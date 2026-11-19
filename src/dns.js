// SPDX-License-Identifier: GPL-3.0-or-later
import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import packet from 'dns-packet';

const EDNS_UDP_SIZE = 1232;

export class DnsTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DnsTimeoutError';
  }
}

function buildQuery(name, type) {
  const id = randomInt(0, 65536);
  const buf = packet.encode({
    type: 'query',
    id,
    flags: packet.RECURSION_DESIRED,
    questions: [{ type, class: 'IN', name }],
    additionals: [{ type: 'OPT', name: '.', udpPayloadSize: EDNS_UDP_SIZE }],
  });
  return { id, buf };
}

function queryUdp(buf, id, server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(server.family === 6 ? 'udp6' : 'udp4');
    const timer = setTimeout(() => {
      finish(new DnsTimeoutError(`No response from ${server.host} after ${timeoutMs} ms`));
    }, timeoutMs);

    function finish(err, msg) {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {});
      try { sock.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(msg);
    }

    sock.on('error', (err) => finish(err));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.port !== server.port) return;
      if (msg.length < 2 || msg.readUInt16BE(0) !== id) return; // not ours
      finish(null, msg);
    });
    sock.send(buf, server.port, server.host, (err) => { if (err) finish(err); });
  });
}

function queryTcp(buf, id, server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server.host, port: server.port });
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      finish(new DnsTimeoutError(`No TCP response from ${server.host} after ${timeoutMs} ms`));
    }, timeoutMs);

    function finish(err, msg) {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      if (err) reject(err); else resolve(msg);
    }

    sock.on('connect', () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(buf.length);
      sock.write(Buffer.concat([len, buf]));
    });
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 2) {
        const len = data.readUInt16BE(0);
        if (data.length >= len + 2) {
          const msg = data.subarray(2, len + 2);
          if (msg.readUInt16BE(0) !== id) return finish(new Error('Mismatched DNS response id'));
          finish(null, msg);
        }
      }
    });
    sock.on('error', (err) => finish(err));
    sock.on('end', () => finish(new Error('Connection closed before full response')));
  });
}

/**
 * Perform a single DNS query.
 * @param {{name: string, type: string, server: {host,port,family}, timeoutMs?: number}} opts
 */
export async function query({ name, type, server, timeoutMs = 5000 }) {
  const { id, buf } = buildQuery(name, type);
  const start = performance.now();
  let transport = 'udp';
  let raw = await queryUdp(buf, id, server, timeoutMs);
  let decoded = packet.decode(raw);
  if (decoded.flag_tc) {
    transport = 'tcp';
    raw = await queryTcp(buf, id, server, timeoutMs);
    decoded = packet.decode(raw);
  }
  const timeMs = Math.round((performance.now() - start) * 10) / 10;
  return normalize(decoded, { transport, timeMs, msgSize: raw.length });
}

// ---------------------------------------------------------------------------
// Normalisation: turn dns-packet output into JSON-safe, display-ready records.
// ---------------------------------------------------------------------------

const fqdn = (n) => (n ? (n.endsWith('.') ? n : n + '.') : '.');

function quote(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  let out = '"';
  for (const b of buf) {
    if (b === 0x22 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += '\\' + String(b).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

function dnsTime(sec) {
  return new Date(sec * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Presentation-format value (as dig shows it). */
function present(rr) {
  const d = rr.data;
  switch (rr.type) {
    case 'A':
    case 'AAAA':
      return String(d);
    case 'NS':
    case 'CNAME':
    case 'PTR':
    case 'DNAME':
      return fqdn(d);
    case 'MX':
      return `${d.preference} ${fqdn(d.exchange)}`;
    case 'TXT': {
      const parts = Array.isArray(d) ? d : [d];
      return parts.map(quote).join(' ');
    }
    case 'SOA':
      return `${fqdn(d.mname)} ${fqdn(d.rname)} ${d.serial} ${d.refresh} ${d.retry} ${d.expire} ${d.minimum}`;
    case 'CAA':
      return `${d.flags ?? 0} ${d.tag} ${quote(d.value)}`;
    case 'SRV':
      return `${d.priority} ${d.weight} ${d.port} ${fqdn(d.target)}`;
    case 'NAPTR':
      return `${d.order} ${d.preference} ${quote(d.flags)} ${quote(d.services)} ${quote(d.regexp)} ${fqdn(d.replacement)}`;
    case 'DS':
      return `${d.keyTag} ${d.algorithm} ${d.digestType} ${d.digest.toString('hex').toUpperCase()}`;
    case 'DNSKEY':
      return `${d.flags} 3 ${d.algorithm} ${d.key.toString('base64')}`;
    case 'TLSA':
      return `${d.usage} ${d.selector} ${d.matchingType} ${d.certificate.toString('hex').toUpperCase()}`;
    case 'HINFO':
      return `${quote(d.cpu)} ${quote(d.os)}`;
    case 'RRSIG':
      return `${d.typeCovered} ${d.algorithm} ${d.labels} ${d.originalTTL} ${dnsTime(d.expiration)} ` +
        `${dnsTime(d.inception)} ${d.keyTag} ${fqdn(d.signersName)} ${d.signature.toString('base64')}`;
    case 'NSEC':
      return `${fqdn(d.nextDomain)} ${(d.rrtypes || []).join(' ')}`;
    default:
      if (Buffer.isBuffer(d)) return `\\# ${d.length} ${d.toString('hex').toUpperCase()}`;
      return typeof d === 'string' ? d : JSON.stringify(d);
  }
}

function normRecord(rr) {
  return {
    name: fqdn(rr.name),
    type: rr.type,
    class: rr.class || 'IN',
    ttl: rr.ttl ?? 0,
    value: present(rr),
  };
}

function normalize(msg, extra) {
  const additionals = msg.additionals || [];
  const opt = additionals.find((r) => r.type === 'OPT');
  return {
    id: msg.id,
    opcode: msg.opcode || 'QUERY',
    rcode: msg.rcode || 'NOERROR',
    flags: {
      qr: !!msg.flag_qr,
      aa: !!msg.flag_aa,
      tc: !!msg.flag_tc,
      rd: !!msg.flag_rd,
      ra: !!msg.flag_ra,
      ad: !!msg.flag_ad,
      cd: !!msg.flag_cd,
    },
    edns: opt ? { version: opt.version ?? 0, udpPayloadSize: opt.udpPayloadSize, do: !!(opt.flags & packet.DNSSEC_OK) } : null,
    question: (msg.questions || []).map((q) => ({ name: fqdn(q.name), type: q.type, class: q.class || 'IN' })),
    answers: (msg.answers || []).map(normRecord),
    authorities: (msg.authorities || []).map(normRecord),
    additionals: additionals.filter((r) => r.type !== 'OPT').map(normRecord),
    ...extra,
  };
}
