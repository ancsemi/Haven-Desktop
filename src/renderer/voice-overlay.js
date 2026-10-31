'use strict';

// The voice overlay's page (see src/main/voice-overlay.js). Main sends how to
// look (view) and what to show (state); everything here is drawing.

const $ = (id) => document.getElementById(id);
const usersEl = $('users');
const msgsEl = $('messages');
const headerEl = $('header');
const hintEl = $('hint');

let view = { onlySpeaking: false, showMessages: true, scale: 1, opacity: 1, messageSeconds: 12, editing: false, align: 'left', labels: {} };
let state = null;

const MAX_MESSAGES = 4;
const svgNs = 'http://www.w3.org/2000/svg';
const ICONS = {
  muted: 'M19 11a7 7 0 0 1-1.1 3.8l-1.5-1.5c.4-.7.6-1.5.6-2.3h2zM15 11V5a3 3 0 0 0-5.9-.8L15 10.1V11zM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.4 2.6l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1c1-.1 1.9-.5 2.7-1l3.9 4 1.4-1.3L4.3 3z',
  deafened: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 11.8-5.1l1.4-1.4A9 9 0 0 0 12 3zm7.9 4.5-1.5 1.5c.4.9.6 1.9.6 3v1h-3v8h3a2 2 0 0 0 2-2v-7c0-1.6-.4-3.1-1.1-4.5zM2.7 2 1.3 3.4l19.3 19.3 1.4-1.4L2.7 2z',
};

function icon(name) {
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(svgNs, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.appendChild(p);
  return svg;
}

function applyView() {
  document.documentElement.style.setProperty('--scale', String(view.scale));
  document.body.style.opacity = String(view.opacity);
  document.body.classList.toggle('editing', !!view.editing);
  document.body.classList.toggle('right', view.align === 'right');
  $('edit-hint').textContent = view.labels.move || '';
  $('done').textContent = view.labels.done || 'Done';
}

function avatarFor(u) {
  const el = document.createElement('div');
  el.className = 'avatar';
  if (u.color) el.style.setProperty('--c', u.color);
  el.textContent = (u.name || '?').trim().charAt(0).toUpperCase();
  if (u.avatar) {
    const img = new Image();
    img.alt = '';
    img.onload = () => el.replaceChildren(img);
    img.src = u.avatar;
  }
  return el;
}

// Rows are kept by user id, so a talking change only flips a class and the
// avatar is not loaded again.
const rows = new Map();

function renderUsers() {
  const users = state ? state.users.filter(u => !view.onlySpeaking || u.talking) : [];
  const keep = new Set();
  users.forEach((u, i) => {
    keep.add(u.id);
    let row = rows.get(u.id);
    if (!row) {
      row = { el: document.createElement('div'), look: null };
      row.el.className = 'user';
      row.name = document.createElement('div');
      row.name.className = 'name';
      row.bot = document.createElement('span');
      row.bot.className = 'bot';
      row.bot.textContent = 'BOT';
      row.icons = document.createElement('div');
      row.icons.className = 'icons';
      rows.set(u.id, row);
    }
    const look = `${u.avatar}|${u.color}|${u.name}|${u.isBot}`;
    if (row.look !== look) {
      row.look = look;
      row.name.textContent = u.name;
      row.el.replaceChildren(avatarFor(u), row.name, ...(u.isBot ? [row.bot] : []), row.icons);
    }
    const status = `${u.muted}|${u.deafened}`;
    if (row.status !== status) {
      row.status = status;
      row.icons.replaceChildren(...(u.muted ? [icon('muted')] : []), ...(u.deafened ? [icon('deafened')] : []));
    }
    row.el.classList.toggle('talking', u.talking);
    if (usersEl.children[i] !== row.el) usersEl.insertBefore(row.el, usersEl.children[i] || null);
  });
  for (const [id, row] of rows) {
    if (!keep.has(id)) { row.el.remove(); rows.delete(id); }
  }
  headerEl.textContent = state ? `🔊 ${state.channelName}` : '';
  headerEl.classList.toggle('show', !!state && (users.length > 0 || view.editing));
}

// A message shows for messageSeconds from when the overlay first saw it.
// Messages already there when a call's report first arrives are old news.
const firstSeen = new Map(); // `${key}#${seq}` -> time
let primedFor = null;

function renderMessages() {
  const now = Date.now();
  const list = [];
  if (state && view.showMessages) {
    const old = primedFor !== state.key;
    primedFor = state.key;
    const ttl = view.messageSeconds * 1000;
    for (const m of state.messages) {
      const id = `${state.key}#${m.seq}`;
      if (!firstSeen.has(id)) firstSeen.set(id, old ? 0 : now);
      const age = now - firstSeen.get(id);
      if (age < ttl) list.push({ m, fading: age > ttl - 700 });
    }
  }
  msgsEl.replaceChildren(...list.slice(-MAX_MESSAGES).map(({ m, fading }) => {
    const el = document.createElement('div');
    el.className = fading ? 'msg fading' : 'msg';
    const who = document.createElement('div');
    who.className = 'who';
    if (m.color) who.style.setProperty('--c', m.color);
    who.textContent = m.name;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.content;
    el.append(who, body);
    return el;
  }));
  if (firstSeen.size > 200) {
    for (const id of [...firstSeen.keys()].slice(0, 100)) firstSeen.delete(id);
  }
}

function render() {
  renderUsers();
  renderMessages();
  hintEl.textContent = state ? '' : (view.labels.idle || '');
  hintEl.classList.toggle('show', !state);
}

setInterval(renderMessages, 500); // messages fade on their own

// ── Moving ──
// While moving, the window manager drags the window (-webkit-app-region in
// voice-overlay.css); this page only says when the user is done.
$('done').addEventListener('click', () => window.voiceOverlay?.done());
document.addEventListener('keydown', (e) => {
  if (view.editing && (e.key === 'Escape' || e.key === 'Enter')) window.voiceOverlay?.done();
});

if (window.voiceOverlay) {
  window.voiceOverlay.onView((v) => { view = v; applyView(); render(); });
  window.voiceOverlay.onState((s) => { state = s; render(); });
}
