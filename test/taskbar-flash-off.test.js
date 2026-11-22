const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const flashBlock = source.slice(source.indexOf("    if (store.get('flashTaskbar') !== false)"), source.indexOf("    if (store.get('flashTaskbar') !== false)") + 420).split('    return true;')[0];
for (const focused of [false, true]) for (const enabled of [false, true, undefined]) {
  test(`flashTaskbar=${enabled}, focused=${focused}`, () => {
    const calls = [];
    vm.runInNewContext(flashBlock, { store: { get: () => enabled }, mainWindow: { isFocused: () => focused, flashFrame: v => calls.push(v) }, console });
    assert.deepEqual(calls, enabled !== false && !focused ? [true] : []);
  });
}
test('turning off clears existing flash, irrespective of focus/virtual desktop', () => {
  const start = source.indexOf("  handleFromActiveServer('desktop:set-flash-taskbar'");
  const block = source.slice(start, source.indexOf('\n  });', start) + 6);
  let handler; const calls = [];
  vm.runInNewContext(block, { handleFromActiveServer: (_n, fn) => { handler = fn; }, store: { set: () => {} }, mainWindow: { isDestroyed: () => false, isFocused: () => false, flashFrame: v => calls.push(v) }, console });
  handler({}, false); assert.deepEqual(calls, [false]);
});
test('only one positive flash call exists; unread badge does not request attention', () => {
  const calls = source.split('\n').filter(l => /flashFrame\(true\)/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /!mainWindow\.isFocused\(\)/);
  const unread = source.slice(source.indexOf('function setNotificationBadge()'), source.indexOf('function clearNotificationBadge()'));
  assert.doesNotMatch(unread, /flashFrame\(true\)/);
});
