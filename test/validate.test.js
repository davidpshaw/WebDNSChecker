// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName, normalizeType, parseServer, formatServer, reverseName, ValidationError,
} from '../src/validate.js';

test('normalizeName accepts common names', () => {
  assert.equal(normalizeName('Example.COM.'), 'example.com');
  assert.equal(normalizeName('  _dmarc.example.com '), '_dmarc.example.com');
  assert.equal(normalizeName('_sip._tcp.example.com'), '_sip._tcp.example.com');
  assert.equal(normalizeName('.'), '');
  assert.equal(normalizeName('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeName('bücher.de'), 'xn--bcher-kva.de');
});

test('normalizeName rejects bad input', () => {
  for (const bad of ['', '   ', 'a..b', '-bad.com', 'bad-.com', 'sp ace.com', 'a'.repeat(64) + '.com', 'x;rm -rf']) {
    assert.throws(() => normalizeName(bad), ValidationError, bad);
  }
});

test('normalizeType', () => {
  assert.equal(normalizeType('mx'), 'MX');
  assert.equal(normalizeType('all'), 'ALL');
  assert.equal(normalizeType(null), 'A');
  assert.throws(() => normalizeType('AXFR'), ValidationError);
});

test('parseServer handles IPv4/IPv6 with and without ports', () => {
  assert.deepEqual(parseServer('1.1.1.1'), { host: '1.1.1.1', port: 53, family: 4 });
  assert.deepEqual(parseServer('192.168.1.1:5353'), { host: '192.168.1.1', port: 5353, family: 4 });
  assert.deepEqual(parseServer('2001:db8::1'), { host: '2001:db8::1', port: 53, family: 6 });
  assert.deepEqual(parseServer('[2001:db8::1]:5353'), { host: '2001:db8::1', port: 5353, family: 6 });
  assert.deepEqual(parseServer('[::1]'), { host: '::1', port: 53, family: 6 });
});

test('parseServer rejects hostnames and bad ports', () => {
  for (const bad of ['', 'dns.google', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3', '[::1]:x']) {
    assert.throws(() => parseServer(bad), ValidationError, bad);
  }
});

test('formatServer', () => {
  assert.equal(formatServer(parseServer('1.1.1.1')), '1.1.1.1');
  assert.equal(formatServer(parseServer('1.1.1.1:5353')), '1.1.1.1:5353');
  assert.equal(formatServer(parseServer('[::1]:5353')), '[::1]:5353');
});

test('reverseName', () => {
  assert.equal(reverseName('8.8.4.4'), '4.4.8.8.in-addr.arpa');
  assert.equal(
    reverseName('2001:db8::1'),
    '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
  );
  assert.equal(
    reverseName('::ffff:1.2.3.4'),
    '4.0.3.0.2.0.1.0.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa',
  );
});
