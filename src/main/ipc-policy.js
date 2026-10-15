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

module.exports = { isTypingKeyAccelerator, dialogHost, notificationTitle };
