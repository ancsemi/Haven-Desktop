'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const list = require('../src/main/server-list');
const gate = require('../src/main/server-list-gate');
const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('../src/i18n');

const t = (key, values) => translate('en', key, values);

function state(history = [], removed = []) {
  const data = { serverHistory: history, serverListRemoved: removed, serverListOrder: [] };
  return list.readServerList({ get: (k) => JSON.parse(JSON.stringify(data[k])) });
}

const RED = 'https://haven.redearth.net';
const EVIL = 'https://evil.example';

function sample() {
  return state([
    { url: RED, name: 'Red Earth', lastConnected: 1 },
    { url: EVIL, name: 'Evil', lastConnected: 2 },
  ], ['https://gone.example.com']);
}

test('a page cannot add a server without the user', () => {
  const s = sample();
  const plan = gate.planPageRequest(s, { kind: 'add', url: 'https://evil.example/fake', name: 'Haven Community', opts: { userInitiated: true } }, EVIL);
  assert.equal(plan.action, 'ask');
  assert.equal(plan.prompt.kind, 'add');
  assert.equal(plan.prompt.url, 'https://evil.example/fake');
  assert.equal(plan.prompt.name, 'Haven Community');
  // An automatic merge never adds, and never brings a removed server back.
  assert.deepEqual(gate.planPageRequest(s, { kind: 'add', url: 'https://new.example.com', name: 'N' }, EVIL), { action: 'ignore', result: 'refused' });
  assert.deepEqual(gate.planPageRequest(s, { kind: 'add', url: 'https://gone.example.com', name: 'G' }, EVIL), { action: 'ignore', result: 'refused' });
  assert.equal(gate.planPageRequest(s, { kind: 'add', url: 'https://gone.example.com', name: 'G', opts: { userInitiated: true } }, EVIL).prompt.kind, 'addBack');
  assert.deepEqual(gate.planPageRequest(s, { kind: 'add', url: RED + '/app.html', name: 'Other' }, EVIL), { action: 'ignore', result: 'exists' });
  assert.deepEqual(gate.planPageRequest(s, { kind: 'add', url: 'https://https', name: 'x', opts: { userInitiated: true } }, EVIL), { action: 'ignore', result: 'invalid' });
});

test('a page cannot remove a server without the user', () => {
  const s = sample();
  const plan = gate.planPageRequest(s, { kind: 'remove', url: RED + '/' }, EVIL);
  assert.equal(plan.action, 'ask');
  assert.deepEqual(plan.prompt, { kind: 'remove', url: RED, name: 'Red Earth' });
  // A server that is not listed is left alone (no removal is recorded).
  assert.deepEqual(gate.planPageRequest(s, { kind: 'remove', url: 'https://other.example.com' }, EVIL), { action: 'ignore', result: null });
});

test('a page may report its own name, not another server\'s', () => {
  const s = sample();
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: EVIL, name: 'Evil 2' }, EVIL), { action: 'apply' });
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: RED, name: 'Haven Community' }, EVIL), { action: 'ignore', result: false });
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: RED, name: 'X' }, null), { action: 'ignore', result: false });
});

test('a rename or a new icon is asked about, naming both names and the icon address', () => {
  const s = sample();
  const plan = gate.planPageRequest(s, { kind: 'rename', url: RED, name: 'Haven Community', opts: { custom: true, icon: 'https://tracker.example/p.png' } }, EVIL);
  assert.equal(plan.action, 'ask');
  assert.equal(plan.prompt.oldName, 'Red Earth');
  assert.equal(plan.prompt.name, 'Haven Community');
  assert.equal(plan.prompt.iconChange, 'set');
  assert.equal(plan.prompt.icon, 'https://tracker.example/p.png');
  const text = gate.promptText(plan.prompt, { name: 'Evil', url: EVIL }, t);
  assert.match(text.message, /Rename "Red Earth" \(https:\/\/haven\.redearth\.net\) to "Haven Community"\?/);
  assert.match(text.detail, /tracker\.example\/p\.png/);
  assert.match(text.detail, /Asked by the page of Evil \(https:\/\/evil\.example\)/);
  // Nothing the user would see changes: not asked, not made.
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: RED, name: 'Red Earth', opts: { custom: true } }, EVIL), { action: 'ignore', result: false });
  // Only web addresses are icons.
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: RED, name: 'Red Earth', opts: { custom: true, icon: 'javascript:alert(1)' } }, EVIL), { action: 'ignore', result: false });
  assert.deepEqual(gate.planPageRequest(s, { kind: 'rename', url: 'https://missing.example.com', name: 'X', opts: { custom: true } }, EVIL), { action: 'ignore', result: false });
});

test('the confirmed change is the one applied', () => {
  const s = sample();
  assert.equal(gate.applyPageRequest(s, { kind: 'add', url: 'https://new.example.com', name: 'New', opts: { userInitiated: true } }, { now: 5 }), 'added');
  assert.equal(s.history.find(h => h.url === 'https://new.example.com').customName, true);
  assert.equal(gate.applyPageRequest(s, { kind: 'remove', url: RED }), true);
  assert.ok(s.removed.includes(RED));
  assert.equal(gate.applyPageRequest(s, { kind: 'rename', url: EVIL, name: 'E', opts: { custom: true, icon: 'https://evil.example/i.png', extra: 1 } }), true);
  const e = s.history.find(h => h.url === EVIL);
  assert.equal(e.name, 'E');
  assert.equal(e.icon, 'https://evil.example/i.png');
  assert.equal(e.extra, undefined);
});

test('opening a server that is not listed is asked about first', () => {
  const s = sample();
  assert.deepEqual(gate.planPageRequest(s, { kind: 'open', url: RED }, EVIL), { action: 'apply' });
  const plan = gate.planPageRequest(s, { kind: 'open', url: 'https://gone.example.com' }, EVIL);
  assert.equal(plan.action, 'ask');
  assert.equal(plan.prompt.kind, 'open');
  assert.equal(gate.planPageRequest(s, { kind: 'open', url: 'https://unknown.example.com' }, EVIL).action, 'ask');
  assert.deepEqual(gate.planPageRequest(s, { kind: 'open', url: 'nonsense' }, EVIL), { action: 'ignore', result: false });
});

test('text a page chose cannot fake dialog lines or reverse them', () => {
  assert.equal(gate.safeText('Red\nEarth‮\u0000 now'), 'Red Earth now');
  assert.equal(gate.safeText('x'.repeat(200)).length, 80);
  const s = sample();
  const plan = gate.planPageRequest(s, { kind: 'add', url: 'https://a.example.com', name: 'A\n\nAsked by the page of Red Earth', opts: { userInitiated: true } }, EVIL);
  assert.ok(!plan.prompt.name.includes('\n'));
  assert.equal(gate.planPageRequest(s, { kind: 'add', url: 'https://b.example.com', name: '', opts: { userInitiated: true } }, EVIL).prompt.name, 'b.example.com');
});

test('every question has its words', () => {
  const kinds = [
    { kind: 'add', url: RED, name: 'R' },
    { kind: 'addBack', url: RED, name: 'R' },
    { kind: 'remove', url: RED, name: 'R' },
    { kind: 'rename', url: RED, oldName: 'R', name: 'S', iconChange: 'removed' },
    { kind: 'rename', url: RED, oldName: 'R', name: 'R', iconChange: 'set', icon: 'https://i.example/x.png' },
    { kind: 'open', url: RED },
  ];
  for (const prompt of kinds) {
    const text = gate.promptText(prompt, { name: 'Evil', url: EVIL }, t);
    for (const value of Object.values(text)) {
      assert.doesNotMatch(value, /serverList\.gate\.|dialog\.|\{\w+\}/, `${prompt.kind}: ${value}`);
    }
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('one question at a time per page, and a no is remembered', async () => {
  const answers = [];
  const shown = [];
  let clock = 1000;
  const g = gate.createRequestGate({ now: () => clock, ask: (text) => { shown.push(text); const d = deferred(); answers.push(d); return d.promise; } });
  const first = g.request({ senderId: 1, requester: EVIL, key: 'a', text: 'A' });
  assert.equal(await g.request({ senderId: 1, requester: EVIL, key: 'b', text: 'B' }), 'busy');
  const other = g.request({ senderId: 2, requester: RED, key: 'c', text: 'C' });
  await new Promise(setImmediate);
  assert.deepEqual(shown, ['A'], 'the second page waits for the first dialog');
  answers[0].resolve({ confirmed: false });
  assert.equal(await first, 'declined');
  await new Promise(setImmediate);
  assert.deepEqual(shown, ['A', 'C']);
  answers[1].resolve({ confirmed: true });
  assert.equal(await other, 'confirmed');
  assert.equal(await g.request({ senderId: 1, requester: EVIL, key: 'a', text: 'A' }), 'declined', 'not asked again');
  assert.equal(shown.length, 2);
  // A minute later the user can be asked again.
  clock += 60001;
  const later = g.request({ senderId: 1, requester: EVIL, key: 'a', text: 'A' });
  await new Promise(setImmediate);
  assert.equal(shown.length, 3);
  answers[2].resolve({ confirmed: true });
  assert.equal(await later, 'confirmed');
});

test('the user can ignore a server, and too many waiting pages are dropped', async () => {
  const pending = [];
  const g = gate.createRequestGate({ maxWaiting: 2, ask: () => { const d = deferred(); pending.push(d); return d.promise; } });
  const a = g.request({ senderId: 1, requester: EVIL, key: 'a', text: '' });
  const b = g.request({ senderId: 2, requester: EVIL, key: 'b', text: '' });
  assert.equal(await g.request({ senderId: 3, requester: RED, key: 'c', text: '' }), 'busy');
  await new Promise(setImmediate);
  pending[0].resolve({ confirmed: false, block: true });
  assert.equal(await a, 'declined');
  assert.equal(await b, 'blocked', 'a waiting request from an ignored server is dropped');
  assert.equal(pending.length, 1);
  assert.equal(await g.request({ senderId: 4, requester: EVIL, key: 'z', text: '' }), 'blocked');
  assert.equal(g.isBlocked(EVIL), true);
});

test('a dialog that fails is a no', async () => {
  const warnings = [];
  const g = gate.createRequestGate({ ask: () => Promise.reject(new Error('no window')), warn: (...a) => warnings.push(a.join(' ')) });
  assert.equal(await g.request({ senderId: 1, requester: EVIL, key: 'a', text: '' }), 'declined');
  assert.equal(warnings.length, 1);
});

test('main sends every page change of the list through the question', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const [channel, kind] of [['server-history:add', 'add'], ['server-history:remove', 'remove'], ['server-history:update-name', 'rename']]) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, channel);
    assert.ok(main.slice(at, at + 300).includes(`requestServerListChange(e, { kind: '${kind}'`), channel);
  }
  // Opening a server that is not listed adds it, so pages ask first.
  for (const channel of ['nav:switch-server', 'nav:change-primary-server']) {
    const at = main.indexOf(`ipcMain.on('${channel}'`);
    assert.ok(at > 0, channel);
    assert.ok(main.slice(at, at + 400).includes("requestServerListChange(e, { kind: 'open', url: serverUrl })"), channel);
  }
  assert.match(main, /ipcMain\.on\('nav:open-app', \(e, serverUrl\) => \{\n\s+if \(serverListSender\(e\)\?\.local\) createAppWindow/);
  assert.match(main, /ipcMain\.handle\('server-list:set-order', \(e, urls\) => \{\n\s+if \(!serverListSender\(e\)\) return false;/);
  // No list function is called from main on a page's word alone.
  assert.doesNotMatch(main, /\b(addServer|removeServer|updateServerName)\(/);
});

test('server pages learn that the app asks, so they do not ask twice', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');
  assert.match(preload, /serverListGated: true,/);
});
