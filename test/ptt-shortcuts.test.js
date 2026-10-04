'use strict';

// Runs the push to talk section of the app preload with stand-ins for
// Electron and the page, and checks what reaches the mic (Haven #5724).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');
const START = SOURCE.indexOf('// ─── Global voice shortcut triggers');
const END = SOURCE.indexOf('// ─── Server badge state updates', START);

async function loadPtt(config) {
  const ipc = new Map();
  const listeners = new Map();
  let now = 1000;
  const app = { voice: { isMuted: true, inVoice: true }, toggles: 0 };
  app._toggleMute = () => { app.voice.isMuted = !app.voice.isMuted; app.toggles++; };
  const context = vm.createContext({
    ipcRenderer: {
      on: (channel, fn) => ipc.set(channel, fn),
      invoke: async (channel) => (channel === 'shortcuts:get' ? config : null),
    },
    window: {
      app,
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    },
    document: { getElementById: () => null },
    console: { log() {}, warn() {} },
    Date: { now: () => now },
  });
  assert.ok(START > 0 && END > START, 'push to talk section found');
  vm.runInContext(SOURCE.slice(START, END), context);
  for (const fn of listeners.get('DOMContentLoaded') || []) fn();
  await new Promise(resolve => setImmediate(resolve));
  const fire = (type, event) => (listeners.get(type) || []).forEach(fn => fn(event));
  return {
    app,
    hook: (channel) => ipc.get(channel)(),
    key: (type, key, extra = {}) => fire(type, { key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }),
    wait: (ms) => { now += ms; },
  };
}

test('toggle mode: a key press in the focused window flips the mic each time', async () => {
  const p = await loadPtt({ ptt: 'F8', pttMode: 'toggle' });
  p.key('keydown', 'F8');
  assert.equal(p.app.voice.isMuted, false, 'first press opens the mic');
  p.key('keyup', 'F8');
  assert.equal(p.app.voice.isMuted, false, 'releasing does nothing in toggle mode');
  p.wait(400);
  p.key('keydown', 'F8');
  assert.equal(p.app.voice.isMuted, true, 'second press closes it again');
});

test('toggle mode: the hook and the page seeing one press flip it once', async () => {
  const p = await loadPtt({ ptt: 'F8', pttMode: 'toggle' });
  p.key('keydown', 'F8');
  p.wait(20);
  p.hook('voice:ptt-toggle');
  assert.equal(p.app.toggles, 1);
  p.wait(400);
  p.hook('voice:ptt-toggle');
  assert.equal(p.app.toggles, 2, 'a later press from the hook alone still works');
});

test('toggle mode: holding the key does not flip it on every repeat', async () => {
  const p = await loadPtt({ ptt: 'F8', pttMode: 'toggle' });
  p.key('keydown', 'F8');
  p.wait(500);
  p.key('keydown', 'F8', { repeat: true });
  assert.equal(p.app.toggles, 1);
});

test('hold mode is unchanged: talk while held, muted on release', async () => {
  const p = await loadPtt({ ptt: 'F8', pttMode: 'hold' });
  p.key('keydown', 'F8');
  assert.equal(p.app.voice.isMuted, false);
  p.key('keydown', 'F8', { repeat: true });
  p.key('keyup', 'F8');
  assert.equal(p.app.voice.isMuted, true);
  assert.equal(p.app.toggles, 2);
});

test('other keys do nothing', async () => {
  const p = await loadPtt({ ptt: 'F8', pttMode: 'toggle' });
  p.key('keydown', 'F9');
  assert.equal(p.app.toggles, 0);
});
