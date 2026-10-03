'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyDisplayColorWorkarounds } = require('../src/main/color-profile');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');

for (const platform of ['win32', 'linux', 'darwin']) {
  for (const forceSDR of [false, true]) {
    test(`display switches on ${platform} with forceSDR=${forceSDR}`, () => {
      const switches = [];
      applyDisplayColorWorkarounds({ appendSwitch: (...args) => switches.push(args) }, platform, forceSDR);
      const expected = [];
      if (forceSDR) expected.push(['force-color-profile', platform === 'win32' ? 'scrgb-linear' : 'srgb']);
      // Exact list also excludes disabling the GPU/DirectComposition,
      // overriding ANGLE, or replacing feature switches needed by H.265.
      assert.deepEqual(switches, expected);
    });
  }
}

test('main applies the workaround before ready, without rewriting SDR preferences', () => {
  const start = main.indexOf('// ── Display color workarounds');
  const end = main.indexOf('// ── G-Sync / VRR workaround', start);
  const ready = main.search(/^app\.whenReady\(\)/m);
  assert.ok(start >= 0 && end > start && ready > end);
  const switches = [];
  vm.runInNewContext(main.slice(start, end), {
    applyDisplayColorWorkarounds,
    app: { commandLine: { appendSwitch: (...args) => switches.push(args) } },
    process: { platform: 'win32' },
    store: {
      get: key => { assert.equal(key, 'forceSDR'); return false; },
      set: () => assert.fail('Startup must not change the user preference'),
    },
  });
  assert.deepEqual(switches, []);
});

test('SDR IPC accepts both toggle states, including consecutive Windows requests', async () => {
  const getStart = main.indexOf("  ipcMain.handle('desktop:get-prefs'");
  const getEnd = main.indexOf('\n  }));', getStart) + '\n  }));'.length;
  const setStart = main.indexOf("  ipcMain.handle('desktop:set-force-sdr'");
  const setEnd = main.indexOf('\n  });', setStart) + '\n  });'.length;
  assert.ok(getStart >= 0 && getEnd > getStart && setStart >= 0 && setEnd > setStart);
  const handlers = new Map();
  let storedForceSDR = true;
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    process: { platform: 'win32' },
    store: {
      get: key => key === 'forceSDR' ? storedForceSDR : undefined,
      set: (key, value) => { assert.equal(key, 'forceSDR'); storedForceSDR = value; },
    },
    getI18nState: () => ({}),
    normalizeVideoEncoderPreference: () => 'hardware',
  };
  vm.runInNewContext(main.slice(getStart, getEnd) + main.slice(setStart, setEnd), context);
  const getPrefs = handlers.get('desktop:get-prefs');
  const setPref = handlers.get('desktop:set-force-sdr');
  const invoke = value => Promise.resolve().then(() => setPref({}, value));
  assert.equal(getPrefs().forceSDR, true);
  const disabled = await invoke(false);
  assert.equal(disabled.requiresRestart, true);
  assert.equal(getPrefs().forceSDR, false);
  const [off, on] = await Promise.all([invoke(false), invoke(true)]);
  assert.equal(off.requiresRestart, true);
  assert.equal(on.requiresRestart, true);
  assert.equal(getPrefs().forceSDR, true);
});
