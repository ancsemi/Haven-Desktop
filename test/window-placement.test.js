'use strict';

// A window that ended up where nobody can reach it, such as on a VR headset's
// monitor after the headset is off (Haven #5847).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { onSomeDisplay, usableBounds, centeredIn } = require('../src/main/window-placement');

const MAIN = { workArea: { x: 0, y: 40, width: 1920, height: 1040 } };
const LEFT = { workArea: { x: -2560, y: 0, width: 2560, height: 1440 } };

test('a window on a monitor counts, one on no monitor does not', () => {
  assert.equal(onSomeDisplay({ x: 100, y: 100, width: 1200, height: 800 }, [MAIN]), true);
  assert.equal(onSomeDisplay({ x: -2000, y: 100, width: 1200, height: 800 }, [MAIN, LEFT]), true);
  assert.equal(onSomeDisplay({ x: -2000, y: 100, width: 1200, height: 800 }, [MAIN]), false, 'that monitor is gone');
  assert.equal(onSomeDisplay({ x: 1915, y: 100, width: 1200, height: 800 }, [MAIN]), false, 'a sliver at the edge is no use');
  assert.equal(onSomeDisplay({ x: 'left', y: 100 }, [MAIN]), false);
});

test('startup keeps a reachable position and drops one nobody can see', () => {
  const here = { x: 100, y: 100, width: 1200, height: 800 };
  assert.deepEqual(usableBounds(here, [MAIN]), here);
  assert.deepEqual(usableBounds({ x: 9000, y: 100, width: 1200, height: 800 }, [MAIN]), { width: 1200, height: 800 }, 'the size stays');
  assert.deepEqual(usableBounds({ width: 1200, height: 800 }, [MAIN]), { width: 1200, height: 800 }, 'a first run has only a size');
  assert.deepEqual(usableBounds(undefined, [MAIN]), {});
});

test('bringing a window back centers it and fits it to the screen', () => {
  assert.deepEqual(centeredIn({ x: 9000, y: 50, width: 1200, height: 800 }, MAIN.workArea), { x: 360, y: 160, width: 1200, height: 800 });
  assert.deepEqual(centeredIn({ x: 9000, y: 50, width: 5000, height: 3000 }, MAIN.workArea), { x: 0, y: 40, width: 1920, height: 1040 });
});

test('the tray offers it, startup checks the saved spot, and a monitor leaving moves the window', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /t\('tray\.moveToMainScreen'\), click: \(\) => bringWindowToMainScreen\(\)/);
  assert.match(main, /usableBounds\(store\.get\('windowBounds'\), screen\.getAllDisplays\(\)\)/);
  assert.match(main, /screen\.on\('display-removed'/);
  for (const locale of ['en', 'pt-BR']) {
    const strings = require(`../src/i18n/locales/${locale}`);
    assert.ok(strings['tray.moveToMainScreen'], locale);
  }
});
