'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('havenScreenPicker', Object.freeze({
  onData(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.once('screen-picker:data', (_event, data) => callback(data));
  },
  submit(result) {
    ipcRenderer.send('screen-picker:result', result);
  },
}));
