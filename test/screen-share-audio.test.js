const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioCaptureManager } = require('../src/main/audio-capture');
const {
  BoundedPcmRing,
  createAudioCaptureController,
  resolveAudioSelection,
  shouldDropAudioPacket,
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

test('drops stale audio packets before they can add delay', () => {
  assert.equal(shouldDropAudioPacket(1000, 1149), false);
  assert.equal(shouldDropAudioPacket(1000, 1151), true);
  assert.equal(shouldDropAudioPacket(undefined, 1000), true);
});

test('bounded PCM ring keeps the newest audio when the producer falls behind', () => {
  const ring = new BoundedPcmRing(4);
  ring.push(Float32Array.from([1, 2, 3]));
  assert.equal(ring.push(Float32Array.from([4, 5, 6])), 2);
  assert.equal(ring.available, 4);

  const output = new Float32Array(4);
  assert.equal(ring.pull(output), true);
  assert.deepEqual(Array.from(output), [3, 4, 5, 6]);
});

test('bounded PCM ring emits silence instead of replaying partial stale audio', () => {
  const ring = new BoundedPcmRing(4);
  ring.push(Float32Array.from([1, 2]));
  const output = Float32Array.from([9, 9, 9]);
  assert.equal(ring.pull(output), false);
  assert.deepEqual(Array.from(output), [0, 0, 0]);
  assert.equal(ring.available, 0);

  ring.push(Float32Array.from([3, 4, 5]));
  assert.equal(ring.pull(output), true);
  assert.deepEqual(Array.from(output), [3, 4, 5]);
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

test('ignores native callbacks retained from an older capture generation', () => {
  const sessions = [];
  const addon = {
    startCapture(_pid, _mode, onData, onStatus) {
      sessions.push({ onData, onStatus });
      return true;
    },
    stopCapture() {},
  };
  const manager = new AudioCaptureManager(addon);
  const received = [];

  manager.startCapture(1, {
    onData: () => received.push('old-data'),
    onStatus: () => received.push('old-status'),
  });
  manager.stopCapture();
  manager.startCapture(2, {
    onData: (_pcm, capturedAt) => received.push(`new-data:${capturedAt}`),
    onStatus: () => received.push('new-status'),
  });

  sessions[0].onData(Float32Array.of(1), 1000);
  sessions[0].onStatus({ kind: 'failed' });
  sessions[1].onData(Float32Array.of(2), 2000);
  sessions[1].onStatus({ kind: 'started' });

  assert.deepEqual(received, ['new-data:2000', 'new-status']);
  manager.stopCapture();
});

test('runs capture teardown before stopping the native addon', () => {
  const events = [];
  const addon = {
    startCapture() { return true; },
    stopCapture() { events.push('native'); },
  };
  const manager = new AudioCaptureManager(addon, () => events.push('router'));

  manager.startCapture(1, { onData() {} });
  manager.stopCapture();

  assert.deepEqual(events, ['router', 'native']);
});
