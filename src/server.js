// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import dns from 'node:dns';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, DnsTimeoutError } from './dns.js';
import {
  TYPES, ALL_TYPES, ValidationError,
  normalizeName, normalizeType, parseServer, formatServer, reverseName,
} from './validate.js';
import { isIP } from 'node:net';

const envInt = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v);
};

const PORT = envInt('PORT', 8080); // 0 = pick a free port (used by tests)
const QUERY_TIMEOUT_MS = envInt('QUERY_TIMEOUT_MS', 5000) || 5000;
const RATE_LIMIT = envInt('RATE_LIMIT', 60);
const MAX_CONCURRENT_QUERIES = envInt('MAX_CONCURRENT_QUERIES', 50);
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------------------------------------------------------------------------
// Default DNS server
// ---------------------------------------------------------------------------

function resolveDefaultServer() {
  const configured = process.env.DEFAULT_DNS || dns.getServers()[0];
  if (!configured) throw new Error('No default DNS server found; set DEFAULT_DNS');
  return parseServer(configured);
}

const DEFAULT_SERVER = resolveDefaultServer();

// ---------------------------------------------------------------------------
// Static files (loaded into memory at startup; public/ is small)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATIC = new Map();
for (const file of readdirSync(PUBLIC_DIR)) {
  const type = MIME[extname(file)];
  if (!type) continue;
  const body = readFileSync(join(PUBLIC_DIR, file));
  const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"';
  STATIC.set('/' + file, { body, type, etag });
}
STATIC.set('/', STATIC.get('/index.html'));

// ---------------------------------------------------------------------------
// Rate limiting: fixed one-minute window per client IP
// ---------------------------------------------------------------------------

const hits = new Map();
const WINDOW_MS = 60_000;

function rateLimited(ip) {
  if (!RATE_LIMIT) return false;
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now - entry.start >= WINDOW_MS) {
    entry = { start: now, count: 0 };
    hits.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start >= WINDOW_MS) hits.delete(ip);
}, WINDOW_MS).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function handleConfig(res) {
  sendJson(res, 200, {
    defaultServer: formatServer(DEFAULT_SERVER),
    types: TYPES,
    allTypes: ALL_TYPES,
  });
}

async function runOne(name, type, server) {
  const qname = type === 'PTR' && isIP(name) ? reverseName(name) : name;
  return query({ name: qname, type, server, timeoutMs: QUERY_TIMEOUT_MS });
}

function errorStatus(err) {
  if (err instanceof ValidationError) return 400;
  if (err instanceof DnsTimeoutError) return 504;
  return 502;
}

async function handleQuery(req, res, url) {
  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: `Rate limit exceeded (${RATE_LIMIT} queries per minute). Try again shortly.` });
  }

  let name, type, server;
  try {
    name = normalizeName(url.searchParams.get('name') ?? '');
    type = normalizeType(url.searchParams.get('type'));
    const s = url.searchParams.get('server');
    server = s ? parseServer(s) : DEFAULT_SERVER;
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  // Global cap on DNS queries in flight (protects sockets/CPU under load).
  // "ALL" sends one query per type, so it takes that many slots.
  const slots = type === 'ALL' ? ALL_TYPES.length : 1;
  if (!acquireSlots(slots)) {
    return sendJson(res, 503, { error: 'Server is busy handling other queries. Try again in a moment.' },
      { 'Retry-After': '1' });
  }
  try {
    return await runQuery(res, name, type, server);
  } finally {
    releaseSlots(slots);
  }
}

let inFlight = 0;

function acquireSlots(n) {
  if (!MAX_CONCURRENT_QUERIES) return true;
  // Never let a request need more slots than exist, or ALL could never run.
  const need = Math.min(n, MAX_CONCURRENT_QUERIES);
  if (inFlight + need > MAX_CONCURRENT_QUERIES) return false;
  inFlight += need;
  return true;
}

function releaseSlots(n) {
  if (!MAX_CONCURRENT_QUERIES) return;
  inFlight -= Math.min(n, MAX_CONCURRENT_QUERIES);
}

async function runQuery(res, name, type, server) {
  const serverLabel = formatServer(server);

  if (type === 'ALL') {
    const settled = await Promise.allSettled(ALL_TYPES.map((t) => runOne(name, t, server)));
    const results = {};
    ALL_TYPES.forEach((t, i) => {
      const r = settled[i];
      results[t] = r.status === 'fulfilled'
        ? { server: serverLabel, ...r.value }
        : { server: serverLabel, error: r.reason.message };
    });
    if (settled.every((r) => r.status === 'rejected')) {
      return sendJson(res, errorStatus(settled[0].reason), { error: settled[0].reason.message, results });
    }
    return sendJson(res, 200, { name, type, results });
  }

  try {
    const result = await runOne(name, type, server);
    return sendJson(res, 200, { server: serverLabel, ...result });
  } catch (err) {
    return sendJson(res, errorStatus(err), { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    if (url.pathname === '/api/config') return handleConfig(res);
    if (url.pathname === '/api/query') return await handleQuery(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    const file = STATIC.get(url.pathname);
    if (!file) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });

    const headers = {
      'Content-Type': file.type,
      ETag: file.etag,
      'Cache-Control': 'no-cache',
    };
    if (req.headers['if-none-match'] === file.etag) return send(res, 304, undefined, headers);
    return send(res, 200, req.method === 'HEAD' ? undefined : file.body, headers);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`WebDNSChecker listening on :${server.address().port} (default DNS ${formatServer(DEFAULT_SERVER)})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
