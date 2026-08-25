const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createAudioCaptureController,
  resolveAudioSelection,
} = require('../src/main/screen-share-audio');

const apps = [{ pid: 42, name: 'Music' }];

test('defaults unknown audio choices to no audio', () => {
  assert.deepEqual(resolveAudioSelection(undefined, apps, { system: true }), {
    type: 'none',
    app: null,
  });
});

test('allows system audio only when the platform reports support', () => {
  assert.equal(resolveAudioSelection('system', apps, { system: true }).type, 'system');
  assert.equal(resolveAudioSelection('system', apps, { system: false }).type, 'none');
});

test('allows only an application listed by the picker', () => {
  assert.equal(resolveAudioSelection(42, apps, {}).app, apps[0]);
  assert.equal(resolveAudioSelection(99, apps, {}).type, 'none');
});

test('stops captures only for their owner and capture ID', () => {
  let stops = 0;
  const owner = Object.assign(new EventEmitter(), { id: 7 });
  const controller = createAudioCaptureController(() => { stops++; });
  controller.start('share-1', owner);

  assert.equal(controller.stop('share-1', 8), false);
  assert.equal(controller.stop('share-2', 7), false);
  assert.equal(controller.stop('share-1', 7), true);
  assert.equal(stops, 1);
});

test('stops capture when its renderer is destroyed without affecting a newer capture', () => {
  let stops = 0;
  const first = Object.assign(new EventEmitter(), { id: 1 });
  const second = Object.assign(new EventEmitter(), { id: 2 });
  const controller = createAudioCaptureController(() => { stops++; });

  controller.start('share-1', first);
  controller.start('share-2', second);
  first.emit('destroyed');
  assert.equal(controller.isActive('share-2'), true);

  second.emit('render-process-gone');
  assert.equal(controller.hasActive(), false);
  assert.equal(stops, 2);
});
