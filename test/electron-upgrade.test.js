'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

test('keeps the Electron 42 toolchain requirements consistent', () => {
  assert.match(packageJson.engines.node, /^>=22\.23\.2$/);
  assert.match(packageJson.engines.npm, /^>=10$/);
  assert.match(packageJson.devDependencies.electron, /^\^42\./);
  assert.match(packageJson.devDependencies['node-gyp'], /^\^12\.4\./);
  assert.equal(packageJson.devDependencies['@electron/rebuild'], undefined);
  assert.match(packageJson.scripts.postinstall, /electron-builder install-app-deps/);
});

test('keeps native include paths safe when the project path contains spaces', () => {
  const binding = fs.readFileSync(path.join(__dirname, '..', 'native', 'binding.gyp'), 'utf8');
  assert.match(binding, /"\.\.\/node_modules\/node-addon-api"/);
  assert.doesNotMatch(binding, /require\('node-addon-api'\)\.include/);
});

test('keeps root lockfile metadata synchronized with package.json', () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
  assert.equal(
    packageLock.packages[''].devDependencies.electron,
    packageJson.devDependencies.electron
  );
  assert.equal(
    packageLock.packages[''].devDependencies['node-gyp'],
    packageJson.devDependencies['node-gyp']
  );
});
