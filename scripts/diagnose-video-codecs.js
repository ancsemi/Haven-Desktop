'use strict';

// Run with Electron; --native-colors skips SDR correction and --visible
// shows the diagnostic windows. This never connects to a server or captures
// media; actual screen-share/driver compatibility still needs a manual test.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { applyDisplayColorWorkarounds } = require('../src/main/color-profile');

app.setPath('userData', path.join(app.getPath('temp'), 'opencode', `haven-codecs-${process.pid}`));
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCEncoderSupport,WebRtcAllowH265Send,WebRtcAV1HWEncode');
applyDisplayColorWorkarounds(app.commandLine, process.platform, !process.argv.includes('--native-colors'));
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '256');
// Keep the diagnostic alive between the two temporary renderer windows.
app.on('window-all-closed', () => {});

const timeout = setTimeout(() => {
  console.error('Video codec diagnostics timed out.');
  app.exit(1);
}, 30000);

app.whenReady().then(async () => {
  await app.getGPUInfo('complete');
  const renderers = [];
  for (const sandbox of [false, true]) {
    const win = new BrowserWindow({
      show: process.argv.includes('--visible'),
      webPreferences: { sandbox, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('Diagnostic renderer exited:', JSON.stringify(details));
    });
    try {
      await win.loadURL('about:blank');
      const capabilities = await win.webContents.executeJavaScript(`({
        send: RTCRtpSender.getCapabilities('video')?.codecs || [],
        receive: RTCRtpReceiver.getCapabilities('video')?.codecs || [],
      })`);
      renderers.push({
        sandbox,
        send: [...new Set(capabilities.send.map(codec => codec.mimeType))],
        receive: [...new Set(capabilities.receive.map(codec => codec.mimeType))],
        hevcProfiles: capabilities.send.filter(codec => /video\/(h265|hevc)/i.test(codec.mimeType)),
      });
    } finally {
      win.destroy();
    }
  }
  const gpuInfo = await app.getGPUInfo('complete');
  console.log(JSON.stringify({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    disableDirectComposition: app.commandLine.hasSwitch('disable-direct-composition'),
    gpuFeatures: app.getGPUFeatureStatus(),
    gpuRenderer: gpuInfo.auxAttributes?.glRenderer,
    overlays: gpuInfo.auxAttributes?.overlayInfo,
    renderers,
  }, null, 2));
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  clearTimeout(timeout);
  console.error(error.stack || error.message);
  app.exit(1);
});
