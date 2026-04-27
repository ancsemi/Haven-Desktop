// ═══════════════════════════════════════════════════════════
// Haven Desktop — Main Process
// ═══════════════════════════════════════════════════════════

const {
  app, BrowserWindow, BrowserView, ipcMain, Notification, Tray, Menu,
  nativeImage, desktopCapturer, session, dialog, shell, screen, globalShortcut
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const Store = require('electron-store');
const { ServerManager }      = require('./server-manager');
const { AudioCaptureManager } = require('./audio-capture');

// ── Auto-Updater (electron-updater) ───────────────────────
let autoUpdater;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// ── Constants ─────────────────────────────────────────────
// ── Enable native Wayland support (must be before app.whenReady) ──
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

const IS_DEV    = process.argv.includes('--dev');
const SHOW_SERVER  = process.argv.includes('--show-server');
const START_HIDDEN = process.argv.includes('--hidden');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// ── Persistent Store ──────────────────────────────────────
const store = new Store({
  defaults: {
    userPrefs: {
      mode: null,             // 'host' | 'join'
      serverUrl: null,        // last-connected server URL
      serverPath: null,       // path to Haven server dir (for hosting)
      skipWelcome: false,     // remember choice
      audioInput:  null,      // preferred mic device ID
      audioOutput: null,      // preferred speaker device ID
    },
    windowBounds: { width: 1200, height: 800 },
    desktopShortcuts: {
      mute:   'CommandOrControl+Shift+M',  // toggle mute
      deafen: 'CommandOrControl+Shift+D',  // toggle deafen
      ptt:    '',                           // push-to-talk (empty = disabled)
    },
    startOnLogin:   false,    // launch Haven Desktop on OS login
    startHidden:    false,    // start minimized to tray (when startOnLogin is enabled)
    minimizeToTray: false,    // close button hides to tray instead of quitting
    forceSDR:       false,    // force sRGB color profile (fixes HDR over-saturation)
    hideMenuBar:    false,    // hide the File/Edit/View/Window/Help menu bar
    serverHistory:  [],       // [{url, name, lastConnected}] — recent server connections
  },
});

// ── Force sRGB color profile when user has HDR issues (must be before app.whenReady) ──
if (store.get('forceSDR')) {
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
}

// ── Suppress Chrome Autofill CDP warnings (harmless but noisy on startup) ──
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');

// ── Suppress Chromium stderr noise (WGC ProcessFrame spam, GPU errors, etc.) ──
// disable-logging shuts down Chromium's logging system across ALL subprocesses
// (browser, renderer, GPU).  --log-level only affects the browser process,
// but the WGC ProcessFrame flood originates from the GPU process.
app.commandLine.appendSwitch('disable-logging');

// ── Memory management: keep the renderer lean ──────────────
// The Oilpan OOM crash is in Chromium's C++ DOM-object allocator, which is
// separate from V8's JS heap.  Raising V8 to 512 MB gives the RGB theme cycle,
// canvas effects, and message rendering more headroom so the GC fires less
// frequently (GC pauses were a significant contributor to the progressive
// slowdown reported as "hover gets slower over 5 minutes").
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
// Reduce GPU process memory usage — Haven doesn't need heavy GPU compositing
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
// Limit image decode cache (large images/gifs can balloon memory)
app.commandLine.appendSwitch('image-decode-ct', '3');
// NOTE: 'disable-renderer-backgrounding' was removed — it prevented Chromium
// from throttling timers when the window was unfocused, causing all intervals
// (clock, ping, server polling, voice analysers) to run at full speed 24/7.
// This contributed to renderer freezes by starving the event loop.
// Cap the GPU-process memory budget so decoded textures don't eat into
// the reservation Oilpan needs for large DOM allocations.
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '256');

// ── State ─────────────────────────────────────────────────
let mainWindow      = null;
let welcomeWindow   = null;
let tray            = null;
let serverManager   = null;
let audioCapture    = null;
let serverViews     = new Map();  // serverUrl → BrowserView
let activeServerUrl = null;
let primaryServerUrl = null;       // the server the user actually chose to connect to
let badgeIcon       = null;
let serverBadgeState = new Map();  // serverUrl → boolean (true = has unreads)
// senderUrl → Set<normalizedUrl> of servers that view's sidebar can display.
// Used to filter the taskbar overlay so a background BrowserView with
// unreads doesn't light the badge when no open view has a visible icon
// for that server (orphan / phantom badge). (#5269)
let knownServerUrlsByView = new Map();
let _logBuf = '', _logTimer = null;  // server log batch buffer (module-scope so crash handler can clear)

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

function buildServerAppUrl(serverUrl) {
  return normalizeServerUrl(serverUrl) + '/app.html';
}

// ── Single-Instance Lock ──────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => {
    const win = mainWindow || welcomeWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// ═══════════════════════════════════════════════════════════
// Self-Signed Certificate Handling
//
// Haven servers often use self-signed certs for localhost.
// Accept them for local connections so the app can load.
// ═══════════════════════════════════════════════════════════

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Haven servers commonly use self-signed certs.
  // Accept them so users can connect to LAN / remote servers without a blank screen.
  event.preventDefault();
  callback(true);
});

// ═══════════════════════════════════════════════════════════
// Session-Level Certificate Bypass
//
// The 'certificate-error' event above only fires for navigation
// (page loads).  WebSocket, fetch, and XHR connections go through
// Chromium's network stack directly, where self-signed cert
// failures flood ssl_client_socket_impl with rapid-fire errors.
// Each error allocates renderer-heap objects; in a Socket.IO
// reconnection storm the renderer OOMs and the screen goes blank.
//
// setCertificateVerifyProc handles ALL connections — navigation
// *and* sub-resources — at a level above the C++ TLS code, so
// the handshake never fails and no error objects accumulate.
// ═══════════════════════════════════════════════════════════
app.on('ready', () => {
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0); // 0 = chromium net::OK — accept the certificate
  });
});

// ═══════════════════════════════════════════════════════════
// App Lifecycle
// ═══════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  serverManager = new ServerManager(store, { showConsole: SHOW_SERVER || IS_DEV });
  audioCapture  = new AudioCaptureManager();
  badgeIcon     = createBadgeIcon();

  // ── Sync start-on-login with OS ──────────────────────
  const loginEnabled = !!store.get('startOnLogin');
  const hiddenArg    = store.get('startHidden') ? ['--hidden'] : [];
  app.setLoginItemSettings({
    openAtLogin: loginEnabled,
    args: loginEnabled ? hiddenArg : [],
  });

  // ── Auto-update check (issue #3) ──────────────────────
  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
      safeSend(getActiveContents() || welcomeWindow?.webContents, 'update:available', { version: info.version });
    });
    autoUpdater.on('download-progress', (progress) => {
      safeSend(getActiveContents() || welcomeWindow?.webContents, 'update:download-progress', { percent: Math.round(progress.percent) });
    });
    autoUpdater.on('update-downloaded', () => {
      safeSend(getActiveContents() || welcomeWindow?.webContents, 'update:downloaded');
    });
    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdate] Error:', err.message);
      safeSend(getActiveContents() || welcomeWindow?.webContents, 'update:error', { message: err.message });
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }

  // ── Linux desktop integration (issue #3) ──────────────
  if (process.platform === 'linux') installLinuxDesktopEntry();

  // Forward server log lines to whichever renderer window is active.
  // Batched to 50 ms to avoid overwhelming the renderer with rapid IPC sends
  // during server startup / reconnect bursts.
  serverManager.onLog((msg) => {
    _logBuf += msg;
    if (_logTimer) return;
    _logTimer = setTimeout(() => {
      const batch = _logBuf;
      _logBuf = ''; _logTimer = null;
      safeSend(getActiveContents() || welcomeWindow?.webContents, 'server:log', batch);
    }, 50);
  });

  // Auto-grant camera, mic, screen-share, fullscreen, and PiP permissions for all server views
  const ALLOWED_PERMS = ['media', 'mediaKeySystem', 'display-capture', 'notifications', 'fullscreen', 'window-management', 'picture-in-picture', 'clipboard-write', 'clipboard-read'];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED_PERMS.includes(permission);
  });

  registerIPC();
  registerScreenShareHandler();
  registerVoiceShortcuts();

  const prefs = store.get('userPrefs');

  if (prefs.skipWelcome && prefs.mode && prefs.serverUrl) {
    // Returning user — remembered preferences
    if (prefs.mode === 'host' && prefs.serverPath) {
      const res = await serverManager.startServer(prefs.serverPath);
      if (!res.success) { createWelcomeWindow(); createTray(); return; }
      console.log(`[Haven Desktop] Server started at ${res.url} (port ${res.port})`);
      // Use the fresh URL (protocol may have changed between http/https)
      createAppWindow(res.url || prefs.serverUrl);
    } else {
      createAppWindow(prefs.serverUrl);
    }
  } else {
    createWelcomeWindow();
  }

  createTray();

  // ── Global shortcut: Ctrl+Shift+Home to reset to welcome screen ──
  // This is the escape hatch for users who are soft-locked into a broken server
  globalShortcut.register('CommandOrControl+Shift+Home', () => {
    if (mainWindow) resetToWelcome(true); // full reset — user explicitly requested
  });
});

// ── Voice / PTT global shortcuts ───────────────────────
function unregisterVoiceShortcuts() {
  const cfg = store.get('desktopShortcuts') || {};
  ['mute', 'deafen', 'ptt'].forEach(k => {
    try { if (cfg[k]) globalShortcut.unregister(cfg[k]); } catch {}
  });
}

function registerVoiceShortcuts() {
  unregisterVoiceShortcuts();
  const cfg = store.get('desktopShortcuts') || {};
  const bind = (accel, event) => {
    if (!accel) return;
    try {
      globalShortcut.register(accel, () => {
        safeSend(getActiveContents(), event);
      });
    } catch (e) {
      console.warn(`[Shortcuts] Failed to register ${accel}:`, e.message);
    }
  };
  bind(cfg.mute,   'voice:mute-toggle');
  bind(cfg.deafen, 'voice:deafen-toggle');
  bind(cfg.ptt,    'voice:ptt-toggle');
}

// ── Reset to welcome screen ─────────────────────────────
// clearPrefs=true only when the user explicitly requests a full reset
// (Ctrl+Shift+Home). Automatic failures (load errors, etc.) use the default
// clearPrefs=false so the stored server path survives and next launch retries.
function resetToWelcome(clearPrefs = false) {
  serverManager?.stopServer();
  // Clean up all BrowserViews
  for (const [url, view] of serverViews) {
    mainWindow?.removeBrowserView(view);
    try { view.webContents.destroy(); } catch {}
  }
  serverViews.clear();
  serverBadgeState.clear();
  knownServerUrlsByView.clear();
  activeServerUrl = null;
  primaryServerUrl = null;
  if (clearPrefs) {
    // Full reset — user explicitly chose to forget their server
    store.set('userPrefs.skipWelcome', false);
    store.set('userPrefs.serverUrl', null);
    store.set('userPrefs.mode', null);
  }
  mainWindow?.close();
  createWelcomeWindow();
  createTray();
}

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  serverManager?.stopServer();
  audioCapture?.cleanup();
});

// ═══════════════════════════════════════════════════════════
// Window Factories
// ═══════════════════════════════════════════════════════════

function createWelcomeWindow() {
  welcomeWindow = new BrowserWindow({
    width: 720, height: 560,
    minWidth: 620, minHeight: 480,
    resizable: false,
    frame: false,
    backgroundColor: '#0d0d1a',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  welcomeWindow.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow.show();
    if (IS_DEV) welcomeWindow.webContents.openDevTools({ mode: 'detach' });
  });
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function createAppWindow(serverUrl) {
  if (!mainWindow) {
    const bounds = store.get('windowBounds');
    mainWindow = new BrowserWindow({
      ...bounds,
      minWidth: 800, minHeight: 600,
      frame: true,
      autoHideMenuBar: !!store.get('hideMenuBar'),
      backgroundColor: '#0d0d1a',
      icon: ICON_PATH,
      show: false,
    });

    const saveBounds = () => {
      if (!mainWindow || mainWindow.isMaximized()) return;
      const b = mainWindow.getBounds();
      store.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
    };
    mainWindow.on('resize', saveBounds);
    mainWindow.on('move',   saveBounds);

    // ── Minimize-to-tray: intercept close if enabled ──
    mainWindow.on('close', (e) => {
      if (!app.isQuitting && store.get('minimizeToTray')) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // Badge is cleared by the web app when unreads reach zero, not on raw focus.
    // Clearing on focus caused the overlay to vanish even while unreads remained.
    mainWindow.on('closed', () => {
      serverViews.clear();
      serverBadgeState.clear();
      knownServerUrlsByView.clear();
      activeServerUrl = null;
      primaryServerUrl = null;
      mainWindow = null;
    });
  }

  // Track the user's chosen server so load failures on peer links don't wipe the session
  if (!primaryServerUrl) {
    try { primaryServerUrl = new URL(serverUrl).origin; } catch { primaryServerUrl = serverUrl; }
  }

  switchToServer(serverUrl);

  // Pre-load background BrowserViews for the user's other known servers so
  // their unread counts can light up the sidebar dots in real time. Toggle
  // via Desktop settings (default: on). Capped to keep RAM usage reasonable.
  scheduleBackgroundServerPreload(serverUrl);

  if (!mainWindow.isVisible() && !START_HIDDEN) {
    mainWindow.show();
    if (welcomeWindow) welcomeWindow.close();
  } else if (START_HIDDEN && welcomeWindow) {
    welcomeWindow.close();
  }
}

// ── Multi-Server View Management ────────────────────────────

function switchToServer(serverUrl) {
  const url = normalizeServerUrl(serverUrl);
  if (!mainWindow) return;

  // Reuse a pre-created background view if one exists, otherwise create
  ensureServerView(url);
  const view = serverViews.get(url);
  if (!view) return;

  mainWindow.setTopBrowserView(view);
  activeServerUrl = url;

  // Save to server history
  const _hist = store.get('serverHistory') || [];
  const _hIdx = _hist.findIndex(h => h.url === url);
  if (_hIdx >= 0) {
    _hist[_hIdx].lastConnected = Date.now();
  } else {
    _hist.push({ url, name: url, lastConnected: Date.now() });
  }
  while (_hist.length > 20) _hist.shift();
  store.set('serverHistory', _hist);
}

// Pre-create a BrowserView for a server WITHOUT making it the visible/active
// view. Lets background servers run their renderer (and thus their socket
// connections) so per-server unread badges can light up on the sidebar of
// the active view. Idempotent — second call for the same URL is a no-op.
function ensureServerView(serverUrl, { background = false } = {}) {
  const url = normalizeServerUrl(serverUrl);
  if (!mainWindow) return null;
  let view = serverViews.get(url);
  if (view) return view;

  {
    view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, 'app-preload.js'),
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
      },
    });
    mainWindow.addBrowserView(view);
    const [w, h] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
    view.setAutoResize({ width: true, height: true });

    view.webContents.loadURL(buildServerAppUrl(url));

    // ── Forward renderer performance logs to main process console ──
    // The renderer's automatic perf diagnostics use console.warn/log with
    // a [Haven Perf] prefix.  Capture those here so they appear in the
    // server console panel and Electron's stdout for post-mortem analysis.
    view.webContents.on('console-message', (_e, level, message) => {
      if (message.startsWith('[Haven Perf')) {
        // level: 0=verbose, 1=info, 2=warning, 3=error
        if (level >= 2) console.warn('[Renderer]', message);
        else            console.log('[Renderer]', message);
      }
    });

    // BrowserView keyboard accelerators can fail to trigger Chromium's
    // built-in copy command on some Windows setups. Forward Ctrl/Cmd+C
    // explicitly so selected message text reaches the clipboard.
    view.webContents.on('before-input-event', (event, input) => {
      const isCopy = input.type === 'keyDown'
        && !input.isAutoRepeat
        && (input.control || input.meta)
        && !input.alt
        && String(input.key || '').toLowerCase() === 'c';
      if (!isCopy) return;
      event.preventDefault();
      try { view.webContents.copy(); } catch {}
    });

    // ── Page load timeout — if no content after 15 s, offer to go back ──
    // Background-preloaded views are silent: they never show user dialogs.
    // If they fail to load, they're cleaned up quietly so unread-badge
    // pre-loading doesn't surface as a scary popup on launch.
    let loadResolved = false;
    view.webContents.once('did-finish-load', async () => {
      loadResolved = true;
      // Check that the page is actually a Haven server by looking for a
      // Haven-specific element. Catches the case where the server URL now
      // points to a reverse proxy error page or a completely different site.
      // Check both the app page (#app-body) and the login page (.auth-page).
      const isHaven = await view.webContents.executeJavaScript(
        '!!(document.getElementById("app-body") || document.querySelector(".auth-page") || document.title.startsWith("Haven"))'
      ).catch(() => false);
      if (isHaven || !mainWindow || mainWindow.isDestroyed()) return;
      if (background) {
        // Silent cleanup — don't bother the user about a background preload
        mainWindow?.removeBrowserView(view);
        try { view.webContents.destroy(); } catch {}
        serverViews.delete(url);
        serverBadgeState.delete(url);
        knownServerUrlsByView.delete(url);
        recomputeTaskbarBadge();
        return;
      }
      {
        const isSecondary = primaryServerUrl && url !== primaryServerUrl;
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: [isSecondary ? 'Go Back to My Server' : 'Change Server', 'Keep Loading'],
          defaultId: 0,
          title: 'Haven Not Found',
          message: `The page at ${url} doesn't look like a Haven server.\n\nThis can happen if the server moved to a new address or the URL is wrong.`,
        });
        if (response === 0) {
          if (isSecondary) {
            // Clean up the failed secondary view and return to primary
            mainWindow?.removeBrowserView(view);
            try { view.webContents.destroy(); } catch {}
            serverViews.delete(url);
            serverBadgeState.delete(url);
            knownServerUrlsByView.delete(url);
            recomputeTaskbarBadge();
            switchToServer(primaryServerUrl);
          } else {
            resetToWelcome(true);
          }
        }
      }
    });
    setTimeout(() => {
      if (loadResolved || !mainWindow) return;
      // Check if the page actually has content (async — never blocks renderer or main)
      view.webContents.executeJavaScript('document.body?.innerText?.length || 0').then(async (len) => {
        if (len > 20) return; // Page has content, it's fine
        if (background) {
          // Background preload silently failed to load \u2014 just clean up
          mainWindow?.removeBrowserView(view);
          try { view.webContents.destroy(); } catch {}
          serverViews.delete(url);
          serverBadgeState.delete(url);
          knownServerUrlsByView.delete(url);
          recomputeTaskbarBadge();
          return;
        }
        const isSecondary = primaryServerUrl && url !== primaryServerUrl;
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: [isSecondary ? 'Go Back to My Server' : 'Go Back to Welcome', 'Keep Waiting'],
          defaultId: 0,
          title: 'Connection Problem',
          message: `Haven couldn't load the server at ${url}.\n\nThis could mean the server is down, the address is wrong, or there's a network issue.`,
        });
        if (response === 0) {
          if (isSecondary) {
            mainWindow?.removeBrowserView(view);
            try { view.webContents.destroy(); } catch {}
            serverViews.delete(url);
            serverBadgeState.delete(url);
            knownServerUrlsByView.delete(url);
            recomputeTaskbarBadge();
            switchToServer(primaryServerUrl);
          } else {
            resetToWelcome();
          }
        }
      }).catch(() => {});
    }, 15000);

    // ── Handle load failures — only reset to welcome for the primary server ──
    // Retry briefly on transient errors (server restart, brief outage) before
    // giving up and dumping the user back to the welcome screen.
    let _failRetryCount = 0;
    const MAX_FAIL_RETRIES = 6; // ~30 s total at 5 s back-off
    view.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedUrl, isMainFrame) => {
      // Ignore subframe failures (iframes, ads, etc.) — only the main page matters.
      if (isMainFrame === false) return;
      console.error(`[Haven Desktop] Failed to load ${url}: ${errorCode} ${errorDesc}`);
      // -3 ABORTED = navigation cancelled (e.g. another nav started). Ignore.
      if (errorCode === -3) return;

      // Background preload views never retry — they're best-effort badge
      // pollers. Let the existing background-cleanup branch below handle them.
      const TRANSIENT = new Set([
        -102, // CONNECTION_REFUSED
        -106, // INTERNET_DISCONNECTED
        -109, // ADDRESS_UNREACHABLE
        -118, // CONNECTION_TIMED_OUT
        -7,   // TIMED_OUT
        -21,  // NETWORK_CHANGED
        -101, // CONNECTION_RESET
        -105, // NAME_NOT_RESOLVED
        -130, // PROXY_CONNECTION_FAILED
        -324, // EMPTY_RESPONSE
      ]);
      if (!background && TRANSIENT.has(errorCode) && _failRetryCount < MAX_FAIL_RETRIES) {
        _failRetryCount++;
        const delay = Math.min(5000, 1000 * Math.pow(2, _failRetryCount - 1));
        console.warn(`[Haven Desktop] Transient load failure (${errorCode}), retry ${_failRetryCount}/${MAX_FAIL_RETRIES} in ${delay}ms…`);
        setTimeout(() => {
          // The view may have been torn down (window closed, server switched,
          // crash recovery, etc.) between scheduling and firing. Guard every
          // hop — webContents itself becomes undefined after .destroy().
          if (!mainWindow || mainWindow.isDestroyed?.()) return;
          if (!view || !view.webContents) return;
          try { if (view.webContents.isDestroyed()) return; } catch { return; }
          try { view.webContents.loadURL(url); } catch {}
        }, delay);
        return;
      }

      loadResolved = true;
      if (url !== primaryServerUrl) {
        // A peer/secondary server failed — clean up and return to the primary view silently
        mainWindow?.removeBrowserView(view);
        try { view.webContents.destroy(); } catch {}
        serverViews.delete(url);
        serverBadgeState.delete(url);
        knownServerUrlsByView.delete(url);
        recomputeTaskbarBadge();
        if (primaryServerUrl && serverViews.has(primaryServerUrl)) {
          switchToServer(primaryServerUrl);
          const wc = serverViews.get(primaryServerUrl)?.webContents;
          if (wc && !wc.isDestroyed()) {
            wc.executeJavaScript(`
              if (typeof app !== 'undefined' && typeof app._showToast === 'function') {
                app._showToast("Couldn't connect to that server", 'error');
              }
            `).catch(() => {});
          }
        } else {
          resetToWelcome();
        }
        return;
      }
      resetToWelcome();
    });

    // Reset retry counter once a load succeeds, so a future failure starts
    // fresh and we don't burn the budget over many brief outages.
    view.webContents.on('did-finish-load', () => { _failRetryCount = 0; });

    // ── Open external links in default browser (issue #5) ──
    // Allow navigations to known embed origins (SoundCloud, Spotify, YouTube)
    // so iframes work correctly instead of hijacking the main view.
    const EMBED_ORIGINS = [
      'https://w.soundcloud.com',
      'https://open.spotify.com',
      'https://www.youtube.com',
      'https://www.youtube-nocookie.com',
    ];
    view.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const navOrigin = new URL(navUrl).origin;
        if (navOrigin === new URL(url).origin) return;
        if (EMBED_ORIGINS.includes(navOrigin)) return;
        event.preventDefault();
        shell.openExternal(navUrl);
      } catch {}
    });

    // Intercept window.open → switch servers or open external.
    // Same-origin popups (e.g. game pop-out) open in a real child window;
    // cross-origin links go to the system browser.
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      try {
        const parsedOpen = new URL(openUrl);
        const parsedServer = new URL(url);
        if (parsedOpen.origin === parsedServer.origin) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 800,
              height: 900,
              autoHideMenuBar: true,
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
              }
            }
          };
        }
      } catch {}
      handleWindowOpen(openUrl);
      return { action: 'deny' };
    });

    // ── Auto-recover from renderer crashes ──
    // When the BrowserView's renderer dies the screen goes blank with no
    // automatic recovery.  Re-load the page after a short pause.
    // Uses exponential back-off, and after exhausting retries, performs a
    // full BrowserView tear-down + rebuild so the user never sees a
    // permanent blank screen.
    let _crashCount = 0;
    const MAX_CRASH_RETRIES = 5;
    const CRASH_WINDOW_MS  = 60000; // reset counter after 1 min of stability
    let _crashStabilityTimer = null;
    view.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      _crashCount++;

      // Immediately kill the pending log-batch timer so safeSend doesn't
      // try to IPC into the now-dead renderer frame.
      if (_logTimer) { clearTimeout(_logTimer); _logTimer = null; _logBuf = ''; }

      // Stop monitoring intervals — the renderer is dead, executing JS or
      // querying memory on it will throw.
      if (_memCheckInterval) { clearInterval(_memCheckInterval); _memCheckInterval = null; }
      if (_healthCheckInterval) { clearInterval(_healthCheckInterval); _healthCheckInterval = null; }

      console.warn(`[Haven Desktop] Renderer crashed (${details.reason}) for ${url} [${_crashCount}/${MAX_CRASH_RETRIES}], reloading…`);

      // Clear any previous stability timer
      if (_crashStabilityTimer) { clearTimeout(_crashStabilityTimer); _crashStabilityTimer = null; }

      if (_crashCount > MAX_CRASH_RETRIES) {
        // Nuclear recovery: tear down the BrowserView entirely and rebuild it
        console.warn(`[Haven Desktop] Renderer crashed ${_crashCount} times — rebuilding BrowserView for ${url}`);
        try {
          mainWindow?.removeBrowserView(view);
          try { view.webContents.destroy(); } catch {}
          serverViews.delete(url);
          // After a brief pause, rebuild
          setTimeout(() => {
            if (!mainWindow) return;
            _crashCount = 0; // reset for the new view
            switchToServer(url);
          }, 2000);
        } catch (e) {
          console.error('[Haven Desktop] Nuclear recovery failed:', e.message);
          resetToWelcome();
        }
        return;
      }
      const delay = 1500 * Math.pow(2, _crashCount - 1); // 1.5 s, 3 s, 6 s, 12 s, 24 s
      setTimeout(() => {
        if (!mainWindow || !serverViews.has(url)) return;
        try { view.webContents.loadURL(buildServerAppUrl(url)); } catch {}
      }, delay);
      // Reset counter after a period of stability
      _crashStabilityTimer = setTimeout(() => { _crashCount = 0; }, CRASH_WINDOW_MS);
    });

    // ── Handle renderer becoming unresponsive (OOM / infinite loop) ──
    let _unresponsiveTimer = null;
    view.webContents.on('unresponsive', () => {
      if (_unresponsiveTimer) return; // already scheduled
      console.warn(`[Haven Desktop] Renderer unresponsive for ${url}, will reload after 5 s…`);
      _unresponsiveTimer = setTimeout(() => {
        _unresponsiveTimer = null;
        if (!mainWindow || !serverViews.has(url)) return;
        try { view.webContents.loadURL(buildServerAppUrl(url)); } catch {}
      }, 5000);
    });
    view.webContents.on('responsive', () => {
      if (_unresponsiveTimer) {
        clearTimeout(_unresponsiveTimer);
        _unresponsiveTimer = null;
        console.log(`[Haven Desktop] Renderer recovered for ${url}, cancelled reload`);
      }
    });

    // ── Periodic memory monitoring ──
    // Checks renderer memory every 30 s.  Soft DOM trim at 300 MB,
    // hard reload only at 512 MB with a 2 min cooldown to prevent
    // reload loops on media-heavy channels.
    const MEM_THRESHOLD_MB = 512;
    const MEM_WARN_MB      = 300;
    const MEM_CHECK_INTERVAL = 30000;
    const MEM_RELOAD_COOLDOWN = 120000; // 2 min between hard reloads
    let _memCheckInterval = null;
    let _lastMemReload = 0;           // timestamp of last memory reload
    const _memTrend = [];           // [{ts, mb}] — last 20 readings (~10 min)
    const MEM_TREND_MAX = 20;
    let _memSampleCount = 0;        // total samples taken (for trend log cadence)
    const _startMemCheck = () => {
      _memCheckInterval = setInterval(() => {
      if (!mainWindow || !serverViews.has(url)) {
        clearInterval(_memCheckInterval);
        return;
      }
      if (activeServerUrl !== url) return; // only check active view
      try {
        // Use app.getAppMetrics() to find renderer memory by PID —
        // getProcessMemoryInfo().private returns 0 on some Electron/Windows combos.
        const rendererPid = view.webContents.getOSProcessId();
        const allMetrics = app.getAppMetrics();
        const proc = allMetrics.find(m => m.pid === rendererPid);
        const memKB = proc ? (proc.memory.workingSetSize || 0) : 0;
        const memMB = memKB / 1024;

        // Track trend
        _memTrend.push({ ts: Date.now(), mb: Math.round(memMB) });
        if (_memTrend.length > MEM_TREND_MAX) _memTrend.shift();
        _memSampleCount++;

        // Log trend every 5th sample (~2.5 min), but only when memory changed significantly
        if (_memSampleCount % 5 === 0 && _memTrend.length >= 5) {
          const first = _memTrend[0].mb;
          const last  = _memTrend[_memTrend.length - 1].mb;
          const delta = last - first;
          // Only log if memory shifted by more than 10 MB
          if (Math.abs(delta) > 10) {
            const arrow = delta > 0 ? '↑' : '↓';
            console.log(`[Haven Desktop] Memory trend: ${first}→${last} MB (${delta > 0 ? '+' : ''}${delta}) ${arrow} over ${Math.round((_memTrend[_memTrend.length-1].ts - _memTrend[0].ts)/60000)} min`);
          }
        }

        if (memMB > MEM_THRESHOLD_MB) {
          // Hard reload — but only if we haven't reloaded recently to prevent loops
          if (Date.now() - _lastMemReload < MEM_RELOAD_COOLDOWN) {
            console.warn(`[Haven Desktop] Memory ${Math.round(memMB)} MB — skipping reload (cooldown active), trimming DOM instead`);
          } else {
            console.warn(`[Haven Desktop] Renderer memory ${Math.round(memMB)} MB exceeds ${MEM_THRESHOLD_MB} MB — clearing caches & reloading`);
            _lastMemReload = Date.now();
            try { view.webContents.session.clearCache().catch(() => {}); } catch {}
            try { view.webContents.loadURL(buildServerAppUrl(url)); } catch {}
            return; // skip soft trim — we're reloading
          }
        }

        if (memMB > MEM_WARN_MB) {
          // Soft intervention: trim excess DOM nodes + revoke blob URLs.
          // CRITICAL: Do NOT use getBoundingClientRect() here — it forces
          // a synchronous layout recalculation for EVERY element, which
          // starves the renderer event loop and causes complete UI freezes.
          try {
            view.webContents.executeJavaScript(`
              (function(){
                var ct = 0;
                var msgs = document.getElementById('messages');
                if (msgs) {
                  while (msgs.children.length > 200) {
                    msgs.removeChild(msgs.firstElementChild);
                    ct++;
                  }
                }
                // Strip heavy embeds (iframes, large images) from older messages
                if (msgs) {
                  var old = Array.from(msgs.querySelectorAll('.link-preview-yt, .link-preview'));
                  old.slice(0, Math.max(0, old.length - 5)).forEach(function(el) { el.remove(); });
                }
                if (ct) console.log('[Haven] Soft GC: trimmed ' + ct + ' old messages + embeds');
              })()
            `).catch(() => {});
          } catch {}
        }
      } catch {}
    }, MEM_CHECK_INTERVAL);
    }; // end _startMemCheck
    setTimeout(_startMemCheck, 30000); // wait 30 s before first memory check

    // ── Periodic health check: detect blank screen without crash event ──
    // Sometimes the renderer goes blank without firing 'render-process-gone'
    // (e.g. GPU process crash, OOM).  Check if the renderer process is
    // crashed and reload if so.  IMPORTANT: we no longer use
    // executeJavaScript() for this — injecting JS into a renderer that's
    // already busy/stalled blocks the main process event loop and makes
    // the freeze WORSE.  isCrashed() is a synchronous C++ call on the
    // main process side that doesn't touch the renderer at all.
    let _healthCheckInterval = setInterval(() => {
      if (!mainWindow || !serverViews.has(url)) {
        clearInterval(_healthCheckInterval);
        return;
      }
      if (activeServerUrl !== url) return; // only check the active view
      try {
        if (view.webContents.isCrashed()) {
          console.warn('[Haven Desktop] Health check: renderer crashed, reloading…');
          view.webContents.loadURL(buildServerAppUrl(url));
        }
      } catch {}
    }, 30000); // check every 30 seconds

    // Only open DevTools for the first server view in dev mode
    if (IS_DEV && serverViews.size === 0) view.webContents.openDevTools({ mode: 'detach' });
    serverViews.set(url, view);
  }

  return view;
}

// Default cap on how many secondary servers we'll pre-load in the background.
// Each background view is a full Chromium renderer + Socket.IO connection, so
// this is the dial that controls how memory-heavy the desktop app gets when
// the user has lots of servers added.
const BACKGROUND_SERVER_CAP = 8;

function scheduleBackgroundServerPreload(activeServerUrl) {
  // Off-switch: setting `backgroundServerConnections` to false disables
  // pre-loading entirely, restoring the old lazy behavior.
  const enabled = store.get('backgroundServerConnections');
  if (enabled === false) return;

  // Wait a few seconds so the active view's first paint isn't competing
  // with N background renderers spinning up at the same moment.
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const activeNorm = normalizeServerUrl(activeServerUrl);
    const history = sanitizeServerHistory(store.get('serverHistory') || []);
    let started = 0;
    for (const entry of history) {
      if (started >= BACKGROUND_SERVER_CAP) break;
      const url = entry.url;
      if (!url || url === activeNorm || serverViews.has(url)) continue;
      try {
        ensureServerView(url, { background: true });
        started++;
      } catch (e) {
        console.warn('[Haven Desktop] Background preload failed for', url, e.message);
      }
    }
    if (started > 0) {
      console.log(`[Haven Desktop] Pre-loaded ${started} background server view${started === 1 ? '' : 's'} for unread badges`);
    }
  }, 4000);
}

function handleWindowOpen(url) {
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol)) {
      // Only switch within the app for servers already registered in this session.
      // Unknown external URLs (including friends' Haven servers) open in the system
      // browser — trying to auto-load them risks a failed navigation that resets the session.
      const normalizedUrl = normalizeServerUrl(url);
      if (serverViews.has(normalizedUrl)) {
        switchToServer(normalizedUrl);
        return;
      }
    }
  } catch { /* not a URL */ }
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
}

function getActiveContents() {
  if (activeServerUrl && serverViews.has(activeServerUrl))
    return serverViews.get(activeServerUrl).webContents;
  return mainWindow?.webContents || welcomeWindow?.webContents || null;
}

/**
 * Guard against "Render frame was disposed before WebFrameMain could be
 * accessed".  Checking `wc.mainFrame` before `send()` prevents Electron's
 * native C++ layer from even attempting the IPC send to a disposed frame.
 * The try/catch stays as a safety net for the remaining race window.
 */
function safeSend(wc, channel, ...args) {
  try {
    if (!wc || wc.isDestroyed()) return;
    const frame = wc.mainFrame;
    if (!frame) return;
    // Use the WebFrameMain directly — avoids the extra webContents dispatch
    // layer that logs a native error even when we catch the JS exception.
    frame.send(channel, ...args);
  } catch { /* frame disposed between check and send — harmless */ }
}

// ── Notification Badge ───────────────────────────────────────

function createBadgeIcon() {
  // 32×32 renders sharply on HiDPI Windows taskbars.
  // Shape: pointy-top hexagon matching Haven's app icon.
  // Fill: diagonal gradient #8b6ff0 → #6b4fdb (same as the SVG brand mark).
  // Ring: 2px light-lavender edge echoing the hex outline stroke.
  // Mark: white "!" so it reads clearly as a notification badge.
  const s = 32;
  const buf = Buffer.alloc(s * s * 4, 0);
  const cx = s / 2 - 0.5, cy = s / 2 - 0.5;  // sub-pixel center
  const R     = 14.5;  // outer circumradius
  const fillR = R - 2; // inner fill radius (= ring width of 2px)

  // Pointy-top hex: first vertex at top (image coords with y-down axis).
  // Angles: π/2, π/2+π/3, π/2+2π/3, …
  const uv = Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 2 + k * Math.PI / 3;
    return [Math.cos(a), -Math.sin(a)]; // y-down: negate sin
  });

  // CW point-in-regular-hexagon test (cross product, all edges must have cross ≤ 0).
  function inHex(px, py, r) {
    const x = px - cx, y = py - cy;
    for (let k = 0; k < 6; k++) {
      const ax = uv[k][0] * r,       ay = uv[k][1] * r;
      const bx = uv[(k + 1) % 6][0] * r, by = uv[(k + 1) % 6][1] * r;
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) > 0) return false;
    }
    return true;
  }

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5, py = y + 0.5; // test pixel centre
      if (!inHex(px, py, R)) continue;  // transparent outside hex

      const i = (y * s + x) * 4;
      if (!inHex(px, py, fillR)) {
        // Ring: soft lavender-white, echoes the hex outline in the app icon
        buf[i] = 220; buf[i + 1] = 210; buf[i + 2] = 248; buf[i + 3] = 255;
      } else {
        // Gradient fill: #8b6ff0 (top-left) → #6b4fdb (bottom-right)
        const t = Math.max(0, Math.min(1, ((px - cx) + (py - cy)) / (fillR * 2) + 0.5));
        buf[i]     = Math.round(0x8b + t * (0x6b - 0x8b)); // 139 → 107
        buf[i + 1] = Math.round(0x6f + t * (0x4f - 0x6f)); // 111 →  79
        buf[i + 2] = Math.round(0xf0 + t * (0xdb - 0xf0)); // 240 → 219
        buf[i + 3] = 255;
      }
    }
  }

  // White "!" centered at x=15.5 (4px wide: px 14–17).
  // Bar: y 8–17 (10px).  Gap: y 18–21.  Dot: y 22–24 (3px).
  const paint = (px, py) => {
    if (px < 0 || px >= s || py < 0 || py >= s) return;
    const idx = (py * s + px) * 4;
    if (buf[idx + 3] === 0) return; // don't bleed outside hex
    buf[idx] = buf[idx + 1] = buf[idx + 2] = 255; buf[idx + 3] = 255;
  };
  for (let py = 8;  py <= 17; py++) for (let px = 14; px <= 17; px++) paint(px, py);
  for (let py = 22; py <= 24; py++) for (let px = 14; px <= 17; px++) paint(px, py);

  return nativeImage.createFromBuffer(buf, { width: s, height: s });
}

function setNotificationBadge() {
  if (!mainWindow) return;
  // Overlay/dock badge: always show when there are unreads (even if window is focused —
  // the user may be in a different channel and hasn't seen the new message yet).
  if (process.platform === 'win32' && badgeIcon) mainWindow.setOverlayIcon(badgeIcon, 'New messages');
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(1);
  // Taskbar flash: only when the window is not already in focus (avoids annoying flicker).
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
}

function clearNotificationBadge() {
  if (!mainWindow) return;
  if (process.platform === 'win32') mainWindow.setOverlayIcon(null, '');
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(0);
  mainWindow.flashFrame(false);
}

// Compute and apply the taskbar overlay badge based on serverBadgeState,
// filtered so a server's unreads only count if at least one open view's
// sidebar can display that server (its own origin counts). Without this
// filter, background-preloaded BrowserViews fire the badge for servers
// the user has no visible icon for, producing a "phantom" taskbar badge
// with no in-app indicator anywhere. (#5269)
function recomputeTaskbarBadge() {
  // Union of every open view's known URL set (each view contributes its
  // own origin + every remote icon it currently shows). A badge counts
  // only if its server URL is in this union.
  const visible = new Set();
  for (const set of knownServerUrlsByView.values()) {
    for (const u of set) visible.add(u);
  }
  let anyVisibleUnread = false;
  for (const [url, hasUnread] of serverBadgeState) {
    if (!hasUnread) continue;
    // If no view has reported its known URLs yet (early startup before
    // any renderer has finished its first sidebar render), fall back to
    // the legacy behaviour so the badge still works.
    if (knownServerUrlsByView.size === 0 || visible.has(url)) {
      anyVisibleUnread = true;
      break;
    }
  }
  if (anyVisibleUnread) setNotificationBadge();
  else clearNotificationBadge();
}

// ═══════════════════════════════════════════════════════════
// System Tray
// ═══════════════════════════════════════════════════════════

function createTray() {
  let icon;
  try {
    const raw = nativeImage.createFromPath(ICON_PATH);
    // DPI-aware tray icon sizing (issue #4)
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    if (process.platform === 'win32') {
      const s = Math.round(16 * sf);
      icon = raw.resize({ width: s, height: s });
    } else if (process.platform === 'linux') {
      const s = Math.round(24 * sf);
      icon = raw.resize({ width: s, height: s });
    } else {
      icon = raw.resize({ width: 22, height: 22 }); // macOS template size
    }
  } catch {
    return; // icon asset may not exist yet in dev
  }

  tray = new Tray(icon);
  tray.setToolTip('Haven Desktop');

  const rebuildMenu = () => {
    const running = serverManager?.isRunning();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Haven Desktop v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Show Haven', click: () => { (mainWindow || welcomeWindow)?.show(); (mainWindow || welcomeWindow)?.focus(); } },
      ...(mainWindow ? [{
        label: (activeServerUrl && primaryServerUrl && activeServerUrl !== primaryServerUrl) ? 'Back to My Server' : 'Change Server',
        click: () => {
          if (activeServerUrl && primaryServerUrl && activeServerUrl !== primaryServerUrl) {
            // Viewing a secondary server — just switch back to primary
            const secondaryUrl = activeServerUrl;
            const secondaryView = serverViews.get(secondaryUrl);
            if (secondaryView) {
              mainWindow?.removeBrowserView(secondaryView);
              try { secondaryView.webContents.destroy(); } catch {}
              serverViews.delete(secondaryUrl);
              serverBadgeState.delete(secondaryUrl);
              knownServerUrlsByView.delete(secondaryUrl);
              recomputeTaskbarBadge();
            }
            switchToServer(primaryServerUrl);
          } else {
            resetToWelcome(true);
          }
        }
      }] : []),
      { type: 'separator' },
      { label: running ? '● Server Running' : '○ Server Stopped', enabled: false },
      { type: 'separator' },
      { label: 'Quit Haven', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };

  rebuildMenu();
  // Refresh tray menu periodically so server status stays current
  setInterval(rebuildMenu, 60000);

  tray.on('click', () => {
    const win = mainWindow || welcomeWindow;
    if (win) { win.isVisible() ? win.focus() : win.show(); }
  });
}

// ═══════════════════════════════════════════════════════════
// Screen-Share Handler  (per-app audio magic)
// ═══════════════════════════════════════════════════════════
//
// When the Haven web app calls navigator.mediaDevices.getDisplayMedia(),
// Electron's handler fires.  We send the available sources + audio apps
// to the renderer, show a custom picker, and start native per-app audio
// capture for the selected application.
// ───────────────────────────────────────────────────────────

function registerScreenShareHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // Video sources
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });

      // Audio-producing applications (native addon)
      let audioApps = [];
      try { audioApps = audioCapture.getAudioApplications(); }
      catch (err) { console.warn('[ScreenShare] audio app enumeration failed:', err.message); }

      const sourceData = sources.map(s => ({
        id:         s.id,
        name:       s.name,
        thumbnail:  s.thumbnail.toDataURL(),
        appIcon:    s.appIcon ? s.appIcon.toDataURL() : null,
        display_id: s.display_id,
      }));

      const targetContents = getActiveContents();
      if (!targetContents) { callback({}); return; }

      // Ask renderer to show the picker
      safeSend(targetContents, 'screen:show-picker', { sources: sourceData, audioApps });

      // Wait for picker result (or 60 s timeout)
      const result = await new Promise(resolve => {
        const handler = (_e, res) => resolve(res);
        ipcMain.once('screen:picker-result', handler);
        setTimeout(() => { ipcMain.removeListener('screen:picker-result', handler); resolve({ cancelled: true }); }, 60000);
      });

      if (result.cancelled) { callback({}); return; }

      const selected = sources.find(s => s.id === result.sourceId);
      if (!selected) { callback({}); return; }

      // Start per-app audio capture when a specific app was chosen
      let usePerAppAudio = false;
      if (result.audioAppPid && result.audioAppPid > 0) {
        try {
          audioCapture.startCapture(result.audioAppPid, (pcmData) => {
            try {
              if (!pcmData || !pcmData.buffer) return;
              // Send as a plain ArrayBuffer (not Float32Array) for reliable
              // cross-context structured-clone transfer.  Typed arrays can
              // arrive in the renderer with non-zero byteOffset from Node's
              // Buffer pool, causing silent alignment failures.
              const ab = pcmData.buffer.slice(
                pcmData.byteOffset,
                pcmData.byteOffset + pcmData.byteLength
              );
              safeSend(targetContents, 'audio:capture-data', ab);
            } catch (cbErr) {
              console.warn('[ScreenShare] audio callback error:', cbErr.message);
            }
          });
          usePerAppAudio = true;
        } catch (err) {
          console.error('[ScreenShare] per-app audio start failed:', err.message);
        }
      }

      // No audio: user explicitly chose silence.
      // System audio: use loopback (default).
      // Per-app audio: also request loopback initially; renderer swaps in the
      // per-app track once native PCM is confirmed alive. This avoids a silent
      // stream if native per-app capture initializes but fails to deliver data.
      if (usePerAppAudio) {
        callback({ video: selected, audio: 'loopback' });
      } else if (result.audioAppPid === 'none') {
        callback({ video: selected });
      } else {
        callback({ video: selected, audio: 'loopback' });
      }

    } catch (err) {
      console.error('[ScreenShare] handler error:', err);
      callback({});
    }
  });
}

// ═══════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════

function registerIPC() {

  // ── Server Management ─────────────────────────────────
  ipcMain.handle('server:detect',      ()        => serverManager.detectServer());
  ipcMain.handle('server:start',       (_e, dir) => serverManager.startServer(dir));
  ipcMain.handle('server:stop',        ()        => serverManager.stopServer());
  ipcMain.handle('server:status',      ()        => serverManager.getStatus());

  ipcMain.handle('server:browse', async () => {
    const lastPath = store.get('userPrefs.serverPath');
    const r = await dialog.showOpenDialog(welcomeWindow || mainWindow, {
      title: 'Select Haven Server Directory',
      defaultPath: lastPath || undefined,
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('server:browse-file', async () => {
    const r = await dialog.showOpenDialog(welcomeWindow || mainWindow, {
      title: 'Select server.js',
      properties: ['openFile'],
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ── Auto-Update ───────────────────────────────────────
  ipcMain.handle('update:download', async () => {
    if (!autoUpdater) return { error: 'Auto-updater not available' };
    try { await autoUpdater.downloadUpdate(); return { success: true }; }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.on('update:install', () => {
    if (autoUpdater) {
      serverManager?.stopServer();
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // ── Audio Capture ─────────────────────────────────────
  ipcMain.handle('audio:get-apps',      () => { try { return audioCapture.getAudioApplications(); } catch { return []; } });
  ipcMain.handle('audio:start-capture',  (_e, pid) => {
    try {
      return audioCapture.startCapture(pid, pcm => {
        try {
          if (!pcm || !pcm.buffer) return;
          const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          safeSend(getActiveContents(), 'audio:capture-data', ab);
        } catch { /* non-critical */ }
      });
    } catch (e) { console.error('[AudioCapture] start-capture IPC failed:', e.message); return false; }
  });
  ipcMain.handle('audio:stop-capture',   () => { try { audioCapture.stopCapture(); } catch {} });
  ipcMain.handle('audio:is-supported',   () => { try { return audioCapture.isSupported(); } catch { return false; } });
  ipcMain.handle('audio:opt-out-ducking', () => audioCapture.optOutOfDucking());

  // ── Audio Devices ─────────────────────────────────────
  ipcMain.handle('devices:get-inputs', async () => {
    const wc = getActiveContents();
    if (!wc) return [];
    return wc.executeJavaScript(`
      navigator.mediaDevices.enumerateDevices()
        .then(d => d.filter(x => x.kind==='audioinput').map(x => ({ deviceId:x.deviceId, label:x.label||'Mic '+x.deviceId.slice(0,8), groupId:x.groupId })))
    `);
  });

  ipcMain.handle('devices:get-outputs', async () => {
    const wc = getActiveContents();
    if (!wc) return [];
    return wc.executeJavaScript(`
      navigator.mediaDevices.enumerateDevices()
        .then(d => d.filter(x => x.kind==='audiooutput').map(x => ({ deviceId:x.deviceId, label:x.label||'Speaker '+x.deviceId.slice(0,8), groupId:x.groupId })))
    `);
  });

  // ── Notifications ─────────────────────────────────────
  ipcMain.handle('notify', (e, opts) => {
    const n = new Notification({
      title: opts.title || 'Haven',
      body:  opts.body  || '',
      icon:  ICON_PATH,
      silent: opts.silent || false,
    });
    n.show();
    n.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      // Tell the renderer which channel to navigate to
      if (opts.channelCode) {
        try { e.sender.send('notification-clicked', opts.channelCode); } catch {}
      }
    });

    // Badge is managed exclusively by the renderer via 'notification-badge' IPC.
    // Setting it here caused a race: the renderer would clear the badge (unreads=0)
    // right before notify() re-set it, leaving a phantom taskbar badge forever.
    return true;
  });

  // ── Unread badge signal (fired by renderer on any unread count change) ──
  // Tracks per-server unread state so one server clearing its badge doesn't
  // accidentally clear another server's unreads.
  ipcMain.on('notification-badge', (e, hasUnread) => {
    // Identify which server sent this signal by matching the sender's webContents
    let senderUrl = null;
    for (const [url, view] of serverViews) {
      if (view.webContents === e.sender) { senderUrl = url; break; }
    }
    if (senderUrl) serverBadgeState.set(senderUrl, !!hasUnread);

    recomputeTaskbarBadge();

    // Notify the active BrowserView so it can show notification dots on server icons
    const active = getActiveContents();
    if (active && active !== e.sender) {
      const badgeMap = Object.fromEntries(serverBadgeState);
      safeSend(active, 'server-badge-update', badgeMap);
    }
  });

  // ── Renderer reports which server URLs its sidebar can display ──
  // Used by recomputeTaskbarBadge to skip phantom unreads from background
  // servers the user has no visible icon for. (#5269)
  ipcMain.on('report-known-server-urls', (e, urls) => {
    let senderUrl = null;
    for (const [url, view] of serverViews) {
      if (view.webContents === e.sender) { senderUrl = url; break; }
    }
    if (!senderUrl) return;
    const set = new Set();
    for (const u of (urls || [])) {
      const n = normalizeServerUrl(u);
      if (n) set.add(n);
    }
    knownServerUrlsByView.set(senderUrl, set);
    recomputeTaskbarBadge();
  });

  // ── Query per-server badge state (renderer asks for current state) ──
  ipcMain.handle('get-server-badges', () => {
    return Object.fromEntries(serverBadgeState);
  });

  // ── Window Controls ───────────────────────────────────
  ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
  ipcMain.on('window:maximize', () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.isMaximized() ? w.unmaximize() : w?.maximize();
  });
  ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close());

  // ── Fullscreen (BrowserView doesn't support the HTML5 Fullscreen API natively;
  //    the preload overrides requestFullscreen / exitFullscreen via IPC) ──
  ipcMain.on('window:enter-fullscreen', () => {
    if (mainWindow && !mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
  });
  ipcMain.on('window:leave-fullscreen', () => {
    if (mainWindow && mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  });

  // ── Settings ──────────────────────────────────────────
  const ALLOWED_SETTINGS_KEYS = new Set([
    'userPrefs', 'windowBounds', 'audioInputDevice', 'audioOutputDevice',
    'lastServer', 'pushToTalk', 'pushToTalkKey', 'noiseGate', 'noiseThreshold',
    'desktopShortcuts', 'startOnLogin', 'startHidden', 'minimizeToTray', 'forceSDR'
  ]);
  ipcMain.handle('settings:get', (_e, key)        => store.get(key));
  ipcMain.handle('settings:set', (_e, key, value)  => {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) return false;
    store.set(key, value);
    return true;
  });

  // ── App Info ──────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion());

  // ── Desktop App Preferences ───────────────────────────
  ipcMain.handle('desktop:get-prefs', () => ({
    startOnLogin:   !!store.get('startOnLogin'),
    startHidden:    !!store.get('startHidden'),
    minimizeToTray: !!store.get('minimizeToTray'),
    forceSDR:       !!store.get('forceSDR'),
    hideMenuBar:    !!store.get('hideMenuBar'),
  }));

  ipcMain.handle('desktop:set-start-on-login', (_e, enabled) => {
    store.set('startOnLogin', !!enabled);
    const hiddenArg = store.get('startHidden') ? ['--hidden'] : [];
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: enabled ? hiddenArg : [],
    });
    return true;
  });

  ipcMain.handle('desktop:set-start-hidden', (_e, enabled) => {
    store.set('startHidden', !!enabled);
    // Re-sync login item args so --hidden is included/excluded
    const loginEnabled = !!store.get('startOnLogin');
    if (loginEnabled) {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: enabled ? ['--hidden'] : [],
      });
    }
    return true;
  });

  ipcMain.handle('desktop:set-minimize-to-tray', (_e, enabled) => {
    store.set('minimizeToTray', !!enabled);
    return true;
  });

  ipcMain.handle('desktop:set-force-sdr', (_e, enabled) => {
    store.set('forceSDR', !!enabled);
    // force-color-profile is a Chromium command-line switch, requires restart
    return { requiresRestart: true };
  });

  ipcMain.handle('desktop:set-hide-menu-bar', (_e, enabled) => {
    store.set('hideMenuBar', !!enabled);
    if (mainWindow) {
      mainWindow.setAutoHideMenuBar(!!enabled);
      mainWindow.setMenuBarVisibility(!enabled);
    }
    return true;
  });

  // ── Desktop Shortcuts ─────────────────────────────────
  ipcMain.handle('shortcuts:get', () => store.get('desktopShortcuts') || {});
  ipcMain.handle('shortcuts:register', (_e, updates) => {
    if (!updates || typeof updates !== 'object') return false;
    unregisterVoiceShortcuts();
    const cfg = { ...store.get('desktopShortcuts') };
    const allowed = new Set(['mute', 'deafen', 'ptt']);
    Object.entries(updates).forEach(([k, v]) => {
      if (allowed.has(k) && typeof v === 'string' && v.length <= 50) cfg[k] = v;
    });
    store.set('desktopShortcuts', cfg);
    registerVoiceShortcuts();
    // Report registration success for each non-empty shortcut
    const result = {};
    Object.entries(cfg).forEach(([k, v]) => {
      result[k] = v ? globalShortcut.isRegistered(v) : true;
    });
    return result;
  });

  // ── Navigation ────────────────────────────────────────
  ipcMain.on('nav:open-app', (_e, serverUrl) => createAppWindow(serverUrl));
  ipcMain.on('nav:back-to-welcome', () => resetToWelcome());
  ipcMain.on('nav:switch-server', (_e, serverUrl) => {
    if (mainWindow && typeof serverUrl === 'string' && /^https?:\/\//i.test(serverUrl)) {
      switchToServer(normalizeServerUrl(serverUrl));
    }
  });

  // ── Change Primary Server (from login page server picker) ──
  ipcMain.on('nav:change-primary-server', (_e, serverUrl) => {
    if (!mainWindow || typeof serverUrl !== 'string' || !/^https?:\/\//i.test(serverUrl)) return;
    try {
      const newUrl = normalizeServerUrl(serverUrl);
      for (const [u, view] of serverViews) {
        mainWindow.removeBrowserView(view);
        try { view.webContents.destroy(); } catch {}
      }
      serverViews.clear();
      serverBadgeState.clear();
      knownServerUrlsByView.clear();
      primaryServerUrl = newUrl;
      activeServerUrl = null;
      store.set('userPrefs.serverUrl', newUrl);
      store.set('userPrefs.mode', 'join');
      switchToServer(newUrl);
    } catch {}
  });

  // ── Server History ────────────────────────────────────
  // Sanitize on read so legacy entries with mixed casing, /app paths, or
  // garbage hostnames (e.g. someone typed "https") get cleaned up the next
  // time the renderer asks for the list.
  ipcMain.handle('server-history:get', () => {
    const raw = store.get('serverHistory') || [];
    const cleaned = sanitizeServerHistory(raw);
    if (cleaned.length !== raw.length || cleaned.some((c, i) => c.url !== raw[i]?.url)) {
      store.set('serverHistory', cleaned);
    }
    return cleaned;
  });
  // Synchronous variant for preload bootstrap. The renderer can't wait on a
  // promise before the page-scripts run, but it CAN do a sendSync at preload
  // time. This lets the sidebar populate with the user's known servers on
  // first-join to a brand-new server before any network calls happen.
  ipcMain.on('server-history:get-sync', (e) => {
    try {
      const raw = store.get('serverHistory') || [];
      e.returnValue = sanitizeServerHistory(raw);
    } catch {
      e.returnValue = [];
    }
  });
  ipcMain.handle('server-history:add', (_e, url, name) => {
    const normalizedUrl = normalizeServerUrl(url);
    if (!normalizedUrl || !isValidServerHost(normalizedUrl)) return;
    const history = sanitizeServerHistory(store.get('serverHistory') || []);
    if (history.find(h => h.url === normalizedUrl)) {
      store.set('serverHistory', history);
      return;
    }
    history.push({ url: normalizedUrl, name: name || normalizedUrl, lastConnected: 0 });
    while (history.length > 20) history.shift();
    store.set('serverHistory', history);
  });
  ipcMain.handle('server-history:remove', (_e, url) => {
    const normalizedUrl = normalizeServerUrl(url);
    const history = sanitizeServerHistory(store.get('serverHistory') || [])
      .filter(h => h.url !== normalizedUrl);
    store.set('serverHistory', history);
    return history;
  });
  ipcMain.handle('server-history:update-name', (_e, url, name) => {
    const normalizedUrl = normalizeServerUrl(url);
    const history = sanitizeServerHistory(store.get('serverHistory') || []);
    const entry = history.find(h => h.url === normalizedUrl);
    if (entry && name) entry.name = name;
    store.set('serverHistory', history);
  });

  // ── External links ────────────────────────────────────
  ipcMain.on('open-external', (_e, url) => {
    // Only allow http/https URLs to prevent file:// or protocol handler abuse
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  // ── JavaScript dialog overrides for BrowserView (issue #6) ──

  ipcMain.on('dialog:alert', (event, { message }) => {
    // Focus the window so the modal dialog is always visible — if it spawns
    // behind the app, the user can't dismiss it and the app appears frozen.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // showMessageBoxSync is intentionally synchronous here — confirm/alert/prompt
    // are modal by spec, so blocking is expected.  The REAL freeze causes were
    // the getBoundingClientRect reflow storm and executeJavaScript health checks,
    // not these dialog calls.
    dialog.showMessageBoxSync(mainWindow, {
      type: 'info', buttons: ['OK'], title: 'Haven',
      message: String(message || ''),
    });
    event.returnValue = true;
  });

  ipcMain.on('dialog:confirm', (event, { message }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', buttons: ['Cancel', 'OK'],
      defaultId: 1, cancelId: 0, title: 'Haven',
      message: String(message || ''),
    });
    event.returnValue = r === 1;
  });

  ipcMain.on('dialog:prompt', (event, { message, defaultValue }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Native Electron dialog — no cscript.exe, no execSync, no 5-minute timeout.
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1, cancelId: 0,
      title: 'Haven',
      message: String(message || ''),
      detail: defaultValue ? `Default: ${defaultValue}` : undefined,
    });
    event.returnValue = r === 1 ? (defaultValue || '') : null;
  });
}

// ═══════════════════════════════════════════════════════════
// Linux Desktop Integration (issue #3)
//
// When running as an AppImage, install a .desktop entry and
// icon so Haven appears in the application launcher.
// ═══════════════════════════════════════════════════════════

function installLinuxDesktopEntry() {
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return; // Only for AppImage installs

  const home = process.env.HOME || os.homedir();
  const appsDir = path.join(home, '.local', 'share', 'applications');
  const iconDir = path.join(home, '.local', 'share', 'icons');
  const desktopFile = path.join(appsDir, 'haven-desktop.desktop');
  const iconDest = path.join(iconDir, 'haven-desktop.png');

  // Skip if already registered for this AppImage path
  if (fs.existsSync(desktopFile)) {
    try {
      if (fs.readFileSync(desktopFile, 'utf-8').includes(appImagePath)) return;
    } catch {}
  }

  try {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });

    if (fs.existsSync(ICON_PATH)) fs.copyFileSync(ICON_PATH, iconDest);

    const entry = [
      '[Desktop Entry]',
      'Name=Haven',
      'Comment=Private self-hosted chat',
      `Exec="${appImagePath}" %U`,
      `Icon=${iconDest}`,
      'Type=Application',
      'Categories=Network;Chat;InstantMessaging;',
      'Terminal=false',
      'StartupWMClass=haven',
    ].join('\n');

    fs.writeFileSync(desktopFile, entry);
    try { require('child_process').execSync(`update-desktop-database "${appsDir}" 2>/dev/null`, { timeout: 5000 }); } catch {}
    console.log('[Haven Desktop] Installed desktop entry:', desktopFile);
  } catch (err) {
    console.warn('[Haven Desktop] Desktop integration failed:', err.message);
  }
}
