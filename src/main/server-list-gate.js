'use strict';

// Which changes a server page may make to the shared server list.
//
// Every server the user opens runs its own web page inside the app, and the
// shared list (server-list.js) decides what every one of those pages shows in
// its sidebar. So no single server page decides alone which OTHER servers the
// user has: adding, removing, bringing back, renaming or changing the icon of
// a server, or opening a server that is not in the list, is shown to the user
// in the app's own dialog first, naming the change and the server whose page
// asked. Reordering needs no question (it cannot add or remove anything), and
// a page may report the name of its own server.
//
// The app's own screens (the welcome screen) are not server pages and change
// the list directly.
//
// Everything here is plain data so it can be tested without Electron; main.js
// shows the dialog and writes the store.

const {
  normalizeServerUrl, isValidServerHost, addServer, removeServer, updateServerName,
} = require('./server-list');

const TEXT_MAX = 80;
const ICON_TEXT_MAX = 200;

/** Text a page chose, made safe to show in a dialog: no line breaks or
 *  invisible formatting characters (which could fake more dialog text or
 *  reverse it), and not too long. */
function safeText(value, max = TEXT_MAX) {
  const text = String(value == null ? '' : value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function hostOf(url) {
  try { return new URL(url).host; }
  catch { return String(url || ''); } // not a URL: show it as it is
}

function isAddressName(name, url) {
  const text = String(name || '').trim();
  return !text || text === url || normalizeServerUrl(text) === url;
}

/** How a server is named in a question: its name, or its host when it only
 *  has an address. */
function displayName(name, url) {
  return safeText(isAddressName(name, url) ? hostOf(url) : name);
}

function findEntry(state, url) {
  return state.history.find(h => h.url === url) || null;
}

/** The options a rename may carry, and nothing else. */
function renameOptions(opts) {
  const out = {};
  if (!opts || typeof opts !== 'object') return out;
  if (typeof opts.custom === 'boolean') out.custom = opts.custom;
  if (Number.isFinite(Number(opts.editedAt)) && Number(opts.editedAt) > 0) out.editedAt = Number(opts.editedAt);
  if (Object.prototype.hasOwnProperty.call(opts, 'icon')) out.icon = opts.icon;
  return out;
}

function ignore(result) {
  return { action: 'ignore', result };
}

function ask(prompt) {
  return {
    action: 'ask',
    key: JSON.stringify([prompt.kind, prompt.url, prompt.name || '', prompt.icon || '', prompt.iconChange || '']),
    prompt,
  };
}

/**
 * Decide what happens to a server page's request.
 *
 *   request: { kind: 'add' | 'remove' | 'rename' | 'open', url, name?, opts? }
 *   requesterUrl: the address of the server whose page asked (a key of the
 *     app's server views, already normalized)
 *
 * Returns one of
 *   { action: 'ignore', result }  nothing changes; result goes back to the page
 *   { action: 'apply' }           safe to apply without asking
 *   { action: 'ask', key, prompt } apply only once the user says yes
 */
function planPageRequest(state, request, requesterUrl) {
  const kind = request && request.kind;
  const url = normalizeServerUrl(request && request.url);
  const valid = !!url && isValidServerHost(url);
  const entry = valid ? findEntry(state, url) : null;
  const opts = (request && request.opts && typeof request.opts === 'object') ? request.opts : {};

  if (kind === 'add') {
    if (!valid) return ignore('invalid');
    if (entry) return ignore('exists');
    // Only the user's own Add Server may add a server. An automatic merge
    // from a page never adds one, and never brings back a removed one.
    if (opts.userInitiated !== true) return ignore('refused');
    const removed = state.removed.includes(url);
    return ask({ kind: removed ? 'addBack' : 'add', url, name: displayName(request.name, url) });
  }

  if (kind === 'remove') {
    if (!entry) return ignore(null);
    return ask({ kind: 'remove', url, name: displayName(entry.name, url) });
  }

  if (kind === 'rename') {
    if (!entry) return ignore(false);
    const options = renameOptions(opts);
    if (options.custom === undefined) {
      // The name a server reports: only its own page may say it.
      return (requesterUrl && url === requesterUrl) ? { action: 'apply' } : ignore(false);
    }
    const trial = { history: [{ ...entry }], removed: [], order: [] };
    if (!updateServerName(trial, url, request.name, options)) return ignore(false);
    const after = trial.history[0];
    const nameChanged = after.name !== entry.name;
    const iconChanged = (after.icon || '') !== (entry.icon || '');
    // A change nobody would see (only the flags) is not asked about, and not
    // made: the page's own list keeps its version.
    if (!nameChanged && !iconChanged) return ignore(false);
    return ask({
      kind: 'rename',
      url,
      oldName: displayName(entry.name, url),
      name: displayName(after.name, url),
      icon: iconChanged && after.icon ? after.icon : '',
      iconChange: iconChanged ? (after.icon ? 'set' : 'removed') : '',
    });
  }

  if (kind === 'open') {
    if (!valid) return ignore(false);
    // Opening a server adds it to the list (or brings it back), so a server
    // that is not listed is asked about first.
    if (entry) return { action: 'apply' };
    return ask({ kind: 'open', url });
  }

  return ignore(null);
}

/** Make the change a plan allowed (or the user confirmed). Returns what the
 *  list function returned. Opening changes nothing here: the app marks the
 *  server connected when it opens it. */
function applyPageRequest(state, request, { now = Date.now() } = {}) {
  const opts = (request.opts && typeof request.opts === 'object') ? request.opts : {};
  switch (request.kind) {
    case 'add':
      return addServer(state, request.url, request.name, { userInitiated: opts.userInitiated === true, now });
    case 'remove':
      return removeServer(state, request.url);
    case 'rename':
      return updateServerName(state, request.url, request.name, renameOptions(opts));
    default:
      return null;
  }
}

/** The text of the question, in the user's language (t is the app's
 *  translate function). requester: { name, url } of the server that asked. */
function promptText(prompt, requester, t) {
  const askedBy = { name: displayName(requester && requester.name, requester && requester.url), url: safeText(requester && requester.url, ICON_TEXT_MAX) };
  const url = safeText(prompt.url, ICON_TEXT_MAX);
  let message;
  let confirm;
  const detail = [];
  switch (prompt.kind) {
    case 'add':
      message = t('serverList.gate.add', { name: prompt.name, url });
      confirm = t('serverList.gate.confirmAdd');
      break;
    case 'addBack':
      message = t('serverList.gate.addBack', { name: prompt.name, url });
      confirm = t('serverList.gate.confirmAdd');
      break;
    case 'remove':
      message = t('serverList.gate.remove', { name: prompt.name, url });
      confirm = t('serverList.gate.confirmRemove');
      break;
    case 'rename':
      message = prompt.name !== prompt.oldName
        ? t('serverList.gate.rename', { oldName: prompt.oldName, name: prompt.name, url })
        : t('serverList.gate.changeIcon', { name: prompt.name, url });
      if (prompt.iconChange === 'set') detail.push(t('serverList.gate.iconSet', { icon: safeText(prompt.icon, ICON_TEXT_MAX) }));
      if (prompt.iconChange === 'removed') detail.push(t('serverList.gate.iconRemoved'));
      confirm = t('serverList.gate.confirmChange');
      break;
    default:
      message = t('serverList.gate.open', { url });
      confirm = t('serverList.gate.confirmOpen');
      break;
  }
  detail.push(t('serverList.gate.askedBy', askedBy));
  detail.push(t('serverList.gate.explain'));
  return {
    title: t('serverList.gate.title'),
    message,
    detail: detail.join('\n\n'),
    confirm,
    cancel: t('dialog.cancel'),
    block: t('serverList.gate.block', { name: askedBy.name }),
  };
}

/**
 * Questions to the user about server list changes, so a page cannot bury the
 * user in them:
 *   - one open question per page; anything else that page asks meanwhile is
 *     dropped ('busy')
 *   - one dialog at a time, with only a few pages waiting their turn
 *   - a change the user said no to is not asked about again (until the app
 *     restarts), and the user can tell the app to ignore a server's requests
 *
 * ask(text) shows the dialog and resolves to { confirmed, block }. request()
 * resolves to 'confirmed', 'declined', 'busy' or 'blocked'. A dialog that
 * fails counts as a no.
 */
function createRequestGate({ ask: showQuestion, maxWaiting = 4, warn = console.warn }) {
  const asking = new Set();
  const declined = new Set();
  const blocked = new Set();
  let waiting = 0;
  let turn = Promise.resolve();

  async function answerOne({ requester, key, text }) {
    if (blocked.has(requester)) return 'blocked';
    if (declined.has(requester + '\n' + key)) return 'declined';
    let answer = null;
    try {
      answer = await showQuestion(text);
    } catch (err) {
      warn('[server-list] the question could not be shown; the change is not made:', err && err.message ? err.message : err);
      return 'declined';
    }
    if (answer && answer.block) blocked.add(requester);
    if (answer && answer.confirmed === true) return 'confirmed';
    declined.add(requester + '\n' + key);
    return 'declined';
  }

  return {
    isBlocked: (requester) => blocked.has(requester),
    request({ senderId, requester, key, text }) {
      if (blocked.has(requester)) return Promise.resolve('blocked');
      if (declined.has(requester + '\n' + key)) return Promise.resolve('declined');
      if (asking.has(senderId) || waiting >= maxWaiting) return Promise.resolve('busy');
      asking.add(senderId);
      waiting++;
      const mine = turn.then(() => answerOne({ requester, key, text }));
      // The next question waits for this one (answerOne never rejects).
      turn = mine;
      return mine.finally(() => {
        asking.delete(senderId);
        waiting--;
      });
    },
  };
}

module.exports = {
  safeText,
  displayName,
  planPageRequest,
  applyPageRequest,
  promptText,
  createRequestGate,
};
