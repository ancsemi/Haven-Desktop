'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'native', 'runtime', 'gstreamer');
const LINUX_REQUIRED_PLUGIN_GROUPS = [
  ['libgstcoreelements.so'],
  ['libgstapp.so'],
  ['libgstvideotestsrc.so'],
  ['libgstvideorate.so'],
  ['libgstvideoconvertscale.so', 'libgstvideoconvert.so'],
  ['libgstvideoconvertscale.so', 'libgstvideoscale.so'],
  ['libgstaudioconvert.so'],
  ['libgstaudioresample.so'],
  ['libgstopus.so'],
  ['libgstximagesrc.so'],
  ['libgstpipewire.so'],
  ['libgstvideoparsersbad.so'],
  ['libgstrtp.so'],
  ['libgstrtpmanager.so'],
  ['libgstwebrtc.so'],
  ['libgstnice.so'],
  ['libgstdtls.so'],
  ['libgstsrtp.so'],
];
const WINDOWS_PLUGIN_TOKENS = [
  'coreelements', 'gstapp', 'videotestsrc', 'videorate', 'videoconvert', 'videoscale', 'audioconvert',
  'audioresample', 'opus', 'd3d11', 'd3d12', 'nvcodec', 'qsv', 'amfcodec',
  'mediafoundation', 'gstmf', 'videoparsersbad', 'rsrtp', 'rtp', 'webrtc', 'nice',
  'dtls', 'srtp',
];
const WINDOWS_REQUIRED_PLUGIN_GROUPS = [
  ['gstcoreelements.dll'], ['gstapp.dll'], ['gstvideotestsrc.dll'], ['gstvideorate.dll'],
  ['gstvideoconvertscale.dll', 'gstvideoconvert.dll'],
  ['gstvideoconvertscale.dll', 'gstvideoscale.dll'],
  ['gstaudioconvert.dll'], ['gstaudioresample.dll'], ['gstopus.dll'],
  ['gstd3d11.dll'], ['gstmediafoundation.dll', 'gstmf.dll'],
  ['gstvideoparsersbad.dll'], ['gstrtp.dll'],
  ['gstwebrtc.dll'], ['gstnice.dll'], ['gstdtls.dll'], ['gstsrtp.dll'],
];

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

function selectRequiredPlugins(allPlugins, pluginGroups) {
  return pluginGroups.map(alternatives => {
    const plugin = allPlugins.find(file => {
      const basename = path.basename(file).toLowerCase();
      return alternatives.some(token => basename.includes(token.toLowerCase()));
    });
    if (!plugin) {
      throw new Error(`Missing required GStreamer plugin: ${alternatives.join(' or ')}`);
    }
    return plugin;
  });
}

function stageLinux(output) {
  const pluginDirectory = process.env.GSTREAMER_PLUGIN_DIR || execFileSync(
    'pkg-config',
    ['--variable=pluginsdir', 'gstreamer-1.0'],
    { encoding: 'utf8' }
  ).trim();
  const helper = path.join(ROOT, 'native', 'build', 'Release', 'haven_screen_share');
  if (!fs.existsSync(helper)) throw new Error('Build haven_screen_share before staging GStreamer');

  const allPlugins = listFiles(pluginDirectory, name => name.endsWith('.so'));
  const selected = selectRequiredPlugins(allPlugins, LINUX_REQUIRED_PLUGIN_GROUPS);
  const encoderPlugins = allPlugins.filter(file =>
    /libgst(?:va(?:api)?|nvcodec|qsv|amfcodec)\.so$/.test(path.basename(file))
  );
  if (!encoderPlugins.length) throw new Error('Missing a supported hardware encoder plugin');
  selected.push(...encoderPlugins);

  const optionalPlugins = ['rsrtp'];
  for (const token of optionalPlugins) {
    const plugin = allPlugins.find(file => path.basename(file).includes(token));
    if (plugin) selected.push(plugin);
  }

  const pluginOutput = path.join(output, 'plugins');
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
  const scannerOutput = path.join(output, 'libexec', 'gst-plugin-scanner');
  copy(scanner, scannerOutput);

  const libraryOutput = path.join(output, 'lib');
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

function stageWindows(output) {
  const root = process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 ||
    process.env.GSTREAMER_ROOT_X86_64 ||
    'C:\\gstreamer\\1.0\\msvc_x86_64';
  const binDirectory = path.join(root, 'bin');
  const pluginDirectory = path.join(root, 'lib', 'gstreamer-1.0');
  if (!fs.existsSync(binDirectory) || !fs.existsSync(pluginDirectory)) {
    throw new Error(`GStreamer MSVC runtime was not found at ${root}`);
  }

  const binOutput = path.join(output, 'bin');
  for (const file of listFiles(binDirectory, name => name.toLowerCase().endsWith('.dll'))) {
    copy(file, path.join(binOutput, path.basename(file)));
  }

  const plugins = listFiles(pluginDirectory, name => {
    const lower = name.toLowerCase();
    return lower.endsWith('.dll') && WINDOWS_PLUGIN_TOKENS.some(token => lower.includes(token));
  });
  selectRequiredPlugins(plugins, WINDOWS_REQUIRED_PLUGIN_GROUPS);
  const pluginOutput = path.join(output, 'plugins');
  for (const plugin of plugins) copy(plugin, path.join(pluginOutput, path.basename(plugin)));

  const scannerCandidates = [
    path.join(root, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
    path.join(binDirectory, 'gst-plugin-scanner.exe'),
  ];
  const scanner = scannerCandidates.find(fs.existsSync);
  if (!scanner) throw new Error('Could not locate gst-plugin-scanner.exe');
  copy(scanner, path.join(output, 'libexec', 'gst-plugin-scanner.exe'));
}

function main() {
  const temporaryOutput = `${OUTPUT}.tmp-${process.pid}`;
  fs.rmSync(temporaryOutput, { recursive: true, force: true });
  ensureDirectory(temporaryOutput);
  try {
    if (process.platform === 'linux') stageLinux(temporaryOutput);
    else if (process.platform === 'win32') stageWindows(temporaryOutput);
    else throw new Error(`GStreamer staging is unsupported on ${process.platform}`);

    fs.rmSync(OUTPUT, { recursive: true, force: true });
    fs.renameSync(temporaryOutput, OUTPUT);
  } catch (err) {
    fs.rmSync(temporaryOutput, { recursive: true, force: true });
    throw err;
  }

  console.log(`Staged GStreamer runtime in ${OUTPUT}`);
}

if (require.main === module) main();

module.exports = {
  LINUX_REQUIRED_PLUGIN_GROUPS,
  WINDOWS_REQUIRED_PLUGIN_GROUPS,
  selectRequiredPlugins,
};
