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
  assert.match(MAIN, /setPermissionRequestHandler\(\(contents, permission, callback, details\) => \{[\s\S]{0,300}const allowed = permissionAllowed\(\{ permission, requester, requestingOrigin \}\);/);
  assert.match(MAIN, /setPermissionCheckHandler\(\(contents, permission, requestingOrigin, details\) => \{\s*const requester = permissionRequester\(contents\);\s*return permissionAllowed\(/);
  assert.match(MAIN, /serverPopupOwners\.set\(child\.webContents, url\);/);
});

test('a server page stays on its server; embeds are frames, never the page', () => {
  const { serverNavigation } = require('../src/main/ipc-policy');
  const server = 'https://haven.example:3000';
  assert.equal(serverNavigation('https://haven.example:3000/app.html?channel=x', server), 'stay');
  assert.equal(serverNavigation('https://www.youtube.com/watch?v=1', server), 'browser');
  assert.equal(serverNavigation('https://open.spotify.com/track/1', server), 'browser');
  assert.equal(serverNavigation('https://haven.example/app.html', server), 'browser', 'another port is another server');
  assert.equal(serverNavigation('ms-msdt:/id', server), 'block');
  assert.equal(serverNavigation('file://server/share/x.exe', server), 'block');
  assert.equal(serverNavigation('not a url', server), 'block');
});

test('server views check navigations and redirects, and popups get their own guards', () => {
  assert.doesNotMatch(MAIN, /EMBED_ORIGINS/);
  assert.match(MAIN, /view\.webContents\.on\('will-navigate', \(event, navUrl\) => \{\s*const verdict = signIn\.decide\(navUrl, url\);/);
  assert.match(MAIN, /view\.webContents\.on\('will-redirect', /);
  assert.match(MAIN, /guardServerPopup\(child\.webContents\);/);
  const popup = MAIN.slice(MAIN.indexOf('function guardServerPopup'), MAIN.indexOf('function getServerUrlForContents'));
  assert.match(popup, /'will-navigate'/);
  assert.match(popup, /'will-redirect'/);
  assert.match(popup, /setWindowOpenHandler\([\s\S]*action: 'deny'/);
});

test('a server that got the mic while shown keeps it while hidden, for its own origin only', () => {
  const { permissionAllowed } = require('../src/main/ipc-policy');
  const ask = (permission, requester, requestingOrigin) => permissionAllowed({ permission, requester, requestingOrigin });
  const inCall = { kind: 'server', origin: 'https://a.example', active: false, mediaOrigin: 'https://a.example' };
  assert.equal(ask('media', inCall, 'https://a.example'), true, 'the call goes on behind another server');
  assert.equal(ask('media', inCall, 'https://www.youtube.com'), false);
  assert.equal(ask('display-capture', inCall, 'https://a.example'), false, 'screen capture stays shown only');
  assert.equal(ask('window-management', inCall, 'https://a.example'), false);
  const moved = { ...inCall, origin: 'https://b.example' };
  assert.equal(ask('media', moved, 'https://a.example'), false, 'not once the view belongs to another origin');
  assert.equal(ask('media', { ...inCall, mediaOrigin: null }, 'https://a.example'), false, 'never granted: never');
});

test('main remembers a shown grant and forgets it when the page changes origin', () => {
  assert.match(MAIN, /if \(allowed && permission === 'media' && requester\?\.kind === 'server' && requester\.active\) \{\s*mediaGrantOrigins\.set\(contents, requestingOrigin\);/);
  assert.match(MAIN, /mediaOrigin: mediaGrantOrigins\.get\(contents\) \|\| null,/);
  assert.match(MAIN, /view\.webContents\.on\('did-navigate', \(_e, navUrl\) => forgetMediaGrantOnNavigation\(view\.webContents, navUrl\)\);/);
  const forget = MAIN.slice(MAIN.indexOf('function forgetMediaGrantOnNavigation'), MAIN.indexOf('function forgetMediaGrantOnNavigation') + 250);
  assert.match(forget, /getHttpOrigin\(url\) !== granted\) mediaGrantOrigins\.delete\(contents\)/);
});
