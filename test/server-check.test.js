'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CHECK_WINDOW_MS, hostOfHttpUrl, createServerCheckHosts, isLocalScreenFrame,
  httpsFallbackUrl, fetchHealth, checkServer,
} = require('../src/main/server-check');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('only http(s) URLs give a host', () => {
  assert.equal(hostOfHttpUrl('https://203.0.113.7:3000'), '203.0.113.7');
  assert.equal(hostOfHttpUrl('http://Haven.Example.COM/app'), 'haven.example.com');
  assert.equal(hostOfHttpUrl('https://[2001:db8::1]:3000'), '2001:db8::1');
  for (const bad of ['file:///C:/x.html', 'javascript:alert(1)', 'not a url', '', null]) {
    assert.equal(hostOfHttpUrl(bad), '', String(bad));
  }
});

test('a checked host counts for two minutes, then is forgotten', () => {
  let now = 1000;
  const checks = createServerCheckHosts({ now: () => now });
  assert.equal(checks.has('203.0.113.7'), false);
  assert.equal(checks.add('https://203.0.113.7:3000'), true);
  assert.equal(checks.has('203.0.113.7'), true);
  assert.equal(checks.has('198.51.100.1'), false);
  now += CHECK_WINDOW_MS - 1;
  assert.equal(checks.has('203.0.113.7'), true);
  now += 1;
  assert.equal(checks.has('203.0.113.7'), false);
});

test('non-http addresses are not added and the set stays small', () => {
  const checks = createServerCheckHosts({ max: 3 });
  assert.equal(checks.add('file:///etc/passwd'), false);
  assert.equal(checks.add('nonsense'), false);
  for (let i = 1; i <= 5; i++) checks.add(`https://203.0.113.${i}`);
  assert.equal(checks.has('203.0.113.1'), false);
  assert.equal(checks.has('203.0.113.2'), false);
  assert.equal(checks.has('203.0.113.5'), true);
});

test('trust is remembered only for a host being checked, and only during the check', () => {
  let now = 0;
  const checks = createServerCheckHosts({ now: () => now });
  checks.markTrusted('203.0.113.7');
  checks.add('https://203.0.113.7:3000');
  assert.equal(checks.trustedDuringCheck('https://203.0.113.7:3000'), false);
  checks.markTrusted('203.0.113.7');
  assert.equal(checks.trustedDuringCheck('https://203.0.113.7:3000'), true);
  // Starting a new check starts over.
  checks.add('https://203.0.113.7:3000');
  assert.equal(checks.trustedDuringCheck('https://203.0.113.7:3000'), false);
  checks.markTrusted('203.0.113.7');
  now += CHECK_WINDOW_MS;
  assert.equal(checks.trustedDuringCheck('https://203.0.113.7:3000'), false);
});

test('only the main frame of an app screen counts as a local screen', () => {
  const sender = (url) => {
    const mainFrame = { url, isDestroyed: () => false };
    return { mainFrame, getURL: () => url, isDestroyed: () => false };
  };
  const welcome = sender('file:///C:/Haven/src/renderer/welcome.html');
  assert.equal(isLocalScreenFrame(welcome, welcome.mainFrame), true);
  const server = sender('https://203.0.113.7:3000/');
  assert.equal(isLocalScreenFrame(server, server.mainFrame), false);
  const child = { url: welcome.mainFrame.url, isDestroyed: () => false };
  assert.equal(isLocalScreenFrame(welcome, child), false);
  const moving = sender('file:///C:/Haven/src/renderer/welcome.html');
  moving.getURL = () => 'https://evil.example/';
  assert.equal(isLocalScreenFrame(moving, moving.mainFrame), false);
  assert.equal(isLocalScreenFrame(null, null), false);
  const gone = sender('file:///x.html');
  gone.isDestroyed = () => true;
  assert.equal(isLocalScreenFrame(gone, gone.mainFrame), false);
});

test('http:// falls back to https://, nothing else does', () => {
  assert.equal(httpsFallbackUrl('http://203.0.113.7:3000'), 'https://203.0.113.7:3000');
  assert.equal(httpsFallbackUrl('HTTP://203.0.113.7:3000'), 'https://203.0.113.7:3000');
  assert.equal(httpsFallbackUrl('https://203.0.113.7:3000'), null);
  assert.equal(httpsFallbackUrl(''), null);
});

// A fake timer that runs a callback only when told to.
function manualTimers() {
  const timers = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimer: (t) => timers.delete(t),
    async fire() {
      const all = [...timers];
      timers.clear();
      for (const t of all) await t.fn();
    },
    get size() { return timers.size; },
  };
}

test('the health check times out, but not while a certificate question is open', async () => {
  const timers = manualTimers();
  let pending = true;
  let signal;
  const fetch = (_url, opts) => new Promise((_resolve, reject) => {
    signal = opts.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const result = fetchHealth('https://203.0.113.7:3000', { fetch, questionPending: async () => pending, ...timers });
  await timers.fire();
  assert.equal(signal.aborted, false, 'held open while the question is pending');
  assert.equal(timers.size, 1, 'the timeout is armed again');
  pending = false;
  await timers.fire();
  assert.equal(signal.aborted, true);
  assert.equal(await result, null);
});

test('a finished check leaves no timer behind', async () => {
  const timers = manualTimers();
  const res = await fetchHealth('https://h.example', {
    fetch: async (url) => ({ ok: true, url }),
    questionPending: async () => false,
    ...timers,
  });
  assert.equal(res.url, 'https://h.example/api/health');
  assert.equal(timers.size, 0);
});

function fakeDeps(script) {
  const calls = [];
  return {
    calls,
    deps: {
      begin: async (u) => { calls.push(['begin', u]); return true; },
      questionPending: async () => false,
      waitForTrust: async (u) => { calls.push(['wait', u]); return !!script.trust?.[u]; },
      fetch: async (u) => {
        calls.push(['fetch', u]);
        const next = script.fetch[u]?.shift();
        if (next === 'fail') throw new TypeError('Failed to fetch');
        return next || { ok: false, status: 500 };
      },
    },
  };
}

test('main is told about the server before it is fetched', async () => {
  const { calls, deps } = fakeDeps({ fetch: { 'https://203.0.113.7:3000/api/health': [{ ok: true }] } });
  const r = await checkServer('https://203.0.113.7:3000', deps);
  assert.deepEqual({ ok: r.ok, url: r.url }, { ok: true, url: 'https://203.0.113.7:3000' });
  assert.deepEqual(calls, [['begin', 'https://203.0.113.7:3000'], ['fetch', 'https://203.0.113.7:3000/api/health']]);
});

test('a check refused while the user was asked is tried once more after a yes', async () => {
  const u = 'https://203.0.113.7:3000';
  const { calls, deps } = fakeDeps({ fetch: { [`${u}/api/health`]: ['fail', { ok: true }] }, trust: { [u]: true } });
  const r = await checkServer(u, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 2);
});

test('no second try without a yes, and an unreachable https server stays unreachable', async () => {
  const u = 'https://203.0.113.7:3000';
  const { calls, deps } = fakeDeps({ fetch: { [`${u}/api/health`]: ['fail', { ok: true }] } });
  const r = await checkServer(u, deps);
  assert.equal(r.ok, false);
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 1);
});

test('an http:// address that only speaks https is reached on https://', async () => {
  const { deps } = fakeDeps({ fetch: {
    'http://203.0.113.7:3000/api/health': ['fail'],
    'https://203.0.113.7:3000/api/health': [{ ok: true }],
  } });
  const r = await checkServer('http://203.0.113.7:3000', deps);
  assert.deepEqual({ ok: r.ok, url: r.url }, { ok: true, url: 'https://203.0.113.7:3000' });
});

test('an http:// server that answers with an error is not retried on https://', async () => {
  const { calls, deps } = fakeDeps({ fetch: { 'http://h.example/api/health': [{ ok: false, status: 502 }] } });
  const r = await checkServer('http://h.example', deps);
  assert.equal(r.ok, false);
  assert.equal(r.url, 'http://h.example');
  assert.equal(calls.some(c => c[1].startsWith('https://')), false);
});

test('main only lets app screens name a server to check, and isServerHost reads it', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /require\('\.\/server-check'\)/);
  assert.match(main, /function isServerHost\(host\) \{\r?\n\s+if \(_serverChecks\.has\(host\)\) return true;/);
  assert.match(main, /const serverCheckAllowed = \(e\) => isLocalScreenFrame\(e\.sender, e\.senderFrame\)/);
  for (const channel of ['server-check:begin', 'server-check:question-pending', 'server-check:wait-for-trust']) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, channel);
    assert.match(main.slice(at, at + 200), /serverCheckAllowed\(e\)/, channel);
  }
  // An untrusted certificate is still asked about, never accepted outright.
  assert.match(main, /if \(verdict === 'unknown' && !isServerHost\(host\)\) return callback\(-3\);/);
  assert.match(main, /askToTrustCertificate\(host, request\.certificate, verdict === 'changed'\)/);
  assert.match(main, /rememberCertificate\(host, fingerprint\);\r?\n\s+_serverChecks\.markTrusted\(host\);/);
});

test('the Join screen checks through the preload, not a bare fetch', () => {
  const welcome = read('src', 'renderer', 'welcome.js');
  assert.match(welcome, /await window\.haven\.servers\.check\(serverUrl\)/);
  assert.doesNotMatch(welcome, /fetch\(serverUrl \+ '\/api\/health'/);
  const preload = read('src', 'main', 'preload.js');
  assert.match(preload, /ipcRenderer\.invoke\('server-check:begin', u\)/);
  assert.match(preload, /ipcRenderer\.invoke\('server-check:wait-for-trust', u\)/);
});
