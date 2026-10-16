'use strict';

// scripts/brand-dev-electron.js stamps the Haven icon into the electron.exe a
// copy run from source uses. The pieces that need no exe are tested here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  decodePng,
  encodePng,
  resizeRgba,
  areaWeights,
  iconFromPng,
  stampKey,
  isStamped,
  parseArgs,
} = require('../scripts/brand-dev-electron');

const ICON_PNG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));

test('the Haven icon decodes, and a PNG survives a round trip', () => {
  const img = decodePng(ICON_PNG);
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.equal(img.rgba.length, 512 * 512 * 4);
  const again = decodePng(encodePng(img));
  assert.equal(again.width, 512);
  assert.ok(again.rgba.equals(img.rgba));
});

test('area weights cover every source pixel exactly once', () => {
  for (const [from, to] of [[512, 16], [512, 24], [512, 48], [512, 256], [3, 2]]) {
    const total = new Array(from).fill(0);
    for (const taps of areaWeights(from, to)) {
      const sum = taps.reduce((s, [, w]) => s + w, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `weights of one pixel sum to 1 (${from} to ${to})`);
      for (const [s, w] of taps) total[s] += w * (from / to);
    }
    for (const t of total) assert.ok(Math.abs(t - 1) < 1e-9);
  }
});

test('shrinking keeps a solid color and a transparent edge clean', () => {
  const rgba = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const opaque = i % 4 < 2; // left half purple, right half transparent
    rgba.set(opaque ? [120, 80, 200, 255] : [0, 0, 0, 0], i * 4);
  }
  const small = resizeRgba({ width: 4, height: 4, rgba }, 2, 2);
  assert.deepEqual([...small.rgba.subarray(0, 4)], [120, 80, 200, 255]);
  assert.deepEqual([...small.rgba.subarray(4, 8)], [0, 0, 0, 0]);
  const half = resizeRgba({ width: 4, height: 4, rgba }, 1, 1);
  assert.deepEqual([...half.rgba], [120, 80, 200, 128], 'a half covered pixel keeps its color, not a darker one');
});

test('the .ico holds one PNG per size Windows asks for', () => {
  const ico = iconFromPng(ICON_PNG);
  assert.equal(ico.readUInt16LE(2), 1, 'icon type');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = ico[at] || 256;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    const png = decodePng(ico.subarray(offset, offset + length));
    assert.equal(png.width, size);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test('resedit reads the .ico the script builds', (t) => {
  let ResEdit;
  try {
    ResEdit = require('resedit');
  } catch (err) {
    t.skip(`resedit is not installed here (${err.code})`);
    return;
  }
  const file = ResEdit.Data.IconFile.from(iconFromPng(ICON_PNG));
  assert.deepEqual(file.icons.map(i => i.width || 256), [16, 24, 32, 48, 64, 128, 256]);
});

test('the stamp changes with the icon, the name and the Electron version', () => {
  const base = { iconPng: ICON_PNG, productName: 'Haven Desktop (source)', electronVersion: '42.11.2' };
  const key = stampKey(base);
  assert.equal(stampKey({ ...base }), key);
  assert.notEqual(stampKey({ ...base, electronVersion: '42.12.0' }), key);
  assert.notEqual(stampKey({ ...base, productName: 'Other' }), key);
  assert.notEqual(stampKey({ ...base, iconPng: Buffer.concat([ICON_PNG, Buffer.from([0])]) }), key);
});

test('an exe npm put back is stamped again even if the record is still there', () => {
  const record = { key: 'k', size: 100, mtimeMs: 1234.5 };
  assert.equal(isStamped(record, 'k', { size: 100, mtimeMs: 1234.5 }), true);
  assert.equal(isStamped(record, 'other', { size: 100, mtimeMs: 1234.5 }), false);
  assert.equal(isStamped(record, 'k', { size: 101, mtimeMs: 1234.5 }), false);
  assert.equal(isStamped(record, 'k', { size: 100, mtimeMs: 9999 }), false);
  assert.equal(isStamped(null, 'k', { size: 100, mtimeMs: 1234.5 }), false);
});

test('options pick another exe and name for testing', () => {
  assert.deepEqual(parseArgs([]), { exe: null, name: 'Haven Desktop (source)' });
  const o = parseArgs(['--exe', 'copy/electron.exe', '--name', 'Probe']);
  assert.equal(o.exe, path.resolve('copy/electron.exe'));
  assert.equal(o.name, 'Probe');
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});
