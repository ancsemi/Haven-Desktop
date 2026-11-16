'use strict';

// Activity from other apps on this computer (Haven #5894): the local
// listener that games and music players announce themselves to, and the
// rule that a server page only hears it after the user said yes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OP, MAX_FRAME, encodeFrame, createFrameReader, cleanText, programName, toMillis, toHavenActivity,
  pickCurrent, pipePath, createActivityListener, createNameLookup, serverOrigin, cleanAllowed,
} = require('../src/main/app-activity');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('src/main/main.js');
const PRELOAD = read('src/main/app-preload.js');
const WORLD = read('src/main/app-page-world.js');
const MODULE = read('src/main/app-activity.js');

test('messages survive being split and joined, and junk is refused', () => {
  const a = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', n: 1 });
  const b = encodeFrame(OP.PING, { n: 2 });
  const all = Buffer.concat([a, b]);
  const reader = createFrameReader();
  const got = [];
  for (let i = 0; i < all.length; i += 3) got.push(...reader.push(all.subarray(i, i + 3)));
  assert.deepEqual(got, [{ op: OP.FRAME, data: { cmd: 'SET_ACTIVITY', n: 1 } }, { op: OP.PING, data: { n: 2 } }]);

  const big = Buffer.alloc(8);
  big.writeInt32LE(OP.FRAME, 0);
  big.writeInt32LE(MAX_FRAME + 1, 4);
  assert.throws(() => createFrameReader().push(big), /too large/);
  const odd = Buffer.alloc(8);
  odd.writeInt32LE(9, 0);
  assert.throws(() => createFrameReader().push(odd), /unknown/);
  const bad = Buffer.concat([Buffer.from([1, 0, 0, 0, 3, 0, 0, 0]), Buffer.from('{{{')]);
  assert.throws(() => createFrameReader().push(bad));
});

test('text from another program is made plain', () => {
  assert.equal(cleanText('  Elden\u202E Ring\n\u0000 '), 'Elden Ring');
  assert.equal(cleanText('x'.repeat(500)).length, 120);
  assert.equal(cleanText(42), '');
  assert.equal(programName('C:\\Games\\Heroic.exe'), 'Heroic');
  assert.equal(programName('/usr/bin/feishin'), 'feishin');
  assert.equal(programName('javaw.exe'), '');
  assert.equal(programName('wine64-preloader'), '');
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000123), 1700000000123);
  assert.equal(toMillis('soon'), 0);
});

test('an announcement becomes the little Haven shows', () => {
  const now = 1_800_000_000_000;
  const game = toHavenActivity({
    details: 'Limgrave', state: 'Level 12', timestamps: { start: now / 1000 - 60 },
    assets: { large_image: 'https://evil.example/x.png' }, buttons: [{ label: 'Join', url: 'https://evil.example' }],
  }, 'Elden Ring', now);
  assert.deepEqual(game, { slot: 'playing', name: 'Elden Ring', details: 'Limgrave · Level 12', startedAt: now - 60000, duration: 0, app: 'Elden Ring' });
  assert.ok(!JSON.stringify(game).includes('evil'), 'links and artwork are dropped');

  const song = toHavenActivity({ type: 2, details: 'Track', state: 'Artist', timestamps: { start: now - 5000, end: now + 195000 } }, 'feishin', now);
  assert.deepEqual(song, { slot: 'listening', name: 'Track', details: 'Artist', startedAt: now - 5000, duration: 200000, app: 'feishin' });

  // The app's own name wins over its program's; with neither, its first line is the name.
  assert.equal(toHavenActivity({ name: 'Own Name', details: 'x' }, 'prog', now).name, 'Own Name');
  assert.deepEqual(toHavenActivity({ details: 'Only line' }, '', now), { slot: 'playing', name: 'Only line', details: '', startedAt: now, duration: 0, app: '' });
  assert.equal(toHavenActivity({}, '', now), null);
  assert.equal(toHavenActivity(null, 'App', now), null);
  // A start time in the future, or long ago, is not believed.
  assert.equal(toHavenActivity({ details: 'x', timestamps: { start: now + 9e9 } }, 'App', now).startedAt, now);
});

test('the newest activity for each slot is the one shown', () => {
  const a = { slot: 'playing', name: 'Old' };
  const b = { slot: 'playing', name: 'New' };
  const c = { slot: 'listening', name: 'Song' };
  assert.deepEqual(pickCurrent([{ activity: a, at: 1 }, { activity: c, at: 2 }, { activity: b, at: 3 }, { activity: null, at: 4 }]),
    { playing: { name: 'New' }, listening: { name: 'Song' } });
  assert.deepEqual(pickCurrent([]), { playing: null, listening: null });
});

test('the pipe is where apps look for it', () => {
  assert.equal(pipePath(0, { platform: 'win32', env: {} }), '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(pipePath(3, { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } }), '/run/user/1000/discord-ipc-3');
  assert.equal(pipePath(0, { platform: 'darwin', env: { TMPDIR: '/var/tmp/x' } }), '/var/tmp/x/discord-ipc-0');
});

test('only web origins are remembered as allowed servers', () => {
  assert.equal(serverOrigin('https://chat.example:3000/app'), 'https://chat.example:3000');
  assert.equal(serverOrigin('file:///etc/passwd'), '');
  assert.equal(serverOrigin('nonsense'), '');
  assert.deepEqual(cleanAllowed(['https://a.example/x', 'https://a.example', 'javascript:1', 7]), ['https://a.example']);
  assert.deepEqual(cleanAllowed('https://a.example'), []);
});

test('a program name is read from the system, never guessed', async () => {
  const calls = [];
  const win = createNameLookup({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFile: (file, args, _opts, cb) => { calls.push([file, args]); cb(null, '"Heroic.exe","4242","Console","1","100,000 K"\r\n'); },
  });
  assert.equal(await win(4242), 'Heroic.exe');
  assert.deepEqual(calls[0], ['C:\\Windows\\System32\\tasklist.exe', ['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']]);
  assert.equal(await win('4242; calc'), '', 'only a whole number is ever passed on');
  assert.equal(calls.length, 1);

  const linux = createNameLookup({ platform: 'linux', env: {}, readFile: async (file) => { calls.push(file); return 'feishin\n'; } });
  assert.equal(await linux(5000), 'feishin');
  assert.equal(calls.at(-1), '/proc/5000/comm');
  assert.equal(await linux(2), '', 'an id from inside a sandbox is not looked up');
});

// A real round trip over a real pipe, on a private path so a Discord app on
// this machine is left alone.
function talk(file) {
  const socket = net.createConnection(file);
  const reader = createFrameReader();
  const inbox = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    inbox.push(...reader.push(chunk));
    while (inbox.length && waiters.length) waiters.shift()(inbox.shift());
  });
  return {
    socket,
    send: (op, data) => socket.write(encodeFrame(op, data)),
    next: () => new Promise((resolve) => (inbox.length ? resolve(inbox.shift()) : waiters.push(resolve))),
    closed: new Promise((resolve) => socket.once('close', resolve)),
  };
}

test('an app announces itself, updates, and is forgotten when it leaves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-act-'));
  const env = process.platform === 'win32' ? {} : { XDG_RUNTIME_DIR: dir };
  // On Windows the pipe name is fixed, so stand in a net that renames it.
  const tag = `haven-test-${process.pid}-${Date.now()}`;
  const rename = (file) => (process.platform === 'win32' ? file.replace('discord-ipc', tag) : file);
  const testNet = {
    createServer: (...a) => {
      const s = net.createServer(...a);
      const listen = s.listen.bind(s);
      s.listen = (file, cb) => listen(rename(file), cb);
      return s;
    },
    createConnection: (file) => net.createConnection(rename(file)),
  };
  const changes = [];
  const logs = [];
  const listener = createActivityListener({
    net: testNet, fs, platform: process.platform, env,
    lookupName: async (pid) => (pid === 4242 ? 'Heroic.exe' : ''),
    onChange: (c) => changes.push(c),
    log: (m) => logs.push(m),
  });
  await listener.start();
  assert.ok(listener.isListening(), logs.join('\n'));
  const file = rename(pipePath(0, { platform: process.platform, env }));

  const app = talk(file);
  app.send(OP.HANDSHAKE, { v: 1, client_id: '123456789012345678' });
  const ready = await app.next();
  assert.equal(ready.data.evt, 'READY');

  app.send(OP.PING, { n: 7 });
  assert.deepEqual(await app.next(), { op: OP.PONG, data: { n: 7 } });

  app.send(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: 'n1', args: { pid: 4242, activity: { details: 'In the menus', state: 'Idle' } } });
  const answer = await app.next();
  assert.equal(answer.data.cmd, 'SET_ACTIVITY');
  assert.equal(answer.data.nonce, 'n1');
  assert.equal(changes.at(-1).playing.name, 'Heroic');
  assert.equal(changes.at(-1).playing.details, 'In the menus · Idle');
  assert.equal(listener.current().playing.name, 'Heroic');

  // Anything other than an activity is not answered and changes nothing.
  const before = changes.length;
  app.send(OP.FRAME, { cmd: 'AUTHORIZE', nonce: 'n2', args: { scopes: ['identify'] } });
  app.send(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: 'n3', args: { pid: 4242, activity: null } });
  assert.equal((await app.next()).data.nonce, 'n3');
  assert.equal(changes.length, before + 1);
  assert.deepEqual(changes.at(-1), { playing: null, listening: null });

  app.send(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: 'n4', args: { pid: 4242, activity: { details: 'Playing' } } });
  await app.next();
  assert.equal(changes.at(-1).playing.name, 'Heroic');
  app.socket.destroy();
  await app.closed;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(changes.at(-1), { playing: null, listening: null }, 'gone with the app');

  // An app that speaks before saying hello, or sends junk, is dropped.
  const rude = talk(file);
  rude.socket.write(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0]));
  await rude.closed;

  listener.stop();
  assert.equal(listener.isListening(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a server page only hears it after the user said yes for that server', () => {
  // Every channel checks that the caller is a server page's own top frame.
  for (const channel of ['app-activity:status', 'app-activity:disable']) {
    assert.match(MAIN, new RegExp(`ipcMain\\.handle\\('${channel}', \\(e\\) => \\{\\n\\s+const url = getTrustedServerUrlForFrame\\(e\\.sender, e\\.senderFrame\\);\\n\\s+if \\(!url\\) return`));
  }
  // Switching it on: the page on screen, a fresh user action, then the app's own dialog.
  const enable = MAIN.slice(MAIN.indexOf("ipcMain.handle('app-activity:enable'"), MAIN.indexOf("ipcMain.handle('app-activity:disable'"));
  assert.match(enable, /getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame, \{ active: true \}\)/);
  assert.match(enable, /action\.fresh !== true \|\| _appActivityAsking\) return \{ enabled: false \}/);
  assert.match(enable, /await askAboutAppActivity\(url\)/);
  assert.ok(enable.indexOf('askAboutAppActivity') < enable.indexOf("store.set('appActivityServers'"));
  // Updates go only to pages that were let in, and status lets a page in only when allowed.
  assert.match(MAIN, /if \(enabled\) watchAppActivity\(e\.sender\);/);
  assert.equal([...MAIN.matchAll(/'app-activity:update'/g)].length, 2);
  // Off by default, and the freshness is read in the preload, not taken from the page.
  assert.match(MAIN, /appActivityServers: \[\],/);
  assert.match(PRELOAD, /enable: \(\) => ipcRenderer\.invoke\('app-activity:enable', \{ fresh: userActedJustNow\(\) \}\)/);
  assert.match(WORLD, /on\('app-activity:update'/);
});

test('nothing is looked up anywhere', () => {
  assert.doesNotMatch(MODULE, /fetch\(|https?\.request|require\('(node:)?https?'\)/);
});
