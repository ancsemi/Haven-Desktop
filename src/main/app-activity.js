'use strict';

// Activity from other apps on this computer (Haven #5894).
//
// Games and music players that support "rich presence" announce what they
// are doing to a Discord app on the same computer, over a local pipe. This
// listens on that pipe, so those apps show as the user's activity in Haven
// instead. It is off until the user turns it on for a server, and main only
// hands what it hears to the server pages the user said yes to.
//
// Everything stays on this computer: nothing is looked up anywhere. Apps
// send a number, not their name, and turning the number into a name or
// artwork would mean asking Discord's servers, so the name shown is the one
// the app gives or the name of its program, and there is no artwork.
//
// While a real Discord app runs it holds the pipe apps look for first, and
// this hears nothing.
//
// Kept apart from main.js, with its file system and network handed in, so it
// can be tested without Electron.

const path = require('node:path');

const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });
const MAX_FRAME = 64 * 1024;
const MAX_CLIENTS = 10;
const PIPE_TRIES = 10;
const TEXT_MAX = 120;
const DAY_MS = 24 * 3600 * 1000;

/** One protocol message: the kind, the length, then JSON. */
function encodeFrame(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/**
 * Collects bytes into messages. push(chunk) returns the complete messages
 * so far as [{ op, data }], and throws on anything that is not the protocol
 * (the caller drops the connection).
 */
function createFrameReader() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (op < 0 || op > OP.PONG) throw new Error('unknown message kind');
        if (len < 0 || len > MAX_FRAME) throw new Error('message too large');
        if (buf.length < 8 + len) break;
        const data = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        buf = buf.subarray(8 + len);
        out.push({ op, data });
      }
      if (buf.length > MAX_FRAME + 8) throw new Error('message too large');
      return out;
    },
  };
}

/** Text another program chose, made plain: no control or invisible
 *  formatting characters, one line, not too long. */
function cleanText(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Programs that run other things: their name says nothing about the app.
const GENERIC_PROGRAMS = new Set([
  'java', 'javaw', 'python', 'python3', 'pythonw', 'node', 'electron', 'wine', 'wine64',
  'wine-preloader', 'wine64-preloader', 'wineserver', 'bash', 'sh', 'cmd', 'powershell', 'pwsh',
  'dotnet', 'mono', 'steam', 'proton', 'bwrap', 'flatpak', 'systemd',
]);

/** A program's file name as an app name ("Heroic.exe" -> "Heroic"), or ''
 *  when it only names a launcher or runtime. */
function programName(raw) {
  let name = cleanText(String(raw || '').split(/[\\/]/).pop(), 60);
  name = name.replace(/\.(exe|appimage|bin|x86_64)$/i, '');
  if (!name || GENERIC_PROGRAMS.has(name.toLowerCase())) return '';
  return name;
}

/** A start or end time an app sent, in seconds or milliseconds, as
 *  milliseconds; 0 when it is not a time. */
function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
}

/**
 * What an app announced, as the little Haven shows:
 *   { slot: 'playing' | 'listening', name, details, startedAt, duration, app }
 * or null when there is nothing to show. `appName` is the app's own name
 * when known. Buttons, links, artwork, party and join details are dropped.
 */
function toHavenActivity(activity, appName, now = Date.now()) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  const app = cleanText(activity.name, 60) || cleanText(appName, 60);
  const details = cleanText(activity.details);
  const state = cleanText(activity.state);
  const stamps = activity.timestamps && typeof activity.timestamps === 'object' ? activity.timestamps : {};
  let startedAt = toMillis(stamps.start);
  if (!startedAt || startedAt > now || startedAt < now - 7 * DAY_MS) startedAt = now;
  const end = toMillis(stamps.end);
  const duration = end > startedAt && end - startedAt <= DAY_MS ? end - startedAt : 0;

  // A music player: the track is the headline, the artist the detail.
  if (Number(activity.type) === 2 && details) {
    return { slot: 'listening', name: details, details: state, startedAt, duration, app };
  }
  const text = [details, state].filter(Boolean).join(' · ').slice(0, TEXT_MAX);
  if (app) return { slot: 'playing', name: app, details: text, startedAt, duration: 0, app };
  // No name for the app: its own first line is the best there is.
  if (details) return { slot: 'playing', name: details, details: state, startedAt, duration: 0, app: '' };
  if (state) return { slot: 'playing', name: state, details: '', startedAt, duration: 0, app: '' };
  return null;
}

/** The newest activity for each slot, from every connected app's latest. */
function pickCurrent(entries) {
  const out = { playing: null, listening: null };
  const seen = { playing: -1, listening: -1 };
  for (const e of entries) {
    if (!e || !e.activity || e.at <= seen[e.activity.slot]) continue;
    seen[e.activity.slot] = e.at;
    const { slot, ...rest } = e.activity;
    out[slot] = rest;
  }
  return out;
}

/** Where apps look for the pipe, numbered 0 to 9. */
function pipePath(index, { platform, env }) {
  if (platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
  const dir = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  return path.posix.join(dir, `discord-ipc-${index}`);
}

const READY = Object.freeze({
  cmd: 'DISPATCH',
  evt: 'READY',
  nonce: null,
  data: {
    v: 1,
    // Apps expect these fields; nothing here is ever contacted by Haven.
    config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
    user: { id: '0', username: 'haven', discriminator: '0', global_name: 'Haven', avatar: null, bot: false, flags: 0, premium_type: 0 },
  },
});

/**
 * The listener. start() opens the pipe (the first free one of 0 to 9) and
 * stop() closes it and forgets everything. onChange({ playing, listening })
 * runs whenever what should be shown changes.
 *
 * deps: net (node:net), fs (node:fs, for a stale socket file on Linux and
 * macOS), platform, env, lookupName(pid) -> Promise<string>, log(message).
 */
function createActivityListener({ net, fs, platform, env, lookupName, onChange, log = () => {} }) {
  let server = null;
  let starting = false;
  let stopped = true;
  let order = 0;
  let lastSent = JSON.stringify(pickCurrent([]));
  const clients = new Map(); // socket -> { activity, at, name, pid }

  function publish() {
    const current = pickCurrent(clients.values());
    const json = JSON.stringify(current);
    if (json === lastSent) return;
    lastSent = json;
    onChange(current);
  }

  function send(socket, op, data) {
    if (socket.destroyed) return;
    try { socket.write(encodeFrame(op, data)); }
    catch (err) { log(`could not answer an app: ${err.message}`); }
  }

  async function nameFor(client, pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) return client.name || '';
    if (client.pid === id) return client.name || '';
    client.pid = id;
    client.name = '';
    try { client.name = programName(await lookupName(id)); }
    catch (err) { log(`could not read the name of program ${id}: ${err.message}`); }
    return client.name;
  }

  async function onRequest(socket, client, msg) {
    if (!msg || typeof msg !== 'object' || msg.cmd !== 'SET_ACTIVITY') return; // nothing else is offered
    const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
    const raw = args.activity && typeof args.activity === 'object' ? args.activity : null;
    const turn = ++order;
    const name = raw ? await nameFor(client, args.pid) : '';
    if (!clients.has(socket)) return; // gone while the name was read
    client.activity = raw ? toHavenActivity(raw, name) : null;
    client.at = turn;
    send(socket, OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      evt: null,
      nonce: msg.nonce ?? null,
      data: raw ? { ...raw, name: client.activity?.app || '', application_id: client.clientId, type: Number(raw.type) || 0 } : null,
    });
    publish();
  }

  function onConnection(socket) {
    if (clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    const client = { activity: null, at: 0, name: '', pid: 0, clientId: '', ready: false };
    const reader = createFrameReader();
    clients.set(socket, client);
    const drop = () => {
      if (!clients.delete(socket)) return;
      publish();
    };
    socket.on('error', drop); // an app that vanished mid-message: forget it
    socket.on('close', drop);
    socket.on('data', (chunk) => {
      let frames;
      try { frames = reader.push(chunk); }
      catch (err) { log(`dropped an app that sent something unreadable: ${err.message}`); socket.destroy(); return; }
      for (const { op, data } of frames) {
        if (op === OP.PING) { send(socket, OP.PONG, data); continue; }
        if (op === OP.CLOSE) { socket.destroy(); return; }
        if (op === OP.HANDSHAKE) {
          const id = data && (typeof data.client_id === 'string' || typeof data.client_id === 'number') ? String(data.client_id) : '';
          if (client.ready || !/^\d{1,32}$/.test(id) || Number(data.v ?? 1) !== 1) { socket.destroy(); return; }
          client.ready = true;
          client.clientId = id;
          send(socket, OP.FRAME, READY);
          continue;
        }
        if (op === OP.FRAME && client.ready) {
          onRequest(socket, client, data).catch(err => log(`an app's activity could not be read: ${err.message}`));
        }
      }
    });
  }

  /** On Linux and macOS a socket file can outlive the app that made it.
   *  Resolves true when nothing answers there, so the file may be replaced. */
  function isStale(file) {
    return new Promise((resolve) => {
      const probe = net.createConnection(file);
      const done = (stale) => { probe.destroy(); resolve(stale); };
      probe.once('connect', () => done(false));
      probe.once('error', () => done(true));
    });
  }

  function listenOn(file) {
    return new Promise((resolve) => {
      const s = net.createServer(onConnection);
      s.once('error', () => resolve(null)); // in use (a Discord app, or another listener): try the next one
      s.listen(file, () => {
        s.removeAllListeners('error');
        s.on('error', err => log(`listener error: ${err.message}`));
        resolve(s);
      });
    });
  }

  async function start() {
    if (server || starting) return;
    starting = true;
    stopped = false;
    try {
      for (let i = 0; i < PIPE_TRIES && !stopped; i += 1) {
        const file = pipePath(i, { platform, env });
        if (platform !== 'win32' && fs.existsSync(file)) {
          if (!(await isStale(file))) continue;
          try { fs.unlinkSync(file); }
          catch (err) { log(`could not clear ${file}: ${err.message}`); continue; }
        }
        const s = await listenOn(file);
        if (!s) continue;
        if (stopped) { s.close(); return; }
        server = s;
        log(`listening for app activity at ${file}${i ? ' (a Discord app holds the first pipe, so most apps will not find this one)' : ''}`);
        return;
      }
      if (!stopped) log('no free pipe to listen for app activity on');
    } finally {
      starting = false;
    }
  }

  function stop() {
    stopped = true;
    for (const socket of clients.keys()) socket.destroy();
    clients.clear();
    if (server) {
      server.close(); // also removes the socket file on Linux and macOS
      server = null;
    }
    publish();
  }

  return { start, stop, current: () => pickCurrent(clients.values()), isListening: () => !!server };
}

/**
 * The file name of a running program, by process id, read from the system
 * itself. deps: platform, env, execFile (node:child_process), readFile
 * (node:fs/promises). Resolves '' when it cannot be read.
 */
function createNameLookup({ platform, env, execFile, readFile }) {
  const run = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
  return async function lookupName(pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return '';
    if (platform === 'win32') {
      const tasklist = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tasklist.exe');
      const out = await run(tasklist, ['/FI', `PID eq ${id}`, '/FO', 'CSV', '/NH']);
      const m = /^"([^"]+)"/.exec(out.trim());
      return m ? m[1] : '';
    }
    if (platform === 'linux') {
      // Ids this low inside a sandbox (Flatpak, Snap) are not this system's.
      if (id < 100) return '';
      return String(await readFile(`/proc/${id}/comm`, 'utf8')).trim();
    }
    return (await run('/bin/ps', ['-p', String(id), '-o', 'comm='])).trim();
  };
}

/** The origin a server's yes is kept under, or '' for anything not a web address. */
function serverOrigin(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch {
    return ''; // not a URL: no server to remember
  }
}

/** The servers the user said yes to, as stored: a short list of origins. */
function cleanAllowed(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(serverOrigin).filter(Boolean))].slice(0, 200);
}

module.exports = {
  OP, MAX_FRAME, encodeFrame, createFrameReader, cleanText, programName, toMillis, toHavenActivity,
  pickCurrent, pipePath, createActivityListener, createNameLookup, serverOrigin, cleanAllowed,
};
