'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { x11LaunchPlan, isX11Copy } = require('../src/main/linux-x11');

const base = { platform: 'linux', enabled: true, argv: ['/opt/Haven/haven', '--hidden'], env: {}, execPath: '/opt/Haven/haven', pending: undefined };

test('X11 mode starts an X11 copy with the flag, keeping the other arguments', () => {
  assert.deepEqual(x11LaunchPlan(base), { action: 'start-x11', command: '/opt/Haven/haven', args: ['--hidden', '--ozone-platform=x11'] });
});

test('an AppImage starts its copy from the .AppImage file', () => {
  const plan = x11LaunchPlan({ ...base, env: { APPIMAGE: '/home/me/Haven-1.6.1.AppImage' }, execPath: '/tmp/.mount_HavenX/haven' });
  assert.equal(plan.command, '/home/me/Haven-1.6.1.AppImage');
});

test('a lock retry flag is not carried into the X11 copy', () => {
  const plan = x11LaunchPlan({ ...base, argv: [...base.argv, '--relaunch-retry'] });
  assert.deepEqual(plan.args, ['--hidden', '--ozone-platform=x11']);
});

test('nothing to do when off, not Linux, or a platform was already given', () => {
  assert.equal(x11LaunchPlan({ ...base, enabled: false }).action, 'none');
  assert.equal(x11LaunchPlan({ ...base, enabled: undefined }).action, 'none');
  assert.equal(x11LaunchPlan({ ...base, platform: 'win32' }).action, 'none');
  // The X11 copy itself, so it never loops.
  assert.equal(x11LaunchPlan({ ...base, argv: [...base.argv, '--ozone-platform=x11'], pending: 123 }).action, 'none');
  // Someone who typed a platform themselves.
  assert.equal(x11LaunchPlan({ ...base, argv: [...base.argv, '--ozone-platform=wayland'] }).action, 'none');
});

test('a launch that finds the last X11 start never came up gives up instead of trying again (#5741)', () => {
  assert.equal(x11LaunchPlan({ ...base, pending: Date.now() - 60000 }).action, 'give-up');
});

test('the X11 copy is recognised by its flag', () => {
  assert.equal(isX11Copy(['/opt/Haven/haven', '--ozone-platform=x11']), true);
  assert.equal(isX11Copy(['/opt/Haven/haven']), false);
});

test('main starts the copy directly, never takes the lock while quitting, and recovers from a failed start', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
  const plan = main.indexOf('const x11Plan = x11LaunchPlan(');
  assert.ok(plan > 0 && plan < main.indexOf('requestSingleInstanceLock()'));
  assert.doesNotMatch(main, /app\.relaunch\(x11/);
  assert.match(main, /store\.set\('linuxX11Pending', Date\.now\(\)\);\n\s+try \{\n\s+require\('child_process'\)\.spawn\(x11Plan\.command, x11Plan\.args/);
  assert.match(main, /const gotLock = exitingForX11 \? false : app\.requestSingleInstanceLock\(\);/);
  assert.match(main, /if \(x11Plan\.action === 'give-up'\) \{\n[^]*?store\.set\('linuxForceX11', false\);/);
  assert.match(main, /if \(exitingForX11\) return;/);
  assert.match(main, /'linuxForceX11'/);
  assert.match(main, /desktop:set-linux-force-x11/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/app-preload.js'), 'utf8');
  assert.match(preload, /setLinuxForceX11:\s*\(v\)\s*=> ipcRenderer\.invoke\('desktop:set-linux-force-x11', v\)/);
});

test('a working X11 setup is not turned off by a second launch, a quick quit or turning the setting on again (#5741)', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
  const between = (start, length) => { const at = main.indexOf(start); assert.ok(at > 0, start); return main.slice(at, at + length); };
  // Launching Haven again while the X11 copy runs.
  assert.match(between("app.on('second-instance', (_event, argv) => {", 500), /if \(isX11Copy\(process\.argv\) \|\| isX11Copy\(argv\)\) clearX11Pending\(\);/);
  // Quitting the X11 copy within a few seconds of opening it.
  assert.match(between("app.on('before-quit', () => {", 300), /if \(isX11Copy\(process\.argv\)\) clearX11Pending\(\);/);
  // Turning the setting on or off in Settings.
  assert.match(between("ipcMain.handle('desktop:set-linux-force-x11'", 300), /clearX11Pending\(\);/);
  // A start that never comes up is only cleared by these, so it is still
  // found next time: the launch that starts the copy never clears it.
  const start = between("} else if (x11Plan.action === 'start-x11') {", 400);
  assert.doesNotMatch(start.slice(0, start.indexOf('} catch')), /clearX11Pending|linuxX11Pending'\)/);
  assert.equal((main.match(/clearX11Pending\b/g) || []).length, 5, 'definition, timer, second launch, quit, setting');
});
