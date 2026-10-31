'use strict';

// Preload for the voice overlay window (voice-overlay.js). It only shows what
// main sends, and says when the user is done moving it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceOverlay', {
  onView: (fn) => ipcRenderer.on('voice-overlay:view', (_e, view) => fn(view)),
  onState: (fn) => ipcRenderer.on('voice-overlay:state', (_e, state) => fn(state)),
  done: () => ipcRenderer.send('voice-overlay:done'),
});
