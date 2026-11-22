const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A server page can ask Desktop to save a picture. What gets written is
// decided here, not by the page: the bytes must be a picture and the file
// gets that picture's extension.

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf("  const SAVED_IMAGE_EXTENSIONS = [");
const end = source.indexOf("  handleFromActiveServer('dialog:save-image'");
const ctx = vm.createContext({ Buffer });
vm.runInContext(source.slice(start, end) + '\nthis.ext = savedImageExtension; this.list = SAVED_IMAGE_EXTENSIONS;', ctx);

const bytes = (...b) => Buffer.from(b);

test('pictures are recognised by how the file starts', () => {
  assert.equal(ctx.ext(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0)), 'png');
  assert.equal(ctx.ext(bytes(0xFF, 0xD8, 0xFF, 0xE0)), 'jpg');
  assert.equal(ctx.ext(Buffer.from('GIF89a....')), 'gif');
  assert.equal(ctx.ext(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(ctx.ext(Buffer.from('\0\0\0\x1cftypavif\0\0\0\0', 'latin1')), 'avif');
  assert.equal(ctx.ext(Buffer.from('BM\0\0\0\0')), 'bmp');
});

test('a program, a script or a web page is not a picture', () => {
  for (const sample of ['MZ\x90\0\x03\0\0\0', '@echo off\r\nstart calc', '<html><script>', '#!/bin/sh\n', 'PK\x03\x04', '<svg onload=1>', '']) {
    assert.equal(ctx.ext(Buffer.from(sample, 'latin1')), null, JSON.stringify(sample));
  }
});

test('the save handler checks the bytes, names the file itself and checks the chosen name', () => {
  const handler = source.slice(end, source.indexOf("// ── Desktop App Preferences", end));
  assert.match(handler, /const ext = savedImageExtension\(buf\);\s*\n\s*if \(!ext\) return \{ ok: false, reason: 'not-an-image' \};/);
  assert.match(handler, /const name = `\$\{stem\}\.\$\{ext\}`;/);
  assert.match(handler, /SAVED_IMAGE_EXTENSIONS\.includes\(path\.extname\(picked\.filePath\)/);
  assert.ok(handler.indexOf('SAVED_IMAGE_EXTENSIONS.includes') < handler.indexOf('fs.writeFileSync'), 'checked before writing');
  for (const e of ctx.list) assert.match(e, /^(png|jpe?g|gif|webp|avif|bmp)$/);
});

test('the release build does not leave its token in the checkout', () => {
  const yml = fs.readFileSync(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8');
  const checkouts = yml.split('uses: actions/checkout@').length - 1;
  assert.ok(checkouts >= 1);
  assert.equal(yml.split('persist-credentials: false').length - 1, checkouts);
});
