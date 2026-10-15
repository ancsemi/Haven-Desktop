'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isTypingKeyAccelerator, dialogHost, notificationTitle } = require('../src/main/ipc-policy');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

test('keys that type are never global shortcuts on their own', () => {
  for (const accel of ['V', 'm', '1', '`', '/', 'Space', 'Tab', 'Enter', 'Backspace', 'Plus',
    'num5', 'numadd', 'Shift+A', 'Shift+Space']) {
    assert.equal(isTypingKeyAccelerator(accel), true, accel);
  }
});

test('combos, function keys, lone modifiers and mouse buttons are fine', () => {
  for (const accel of ['CommandOrControl+Shift+M', 'Ctrl+Space', 'Alt+V', 'Shift+Alt+num0',
    'F9', 'F13', 'Shift', 'Alt', 'CommandOrControl', 'Mouse4', 'Home', 'Insert', 'NumLock', '', null]) {
    assert.equal(isTypingKeyAccelerator(accel), false, String(accel));
  }
});

test('a dialog and a hidden server notification name the server asking', () => {
  assert.equal(dialogHost('https://haven.example:3000/app.html'), 'haven.example:3000');
  assert.equal(dialogHost('nonsense'), '');
  assert.equal(notificationTitle('#general', { active: true, serverName: 'Home' }), '#general');
  assert.equal(notificationTitle('#general', { active: false, serverName: 'Home' }), 'Home · #general');
  assert.equal(notificationTitle(undefined, { active: true }), 'Haven');
});

function handlerBody(channel) {
  const start = MAIN.search(new RegExp(`(ipcMain\\.(handle|on)|handleFromActiveServer)\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.ok(start >= 0, `${channel} handler found`);
  const next = MAIN.slice(start + 10).search(/\n {2}(ipcMain\.|handleFromActiveServer\(|const )/);
  return MAIN.slice(start, next >= 0 ? start + 10 + next : undefined);
}

test('settings, clipboard, saving and shortcuts answer only the server on screen', () => {
  for (const channel of ['desktop:set-start-on-login', 'desktop:set-start-hidden', 'desktop:set-minimize-to-tray',
    'desktop:set-force-sdr', 'desktop:set-hide-menu-bar', 'desktop:set-disable-gpu-vsync',
    'desktop:set-flash-taskbar', 'desktop:set-unlimit-frame-rate', 'desktop:set-linux-vaapi-bypass',
    'desktop:set-linux-force-x11', 'shortcuts:register', 'clipboard:write-text', 'clipboard:write-image',
    'dialog:save-image', 'devices:get-inputs', 'devices:get-outputs']) {
    assert.match(MAIN, new RegExp(`handleFromActiveServer\\('${channel}'`), channel);
    assert.doesNotMatch(MAIN, new RegExp(`ipcMain\\.handle\\('${channel}'`), channel);
  }
});

test('the server list and the badges that name it go only to app screens and the shown server', () => {
  for (const channel of ['server-history:get', 'server-history:get-sync', 'server-list:get',
    'server-list:get-sync', 'get-server-badges', 'server-mute:get-all']) {
    assert.match(handlerBody(channel), /serverListReader\(e\)/, channel);
  }
  assert.match(handlerBody('notification-badge'), /getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame\)/);
  assert.doesNotMatch(handlerBody('notification-badge'), /for \(const \[, view\] of serverViews\)/);
  assert.match(handlerBody('report-known-server-urls'), /getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame\)/);
});

test('page dialogs are asynchronous, for the shown server only, and name it', () => {
  assert.doesNotMatch(MAIN, /showMessageBoxSync/);
  const body = MAIN.slice(MAIN.indexOf('const pageDialog'), MAIN.indexOf("ipcMain.on('dialog:alert'"));
  assert.match(body, /\{ active: true \}/);
  assert.match(body, /t\('dialog\.fromServer', \{ host: dialogHost\(serverUrl\) \}\)/);
  assert.match(body, /dialog\.showMessageBox\(mainWindow, options\)/);
});

test('notifications come from a server page top frame', () => {
  assert.match(handlerBody('notify'), /getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame\)/);
});

test('the microphone and camera go only to the server on screen, from its own origin', () => {
  const { permissionAllowed } = require('../src/main/ipc-policy');
  const shown = { kind: 'server', origin: 'https://a.example', active: true };
  const hidden = { kind: 'server', origin: 'https://b.example', active: false };
  const popup = { kind: 'popup', origin: 'https://a.example' };
  const ask = (permission, requester, requestingOrigin) => permissionAllowed({ permission, requester, requestingOrigin });

  assert.equal(ask('media', shown, 'https://a.example'), true);
  assert.equal(ask('display-capture', shown, 'https://a.example'), true);
  assert.equal(ask('media', shown, 'https://www.youtube.com'), false, 'not an embed on the shown page');
  assert.equal(ask('media', hidden, 'https://b.example'), false, 'not a hidden background server');
  assert.equal(ask('media', popup, 'https://a.example'), false, 'not a popup');
  assert.equal(ask('media', null, 'https://a.example'), false, 'not an unknown page');
  assert.equal(ask('media', { kind: 'local' }, null), false);

  assert.equal(ask('notifications', hidden, 'https://b.example'), true, 'hidden servers still notify');
  assert.equal(ask('notifications', hidden, 'https://a.example'), false);
  assert.equal(ask('clipboard-write', popup, 'https://a.example'), true);
  assert.equal(ask('fullscreen', shown, 'https://www.youtube.com'), true, 'an embedded video can go full screen');
  assert.equal(ask('fullscreen', { kind: 'local' }, null), true);
  assert.equal(ask('clipboard-read', shown, 'https://a.example'), false);
  assert.equal(ask('geolocation', shown, 'https://a.example'), false);
});

test('main asks the permission rules for every request and check', () => {
  assert.match(MAIN, /setPermissionRequestHandler\(\(contents, permission, callback, details\) => \{\s*callback\(permissionAllowed\(/);
  assert.match(MAIN, /setPermissionCheckHandler\(\(contents, permission, requestingOrigin, details\) => \{\s*const requester = permissionRequester\(contents\);\s*return permissionAllowed\(/);
  assert.match(MAIN, /serverPopupOwners\.set\(child\.webContents, url\);/);
});
