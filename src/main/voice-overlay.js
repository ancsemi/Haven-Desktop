'use strict';

// The voice overlay window (see voice-overlay-state.js for what it shows).
// It is see-through, lets clicks pass to the game under it, never takes
// focus, and stays above other windows.
//
// Moving it: "Move overlay" swaps it for an ordinary frameless window at the
// same spot that the window manager drags itself, like a title bar, and Done
// swaps back. The window manager moves the window with the cursor, so it
// never trails behind or keeps going after the button comes up. Moving the
// window from here instead (setPosition on every pointer move) lagged behind
// the cursor on Linux, where every move goes through XWayland and the
// compositor, and kept the main process so busy that the release reached the
// overlay late. The swap is needed because the overlay's usual window, a
// notification window on Linux so it stays above full screen games, is one
// the window manager will not let the user move.

const path = require('path');
const {
  DEFAULT_OVERLAY_SETTINGS, MESSAGE_SECONDS, normalizeOverlaySettings,
  overlayAlignment, cornerPosition,
} = require('./voice-overlay-state');

const SIZE = Object.freeze({ width: 340, height: 620 });
const SAVE_MOVE_MS = 300;

/**
 * electron: { BrowserWindow, ipcMain, screen }
 * store: the app's electron-store (key `voiceOverlay`)
 * t: the app's translator
 * onChange(settings): called after the user changes a setting, so main can
 *   rebuild its menus and tell server pages whether to report.
 */
function createVoiceOverlay({ electron, store, t, onChange }) {
  const { BrowserWindow, ipcMain, screen } = electron;
  let settings = normalizeOverlaySettings(store.get('voiceOverlay') || DEFAULT_OVERLAY_SETTINGS);
  let win = null;
  let editing = false;
  let saveMoveTimer = null;
  let lastState = null;
  // The overlay belongs to the app window: while it is closed (the welcome
  // screen, or quitting) there is no call to show, and an open overlay
  // would keep the app running after its last real window closed.
  let appOpen = false;

  function save() {
    store.set('voiceOverlay', settings);
  }

  function contents() {
    return win && !win.isDestroyed() ? win.webContents : null;
  }

  function send(channel, payload) {
    const wc = contents();
    if (wc && !wc.isLoading()) wc.send(channel, payload);
  }

  function view() {
    let align = 'left';
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      align = overlayAlignment(bounds, screen.getDisplayMatching(bounds).workArea);
    }
    return {
      onlySpeaking: settings.onlySpeaking,
      showMessages: settings.showMessages,
      scale: settings.scale,
      opacity: settings.opacity,
      messageSeconds: MESSAGE_SECONDS,
      editing,
      align,
      labels: {
        move: t('voiceOverlay.dragHint'),
        done: t('voiceOverlay.done'),
        idle: t('voiceOverlay.idle'),
      },
    };
  }

  function initialPosition() {
    if (settings.x != null && settings.y != null) {
      // Keep it on a screen that is still there.
      const point = { x: settings.x + 10, y: settings.y + 10 };
      const onScreen = screen.getAllDisplays().some(d => {
        const b = d.workArea;
        return point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height;
      });
      if (onScreen) return { x: settings.x, y: settings.y };
    }
    return cornerPosition('top-left', screen.getPrimaryDisplay().workArea, SIZE);
  }

  function open(at) {
    if (win && !win.isDestroyed()) return;
    const { x, y } = at || initialPosition();
    const moving = editing;
    const w = new BrowserWindow({
      x, y, ...SIZE,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      // While moving it takes the mouse and focus, so its first click starts
      // a drag. Otherwise, on Linux, a notification window: window managers
      // keep those above full screen (borderless) games.
      focusable: moving,
      ...(!moving && process.platform === 'linux' ? { type: 'notification' } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'voice-overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win = w;
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setIgnoreMouseEvents(!moving);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('did-finish-load', () => {
      send('voice-overlay:view', view());
      send('voice-overlay:state', lastState);
      if (moving) w.show();
      else w.showInactive();
    });
    if (moving) w.on('move', savePositionSoon);
    w.on('closed', () => {
      if (win !== w) return; // swapped for the other kind of window
      win = null;
      editing = false;
    });
    w.loadFile(path.join(__dirname, '..', 'renderer', 'voice-overlay.html'));
  }

  function close() {
    clearTimeout(saveMoveTimer);
    const w = win;
    win = null;
    editing = false;
    if (w && !w.isDestroyed()) w.destroy();
  }

  function savePosition() {
    clearTimeout(saveMoveTimer);
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    settings = { ...settings, x, y };
    save();
    send('voice-overlay:view', view()); // which edge rows line up with may have changed
  }

  function savePositionSoon() {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(savePosition, SAVE_MOVE_MS);
  }

  function sync() {
    if (settings.enabled && appOpen) open();
    else close();
  }

  function setAppOpen(on) {
    appOpen = !!on;
    if (!appOpen) lastState = null;
    sync();
  }

  function set(key, value) {
    settings = normalizeOverlaySettings({ ...settings, [key]: value });
    save();
    if (key === 'enabled') sync();
    send('voice-overlay:view', view());
    onChange?.(settings);
  }

  function setEditing(on) {
    if (!win || win.isDestroyed() || editing === !!on) return;
    savePosition();
    const [x, y] = win.getPosition();
    const old = win;
    win = null;
    editing = !!on;
    old.destroy();
    open({ x, y });
    onChange?.(settings);
  }

  function snapTo(corner) {
    if (!win || win.isDestroyed()) return;
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    const { x, y } = cornerPosition(corner, workArea, SIZE);
    win.setPosition(x, y);
    settings = { ...settings, x, y };
    save();
    send('voice-overlay:view', view());
  }

  function fromOverlay(e) {
    const wc = contents();
    return !!wc && e.sender === wc && e.senderFrame === wc.mainFrame;
  }

  ipcMain.on('voice-overlay:done', (e) => {
    if (fromOverlay(e)) setEditing(false);
  });

  /** What the server pages report, already sanitized and chosen (or null). */
  function update(state) {
    lastState = state;
    send('voice-overlay:state', state);
  }

  /** The tray's "Voice overlay" submenu. */
  function menu({ waylandNote = false } = {}) {
    const radio = (label, key, value) => ({
      label, type: 'radio', checked: settings[key] === value, click: () => set(key, value),
    });
    return [
      { label: t('voiceOverlay.show'), type: 'checkbox', checked: settings.enabled, click: (i) => set('enabled', i.checked) },
      ...(waylandNote ? [{ label: t('voiceOverlay.waylandNote'), enabled: false }] : []),
      { type: 'separator' },
      { label: t('voiceOverlay.move'), type: 'checkbox', checked: editing, enabled: settings.enabled, click: (i) => setEditing(i.checked) },
      {
        label: t('voiceOverlay.corner'),
        enabled: settings.enabled,
        submenu: [
          { label: t('voiceOverlay.corner.topLeft'), click: () => snapTo('top-left') },
          { label: t('voiceOverlay.corner.topRight'), click: () => snapTo('top-right') },
          { label: t('voiceOverlay.corner.bottomLeft'), click: () => snapTo('bottom-left') },
          { label: t('voiceOverlay.corner.bottomRight'), click: () => snapTo('bottom-right') },
        ],
      },
      { type: 'separator' },
      { label: t('voiceOverlay.onlySpeaking'), type: 'checkbox', checked: settings.onlySpeaking, click: (i) => set('onlySpeaking', i.checked) },
      { label: t('voiceOverlay.showMessages'), type: 'checkbox', checked: settings.showMessages, click: (i) => set('showMessages', i.checked) },
      {
        label: t('voiceOverlay.size'),
        submenu: [
          radio(t('voiceOverlay.size.small'), 'scale', 0.85),
          radio(t('voiceOverlay.size.normal'), 'scale', 1),
          radio(t('voiceOverlay.size.large'), 'scale', 1.2),
          radio(t('voiceOverlay.size.extraLarge'), 'scale', 1.4),
        ],
      },
      {
        label: t('voiceOverlay.opacity'),
        submenu: [1, 0.85, 0.7, 0.5].map(v => radio(`${Math.round(v * 100)}%`, 'opacity', v)),
      },
    ];
  }

  /** Labels follow the app language. */
  function languageChanged() {
    send('voice-overlay:view', view());
  }

  return {
    get enabled() { return settings.enabled; },
    setAppOpen,
    update,
    menu,
    languageChanged,
    destroy: close,
  };
}

module.exports = { createVoiceOverlay };
