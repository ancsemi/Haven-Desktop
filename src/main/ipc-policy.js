'use strict';

// Small rules for what a server page may ask of the app. Kept out of main.js
// so they can be tested without Electron.

const MODIFIERS = new Set([
  'commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'alt', 'option', 'altgr',
  'shift', 'meta', 'cmd', 'command', 'super',
]);
// Keys that put text into whatever app has focus. Space, Tab, Enter and
// Backspace count too: taking them away from every other app is as bad.
const TYPING_KEY_NAMES = new Set([
  'space', 'tab', 'enter', 'return', 'backspace', 'plus',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
]);

/**
 * True when an accelerator is a key that types, on its own or with only
 * Shift (Shift+A still types a letter). As a global shortcut it would take
 * that key away from every other app, or fire whenever the user types it.
 */
function isTypingKeyAccelerator(accel) {
  const parts = String(accel || '').split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(m => m.toLowerCase());
  if (mods.some(m => !MODIFIERS.has(m))) return false;
  if (mods.some(m => m !== 'shift')) return false;
  if (MODIFIERS.has(key.toLowerCase())) return false; // a lone modifier types nothing
  if ([...key].length === 1) return true;
  return TYPING_KEY_NAMES.has(key.toLowerCase());
}

/**
 * Shortcuts that act while their key is down and stop when it comes up: push
 * to talk in hold mode, and push to mute, which is always held. Only the input
 * hook takes these, and it only listens, so they may sit on a key that types
 * (V, Space): the key still reaches the game or whatever has focus.
 */
function isHoldShortcut(name, cfg) {
  if (name === 'ptm') return true;
  return name === 'ptt' && (cfg || {}).pttMode !== 'toggle';
}

/** A key that types is refused for every shortcut that is not a held one. */
function shortcutKeyRefused(cfg, name, accel) {
  return !!accel && isTypingKeyAccelerator(accel) && !isHoldShortcut(name, cfg);
}

/** The host a dialog names as the page asking, or '' when there is none. */
function dialogHost(serverUrl) {
  try { return new URL(String(serverUrl)).host; } catch { return ''; } // not a URL: no name
}

/** A server page's notification title, naming the server when it is not the
 *  one on screen so a hidden server cannot pass for another. */
function notificationTitle(title, { active, serverName }) {
  const text = String(title || 'Haven').slice(0, 200);
  if (active || !serverName) return text;
  return `${String(serverName).slice(0, 80)} · ${text}`;
}

// Browser permissions a page may be granted, by who asks:
//   any frame of a server page or its popups, embeds included: harmless
//   ones a browser grants without asking (an embedded video going full
//   screen or picture in picture, or asking for its media keys);
//   the server's own origin, page or popup: notifications, clipboard write;
//   the server page on screen, from its own origin: microphone and camera,
//   screen capture and the screen layout. A hidden server page never gets
//   the mic first; one that got it while shown (in a voice call) keeps it
//   for its own origin while hidden (requester.mediaOrigin), so switching
//   to another server does not cut the call. Screen capture stays
//   shown only.
const ANY_FRAME = new Set(['fullscreen', 'picture-in-picture', 'mediaKeySystem']);
const OWN_ORIGIN = new Set(['notifications', 'clipboard-write']);
const SHOWN_SERVER = new Set(['media', 'display-capture', 'window-management']);

/**
 * requester: null (unknown), { kind: 'local' } for the app's own screens,
 * { kind: 'server', origin, active, mediaOrigin } for a server view
 * (mediaOrigin: the origin it was granted the mic for while shown), or
 * { kind: 'popup', origin } for a window a server page opened.
 * requestingOrigin: the http(s) origin of the frame asking, or null.
 */
function permissionAllowed({ permission, requester, requestingOrigin }) {
  if (!requester) return false;
  if (requester.kind === 'local') return permission === 'fullscreen';
  if (requester.kind !== 'server' && requester.kind !== 'popup') return false;
  if (ANY_FRAME.has(permission)) return true;
  const ownOrigin = !!requester.origin && requestingOrigin === requester.origin;
  if (OWN_ORIGIN.has(permission)) return ownOrigin;
  if (!SHOWN_SERVER.has(permission) || !ownOrigin || requester.kind !== 'server') return false;
  if (requester.active === true) return true;
  return permission === 'media' && requester.mediaOrigin === requestingOrigin;

}

/**
 * Where a server page's top frame may go: 'stay' on its own server,
 * 'browser' for any other web address (opened in the system browser), or
 * 'block' for anything else, since other schemes handed to the OS can run
 * code (ms-msdt:, search-ms:, file: and network shares). Embedded players
 * (YouTube, Spotify, SoundCloud) load in frames, which this does not cover;
 * the page itself never becomes one of them.
 */
function serverNavigation(url, serverUrl) {
  let target;
  let server;
  try { target = new URL(String(url)); server = new URL(String(serverUrl)); }
  catch { return 'block'; } // not a URL: nowhere to go
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'block';
  return target.origin === server.origin ? 'stay' : 'browser';
}

// The same server saved twice, once as http:// and once as https://. The http
// one redirects to the https one, so a view of it can only end up off its own
// origin (Haven-Desktop #71).
function isHttpTwin(url, savedUrls) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:') return false;
    return savedUrls.some((other) => {
      try {
        const o = new URL(String(other));
        return o.protocol === 'https:' && o.hostname === u.hostname;
      } catch {
        return false; // an unreadable saved entry is nobody's twin
      }
    });
  } catch {
    return false; // not a URL: not a twin of anything
  }
}

// Single sign-on (OIDC) runs in the server page's own view: the server sends
// it to its identity provider and the provider sends it back. That is the one
// time a server view may show another site, and only along that path.
const SIGN_IN_START_PATH = '/api/auth/oidc/start';
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

/**
 * One server view's sign-in round trip. decide(target, serverUrl, { redirect })
 * answers like serverNavigation for each top frame navigation or redirect:
 *   - the page's own move to /api/auth/oidc/start opens the round trip;
 *   - the server's redirect from there names the provider and stays;
 *   - the provider's own pages stay;
 *   - coming back to the server closes it.
 * Going anywhere else, or taking longer than SIGN_IN_WINDOW_MS, closes it too.
 * While the view shows the provider, main refuses every call from the page,
 * because its trusted frame check wants the server's own origin.
 */
function createSignInRoundTrip({ now = Date.now, windowMs = SIGN_IN_WINDOW_MS } = {}) {
  let trip = null; // { openedAt, provider: origin or null }
  return {
    decide(target, serverUrl, { redirect = false } = {}) {
      const verdict = serverNavigation(target, serverUrl);
      if (trip && now() - trip.openedAt > windowMs) trip = null;
      if (verdict === 'block') { trip = null; return 'block'; }
      const parsed = new URL(String(target));
      if (verdict === 'stay') {
        trip = parsed.pathname === SIGN_IN_START_PATH ? { openedAt: now(), provider: null } : null;
        return 'stay';
      }
      if (trip && !trip.provider && redirect) {
        trip.provider = parsed.origin;
        return 'stay';
      }
      if (trip && trip.provider === parsed.origin) return 'stay';
      trip = null;
      return 'browser';
    },
    isOpen() {
      if (trip && now() - trip.openedAt > windowMs) trip = null;
      return !!trip;
    },
  };
}

module.exports = {
  isTypingKeyAccelerator, isHoldShortcut, shortcutKeyRefused, dialogHost, notificationTitle, permissionAllowed, serverNavigation,
  createSignInRoundTrip, SIGN_IN_WINDOW_MS, isHttpTwin,
};



