'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getHttpOrigin, isTrustedMainFrame } = require('../src/main/ipc-security');

function createSender(url = 'https://haven.example/app.html') {
  const mainFrame = { url, isDestroyed: () => false };
  return {
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  };
}

test('accepts only the current top-level frame on the registered server origin', () => {
  const sender = createSender();
  assert.equal(
    isTrustedMainFrame(sender, sender.mainFrame, 'https://haven.example/team'),
    true
  );
});

test('rejects child frames even when they share the server origin', () => {
  const sender = createSender();
  const childFrame = { url: sender.mainFrame.url, isDestroyed: () => false };
  assert.equal(
    isTrustedMainFrame(sender, childFrame, 'https://haven.example'),
    false
  );
});

test('rejects a server WebContents after cross-origin navigation', () => {
  const sender = createSender('https://attacker.example/app.html');
  assert.equal(
    isTrustedMainFrame(sender, sender.mainFrame, 'https://haven.example'),
    false
  );
});

test('rejects stale frame URLs during navigation', () => {
  const sender = createSender();
  sender.getURL = () => 'https://attacker.example/landing';
  assert.equal(
    isTrustedMainFrame(sender, sender.mainFrame, 'https://haven.example'),
    false
  );
});

test('accepts only HTTP server origins', () => {
  assert.equal(getHttpOrigin('https://haven.example/app.html'), 'https://haven.example');
  assert.equal(getHttpOrigin('file:///tmp/picker.html'), null);
  assert.equal(getHttpOrigin('not a URL'), null);
});

test('remote app preload cannot receive picker previews or submit consent', () => {
  const preload = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'app-preload.js'),
    'utf8'
  );
  assert.doesNotMatch(preload, /ipcRenderer\.on\('screen:show-picker'/);

  const pickerHtml = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'screen-picker.html'),
    'utf8'
  );
  assert.match(pickerHtml, /default-src 'none'/);
  assert.match(pickerHtml, /script-src 'self'/);
});

test('timed out audio preparations are cancelled and serialized in the preload', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'main.js'),
    'utf8'
  );
  const preload = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'app-preload.js'),
    'utf8'
  );

  assert.match(main, /requestFrame\.send\('screen:prepare-share-cancel'/);
  assert.match(preload, /ipcRenderer\.on\('screen:prepare-share-cancel'/);
  assert.match(preload, /_audioPreparationQueue = _audioPreparationQueue\.then\(prepare, prepare\)/);
});
