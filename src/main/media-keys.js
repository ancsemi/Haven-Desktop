'use strict';

// The keyboard's media keys for Listen Together, Haven's shared music
// player. A global shortcut on a media key takes that key away from every
// other app, so main only holds them while a server page asks: the page asks
// while its shared player is playing (or was paused a moment ago) and the
// user may control it, and lets go otherwise. Each press goes to the server
// page that asked, preferring the one on screen. Kept out of main.js so it
// can be tested without Electron.

// Electron accelerator -> the action the page's player gets.
const MEDIA_KEY_ACTIONS = Object.freeze({
  MediaPlayPause: 'playpause',
  MediaNextTrack: 'nexttrack',
  MediaPreviousTrack: 'previoustrack',
});

const PAGE_ACTIONS = new Set(Object.values(MEDIA_KEY_ACTIONS));

/** The page action for an accelerator, or null for anything else. */
function mediaKeyAction(accel) {
  return Object.prototype.hasOwnProperty.call(MEDIA_KEY_ACTIONS, accel) ? MEDIA_KEY_ACTIONS[accel] : null;
}

/** Whether an action name from main is one the page world may run. */
function isMediaKeyAction(action) {
  return PAGE_ACTIONS.has(action);
}

/** A page's claim, read strictly: only `{ wanted: true }` asks for the keys. */
function claimWanted(payload) {
  return !!payload && typeof payload === 'object' && payload.wanted === true;
}

/**
 * Which server pages want the media keys. Pages are named by any key (main
 * uses the webContents id). set() and drop() return true when that changes
 * whether any page wants them.
 */
function createMediaKeyClaims() {
  const claims = new Map(); // key -> order of the claim
  let order = 0;
  return {
    set(key, wanted) {
      const before = claims.size > 0;
      if (wanted) {
        if (!claims.has(key)) claims.set(key, ++order);
      } else {
        claims.delete(key);
      }
      return before !== (claims.size > 0);
    },
    drop(key) {
      const before = claims.size > 0;
      claims.delete(key);
      return before !== (claims.size > 0);
    },
    wanted() {
      return claims.size > 0;
    },
    has(key) {
      return claims.has(key);
    },
    /** The page a press goes to: the one on screen if it asked, else the latest to ask. */
    target(activeKey) {
      if (activeKey != null && claims.has(activeKey)) return activeKey;
      let best = null;
      let bestOrder = -1;
      for (const [key, n] of claims) {
        if (n > bestOrder) { best = key; bestOrder = n; }
      }
      return best;
    },
  };
}

module.exports = { MEDIA_KEY_ACTIONS, mediaKeyAction, isMediaKeyAction, claimWanted, createMediaKeyClaims };
