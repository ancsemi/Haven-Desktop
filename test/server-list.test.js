'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const list = require('../src/main/server-list');

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    get: (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : undefined),
    set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

function state(history = [], removed = [], order = []) {
  return list.readServerList(fakeStore({ serverHistory: history, serverListRemoved: removed, serverListOrder: order }));
}

test('a removed server is refused when a page adds it back', () => {
  const s = state([{ url: 'https://a.example.com', name: 'A' }, { url: 'https://b.example.com', name: 'B' }]);
  assert.equal(list.removeServer(s, 'https://a.example.com/app.html'), true);
  assert.deepEqual(s.removed, ['https://a.example.com']);
  assert.deepEqual(s.history.map(h => h.url), ['https://b.example.com']);
  assert.equal(list.addServer(s, 'https://A.example.com/', 'A'), 'refused');
  assert.deepEqual(s.history.map(h => h.url), ['https://b.example.com']);
});

test('Add Server by the user brings a removed server back', () => {
  const s = state([], ['https://a.example.com']);
  assert.equal(list.addServer(s, 'a.example.com', 'A', { userInitiated: true }), 'added');
  assert.deepEqual(s.removed, []);
  assert.equal(s.history[0].name, 'A');
  assert.equal(list.addServer(s, 'https://a.example.com', 'Other'), 'exists');
  assert.equal(s.history[0].name, 'A');
});

test('opening a server lifts its removal', () => {
  const s = state([], ['https://a.example.com']);
  list.markConnected(s, 'https://a.example.com/app.html', 123);
  assert.deepEqual(s.removed, []);
  assert.deepEqual(s.history, [{ url: 'https://a.example.com', name: 'https://a.example.com', lastConnected: 123 }]);
  list.markConnected(s, 'https://a.example.com', 456);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].lastConnected, 456);
});

test('invalid addresses are not stored', () => {
  const s = state();
  assert.equal(list.addServer(s, 'https://https', 'x'), 'invalid');
  assert.equal(list.addServer(s, '', 'x'), 'invalid');
  assert.equal(s.history.length, 0);
});

test('a stored server that is also removed reads as removed', () => {
  const store = fakeStore({
    serverHistory: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
    serverListRemoved: ['https://a.example.com/'],
    serverListOrder: ['https://a.example.com', 'https://b.example.com'],
  });
  const s = list.readServerList(store);
  assert.deepEqual(s.history.map(h => h.url), ['https://b.example.com']);
  assert.deepEqual(s.order, ['https://b.example.com']);
  list.writeServerList(store, s);
  assert.deepEqual(store.data.serverHistory.map(h => h.url), ['https://b.example.com']);
});

test('a name the user chose sticks over the name the server reports', () => {
  const s = state([{ url: 'https://a.example.com', name: 'https://a.example.com' }]);
  assert.equal(list.updateServerName(s, 'https://a.example.com', 'LIT'), true);
  assert.equal(s.history[0].name, 'LIT');
  assert.equal(list.updateServerName(s, 'https://a.example.com', 'Red Earth', { custom: true, editedAt: 77 }), true);
  assert.equal(s.history[0].customName, true);
  assert.equal(s.history[0].editedAt, 77, 'the page keeps the time of its edit');
  assert.equal(list.updateServerName(s, 'https://a.example.com', 'LIT'), false);
  assert.equal(s.history[0].name, 'Red Earth');
  // Going back to the server's own name lets the server rename it again.
  assert.equal(list.updateServerName(s, 'https://a.example.com', 'LIT', { custom: false }), true);
  assert.equal(s.history[0].customName, undefined);
  assert.ok(s.history[0].editedAt > 77, 'going back is an edit too, so it wins over the older one');
  assert.equal(list.updateServerName(s, 'https://a.example.com', 'LIT 2'), true);
  assert.equal(s.history[0].name, 'LIT 2');
  assert.equal(list.updateServerName(s, 'https://missing.example.com', 'X'), false);
  assert.equal(list.updateServerName(s, 'https://a.example.com', '   '), false);
});

test('a user icon is kept with a user edit and only as a web address', () => {
  const s = state([{ url: 'https://a.example.com', name: 'A' }]);
  list.updateServerName(s, 'https://a.example.com', 'A', { custom: true, icon: 'https://img.example.com/a.png' });
  assert.equal(s.history[0].icon, 'https://img.example.com/a.png');
  assert.equal(s.history[0].customIcon, true);
  list.updateServerName(s, 'https://a.example.com', 'A', { custom: true, icon: 'javascript:alert(1)' });
  assert.equal(s.history[0].icon, undefined);
  list.updateServerName(s, 'https://a.example.com', 'A', { icon: 'https://img.example.com/b.png' });
  assert.equal(s.history[0].icon, undefined, 'an automatic rename never sets an icon');
});

test('order: a page moves only the servers it shows, the rest keep their places', () => {
  const s = state(['a', 'b', 'c', 'd'].map(x => ({ url: `https://${x}.example.com`, name: x })));
  assert.equal(list.serverListView(s).hasOrder, false);
  // Page on b does not list itself; it moves d before a.
  assert.equal(list.setOrder(s, ['https://d.example.com', 'https://a.example.com', 'https://c.example.com']), true);
  assert.deepEqual(list.orderedUrls(s), ['https://d.example.com', 'https://b.example.com', 'https://a.example.com', 'https://c.example.com']);
  assert.equal(list.setOrder(s, ['https://d.example.com', 'https://a.example.com', 'https://c.example.com']), false);
  const view = list.serverListView(s);
  assert.equal(view.hasOrder, true);
  assert.deepEqual(view.servers.map(h => h.name), ['d', 'b', 'a', 'c']);
  assert.deepEqual(view.order, list.orderedUrls(s));
  // New servers go after the ordered ones; removed ones leave the order.
  list.addServer(s, 'https://e.example.com', 'e');
  list.removeServer(s, 'https://a.example.com');
  assert.deepEqual(list.serverListView(s).servers.map(h => h.name), ['d', 'b', 'c', 'e']);
  assert.equal(list.setOrder(s, ['https://a.example.com', 'https://e.example.com', 'https://d.example.com']), true);
  assert.ok(!s.order.includes('https://a.example.com'), 'a removed server is not ordered back in');
});

test('the history holds 100 servers and drops the longest unused first', () => {
  const s = state();
  for (let i = 0; i < 100; i++) list.markConnected(s, `https://s${i}.example.com`, 1000 + i);
  list.markConnected(s, 'https://s0.example.com', 5000); // s0 is recent again
  list.setOrder(s, ['https://s1.example.com', 'https://s50.example.com']);
  assert.equal(list.addServer(s, 'https://new.example.com', 'New'), 'added');
  assert.equal(s.history.length, list.HISTORY_CAP);
  const urls = s.history.map(h => h.url);
  assert.ok(urls.includes('https://new.example.com'));
  assert.ok(urls.includes('https://s0.example.com'));
  assert.ok(!urls.includes('https://s1.example.com'), 'the oldest connection goes');
  assert.ok(!s.order.includes('https://s1.example.com'), 'a dropped server leaves the order');
  assert.ok(s.order.includes('https://s50.example.com'));
  assert.deepEqual(s.removed, [], 'dropping for room is not a removal');
});

test('the removed list is capped', () => {
  const s = state();
  for (let i = 0; i < 250; i++) list.removeServer(s, `https://r${i}.example.com`);
  assert.equal(s.removed.length, 200);
  assert.equal(s.removed[199], 'https://r249.example.com');
});

test('main and the preloads use the shared list', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('server-list:get'/);
  assert.match(main, /ipcMain\.handle\('server-list:set-order'/);
  assert.match(main, /addServer\(list, url, name, \{ userInitiated/);
  assert.match(main, /markConnected\(_list, url\)/);
  assert.doesNotMatch(main, /length > 20\) _?hist(ory)?\.shift/);
});

test('server pages get the shared list from the preload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');
  assert.match(preload, /getServerList: \(\) => ipcRenderer\.invoke\('server-list:get'\)/);
  assert.match(preload, /setServerOrder: \(urls\) => ipcRenderer\.invoke\('server-list:set-order'/);
  assert.match(preload, /addServerHistory: \(url, name, opts\) => ipcRenderer\.invoke\('server-history:add', url, name, opts\)/);
  assert.match(preload, /updateServerName: \(url, name, opts\) => ipcRenderer\.invoke\('server-history:update-name', url, name, opts\)/);
  assert.match(preload, /sendSync\('server-list:get-sync'\)/);
});
