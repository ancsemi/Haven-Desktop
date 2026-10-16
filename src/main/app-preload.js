// ═══════════════════════════════════════════════════════════
// Haven Desktop: App Window Preload
//
// Loaded when the Haven web app runs inside the desktop shell.
// Provides:
//  • Per-application audio capture during screen share
//  • Custom screen-share picker (windows + audio apps)
//  • Native desktop notifications
//  • Audio device enumeration & hot-switching
//  • Transparent getDisplayMedia() override (Haven's voice.js
//    calls the same API; our code intercepts and enhances it)
//
// This file runs in the preload's own world (contextIsolation), apart from
// the server page's scripts, and is the only place that holds ipcRenderer.
// The page gets window.havenDesktop through contextBridge: plain functions,
// each calling one IPC channel. What has to replace the page's own globals
// lives in app-page-world.js, injected into the page before its scripts
// run, and talks to this file through a second, equally narrow bridge.
// ═══════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer, webFrame } = require('electron');
const { pageWorldSource } = require('./app-page-world');

const { createTranslator } = require('../i18n');
const {
  SERVER_LOCALE_KEY,
  serverLocaleForDesktop,
  desktopLocaleForServer,
  reconcileLanguagePreferences,
} = require('../i18n/server-bridge');

let i18nState = ipcRenderer.sendSync('i18n:get-state-sync');
let translate = createTranslator(i18nState.locale);
let _lastShareModeInfo = null;

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

// This world's Storage is not the page's, so a write made here never
// reaches the page world's language hook and cannot echo back.
function writeServerLocalePreference(preference) {
  try {
    window.localStorage.setItem(SERVER_LOCALE_KEY, preference);
    return true;
  } catch {
    return false; // storage blocked: the server page keeps its own language
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

// The page world publishes it (window.__havenShareAudioMode and the
// haven:share-audio-mode event) when it belongs to the share in progress.
function sendShareModeInfo(modeInfo) {
  toPageWorld('audio:share-mode', { raw: modeInfo, localized: localizeShareModeInfo(modeInfo) });
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

// ═══════════════════════════════════════════════════════════
// Bridge to the page world (app-page-world.js)
//
// The page can reach this object too, so it only offers what the page
// world needs, each a plain function with checked arguments, and main
// checks every call again.
// ═══════════════════════════════════════════════════════════

let pageWorldListener = null;
function toPageWorld(kind, payload) {
  if (!pageWorldListener) return;
  try { pageWorldListener(kind, payload); }
  catch (err) { console.warn(`[Haven Desktop] the page world could not take ${kind}:`, err?.message || err); }
}

const PAGE_DIALOGS = new Set(['alert', 'confirm', 'prompt']);
contextBridge.exposeInMainWorld('__havenDesktopPage', {
  // The page world subscribes first, before any page script runs; later
  // callers get nothing.
  subscribe: (fn) => {
    if (pageWorldListener || typeof fn !== 'function') return false;
    pageWorldListener = fn;
    return true;
  },
  t: (key, values) => t(String(key), values && typeof values === 'object' ? values : undefined),
  // The OS dialog blocks the page until the user answers (see main.js).
  dialog: (kind, message, defaultValue) => {
    if (!PAGE_DIALOGS.has(kind)) return null;
    return ipcRenderer.sendSync(`dialog:${kind}`, {
      message: String(message ?? ''),
      defaultValue: String(defaultValue ?? ''),
    });
  },
  notify: (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    ipcRenderer.invoke('notify', {
      title: String(o.title ?? ''),
      body: String(o.body ?? ''),
      silent: o.silent === true,
      channelCode: typeof o.channelCode === 'string' ? o.channelCode : undefined,
    }).catch(err => console.warn('[Haven Desktop] notification failed:', err?.message || err));
  },
  fullscreen: (enter) => ipcRenderer.send(enter === true ? 'window:enter-fullscreen' : 'window:leave-fullscreen'),
  serverLocaleChanged: (value) => syncDesktopFromServerPreference(String(value)),
  reportServerLanguage: (preference, locale) => {
    ipcRenderer.send('i18n:server-state', { preference: String(preference), locale: String(locale) });
  },
  shortcutsGet: () => ipcRenderer.invoke('shortcuts:get'),
  getEncoderConfig: () => ipcRenderer.invoke('video:get-encoder-config'),
  stopCapture: (captureId) => (typeof captureId === 'string'
    ? ipcRenderer.invoke('audio:stop-capture', { captureId })
    : Promise.resolve(false)),
  prepareShareResult: (requestId, audioReady) => {
    if (typeof requestId !== 'string') return;
    ipcRenderer.send('screen:prepare-share-result', { requestId, audioReady: audioReady === true });
  },
});

// Events from main that the page world acts on.
for (const channel of [
  'voice:mute-toggle', 'voice:deafen-toggle', 'voice:ptt-toggle', 'voice:ptt-down', 'voice:ptt-up',
  'voice:ptm-down', 'voice:ptm-up',
  'notification-clicked', 'app:navigate-deep-link', 'screen:prepare-share', 'screen:prepare-share-cancel',
]) {
  ipcRenderer.on(channel, (_event, payload) => toPageWorld(channel, payload));
}
ipcRenderer.on('audio:capture-status', (_event, status) => {
  toPageWorld('audio:capture-status', localizeAudioStatus(status));
});
ipcRenderer.on('audio:share-mode', (_event, modeInfo) => {
  _lastShareModeInfo = modeInfo;
  sendShareModeInfo(modeInfo);
});
ipcRenderer.on('audio:capture-data', (_event, payload) => {
  if (!payload || shouldDropAudioPacket(payload.capturedAt)) return;
  toPageWorld('audio:capture-data', payload);
});

ipcRenderer.on('i18n:changed', (_event, state) => {
  updatePreloadI18nState(state);
  applyInjectedTranslations();
  if (_lastShareModeInfo) sendShareModeInfo(_lastShareModeInfo);
  window.dispatchEvent(new CustomEvent('haven-desktop-language-changed', { detail: { ...state } }));
});

ipcRenderer.on('i18n:sync-server-preference', (_event, state) => {
  updatePreloadI18nState(state);
  syncServerFromDesktopPreference(state, true);
});

ipcRenderer.on('i18n:became-active', (_event, state) => {
  updatePreloadI18nState(state);
  reconcileCurrentLanguagePreference(true);
  toPageWorld('i18n:report-language');
});

window.addEventListener('languagechange', () => {
  if (i18nState.preference === 'auto') {
    ipcRenderer.invoke('i18n:refresh-automatic').catch(() => {});
  }
});

const { shouldDropAudioPacket } = require('./screen-share-audio');

const { checkServer } = require('./server-check');

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
  } catch (err) {
    console.warn('[Haven Desktop] could not read the page theme:', err?.message || err);
  }
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

// ─── Clear any stale voice-channel state on fresh page load ──────────────
// Without this, closing the app while in voice leaves haven_voice_channel in
// localStorage, causing the web app to think the user is already in voice on
// the next launch, which prevents rejoining until they manually "leave" first.
window.addEventListener('DOMContentLoaded', () => {
  try { localStorage.removeItem('haven_voice_channel'); } catch {}
});

// ─── Desktop Status Bar (guaranteed visible) ─────────────────────────────
// The server's responsive CSS hides #status-bar at narrow viewport widths
// (for mobile).  Windows DPI scaling can shrink the BrowserView's CSS
// viewport below that threshold.  We solve this by injecting a fixed-position
// bar at the bottom of the page from the preload, entirely independent of
// the server's CSS layout.  We clone the server bar's live text nodes so
// the data (ping, version, channel, online count) stays in sync.
window.addEventListener('DOMContentLoaded', () => {
  // Inject the CSS once
  const css = document.createElement('style');
  css.textContent = `
    /* Switch Server button on login page (fixed above the status bar) */
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

// ═══════════════════════════════════════════════════════════
//  Exposed API  (window.havenDesktop)
// ═══════════════════════════════════════════════════════════

contextBridge.exposeInMainWorld('havenDesktop', {
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
    stopCapture:     ()    => { toPageWorld('audio:teardown'); return ipcRenderer.invoke('audio:stop-capture'); },
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
    // The in-page hold-mode PTT and push to mute follow the same bindings
    // (Haven #5603).
    setConfig: (updates)  => ipcRenderer.invoke('shortcuts:register', updates)
      .then((res) => { toPageWorld('shortcuts:changed'); return res; }),
  },

  /** Signal the taskbar/dock badge (no native notification needed) */
  setUnreadBadge: (hasUnread) => ipcRenderer.send('notification-badge', !!hasUnread),

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
    setFlashTaskbar:  (v)     => ipcRenderer.invoke('desktop:set-flash-taskbar', v),
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

  /** Server mute, shared by every server page: { origin: 'all' | 'mentions' }.
   *  set(url, mode) with mode null unmutes. onChanged(cb) hears every change. */
  serverMute: {
    getAll: () => ipcRenderer.invoke('server-mute:get-all'),
    set: (url, mode) => ipcRenderer.invoke('server-mute:set', String(url || ''), mode == null ? null : String(mode)),
    onChanged: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('server-mute:changed', (_e, data) => { try { cb(data); } catch (err) { console.warn('[Haven] server mute listener failed:', err.message); } });
    },
  },

  /** Report which server URLs this view can actually display in its sidebar.
   *  Main filters the taskbar overlay so it only counts unreads from
   *  servers at least one open view can surface, preventing phantom
   *  badges from background-preloaded servers the user never added on
   *  the active origin. (#5269) */
  reportKnownServerUrls: (urls) => ipcRenderer.send('report-known-server-urls', Array.isArray(urls) ? urls.map(String) : []),
});

// ═══════════════════════════════════════════════════════════
// Page world
//
// What has to replace the page's own globals runs in the page, before any
// of its scripts (app-page-world.js). It reaches the app only through the
// __havenDesktopPage bridge above.
// ═══════════════════════════════════════════════════════════

webFrame.executeJavaScript(pageWorldSource())
  .catch(err => console.error('[Haven Desktop] the page world failed to start:', err?.message || err));

console.log('[Haven Desktop] App preload ready: per-app audio & enhanced features active');

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
    close.onclick = () => { removeBanner(); ipcRenderer.send('update:dismiss'); };
    bannerEl.appendChild(close);
    // The news can arrive while the page is still loading, before there is
    // a body to put the banner in (#63).
    const el = bannerEl;
    if (document.body) document.body.prepend(el);
    else document.addEventListener('DOMContentLoaded', () => { if (bannerEl === el) document.body.prepend(el); }, { once: true });
  }

  function removeBanner() {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
  }

  function showAvailable(version) {
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
  }

  function showDownloaded() {
    createBanner(
      'update.downloaded',
      null,
      'update.restartNow',
      () => ipcRenderer.send('update:install')
    );
  }

  ipcRenderer.on('update:available', (_e, { version }) => showAvailable(version));

  ipcRenderer.on('update:download-progress', (_e, { percent }) => {
    const msg = document.getElementById('haven-update-msg');
    setI18nText(msg, 'update.downloadingProgress', { percent });
  });

  ipcRenderer.on('update:downloaded', () => showDownloaded());

  ipcRenderer.on('update:error', (_e, { message }) => {
    const msg = document.getElementById('haven-update-msg');
    setI18nText(msg, 'update.error', { error: message });
  });

  // Ask what the updater already found: the start-up check usually answers
  // before this page has loaded, and the message it sent then is lost (#63).
  // A popup opened from a server page (a picture in its own window) is left
  // out; its server page has the banner.
  if (!window.opener) ipcRenderer.invoke('update:state').then((state) => {
    if (bannerEl || !state) return;
    if (state.status === 'downloaded') showDownloaded();
    else if (state.status === 'available') showAvailable(state.version);
  }).catch(err => console.warn('[AutoUpdate] could not read the update state:', err?.message || err));
})();
