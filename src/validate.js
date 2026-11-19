// SPDX-License-Identifier: GPL-3.0-or-later
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/** Record types offered in the UI. */
export const TYPES = [
  'A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA', 'PTR', 'SRV',
  'NAPTR', 'DS', 'DNSKEY', 'TLSA', 'HINFO',
];

/** Types queried by the "All common types" option. */
export const ALL_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/**
 * Validate and normalise a query name. Accepts IDNs (converted to punycode),
 * underscores (for _dmarc, _sip._tcp, …) and the root ".".
 * Returns the name without a trailing dot ("" for root).
 */
export function normalizeName(input) {
  if (typeof input !== 'string') throw new ValidationError('Name is required');
  let name = input.trim();
  if (name === '.') return '';
  if (!name) throw new ValidationError('Name is required');
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (isIP(name)) return name;

  // Convert IDNs to punycode. domainToASCII rejects underscores, so only use it
  // when there are non-ASCII characters.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(name)) {
    const ascii = domainToASCII(name);
    if (!ascii) throw new ValidationError('Invalid internationalised domain name');
    name = ascii;
  }

  if (name.length > 253) throw new ValidationError('Name is too long (max 253 characters)');
  const labels = name.split('.');
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      throw new ValidationError(`Invalid label "${label}" in name`);
    }
  }
  return name.toLowerCase();
}

/** Validate a record type. Returns the upper-cased type, or "ALL". */
export function normalizeType(input) {
  const type = String(input || 'A').trim().toUpperCase();
  if (type === 'ALL' || TYPES.includes(type)) return type;
  throw new ValidationError(`Unsupported record type "${input}"`);
}

/** Expand an IPv6 address to 32 hex nibbles. */
function expandIPv6(ip) {
  let addr = ip.split('%')[0];
  // Embedded IPv4 (e.g. ::ffff:1.2.3.4) → convert last part to two hextets.
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    addr = addr.slice(0, -v4[1].length) +
      ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  const groups = addr.includes('::') ? [...h, ...Array(missing).fill('0'), ...t] : h;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

/** Convert an IP address to its reverse-lookup name. */
export function reverseName(ip) {
  const family = isIP(ip);
  if (family === 4) return ip.split('.').reverse().join('.') + '.in-addr.arpa';
  if (family === 6) return expandIPv6(ip).split('').reverse().join('.') + '.ip6.arpa';
  throw new ValidationError('Not an IP address');
}

/**
 * Parse a DNS server string: "1.2.3.4", "1.2.3.4:5353", "2001:db8::1",
 * "[2001:db8::1]:53". Only IP addresses are accepted.
 * Returns { host, port, family }.
 */
export function parseServer(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ValidationError('DNS server is required');
  }
  const s = input.trim();
  let host = s;
  let port = 53;

  const bracket = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else if (isIP(s) === 6) {
    host = s;
  } else {
    const m = s.match(/^([^:]+):(\d+)$/);
    if (m) {
      host = m[1];
      port = Number(m[2]);
    }
  }

  const family = isIP(host);
  if (!family) throw new ValidationError(`DNS server must be an IP address (got "${input}")`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('DNS server port must be 1-65535');
  }
  return { host, port, family };
}

/** Format a server for display: "1.2.3.4", "1.2.3.4:5353", "[::1]:5353". */
export function formatServer({ host, port, family }) {
  if (port === 53) return host;
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}
