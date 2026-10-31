'use strict';

// The voice overlay: a small see-through window that stays above games and
// shows who is in your voice call, who is talking, and new chat messages from
// that call's channel. Server pages report what they see (app-page-world.js)
// and main shows the one you are in a call on. This file holds the rules
// that need no Electron, so they can be tested: what the settings may be,
// what a page's report may contain, and which report is shown.

const DEFAULT_OVERLAY_SETTINGS = Object.freeze({
  enabled: false,
  x: null,              // window position; null puts it in the top-left corner
  y: null,
  onlySpeaking: false,  // hide people who are not talking
  showMessages: true,   // show new messages from the voice call's channel
  scale: 1,
  opacity: 1,
});

const SCALES = [0.85, 1, 1.2, 1.4];
const OPACITIES = [1, 0.85, 0.7, 0.5];
const MESSAGE_SECONDS = 12;

const MAX_USERS = 50;
const MAX_MESSAGES = 10;
const MAX_NAME = 64;
const MAX_CHANNEL_NAME = 100;
const MAX_CONTENT = 300;

// A role color the overlay may paint with. Anything else (gradients, url(),
// expressions) is dropped so a page cannot style the overlay.
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/i;

function safeColor(value) {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim() : null;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** The overlay settings from the store, with anything unknown or broken reset. */
function normalizeOverlaySettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: s.enabled === true,
    x: finiteOrNull(s.x),
    y: finiteOrNull(s.y),
    onlySpeaking: s.onlySpeaking === true,
    showMessages: s.showMessages !== false,
    scale: SCALES.includes(s.scale) ? s.scale : DEFAULT_OVERLAY_SETTINGS.scale,
    opacity: OPACITIES.includes(s.opacity) ? s.opacity : DEFAULT_OVERLAY_SETTINGS.opacity,
  };
}

/** An avatar the overlay may load: an http(s) URL on the reporting server. */
function sameOriginImage(value, serverOrigin) {
  if (typeof value !== 'string' || !serverOrigin) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin === serverOrigin ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A server page's report, cut down to what the overlay shows. Returns null
 * for anything that is not a report. The page is the server's code, so every
 * field is checked: types, lengths, colors, and avatars only from that server.
 */
function sanitizeVoiceReport(raw, serverOrigin) {
  if (!raw || typeof raw !== 'object') return null;
  const inVoice = raw.inVoice === true;
  const users = !inVoice || !Array.isArray(raw.users) ? [] : raw.users.slice(0, MAX_USERS)
    .filter(u => u && typeof u === 'object')
    .map(u => ({
      id: text(String(u.id ?? ''), 64),
      name: text(u.name, MAX_NAME) || '?',
      color: safeColor(u.color),
      avatar: sameOriginImage(u.avatar, serverOrigin),
      isSelf: u.isSelf === true,
      isBot: u.isBot === true,
      talking: u.talking === true,
      muted: u.muted === true,
      deafened: u.deafened === true,
    }));
  const messages = !inVoice || !Array.isArray(raw.messages) ? [] : raw.messages.slice(-MAX_MESSAGES)
    .filter(m => m && typeof m === 'object' && Number.isFinite(m.seq))
    .map(m => ({
      seq: m.seq,
      name: text(m.name, MAX_NAME) || '?',
      color: safeColor(m.color),
      content: text(m.content, MAX_CONTENT),
    }));
  return {
    inVoice,
    channelName: inVoice ? text(raw.channelName, MAX_CHANNEL_NAME) : '',
    users,
    messages,
  };
}

/**
 * The reports from every server page, by any key (main uses the webContents
 * id). shown() is the one to draw: the page on screen if it is in a call,
 * else any page that is, else nothing.
 */
function createVoiceReports() {
  const reports = new Map();
  return {
    set(key, report) {
      if (report) reports.set(key, report);
      else reports.delete(key);
    },
    drop(key) {
      reports.delete(key);
    },
    shown(activeKey) {
      const active = reports.get(activeKey);
      if (active && active.inVoice) return { key: activeKey, ...active };
      for (const [key, report] of reports) {
        if (report.inVoice) return { key, ...report };
      }
      return null;
    },
  };
}

/** Which side of its screen the overlay is on, so rows line up with that edge. */
function overlayAlignment(bounds, workArea) {
  if (!bounds || !workArea) return 'left';
  return bounds.x + bounds.width / 2 > workArea.x + workArea.width / 2 ? 'right' : 'left';
}

/** The window position for a corner of a work area. */
function cornerPosition(corner, workArea, size, margin = 24) {
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - size.width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - size.height - margin;
  switch (corner) {
    case 'top-right': return { x: right, y: top };
    case 'bottom-left': return { x: left, y: bottom };
    case 'bottom-right': return { x: right, y: bottom };
    default: return { x: left, y: top };
  }
}

module.exports = {
  DEFAULT_OVERLAY_SETTINGS, SCALES, OPACITIES, MESSAGE_SECONDS,
  safeColor, normalizeOverlaySettings, sanitizeVoiceReport, createVoiceReports,
  overlayAlignment, cornerPosition,
};
