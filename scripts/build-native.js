#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const path = require('path');

function resolvePython() {
  const envPython = process.env.PYTHON || process.env.npm_config_python;
  if (envPython && envPython.trim()) return envPython.trim();

  // On Windows, node-gyp auto-discovery can fail with Microsoft Store Python.
  // Resolve the real interpreter path via py launcher and pass it explicitly.
  if (process.platform === 'win32') {
    try {
      const out = execSync('py -3 -c "import sys; print(sys.executable)"', {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      if (out) return out;
    } catch {
      return null;
    }
  }

  return null;
}

function main() {
  const nodeGyp = path.resolve(__dirname, '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const args = [nodeGyp, 'rebuild', '--directory=native'];

  const python = resolvePython();
  if (python) args.push(`--python=${python}`);

  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    shell: false,
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

main();
