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

  // ── Update server name in history from public config ──
  const _serverUrl = _normalizeDesktopServerUrl();
  fetch('/api/public-config').then(r => r.json()).then(d => {
    if (d.server_title) {
      ipcRenderer.invoke('server-history:update-name', _serverUrl, d.server_title);
    }
  }).catch(() => {});

  // ── Login Page: Server Picker (desktop only) ─────────────────────────
  if (document.querySelector('.auth-page')) {
    const authContainer = document.querySelector('.auth-container');
    if (authContainer) {
      // Inject "Switch Server" button fixed to bottom of viewport
      const switchBtn = document.createElement('button');
      switchBtn.id = 'haven-switch-server-btn';
      switchBtn.textContent = '⬡ Switch Server';
      document.body.appendChild(switchBtn);

      // Build the server picker overlay
      const overlay = document.createElement('div');
      overlay.id = 'haven-server-picker-overlay';
      overlay.style.display = 'none';
      overlay.innerHTML = `
        <div id="haven-server-picker">
          <h3>Switch Server</h3>
          <div class="hsp-form">
            <input type="text" id="hsp-url-input" placeholder="https://haven.example.com" spellcheck="false" autocomplete="off">
            <button id="hsp-connect-btn">Connect</button>
          </div>
          <div id="hsp-error" class="hsp-error" style="display:none"></div>
          <div id="hsp-recent-section" style="display:none">
            <div class="hsp-divider-label">Recent Servers</div>
            <div id="hsp-recent-list"></div>
          </div>
          <button id="hsp-cancel-btn" class="hsp-cancel">Cancel</button>
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
          errorEl.textContent = 'Please enter a valid URL.';
          errorEl.style.display = 'block';
          return;
        }

        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting\u2026';

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(url + '/api/health', { signal: controller.signal }).catch(() => null);
          clearTimeout(timeout);

          if (!res || !res.ok) {
            errorEl.textContent = 'Could not reach server. Check the address and try again.';
            errorEl.style.display = 'block';
            return;
          }

          ipcRenderer.send('nav:change-primary-server', url);
        } catch {
          errorEl.textContent = 'Connection failed. Check the address and try again.';
          errorEl.style.display = 'block';
        } finally {
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect';
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
            ipcRenderer.send('nav:change-primary-server', entry.url);
          });

          const removeBtn = document.createElement('button');
          removeBtn.className = 'hsp-remove-btn';
          removeBtn.textContent = '\u00d7';
          removeBtn.title = 'Remove from history';
          removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await ipcRenderer.invoke('server-history:remove', entry.url);
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
let _audioPacketsReceived = 0;
// ─── Global voice shortcut triggers ──────────────────────
ipcRenderer.on('voice:mute-toggle',   () => document.getElementById('voice-mute-btn')?.click());
ipcRenderer.on('voice:deafen-toggle', () => document.getElementById('voice-deafen-btn')?.click());
ipcRenderer.on('voice:ptt-toggle',    () => document.getElementById('voice-mute-btn')?.click());

// PTT hold mode (#184): main fires -down on key/mouse press and -up on
// release. We unmute on press and re-mute on release iff that state
// transition is needed — the mute button is a toggle, so we only click
// it when its current visual state doesn't match the desired one.
function _pttSetTalking(shouldTalk) {
  const btn = document.getElementById('voice-mute-btn');
  if (!btn) return;
  // The mute button reflects mute state via aria-pressed / .muted /
  // its inner icon (varies by build). Use aria-pressed first, fall
  // back to a `.muted` class probe.
  const pressed = btn.getAttribute('aria-pressed');
  let isMuted;
  if (pressed === 'true' || pressed === 'false') {
    isMuted = pressed === 'true';
  } else {
    isMuted = btn.classList.contains('muted') || btn.classList.contains('is-muted');
  }
  // shouldTalk → want unmuted. Click only when state needs to flip.
  const needFlip = shouldTalk ? isMuted : !isMuted;
  if (needFlip) btn.click();
}
ipcRenderer.on('voice:ptt-down', () => _pttSetTalking(true));
ipcRenderer.on('voice:ptt-up',   () => _pttSetTalking(false));

// ─── Server badge state updates from main process ────────
ipcRenderer.on('server-badge-update', (_event, badgeMap) => {
  window.dispatchEvent(new CustomEvent('haven-server-badges', { detail: badgeMap }));
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
let _lastNativeStatus = null;
ipcRenderer.on('audio:capture-status', (_event, status) => {
  if (!status?.captureId || status.captureId !== _activeAudioCaptureId) return;
  _lastNativeStatus = status;
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
    window.__havenShareAudioMode = modeInfo;
    window.dispatchEvent(new CustomEvent('haven:share-audio-mode', { detail: modeInfo }));
  } catch (e) { console.warn('[Haven Desktop] dispatch share-mode event failed:', e.message); }
});
ipcRenderer.on('audio:capture-data', (_event, payload) => {
  if (!payload?.captureId || payload.captureId !== _activeAudioCaptureId) return;
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
    _audioWorkletNode.port.postMessage({ type: 'audio-data', samples });
  } else if (window._havenAppAudioPush) {
    window._havenAppAudioPush(samples);
  } else {
    _audioBufferQueue.push(samples);
  }
  _audioPacketsReceived++;
});

// ─── Listen for screen-picker request from main process ──
ipcRenderer.on('screen:show-picker', (_event, data) => {
  showScreenPicker(
    data?.sources || [],
    data?.audioApps || [],
    data?.audioCapabilities || {},
    data?.requestId || null
  );
});

// ═══════════════════════════════════════════════════════════
// Screen-Share Picker  (injected as a full-screen overlay)
// ═══════════════════════════════════════════════════════════

function getScreenPickerCopy() {
  const language = (document.documentElement?.lang || navigator.language || 'en').toLowerCase();
  if (language.startsWith('pt')) {
    return {
      title: 'Compartilhar tela',
      screens: 'Telas',
      windows: 'Janelas',
      audio: 'Áudio',
      noAudio: 'Sem áudio',
      systemAudio: 'Todo o áudio do sistema',
      applicationAudio: 'Áudio de um aplicativo',
      noApplications: 'Nenhum aplicativo reproduzindo áudio',
      systemUnavailable: 'Áudio do sistema indisponível',
      applicationUnavailable: 'Áudio de aplicativos indisponível',
      silent: 'silencioso',
      silentDescription: 'A captura começa quando o aplicativo reproduzir áudio.',
      noPreview: 'Sem prévia',
      cancel: 'Cancelar',
      share: 'Compartilhar',
    };
  }
  return {
    title: 'Share screen',
    screens: 'Screens',
    windows: 'Windows',
    audio: 'Audio',
    noAudio: 'No audio',
    systemAudio: 'All system audio',
    applicationAudio: 'Audio from one application',
    noApplications: 'No applications are playing audio',
    systemUnavailable: 'System audio unavailable',
    applicationUnavailable: 'Application audio unavailable',
    silent: 'silent',
    silentDescription: 'Capture starts when the application plays audio.',
    noPreview: 'No preview',
    cancel: 'Cancel',
    share: 'Share',
  };
}

function showScreenPicker(sources, audioApps, audioCapabilities, requestId) {
  const stalePicker = document.getElementById('haven-screen-picker');
  const staleRequestId = stalePicker?.dataset.requestId;
  if (staleRequestId && staleRequestId !== requestId) {
    ipcRenderer.send('screen:picker-result', { requestId: staleRequestId, cancelled: true });
  }
  stalePicker?.remove();

  const copy = getScreenPickerCopy();
  const canShareSystemAudio = audioCapabilities.system === true;
  const canShareApplicationAudio = audioCapabilities.application === true;
  const overlay = document.createElement('div');
  overlay.id = 'haven-screen-picker';
  overlay.dataset.requestId = requestId;
  overlay.innerHTML = `
    <style>
      #haven-screen-picker {
        position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999999;
        display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      }
      .hsp-box{background:#1a1a2e;border-radius:14px;padding:24px;max-width:900px;width:100%;
        max-height:calc(100vh - 36px);box-sizing:border-box;display:flex;flex-direction:column;
        border:1px solid rgba(107,79,219,.3);
        box-shadow:0 20px 60px rgba(0,0,0,.5);}
      .hsp-title{color:#f1f1f5;font-size:20px;font-weight:700;margin-bottom:18px;flex-shrink:0}
      .hsp-scroll{flex:1;overflow-y:auto;padding-right:6px;margin-right:-6px;min-height:0}
      .hsp-sec{margin-bottom:18px}
      .hsp-sec-title{color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;
        margin-bottom:8px;font-weight:700}
      .hsp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px}
      .hsp-src{appearance:none;background:#16213e;border-radius:8px;padding:8px;cursor:pointer;
        border:2px solid transparent;transition:border-color .2s,transform .15s;font:inherit;text-align:inherit}
      .hsp-src:hover{border-color:rgba(107,79,219,.5);transform:translateY(-1px)}
      .hsp-src.sel,.hsp-src:focus-visible{border-color:#8069e8;outline:none}
      .hsp-src img{width:100%;border-radius:4px;margin-bottom:6px;aspect-ratio:16/9;
        object-fit:cover;background:#0d0d1a}
      .hsp-src .hsp-thumb-ph{width:100%;border-radius:4px;margin-bottom:6px;aspect-ratio:16/9;
        background:linear-gradient(135deg,#0d0d1a,#1a1a2e);display:flex;align-items:center;
        justify-content:center;color:#777;font-size:11px;letter-spacing:.3px}
      .hsp-src-name{color:#ccc;font-size:12px;text-align:center;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      .hsp-audio{padding-top:18px;border-top:1px solid #2a2a4a}
      .hsp-app-title{color:#888;font-size:12px;margin:14px 0 8px}
      .hsp-apps{display:flex;flex-wrap:wrap;gap:8px}
      .hsp-app{appearance:none;background:#16213e;border-radius:7px;padding:9px 14px;cursor:pointer;
        border:2px solid transparent;transition:border-color .2s;display:flex;
        align-items:center;gap:8px;color:#ccc;font:inherit;font-size:13px;text-align:left}
      .hsp-app:hover{border-color:rgba(107,79,219,.5)}
      .hsp-app.sel,.hsp-app:focus-visible{border-color:#8069e8;outline:none}
      .hsp-app .ico{width:20px;height:20px}
      .hsp-empty{color:#777;font-size:12px;padding:4px 0}
      .hsp-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;flex-shrink:0}
      .hsp-btn{padding:8px 22px;border-radius:6px;border:none;font-size:14px;cursor:pointer;font-weight:600}
      .hsp-cancel{background:#333;color:#ccc}.hsp-cancel:hover{background:#444}
      .hsp-share{background:#6b4fdb;color:#fff}.hsp-share:hover{background:#7b5fe9}
      .hsp-share:disabled{opacity:.45;cursor:not-allowed}
      @media (max-width:600px){
        #haven-screen-picker{padding:10px}.hsp-box{padding:18px;max-height:calc(100vh - 20px)}
        .hsp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hsp-btn{flex:1}
      }
    </style>

    <div class="hsp-box" role="dialog" aria-modal="true" aria-labelledby="hsp-title">
      <div class="hsp-title" id="hsp-title">${copy.title}</div>

      <div class="hsp-scroll">
        <div class="hsp-sec" id="hsp-screens-section">
          <div class="hsp-sec-title">${copy.screens}</div>
          <div class="hsp-grid" id="hsp-screens"></div>
        </div>

        <div class="hsp-sec" id="hsp-windows-section">
          <div class="hsp-sec-title">${copy.windows}</div>
          <div class="hsp-grid" id="hsp-windows"></div>
        </div>

        <div class="hsp-audio">
          <div class="hsp-sec-title">${copy.audio}</div>
          <div class="hsp-apps" id="hsp-audio-modes"></div>
          <div class="hsp-app-title">${copy.applicationAudio}</div>
          <div class="hsp-apps" id="hsp-audio-apps"></div>
        </div>
      </div>

      <div class="hsp-btns">
        <button class="hsp-btn hsp-cancel" id="hsp-cancel" type="button">${copy.cancel}</button>
        <button class="hsp-btn hsp-share" id="hsp-go" type="button" disabled>${copy.share}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  let selSource = null;
  let selAudioPid = 'none';

  const screensEl  = document.getElementById('hsp-screens');
  const windowsEl  = document.getElementById('hsp-windows');
  const modesEl    = document.getElementById('hsp-audio-modes');
  const appsEl     = document.getElementById('hsp-audio-apps');
  const goBtn      = document.getElementById('hsp-go');

  // ── Populate video sources ─────────────────────────────
  sources.forEach(src => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'hsp-src';
    el.setAttribute('aria-pressed', 'false');
    if (src.thumbnail) {
      const preview = document.createElement('img');
      preview.src = src.thumbnail;
      preview.alt = '';
      el.appendChild(preview);
    } else {
      const preview = document.createElement('div');
      preview.className = 'hsp-thumb-ph';
      preview.textContent = copy.noPreview;
      el.appendChild(preview);
    }
    const sourceName = document.createElement('div');
    sourceName.className = 'hsp-src-name';
    sourceName.title = src.name;
    sourceName.textContent = src.name;
    el.appendChild(sourceName);
    el.onclick = () => {
      overlay.querySelectorAll('.hsp-src.sel').forEach(source => {
        source.classList.remove('sel');
        source.setAttribute('aria-pressed', 'false');
      });
      el.classList.add('sel');
      el.setAttribute('aria-pressed', 'true');
      selSource = src.id;
      goBtn.disabled = false;
    };
    (src.id.startsWith('screen:') ? screensEl : windowsEl).appendChild(el);
  });
  if (!screensEl.children.length) document.getElementById('hsp-screens-section').hidden = true;
  if (!windowsEl.children.length) document.getElementById('hsp-windows-section').hidden = true;

  const selectAudio = (element, value) => {
    overlay.querySelectorAll('.hsp-app.sel').forEach(option => {
      option.classList.remove('sel');
      option.setAttribute('aria-pressed', 'false');
    });
    element.classList.add('sel');
    element.setAttribute('aria-pressed', 'true');
    selAudioPid = value;
  };

  const createAudioOption = (label, icon, value, selected = false) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `hsp-app${selected ? ' sel' : ''}`;
    element.setAttribute('aria-pressed', selected ? 'true' : 'false');
    element.appendChild(document.createTextNode(`${icon} ${label}`));
    element.onclick = () => selectAudio(element, value);
    return element;
  };

  modesEl.appendChild(createAudioOption(copy.noAudio, '🔇', 'none', true));
  if (canShareSystemAudio) {
    modesEl.appendChild(createAudioOption(copy.systemAudio, '🔊', 'system'));
  } else {
    const unavailable = document.createElement('div');
    unavailable.className = 'hsp-empty';
    unavailable.textContent = copy.systemUnavailable;
    modesEl.appendChild(unavailable);
  }

  if (canShareApplicationAudio && audioApps.length) {
    audioApps.forEach(a => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'hsp-app';
      el.setAttribute('aria-pressed', 'false');
      if (a.active === false) el.style.opacity = '0.55';
      if (a.icon) {
        const icon = document.createElement('img');
        icon.className = 'ico';
        icon.src = a.icon;
        icon.alt = '';
        el.appendChild(icon);
      } else {
        el.appendChild(document.createTextNode('🔊'));
      }
      const name = document.createElement('span');
      name.textContent = a.name;
      if (a.active === false) name.appendChild(document.createTextNode(` (${copy.silent})`));
      el.appendChild(name);
      el.title = a.active === false
        ? copy.silentDescription
        : a.name;
      el.onclick = () => selectAudio(el, a.pid);
      appsEl.appendChild(el);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'hsp-empty';
    empty.textContent = canShareApplicationAudio
      ? copy.noApplications
      : copy.applicationUnavailable;
    appsEl.appendChild(empty);
  }

  // ── Cancel ─────────────────────────────────────────────
  let dismissed = false;
  const dismiss = async (cancelled) => {
    if (dismissed) return; // prevent double-dismiss
    dismissed = true;
    overlay.remove();
    document.removeEventListener('keydown', escHandler);

    // Restore focus to the main window content (prevents Wayland focus loss)
    try { document.body?.focus(); window.focus(); } catch {}

    let effectiveAudioPid = selAudioPid;
    if (!cancelled) {
      teardownAudioPipeline(_activeAudioCaptureId);
      _activeShareId = requestId;
    }

    const wantsNativePipeline = (Number.isSafeInteger(selAudioPid) && selAudioPid > 0)
      || (selAudioPid === 'system' && audioCapabilities.systemNative === true);
    if (!cancelled && wantsNativePipeline) {
      _activeAudioCaptureId = requestId;
      _capturedAudioPid = selAudioPid;
      console.log(`[Haven Desktop] Picker dismissed: building native audio pipeline for ${selAudioPid}`);
      const pipelineOk = await buildAudioPipeline();
      if (!pipelineOk) {
        console.warn('[Haven Desktop] Local audio pipeline failed to build; continuing without audio');
        teardownAudioPipeline(requestId);
        effectiveAudioPid = 'none';
      }
    }

    _pendingShareId = requestId;
    ipcRenderer.send('screen:picker-result', cancelled
      ? { requestId, cancelled: true }
      : { requestId, sourceId: selSource, audioAppPid: effectiveAudioPid });
  };

  document.getElementById('hsp-cancel').onclick = () => dismiss(true);
  goBtn.onclick = () => dismiss(false);

  // Also dismiss on overlay background click (outside the box)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(true); });

  const escHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(true); } };
  document.addEventListener('keydown', escHandler, true);
}

// ═══════════════════════════════════════════════════════════
// Audio-Capture Pipeline
//
// Receives PCM from the native addon via IPC, pipes it through
// an AudioWorklet, and exposes a MediaStreamTrack that replaces
// the system-loopback track on the screen-share MediaStream.
// ═══════════════════════════════════════════════════════════

async function buildAudioPipeline() {
  // Reset arrival counters so the getDisplayMedia override's readiness
  // check reflects ONLY this capture session, never a stale prior one.
  _audioPacketsReceived = 0;
  _ipcDataCount = 0;
  _audioBufferQueue = [];

  // Try AudioWorklet first, fall back to ScriptProcessorNode if it fails
  // (AudioWorklet blob URLs can fail in some Electron/BrowserView contexts)
  try {
    _audioCtx = new AudioContext({ sampleRate: 48000 });
    // Explicitly resume — BrowserView contexts may start suspended
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();

    // Inline AudioWorklet processor (blob URL avoids CSP / file issues)
    const workletSrc = `
      class AppAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._ring   = new Float32Array(96000);   // 2 s ring buffer
          this._wPos   = 0;
          this._rPos   = 0;
          this._avail  = 0;

          this.port.onmessage = (e) => {
            if (e.data.type !== 'audio-data') return;
            const s = e.data.samples;
            for (let i = 0; i < s.length; i++) {
              this._ring[this._wPos] = s[i];
              this._wPos = (this._wPos + 1) % this._ring.length;
            }
            this._avail = Math.min(this._avail + s.length, this._ring.length);
          };
        }

        process(_inputs, outputs) {
          const out = outputs[0];
          if (!out || !out.length) return true;
          const buf = out[0];
          const len = buf.length;

          if (this._avail < len) { buf.fill(0); return true; }

          for (let i = 0; i < len; i++) {
            buf[i] = this._ring[this._rPos];
            this._rPos = (this._rPos + 1) % this._ring.length;
          }
          this._avail -= len;

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
      _audioWorkletNode.port.postMessage({ type: 'audio-data', samples: buf })
    );
    _audioBufferQueue = [];

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
  }

  // ── Fallback: ScriptProcessorNode (works in all Electron versions) ──
  try {
    _audioCtx = new AudioContext({ sampleRate: 48000 });
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();

    const bufSize = 4096;
    // Use 1 input channel (not 0).  A "generator" ScriptProcessor with
    // 0 inputs may not have its onaudioprocess callback pumped reliably
    // in Electron / BrowserView environments.  Connecting a live source
    // to the input guarantees Chromium's audio thread drives the node.
    const scriptNode = _audioCtx.createScriptProcessor(bufSize, 1, 2);
    const ring   = new Float32Array(96000);
    let   wPos   = 0;
    let   rPos   = 0;
    let   avail  = 0;
    let   _spProcessCount = 0;

    // Store a push function that the IPC handler can call
    window._havenAppAudioPush = (samples) => {
      for (let i = 0; i < samples.length; i++) {
        ring[wPos] = samples[i];
        wPos = (wPos + 1) % ring.length;
      }
      avail = Math.min(avail + samples.length, ring.length);
    };

    scriptNode.onaudioprocess = (e) => {
      _spProcessCount++;
      const out = e.outputBuffer.getChannelData(0);
      if (avail < out.length) { out.fill(0); } else {
        for (let i = 0; i < out.length; i++) {
          out[i] = ring[rPos];
          rPos = (rPos + 1) % ring.length;
        }
        avail -= out.length;
      }
      // Copy mono to stereo
      const out1 = e.outputBuffer.getChannelData(1);
      out1.set(out);
      // Periodic diagnostic
      if (_spProcessCount === 1 || _spProcessCount % 200 === 0) {
        const peak = Math.max(...Array.from(out.slice(0, 128)).map(Math.abs));
        console.log(`[Haven Desktop] ScriptProcessor process #${_spProcessCount}, avail=${avail}, peak=${peak.toFixed(4)}`);
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
        const stepMs    = 100;
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

      // An older video track must not tear down a newer share.
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (_activeShareId !== shareId) return;
        teardownAudioPipeline(captureId);
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

  /** Switch to another Haven server inside the app window (hot-swap) */
  switchServer: (url) => ipcRenderer.send('nav:switch-server', url),

  /** Go back to the welcome / setup screen */
  backToWelcome: () => ipcRenderer.send('nav:back-to-welcome'),

  /** Auto-update controls */
  update: {
    download: () => ipcRenderer.invoke('update:download'),
    install:  () => ipcRenderer.send('update:install'),
  },

  audio: {
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
    setConfig: (updates)  => ipcRenderer.invoke('shortcuts:register', updates),
  },

  /** Signal the taskbar/dock badge (no native notification needed) */
  setUnreadBadge: (hasUnread) => ipcRenderer.send('notification-badge', hasUnread),

  settings: {
    get: (key)       => ipcRenderer.invoke('settings:get', key),
    set: (key, val)  => ipcRenderer.invoke('settings:set', key, val),
  },

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

  /** Access the Desktop-level server history (persists across all servers) */
  getServerHistory: () => ipcRenderer.invoke('server-history:get'),
  addServerHistory: (url, name) => ipcRenderer.invoke('server-history:add', url, name),
  removeServerHistory: (url) => ipcRenderer.invoke('server-history:remove', url),

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

  function createBanner(text, buttonLabel, buttonAction) {
    removeBanner();
    bannerEl = document.createElement('div');
    bannerEl.id = 'haven-update-banner';
    bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999998;background:linear-gradient(135deg,#6b4fdb,#8b6ce7);color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    const msg = document.createElement('span');
    msg.textContent = text;
    msg.id = 'haven-update-msg';
    bannerEl.appendChild(msg);
    if (buttonLabel) {
      const btn = document.createElement('button');
      btn.textContent = buttonLabel;
      btn.id = 'haven-update-btn';
      btn.style.cssText = 'background:#fff;color:#6b4fdb;border:none;border-radius:4px;padding:4px 14px;font-weight:600;cursor:pointer;font-size:12px;';
      btn.onclick = buttonAction;
      bannerEl.appendChild(btn);
    }
    const close = document.createElement('button');
    close.textContent = '✕';
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
      `Haven Desktop v${version} is available!`,
      'Update Now',
      async () => {
        const btn = document.getElementById('haven-update-btn');
        const msg = document.getElementById('haven-update-msg');
        if (btn) btn.disabled = true;
        if (msg) msg.textContent = 'Downloading update...';
        const res = await ipcRenderer.invoke('update:download');
        if (res?.error) {
          if (msg) msg.textContent = `Update failed: ${res.error}`;
        }
      }
    );
  });

  ipcRenderer.on('update:download-progress', (_e, { percent }) => {
    const msg = document.getElementById('haven-update-msg');
    if (msg) msg.textContent = `Downloading update... ${percent}%`;
  });

  ipcRenderer.on('update:downloaded', () => {
    createBanner(
      'Update downloaded! Restart to apply.',
      'Restart Now',
      () => ipcRenderer.send('update:install')
    );
  });

  ipcRenderer.on('update:error', (_e, { message }) => {
    const msg = document.getElementById('haven-update-msg');
    if (msg) msg.textContent = `Update error: ${message}`;
  });
})();
