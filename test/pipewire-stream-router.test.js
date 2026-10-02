const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  PipeWireStreamRouter,
  createJsonArrayParser,
  isExternalProcess,
} = require('../src/main/pipewire-stream-router');

function createMonitor() {
  const monitor = new EventEmitter();
  monitor.stdout = new EventEmitter();
  monitor.kill = () => { monitor.killed = true; };
  return monitor;
}

function flushAsyncWork() {
  return new Promise(resolve => setImmediate(resolve));
}

function graph({ previousTarget = null } = {}) {
  const objects = [
    {
      id: 10,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'media.class': 'Audio/Sink',
        'node.name': 'HavenCombined_100',
        'object.serial': 1000,
      } },
    },
    {
      id: 20,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'media.class': 'Audio/Sink',
        'node.name': 'speakers',
        'object.serial': 2000,
      } },
    },
    {
      id: 30,
      type: 'PipeWire:Interface:Client',
      info: { props: {
        'application.name': 'Stremio',
        'application.process.id': 2,
        'pipewire.access': 'flatpak',
        'pipewire.sec.pid': 500,
      } },
    },
    {
      id: 40,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'client.id': 30,
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Stremio audio',
        'object.serial': 4000,
      } },
    },
    {
      id: 50,
      type: 'PipeWire:Interface:Link',
      info: { 'output-node-id': 40, 'input-node-id': 20 },
    },
    {
      id: 31,
      type: 'PipeWire:Interface:Client',
      info: { props: {
        'application.name': 'Chrome',
        'application.process.id': 300,
        'client.api': 'pipewire-pulse',
      } },
    },
    {
      id: 41,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'client.id': 31,
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Chrome audio',
        'object.serial': 4100,
      } },
    },
    {
      id: 51,
      type: 'PipeWire:Interface:Link',
      info: { 'output-node-id': 41, 'input-node-id': 20 },
    },
  ];

  if (previousTarget !== null) {
    objects.push({
      id: 60,
      type: 'PipeWire:Interface:Metadata',
      props: { 'metadata.name': 'default' },
      metadata: [{
        subject: 40,
        key: 'target.object',
        type: 'Spa:Id',
        value: previousTarget,
      }],
    });
  }
  return objects;
}

function replacementGraph({ own = false, serial = 9000, withoutSerial = false } = {}) {
  const objects = graph({ previousTarget: 3000 });
  objects[2].info.props = own
    ? { 'application.name': 'Haven', 'application.process.id': 100 }
    : { 'application.name': 'Music', 'application.process.id': 600 };
  objects[3].info.props['node.name'] = own ? 'Haven audio' : 'Music audio';
  objects[3].info.props['object.serial'] = serial;
  if (withoutSerial) delete objects[3].info.props['object.serial'];
  return objects;
}

function controlledRouting({ hold = () => false, native = false } = {}) {
  const commands = [];
  const monitors = [];
  const gates = new Map();
  const router = new PipeWireStreamRouter({
    spawnProcess(command, args) {
      if (command === 'pw-metadata') {
        const index = commands.push(args) - 1;
        const child = new EventEmitter();
        child.kill = () => {};
        if (hold(args, index)) gates.set(index, status => child.emit('close', status));
        else setImmediate(() => child.emit('close', 0));
        return child;
      }
      const monitor = createMonitor();
      monitors.push(monitor);
      return monitor;
    },
    runCommand: native ? null : (_command, args) => {
      const index = commands.push(args) - 1;
      if (!hold(args, index)) return { status: 0 };
      return new Promise(resolve => gates.set(index, status => resolve({ status })));
    },
    processExternal: pid => pid !== 100,
    logger: { warn() {} },
  });
  return {
    router,
    commands,
    start(objects = graph()) {
      assert.equal(router.start('HavenCombined_100', 100), true);
      this.send(objects);
    },
    send(objects) {
      monitors.at(-1).stdout.emit('data', JSON.stringify(objects));
    },
    complete(index, status = 0) {
      assert.ok(gates.has(index), `command ${index} must be in flight`);
      gates.get(index)(status);
      gates.delete(index);
    },
  };
}

test('parses fragmented consecutive pw-dump arrays', () => {
  const values = [];
  const parse = createJsonArrayParser(value => values.push(value));
  parse(' [ {"value":"[x]"');
  parse('} ]\n[{"value":2}]');
  assert.deepEqual(values, [[{ value: '[x]' }], [{ value: 2 }]]);
});

test('stops the PipeWire monitor when its stdout pipe fails', () => {
  const monitor = createMonitor();
  const warnings = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    logger: { warn(message) { warnings.push(message); } },
  });

  assert.equal(router.start('HavenCombined_100', 100), true);
  monitor.stdout.emit('error', new Error('read EIO'));

  assert.equal(monitor.killed, true);
  assert.equal(router._monitor, null);
  assert.match(warnings[0], /read EIO/);
});

test('classifies only fully inspectable unrelated processes as external', () => {
  const stats = new Map([
    ['/proc/101/stat', '101 (Haven audio) S 1 0 0 0'],
    ['/proc/102/stat', '102 (Haven child) S 100 0 0 0'],
    ['/proc/200/stat', '200 (Music) S 1 0 0 0'],
    ['/proc/201/stat', '201 (Unknown executable) S 1 0 0 0'],
    ['/proc/400/stat', 'malformed'],
    ['/proc/1/stat', '1 (init) S 0 0 0 0'],
  ]);
  const readFileSync = path => {
    if (!stats.has(path)) throw new Error('missing process');
    return stats.get(path);
  };
  const executables = new Map([
    ['/proc/100/exe', '/opt/Haven/haven-desktop'],
    ['/proc/101/exe', '/opt/Haven/haven-desktop'],
    ['/proc/102/exe', '/usr/bin/utility'],
    ['/proc/200/exe', '/usr/bin/music'],
    ['/proc/400/exe', '/usr/bin/broken'],
  ]);
  const readlinkSync = path => {
    if (!executables.has(path)) throw new Error('missing executable');
    return executables.get(path);
  };

  assert.equal(isExternalProcess(101, 100, readFileSync, readlinkSync), false);
  assert.equal(isExternalProcess(102, 100, readFileSync, readlinkSync), false);
  assert.equal(isExternalProcess(200, 100, readFileSync, readlinkSync), true);
  assert.equal(isExternalProcess(201, 100, readFileSync, readlinkSync), false);
  assert.equal(isExternalProcess(300, 100, readFileSync, readlinkSync), false);
  assert.equal(isExternalProcess(400, 100, readFileSync, readlinkSync), false);
});

test('routes native Flatpak audio but leaves pipewire-pulse streams alone', async () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  assert.equal(router.start('HavenCombined_100', 100), true);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.deepEqual(commands, [[
    'pw-metadata',
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
  ]]);

  await router.stop();
  assert.equal(monitor.killed, true);
  assert.deepEqual(commands[1], [
    'pw-metadata',
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
  ]);
  assert.deepEqual(commands[2], [
    'pw-metadata',
    ['-n', 'default', '-d', '40', 'target.object'],
  ]);
});

test('restores a native stream previous PipeWire target', async () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph({ previousTarget: 2000 })));
  await flushAsyncWork();
  await router.stop();

  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
  ]);
});

test('does not overwrite an output target changed while sharing', async () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph({ previousTarget: 2000 })));
  await flushAsyncWork();
  monitor.stdout.emit('data', JSON.stringify([{
    id: 60,
    type: 'PipeWire:Interface:Metadata',
    props: { 'metadata.name': 'default' },
    metadata: [{
      subject: 40,
      key: 'target.object',
      type: 'Spa:Id',
      value: 3000,
    }],
  }]));
  await flushAsyncWork();
  await router.stop();

  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
  ]);
});

test('still restores after observing its own combined target update', async () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph({ previousTarget: 2000 })));
  await flushAsyncWork();
  monitor.stdout.emit('data', JSON.stringify([{
    id: 60,
    type: 'PipeWire:Interface:Metadata',
    props: { 'metadata.name': 'default' },
    metadata: [{
      subject: 40,
      key: 'target.object',
      type: 'Spa:Id',
      value: 1000,
    }],
  }]));
  await flushAsyncWork();
  await router.stop();

  assert.deepEqual(commands.at(-1), [
    '-n', 'default', '40', 'target.object', '2000', 'Spa:Id',
  ]);
});

test('does not route native streams that are not proven external', async () => {
  const monitor = createMonitor();
  const commands = [];
  const objects = graph();
  objects[2].info.props['pipewire.access'] = 'unrestricted';
  objects[2].info.props['application.process.id'] = 101;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => false,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  await flushAsyncWork();
  await router.stop();
  assert.deepEqual(commands, []);
});

test('uses the host security PID to identify an owned Flatpak stream', async () => {
  const monitor = createMonitor();
  const commands = [];
  const objects = graph();
  objects[2].info.props['application.process.id'] = 2;
  objects[2].info.props['pipewire.sec.pid'] = 500;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => false,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  await flushAsyncWork();
  await router.stop();
  assert.deepEqual(commands, []);
});

test('ignores a Flatpak namespace PID collision when the host PID is external', async () => {
  const monitor = createMonitor();
  const commands = [];
  const objects = graph();
  objects[2].info.props['application.process.id'] = 100;
  objects[2].info.props['pipewire.sec.pid'] = 500;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: pid => pid === 500,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  await flushAsyncWork();
  await router.stop();

  assert.equal(commands[0][2], '40');
  assert.equal(commands[0][4], '1000');
});

test('waits for a Flatpak host PID instead of routing by application name', async () => {
  const monitor = createMonitor();
  const commands = [];
  const objects = graph();
  delete objects[2].info.props['pipewire.sec.pid'];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  await flushAsyncWork();
  await router.stop();

  assert.deepEqual(commands, []);
});

test('retries and reports a failed route restoration', async () => {
  const monitor = createMonitor();
  const warnings = [];
  let calls = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: () => ({ status: calls++ === 0 ? 0 : 1 }),
    processExternal: () => true,
    logger: { warn(message) { warnings.push(message); } },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  await router.stop();

  assert.equal(calls, 5);
  assert.equal(warnings.some(message => message.endsWith(': 40')), true);
});

test('spawns pw-metadata asynchronously instead of blocking the main thread', async () => {
  const monitor = createMonitor();
  const spawned = [];
  const metadataChild = new EventEmitter();
  metadataChild.kill = () => {};
  const router = new PipeWireStreamRouter({
    spawnProcess: (command, args) => {
      if (command === 'pw-metadata') {
        spawned.push(args);
        setImmediate(() => metadataChild.emit('close', 0));
        return metadataChild;
      }
      return monitor;
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  assert.equal(router.start('HavenCombined_100', 100), true);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  // The route must be requested without any synchronous child_process call.
  await flushAsyncWork();
  assert.deepEqual(spawned, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
  ]);
  await router.stop();
});

test('restores a stream moved while the session was stopping', async () => {
  const monitor = createMonitor();
  let resolveMove;
  const moveGate = new Promise(resolve => { resolveMove = resolve; });
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      if (args[2] === '40' && args[4] === '1000') return moveGate.then(() => ({ status: 0 }));
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  // End the session while the move is still in flight. The move itself may
  // still land, so the router must restore the previous target instead of
  // dropping the route and leaving the stream hijacked.
  const stopPromise = router.stop();
  assert.equal(await stopPromise, true);
  resolveMove();
  await flushAsyncWork();
  await router._pendingRestore;

  assert.equal(router._routes.size, 0);
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '-d', '40', 'target.object'],
  ]);
});

test('serializes a new session move after a stale in-flight repair', async () => {
  const monitors = [createMonitor(), createMonitor()];
  let monitorIndex = 0;
  const commands = [];
  let resolveMove;
  const moveGate = new Promise(resolve => { resolveMove = resolve; });
  let moves = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitors[monitorIndex],
    runCommand: (_command, args) => {
      commands.push(args);
      // Hold only the first session's move; everything else succeeds at once.
      if (args[2] === '40' && args[4] === '1000' && ++moves === 1) {
        return moveGate.then(() => ({ status: 0 }));
      }
      return { status: 0 };
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitors[0].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  // Stop the first session and start a new one while its move is in flight.
  // The new session must wait for the stale move + repair instead of racing
  // it, so no second move is issued yet.
  const stopA = router.stop();
  assert.equal(await stopA, true);
  monitorIndex = 1;
  router.start('HavenCombined_100', 100);
  monitors[1].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  // Let the stale move land: repair restores 2000 + delete, then the new
  // session moves to 1000. The repair never lands after the new move.
  resolveMove();
  await flushAsyncWork();
  await router._pendingRestore;
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(router._routes.size, 1);
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '-d', '40', 'target.object'],
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
  ]);
  await router.stop();
});

test('ignores a stream ID reused by an own process while waiting', async () => {
  const monitors = [createMonitor(), createMonitor()];
  let monitorIndex = 0;
  const commands = [];
  let resolveMove;
  const moveGate = new Promise(resolve => { resolveMove = resolve; });
  let moves = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitors[monitorIndex],
    runCommand: (_command, args) => {
      commands.push(args);
      if (args[2] === '40' && args[4] === '1000' && ++moves === 1) {
        return moveGate.then(() => ({ status: 0 }));
      }
      return { status: 0 };
    },
    // Only the Flatpak host PID counts as external; PID 100 is Haven itself.
    processExternal: pid => pid === 500,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitors[0].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  const stopA = router.stop();
  assert.equal(await stopA, true);
  monitorIndex = 1;
  router.start('HavenCombined_100', 100);
  monitors[1].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  // While the old move is still gated, ID 40 is removed and reused by an own
  // Haven stream with a different object.serial on the same sink.
  monitors[1].stdout.emit('data', JSON.stringify([
    { id: 40, info: null },
    { id: 30, info: null },
    {
      id: 90,
      type: 'PipeWire:Interface:Client',
      info: { props: {
        'application.name': 'Haven',
        'application.process.id': 100,
      } },
    },
    {
      id: 40,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'client.id': 90,
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Haven audio',
        'object.serial': 9999,
      } },
    },
    {
      id: 50,
      type: 'PipeWire:Interface:Link',
      info: { 'output-node-id': 40, 'input-node-id': 20 },
    },
  ]));
  await flushAsyncWork();

  // Let the stale move land: neither its repair nor the new session may touch
  // the reused own stream.
  resolveMove();
  await flushAsyncWork();
  await router._pendingRestore;
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(router._routes.size, 0);
  assert.equal(commands.length, 1);
  await router.stop();
});

test('skips a late repair when the ID was reused before stop cleared the graph', async () => {
  const monitor = createMonitor();
  const commands = [];
  let resolveMove;
  const moveGate = new Promise(resolve => { resolveMove = resolve; });
  let moves = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      if (args[2] === '40' && args[4] === '1000' && ++moves === 1) {
        return moveGate.then(() => ({ status: 0 }));
      }
      return { status: 0 };
    },
    processExternal: pid => pid === 500,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  // The monitor reports removal + reuse by an own stream while the move is
  // still gated, then the share stops (clearing the graph, no restart).
  monitor.stdout.emit('data', JSON.stringify([
    { id: 40, info: null },
    { id: 30, info: null },
    {
      id: 90,
      type: 'PipeWire:Interface:Client',
      info: { props: {
        'application.name': 'Haven',
        'application.process.id': 100,
      } },
    },
    {
      id: 40,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'client.id': 90,
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Haven audio',
        'object.serial': 9000,
      } },
    },
    {
      id: 50,
      type: 'PipeWire:Interface:Link',
      info: { 'output-node-id': 40, 'input-node-id': 20 },
    },
  ]));
  await flushAsyncWork();
  assert.equal(commands.length, 1);

  assert.equal(await router.stop(), true);

  // The gated move lands after the clear: with no identity confirmation the
  // repair must not touch ID 40 blindly.
  resolveMove();
  await flushAsyncWork();
  await router._pendingRestore;
  await flushAsyncWork();

  assert.equal(router._routes.size, 0);
  assert.equal(commands.length, 1);
});

test('keeps a later-session reuse veto across its stop before the old move lands', async () => {
  const monitors = [createMonitor(), createMonitor()];
  let monitorIndex = 0;
  const commands = [];
  let resolveMove;
  const moveGate = new Promise(resolve => { resolveMove = resolve; });
  let moves = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitors[monitorIndex],
    runCommand: (_command, args) => {
      commands.push(args);
      if (args[2] === '40' && args[4] === '1000' && ++moves === 1) {
        return moveGate.then(() => ({ status: 0 }));
      }
      return { status: 0 };
    },
    processExternal: pid => pid === 500,
    logger: { warn() {} },
  });

  // Session A routes an external stream; its move stays gated.
  router.start('HavenCombined_100', 100);
  monitors[0].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(commands.length, 1);
  assert.equal(await router.stop(), true);

  // Session B observes ID 40 reused by an own Haven stream with an explicit
  // target of 3000, then stops as well before A's move lands.
  monitorIndex = 1;
  router.start('HavenCombined_100', 100);
  const reused = graph({ previousTarget: 3000 });
  reused[2].info.props = {
    'application.name': 'Haven',
    'application.process.id': 100,
  };
  reused[3].info.props = {
    'client.id': 90,
    'media.class': 'Stream/Output/Audio',
    'node.name': 'Haven audio',
    'object.serial': 9000,
  };
  reused[2].id = 90;
  reused[3].info.props['client.id'] = 90;
  monitors[1].stdout.emit('data', JSON.stringify(reused));
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(commands.length, 1);
  assert.equal(await router.stop(), true);

  // A's gated move lands after both stops: the repair must honor B's reuse
  // veto instead of trusting A's pre-clear snapshot and wiping target 3000.
  resolveMove();
  await flushAsyncWork();
  await router._pendingRestore;
  await flushAsyncWork();

  assert.equal(router._routes.size, 0);
  assert.equal(commands.length, 1);
});

test('serializes an old session restore before a new session move', async () => {
  const monitors = [createMonitor(), createMonitor()];
  let monitorIndex = 0;
  const issued = [];
  const gates = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitors[monitorIndex],
    runCommand: (_command, args) => {
      issued.push(args);
      let resolveGate;
      const gate = new Promise(resolve => { resolveGate = resolve; });
      gates.push({ args, resolveGate });
      return gate.then(() => ({ status: 0 }));
    },
    processExternal: () => true,
    logger: { warn() {} },
  });

  // Session A routes node 40.
  router.start('HavenCombined_100', 100);
  monitors[0].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  assert.equal(issued.length, 1);
  gates[0].resolveGate();
  await flushAsyncWork();
  assert.equal(router._routes.size, 1);

  // Stop A: the restore is issued but held in flight.
  const stopA = router.stop();
  await flushAsyncWork();
  assert.equal(issued.length, 2);

  // Session B starts and sees the same stream while A's restore is pending.
  // Its move must wait until the old restore has fully completed.
  monitorIndex = 1;
  router.start('HavenCombined_100', 100);
  monitors[1].stdout.emit('data', JSON.stringify(graph()));
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(issued.length, 2);

  gates[1].resolveGate();
  await flushAsyncWork();
  assert.equal(issued.length, 3);
  gates[2].resolveGate();
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(issued.length, 4);
  assert.deepEqual(issued[3], ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id']);
  gates[3].resolveGate();
  await flushAsyncWork();
  assert.equal(router._routes.size, 1);
  assert.equal(await stopA, true);

  const stopB = router.stop();
  await flushAsyncWork();
  gates[4].resolveGate();
  await flushAsyncWork();
  gates[5].resolveGate();
  await flushAsyncWork();
  assert.equal(await stopB, true);
});

test('ingests first-snapshot reuse while a different stream blocks the restore queue', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 1 || index === 2 });
  const { router, commands } = harness;
  const objects = graph();
  objects.push({
    id: 42,
    type: 'PipeWire:Interface:Node',
    info: { props: {
      'client.id': 30,
      'media.class': 'Stream/Output/Audio',
      'node.name': 'Second external stream',
      'object.serial': 4200,
    } },
  }, {
    id: 52,
    type: 'PipeWire:Interface:Link',
    info: { 'output-node-id': 42, 'input-node-id': 20 },
  });
  // Node 42 is routed first; node 40 then holds a move in flight.
  const stream40 = objects.splice(objects.findIndex(object => object.id === 40), 1)[0];
  objects.push(stream40);
  harness.start(objects);
  await flushAsyncWork();
  assert.equal(commands.length, 2);
  const stopped = router.stop();
  await flushAsyncWork();
  assert.equal(commands.length, 3);
  harness.complete(1);
  await flushAsyncWork();
  // A's repair is now queued behind node 42's held restore. B's very first
  // snapshot announces reuse, and B stops before that queue is released.
  harness.start(replacementGraph({ own: true }));
  await flushAsyncWork();
  const stoppedB = router.stop();
  harness.complete(2);
  await stopped;
  await stoppedB;
  await router._pendingRestore;
  await flushAsyncWork();
  assert.deepEqual(commands, [
    ['-n', 'default', '42', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '42', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '-d', '42', 'target.object'],
  ]);
  assert.equal(router._activeMoves.size, 0);
  assert.equal(router._routeOperations.size, 0);
});

for (const change of ['reuse', 'external target']) {
  test(`late repair rechecks ${change} before deleting metadata (async spawn)`, async () => {
    const harness = controlledRouting({
      native: true,
      hold: (_args, index) => index === 0 || index === 1,
    });
    const { router, commands } = harness;
    harness.start();
    await flushAsyncWork();
    await router.stop();
    harness.complete(0);
    await flushAsyncWork();
    assert.equal(commands.length, 2);
    if (change === 'reuse') harness.start(replacementGraph({ own: true }));
    else harness.start(graph({ previousTarget: 3000 }));
    await flushAsyncWork();
    const stopB = router.stop();
    harness.complete(1);
    await stopB;
    await router._pendingRestore;
    await flushAsyncWork();
    assert.deepEqual(commands, [
      ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
      ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ]);
    assert.equal(router._activeMoves.size, 0);
    assert.equal(router._routeOperations.size, 0);
  });
}

for (const withoutSerial of [false, true]) {
  test(`same-session ID reuse retains the old operation until settled (serial: ${!withoutSerial})`, async () => {
    const harness = controlledRouting({ hold: (_args, index) => index === 0 });
    const { router, commands } = harness;
    const initial = graph();
    if (withoutSerial) delete initial[3].info.props['object.serial'];
    harness.start(initial);
    await flushAsyncWork();
    const original = router._activeMoves.get(40);
    harness.send([{ id: 40, info: null }, ...replacementGraph({ withoutSerial })]);
    await flushAsyncWork();
    assert.equal(commands.length, 1);
    assert.equal(router._activeMoves.get(40), original);
    assert.equal(original.invalidated, true);
    harness.complete(0);
    await flushAsyncWork();
    assert.equal(router._routes.get(40).previousTarget.value, 3000);
    assert.equal(commands.length, 2);
    await router.stop();
    assert.deepEqual(commands, [
      ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
      ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
      ['-n', 'default', '40', 'target.object', '3000', 'Spa:Id'],
    ]);
    assert.equal(router._activeMoves.size, 0);
    assert.equal(router._routeOperations.size, 0);
  });
}

test('late repair preserves a newer explicit target across two stops', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start(graph({ previousTarget: 2000 }));
  await flushAsyncWork();
  await router.stop();
  const newer = graph({ previousTarget: 3000 });
  newer[1].info.props['object.serial'] = 3000;
  harness.start(newer);
  await flushAsyncWork();
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.equal(commands.length, 1);
  assert.equal(router._routeOperations.size, 0);
});

test('a stable external replacement is routed after waiting, without another update', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  await router.stop();
  harness.start(replacementGraph());
  await flushAsyncWork();
  assert.equal(commands.length, 1);
  harness.complete(0);
  await flushAsyncWork();
  assert.equal(router._routes.get(40).streamSerial, 9000);
  await router.stop();
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '3000', 'Spa:Id'],
  ]);
});

test('a name-only update with the same serial does not cancel a late repair', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  await router.stop();
  harness.start();
  // Merge a partial property update: the serial is retained and authoritative.
  harness.send([{ id: 40, info: { props: { 'node.name': 'Renamed stream' } } }]);
  await flushAsyncWork();
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '-d', '40', 'target.object'],
  ]);
});

test('observing the moved link does not undo a live screen share', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  harness.send([{
    id: 50,
    type: 'PipeWire:Interface:Link',
    info: { 'output-node-id': 40, 'input-node-id': 10 },
  }]);
  harness.complete(0);
  await flushAsyncWork();
  assert.equal(commands.length, 1);
  assert.equal(router._routes.has(40), true);
  await router.stop();
  assert.equal(router._routeOperations.size, 0);
});

test('delayed own restore echoes do not suppress a required retry', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 1 || index === 2 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  const stopped = router.stop();
  await flushAsyncWork();
  harness.start();
  harness.complete(1);
  await flushAsyncWork();
  assert.equal(commands.length, 3);
  // The delete is pending, but pw-dump only now reports our preceding set.
  harness.send(graph({ previousTarget: 2000 }).filter(object => object.type === 'PipeWire:Interface:Metadata'));
  const stoppedB = router.stop();
  harness.complete(2, 1);
  await stopped;
  await stoppedB;
  assert.equal(commands.length, 5);
  assert.deepEqual(commands.slice(3), [
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '-d', '40', 'target.object'],
  ]);
  assert.equal(router._routeOperations.size, 0);
});

test('a partial initial snapshot is not positive evidence of stream reuse', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  await router.stop();
  harness.start([{ id: 40, type: 'PipeWire:Interface:Node', info: { props: {} } }]);
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.equal(commands.length, 3);
  assert.equal(router._routeOperations.size, 0);
});

test('a numeric node ID reused by a Link vetoes the old repair', async () => {
  const harness = controlledRouting({ hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  await router.stop();
  harness.start([{
    id: 40,
    type: 'PipeWire:Interface:Link',
    info: { 'output-node-id': 400, 'input-node-id': 20 },
  }]);
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.equal(commands.length, 1);
  assert.equal(router._routeOperations.size, 0);
});

test('a failed async move releases its operation without attempting a repair', async () => {
  const harness = controlledRouting({ native: true, hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  await router.stop();
  harness.complete(0, 1);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.equal(commands.length, 1);
  assert.equal(router._activeMoves.size, 0);
  assert.equal(router._routeOperations.size, 0);
});

for (const lastObserved of ['combined', 'external']) {
  test(`pending move preserves the last external choice when ${lastObserved} is observed last`, async () => {
    const harness = controlledRouting({ native: true, hold: (_args, index) => index === 0 });
    const { router, commands } = harness;
    harness.start(graph({ previousTarget: 2000 }));
    await flushAsyncWork();
    const announce = value => harness.send(graph({ previousTarget: value }).filter(object =>
      object.type === 'PipeWire:Interface:Metadata'
    ));
    announce(lastObserved === 'combined' ? 3000 : 1000);
    announce(lastObserved === 'combined' ? 1000 : 3000);
    if (lastObserved === 'combined') {
      harness.send([{
        id: 50,
        type: 'PipeWire:Interface:Link',
        info: { 'output-node-id': 40, 'input-node-id': 10 },
      }]);
    }
    // The move has applied/been observed, but its child has not closed yet.
    await router.stop();
    harness.complete(0);
    await flushAsyncWork();
    await router._pendingRestore;
    if (lastObserved === 'combined') {
      assert.deepEqual(commands, [
        ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
        ['-n', 'default', '40', 'target.object', '3000', 'Spa:Id'],
      ]);
    } else {
      assert.equal(commands.length, 1);
    }
    assert.equal(router._activeMoves.size, 0);
    assert.equal(router._routeOperations.size, 0);
  });
}

test('an initial explicit target announced after the move starts is restored after stop', async () => {
  const harness = controlledRouting({ native: true, hold: (_args, index) => index === 0 });
  const { router, commands } = harness;
  harness.start();
  await flushAsyncWork();
  for (const value of [2000, 1000]) {
    harness.send(graph({ previousTarget: value }).filter(object => object.type === 'PipeWire:Interface:Metadata'));
  }
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  await router._pendingRestore;
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
  ]);
});

test('a repair that overwrites a newer target retries that choice, not the old target', async () => {
  const harness = controlledRouting({ native: true, hold: (_args, index) => index === 0 || index === 1 });
  const { router, commands } = harness;
  harness.start(graph({ previousTarget: 2000 }));
  await flushAsyncWork();
  await router.stop();
  harness.complete(0);
  await flushAsyncWork();
  assert.equal(commands.length, 2);
  harness.start(graph({ previousTarget: 2000 }));
  for (const value of [3000, 2000]) {
    harness.send(graph({ previousTarget: value }).filter(object => object.type === 'PipeWire:Interface:Metadata'));
  }
  const stopB = router.stop();
  harness.complete(1);
  await stopB;
  await router._pendingRestore;
  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '3000', 'Spa:Id'],
  ]);
  assert.equal(router._routeOperations.size, 0);
});
