'use strict';

// A launcher or terminal can close its output pipe while the app is still open.
// Handle that stream error locally instead of triggering Electron's error dialog.
function handleClosedOutput(stream) {
  stream?.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
}

module.exports = { handleClosedOutput };
