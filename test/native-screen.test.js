'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  NativeScreenManager,
  decodeField,
  encodeField,
} = require('../src/main/native-screen');

function createOwner() {
  const owner = new EventEmitter();
  owner.destroyed = false;
  owner.signals = [];
  owner.isDestroyed = () => owner.destroyed;
  owner.send = (event, payload) => owner.signals.push({ event, payload });
  return owner;
}

function createFakeHelper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.commands = [];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0, null);
  };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const [command, ...fields] = line.split('\t');
      const values = fields.map(decodeField);
      child.commands.push({ command, values });
      if (command === 'START') {
        child.stdout.write(`READY\t${encodeField(values[0])}\n`);
      } else if (command === 'STOP') {
        child.stdout.write(`STOPPED\t${encodeField(values[0])}\n`);
      }
    }
  });
  return child;
}

function createManager(overrides = {}) {
  const helper = overrides.helper || createFakeHelper();
  const capabilities = {
    protocolVersion: 2,
    supported: true,
    captureBackends: ['x11'],
    encoder: 'vah264enc',
  };
  const manager = new NativeScreenManager({
    platform: 'linux',
    env: { XDG_SESSION_TYPE: 'x11' },
    helperPath: '/fake/haven_screen_share',
    existsSync: () => true,
    spawnSync: () => ({ status: 0, stdout: JSON.stringify(capabilities), stderr: '' }),
    spawn: () => helper,
    selectSource: async () => ({
      kind: 'linux-x11-screen',
      handle: '0',
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    }),
    ...overrides,
  });
  return { manager, helper };
}

test('starts the helper and forwards native offers to the owning renderer', async () => {
  const owner = createOwner();
  const { manager, helper } = createManager();

  const result = await manager.start(owner, {
    resolution: 1080,
    frameRate: 60,
    bitrate: 8_000_000,
    iceServers: [
      { urls: 'stun:stun.example.test:3478' },
      {
        urls: [
          'turn:turn.example.test:3478?transport=udp',
          'turn:turn.example.test:3478?transport=tcp',
          'turns:turn.example.test:5349',
        ],
        username: 'haven',
        credential: 'secret',
      },
    ],
  });

  assert.equal(result.started, true);
  assert.match(result.sessionId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(helper.commands[0].command, 'START');
  assert.equal(helper.commands[0].values[0], result.sessionId);
  assert.equal(helper.commands[0].values[1], 'linux-x11-screen');
  assert.equal(helper.commands[0].values[8], '60');
  const turnUrls = helper.commands[0].values[12].split(';').map(record =>
    decodeField(record.split(',')[0])
  );
  assert.deepEqual(turnUrls, [
    'turn:turn.example.test:3478?transport=udp',
    'turn:turn.example.test:3478?transport=tcp',
    'turns:turn.example.test:5349',
  ]);

  await manager.addPeer(owner, { sessionId: result.sessionId, peerId: 7 });
  helper.stdout.write([
    'OFFER',
    encodeField(result.sessionId),
    encodeField('7'),
    encodeField('v=0\r\n'),
  ].join('\t') + '\n');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(owner.signals.length, 1);
  assert.match(owner.signals[0].payload.negotiationId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual(owner.signals, [{
    event: 'native-screen:signal',
    payload: {
      type: 'offer',
      sessionId: result.sessionId,
      negotiationId: owner.signals[0].payload.negotiationId,
      peerId: 7,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    },
  }]);
  await manager.stop(owner);
  assert.equal(helper.killed, true);
});

test('rejects commands from another renderer and stale sessions', async () => {
  const owner = createOwner();
  const other = createOwner();
  const { manager } = createManager();
  const result = await manager.start(owner, {});

  await assert.rejects(
    manager.addPeer(other, { sessionId: result.sessionId, peerId: 7 }),
    /another view/
  );
  await assert.rejects(
    manager.addPeer(owner, { sessionId: 'native-session-old1', peerId: 7 }),
    /Stale native screen session/
  );
  await manager.stop(owner);
});

test('uses the PipeWire portal backend on Wayland', async () => {
  const helper = createFakeHelper();
  const owner = createOwner();
  const { manager } = createManager({
    helper,
    env: { XDG_SESSION_TYPE: 'wayland' },
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        protocolVersion: 2,
        supported: true,
        captureBackends: ['x11', 'pipewire-portal'],
        encoder: 'vah264enc',
      }),
      stderr: '',
    }),
    selectSource: async () => ({ kind: 'linux-pipewire', handle: '' }),
  });

  assert.equal((await manager.getCapabilities()).supported, true);
  const result = await manager.start(owner, {});
  assert.equal(result.started, true);
  assert.equal(helper.commands[0].values[1], 'linux-pipewire');
  await manager.stop(owner);
});

test('rejects startup immediately when the helper reports a fatal error', async () => {
  const helper = createFakeHelper();
  helper.stdin.removeAllListeners('data');
  helper.stdin.on('data', chunk => {
    const [command, session] = chunk.toString('utf8').trim().split('\t');
    if (command === 'START') {
      helper.stdout.write([
        'ERROR', session, encodeField(''), encodeField('portal failed'), encodeField('1'),
      ].join('\t') + '\n');
    } else if (command === 'STOP') {
      helper.stdout.write(`STOPPED\t${session}\n`);
    }
  });
  const owner = createOwner();
  const { manager } = createManager({ helper });
  const result = await manager.start(owner, {});
  assert.equal(result.started, false);
  assert.equal(result.reason, 'native-helper-start-failed');
  assert.equal(result.detail, 'portal failed');
});

test('rejects incompatible helper protocols even when the helper says supported', async () => {
  const { manager } = createManager({
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        protocolVersion: 3,
        supported: true,
        captureBackends: ['x11'],
      }),
      stderr: '',
    }),
  });
  assert.deepEqual(await manager.getCapabilities(), {
    protocolVersion: 3,
    supported: false,
    captureBackends: ['x11'],
    reason: 'native-helper-protocol-mismatch',
  });
});

test('preserves an unsupported probe reason when the helper exits nonzero', async () => {
  const { manager } = createManager({
    spawnSync: () => ({
      status: 2,
      stdout: JSON.stringify({
        protocolVersion: 2,
        supported: false,
        captureBackends: ['x11'],
        reason: 'gstreamer-plugins-unavailable',
      }),
      stderr: '',
    }),
  });
  assert.equal((await manager.getCapabilities()).reason, 'gstreamer-plugins-unavailable');
});

test('does not cache transient helper probe failures', async () => {
  let probes = 0;
  const { manager } = createManager({
    spawnSync: () => {
      probes++;
      if (probes === 1) return { status: 1, stdout: '', stderr: 'busy' };
      return {
        status: 0,
        stdout: JSON.stringify({
          protocolVersion: 2,
          supported: true,
          captureBackends: ['x11'],
          encoder: 'vah264enc',
        }),
        stderr: '',
      };
    },
  });

  assert.equal((await manager.getCapabilities()).supported, false);
  assert.equal((await manager.getCapabilities()).supported, true);
  assert.equal(probes, 2);
});

test('serializes starts and does not replace another renderer session', async () => {
  let selectSource;
  const pendingSource = new Promise(resolve => { selectSource = resolve; });
  const owner = createOwner();
  const other = createOwner();
  const { manager } = createManager({ selectSource: () => pendingSource });

  const firstStart = manager.start(owner, {});
  assert.deepEqual(await manager.start(other, {}), {
    started: false,
    reason: 'native-screen-start-pending',
  });
  selectSource({ kind: 'linux-x11-screen', handle: '0' });
  const firstResult = await firstStart;
  assert.equal(firstResult.started, true);
  assert.deepEqual(await manager.start(other, {}), {
    started: false,
    reason: 'native-screen-owned-by-another-view',
  });
  await manager.stop(owner);
});

test('kills the helper when its renderer reloads or reports a fatal runtime error', async () => {
  const owner = createOwner();
  let setup = createManager();
  let result = await setup.manager.start(owner, {});
  owner.emit('did-start-navigation', {}, 'https://haven.test', false, true);
  assert.equal(setup.helper.killed, true);
  assert.equal(setup.manager._session, null);

  setup = createManager();
  result = await setup.manager.start(owner, {});
  setup.helper.stdout.write([
    'ERROR',
    encodeField(result.sessionId),
    encodeField(''),
    encodeField('pipeline failed'),
    encodeField('1'),
  ].join('\t') + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.helper.killed, true);
  assert.equal(setup.manager._session, null);
  assert.equal(owner.signals.at(-1).payload.fatal, true);
});

test('does not spawn the helper if its renderer navigates while the picker is open', async () => {
  let spawnCalls = 0;
  const owner = createOwner();
  const { manager } = createManager({
    selectSource: async () => ({ kind: 'linux-x11-screen', handle: '0' }),
    spawn: () => {
      spawnCalls++;
      return createFakeHelper();
    },
  });

  const pending = manager.start(owner, {});
  owner.emit('did-start-navigation', {}, 'https://haven.test/other', false, true);

  assert.deepEqual(await pending, {
    started: false,
    cancelled: true,
    reason: 'native-screen-start-cancelled',
  });
  assert.equal(spawnCalls, 0);
});

test('stop aborts a pending picker before a helper session exists', async () => {
  let spawnCalls = 0;
  const owner = createOwner();
  const { manager } = createManager({
    selectSource: (_owner, _capabilities, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
    spawn: () => {
      spawnCalls++;
      return createFakeHelper();
    },
  });

  const pending = manager.start(owner, {});
  assert.equal(await manager.stop(owner), true);
  assert.deepEqual(await pending, {
    started: false,
    cancelled: true,
    reason: 'native-screen-start-cancelled',
  });
  assert.equal(spawnCalls, 0);
});

test('owner navigation aborts the pending native picker immediately', async () => {
  const owner = createOwner();
  const { manager } = createManager({
    selectSource: (_owner, _capabilities, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  });

  const pending = manager.start(owner, {});
  owner.emit('did-start-navigation', {}, 'https://haven.test/other', false, true);

  assert.deepEqual(await pending, {
    started: false,
    cancelled: true,
    reason: 'native-screen-start-cancelled',
  });
});

test('a stale stop cannot abort a newer pending picker', async () => {
  let aborts = 0;
  const owner = createOwner();
  const { manager } = createManager({
    selectSource: (_owner, _capabilities, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        aborts++;
        resolve(null);
      }, { once: true });
    }),
  });

  const pending = manager.start(owner, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await manager.stop(owner, false, 'native-session-old1'), false);
  assert.equal(aborts, 0);
  assert.equal(await manager.stop(owner), true);
  await pending;
  assert.equal(aborts, 1);
});

test('rejects answers and ICE from a replaced peer negotiation', async () => {
  const owner = createOwner();
  const { manager, helper } = createManager();
  const result = await manager.start(owner, {});
  await manager.addPeer(owner, { sessionId: result.sessionId, peerId: 7 });
  helper.stdout.write([
    'OFFER', encodeField(result.sessionId), encodeField('7'), encodeField('v=0\r\n'),
  ].join('\t') + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const negotiationId = owner.signals.at(-1).payload.negotiationId;

  await assert.rejects(manager.setRemoteDescription(owner, {
    sessionId: result.sessionId,
    negotiationId: 'stale-negotiation',
    peerId: 7,
    description: { type: 'answer', sdp: 'v=0\r\n' },
  }), /Stale native screen negotiation/);
  await manager.addIceCandidate(owner, {
    sessionId: result.sessionId,
    negotiationId,
    peerId: 7,
    candidate: null,
  });
  assert.equal(helper.commands.at(-1).command, 'ICE');
  await manager.stop(owner);
});

test('drops an offer that arrives after its peer was removed', async () => {
  const owner = createOwner();
  const { manager, helper } = createManager();
  const result = await manager.start(owner, {});
  await manager.addPeer(owner, { sessionId: result.sessionId, peerId: 7 });
  await manager.removePeer(owner, { sessionId: result.sessionId, peerId: 7 });
  helper.stdout.write([
    'OFFER', encodeField(result.sessionId), encodeField('7'), encodeField('v=0\r\n'),
  ].join('\t') + '\n');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(owner.signals.length, 0);
  await manager.stop(owner);
});

test('a stale session-specific stop does not kill a newer helper', async () => {
  const owner = createOwner();
  const { manager, helper } = createManager();
  const result = await manager.start(owner, {});

  assert.equal(await manager.stop(owner, false, 'native-session-old1'), false);
  assert.equal(helper.killed, false);
  assert.equal(await manager.stop(owner, false, result.sessionId), true);
  assert.equal(helper.killed, true);
});

test('normalizes null options and tears down after a synchronous START failure', async () => {
  const owner = createOwner();
  let setup = createManager();
  let result = await setup.manager.start(owner, null);
  assert.equal(result.started, true);
  await setup.manager.stop(owner);

  const helper = createFakeHelper();
  Object.defineProperty(helper.stdin, 'writable', { value: false });
  setup = createManager({ helper });
  result = await setup.manager.start(owner, {});
  assert.equal(result.started, false);
  assert.equal(result.reason, 'native-helper-start-failed');
  assert.equal(helper.killed, true);
  assert.equal(setup.manager._session, null);
});
