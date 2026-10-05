'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { x11RelaunchOptions } = require('../src/main/linux-x11');

const base = { platform: 'linux', enabled: true, argv: ['/opt/Haven/haven', '--hidden'], env: {}, execPath: '/opt/Haven/haven' };

test('X11 mode restarts with the ozone flag, keeping the other arguments', () => {
  assert.deepEqual(x11RelaunchOptions(base), { execPath: '/opt/Haven/haven', args: ['--hidden', '--ozone-platform=x11'] });
});

test('an AppImage restarts from the .AppImage file', () => {
  const opts = x11RelaunchOptions({ ...base, env: { APPIMAGE: '/home/me/Haven-1.5.0.AppImage' }, execPath: '/tmp/.mount_HavenX/haven' });
  assert.equal(opts.execPath, '/home/me/Haven-1.5.0.AppImage');
});

test('nothing to do when off, not Linux, or a platform was already given', () => {
  assert.equal(x11RelaunchOptions({ ...base, enabled: false }), null);
  assert.equal(x11RelaunchOptions({ ...base, enabled: undefined }), null);
  assert.equal(x11RelaunchOptions({ ...base, platform: 'win32' }), null);
  // The relaunched copy, so it never loops.
  assert.equal(x11RelaunchOptions({ ...base, argv: [...base.argv, '--ozone-platform=x11'] }), null);
  // Someone who typed a platform themselves.
  assert.equal(x11RelaunchOptions({ ...base, argv: [...base.argv, '--ozone-platform=wayland'] }), null);
});

test('main relaunches before the single instance lock and exposes the setting', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const relaunch = main.indexOf('app.relaunch(x11Relaunch)');
  assert.ok(relaunch > 0 && relaunch < main.indexOf('app.requestSingleInstanceLock()'));
  assert.match(main, /'linuxForceX11'/);
  assert.match(main, /desktop:set-linux-force-x11/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');
  assert.match(preload, /setLinuxForceX11:\s*\(v\)\s*=> ipcRenderer\.invoke\('desktop:set-linux-force-x11', v\)/);
});
