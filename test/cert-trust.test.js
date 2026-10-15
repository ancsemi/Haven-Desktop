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

test('this computer never asks, whatever its certificate', () => {
  for (const hostname of ['localhost', 'haven.localhost', '127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(certDecision({ hostname, errorCode: -202, fingerprint: 'sha256/new' },
      { pins: { [hostname]: 'sha256/old' } }), 'local', hostname);
  }
});

test('a local network server is trusted on first use, then held to that certificate', () => {
  const cert = { hostname: '192.168.1.20', errorCode: -202, fingerprint: 'sha256/aaa' };
  assert.equal(certDecision(cert), 'local-first');
  assert.equal(certDecision(cert, { pins: { '192.168.1.20': 'sha256/aaa' } }), 'pinned');
  assert.equal(certDecision({ ...cert, fingerprint: 'sha256/bbb' }, { pins: { '192.168.1.20': 'sha256/aaa' } }), 'changed');
  assert.equal(certDecision({ ...cert, hostname: 'NAS.local' }, { pins: { 'nas.local': 'sha256/zzz' } }), 'changed');
});

test('only loopback counts as this computer', () => {
  const { isLoopbackHost } = require('../src/main/cert-trust');
  for (const host of ['localhost', 'a.localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['192.168.1.2', 'nas.local', '10.0.0.1', 'fe80::1', 'localhost.example.com', '']) assert.equal(isLoopbackHost(host), false, host);
});

test('main remembers a local host the first time and asks when it changes', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /if \(verdict === 'grandfathered' \|\| verdict === 'local-first'\) \{\s*rememberCertificate\(host, fingerprint\);\s*return callback\(0\);/);
  assert.match(main, /if \(verdict === 'local-first'\) rememberCertificate\(host, certificate\?\.fingerprint \|\| ''\);/);
  assert.match(main, /askToTrustCertificate\(host, request\.certificate, verdict === 'changed'\)/);
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
