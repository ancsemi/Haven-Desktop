'use strict';

const path = require('path');
const { app } = require('electron');

const timeout = setTimeout(() => {
  console.error('Electron smoke test timed out.');
  app.exit(1);
}, 15000);

app.whenReady().then(() => {
  const electronMajor = Number(process.versions.electron.split('.')[0]);
  if (electronMajor !== 42) {
    throw new Error(`Expected Electron 42, found ${process.versions.electron}`);
  }

  const addon = require(path.join(
    __dirname,
    '..',
    'native',
    'build',
    'Release',
    'haven_audio.node'
  ));
  for (const method of ['isSupported', 'getAudioApplications', 'startCapture', 'stopCapture', 'cleanup']) {
    if (typeof addon[method] !== 'function') {
      throw new Error(`Native audio addon is missing ${method}()`);
    }
  }

  clearTimeout(timeout);
  console.log(`Electron ${process.versions.electron} loaded the native audio addon.`);
  app.quit();
}).catch(error => {
  clearTimeout(timeout);
  console.error(error.stack || error.message);
  app.exit(1);
});
