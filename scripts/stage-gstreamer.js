'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'native', 'runtime', 'gstreamer');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function copy(source, destination) {
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode);
}

function listFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map(name => path.join(directory, name))
    .filter(file => fs.statSync(file).isFile() && predicate(path.basename(file)));
}

function stageLinux() {
  const pluginDirectory = process.env.GSTREAMER_PLUGIN_DIR || execFileSync(
    'pkg-config',
    ['--variable=pluginsdir', 'gstreamer-1.0'],
    { encoding: 'utf8' }
  ).trim();
  const helper = path.join(ROOT, 'native', 'build', 'Release', 'haven_screen_share');
  if (!fs.existsSync(helper)) throw new Error('Build haven_screen_share before staging GStreamer');

  const pluginGroups = [
    ['coreelements'],
    ['videorate'],
    ['videoconvertscale'],
    ['ximagesrc'],
    ['pipewire'],
    ['videoparsersbad'],
    ['rtp.so'],
    ['rtpmanager'],
    ['webrtc.so'],
    ['nice.so'],
    ['dtls'],
    ['srtp'],
  ];
  const allPlugins = listFiles(pluginDirectory, name => name.endsWith('.so'));
  const selected = [];
  for (const alternatives of pluginGroups) {
    const plugin = allPlugins.find(file => alternatives.some(token => path.basename(file).includes(token)));
    if (!plugin) throw new Error(`Missing required GStreamer plugin: ${alternatives.join(' or ')}`);
    selected.push(plugin);
  }
  const vaPlugins = allPlugins.filter(file => /libgstva(?:api)?\.so$/.test(path.basename(file)));
  if (!vaPlugins.length) throw new Error('Missing VA-API GStreamer encoder plugin');
  selected.push(...vaPlugins);

  const optionalPlugins = ['videotestsrc'];
  for (const token of optionalPlugins) {
    const plugin = allPlugins.find(file => path.basename(file).includes(token));
    if (plugin) selected.push(plugin);
  }

  const pluginOutput = path.join(OUTPUT, 'plugins');
  for (const plugin of new Set(selected)) {
    copy(plugin, path.join(pluginOutput, path.basename(plugin)));
  }

  const scannerCandidates = [
    process.env.GSTREAMER_PLUGIN_SCANNER,
    '/usr/libexec/gstreamer-1.0/gst-plugin-scanner',
    '/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner',
    path.resolve(pluginDirectory, '..', 'gstreamer1.0', 'gstreamer-1.0', 'gst-plugin-scanner'),
  ];
  const scanner = scannerCandidates.filter(Boolean).find(fs.existsSync);
  if (!scanner) throw new Error('Could not locate gst-plugin-scanner');
  const scannerOutput = path.join(OUTPUT, 'libexec', 'gst-plugin-scanner');
  copy(scanner, scannerOutput);

  const libraryOutput = path.join(OUTPUT, 'lib');
  const queue = [helper, scanner, ...selected];
  const visited = new Set();
  const excluded = /\/(?:ld-linux|libc\.so|libm\.so|libdl\.so|libpthread\.so|librt\.so|libresolv\.so|libgcc_s\.so)/;
  while (queue.length) {
    const binary = queue.shift();
    if (!binary || visited.has(binary)) continue;
    visited.add(binary);
    let output;
    try {
      output = execFileSync('ldd', [binary], { encoding: 'utf8' });
    } catch (err) {
      output = String(err.stdout || '');
    }
    const missing = output.split('\n').filter(line => /=>\s+not found\s*$/.test(line));
    if (missing.length) {
      throw new Error(`Missing shared libraries for ${binary}: ${missing.join(', ')}`);
    }
    for (const line of output.split('\n')) {
      const match = line.match(/=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)/);
      const dependency = match && (match[1] || match[2]);
      if (!dependency || !fs.existsSync(dependency) || excluded.test(dependency)) continue;
      const destination = path.join(libraryOutput, path.basename(dependency));
      if (!fs.existsSync(destination)) copy(dependency, destination);
      queue.push(dependency);
    }
  }
}

function stageWindows() {
  const root = process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 ||
    process.env.GSTREAMER_ROOT_X86_64 ||
    'C:\\gstreamer\\1.0\\msvc_x86_64';
  const binDirectory = path.join(root, 'bin');
  const pluginDirectory = path.join(root, 'lib', 'gstreamer-1.0');
  if (!fs.existsSync(binDirectory) || !fs.existsSync(pluginDirectory)) {
    throw new Error(`GStreamer MSVC runtime was not found at ${root}`);
  }

  const binOutput = path.join(OUTPUT, 'bin');
  for (const file of listFiles(binDirectory, name => name.toLowerCase().endsWith('.dll'))) {
    copy(file, path.join(binOutput, path.basename(file)));
  }

  const pluginTokens = [
    'coreelements', 'videorate', 'videoconvertscale', 'd3d11',
    'mediafoundation', 'gstmf', 'videoparsersbad', 'rtp', 'webrtc', 'nice',
    'dtls', 'srtp',
  ];
  const plugins = listFiles(pluginDirectory, name => {
    const lower = name.toLowerCase();
    return lower.endsWith('.dll') && pluginTokens.some(token => lower.includes(token));
  });
  const requiredPluginGroups = [
    ['coreelements'], ['videorate'], ['videoconvertscale'], ['d3d11'],
    ['mediafoundation', 'gstmf'], ['videoparsersbad'], ['rtp'], ['webrtc'],
    ['nice'], ['dtls'], ['srtp'],
  ];
  for (const alternatives of requiredPluginGroups) {
    const found = plugins.some(file => alternatives.some(token =>
      path.basename(file).toLowerCase().includes(token)
    ));
    if (!found) {
      throw new Error(`Missing required GStreamer plugin: ${alternatives.join(' or ')}`);
    }
  }
  const pluginOutput = path.join(OUTPUT, 'plugins');
  for (const plugin of plugins) copy(plugin, path.join(pluginOutput, path.basename(plugin)));

  const scannerCandidates = [
    path.join(root, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
    path.join(binDirectory, 'gst-plugin-scanner.exe'),
  ];
  const scanner = scannerCandidates.find(fs.existsSync);
  if (!scanner) throw new Error('Could not locate gst-plugin-scanner.exe');
  copy(scanner, path.join(OUTPUT, 'libexec', 'gst-plugin-scanner.exe'));
}

fs.rmSync(OUTPUT, { recursive: true, force: true });
ensureDirectory(OUTPUT);
if (process.platform === 'linux') stageLinux();
else if (process.platform === 'win32') stageWindows();
else throw new Error(`GStreamer staging is unsupported on ${process.platform}`);

console.log(`Staged GStreamer runtime in ${OUTPUT}`);
