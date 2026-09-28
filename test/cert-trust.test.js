'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isLocalHost, certDecision, normalizeHost } = require('../src/main/cert-trust');

test('this computer and the local network count as local', () => {
  for (const host of ['localhost', 'haven.localhost', 'nas.local', '127.0.0.1', '10.0.0.5',
    '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.3.4', '::1', '[::1]',
    'fe80::1', 'fd12:3456::1', '::ffff:192.168.0.2', 'LOCALHOST.']) {
    assert.equal(isLocalHost(host), true, host);
  }
});

test('anything reachable from the internet does not', () => {
  for (const host of ['example.com', 'haven.duckdns.org', 'local.example.com', '8.8.8.8',
    '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', '2001:db8::1', 'fe8::1', 'fc::1', '']) {
    assert.equal(isLocalHost(host), false, host);
  }
});

test('a certificate the system trusts is left to the system', () => {
  assert.equal(certDecision({ hostname: 'example.com', errorCode: 0, fingerprint: 'x' }), 'system');
});

test("a remote server's own certificate is asked about once, then remembered", () => {
  const cert = { hostname: 'haven.example.com', errorCode: -202, fingerprint: 'sha256/aaa' };
  assert.equal(certDecision(cert), 'unknown');
  assert.equal(certDecision(cert, { pins: { 'haven.example.com': 'sha256/aaa' } }), 'pinned');
  assert.equal(certDecision({ ...cert, fingerprint: 'sha256/bbb' }, { pins: { 'haven.example.com': 'sha256/aaa' } }), 'changed');
});

test('local servers never ask, whatever their certificate', () => {
  assert.equal(certDecision({ hostname: '192.168.1.20', errorCode: -202, fingerprint: 'sha256/new' },
    { pins: { '192.168.1.20': 'sha256/old' } }), 'local');
});

test('servers used before the check are trusted on their next connection only', () => {
  const cert = { hostname: 'Old.Example.com', errorCode: -202, fingerprint: 'sha256/aaa' };
  assert.equal(certDecision(cert, { grandfathered: ['old.example.com'] }), 'grandfathered');
  assert.equal(certDecision(cert, { pins: { 'old.example.com': 'sha256/bbb' }, grandfathered: ['old.example.com'] }), 'changed');
});

test('hostnames compare without case, brackets or a trailing dot', () => {
  assert.equal(normalizeHost('[FE80::1]'), 'fe80::1');
  assert.equal(normalizeHost('Haven.Example.com.'), 'haven.example.com');
  assert.equal(certDecision({ hostname: 'constructor', errorCode: -202, fingerprint: 'x' }), 'unknown');
});
