// ═══════════════════════════════════════════════════════════
// Haven Desktop — App Window Preload
//
// Loaded when the Haven web app runs inside the desktop shell.
// Provides:
//  • Per-application audio capture during screen share
//  • Custom screen-share picker (windows + audio apps)
//  • Native desktop notifications
//  • Audio device enumeration & hot-switching
//  • Transparent getDisplayMedia() override (Haven's voice.js
//    calls the same API — our code intercepts and enhances it)
// ═══════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');
const { createTranslator } = require('../i18n');
const {
  SERVER_LOCALE_KEY,
  serverLocaleForDesktop,
  desktopLocaleForServer,
  reconcileLanguagePreferences,
} = require('../i18n/server-bridge');

let i18nState = ipcRenderer.sendSync('i18n:get-state-sync');
let translate = createTranslator(i18nState.locale);
let _lastNativeStatus = null;
let _lastShareModeInfo = null;

const nativeStorageSetItem = typeof Storage !== 'undefined' ? Storage.prototype.setItem : null;
const nativeStorageRemoveItem = typeof Storage !== 'undefined' ? Storage.prototype.removeItem : null;
let suppressServerLocaleSync = false;

// Whether the user clicked or typed in this page in the last few seconds.
// A server list question the user said no to is asked again only then (see
// server-list-gate.js). Read through the browser's own getter, kept here
// before any page script runs, so a page cannot fake it; when it cannot be
// read, the answer is no.
const userActedJustNow = (() => {
  try {
    const getter = Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive').get;
    const activation = navigator.userActivation;
    const apply = Reflect.apply;
    return () => apply(getter, activation, []) === true;
  } catch (err) {
    console.warn('[Haven Desktop] user activation is not available here', err?.message || err);
    return () => false;
  }
})();

/** What the app's server list question needs to know about a page's call:
 *  whether the page marked it as the user's own ({ user: true } in its
 *  options) and whether the user acted just now. */
function serverListAction(opts) {
  return { user: !!(opts && typeof opts === 'object' && opts.user === true), fresh: userActedJustNow() };
}

function readServerLocalePreference() {
  try { return window.localStorage.getItem(SERVER_LOCALE_KEY); }
  catch { return null; }
}

function writeServerLocalePreference(preference) {
  if (!nativeStorageSetItem) return false;
  try {
    suppressServerLocaleSync = true;
    nativeStorageSetItem.call(window.localStorage, SERVER_LOCALE_KEY, preference);
    return true;
  } catch {
    return false;
  } finally {
    suppressServerLocaleSync = false;
  }
}

function updatePreloadI18nState(state) {
  if (!state?.locale) return;
  i18nState = state;
  translate = createTranslator(state.locale);
}

function syncDesktopPreference(desktopPreference) {
  try {
    updatePreloadI18nState(ipcRenderer.sendSync('i18n:set-language-sync', desktopPreference));
  } catch {}
}

function syncDesktopFromServerPreference(serverPreference) {
  const desktopPreference = desktopLocaleForServer(serverPreference);
  if (desktopPreference) syncDesktopPreference(desktopPreference);
}

function syncServerFromDesktopPreference(state, reload) {
  const desired = serverLocaleForDesktop(state.preference);
  if (readServerLocalePreference() === desired) return false;
  if (!writeServerLocalePreference(desired)) return false;
  if (reload) {
    try { window.location.reload(); } catch {}
  }
  return true;
}

function isActiveServerView() {
  try { return !!ipcRenderer.sendSync('i18n:is-active-server-sync'); }
  catch { return false; }
}

if (nativeStorageSetItem && nativeStorageRemoveItem) {
  Storage.prototype.setItem = function (key, value) {
    const result = nativeStorageSetItem.call(this, key, value);
    if (!suppressServerLocaleSync && this === window.localStorage && key === SERVER_LOCALE_KEY) {
      syncDesktopFromServerPreference(String(value));
    }
    return result;
  };
  Storage.prototype.removeItem = function (key) {
    const result = nativeStorageRemoveItem.call(this, key);
    if (!suppressServerLocaleSync && this === window.localStorage && key === SERVER_LOCALE_KEY) {
      syncDesktopFromServerPreference('auto');
    }
    return result;
  };
}

function reconcileCurrentLanguagePreference(reload) {
  const serverPreference = readServerLocalePreference();
  const reconciliation = reconcileLanguagePreferences(i18nState, serverPreference, {
    isActive: isActiveServerView(),
  });
  if (reconciliation.action === 'update-server') {
    const persisted = writeServerLocalePreference(reconciliation.preference);
    if (persisted && reload) {
      try { window.location.reload(); } catch {}
    }
  } else if (reconciliation.action === 'update-desktop') {
    syncDesktopPreference(reconciliation.preference);
  }
  return reconciliation.action;
}

(function reconcileInitialLanguagePreference() {
  reconcileCurrentLanguagePreference(false);
})();

function t(key, values) {
  return translate(key, values);
}

function setI18nText(element, key, values, prefix = '', suffix = '') {
  if (!element) return;
  element.dataset.havenI18n = key;
  element.dataset.havenI18nValues = JSON.stringify(values || {});
  element.dataset.havenI18nPrefix = prefix;
  element.dataset.havenI18nSuffix = suffix;
  element.lang = i18nState.locale;
  element.textContent = `${prefix}${t(key, values)}${suffix}`;
}

function setI18nTitle(element, key, values) {
  if (!element) return;
  element.dataset.havenI18nTitle = key;
  element.dataset.havenI18nTitleValues = JSON.stringify(values || {});
  element.title = t(key, values);
}

function localizeMessageValues(values = {}) {
  const localized = { ...values };
  if (localized.modeKey) localized.mode = t(localized.modeKey);
  if (localized.reasonKey) {
    localized.reason = t(
      localized.reasonKey,
      localizeMessageValues(localized.reasonValues || {})
    );
  }
  return localized;
}

function localizeAudioStatus(status) {
  if (!status?.messageKey) return status;
  const values = localizeMessageValues(status.messageValues);
  return { ...status, message: t(status.messageKey, values), messageValues: values };
}

function localizeShareModeInfo(modeInfo) {
  if (!modeInfo?.detailKey) return modeInfo;
  const values = { ...(modeInfo.detailValues || {}) };
  if (modeInfo.detailReasonKey) {
    values.reason = t(
      modeInfo.detailReasonKey,
      localizeMessageValues(modeInfo.detailReasonValues || {})
    );
  } else if (modeInfo.detailReason) {
    values.reason = modeInfo.detailReason;
  }
  return { ...modeInfo, detail: t(modeInfo.detailKey, values) };
}

function dispatchShareModeInfo(modeInfo) {
  const localized = localizeShareModeInfo(modeInfo);
  window.__havenShareAudioMode = localized;
  window.dispatchEvent(new CustomEvent('haven:share-audio-mode', { detail: localized }));
}

function applyInjectedTranslations(root = document) {
  root.querySelectorAll?.('[data-haven-i18n-root]').forEach(element => {
    element.dir = i18nState.direction;
    element.lang = i18nState.locale;
  });
  root.querySelectorAll?.('[data-haven-i18n]').forEach(element => {
    let values = {};
    try { values = JSON.parse(element.dataset.havenI18nValues || '{}'); } catch {}
    const prefix = element.dataset.havenI18nPrefix || '';
    const suffix = element.dataset.havenI18nSuffix || '';
    element.lang = i18nState.locale;
    element.textContent = `${prefix}${t(element.dataset.havenI18n, values)}${suffix}`;
  });
  root.querySelectorAll?.('[data-haven-i18n-title]').forEach(element => {
    let values = {};
    try { values = JSON.parse(element.dataset.havenI18nTitleValues || '{}'); } catch {}
    element.title = t(element.dataset.havenI18nTitle, values);
  });
}

ipcRenderer.on('i18n:changed', (_event, state) => {
  updatePreloadI18nState(state);
  applyInjectedTranslations();
  if (_lastNativeStatus) _lastNativeStatus = localizeAudioStatus(_lastNativeStatus);
  if (_lastShareModeInfo) dispatchShareModeInfo(_lastShareModeInfo);
  window.dispatchEvent(new CustomEvent('haven-desktop-language-changed', { detail: { ...state } }));
});

ipcRenderer.on('i18n:sync-server-preference', (_event, state) => {
  updatePreloadI18nState(state);
  syncServerFromDesktopPreference(state, true);
});

ipcRenderer.on('i18n:became-active', (_event, state) => {
  updatePreloadI18nState(state);
  reconcileCurrentLanguagePreference(true);
  reportServerLanguageState();
});

let lastReportedServerLanguage = '';
function reportServerLanguageState() {
  const serverI18n = window.i18n;
  if (!serverI18n) return;
  const preference = String(serverI18n.preference || readServerLocalePreference() || 'auto');
  const locale = String(serverI18n.locale || document.documentElement?.lang || '');
  if (!locale) return;
  const signature = `${preference}:${locale}`;
  if (signature === lastReportedServerLanguage) return;
  lastReportedServerLanguage = signature;
  ipcRenderer.send('i18n:server-state', { preference, locale });
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(reportServerLanguageState, 0);
  setTimeout(reportServerLanguageState, 500);
  setTimeout(reportServerLanguageState, 2000);
  if (document.documentElement && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(reportServerLanguageState);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
});
document.addEventListener('haven:localechange', reportServerLanguageState);
window.addEventListener('languagechange', () => {
  if (i18nState.preference === 'auto') {
    ipcRenderer.invoke('i18n:refresh-automatic').catch(() => {});
  }
});
const { BoundedPcmRing, shouldDropAudioPacket } = require('./screen-share-audio');
const { checkServer } = require('./server-check');
const {
  normalizeVideoEncoderPreference,
  getAvailableVideoEncoderPreferences,
  applyVideoEncoderPreference,
} = require('./screen-share-video');

const _displayVideoTracks = new WeakSet();
const _screenShareTransceivers = new WeakMap();
const _encoderStatsTimers = new WeakMap();
const _encoderStatsGenerations = new WeakMap();
let _activeDisplayVideoTrack = null;
// Latch for the GPU-confirmed badge. Every viewer peer reports its own stats
// on its own timer and they all write to the same badge (last-wins), so once
// any negotiated report proves hardware encoding for the current screen track
// the badge stays confirmed until the track ends — instead of flickering
// between confirmed/software as competing peer reports land.
let _gpuConfirmedTrack = null;
let _videoEncoderConfig = {
  preference: 'hardware',
  hardwareAvailable: false,
  hardwareStatus: 'unavailable',
};

function videoEncoderLabel(preference) {
  return {
    auto: t('screenPicker.automaticEncoder'),
    hardware: t('screenPicker.hardwareH264'),
    h264: 'H.264',
    vp8: 'VP8',
    vp9: 'VP9',
    av1: 'AV1',
    h265: 'H.265 / HEVC',
  }[preference] || preference;
}

function publishVideoEncoderStatus(status) {
  const detail = { ...status, timestamp: Date.now() };
  window.__havenShareVideoEncoder = detail;
  window.dispatchEvent(new CustomEvent('haven:share-video-encoder', { detail }));

  if (!document.body) return;
  let badge = document.getElementById('haven-video-encoder-status');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'haven-video-encoder-status';
    badge.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
      'padding:7px 10px', 'border-radius:7px', 'background:rgba(17,20,31,.94)',
      'border:1px solid rgba(128,105,232,.55)', 'color:#ddd',
      'font:12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 6px 22px rgba(0,0,0,.35)', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(badge);
  }

  if (status.powerEfficientEncoder === true && status.track) {
    _gpuConfirmedTrack = status.track;
  }
  const gpuLatched = !!_gpuConfirmedTrack &&
    _gpuConfirmedTrack.readyState === 'live' &&
    _gpuConfirmedTrack === _activeDisplayVideoTrack;
  if (!gpuLatched && _gpuConfirmedTrack?.readyState !== 'live') _gpuConfirmedTrack = null;
  const codec = status.mimeType?.replace(/^video\//i, '').toUpperCase()
    || videoEncoderLabel(status.preference);
  let acceleration = t('screenEncoder.browserManaged');
  if (gpuLatched || status.powerEfficientEncoder === true) {
    acceleration = t('screenEncoder.gpuConfirmed');
  }
  else if (status.powerEfficientEncoder === false) acceleration = t('screenEncoder.software');
  else if (status.hardwareAvailable && codec.includes('H264')) {
    acceleration = t('screenEncoder.gpuPending');
  } else if (!status.hardwareAvailable && status.preference === 'hardware') {
    acceleration = t('screenEncoder.gpuUnavailable');
  }

  badge.textContent = t('screenEncoder.status', { codec, acceleration });
  badge.title = [
    status.encoderImplementation,
    status.sdpFmtpLine,
    status.reason,
  ].filter(Boolean).join(' • ');
}

function clearVideoEncoderStatus() {
  document.getElementById('haven-video-encoder-status')?.remove();
  window.__havenShareVideoEncoder = null;
  _gpuConfirmedTrack = null;
}

function configureScreenShareTransceiver(track, transceiver) {
  if (!transceiver || transceiver.stopped) return;

  // Only screen-share video transceivers are ever configured. Relay and
  // voice transceivers share this prototype hook, so anything that is not a
  // live display video track is left completely untouched.
  if (track?.kind && track.kind !== 'video') return;

  if (!_displayVideoTracks.has(track) || track.readyState !== 'live') {
    if (_screenShareTransceivers.has(transceiver)) {
      try { transceiver.setCodecPreferences([]); } catch {}
      _screenShareTransceivers.delete(transceiver);
    }
    return;
  }

  const codecs = window.RTCRtpSender?.getCapabilities?.('video')?.codecs;
  const preference = normalizeVideoEncoderPreference(_videoEncoderConfig.preference);
  const result = applyVideoEncoderPreference(
    transceiver,
    codecs,
    preference,
    _videoEncoderConfig.hardwareAvailable
  );

  if (result.applied) {
    _screenShareTransceivers.set(transceiver, { ...result, track });
    publishVideoEncoderStatus({
      phase: 'requested',
      ...result,
      hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
      hardwareStatus: _videoEncoderConfig.hardwareStatus,
    });
    console.log(`[Haven Desktop] screen encoder requested: ${preference}`);
  } else {
    if (_screenShareTransceivers.has(transceiver)) {
      try { transceiver.setCodecPreferences([]); } catch {}
      _screenShareTransceivers.delete(transceiver);
    }
    publishVideoEncoderStatus({
      phase: 'fallback',
      preference,
      reason: result.reason,
      hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
      hardwareStatus: _videoEncoderConfig.hardwareStatus,
    });
  }
}

async function reportNegotiatedScreenEncoder(peer) {
  let hasLiveScreenTrack = false;
  let reported = false;
  for (const transceiver of peer.getTransceivers()) {
    const encoderState = _screenShareTransceivers.get(transceiver);
    if (!encoderState) continue;
    const track = transceiver.sender.track;
    if (track?.readyState !== 'live' || track !== _activeDisplayVideoTrack) {
      if (_screenShareTransceivers.get(transceiver) === encoderState) {
        _screenShareTransceivers.delete(transceiver);
      }
      continue;
    }
    hasLiveScreenTrack = true;
    try {
      const stats = await transceiver.sender.getStats();
      if (_screenShareTransceivers.get(transceiver) !== encoderState) continue;
      if (track.readyState !== 'live' || transceiver.sender.track !== track) {
        _screenShareTransceivers.delete(transceiver);
        continue;
      }
      const entries = [...stats.values()];
      const outbound = entries.find(stat =>
        stat.type === 'outbound-rtp'
        && (stat.kind === 'video' || stat.mediaType === 'video')
      );
      const codec = entries.find(stat => stat.id === outbound?.codecId);
      if (!outbound || !codec) continue;
      publishVideoEncoderStatus({
        phase: 'negotiated',
        preference: encoderState.preference,
        track,
        mimeType: codec.mimeType,
        sdpFmtpLine: codec.sdpFmtpLine || '',
        encoderImplementation: outbound.encoderImplementation || null,
        powerEfficientEncoder: outbound.powerEfficientEncoder,
        hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
        hardwareStatus: _videoEncoderConfig.hardwareStatus,
        frameWidth: outbound.frameWidth,
        frameHeight: outbound.frameHeight,
        framesPerSecond: outbound.framesPerSecond,
      });
      console.log(
        `[Haven Desktop] negotiated screen encoder: ${codec.mimeType}`,
        outbound.encoderImplementation || ''
      );
      reported = true;
    } catch (error) {
      console.warn('[Haven Desktop] screen encoder stats unavailable:', error.message);
    }
  }
  if (!hasLiveScreenTrack && _activeDisplayVideoTrack?.readyState !== 'live') {
    clearVideoEncoderStatus();
  }
  return { hasLiveScreenTrack, reported };
}

function scheduleScreenEncoderReport(peer, attempt = 0, generation = null) {
  if (generation === null) {
    generation = (_encoderStatsGenerations.get(peer) || 0) + 1;
    _encoderStatsGenerations.set(peer, generation);
  }
  if (_encoderStatsGenerations.get(peer) !== generation) return;
  const previousTimer = _encoderStatsTimers.get(peer);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(async () => {
    _encoderStatsTimers.delete(peer);
    const result = await reportNegotiatedScreenEncoder(peer);
    if (_encoderStatsGenerations.get(peer) !== generation) return;
    if (result.hasLiveScreenTrack && !result.reported && attempt < 15) {
      scheduleScreenEncoderReport(peer, attempt + 1, generation);
    }
  }, attempt === 0 ? 500 : 2000);
  _encoderStatsTimers.set(peer, timer);
}

function installScreenShareEncodingOverride() {
  if (!window.RTCPeerConnection || !window.RTCRtpSender) return false;

  const peerPrototype = window.RTCPeerConnection.prototype;
  const originalAddTrack = peerPrototype.addTrack;
  const originalAddTransceiver = peerPrototype.addTransceiver;
  const originalCreateOffer = peerPrototype.createOffer;
  const originalCreateAnswer = peerPrototype.createAnswer;
  const originalSetRemoteDescription = peerPrototype.setRemoteDescription;
  const trackPrototype = window.MediaStreamTrack?.prototype;
  const originalTrackStop = trackPrototype?.stop;

  function configureTransceivers(peer) {
    // Scope the hook to transceivers carrying the live screen track. The
    // override patches every RTCPeerConnection in the page, including the
    // relay's, so iterating blindly would reset or re-preference
    // transceivers that have nothing to do with screen sharing.
    for (const transceiver of peer.getTransceivers()) {
      const track = transceiver?.sender?.track;
      if (!track || track.readyState !== 'live' || !_displayVideoTracks.has(track)) continue;
      configureScreenShareTransceiver(track, transceiver);
    }
  }

  peerPrototype.addTrack = function (track, ...streams) {
    const sender = originalAddTrack.call(this, track, ...streams);
    const transceiver = this.getTransceivers().find(item => item.sender === sender);
    configureScreenShareTransceiver(track, transceiver);
    return sender;
  };

  peerPrototype.addTransceiver = function (trackOrKind, init) {
    const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
    if (typeof trackOrKind !== 'string') {
      configureScreenShareTransceiver(trackOrKind, transceiver);
    }
    return transceiver;
  };

  peerPrototype.createOffer = function (...args) {
    configureTransceivers(this);
    return originalCreateOffer.apply(this, args);
  };

  peerPrototype.createAnswer = function (...args) {
    configureTransceivers(this);
    return originalCreateAnswer.apply(this, args);
  };

  peerPrototype.setRemoteDescription = function (...args) {
    const operation = originalSetRemoteDescription.apply(this, args);
    if (!operation?.then) return operation;
    return operation.then(result => {
      scheduleScreenEncoderReport(this);
      return result;
    });
  };

  if (trackPrototype && originalTrackStop) {
    trackPrototype.stop = function (...args) {
      const isDisplayTrack = _displayVideoTracks.has(this);
      const result = originalTrackStop.apply(this, args);
      if (isDisplayTrack && _activeDisplayVideoTrack === this) {
        _displayVideoTracks.delete(this);
        _activeDisplayVideoTrack = null;
        clearVideoEncoderStatus();
      }
      return result;
    };
  }

  return true;
}

if (!installScreenShareEncodingOverride()) {
  window.addEventListener('DOMContentLoaded', installScreenShareEncodingOverride, { once: true });
}

// Mark the document as running inside the Electron shell.
// This lets CSS override responsive breakpoints that would otherwise
// hide desktop UI elements (e.g. the status bar) on narrow windows.
// Try to set it immediately (document.documentElement exists in modern
// Electron even before parsing).  Fall back to DOMContentLoaded if not.
if (document.documentElement) {
  document.documentElement.setAttribute('data-desktop-app', '1');
} else {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('data-desktop-app', '1');
  }, { once: true });
}

// Paint the native window from the page palette so Matrix, Braid, Compact
// and the rest match the chrome, not only the webview.
let lastTheme = '';
function syncTheme() {
  try {
    const root = document.documentElement;
    let theme = root.getAttribute('data-theme') || '';
    const saved = localStorage.getItem('haven-theme') || localStorage.getItem('haven_theme') || '';
    if (saved.startsWith('file:')) theme = saved.slice(5).replace(/\.css$/i, '');
    const cs = getComputedStyle(root);
    const bg = (cs.getPropertyValue('--bg-primary') || '').trim();
    const accent = (cs.getPropertyValue('--accent') || '').trim();
    const key = theme + '|' + bg + '|' + accent;
    if (key === lastTheme) return;
    lastTheme = key;
    ipcRenderer.send('theme:colors', { theme, bg, accent });
  } catch {}
}
function watchTheme() {
  const root = document.documentElement;
  if (!root) return false;
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  syncTheme();
  return true;
}
if (!watchTheme()) window.addEventListener('DOMContentLoaded', watchTheme, { once: true });
window.addEventListener('load', () => { syncTheme(); setTimeout(syncTheme, 1500); });
window.addEventListener('storage', syncTheme);

function injectBraidDesktopCss() {
  if (document.getElementById('haven-desktop-braid-gap')) return;
  const el = document.createElement('style');
  el.id = 'haven-desktop-braid-gap';
  el.textContent = 'html[data-braid-layout="1"][data-desktop-app]{--thread-footer-offset:0px}'
    + 'html[data-braid-layout="1"][data-desktop-app] .status-bar,'
    + 'html[data-braid-layout="1"][data-desktop-app] #status-bar{display:none!important;height:0!important;min-height:0!important;padding:0!important;border:0!important;overflow:hidden!important}'
    + 'html[data-braid-layout="1"].braid-status-open[data-desktop-app] .status-bar,'
    + 'html[data-braid-layout="1"].braid-status-open[data-desktop-app] #status-bar{display:flex!important;height:auto!important;min-height:1.75rem!important;padding:.3125rem 1rem!important;overflow:visible!important}'
    + 'html[data-braid-layout="1"] #app-body{flex:1 1 auto!important;height:auto!important;min-height:0}';
  (document.head || document.documentElement).appendChild(el);
}
if (document.head) injectBraidDesktopCss();
else window.addEventListener('DOMContentLoaded', injectBraidDesktopCss, { once: true });
// ═══════════════════════════════════════════════════════════
// JavaScript Dialog Overrides for BrowserView (issue #6)
//
// Electron's BrowserView doesn't natively support prompt(),
// confirm(), or alert(). Override them with IPC calls to the
// main process which shows OS-native dialogs.
// ═══════════════════════════════════════════════════════════

// ── Dialog overrides (confirm / alert / prompt) ───────────
// BrowserView doesn't support native browser dialogs.  We forward them
// to the main process via sendSync, which blocks the renderer while the
// OS dialog is visible.  This is intentionally synchronous — confirm()
// and prompt() are modal by spec and callers expect a return value.
//
// The main process focuses the app window before showing the dialog, so
// it can't appear behind the app on multi-monitor setups (which would
// make it impossible to dismiss and freeze the UI forever).

window.prompt = (message, defaultValue) => {
  return ipcRenderer.sendSync('dialog:prompt', {
    message: message || '',
    defaultValue: defaultValue || '',
  });
};

window.confirm = (message) => {
  return ipcRenderer.sendSync('dialog:confirm', { message: message || '' });
};

window.alert = (message) => {
  ipcRenderer.sendSync('dialog:alert', { message: message || '' });
};

// ─── Clear any stale voice-channel state on fresh page load ──────────────
// Without this, closing the app while in voice leaves haven_voice_channel in
// localStorage, causing the web app to think the user is already in voice on
// the next launch, which prevents rejoining until they manually "leave" first.
window.addEventListener('DOMContentLoaded', () => {
  try { localStorage.removeItem('haven_voice_channel'); } catch {}
});

// ─── Desktop Status Bar — guaranteed visible ─────────────────────────────
// The server's responsive CSS hides #status-bar at narrow viewport widths
// (for mobile).  Windows DPI scaling can shrink the BrowserView's CSS
// viewport below that threshold.  We solve this by injecting a fixed-position
// bar at the bottom of the page from the preload — entirely independent of
// the server's CSS layout.  We clone the server bar's live text nodes so
// the data (ping, version, channel, online count) stays in sync.
window.addEventListener('DOMContentLoaded', () => {
  // Inject the CSS once
  const css = document.createElement('style');
  css.textContent = `
    /* Switch Server button on login page — fixed above the status bar */
    #haven-switch-server-btn {
      position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
      z-index: 9998; padding: 8px 24px;
      background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #444); border-radius: 8px;
      color: var(--text-secondary, #aaa); font-size: 13px; cursor: pointer; transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    #haven-switch-server-btn:hover {
      background: var(--bg-hover, rgba(255,255,255,0.08));
      color: var(--text-primary, #fff); border-color: var(--accent, #6b4fdb);
    }

    /* Server Picker Overlay */
    #haven-server-picker-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7); z-index: 99999;
      display: flex; align-items: center; justify-content: center;
    }
    #haven-server-picker {
      background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #444);
      border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw;
      max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    #haven-server-picker h3 {
      margin: 0 0 16px; color: var(--text-primary, #fff); font-size: 18px; text-align: center;
    }
    .hsp-form { display: flex; gap: 8px; }
    .hsp-form input {
      flex: 1; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border, #444);
      background: var(--bg-primary, #0d0d1a); color: var(--text-primary, #fff); font-size: 13px; outline: none;
    }
    .hsp-form input:focus { border-color: var(--accent, #6b4fdb); }
    .hsp-form button {
      padding: 8px 16px; border-radius: 6px; border: none;
      background: var(--accent, #6b4fdb); color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap;
    }
    .hsp-form button:hover { opacity: 0.9; }
    .hsp-form button:disabled { opacity: 0.5; cursor: default; }
    .hsp-error { color: #ef4444; font-size: 12px; margin-top: 8px; text-align: center; }
    .hsp-divider-label {
      color: var(--text-muted, #666); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.5px; margin: 16px 0 8px; padding-bottom: 4px;
      border-bottom: 1px solid var(--border, #333);
    }
    .hsp-server-item {
      display: flex; align-items: center; padding: 8px 10px; border-radius: 6px;
      cursor: pointer; transition: background 0.15s;
    }
    .hsp-server-item:hover { background: var(--bg-hover, rgba(255,255,255,0.05)); }
    .hsp-server-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .hsp-server-name {
      color: var(--text-primary, #fff); font-size: 13px; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hsp-server-url-label {
      color: var(--text-muted, #666); font-size: 11px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .hsp-remove-btn {
      background: transparent; border: none; color: var(--text-muted, #666);
      font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px; line-height: 1;
    }
    .hsp-remove-btn:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
    .hsp-cancel {
      display: block; width: 100%; margin-top: 16px; padding: 8px;
      background: transparent; border: 1px solid var(--border, #444); border-radius: 6px;
      color: var(--text-secondary, #aaa); font-size: 13px; cursor: pointer;
    }
    .hsp-cancel:hover { background: var(--bg-hover, rgba(255,255,255,0.05)); }
    .hsp-current-badge {
      font-size: 9px; color: var(--accent, #6b4fdb); text-transform: uppercase;
      letter-spacing: 0.5px; font-weight: 600;
    }
  `;
  document.head.appendChild(css);

  function _normalizeDesktopServerUrl(input = window.location.href) {
    let value = String(input || '').trim();
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

  // ── Update server name in history from the server ──
  // The same name the server rail shows (the health check), so the server
  // picker and every page agree. "Haven" is the default for a server that
  // never set one, which says less than its address. A name the user chose
  // is kept by the main process.
  const _serverUrl = _normalizeDesktopServerUrl();
  fetch('/api/health').then(r => r.json()).then(d => {
    const name = typeof d?.name === 'string' ? d.name.trim() : '';
    if (name && name !== 'Haven') {
      ipcRenderer.invoke('server-history:update-name', _serverUrl, name);
    }
  }).catch((err) => { console.warn('[Haven Desktop] could not read this server name', err?.message || err); });

  // ── Login Page: Server Picker (desktop only) ─────────────────────────
  if (document.querySelector('.auth-page')) {
    const authContainer = document.querySelector('.auth-container');
    if (authContainer) {
      // Inject "Switch Server" button fixed to bottom of viewport
      const switchBtn = document.createElement('button');
      switchBtn.id = 'haven-switch-server-btn';
      setI18nText(switchBtn, 'serverPicker.switch', null, '⬡ ');
      document.body.appendChild(switchBtn);

      // Build the server picker overlay
      const overlay = document.createElement('div');
      overlay.id = 'haven-server-picker-overlay';
      overlay.dataset.havenI18nRoot = '';
      overlay.dir = i18nState.direction;
      overlay.lang = i18nState.locale;
      overlay.style.display = 'none';
      overlay.innerHTML = `
        <div id="haven-server-picker">
          <h3 data-haven-i18n="serverPicker.switch">${t('serverPicker.switch')}</h3>
          <div class="hsp-form">
            <input type="text" id="hsp-url-input" placeholder="https://haven.example.com" spellcheck="false" autocomplete="off">
            <button id="hsp-connect-btn" data-haven-i18n="serverPicker.connect">${t('serverPicker.connect')}</button>
          </div>
          <div id="hsp-error" class="hsp-error" style="display:none"></div>
          <div id="hsp-recent-section" style="display:none">
            <div class="hsp-divider-label" data-haven-i18n="serverPicker.recent">${t('serverPicker.recent')}</div>
            <div id="hsp-recent-list"></div>
          </div>
          <button id="hsp-cancel-btn" class="hsp-cancel" data-haven-i18n="serverPicker.cancel">${t('serverPicker.cancel')}</button>
        </div>
      `;
      document.body.appendChild(overlay);

      // Show overlay
      switchBtn.addEventListener('click', async () => {
        overlay.style.display = 'flex';
        document.getElementById('hsp-url-input').value = '';
        document.getElementById('hsp-error').style.display = 'none';
        document.getElementById('hsp-url-input').focus();
        await loadRecentServers();
      });

      // Close overlay
      document.getElementById('hsp-cancel-btn').addEventListener('click', () => {
        overlay.style.display = 'none';
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });

      // Connect to entered URL
      const urlInput = document.getElementById('hsp-url-input');
      const connectBtn = document.getElementById('hsp-connect-btn');
      const errorEl = document.getElementById('hsp-error');

      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !connectBtn.disabled) connectBtn.click();
      });

      connectBtn.addEventListener('click', async () => {
        let url = urlInput.value.trim();
        errorEl.style.display = 'none';
        if (!url) return;

        url = _normalizeDesktopServerUrl(url);
        if (!url || !/^https?:\/\//i.test(url)) {
          setI18nText(errorEl, 'serverPicker.error.invalidUrl');
          errorEl.style.display = 'block';
          return;
        }

        connectBtn.disabled = true;
        setI18nText(connectBtn, 'serverPicker.connecting');

        try {
          // The same check as the Join screen, so a new server's own
          // certificate is asked about instead of refused (#62).
          const check = await checkServer(url, {
            fetch: (...args) => fetch(...args),
            begin: (u) => ipcRenderer.invoke('server-check:begin', u),
            questionPending: (u) => ipcRenderer.invoke('server-check:question-pending', u),
            waitForTrust: (u) => ipcRenderer.invoke('server-check:wait-for-trust', u),
          });

          if (!check.ok) {
            setI18nText(errorEl, 'serverPicker.error.unreachable');
            errorEl.style.display = 'block';
            return;
          }

          ipcRenderer.send('nav:change-primary-server', check.url, serverListAction({ user: true }));
        } catch {
          setI18nText(errorEl, 'serverPicker.error.connectionFailed');
          errorEl.style.display = 'block';
        } finally {
          connectBtn.disabled = false;
          setI18nText(connectBtn, 'serverPicker.connect');
        }
      });

      // Load and display recent servers
      async function loadRecentServers() {
        const history = await ipcRenderer.invoke('server-history:get');
        const recentSection = document.getElementById('hsp-recent-section');
        const recentList = document.getElementById('hsp-recent-list');
        const currentUrl = _normalizeDesktopServerUrl();

        // Filter out the server we're currently on
        const filtered = (history || []).filter(h => _normalizeDesktopServerUrl(h.url) !== currentUrl);
        if (filtered.length === 0) {
          recentSection.style.display = 'none';
          return;
        }

        recentSection.style.display = 'block';
        recentList.innerHTML = '';

        // Sort by lastConnected descending (most recent first)
        filtered.sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));

        filtered.forEach(entry => {
          const item = document.createElement('div');
          item.className = 'hsp-server-item';

          const info = document.createElement('div');
          info.className = 'hsp-server-info';

          let displayName;
          try {
            displayName = (entry.name && entry.name !== entry.url) ? entry.name : new URL(entry.url).hostname;
          } catch {
            displayName = entry.url;
          }

          const nameSpan = document.createElement('span');
          nameSpan.className = 'hsp-server-name';
          nameSpan.textContent = displayName;
          const urlSpan = document.createElement('span');
          urlSpan.className = 'hsp-server-url-label';
          urlSpan.textContent = entry.url;
          info.appendChild(nameSpan);
          info.appendChild(urlSpan);
          info.addEventListener('click', () => {
            ipcRenderer.send('nav:change-primary-server', entry.url, serverListAction({ user: true }));
          });

          const removeBtn = document.createElement('button');
          removeBtn.className = 'hsp-remove-btn';
          removeBtn.textContent = '\u00d7';
          setI18nTitle(removeBtn, 'serverPicker.removeHistory');
          removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await ipcRenderer.invoke('server-history:remove', entry.url, serverListAction({ user: true }));
            await loadRecentServers();
          });

          item.appendChild(info);
          item.appendChild(removeBtn);
          recentList.appendChild(item);
        });
      }
    }
  }

});

// ═══════════════════════════════════════════════════════════
// HTML5 Fullscreen API Override
//
// BrowserView does not support the HTML5 Fullscreen API.
// requestFullscreen() silently resolves but the element never
// actually enters DOM fullscreen state — :fullscreen CSS never
// applies and the visual doesn't change.  We implement fullscreen
// entirely manually: a CSS class for visual fullscreen + IPC to
// toggle the Electron window's native fullscreen.
// ═══════════════════════════════════════════════════════════

(function patchFullscreen() {
  let _fullscreenEl = null;

  // Inject the CSS that makes our manual fullscreen work.
  // Deferred to DOMContentLoaded because the preload runs before <head> exists.
  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .haven-manual-fullscreen {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: unset !important;
        max-height: unset !important;
        z-index: 2147483647 !important;
        background: #000 !important;
        object-fit: contain !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        border-radius: 0 !important;
      }
    `;
    document.head.appendChild(style);
  }
  if (document.head) injectStyle();
  else window.addEventListener('DOMContentLoaded', injectStyle, { once: true });

  function enterFullscreen(el) {
    if (_fullscreenEl) exitFullscreen();
    _fullscreenEl = el;
    el.classList.add('haven-manual-fullscreen');
    ipcRenderer.send('window:enter-fullscreen');
    document.dispatchEvent(new Event('fullscreenchange'));
  }

  function exitFullscreen() {
    if (_fullscreenEl) {
      _fullscreenEl.classList.remove('haven-manual-fullscreen');
      _fullscreenEl = null;
    }
    ipcRenderer.send('window:leave-fullscreen');
    document.dispatchEvent(new Event('fullscreenchange'));
  }

  // Override requestFullscreen
  Element.prototype.requestFullscreen = function () {
    enterFullscreen(this);
    return Promise.resolve();
  };
  if (Element.prototype.webkitRequestFullscreen) {
    Element.prototype.webkitRequestFullscreen = function () {
      enterFullscreen(this);
    };
  }

  // Override exitFullscreen
  Document.prototype.exitFullscreen = function () {
    exitFullscreen();
    return Promise.resolve();
  };

  // Override document.fullscreenElement getter
  Object.defineProperty(Document.prototype, 'fullscreenElement', {
    get() { return _fullscreenEl; },
    configurable: true,
  });
  Object.defineProperty(Document.prototype, 'webkitFullscreenElement', {
    get() { return _fullscreenEl; },
    configurable: true,
  });
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', {
    get() { return true; },
    configurable: true,
  });

  // Escape key exits fullscreen
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _fullscreenEl) {
      e.preventDefault();
      exitFullscreen();
    }
  }, true);
})();

// ─── Internal state ──────────────────────────────────────
let _audioWorkletNode    = null;
let _audioCtx            = null;
let _audioDestination    = null;
let _capturedAudioPid    = null;
let _activeAudioCaptureId = null;
let _activeShareId       = null;
let _pendingShareId      = null;
let _displayMediaPending = false;
let _audioBufferQueue    = [];
let _audioBufferedSamples = 0;
let _audioPacketsReceived = 0;
let _audioPreparationQueue = Promise.resolve();
const _cancelledAudioPreparations = new Set();
// ─── Global voice shortcut triggers ──────────────────────
ipcRenderer.on('voice:mute-toggle',   () => document.getElementById('voice-mute-btn')?.click());
ipcRenderer.on('voice:deafen-toggle', () => document.getElementById('voice-deafen-btn')?.click());
ipcRenderer.on('voice:ptt-toggle',    () => _pttToggleOnce('hook'));

// PTT hold mode (#184): main fires -down on key/mouse press and -up on
// release. We unmute on press and re-mute on release iff that state
// transition is needed — the mute button is a toggle, so we only click
// it when its current visual state doesn't match the desired one.
// The mic state is read from the app itself when it is there (window.app,
// the object Haven's client exposes), and only from the mute button's class
// when it is not. Each press and release is logged with the state it saw and
// what it did, so a report from someone whose hold mode misbehaves can show
// exactly where it stops: View, Toggle Developer Tools, then Console
// (Haven #5603, #38).
function _pttState() {
  const app = window.app || window._havenApp || null;
  const voice = app && app.voice;
  if (voice && typeof voice.isMuted === 'boolean') {
    return { app, isMuted: voice.isMuted, inVoice: !!voice.inVoice, source: 'app' };
  }
  const btn = document.getElementById('voice-mute-btn') || document.getElementById('voice-mute-btn-header');
  if (!btn) return null;
  const pressed = btn.getAttribute('aria-pressed');
  const isMuted = (pressed === 'true' || pressed === 'false')
    ? pressed === 'true'
    : (btn.classList.contains('muted') || btn.classList.contains('is-muted'));
  return { app, isMuted, inVoice: null, source: 'button', btn };
}
function _pttSetTalking(shouldTalk, via = 'key') {
  const s = _pttState();
  const edge = shouldTalk ? 'down' : 'up';
  if (!s) { console.log(`[PTT] ${via} ${edge}: no voice state on the page yet, ignored`); return; }
  // shouldTalk → want unmuted. Flip only when the state has to change, so
  // the input hook and the page's own key handler never fight.
  const needFlip = shouldTalk ? s.isMuted : !s.isMuted;
  console.log(`[PTT] ${via} ${edge}: muted=${s.isMuted} inVoice=${s.inVoice} via ${s.source}, ${needFlip ? 'toggling' : 'no change'}`);
  if (!needFlip) return;
  if (s.app && typeof s.app._toggleMute === 'function') {
    try { s.app._toggleMute(); return; } catch (err) { console.warn('[PTT] _toggleMute threw:', err); }
  }
  const btn = s.btn || document.getElementById('voice-mute-btn');
  if (btn) btn.click();
}
// Toggle mode: one press flips the mic. The global hook and the page's own
// key handler can both see the same press (or the hook sees none at all,
// as on Wayland), so a press within a quarter second of the last one is the
// same press and is ignored (Haven #5724).
let _pttLastToggle = 0;
function _pttToggleOnce(via) {
  const now = Date.now();
  if (now - _pttLastToggle < 250) { console.log(`[PTT] ${via} toggle: same press as the last one, ignored`); return; }
  _pttLastToggle = now;
  const s = _pttState();
  if (!s) { console.log(`[PTT] ${via} toggle: no voice state on the page yet, ignored`); return; }
  console.log(`[PTT] ${via} toggle: muted=${s.isMuted} inVoice=${s.inVoice} via ${s.source}`);
  if (s.app && typeof s.app._toggleMute === 'function') {
    try { s.app._toggleMute(); return; } catch (err) { console.warn('[PTT] _toggleMute threw:', err); }
  }
  const btn = s.btn || document.getElementById('voice-mute-btn');
  if (btn) btn.click();
}
ipcRenderer.on('voice:ptt-down', () => _pttSetTalking(true, 'hook'));
ipcRenderer.on('voice:ptt-up',   () => _pttSetTalking(false, 'hook'));

// ─── Hold-mode PTT while the Haven window itself is focused ──────────
// The native input hook in main drives PTT, but on Windows several people
// see hold mode go quiet while the Haven window is the focused one and work
// again the moment it is minimised or behind a game (Haven #5603, #38). When
// the page is focused it gets the key events itself, so the same binding is
// followed here as well. _pttSetTalking only clicks when the state has to
// flip, so whichever path fires second is a no-op, and the two never fight.
// Toggle mode is followed here too, through _pttToggleOnce, which drops the
// second sighting of one press. On Wayland the global hook gets nothing while
// Haven is focused, so without this the toggle key never worked there.
const _PTT_DOM_KEYS = {
  Space: ' ', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Return: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
const _PTT_LONE_MODS = {
  CommandOrControl: ['control', 'meta'], Control: ['control'], Ctrl: ['control'],
  Meta: ['meta'], Cmd: ['meta'], Super: ['meta'], Alt: ['alt'], Shift: ['shift'],
};
let _pttDomBinding = null;
let _pttDomToggle = false;
let _pttDomDown = false;
function _parsePttAccel(accel) {
  const mouse = /^Mouse(\d+)$/i.exec(accel || '');
  if (mouse) return { mouseButton: parseInt(mouse[1], 10) - 1 };
  const parts = String(accel || '').split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = { ctrl: false, alt: false, shift: false };
  for (const p of parts) {
    if (['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Meta', 'Cmd', 'Command', 'Super'].includes(p)) mods.ctrl = true;
    else if (p === 'Alt' || p === 'Option') mods.alt = true;
    else if (p === 'Shift') mods.shift = true;
    else return null;
  }
  const lone = _PTT_LONE_MODS[key];
  const keys = lone || [String(_PTT_DOM_KEYS[key] || key).toLowerCase()];
  return { mods, keys, lone: !!lone };
}
function _pttDomKeyMatches(e, b, isDown) {
  if (!b || b.mouseButton != null) return false;
  if (!b.keys.includes(String(e.key || '').toLowerCase())) return false;
  // The modifiers only have to be down on the press; by the release they
  // may already be up, and the release still has to count.
  if (!isDown || b.lone) return true;
  return (!b.mods.ctrl || e.ctrlKey || e.metaKey) && (!b.mods.alt || e.altKey) && (!b.mods.shift || e.shiftKey);
}
function _refreshPttDomBinding() {
  return ipcRenderer.invoke('shortcuts:get').then((cfg) => {
    _pttDomToggle = !!cfg && cfg.pttMode === 'toggle';
    _pttDomBinding = (cfg && cfg.ptt) ? _parsePttAccel(cfg.ptt) : null;
    if (!_pttDomBinding && _pttDomDown) { _pttDomDown = false; _pttSetTalking(false); }
  }).catch(() => { _pttDomBinding = null; });
}
window.addEventListener('keydown', (e) => {
  if (_pttDomToggle) {
    if (!e.repeat && _pttDomKeyMatches(e, _pttDomBinding, true)) _pttToggleOnce('page');
    return;
  }
  if (e.repeat || _pttDomDown || !_pttDomKeyMatches(e, _pttDomBinding, true)) return;
  _pttDomDown = true;
  _pttSetTalking(true);
}, true);
window.addEventListener('keyup', (e) => {
  if (!_pttDomDown || !_pttDomKeyMatches(e, _pttDomBinding, false)) return;
  _pttDomDown = false;
  _pttSetTalking(false);
}, true);
window.addEventListener('mousedown', (e) => {
  const b = _pttDomBinding;
  if (!b || b.mouseButton == null || e.button !== b.mouseButton) return;
  if (_pttDomToggle) { _pttToggleOnce('page'); return; }
  if (_pttDomDown) return;
  _pttDomDown = true;
  _pttSetTalking(true);
}, true);
window.addEventListener('mouseup', (e) => {
  const b = _pttDomBinding;
  if (!b || b.mouseButton == null || e.button !== b.mouseButton || !_pttDomDown) return;
  _pttDomDown = false;
  _pttSetTalking(false);
}, true);
window.addEventListener('DOMContentLoaded', () => { _refreshPttDomBinding(); });

// ─── Server badge state updates from main process ────────
ipcRenderer.on('server-badge-update', (_event, badgeMap) => {
  window.dispatchEvent(new CustomEvent('haven-server-badges', { detail: badgeMap }));
});

// The shared server list changed (a removal, rename, new order or server
// on any server page), so this page's sidebar can follow.
ipcRenderer.on('server-list:changed', () => {
  window.dispatchEvent(new CustomEvent('haven-server-list-changed'));
});

// ─── Forward server log messages to the browser console ──
ipcRenderer.on('server:log', (_event, msg) => {
  console.log('[Haven Server]', msg.trimEnd());
});

// ─── Receive PCM chunks from native addon (main process) ─
let _ipcDataCount = 0;
// Track latest native capture status reported by the addon. Lets the
// getDisplayMedia override abort its readiness wait early on hard failure
// instead of always burning the full timeout.
ipcRenderer.on('audio:capture-status', (_event, status) => {
  if (!status?.captureId || status.captureId !== _activeAudioCaptureId) return;
  _lastNativeStatus = localizeAudioStatus(status);
  const codeHex = '0x' + ((status?.code || 0) >>> 0).toString(16);
  console.log(`[Haven Desktop] native capture status: kind=${status?.kind} code=${codeHex} msg=${status?.message}`);
});

// Resolved share-audio mode reported by main once the picker handler decides
// what audio path to use (application / system / none).
// Forwarded to the page so the webapp can show a small mode indicator.
ipcRenderer.on('audio:share-mode', (_event, modeInfo) => {
  if (modeInfo?.captureId && modeInfo.captureId !== _activeShareId) return;
  console.log('[Haven Desktop] share audio mode:', modeInfo);
  try {
    _lastShareModeInfo = modeInfo;
    dispatchShareModeInfo(modeInfo);
  } catch (e) { console.warn('[Haven Desktop] dispatch share-mode event failed:', e.message); }
});
ipcRenderer.on('audio:capture-data', (_event, payload) => {
  if (!payload?.captureId || payload.captureId !== _activeAudioCaptureId) return;
  if (shouldDropAudioPacket(payload.capturedAt)) return;
  const pcmData = payload.data;
  // Build a Float32Array from whatever Electron's IPC delivers.
  // The main process now sends a plain ArrayBuffer (guaranteed offset-0),
  // but we still handle typed-array arrivals defensively.
  let samples;
  try {
    if (pcmData instanceof Float32Array) {
      samples = pcmData;
    } else if (pcmData instanceof ArrayBuffer) {
      samples = new Float32Array(pcmData);
    } else if (ArrayBuffer.isView(pcmData)) {
      // Buffer/Uint8Array — copy to a fresh aligned ArrayBuffer to avoid
      // RangeError when byteOffset is not 4-byte-aligned.
      const bytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
      const aligned = new ArrayBuffer(bytes.length);
      new Uint8Array(aligned).set(bytes);
      samples = new Float32Array(aligned);
    } else {
      console.warn('[Haven Desktop] audio:capture-data unknown format:', typeof pcmData);
      return;
    }
  } catch (e) {
    console.warn('[Haven Desktop] audio:capture-data conversion failed:', e.message);
    return;
  }

  // Periodic diagnostic: confirm data is arriving
  _ipcDataCount++;
  if (_ipcDataCount === 1 || _ipcDataCount % 500 === 0) {
    console.log(`[Haven Desktop] audio:capture-data chunk #${_ipcDataCount}, ${samples.length} samples, peak=${Math.max(...Array.from(samples.slice(0, 128)).map(Math.abs)).toFixed(4)}`);
  }

  if (_audioWorkletNode) {
    _audioWorkletNode.port.postMessage({ type: 'audio-data', samples }, [samples.buffer]);
  } else if (window._havenAppAudioPush) {
    window._havenAppAudioPush(samples);
  } else {
    const buffered = samples.length > 4800 ? samples.subarray(samples.length - 4800) : samples;
    _audioBufferQueue.push(buffered);
    _audioBufferedSamples += buffered.length;
    while (_audioBufferedSamples > 4800 && _audioBufferQueue.length > 1) {
      _audioBufferedSamples -= _audioBufferQueue.shift().length;
    }
  }
  _audioPacketsReceived++;
});

// The trusted picker runs in its own local BrowserWindow. Only after that
// window records consent does main ask this preload to prepare the audio track.
ipcRenderer.on('screen:prepare-share-cancel', (_event, data = {}) => {
  const requestId = typeof data.requestId === 'string' ? data.requestId : null;
  if (!requestId) return;
  _cancelledAudioPreparations.add(requestId);
  if (_activeAudioCaptureId === requestId) teardownAudioPipeline(requestId);
});

ipcRenderer.on('screen:prepare-share', (_event, data = {}) => {
  const requestId = typeof data.requestId === 'string' ? data.requestId : null;
  if (!requestId) return;
  _cancelledAudioPreparations.delete(requestId);

  const prepare = async () => {
    if (_cancelledAudioPreparations.delete(requestId)) return;

    teardownAudioPipeline(_activeAudioCaptureId);
    _activeShareId = requestId;
    _pendingShareId = requestId;
    _lastNativeStatus = null;

    const audioAppPid = data.audioAppPid;
    const wantsNativePipeline =
      (Number.isSafeInteger(audioAppPid) && audioAppPid > 0) || audioAppPid === 'system';
    let audioReady = true;
    if (wantsNativePipeline) {
      _activeAudioCaptureId = requestId;
      _capturedAudioPid = audioAppPid;
      try {
        audioReady = await buildAudioPipeline(() =>
          _cancelledAudioPreparations.has(requestId) || _activeAudioCaptureId !== requestId
        );
      } catch (err) {
        console.warn('[Haven Desktop] Local audio pipeline failed to build:', err.message);
        audioReady = false;
      }
    }

    if (_cancelledAudioPreparations.delete(requestId)) {
      teardownAudioPipeline(requestId);
      return;
    }
    if (!audioReady) teardownAudioPipeline(requestId);
    ipcRenderer.send('screen:prepare-share-result', { requestId, audioReady });
  };

  _audioPreparationQueue = _audioPreparationQueue.then(prepare, prepare);
});

// ═══════════════════════════════════════════════════════════
// Screen-Share Picker  (injected as a full-screen overlay)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// Audio-Capture Pipeline
//
// Receives PCM from the native addon via IPC, pipes it through
// an AudioWorklet, and exposes a MediaStreamTrack that replaces
// the system-loopback track on the screen-share MediaStream.
// ═══════════════════════════════════════════════════════════

async function buildAudioPipeline(isCancelled = () => false) {
  if (isCancelled()) return false;
  // Reset arrival counters so the getDisplayMedia override's readiness
  // check reflects ONLY this capture session, never a stale prior one.
  _audioPacketsReceived = 0;
  _ipcDataCount = 0;
  _audioBufferQueue = [];
  _audioBufferedSamples = 0;

  // Try AudioWorklet first, fall back to ScriptProcessorNode if it fails
  // (AudioWorklet blob URLs can fail in some Electron/BrowserView contexts)
  try {
    _audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    // Explicitly resume — BrowserView contexts may start suspended
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();
    if (isCancelled()) return false;

    // Inline AudioWorklet processor (blob URL avoids CSP / file issues)
    const workletSrc = `
      ${BoundedPcmRing.toString()}
      class AppAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._ring = new BoundedPcmRing(4800); // Never retain more than 100 ms.

          this.port.onmessage = (e) => {
            if (e.data.type !== 'audio-data') return;
            this._ring.push(e.data.samples);
          };
        }

        process(_inputs, outputs) {
          const out = outputs[0];
          if (!out || !out.length) return true;
          const buf = out[0];
          const len = buf.length;

          this._ring.pull(buf);

          for (let ch = 1; ch < out.length; ch++) out[ch].set(buf);
          return true;
        }
      }
      registerProcessor('app-audio-processor', AppAudioProcessor);
    `;

    const blob = new Blob([workletSrc], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await _audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    if (isCancelled()) return false;

    _audioWorkletNode = new AudioWorkletNode(_audioCtx, 'app-audio-processor', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });

    _audioDestination = _audioCtx.createMediaStreamDestination();
    _audioWorkletNode.connect(_audioDestination);
    // Also connect to AudioContext.destination (silenced) so Chromium's
    // audio thread actually drives the AudioWorklet process() callback.
    // Without this, MediaStreamDestination alone may not pump the graph.
    const silencer = _audioCtx.createGain();
    silencer.gain.value = 0;
    _audioWorkletNode.connect(silencer);
    silencer.connect(_audioCtx.destination);

    // Flush any PCM that arrived before the pipeline was ready
    _audioBufferQueue.forEach(buf =>
      _audioWorkletNode.port.postMessage({ type: 'audio-data', samples: buf }, [buf.buffer])
    );
    _audioBufferQueue = [];
    _audioBufferedSamples = 0;

    // Expose track globally so our getDisplayMedia override can grab it
    window._havenAppAudioTrack  = _audioDestination.stream.getAudioTracks()[0];
    window._havenAppAudioStream = _audioDestination.stream;

    // Monitor AudioContext — BrowserView can re-suspend unexpectedly
    window._havenAudioCtxMonitor = setInterval(() => {
      if (_audioCtx && _audioCtx.state === 'suspended') {
        console.warn('[Haven Desktop] AudioContext suspended — resuming');
        _audioCtx.resume().catch(() => {});
      }
    }, 2000);

    console.log('[Haven Desktop] Per-app audio pipeline active (AudioWorklet), ctx state:', _audioCtx.state);
    return true;
  } catch (err) {
    console.warn('[Haven Desktop] AudioWorklet pipeline failed, trying ScriptProcessor fallback:', err.message);
    // Clean up partial AudioWorklet state before fallback
    _audioWorkletNode = null;
    if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
    _audioDestination = null;
    if (isCancelled()) return false;
  }

  // ── Fallback: ScriptProcessorNode (works in all Electron versions) ──
  try {
    _audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();
    if (isCancelled()) return false;

    const bufSize = 1024;
    // Use 1 input channel (not 0).  A "generator" ScriptProcessor with
    // 0 inputs may not have its onaudioprocess callback pumped reliably
    // in Electron / BrowserView environments.  Connecting a live source
    // to the input guarantees Chromium's audio thread drives the node.
    const scriptNode = _audioCtx.createScriptProcessor(bufSize, 1, 2);
    const ring = new BoundedPcmRing(4800);
    let   _spProcessCount = 0;

    // Store a push function that the IPC handler can call
    window._havenAppAudioPush = (samples) => {
      ring.push(samples);
    };

    scriptNode.onaudioprocess = (e) => {
      _spProcessCount++;
      const out = e.outputBuffer.getChannelData(0);
      ring.pull(out);
      // Copy mono to stereo
      const out1 = e.outputBuffer.getChannelData(1);
      out1.set(out);
      // Periodic diagnostic
      if (_spProcessCount === 1 || _spProcessCount % 200 === 0) {
        const peak = Math.max(...Array.from(out.slice(0, 128)).map(Math.abs));
        console.log(`[Haven Desktop] ScriptProcessor process #${_spProcessCount}, avail=${ring.available}, peak=${peak.toFixed(4)}`);
      }
    };

    _audioDestination = _audioCtx.createMediaStreamDestination();
    scriptNode.connect(_audioDestination);

    // Drive the ScriptProcessor with a silent ConstantSourceNode so
    // Chromium's audio thread always pulls from it.
    const driver = _audioCtx.createConstantSource();
    driver.offset.value = 0;
    driver.connect(scriptNode);
    driver.start();
    // Also connect to context destination (silenced) as a second sink
    // to ensure the graph stays active.
    const silencer = _audioCtx.createGain();
    silencer.gain.value = 0;
    scriptNode.connect(silencer);
    silencer.connect(_audioCtx.destination);

    // Flush buffered PCM
    _audioBufferQueue.forEach(buf => window._havenAppAudioPush(buf));
    _audioBufferQueue = [];
    _audioBufferedSamples = 0;

    window._havenAppAudioTrack  = _audioDestination.stream.getAudioTracks()[0];
    window._havenAppAudioStream = _audioDestination.stream;

    // Monitor AudioContext — BrowserView can re-suspend unexpectedly
    window._havenAudioCtxMonitor = setInterval(() => {
      if (_audioCtx && _audioCtx.state === 'suspended') {
        console.warn('[Haven Desktop] AudioContext suspended — resuming');
        _audioCtx.resume().catch(() => {});
      }
    }, 2000);

    console.log('[Haven Desktop] Per-app audio pipeline active (ScriptProcessor fallback), ctx state:', _audioCtx.state);
    return true;
  } catch (err) {
    console.error('[Haven Desktop] Audio pipeline setup failed completely:', err);
    // Clean up on total failure
    if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
    _audioDestination = null;
    window._havenAppAudioPush = null;
    return false;
  }
}

function teardownAudioPipeline(captureId = _activeAudioCaptureId) {
  if (captureId && captureId !== _activeAudioCaptureId) return;
  // Stop native capture first so IPC messages stop arriving
  if (captureId) ipcRenderer.invoke('audio:stop-capture', { captureId }).catch(() => {});
  if (window._havenAudioCtxMonitor) {
    clearInterval(window._havenAudioCtxMonitor);
    window._havenAudioCtxMonitor = null;
  }
  _audioWorkletNode?.disconnect();
  _audioWorkletNode = null;
  _audioCtx?.close().catch(() => {});
  _audioCtx         = null;
  _audioDestination = null;
  _capturedAudioPid = null;
  _activeAudioCaptureId = null;
  _audioBufferQueue = [];
  _audioBufferedSamples = 0;
  _audioPacketsReceived = 0;
  _ipcDataCount     = 0;
  window._havenAppAudioTrack  = null;
  window._havenAppAudioStream = null;
  window._havenAppAudioPush   = null;
  console.log('[Haven Desktop] Audio pipeline torn down');
}

// ═══════════════════════════════════════════════════════════
// Override getDisplayMedia()
//
// After Electron's handler resolves with a video stream, we
// swap the system-loopback audio track for our per-app track.
// Haven's voice.js calls the same standard API — zero changes
// needed on the server/browser code.
//
// NOTE: navigator.mediaDevices is not available at preload
// time — it only exists once the renderer page has loaded.
// We defer the override until DOMContentLoaded.
// ═══════════════════════════════════════════════════════════

function installGetDisplayMediaOverride() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    // Not ready yet (rare, but possible) — retry briefly
    setTimeout(installGetDisplayMediaOverride, 100);
    return;
  }

  const _origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    if (_displayMediaPending) {
      throw new DOMException('A screen-share request is already open.', 'InvalidStateError');
    }
    _displayMediaPending = true;

    // Reset native status before each share so a stale "failed" from a
    // prior session doesn't poison the next attempt.
    _lastNativeStatus = null;

    let stream;
    try {
      stream = await _origGDM(constraints);
    } catch (error) {
      const failedShareId = _pendingShareId;
      _pendingShareId = null;
      if (failedShareId && _activeShareId === failedShareId) {
        teardownAudioPipeline(failedShareId);
        _activeShareId = null;
      }
      _displayMediaPending = false;
      throw error;
    }
    try {
      const shareId = _pendingShareId || _activeShareId;
      _pendingShareId = null;
      const captureId = shareId === _activeAudioCaptureId ? shareId : null;
      const capturedAudioPid = captureId ? _capturedAudioPid : null;
      const audioTracksFromElectron = stream.getAudioTracks().length;
      console.log(`[Haven Desktop] getDisplayMedia resolved (capturedAudioPid=${capturedAudioPid}, electron-audio-tracks=${audioTracksFromElectron}, per-app track ready=${!!window._havenAppAudioTrack})`);

      // Native capture is strict: wait for PCM and add only that track. An
      // application-capture failure stays silent instead of exposing all audio.
      if (capturedAudioPid) {
        const timeoutMs = 8000;
        const stepMs    = 20;
        const start     = Date.now();
        let lastLog     = 0;
        while ((Date.now() - start) < timeoutMs) {
          if (_activeAudioCaptureId !== captureId) break;
          if (_audioPacketsReceived > 0) break;
          if (_lastNativeStatus && _lastNativeStatus.kind === 'failed') {
            console.warn('[Haven Desktop] native capture reported FAILED during readiness wait');
            break;
          }
          if (Date.now() - lastLog > 1000) {
            lastLog = Date.now();
            console.log(`[Haven Desktop] waiting for first PCM packet... elapsed=${Date.now() - start}ms received=${_audioPacketsReceived} status=${_lastNativeStatus?.kind || 'none'}`);
          }
          await new Promise(resolve => setTimeout(resolve, stepMs));
        }

        if (_activeAudioCaptureId === captureId &&
            _audioPacketsReceived > 0 && window._havenAppAudioTrack) {
          // Remove any unexpected Electron track before attaching native audio.
          stream.getAudioTracks().forEach(t => { try { stream.removeTrack(t); t.stop(); } catch {} });
          stream.addTrack(window._havenAppAudioTrack);
          console.log(`[Haven Desktop] native audio track added (waited ${Date.now() - start}ms, ${_audioPacketsReceived} PCM chunks received)`);
        } else {
          console.warn('[Haven Desktop] readiness wait expired without PCM. Diagnostics:');
          console.warn('  capturedAudioPid:', capturedAudioPid);
          console.warn('  packetsReceived:', _audioPacketsReceived);
          console.warn('  ipcDataCount:', _ipcDataCount);
          console.warn('  havenAppAudioTrack present:', !!window._havenAppAudioTrack);
          console.warn('  audioCtx state:', _audioCtx?.state);
          console.warn('  audioWorkletNode present:', !!_audioWorkletNode);
          console.warn('  havenAppAudioPush present:', !!window._havenAppAudioPush);
          console.warn('  lastNativeStatus:', _lastNativeStatus);
          console.warn('  Continuing without audio to prevent a Haven voice loop.');
          stream.getAudioTracks().forEach(t => { try { stream.removeTrack(t); t.stop(); } catch {} });
          teardownAudioPipeline(captureId);
        }
      } else if (window._havenAppAudioTrack && !_activeAudioCaptureId) {
        // A track without an active selection is stale and must never leak into
        // a later "no audio" or "all system audio" share.
        teardownAudioPipeline();
      } else {
        console.log(`[Haven Desktop] no native capture requested; using Electron-provided audio (${audioTracksFromElectron} track(s))`);
      }

      const encoderConfig = await ipcRenderer
        .invoke('video:get-encoder-config')
        .catch(() => _videoEncoderConfig);
      _videoEncoderConfig = {
        ...encoderConfig,
        preference: normalizeVideoEncoderPreference(encoderConfig.preference),
        hardwareAvailable: encoderConfig.hardwareAvailable === true,
      };
      stream.getVideoTracks().forEach((track, index) => {
        _displayVideoTracks.add(track);
        if (index === 0) _activeDisplayVideoTrack = track;
      });

      // An older video track must not tear down a newer share.
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (_activeShareId !== shareId || _activeDisplayVideoTrack !== track) return;
        teardownAudioPipeline(captureId);
        clearVideoEncoderStatus();
        _activeDisplayVideoTrack = null;
        _activeShareId = null;
      }));

      return stream;
    } finally {
      _displayMediaPending = false;
    }
  };

  console.log('[Haven Desktop] getDisplayMedia override installed');
}

document.addEventListener('DOMContentLoaded', installGetDisplayMediaOverride);

// ═══════════════════════════════════════════════════════════
//  Desktop Notifications  (override browser Notification API)
// ═══════════════════════════════════════════════════════════

class HavenNotification {
  constructor(title, opts = {}) {
    ipcRenderer.invoke('notify', { title, body: opts.body || '', silent: opts.silent || false, channelCode: opts.channelCode });
    this._onclick = null;
  }
  set onclick(fn) { this._onclick = fn; }
  get onclick()   { return this._onclick; }
  close() {}
  static get permission() { return 'granted'; }
  static requestPermission() { return Promise.resolve('granted'); }
}
window.Notification = HavenNotification;

// When user clicks a native notification, navigate to the channel
ipcRenderer.on('notification-clicked', (_e, channelCode) => {
  if (channelCode && window.app?.switchChannel) {
    window.app.switchChannel(channelCode);
  }
});

// Issue #5306: in-app navigation for cross-channel message links
// (target="_blank" on /app.html?channel=…&message=… would otherwise
// spawn a fresh BrowserWindow / second client instance on Linux).
ipcRenderer.on('app:navigate-deep-link', (_e, { code, messageId, url } = {}) => {
  try {
    if (code && window.app?.switchChannel) {
      window.app.switchChannel(code);
      if (messageId && window.app?._jumpToMessage) {
        const id = parseInt(messageId, 10);
        if (id) setTimeout(() => { try { window.app._jumpToMessage(id); } catch {} }, 600);
      }
      return;
    }
  } catch {}
  // Fallback: full reload to the deep link if the SPA handlers aren't
  // available (e.g. login page).  The page's auth.js preserves the
  // ?channel/?message query across the auth bounce.
  if (url) { try { location.href = url; } catch {} }
});

// ═══════════════════════════════════════════════════════════
//  Exposed API  (window.havenDesktop)
// ═══════════════════════════════════════════════════════════

window.havenDesktop = {
  platform:     process.platform,
  isDesktopApp: true,
  // The page has focus exactly when the window does (main.js hands focus to
  // the active server view), so document.hasFocus() can stand in for the
  // page being seen: pages here never become hidden. (#58)
  pageFocusFollowsWindow: true,

  i18n: {
    getState: () => ({ ...i18nState }),
    getLocale: () => i18nState.locale,
    t,
    setLanguage: (preference) => ipcRenderer.invoke('i18n:set-language', preference),
  },

  /** Switch to another Haven server inside the app window (hot-swap) */
  switchServer: (url) => ipcRenderer.send('nav:switch-server', url, serverListAction({ user: true })),

  /** Go back to the welcome / setup screen */
  backToWelcome: () => ipcRenderer.send('nav:back-to-welcome'),

  /** Auto-update controls */
  update: {
    download: () => ipcRenderer.invoke('update:download'),
    install:  () => ipcRenderer.send('update:install'),
  },

  // Starting a capture is the share picker's job (see main.js).
  audio: {
    stopCapture:     ()    => { teardownAudioPipeline(); return ipcRenderer.invoke('audio:stop-capture'); },
    isSupported:     ()    => ipcRenderer.invoke('audio:is-supported'),
    optOutOfDucking: ()    => ipcRenderer.invoke('audio:opt-out-ducking'),
  },

  devices: {
    getInputs:  () => ipcRenderer.invoke('devices:get-inputs'),
    getOutputs: () => ipcRenderer.invoke('devices:get-outputs'),
    setOutput:  async (deviceId) => {
      for (const el of document.querySelectorAll('audio, video')) {
        if (el.setSinkId) await el.setSinkId(deviceId);
      }
      return true;
    },
  },

  notify: (title, body, opts = {}) => ipcRenderer.invoke('notify', { title, body, ...opts }),

  /** Desktop shortcut configuration */
  shortcuts: {
    getConfig: ()         => ipcRenderer.invoke('shortcuts:get'),
    // The in-page hold-mode PTT follows the same binding (Haven #5603).
    setConfig: (updates)  => ipcRenderer.invoke('shortcuts:register', updates)
      .then((res) => { _refreshPttDomBinding(); return res; }),
  },

  /** Signal the taskbar/dock badge (no native notification needed) */
  setUnreadBadge: (hasUnread) => ipcRenderer.send('notification-badge', hasUnread),

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  getVersion: () => ipcRenderer.invoke('app:version'),

  /** Write an image to the OS clipboard via the main process.
   *  Bypasses navigator.clipboard.write's gesture restrictions that
   *  the renderer can't reliably satisfy across an async fetch.
   *  Accepts a data: URL or raw base64. Returns { ok, reason }. */
  clipboardWriteImage: (payload) => ipcRenderer.invoke('clipboard:write-image', payload),

  /** Write plain text to the OS clipboard via the main process.
   *  Same gesture-bypass rationale as clipboardWriteImage. */
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  /** Native save dialog for images. WebView/Chromium often ignores <a download>
   *  on http(s) media. Haven passes base64 bytes + a filename. */
  saveImage: ({ bytes, filename } = {}) =>
    ipcRenderer.invoke('dialog:save-image', { payload: bytes || '', filename }),

  /** Access the Desktop-level server history (persists across all servers) */
  getServerHistory: () => ipcRenderer.invoke('server-history:get'),
  /** True: the app asks the user itself before a page adds, removes,
   *  renames or changes the icon of a server, or opens one that is not
   *  listed, so the page does not ask a second time. Removing resolves to
   *  the list with the server still in it when the user said no; adding
   *  resolves to 'declined', 'busy' or 'blocked' when nothing was added.
   *  The page marks the removals and edits the user makes with { user: true }
   *  in their options; unmarked ones are taken for syncing and ignored. */
  serverListGated: true,
  /** opts.userInitiated: the user added it (Add Server), which brings back a
   *  server removed earlier; other adds of a removed server are refused. */
  addServerHistory: (url, name, opts) => ipcRenderer.invoke('server-history:add', url, name, opts, serverListAction(opts)),
  /** opts.user: the user removed it (Manage Servers). Without it the app
   *  takes the call for a page syncing on its own, and nothing changes. */
  removeServerHistory: (url, opts) => ipcRenderer.invoke('server-history:remove', url, serverListAction(opts)),

  /** The shared server list every server page shows:
   *  { servers: [{ url, name, customName?, icon?, customIcon? }] in the
   *  user's order, removed: [url], order: [url], hasOrder }. */
  getServerList: () => ipcRenderer.invoke('server-list:get'),
  /** Save the user's order. Servers the page leaves out keep their places. */
  setServerOrder: (urls) => ipcRenderer.invoke('server-list:set-order', Array.isArray(urls) ? urls : []),
  /** Rename a server for every page. opts.custom true: the user's own name
   *  (opts.icon: the user's own icon, or null); false: back to the server's
   *  own name; left out: the server's own name, which never replaces the
   *  user's. opts.user: the user made this edit; a name or icon for another
   *  server without it is a page syncing on its own, and nothing changes. */
  updateServerName: (url, name, opts) => ipcRenderer.invoke('server-history:update-name', url, name, opts, serverListAction(opts)),
  /** Synchronous snapshot of the shared list at page load, or null. */
  initialServerList: (() => {
    try { return ipcRenderer.sendSync('server-list:get-sync') || null; }
    catch (err) { console.warn('[Haven Desktop] could not read the server list', err); return null; }
  })(),

  /** Synchronous snapshot of the cross-server history at page-load time.
   *  Lets the sidebar populate immediately on first-join to a brand-new
   *  server, before any auth or sync round-trips have completed. */
  initialServerHistory: (() => {
    try { return ipcRenderer.sendSync('server-history:get-sync') || []; }
    catch { return []; }
  })(),

  /** Desktop app preferences (start on login, minimize to tray, HDR/SDR) */
  prefs: {
    get:              ()      => ipcRenderer.invoke('desktop:get-prefs'),
    setStartOnLogin:  (v)     => ipcRenderer.invoke('desktop:set-start-on-login', v),
    setStartHidden:   (v)     => ipcRenderer.invoke('desktop:set-start-hidden', v),
    setMinimizeToTray:(v)     => ipcRenderer.invoke('desktop:set-minimize-to-tray', v),
    setForceSDR:      (v)     => ipcRenderer.invoke('desktop:set-force-sdr', v),
    setHideMenuBar:   (v)     => ipcRenderer.invoke('desktop:set-hide-menu-bar', v),
    setDisableGpuVsync:  (v)  => ipcRenderer.invoke('desktop:set-disable-gpu-vsync', v),
    setUnlimitFrameRate: (v)  => ipcRenderer.invoke('desktop:set-unlimit-frame-rate', v),
    setLinuxVaapiBypass:(v)  => ipcRenderer.invoke('desktop:set-linux-vaapi-bypass', v),
    setLinuxForceX11:   (v)  => ipcRenderer.invoke('desktop:set-linux-force-x11', v),
    setLanguage:         (v)  => ipcRenderer.invoke('i18n:set-language', v),
  },

  /** Query per-server unread badge state for notification dots */
  getServerBadges: () => ipcRenderer.invoke('get-server-badges'),

  /** Report which server URLs this view can actually display in its sidebar.
   *  Main filters the taskbar overlay so it only counts unreads from
   *  servers at least one open view can surface — preventing phantom
   *  badges from background-preloaded servers the user never added on
   *  the active origin. (#5269) */
  reportKnownServerUrls: (urls) => ipcRenderer.send('report-known-server-urls', urls),
};

console.log('[Haven Desktop] App preload ready — per-app audio & enhanced features active');

// ═══════════════════════════════════════════════════════════
// Auto-Update Banner
//
// When electron-updater detects a new version, we inject a slim
// banner at the top of the page so the user can download and
// install with one click.
// ═══════════════════════════════════════════════════════════

(function setupAutoUpdateBanner() {
  let bannerEl = null;

  function createBanner(messageKey, values, buttonKey, buttonAction) {
    removeBanner();
    bannerEl = document.createElement('div');
    bannerEl.id = 'haven-update-banner';
    bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999998;background:linear-gradient(135deg,#6b4fdb,#8b6ce7);color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    const msg = document.createElement('span');
    setI18nText(msg, messageKey, values);
    msg.id = 'haven-update-msg';
    bannerEl.appendChild(msg);
    if (buttonKey) {
      const btn = document.createElement('button');
      setI18nText(btn, buttonKey);
      btn.id = 'haven-update-btn';
      btn.style.cssText = 'background:#fff;color:#6b4fdb;border:none;border-radius:4px;padding:4px 14px;font-weight:600;cursor:pointer;font-size:12px;';
      btn.onclick = buttonAction;
      bannerEl.appendChild(btn);
    }
    const close = document.createElement('button');
    close.textContent = '✕';
    setI18nTitle(close, 'update.close');
    close.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:16px;padding:0 4px;margin-left:4px;';
    close.onclick = removeBanner;
    bannerEl.appendChild(close);
    document.body.prepend(bannerEl);
  }

  function removeBanner() {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
  }

  ipcRenderer.on('update:available', (_e, { version }) => {
    createBanner(
      'update.available',
      { version },
      'update.now',
      async () => {
        const btn = document.getElementById('haven-update-btn');
        const msg = document.getElementById('haven-update-msg');
        if (btn) btn.disabled = true;
        setI18nText(msg, 'update.downloading');
        const res = await ipcRenderer.invoke('update:download');
        if (res?.errorKey) {
          setI18nText(msg, res.errorKey);
        } else if (res?.error) {
          setI18nText(msg, 'update.failed', { error: res.error });
        }
      }
    );
  });

  ipcRenderer.on('update:download-progress', (_e, { percent }) => {
    const msg = document.getElementById('haven-update-msg');
    setI18nText(msg, 'update.downloadingProgress', { percent });
  });

  ipcRenderer.on('update:downloaded', () => {
    createBanner(
      'update.downloaded',
      null,
      'update.restartNow',
      () => ipcRenderer.send('update:install')
    );
  });

  ipcRenderer.on('update:error', (_e, { message }) => {
    const msg = document.getElementById('haven-update-msg');
    setI18nText(msg, 'update.error', { error: message });
  });
})();
