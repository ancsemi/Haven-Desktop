// Builds the per-app audio addon for a copy of Haven Desktop run from source.
//
// A plain `node-gyp rebuild` compiles against the headers of whatever Node is
// installed. Node 26's Windows headers switch on clang's ThinLTO flags, which
// Visual Studio's linker rejects (LNK1117: syntax error in option
// 'opt:lldltojobs=2'), and because `rebuild` cleans first, a failed build also
// deletes the addon that was working. The app then starts without per-app
// audio and the share picker only offers System Audio and No Audio.
//
// Electron's own headers are the right target anyway, so try those first and
// keep the plain build as the fallback (no network, headers unreachable).
// The release workflow keeps using `npm run build:native` on its pinned Node.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const gyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const addon = path.join(root, 'native', 'build', 'Release', 'haven_audio.node');

function rebuild(extra) {
  const args = [gyp, 'rebuild', '--directory=native', ...extra];
  return spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status === 0 && fs.existsSync(addon);
}

let electronVersion = '';
try { electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version; } catch { /* not installed yet */ }

let ok = false;
if (electronVersion) {
  console.log(`Building the audio addon against Electron ${electronVersion} headers...`);
  ok = rebuild([`--target=${electronVersion}`, `--arch=${process.arch}`, '--dist-url=https://electronjs.org/headers']);
}
if (!ok) {
  console.log('Falling back to the installed Node headers...');
  ok = rebuild([]);
}
process.exit(ok ? 0 : 1);
