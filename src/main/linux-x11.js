'use strict';

// X11 mode on Linux (Haven #5721). Native Wayland flickers with some Nvidia
// drivers, and starting with --ozone-platform=x11 (XWayland) fixes it.
// Electron picks the display platform before main.js runs, so a switch set
// from there is too late; the app starts itself again with the flag instead.
//
// Returns the app.relaunch() options for that, or null when there is nothing
// to do: not Linux, the setting is off, or a platform was already given on
// the command line (by this relaunch or by the person). An AppImage restarts
// from the .AppImage file, since its mounted copy goes away on exit.
function x11RelaunchOptions({ platform, enabled, argv, env, execPath }) {
  if (platform !== 'linux' || enabled !== true) return null;
  const args = (argv || []).slice(1);
  if (args.some(a => typeof a === 'string' && a.startsWith('--ozone-platform='))) return null;
  return {
    execPath: (env && env.APPIMAGE) || execPath,
    args: args.concat(['--ozone-platform=x11']),
  };
}

module.exports = { x11RelaunchOptions };
