'use strict';

// Server pages and the welcome page run apart from their preloads, so a page
// can never get hold of ipcRenderer: it gets plain functions through
// contextBridge, and the code that replaces the page's globals runs in the
// page with nothing from Electron.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main', 'main.js');
const APP_PRELOAD = read('main', 'app-preload.js');
const WELCOME_PRELOAD = read('main', 'preload.js');
const PAGE_WORLD = read('main', 'app-page-world.js');

test('server views and the welcome window run isolated from their preloads', () => {
  assert.doesNotMatch(MAIN, /contextIsolation: false/);
  assert.match(MAIN, /preload: path\.join\(__dirname, 'app-preload\.js'\),[\s\S]{0,400}contextIsolation: true,/);
  assert.match(MAIN, /preload: path\.join\(__dirname, 'preload\.js'\),[\s\S]{0,200}contextIsolation: true,/);
});

test('the bridges are exposed through contextBridge, never as page globals', () => {
  assert.match(APP_PRELOAD, /contextBridge\.exposeInMainWorld\('havenDesktop', \{/);
  assert.match(APP_PRELOAD, /contextBridge\.exposeInMainWorld\('__havenDesktopPage', \{/);
  assert.doesNotMatch(APP_PRELOAD, /window\.havenDesktop\s*=/);
  assert.match(WELCOME_PRELOAD, /contextBridge\.exposeInMainWorld\('haven', \{/);
  assert.doesNotMatch(WELCOME_PRELOAD, /window\.haven\s*=/);
});

test('the page world bridge names every channel it uses', () => {
  const start = APP_PRELOAD.indexOf("contextBridge.exposeInMainWorld('__havenDesktopPage'");
  const block = APP_PRELOAD.slice(start, APP_PRELOAD.indexOf('\n});', start));
  const calls = [...block.matchAll(/ipcRenderer\.(send|sendSync|invoke)\(([^,)]+)/g)].map(m => m[2].trim());
  assert.ok(calls.length > 5);
  for (const channel of calls) {
    // The one computed channel is a dialog kind checked against a fixed list.
    if (channel === '`dialog:${kind}`') continue;
    assert.match(channel, /^'[a-z0-9:-]+'$|^enter === true \?/, channel);
  }
  assert.match(block, /if \(!PAGE_DIALOGS\.has\(kind\)\) return null;/);
});

test('the page world holds nothing from Electron or Node', () => {
  const body = PAGE_WORLD.slice(PAGE_WORLD.indexOf('function installPageWorld'), PAGE_WORLD.indexOf('function pageWorldSource'));
  assert.doesNotMatch(body, /ipcRenderer|require\(|process\./);
});

function runPageWorld() {
  const calls = [];
  let listener = null;
  const listeners = new Map();
  const proto = () => function Stub() {};
  const Storage = proto();
  Storage.prototype.setItem = function (k, v) { this[k] = String(v); };
  Storage.prototype.removeItem = function (k) { delete this[k]; };
  const localStorage = new Storage();
  const window = {
    localStorage,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: () => true,
    __havenDesktopPage: {
      subscribe: (fn) => { if (listener) return false; listener = fn; return true; },
      t: (key) => key,
      dialog: (kind, message, value) => { calls.push(['dialog', kind, message, value]); return kind === 'confirm' ? true : 'answer'; },
      notify: (opts) => { calls.push(['notify', opts.title, opts.channelCode]); },
      fullscreen: (on) => { calls.push(['fullscreen', on]); },
      serverLocaleChanged: (v) => { calls.push(['locale', v]); },
      reportServerLanguage: () => {},
      shortcutsGet: async () => ({}),
      getEncoderConfig: async () => ({}),
      stopCapture: async () => true,
      prepareShareResult: (id, ready) => { calls.push(['prepared', id, ready]); },
    },
  };
  const Element = proto();
  const Document = proto();
  const context = vm.createContext({
    window,
    Storage,
    Element,
    Document,
    document: { head: null, documentElement: null, addEventListener: () => {}, getElementById: () => null, dispatchEvent: () => true },
    navigator: {},
    RTCPeerConnection: proto(),
    RTCRtpSender: proto(),
    MediaStreamTrack: proto(),
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    Event: function Event(type) { this.type = type; },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, Map, Set, WeakMap, WeakSet, Float32Array,
  });
  // The page's window is the global object.
  for (const key of ['Storage', 'Element', 'Document', 'RTCPeerConnection', 'RTCRtpSender', 'MediaStreamTrack']) window[key] = context[key];
  const { pageWorldSource } = require('../src/main/app-page-world');
  vm.runInContext(pageWorldSource(), context);
  return { window, calls, emit: (kind, payload) => listener(kind, payload), hasListener: () => !!listener, localStorage };
}

test('the injected page world is valid on its own and wires the page globals to the bridge', () => {
  const p = runPageWorld();
  assert.ok(p.hasListener(), 'the page world subscribed to the bridge');
  assert.equal(p.window.__havenDesktopPage.subscribe(() => {}), false, 'a later caller cannot take the events');

  assert.equal(p.window.confirm('Sure?'), true);
  assert.equal(p.window.prompt('Name?', 'x'), 'answer');
  p.window.alert('Hi');
  assert.deepEqual(p.calls.filter(c => c[0] === 'dialog'), [
    ['dialog', 'confirm', 'Sure?', ''],
    ['dialog', 'prompt', 'Name?', 'x'],
    ['dialog', 'alert', 'Hi', ''],
  ]);

  const n = new p.window.Notification('Hello', { channelCode: 'c1' });
  assert.ok(n);
  assert.equal(p.window.Notification.permission, 'granted');
  assert.deepEqual(p.calls.find(c => c[0] === 'notify'), ['notify', 'Hello', 'c1']);

  p.localStorage.setItem('haven_locale', 'pt');
  p.localStorage.removeItem('haven_locale');
  p.localStorage.setItem('other', '1');
  assert.deepEqual(p.calls.filter(c => c[0] === 'locale'), [['locale', 'pt'], ['locale', 'auto']]);
});

// A full screen stream has to cover the whole page, members panel and
// sidebar included, so it goes into the top layer as a popover (#5755).
function fakeElement({ popover = false, failShow = false } = {}) {
  const attrs = new Map(popover ? [['popover', 'auto']] : []);
  const classes = new Set();
  const el = {
    isConnected: true,
    open: false,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
    hasAttribute: (n) => attrs.has(n),
    getAttribute: (n) => attrs.get(n),
    setAttribute: (n, v) => attrs.set(n, String(v)),
    removeAttribute: (n) => attrs.delete(n),
    matches: (sel) => sel === ':popover-open' && el.open,
    showPopover() { if (failShow) throw new Error('not allowed'); el.open = true; },
    hidePopover() { el.open = false; },
  };
  return el;
}

test('full screen puts the element in the top layer and takes it out again', () => {
  const p = runPageWorld();
  const el = fakeElement();
  p.window.Element.prototype.requestFullscreen.call(el);
  assert.equal(el.open, true, 'shown as a popover');
  assert.equal(el.getAttribute('popover'), 'manual');
  assert.ok(el.classList.has('haven-manual-fullscreen'));
  p.window.Document.prototype.exitFullscreen.call({});
  assert.equal(el.open, false);
  assert.equal(el.hasAttribute('popover'), false, 'the attribute we added is gone');
  assert.equal(el.classList.has('haven-manual-fullscreen'), false);
  assert.deepEqual(p.calls.filter(c => c[0] === 'fullscreen'), [['fullscreen', true], ['fullscreen', false]]);

  // The page's own popover is left alone, and a refused top layer still
  // goes full screen with the class.
  const own = fakeElement({ popover: true });
  p.window.Element.prototype.requestFullscreen.call(own);
  p.window.Document.prototype.exitFullscreen.call({});
  assert.equal(own.getAttribute('popover'), 'auto');
  const refused = fakeElement({ failShow: true });
  p.window.Element.prototype.requestFullscreen.call(refused);
  assert.ok(refused.classList.has('haven-manual-fullscreen'));
  assert.equal(refused.hasAttribute('popover'), false);
});
