// ── Display color workarounds (applied before Electron is ready) ──
function applyDisplayColorWorkarounds(commandLine, platform, forceSDR) {
  // Keep color correction opt-in and leave the GPU compositor untouched.
  // On the reported mixed HDR/SDR Windows setup, linear sRGB output fixed
  // washed-out whites where the regular sRGB profile did not. Disabling
  // DirectComposition instead made visible windows fall back to software
  // compositing and removed H.265 from WebRTC, so do not disable it here.
  if (forceSDR) {
    commandLine.appendSwitch('force-color-profile', platform === 'win32' ? 'scrgb-linear' : 'srgb');
  }
}

module.exports = { applyDisplayColorWorkarounds };
