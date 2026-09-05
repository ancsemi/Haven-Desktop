const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  PipeWireStreamRouter,
  createJsonArrayParser,
} = require('../src/main/pipewire-stream-router');

function createMonitor() {
  const monitor = new EventEmitter();
  monitor.stdout = new EventEmitter();
  monitor.kill = () => { monitor.killed = true; };
  return monitor;
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
      } },
    },
    {
      id: 40,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'client.id': 30,
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Stremio audio',
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

test('routes native Flatpak audio but leaves pipewire-pulse streams alone', () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
    processInTree: () => false,
    logger: { warn() {} },
  });

  assert.equal(router.start('HavenCombined_100', 100), true);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  assert.deepEqual(commands, [[
    'pw-metadata',
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
  ]]);

  router.stop();
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

test('restores a native stream previous PipeWire target', () => {
  const monitor = createMonitor();
  const commands = [];
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
    processInTree: () => false,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph({ previousTarget: 2000 })));
  router.stop();

  assert.deepEqual(commands, [
    ['-n', 'default', '40', 'target.object', '1000', 'Spa:Id'],
    ['-n', 'default', '40', 'target.object', '2000', 'Spa:Id'],
  ]);
});

test('does not route native streams owned by the Haven process tree', () => {
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
    processInTree: pid => pid === 101,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  router.stop();
  assert.deepEqual(commands, []);
});

test('uses the host security PID to identify an owned Flatpak stream', () => {
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
    processInTree: pid => pid === 500,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  router.stop();
  assert.deepEqual(commands, []);
});

test('ignores a Flatpak namespace PID collision when the host PID is external', () => {
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
    processInTree: pid => pid === 100,
    logger: { warn() {} },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(objects));
  router.stop();

  assert.equal(commands[0][2], '40');
  assert.equal(commands[0][4], '1000');
});

test('retries and reports a failed route restoration', () => {
  const monitor = createMonitor();
  const warnings = [];
  let calls = 0;
  const router = new PipeWireStreamRouter({
    spawnProcess: () => monitor,
    runCommand: () => ({ status: calls++ === 0 ? 0 : 1 }),
    processInTree: () => false,
    logger: { warn(message) { warnings.push(message); } },
  });

  router.start('HavenCombined_100', 100);
  monitor.stdout.emit('data', JSON.stringify(graph()));
  router.stop();

  assert.equal(calls, 5);
  assert.equal(warnings.some(message => message.endsWith(': 40')), true);
});
