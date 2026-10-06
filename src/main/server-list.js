'use strict';

// The server list every Haven server page shares inside the app.
//
// Each server keeps its own list in the browser storage of its own address,
// so on their own the lists drift apart: a server removed on one comes back
// from another, a rename or a new order stays where it was made. The app
// keeps the shared copy here and every page reconciles with it:
//
//   history  [{ url, name, lastConnected, customName?, icon?, customIcon? }]
//   removed  [url]  servers the user removed; pages may not add them back
//   order    [url]  the user's order for the server rail
//
// The functions below work on a plain { history, removed, order } object so
// they can be tested without Electron; main.js reads and writes the store.

const HISTORY_CAP = 100;
const REMOVED_CAP = 200;
const NAME_MAX = 100;
const ICON_MAX = 2048;

function normalizeServerUrl(serverUrl) {
  let value = String(serverUrl || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.search = '';
    let pathname = parsed.pathname || '/';
    pathname = pathname.replace(/\/+$/, '') || '/';
    pathname = pathname.replace(/\/app(?:\.html)?$/i, '') || '/';
    pathname = pathname.replace(/\/+$/, '') || '/';
    return pathname === '/' ? parsed.origin : parsed.origin + pathname;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

// Reject obvious garbage (e.g. "https://https", bare words with no TLD)
// while still allowing localhost and IP literals.
function isValidServerHost(serverUrl) {
  try {
    const host = new URL(serverUrl).hostname;
    if (!host) return false;
    if (host === 'localhost') return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4
    if (host.includes(':')) return true; // IPv6 / bracketed
    return host.includes('.') && !/^https?$/i.test(host);
  } catch { return false; }
}

// Dedup + clean a stored serverHistory list. Re-normalizes URLs (lowercases
// host, strips /app paths) and drops malformed entries left over from earlier
// versions that didn't validate input.
function sanitizeServerHistory(list) {
  const seen = new Set();
  const out = [];
  for (const entry of (list || [])) {
    if (!entry || !entry.url) continue;
    const normalizedUrl = normalizeServerUrl(entry.url);
    if (!normalizedUrl || !isValidServerHost(normalizedUrl)) continue;
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    out.push({ ...entry, url: normalizedUrl });
  }
  return out;
}

/** Normalized, valid, unique addresses from a list of strings. */
function cleanUrls(list) {
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (typeof raw !== 'string') continue;
    const url = normalizeServerUrl(raw);
    if (!url || !isValidServerHost(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Read the shared list from an electron-store like object ({ get }). A
 *  server that is both listed and removed counts as removed. */
function readServerList(store) {
  const removed = cleanUrls(store.get('serverListRemoved'));
  const gone = new Set(removed);
  const history = sanitizeServerHistory(store.get('serverHistory') || []).filter(h => !gone.has(h.url));
  const order = cleanUrls(store.get('serverListOrder')).filter(u => !gone.has(u));
  return { history, removed, order };
}

function writeServerList(store, state) {
  store.set('serverHistory', state.history);
  store.set('serverListRemoved', state.removed);
  store.set('serverListOrder', state.order);
}

/** Keep the history under the cap by dropping the servers connected to
 *  longest ago (never the one just added or connected). Dropped servers are
 *  not marked removed, and every other server keeps its place. */
function capHistory(state, keepUrl) {
  while (state.history.length > HISTORY_CAP) {
    let drop = -1;
    for (let i = 0; i < state.history.length; i++) {
      const h = state.history[i];
      if (h.url === keepUrl) continue;
      if (drop < 0 || (h.lastConnected || 0) < (state.history[drop].lastConnected || 0)) drop = i;
    }
    if (drop < 0) break;
    const [gone] = state.history.splice(drop, 1);
    state.order = state.order.filter(u => u !== gone.url);
  }
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, NAME_MAX);
}

/** A page asks to add a server. A server the user removed is refused unless
 *  the user added it on purpose (Add Server), which also lifts the removal.
 *  Returns 'added', 'exists', 'refused' or 'invalid'. */
function addServer(state, rawUrl, rawName, { userInitiated = false } = {}) {
  const url = normalizeServerUrl(rawUrl);
  if (!url || !isValidServerHost(url)) return 'invalid';
  if (state.removed.includes(url)) {
    if (!userInitiated) return 'refused';
    state.removed = state.removed.filter(u => u !== url);
  }
  const name = cleanName(rawName);
  const existing = state.history.find(h => h.url === url);
  if (existing) {
    // A server only known by its address picks up the name it was added with.
    if (name && !existing.customName && (!existing.name || existing.name === existing.url)) existing.name = name;
    return 'exists';
  }
  state.history.push({ url, name: name || url, lastConnected: 0 });
  capHistory(state, url);
  return 'added';
}

/** The user removed a server: drop it and remember that, so no page adds it
 *  back. */
function removeServer(state, rawUrl) {
  const url = normalizeServerUrl(rawUrl);
  if (!url) return false;
  const had = state.history.some(h => h.url === url);
  state.history = state.history.filter(h => h.url !== url);
  state.order = state.order.filter(u => u !== url);
  state.removed = state.removed.filter(u => u !== url);
  state.removed.push(url);
  while (state.removed.length > REMOVED_CAP) state.removed.shift();
  return had;
}

/** The app opened a server: it is wanted again, so the removal is lifted. */
function markConnected(state, rawUrl, now = Date.now()) {
  const url = normalizeServerUrl(rawUrl);
  if (!url) return;
  state.removed = state.removed.filter(u => u !== url);
  const existing = state.history.find(h => h.url === url);
  if (existing) existing.lastConnected = now;
  else state.history.push({ url, name: url, lastConnected: now });
  capHistory(state, url);
}

/** Change a server's name (and, for the user's own edits, its icon).
 *  opts.custom === true: a name the user chose; it sticks.
 *  opts.custom === false: the user went back to the server's own name.
 *  no opts.custom: the name the server reports, ignored over a user's name.
 *  Returns true when something changed. */
function updateServerName(state, rawUrl, rawName, opts = {}) {
  const url = normalizeServerUrl(rawUrl);
  const name = cleanName(rawName);
  const entry = state.history.find(h => h.url === url);
  if (!entry || !name) return false;
  const before = JSON.stringify(entry);
  const custom = opts && typeof opts.custom === 'boolean' ? opts.custom : undefined;
  if (custom === undefined) {
    if (entry.customName) return false;
    entry.name = name;
  } else {
    entry.name = name;
    if (custom) entry.customName = true;
    else delete entry.customName;
    if (Object.prototype.hasOwnProperty.call(opts, 'icon')) {
      const icon = typeof opts.icon === 'string' ? opts.icon.trim() : '';
      if (icon && icon.length <= ICON_MAX && /^https?:\/\//i.test(icon)) {
        entry.icon = icon;
        entry.customIcon = true;
      } else {
        delete entry.icon;
        delete entry.customIcon;
      }
    }
  }
  return JSON.stringify(entry) !== before;
}

/** Every known server address in the user's order: ordered ones first, then
 *  the rest in the order they were added. */
function orderedUrls(state) {
  const known = new Set(state.history.map(h => h.url));
  const out = state.order.filter(u => known.has(u));
  const placed = new Set(out);
  for (const h of state.history) if (!placed.has(h.url)) out.push(h.url);
  return out;
}

/** A page sends its order. A page does not list every server (it hides
 *  itself), so only the servers it lists move, among the places they already
 *  hold; everything else keeps its place. */
function setOrder(state, rawUrls) {
  const gone = new Set(state.removed);
  const want = cleanUrls(rawUrls).filter(u => !gone.has(u));
  const base = [];
  const baseSet = new Set();
  for (const u of [...state.order, ...orderedUrls(state)]) {
    if (!baseSet.has(u)) { baseSet.add(u); base.push(u); }
  }
  const inBase = want.filter(u => baseSet.has(u));
  const wantSet = new Set(inBase);
  let i = 0;
  const out = base.map(u => (wantSet.has(u) ? inBase[i++] : u));
  for (const u of want) if (!baseSet.has(u)) out.push(u);
  const before = state.order.join('\n');
  state.order = out.slice(0, HISTORY_CAP * 2);
  return state.order.join('\n') !== before;
}

/** What a page reads: the servers in the user's order, the removed ones and
 *  the order itself. */
function serverListView(state) {
  const byUrl = new Map(state.history.map(h => [h.url, h]));
  const order = orderedUrls(state);
  return {
    servers: order.map(u => ({ ...byUrl.get(u) })),
    removed: [...state.removed],
    order,
  };
}

module.exports = {
  HISTORY_CAP,
  normalizeServerUrl,
  isValidServerHost,
  sanitizeServerHistory,
  readServerList,
  writeServerList,
  addServer,
  removeServer,
  markConnected,
  updateServerName,
  setOrder,
  orderedUrls,
  serverListView,
};
