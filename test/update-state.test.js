'use strict';

// The update banner must not depend on a page being open when the update
// check answers (Haven-Desktop #63).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createUpdateState, CHECK_INTERVAL_MS } = require('../src/main/update-state');

test('a page that loads after the check answered still gets the banner', () => {
  const s = createUpdateState();
  assert.equal(s.forPage(), null, 'nothing before a check answers');
  assert.equal(s.available('1.6.1'), true);
  assert.deepEqual(s.forPage(), { status: 'available', version: '1.6.1' });
});

test('closing the banner keeps it closed until a newer version or a menu check', () => {
  const s = createUpdateState();
  s.available('1.6.1');
  s.dismiss();
  assert.equal(s.forPage(), null);
  assert.equal(s.available('1.6.1'), false, 'the next background check stays quiet');
  assert.equal(s.available('1.6.1', true), true, 'Help, Check for Updates shows it again');
  assert.deepEqual(s.forPage(), { status: 'available', version: '1.6.1' });
  s.dismiss();
  assert.equal(s.available('1.6.2'), true, 'a newer version shows again');
});

test('a downloaded update asks for a restart and stops background checks', () => {
  const s = createUpdateState();
  s.available('1.6.1');
  assert.equal(s.shouldCheck(), true);
  s.setDownloading(true);
  assert.equal(s.shouldCheck(), false, 'no check while downloading');
  s.downloaded();
  assert.equal(s.isDownloading(), false);
  assert.equal(s.shouldCheck(), false);
  assert.deepEqual(s.forPage(), { status: 'downloaded', version: '1.6.1' });
  assert.equal(s.available('1.6.1'), false, 'no going back to the download banner');
});

test('the app checks again while it stays open', () => {
  assert.ok(CHECK_INTERVAL_MS > 0 && CHECK_INTERVAL_MS <= 12 * 60 * 60 * 1000);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /setInterval\(runBackgroundUpdateCheck, UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(main, /ipcMain\.handle\('update:state'/);
});

test('both banners ask for the update state when their page loads', () => {
  for (const file of ['app-preload.js', 'preload.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../src/main', file), 'utf8');
    assert.match(src, /ipcRenderer\.invoke\('update:state'\)/, file);
  }
});
