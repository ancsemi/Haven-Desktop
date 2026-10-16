'use strict';

// Push to mute (hold): the page world section that follows the key, run with
// stand-ins for the preload's bridge and the page, and the rules main uses
// to take its binding.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { isHoldShortcut, shortcutKeyRefused } = require('../src/main/ipc-policy');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/main/app-page-world.js'), 'utf8');
const START = SOURCE.indexOf('// ─── Global voice shortcut triggers');
const END = SOURCE.indexOf('// ─── Receive PCM chunks', START);
const MAIN = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');

// withClient: the server's client has its own push to mute (Haven 4.24.5+).
async function load(config, { isMuted = false, inVoice = true, withClient = false } = {}) {
  const ipc = new Map();
  const listeners = new Map();
  const app = { voice: { isMuted, inVoice }, toggles: 0, ptm: [] };
  app._toggleMute = () => { app.voice.isMuted = !app.voice.isMuted; app.toggles++; };
  if (withClient) {
    app._pushToMute = (held) => app.ptm.push(held);
    app._micUserMuted = () => 'user-muted';
  }
  const context = vm.createContext({
    on: (channel, fn) => ipc.set(channel, fn),
    bridge: { shortcutsGet: async () => config },
    window: {
      app,
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    },
    document: { getElementById: () => null },
    console: { log() {}, warn() {} },
    Date: { now: () => 1000 },
  });
  assert.ok(START > 0 && END > START, 'voice shortcut section found');
  vm.runInContext(SOURCE.slice(START, END), context);
  for (const fn of listeners.get('DOMContentLoaded') || []) fn();
  await new Promise(resolve => setImmediate(resolve));
  const fire = (type, event) => (listeners.get(type) || []).forEach(fn => fn(event));
  return {
    app,
    hook: (channel) => ipc.get(channel)(),
    key: (type, key, extra = {}) => fire(type, { key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }),
    mouse: (type, button) => fire(type, { button }),
  };
}

test('main takes push to mute as a held shortcut and the preload forwards it', () => {
  assert.match(MAIN, /\{ name: 'ptm', +accel: cfg\.ptm, +event: 'voice:ptm', +mode: 'hold' +\}/);
  assert.match(MAIN, /new Set\(\['mute', 'deafen', 'ptt', 'ptm', 'pttMode'\]\)/);
  assert.match(MAIN, /\['mute', 'deafen', 'ptt', 'ptm'\]\.forEach/, 'unregistered with the others');
  assert.match(MAIN, /shortcuts:get', \(\) => \(\{ ptm: '', \.\.\.\(store\.get\('desktopShortcuts'\) \|\| \{\}\) \}\)/,
    'listed even when unbound, so the settings page shows the row');
  assert.match(MAIN, /if \(typingKey && !isHoldShortcut\(b\.name, cfg\)\)/);
  assert.match(PRELOAD, /'voice:ptm-down', 'voice:ptm-up',/);
});

test('letters and other typing keys are allowed for push to mute, and only through the hook', () => {
  for (const accel of ['V', 'Space', 'Shift+T', 'num0']) {
    assert.equal(shortcutKeyRefused({}, 'ptm', accel), false, accel);
    assert.equal(shortcutKeyRefused({ pttMode: 'toggle' }, 'ptm', accel), false, 'push to talk mode does not matter');
    assert.equal(shortcutKeyRefused({}, 'mute', accel), true, 'a toggle on it is refused');
    assert.equal(shortcutKeyRefused({}, 'deafen', accel), true);
  }
  assert.equal(shortcutKeyRefused({ pttMode: 'hold' }, 'ptt', 'V'), false, 'hold to talk as before');
  assert.equal(shortcutKeyRefused({ pttMode: 'toggle' }, 'ptt', 'V'), true);
  assert.equal(shortcutKeyRefused({}, 'ptm', ''), false);
  assert.equal(isHoldShortcut('ptm', {}), true);
  assert.equal(isHoldShortcut('mute', {}), false);
  // A typing key never becomes a global shortcut: a held binding that the
  // hook cannot take is skipped, not handed to globalShortcut.
  assert.match(MAIN, /if \(typingKey\) \{\r?\n\s*console\.warn\(`\[Shortcuts\] \$\{b\.accel\} needs the input hook/);
});

test('mouse buttons work for push to mute, through the same hook path as hold to talk', () => {
  // The hook path keys bindings by accelerator and event and sends
  // `${event}-down` / `-up` for every held one.
  assert.match(MAIN, /safeSend\(getActiveContents\(\), `\$\{binding\.event\}-down`\)/);
  assert.match(MAIN, /_uiohookMouseBindings\.set\(b\.accel \+ '\|' \+ b\.event/);
});

test('with the client: the hook and the page hand the key to the client', async () => {
  const p = await load({ ptm: 'V' }, { withClient: true });
  p.hook('voice:ptm-down');
  p.hook('voice:ptm-up');
  p.key('keydown', 'v');
  p.key('keydown', 'v', { repeat: true });
  p.key('keyup', 'v');
  assert.deepEqual(p.app.ptm, [true, false, true, false]);
  assert.equal(p.app.toggles, 0, 'the mute toggle is left to the client');
});

test('with the client: a mouse button binding follows press and release', async () => {
  const p = await load({ ptm: 'Mouse4' }, { withClient: true });
  p.mouse('mousedown', 3);
  p.mouse('mouseup', 3);
  p.mouse('mousedown', 0);
  assert.deepEqual(p.app.ptm, [true, false]);
});

test('with the client: push to talk reads the user\'s own mute, not the held one', async () => {
  const p = await load({ ptt: 'F8', pttMode: 'hold' }, { withClient: true });
  // _micUserMuted returns a truthy marker here; hold to talk must flip on a
  // press when the user's own mute says muted.
  p.hook('voice:ptt-down');
  assert.equal(p.app.toggles, 1);
});

test('older server: a live mic is muted while held and live again after', async () => {
  const p = await load({ ptm: 'V' });
  p.hook('voice:ptm-down');
  assert.equal(p.app.voice.isMuted, true);
  p.key('keydown', 'v'); // the page sees the same press
  assert.equal(p.app.toggles, 1);
  p.hook('voice:ptm-up');
  p.key('keyup', 'v');
  assert.equal(p.app.voice.isMuted, false);
  assert.equal(p.app.toggles, 2);
});

test('older server: already muted stays muted', async () => {
  const p = await load({ ptm: 'V' }, { isMuted: true });
  p.hook('voice:ptm-down');
  p.hook('voice:ptm-up');
  assert.equal(p.app.voice.isMuted, true);
  assert.equal(p.app.toggles, 0);
});

test('older server: push to talk while push to mute is held stays muted, and the release follows push to talk', async () => {
  const p = await load({ ptm: 'V', ptt: 'F8', pttMode: 'hold' }, { isMuted: true });
  p.hook('voice:ptm-down');
  p.hook('voice:ptt-down');
  assert.equal(p.app.voice.isMuted, true, 'mute wins');
  p.hook('voice:ptm-up');
  assert.equal(p.app.voice.isMuted, false, 'still talking');
  p.hook('voice:ptt-up');
  assert.equal(p.app.voice.isMuted, true);

  const q = await load({ ptm: 'V', ptt: 'F8', pttMode: 'hold' }, { isMuted: true });
  q.hook('voice:ptt-down');
  q.hook('voice:ptm-down');
  assert.equal(q.app.voice.isMuted, true, 'mute wins over a held talk key');
  q.hook('voice:ptt-up');
  q.hook('voice:ptm-up');
  assert.equal(q.app.voice.isMuted, true, 'talk key went up first: muted');
});

test('out of voice the key does nothing', async () => {
  const p = await load({ ptm: 'V' }, { inVoice: false });
  p.hook('voice:ptm-down');
  p.hook('voice:ptm-up');
  assert.equal(p.app.toggles, 0);
});
