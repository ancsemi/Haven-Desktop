'use strict';

// Listen Together media keys: which keys main takes and for whom, the page
// world section that passes claims and presses along, and the wiring in
// main and the preload.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  MEDIA_KEY_ACTIONS, mediaKeyAction, isMediaKeyAction, claimWanted, createMediaKeyClaims,
} = require('../src/main/media-keys');

const WORLD = fs.readFileSync(path.join(__dirname, '../src/main/app-page-world.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');

test('the three media keys map to the player actions and nothing else does', () => {
  assert.deepEqual({ ...MEDIA_KEY_ACTIONS }, {
    MediaPlayPause: 'playpause', MediaNextTrack: 'nexttrack', MediaPreviousTrack: 'previoustrack',
  });
  assert.equal(mediaKeyAction('MediaPlayPause'), 'playpause');
  assert.equal(mediaKeyAction('MediaNextTrack'), 'nexttrack');
  assert.equal(mediaKeyAction('MediaPreviousTrack'), 'previoustrack');
  for (const accel of ['MediaStop', 'VolumeUp', 'Space', 'toString', '__proto__', '', undefined]) {
    assert.equal(mediaKeyAction(accel), null, String(accel));
  }
  assert.equal(isMediaKeyAction('playpause'), true);
  assert.equal(isMediaKeyAction('stop'), false);
});

test('only an explicit claim asks for the keys', () => {
  assert.equal(claimWanted({ wanted: true }), true);
  for (const payload of [{ wanted: false }, { wanted: 'true' }, { wanted: 1 }, true, null, undefined, 'yes']) {
    assert.equal(claimWanted(payload), false, JSON.stringify(payload));
  }
});

test('the keys are held while any page asks and go to the page on screen first', () => {
  const claims = createMediaKeyClaims();
  assert.equal(claims.wanted(), false);
  assert.equal(claims.target(1), null, 'nobody asked: no target');

  assert.equal(claims.set(1, true), true, 'the first claim takes the keys');
  assert.equal(claims.set(1, true), false, 'asking again changes nothing');
  assert.equal(claims.set(2, true), false, 'still held');
  assert.equal(claims.target(null), 2, 'the latest page to ask');
  assert.equal(claims.target(1), 1, 'the page on screen when it asked');
  assert.equal(claims.target(3), 2, 'the page on screen did not ask');

  assert.equal(claims.set(2, false), false, 'page 1 still asks');
  assert.equal(claims.target(3), 1);
  assert.equal(claims.drop(1), true, 'the last claim gone lets go of the keys');
  assert.equal(claims.wanted(), false);
  assert.equal(claims.drop(1), false);
  assert.equal(claims.set(5, false), false);
});

function runWorldSection() {
  const start = WORLD.indexOf('// ─── Listen Together media keys');
  const end = WORLD.indexOf('// ─── Global voice shortcut triggers', start);
  assert.ok(start > 0 && end > start, 'media key section found');
  const handlers = new Map();
  const docListeners = new Map();
  const sent = [];
  const logs = [];
  const app = { presses: [], _musicMediaKey(action) { this.presses.push(action); return action !== 'previoustrack'; } };
  const window = { app };
  const context = vm.createContext({
    on: (kind, fn) => handlers.set(kind, fn),
    bridge: { musicMediaKeys: (wanted) => sent.push(wanted) },
    document: { addEventListener: (type, fn) => docListeners.set(type, fn) },
    window,
    console: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  vm.runInContext(WORLD.slice(start, end), context);
  return {
    app, window, sent, logs,
    claim: (detail) => docListeners.get('haven:music-media-keys')({ detail }),
    press: (action) => handlers.get('music:media-key')(action),
  };
}

test('the page world passes the client\'s claim to main, strictly', () => {
  const w = runWorldSection();
  w.claim({ wanted: true });
  w.claim({ wanted: false });
  w.claim({ wanted: 'yes' });
  w.claim(undefined);
  assert.deepEqual(w.sent, [true, false, false, false]);
});

test('a press runs the client\'s control, and only for the known actions', () => {
  const w = runWorldSection();
  w.press('playpause');
  w.press('nexttrack');
  w.press('previoustrack');
  w.press('stop');
  w.press({ toString: () => 'playpause' });
  assert.deepEqual(w.app.presses, ['playpause', 'nexttrack', 'previoustrack']);
  assert.ok(w.logs.some(l => /previoustrack: nothing to do/.test(l)), 'a refused press is logged');

  // A server too old for Listen Together keys has no control to run.
  delete w.window.app;
  w.press('playpause');
  assert.ok(w.logs.some(l => /no shared player controls/.test(l)));
});

test('main takes the keys only through a trusted server frame and lets voice shortcuts keep theirs', () => {
  assert.match(MAIN, /require\('\.\/media-keys'\)/);
  assert.match(MAIN, /ipcMain\.on\('music:media-keys', \(e, payload\) => \{\r?\n\s+if \(!getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame\)\) return;/);
  assert.match(MAIN, /function unregisterVoiceShortcuts\(\) \{[\s\S]{0,300}releaseMediaKeys\(\);/);
  assert.match(MAIN, /if \(needUiohook\) _ensureUiohookStarted\(\);\r?\n\s+refreshMediaKeys\(\);/);
  assert.match(MAIN, /_mediaKeysHeld\.has\(accel\) \|\| globalShortcut\.isRegistered\(accel\)/);
  assert.match(MAIN, /if \(!mediaKeyClaims\.wanted\(\)\) \{ releaseMediaKeys\(\); return; \}/);
  assert.match(MAIN, /contents\.once\('destroyed', forget\);/);
  assert.match(MAIN, /contents\.on\('did-navigate', forget\);/);
  assert.match(PRELOAD, /musicMediaKeys: \(wanted\) => ipcRenderer\.send\('music:media-keys', \{ wanted: wanted === true \}\)/);
  assert.match(PRELOAD, /'voice:ptm-down', 'voice:ptm-up', 'music:media-key',/);
});
