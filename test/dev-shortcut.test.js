'use strict';

// The Start Menu shortcut of a copy run from source must be one Electron
// accepts as its own, or Electron rewrites it without our arguments and icon
// on the first notification.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEV_PRODUCT_NAME,
  DEV_TOAST_CLSID,
  devShortcutName,
  devShortcutOptions,
  sameShortcut,
  isStaleDevShortcut,
} = require('../src/main/dev-shortcut');

const EXE = 'C:\\Haven-Desktop\\node_modules\\electron\\dist\\electron.exe';
const APP = 'C:\\Haven-Desktop';
const ICON = 'C:\\Users\\me\\AppData\\Local\\Haven Desktop (source)\\haven-taskbar.ico';

test('the shortcut is named after the product name stamped into electron.exe', () => {
  assert.equal(DEV_PRODUCT_NAME, 'Haven Desktop (source)');
  assert.equal(devShortcutName(), 'Haven Desktop (source).lnk');
  assert.notEqual(DEV_PRODUCT_NAME, 'Haven', 'Haven is the installed app, whose shortcut Electron would take over');
});

test('the shortcut carries what Electron checks: exe, exe folder, app id, CLSID', () => {
  const o = devShortcutOptions({ execPath: EXE, appPath: APP, dev: true, icon: ICON });
  assert.equal(o.target, EXE);
  assert.equal(o.cwd, 'C:\\Haven-Desktop\\node_modules\\electron\\dist');
  assert.equal(o.appUserModelId, 'com.haven.desktop');
  assert.equal(o.toastActivatorClsid, DEV_TOAST_CLSID);
  assert.match(DEV_TOAST_CLSID, /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
  assert.equal(o.args, '"C:\\Haven-Desktop" --dev');
  assert.equal(o.icon, ICON);
  assert.equal(o.iconIndex, 0);
  assert.equal(devShortcutOptions({ execPath: EXE, appPath: APP, dev: false }).args, '"C:\\Haven-Desktop"');
});

test('a shortcut read back from disk counts as the same one', () => {
  const wanted = devShortcutOptions({ execPath: EXE, appPath: APP, dev: true, icon: ICON });
  // readShortcutLink output: description and iconIndex extra, case may differ.
  const onDisk = {
    ...wanted,
    target: EXE.toUpperCase(),
    description: 'whatever',
    toastActivatorClsid: DEV_TOAST_CLSID.toLowerCase(),
  };
  assert.equal(sameShortcut(onDisk, wanted), true);
});

test('the old shortcut, or the one Electron writes, is rewritten', () => {
  const wanted = devShortcutOptions({ execPath: EXE, appPath: APP, dev: true, icon: ICON });
  assert.equal(sameShortcut(null, wanted), false);
  // What main.js used to write: working folder was the app, and no CLSID.
  const old = { ...wanted, cwd: APP, toastActivatorClsid: undefined };
  assert.equal(sameShortcut(old, wanted), false);
  // What Electron writes: no arguments and no icon.
  const electrons = { ...wanted, args: '', icon: '' };
  assert.equal(sameShortcut(electrons, wanted), false);
  assert.equal(sameShortcut({ ...wanted, toastActivatorClsid: '{00000000-0000-0000-0000-000000000000}' }, wanted), false);
});

test('Electron.lnk and stray copies with our id are stale, the installed app is not', () => {
  assert.equal(isStaleDevShortcut({ target: 'C:\\old\\node_modules\\electron\\dist\\electron.exe', appUserModelId: 'com.haven.desktop' }), true);
  assert.equal(isStaleDevShortcut({ target: 'C:\\Users\\me\\AppData\\Local\\Programs\\Haven\\Haven.exe', appUserModelId: 'com.haven.desktop' }), false);
  assert.equal(isStaleDevShortcut({ target: 'C:\\x\\electron.exe', appUserModelId: 'com.other.app' }), false);
  assert.equal(isStaleDevShortcut(null), false);
});
