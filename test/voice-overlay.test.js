'use strict';

// The voice overlay: its settings, what a server page's report may contain,
// which report is shown, the page world section that reports, and the
// wiring in main, the preloads and the overlay page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  DEFAULT_OVERLAY_SETTINGS, normalizeOverlaySettings, sanitizeVoiceReport, createVoiceReports,
  safeColor, overlayAlignment, cornerPosition, dragPosition,
} = require('../src/main/voice-overlay-state');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const WORLD = read('src/main/app-page-world.js');
const MAIN = read('src/main/main.js');
const PRELOAD = read('src/main/app-preload.js');
const OVERLAY_MAIN = read('src/main/voice-overlay.js');
const OVERLAY_PRELOAD = read('src/main/voice-overlay-preload.js');
const OVERLAY_PAGE = read('src/renderer/voice-overlay.js');
const OVERLAY_HTML = read('src/renderer/voice-overlay.html');

const ORIGIN = 'https://chat.example';

test('settings start off and anything broken goes back to its default', () => {
  assert.deepEqual(normalizeOverlaySettings(undefined), { ...DEFAULT_OVERLAY_SETTINGS });
  assert.deepEqual(normalizeOverlaySettings({
    enabled: 'yes', x: 'left', y: NaN, onlySpeaking: 1, showMessages: 0, scale: 7, opacity: -1,
  }), { ...DEFAULT_OVERLAY_SETTINGS });
  assert.deepEqual(normalizeOverlaySettings({
    enabled: true, x: 10.4, y: -20, onlySpeaking: true, showMessages: false, scale: 1.2, opacity: 0.7,
  }), { enabled: true, x: 10, y: -20, onlySpeaking: true, showMessages: false, scale: 1.2, opacity: 0.7 });
});

test('only plain colors get through', () => {
  for (const ok of ['#fff', '#7c5cfc', '#7c5cfc80', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)']) assert.equal(safeColor(ok), ok);
  for (const bad of ['red;background:url(x)', 'linear-gradient(red, blue)', 'url(https://x)', 'var(--x)', 'expression(1)', 12, null]) {
    assert.equal(safeColor(bad), null, String(bad));
  }
});

test('a report is cut down to what the overlay shows, and checked', () => {
  const long = 'x'.repeat(1000);
  const r = sanitizeVoiceReport({
    inVoice: true,
    channelName: 'raid',
    users: [
      { id: 1, name: 'Ana', color: '#abc', avatar: `${ORIGIN}/uploads/a.png`, talking: true, isSelf: true },
      { id: 2, name: long, color: 'red;x:y', avatar: 'https://tracker.example/pixel.png', muted: true, deafened: 'yes' },
      { id: 3, avatar: 'javascript:alert(1)' },
      null,
      'nope',
    ],
    messages: [
      { seq: 1, name: 'Ana', content: long, color: '#123' },
      { seq: 'two', name: 'Bad' },
    ],
    extra: 'dropped',
  }, ORIGIN);

  assert.equal(r.inVoice, true);
  assert.equal(r.channelName, 'raid');
  assert.equal(r.users.length, 3);
  assert.deepEqual(r.users[0], {
    id: '1', name: 'Ana', color: '#abc', avatar: `${ORIGIN}/uploads/a.png`,
    isSelf: true, isBot: false, talking: true, muted: false, deafened: false,
  });
  assert.equal(r.users[1].name.length, 64);
  assert.equal(r.users[1].color, null, 'a color that could style the overlay is dropped');
  assert.equal(r.users[1].avatar, null, 'an avatar from another site is not loaded');
  assert.equal(r.users[1].deafened, false, 'only true counts');
  assert.equal(r.users[2].avatar, null);
  assert.equal(r.users[2].name, '?');
  assert.deepEqual(r.messages, [{ seq: 1, name: 'Ana', color: '#123', content: 'x'.repeat(300) }]);
  assert.equal('extra' in r, false);
});

test('out of a call, a report shows nobody', () => {
  const r = sanitizeVoiceReport({ inVoice: false, channelName: 'x', users: [{ id: 1, name: 'A' }], messages: [{ seq: 1 }] }, ORIGIN);
  assert.deepEqual(r, { inVoice: false, channelName: '', users: [], messages: [] });
  for (const bad of [null, undefined, 'x', 5]) assert.equal(sanitizeVoiceReport(bad, ORIGIN), null);
});

test('the overlay shows the call on screen first, else any call', () => {
  const reports = createVoiceReports();
  const call = (name) => ({ inVoice: true, channelName: name, users: [], messages: [] });
  assert.equal(reports.shown(1), null);
  reports.set(1, { inVoice: false, channelName: '', users: [], messages: [] });
  reports.set(2, call('two'));
  assert.equal(reports.shown(1).channelName, 'two', 'the page on screen is not in a call');
  reports.set(1, call('one'));
  assert.equal(reports.shown(1).channelName, 'one');
  assert.equal(reports.shown(1).key, 1);
  reports.drop(1);
  assert.equal(reports.shown(1).channelName, 'two');
  reports.set(2, null);
  assert.equal(reports.shown(1), null);
});

test('corners and alignment put the window where expected', () => {
  const area = { x: 1920, y: 0, width: 2560, height: 1400 };
  const size = { width: 340, height: 620 };
  assert.deepEqual(cornerPosition('top-left', area, size), { x: 1944, y: 24 });
  assert.deepEqual(cornerPosition('bottom-right', area, size), { x: 1920 + 2560 - 340 - 24, y: 1400 - 620 - 24 });
  assert.deepEqual(cornerPosition('nonsense', area, size), { x: 1944, y: 24 });
  assert.equal(overlayAlignment({ x: 1944, y: 24, ...size }, area), 'left');
  assert.equal(overlayAlignment({ x: 4100, y: 24, ...size }, area), 'right');
});

function runWorldSection() {
  const start = WORLD.indexOf('// ─── Voice overlay');
  const end = WORLD.indexOf('// ─── Listen Together media keys', start);
  assert.ok(start > 0 && end > start, 'voice overlay section found');
  const handlers = new Map();
  const socketHandlers = new Map();
  const emitted = [];
  const sent = [];
  const ticks = [];
  const socket = {
    on: (event, fn) => socketHandlers.set(event, fn),
    emit: (event, data) => emitted.push(JSON.parse(JSON.stringify([event, data]))),
  };
  const app = {
    user: { id: 1, username: 'ana', displayName: 'Ana', avatar: '/uploads/ana.png' },
    socket,
    channels: [{ code: 'vc', name: 'raid' }, { code: 'other', name: 'general' }],
    voice: { inVoice: true, currentChannel: 'vc', isMuted: false, isDeafened: false, talkingState: new Map() },
    _getNickname: (id, name) => (id === 2 ? 'Bea (nick)' : name),
    _memberById: (id) => (id === 2 ? { roleColor: '#e06c75', avatar: '/uploads/bea.png' } : null),
  };
  const context = vm.createContext({
    on: (kind, fn) => handlers.set(kind, fn),
    bridge: {
      voiceOverlayEnabled: () => Promise.resolve(false),
      voiceOverlayReport: (r) => sent.push(JSON.parse(JSON.stringify(r))),
    },
    window: { app },
    location: { href: `${ORIGIN}/app.html` },
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: (id) => { ticks[id - 1] = null; },
    setTimeout: (fn) => fn(),
    Map, URL, JSON,
  });
  vm.runInContext(WORLD.slice(start, end), context);
  return {
    app, sent, emitted,
    enable: (on) => handlers.get('voice-overlay:enabled')(on),
    tick: () => ticks.forEach(fn => fn && fn()),
    running: () => ticks.some(Boolean),
    server: (event, data) => socketHandlers.get(event)(data),
  };
}

test('the page world reports only while the overlay is on, and only changes', () => {
  const w = runWorldSection();
  w.tick();
  assert.equal(w.sent.length, 0, 'off: nothing is read or sent');

  w.enable(true);
  assert.equal(w.sent.length, 1, 'turning on reports at once');
  assert.deepEqual(w.sent[0].users.map(u => u.name), ['Ana'], 'before the roster arrives, you are in your own call');
  assert.deepEqual(w.emitted, [['request-voice-users', { code: 'vc', iAmInVoice: true }]], 'turned on mid-call, it asks for the roster once');

  w.tick();
  assert.equal(w.sent.length, 1, 'nothing changed, nothing sent');

  w.server('voice-users-update', { channelCode: 'vc', users: [{ id: 1, username: 'ana' }, { id: 2, username: 'bea', isMuted: true }] });
  w.app.voice.talkingState.set(2, true);
  w.tick();
  const r = w.sent.at(-1);
  assert.equal(r.channelName, 'raid');
  assert.deepEqual(r.users.map(u => [u.name, u.talking, u.muted, u.isSelf]), [['ana', false, false, true], ['Bea (nick)', true, true, false]]);
  assert.equal(r.users[1].color, '#e06c75');
  assert.equal(r.users[1].avatar, `${ORIGIN}/uploads/bea.png`, 'avatars are made absolute');

  w.app.voice.talkingState.set('self', true);
  w.tick();
  assert.equal(w.sent.at(-1).users[0].talking, true, 'your own talking comes from the "self" entry');

  w.enable(false);
  assert.equal(w.running(), false);
  const count = w.sent.length;
  w.app.voice.talkingState.clear();
  w.tick();
  assert.equal(w.sent.length, count, 'off again: nothing sent');
});

test('the page world passes on messages from the call\'s channel only', () => {
  const w = runWorldSection();
  w.enable(true);
  w.server('new-message', { channelCode: 'other', message: { user_id: 2, username: 'bea', content: 'elsewhere' } });
  w.server('new-message', { channelCode: 'vc', message: { user_id: 2, username: 'bea', content: 'pull left' } });
  w.tick();
  assert.deepEqual(w.sent.at(-1).messages, [{ seq: 1, name: 'Bea (nick)', color: '#e06c75', content: 'pull left' }]);

  w.app.voice.inVoice = false;
  w.server('new-message', { channelCode: 'vc', message: { user_id: 2, username: 'bea', content: 'after leaving' } });
  w.tick();
  assert.deepEqual(w.sent.at(-1), { inVoice: false });
});

test('main takes reports and the on/off question only from a trusted server frame', () => {
  for (const channel of ["ipcMain.on('voice-overlay:report'", "ipcMain.handle('voice-overlay:enabled'"]) {
    const at = MAIN.indexOf(channel);
    assert.ok(at > 0, `${channel} is handled`);
    assert.match(MAIN.slice(at, at + 300), /getTrustedServerUrlForFrame\(e\.sender, e\.senderFrame\)/, channel);
  }
  assert.match(MAIN, /sanitizeVoiceReport\(report, getHttpOrigin\(url\)\)/, 'reports are checked against the server they came from');
  assert.match(PRELOAD, /voiceOverlayReport:/);
  assert.match(PRELOAD, /'voice-overlay:enabled'/, 'the on/off change reaches the page world');
  assert.match(MAIN, /voiceOverlay\?\.setAppOpen\(false\)/, 'the overlay closes with the app window, so it cannot keep the app running');
});

test('the overlay window cannot be navigated and its page only draws', () => {
  assert.match(OVERLAY_MAIN, /contextIsolation: true/);
  assert.match(OVERLAY_MAIN, /nodeIntegration: false/);
  assert.match(OVERLAY_MAIN, /sandbox: true/);
  assert.match(OVERLAY_MAIN, /will-navigate', \(e\) => e\.preventDefault\(\)/);
  assert.match(OVERLAY_MAIN, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(OVERLAY_HTML, /script-src 'self'/);
  assert.doesNotMatch(OVERLAY_PAGE, /innerHTML/, 'names and messages are set as text');
});

test('moving hands the drag to the window manager in a window it may move', () => {
  // The usual overlay is a notification window on Linux, which a window
  // manager will not move; moving swaps in an ordinary one at the same spot.
  assert.match(OVERLAY_MAIN, /focusable: moving,/);
  assert.match(OVERLAY_MAIN, /\.\.\.\(!moving && process\.platform === 'linux' \? \{ type: 'notification' \} : \{\}\)/);
  assert.match(OVERLAY_MAIN, /setIgnoreMouseEvents\(!moving\)/);
  assert.match(OVERLAY_MAIN, /open\(\{ x, y \}\);/, 'the swapped window opens where the old one was');
  const css = read('src/renderer/voice-overlay.css');
  assert.match(css, /body\.editing #root \{[^}]*-webkit-app-region: drag;/);
  assert.match(css, /body\.editing #done \{ -webkit-app-region: no-drag; \}/, 'Done stays clickable');
  // Nothing moves the window from a timer or on the page's word.
  assert.doesNotMatch(OVERLAY_MAIN, /setInterval|getCursorScreenPoint/);
  assert.doesNotMatch(OVERLAY_PRELOAD, /drag/);
});
