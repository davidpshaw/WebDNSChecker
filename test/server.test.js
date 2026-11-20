// SPDX-License-Identifier: GPL-3.0-or-later
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';

// Starts the real server against a "black hole" DNS server that never answers,
// so every query stays in flight until QUERY_TIMEOUT_MS.

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
let blackhole, proc, base;

before(async () => {
  blackhole = dgram.createSocket('udp4');
  await new Promise((r) => blackhole.bind(0, '127.0.0.1', r));

  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      DEFAULT_DNS: `127.0.0.1:${blackhole.address().port}`,
      QUERY_TIMEOUT_MS: '800',
      MAX_CONCURRENT_QUERIES: '3',
      RATE_LIMIT: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    proc.on('exit', (code) => reject(new Error(`server exited (${code})`)));
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/listening on :(\d+)/);
      if (m) resolve(Number(m[1]));
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  proc?.kill();
  blackhole?.close();
});

const get = (qs) => fetch(`${base}/api/query?${qs}`);

test('requests over MAX_CONCURRENT_QUERIES get 503 with Retry-After', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => get('name=example.com&type=A')));
  const codes = responses.map((r) => r.status).sort();
  assert.deepEqual(codes, [503, 503, 504, 504, 504]);
  const busy = responses.find((r) => r.status === 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.match((await busy.json()).error, /busy/i);
});

test('slots are released after queries finish', async () => {
  const r = await get('name=example.com&type=A');
  assert.equal(r.status, 504); // timed out normally, not rejected as busy
});

test('ALL can still run when the cap is smaller than the type count', async () => {
  const r = await get('name=example.com&type=ALL');
  assert.equal(r.status, 504);
  const body = await r.json();
  assert.equal(Object.keys(body.results).length, 8);
});

test('ALL holds every slot, so a concurrent single query is rejected', async () => {
  const all = get('name=example.com&type=ALL');
  await new Promise((r) => setTimeout(r, 100));
  const single = await get('name=example.com&type=A');
  assert.equal(single.status, 503);
  assert.equal((await all).status, 504);
});

test('validation errors do not consume slots', async () => {
  const bad = await Promise.all(Array.from({ length: 10 }, () => get('name=bad..name')));
  assert.ok(bad.every((r) => r.status === 400));
  assert.equal((await get('name=example.com&type=A')).status, 504);
});
