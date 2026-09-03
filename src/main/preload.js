// ═══════════════════════════════════════════════════════════
// Haven Desktop — Welcome Window Preload
// Exposes IPC bridges for the welcome / setup screen.
// ═══════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');
const { createTranslator } = require('../i18n');

let i18nState = ipcRenderer.sendSync('i18n:get-state-sync');
let translate = createTranslator(i18nState.locale);
const i18nListeners = new Set();

function t(key, values) {
  return translate(key, values);
}

function setI18nText(element, key, values) {
  if (!element) return;
  element.dataset.havenI18n = key;
  element.dataset.havenI18nValues = JSON.stringify(values || {});
  element.textContent = t(key, values);
}

function applyI18n(root = document) {
  document.documentElement.lang = i18nState.locale;
  document.documentElement.dir = i18nState.direction;
  root.querySelectorAll?.('[data-haven-i18n]').forEach(element => {
    let values = {};
    try { values = JSON.parse(element.dataset.havenI18nValues || '{}'); } catch {}
    element.textContent = t(element.dataset.havenI18n, values);
  });
}

ipcRenderer.on('i18n:changed', (_event, state) => {
  i18nState = state;
  translate = createTranslator(state.locale);
  applyI18n();
  for (const listener of i18nListeners) listener({ ...state });
});

window.addEventListener('languagechange', () => {
  if (i18nState.preference === 'auto') {
    ipcRenderer.invoke('i18n:refresh-automatic').catch(() => {});
  }
});

window.haven = {
  platform: process.platform,

  // ── Server Management ──────────────────────────────────
  server: {
    detect:     ()          => ipcRenderer.invoke('server:detect'),
    start:      (dir)       => ipcRenderer.invoke('server:start', dir),
    stop:       ()          => ipcRenderer.invoke('server:stop'),
    browse:     ()          => ipcRenderer.invoke('server:browse'),
    browseFile: ()          => ipcRenderer.invoke('server:browse-file'),
    getStatus:  ()          => ipcRenderer.invoke('server:status'),
    onLog:      (cb)        => ipcRenderer.on('server:log', (_e, m) => cb(m)),
  },

  // ── Settings ───────────────────────────────────────────
  settings: {
    get: (key)       => ipcRenderer.invoke('settings:get', key),
    set: (key, val)  => ipcRenderer.invoke('settings:set', key, val),
  },

  // ── Window Controls (frameless title-bar buttons) ──────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // ── Navigation ─────────────────────────────────────────
  nav: {
    openApp: (serverUrl) => ipcRenderer.send('nav:open-app', serverUrl),
  },

  // ── Auto-Update ────────────────────────────────────────
  update: {
    download: () => ipcRenderer.invoke('update:download'),
    install:  () => ipcRenderer.send('update:install'),
  },

  i18n: {
    getState: () => ({ ...i18nState }),
    t,
    setLanguage: (preference) => ipcRenderer.invoke('i18n:set-language', preference),
    onChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      i18nListeners.add(callback);
      return () => i18nListeners.delete(callback);
    },
  },

  // ── Misc ───────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getVersion:   ()    => ipcRenderer.invoke('app:version'),
};

// ── Auto-Update Banner for Welcome Screen ────────────────
(function () {
  let bannerEl = null;
  function createBanner(messageKey, values, buttonKey, buttonAction) {
    removeBanner();
    bannerEl = document.createElement('div');
    bannerEl.id = 'haven-update-banner';
    bannerEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999998;background:linear-gradient(135deg,#6b4fdb,#8b6ce7);color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;box-shadow:0 -2px 8px rgba(0,0,0,.3);';
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
    document.body?.appendChild(bannerEl) || document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bannerEl));
  }
  function removeBanner() { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }

  ipcRenderer.on('update:available', (_e, { version }) => {
    createBanner('update.available', { version }, 'update.now', async () => {
      const btn = document.getElementById('haven-update-btn');
      const msg = document.getElementById('haven-update-msg');
      if (btn) btn.disabled = true;
      setI18nText(msg, 'update.downloading');
      const res = await ipcRenderer.invoke('update:download');
      if (res?.errorKey) setI18nText(msg, res.errorKey);
      else if (res?.error) setI18nText(msg, 'update.failed', { error: res.error });
    });
  });
  ipcRenderer.on('update:download-progress', (_e, { percent }) => {
    const msg = document.getElementById('haven-update-msg');
    setI18nText(msg, 'update.downloadingProgress', { percent });
  });
  ipcRenderer.on('update:downloaded', () => {
    createBanner('update.downloaded', null, 'update.restartNow', () => ipcRenderer.send('update:install'));
  });
})();
