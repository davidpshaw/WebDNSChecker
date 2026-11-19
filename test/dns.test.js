// SPDX-License-Identifier: GPL-3.0-or-later
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import packet from 'dns-packet';
import { query, DnsTimeoutError } from '../src/dns.js';

// A tiny mock DNS server on 127.0.0.1 (UDP + TCP on the same port).
// - "big.test" TXT: truncated over UDP, full answer over TCP
// - "silent.test": never answers (timeout)
// - "nx.test": NXDOMAIN
// - anything else: one A / MX / TXT record

let udp, tcp, port;

function answer(q, viaTcp) {
  const base = { type: 'response', flags: packet.RECURSION_DESIRED | packet.RECURSION_AVAILABLE, questions: [q] };
  if (q.name === 'nx.test') return { ...base, flags: base.flags | 3 }; // rcode 3 = NXDOMAIN
  if (q.name === 'big.test') {
    if (!viaTcp) return { ...base, flags: base.flags | packet.TRUNCATED_RESPONSE, answers: [] };
    return { ...base, answers: Array.from({ length: 20 }, (_, i) => ({ type: 'TXT', name: q.name, ttl: 60, data: 'x'.repeat(100) + i })) };
  }
  const data = { A: '10.0.0.1', MX: { preference: 10, exchange: 'mail.example.test' }, TXT: ['hello "world"'] }[q.type];
  return { ...base, answers: data ? [{ type: q.type, name: q.name, ttl: 300, data }] : [] };
}

before(async () => {
  tcp = net.createServer((sock) => {
    sock.on('data', (buf) => {
      const msg = packet.decode(buf.subarray(2));
      const out = packet.encode({ id: msg.id, ...answer(msg.questions[0], true) });
      const len = Buffer.alloc(2);
      len.writeUInt16BE(out.length);
      sock.end(Buffer.concat([len, out]));
    });
  });
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  port = tcp.address().port;

  udp = dgram.createSocket('udp4');
  udp.on('message', (buf, rinfo) => {
    const msg = packet.decode(buf);
    if (msg.questions[0].name === 'silent.test') return;
    const out = packet.encode({ id: msg.id, ...answer(msg.questions[0], false) });
    udp.send(out, rinfo.port, rinfo.address);
  });
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
});

after(() => {
  udp.close();
  tcp.close();
});

const server = () => ({ host: '127.0.0.1', port, family: 4 });

test('A query over UDP', async () => {
  const r = await query({ name: 'example.test', type: 'A', server: server() });
  assert.equal(r.transport, 'udp');
  assert.equal(r.rcode, 'NOERROR');
  assert.equal(r.flags.qr, true);
  assert.equal(r.flags.ra, true);
  assert.deepEqual(r.answers, [{ name: 'example.test.', type: 'A', class: 'IN', ttl: 300, value: '10.0.0.1' }]);
  assert.ok(r.timeMs >= 0);
  assert.ok(r.msgSize > 0);
});

test('MX and TXT presentation format', async () => {
  const mx = await query({ name: 'example.test', type: 'MX', server: server() });
  assert.equal(mx.answers[0].value, '10 mail.example.test.');
  const txt = await query({ name: 'example.test', type: 'TXT', server: server() });
  assert.equal(txt.answers[0].value, '"hello \\"world\\""');
});

test('NXDOMAIN is returned, not thrown', async () => {
  const r = await query({ name: 'nx.test', type: 'A', server: server() });
  assert.equal(r.rcode, 'NXDOMAIN');
  assert.equal(r.answers.length, 0);
});

test('truncated UDP response falls back to TCP', async () => {
  const r = await query({ name: 'big.test', type: 'TXT', server: server() });
  assert.equal(r.transport, 'tcp');
  assert.equal(r.answers.length, 20);
});

test('timeout', async () => {
  await assert.rejects(
    query({ name: 'silent.test', type: 'A', server: server(), timeoutMs: 200 }),
    DnsTimeoutError,
  );
});
