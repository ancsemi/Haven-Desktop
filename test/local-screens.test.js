'use strict';

// The welcome window's bridge can start a server on this computer, so its
// page may not leave the local files, and the calls that act on this
// computer answer only that page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

function handlerBody(channel) {
  const start = MAIN.search(new RegExp(`ipcMain\\.(handle|on)\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.ok(start >= 0, `${channel} handler found`);
  // Up to the next handler is enough to see the guard at its top.
  const next = MAIN.indexOf('ipcMain.', start + 10);
  return MAIN.slice(start, next > start ? next : undefined);
}

test('every server management call answers only the welcome screen', () => {
  for (const channel of ['server:detect', 'server:start', 'server:stop', 'server:status', 'server:browse', 'server:browse-file']) {
    assert.match(handlerBody(channel), /fromWelcomeScreen\(e\)/, channel);
  }
});

test('updates, going back and the generic store need an app screen or the shown server', () => {
  for (const channel of ['update:download', 'update:install', 'nav:back-to-welcome']) {
    assert.match(handlerBody(channel), /fromAppScreen\(e\) && !fromActiveServer\(e\)/, channel);
  }
  for (const channel of ['settings:get', 'settings:set', 'open-external']) {
    assert.match(handlerBody(channel), /fromAppScreen\(e\)/, channel);
  }
});

test('the local windows cannot be navigated away from their files', () => {
  const guard = MAIN.slice(MAIN.indexOf('function keepOnLocalFiles'), MAIN.indexOf('function contentsOf'));
  assert.match(guard, /'will-navigate', \(event, url\) => \{\s*event\.preventDefault\(\);/);
  assert.match(guard, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*action: 'deny'/);
  assert.match(MAIN, /keepOnLocalFiles\(welcomeWindow\.webContents\)/);
  assert.match(MAIN, /keepOnLocalFiles\(mainWindow\.webContents\)/);
});
