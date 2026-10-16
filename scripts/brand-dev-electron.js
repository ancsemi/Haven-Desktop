#!/usr/bin/env node
'use strict';

// Gives the electron.exe that runs Haven Desktop from source the Haven icon and
// the product name "Haven Desktop (source)" (Windows only, a no-op elsewhere).
//
// Windows draws the taskbar button, and Electron names and draws the Start
// Menu shortcut it makes for notifications, from the exe itself. An unbranded
// electron.exe showed the Electron logo there, or a blank page, whatever the
// app set at run time. See src/main/dev-shortcut.js for the shortcut side.
//
// Safe to run on every launch: it does nothing once the exe is stamped, does
// it again after npm reinstalls or updates Electron, and never fails the
// caller. If the exe is in use (Haven Desktop is running) it says so and
// leaves it alone.
//
// Options, for testing on a copy:
//   --exe <path>    stamp this electron.exe instead of node_modules\electron
//   --name <text>   product name to stamp instead of "Haven Desktop (source)"

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DEV_PRODUCT_NAME } = require('../src/main/dev-shortcut');

const ROOT = path.join(__dirname, '..');
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Bump when the stamping itself changes, so every exe gets stamped again.
const STAMP_FORMAT = 1;
const STAMP_FILE = 'haven-dev-brand.json';

// ── PNG in, PNG out (8-bit RGBA or RGB, not interlaced) ────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!header) throw new Error('PNG has no header');
  const channels = { 6: 4, 2: 3 }[header.colorType];
  if (header.depth !== 8 || !channels || header.interlace !== 0) {
    throw new Error('only 8-bit RGB or RGBA PNGs without interlacing are supported');
  }
  const { width, height } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      pixels[out + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * channels];
    rgba[i * 4 + 1] = pixels[i * channels + 1];
    rgba[i * 4 + 2] = pixels[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Which source pixels make up each target pixel, and how much of each.
function areaWeights(from, to) {
  const scale = from / to;
  const result = [];
  for (let i = 0; i < to; i++) {
    const start = i * scale;
    const end = start + scale;
    const taps = [];
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
      const w = Math.min(end, s + 1) - Math.max(start, s);
      if (w > 0) taps.push([s, w / scale]);
    }
    result.push(taps);
  }
  return result;
}

// Shrinks by averaging the area each new pixel covers, on premultiplied alpha
// so transparent edges do not darken.
function resizeRgba(img, width, height) {
  const { width: sw, height: sh, rgba } = img;
  const pre = new Float64Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = rgba[i * 4 + 3] / 255;
    pre[i * 4] = rgba[i * 4] * a;
    pre[i * 4 + 1] = rgba[i * 4 + 1] * a;
    pre[i * 4 + 2] = rgba[i * 4 + 2] * a;
    pre[i * 4 + 3] = rgba[i * 4 + 3];
  }
  const wx = areaWeights(sw, width);
  const wy = areaWeights(sh, height);
  const rows = new Float64Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < width; x++) {
      for (const [s, w] of wx[x]) {
        for (let c = 0; c < 4; c++) rows[(y * width + x) * 4 + c] += pre[(y * sw + s) * 4 + c] * w;
      }
    }
  }
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = [0, 0, 0, 0];
      for (const [s, w] of wy[y]) {
        for (let c = 0; c < 4; c++) px[c] += rows[(s * width + x) * 4 + c] * w;
      }
      const at = (y * width + x) * 4;
      const a = px[3];
      out[at + 3] = Math.round(Math.min(255, a));
      for (let c = 0; c < 3; c++) {
        out[at + c] = a > 0 ? Math.round(Math.min(255, (px[c] * 255) / a)) : 0;
      }
    }
  }
  return { width, height, rgba: out };
}

// An .ico made of PNG images, one per size.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, at);
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map(image => image.png)]);
}

function iconFromPng(pngBuffer, sizes = ICO_SIZES) {
  const source = decodePng(pngBuffer);
  return buildIco(sizes.map(size => ({ size, png: encodePng(resizeRgba(source, size, size)) })));
}

// ── Stamp record ───────────────────────────────────────────

// What the exe should carry. Any change (a new icon, a new name, a new
// Electron, a new stamping format) means stamping again.
function stampKey({ iconPng, productName, electronVersion }) {
  return crypto.createHash('sha256')
    .update(`${STAMP_FORMAT}\n${productName}\n${electronVersion}\n`)
    .update(iconPng)
    .digest('hex');
}

// The record also holds the exe's size and modified time, so an exe that npm
// put back without removing the record is stamped again.
function isStamped(record, key, stat) {
  return !!record && !!stat
    && record.key === key
    && record.size === stat.size
    && record.mtimeMs === stat.mtimeMs;
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[brand-dev-electron] ignoring an unreadable stamp record: ${err.message}`);
    return null;
  }
}

// ── Stamping ───────────────────────────────────────────────

function parseArgs(argv) {
  const options = { exe: null, name: DEV_PRODUCT_NAME };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe' && argv[i + 1]) options.exe = path.resolve(argv[++i]);
    else if (argv[i] === '--name' && argv[i + 1]) options.name = argv[++i];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return options;
}

function electronVersionFor(exe) {
  try {
    return fs.readFileSync(path.join(path.dirname(exe), 'version'), 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return 'unknown'; // a copy without the version file: the size and time checks still catch a new exe
  }
}

// The exe "Start Haven Desktop.bat" launches. The electron package downloads
// it here when it is missing (Setup.bat installs with --ignore-scripts).
function defaultExe() {
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (err) {
    console.warn(`[brand-dev-electron] ${err.message.split('\n')[0]}`);
    return null;
  }
}

function inUse(err) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(err && err.code);
}

function stampExe(exeBuffer, icoBuffer, productName) {
  const ResEdit = require('resedit');
  // The signature no longer matches once resources change, so it is dropped.
  const exe = ResEdit.NtExecutable.from(exeBuffer, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error('the exe has no icon to replace');
  const icons = ResEdit.Data.IconFile.from(icoBuffer).icons.map(item => item.data);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, icons);

  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!info) throw new Error('the exe has no version information');
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, { ProductName: productName, FileDescription: productName });
  }
  info.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

function refreshIconCache() {
  const tool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe');
  const result = spawnSync(tool, ['-show'], { stdio: 'ignore', timeout: 30000, windowsHide: true });
  if (result.error) console.warn(`[brand-dev-electron] could not refresh the icon cache: ${result.error.message}`);
}

function run(argv) {
  if (process.platform !== 'win32') return 0;
  const options = parseArgs(argv);
  // CI only tests and packages; the installer is built from its own download
  // of Electron, never from this exe. Leave it as it came.
  if (process.env.CI && !options.exe) return 0;
  const exe = options.exe || defaultExe();
  if (!exe || !fs.existsSync(exe)) {
    console.log('Electron is not installed yet, skipping the Haven icon for electron.exe.');
    return 0;
  }
  const recordFile = path.join(path.dirname(exe), STAMP_FILE);
  const iconPng = fs.readFileSync(ICON_PNG);
  const key = stampKey({ iconPng, productName: options.name, electronVersion: electronVersionFor(exe) });
  if (isStamped(readRecord(recordFile), key, fs.statSync(exe))) return 0;

  // A running exe cannot be replaced. Check before the slow part.
  try {
    fs.closeSync(fs.openSync(exe, 'r+'));
  } catch (err) {
    if (!inUse(err)) throw err;
    console.log('Haven Desktop is running, so electron.exe keeps its old icon for now. Close it and start it again to fix the taskbar icon.');
    return 0;
  }

  try {
    require.resolve('resedit');
  } catch (err) {
    console.log(`The resedit package is missing (run Setup.bat), so electron.exe keeps the Electron icon. (${err.code})`);
    return 0;
  }

  console.log('Giving electron.exe the Haven icon (one time)...');
  const stamped = stampExe(fs.readFileSync(exe), iconFromPng(iconPng), options.name);
  const tmp = `${exe}.haven-new`;
  try {
    fs.writeFileSync(tmp, stamped);
    fs.renameSync(tmp, exe);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!inUse(err)) throw err;
    console.log('electron.exe is in use, so it keeps its old icon for now. Close Haven Desktop and start it again.');
    return 0;
  }
  const stat = fs.statSync(exe);
  fs.writeFileSync(recordFile, JSON.stringify({ key, size: stat.size, mtimeMs: stat.mtimeMs }, null, 2) + '\n');
  refreshIconCache();
  console.log('Done.');
  return 0;
}

if (require.main === module) {
  let code = 0;
  try {
    code = run(process.argv.slice(2));
  } catch (err) {
    // Never block a launch or an npm install over an icon.
    console.warn(`[brand-dev-electron] could not give electron.exe the Haven icon: ${err.message}`);
  }
  process.exitCode = code;
}

module.exports = {
  decodePng,
  encodePng,
  resizeRgba,
  areaWeights,
  buildIco,
  iconFromPng,
  stampKey,
  isStamped,
  parseArgs,
  stampExe,
};
