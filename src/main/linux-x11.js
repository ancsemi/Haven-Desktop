'use strict';

// X11 mode on Linux (Haven #5721). Native Wayland flickers with some Nvidia
// drivers, and starting with --ozone-platform=x11 (XWayland) fixes it.
// Electron picks the display platform before main.js runs, so a switch set
// from there is too late; the app starts a second copy of itself with the
// flag and quits.
//
// 1.6.0 did that with app.relaunch(), which on some systems never brought the
// second copy up, so every launch quit and the setting could not be turned
// off again (Haven #5741). Now the copy is started directly, and a launch
// that finds the previous X11 start never finished turns X11 mode off and
// opens normally: at worst one launch fails, never every one.

const X11_FLAG = '--ozone-platform=x11';

// What this launch should do:
//   { action: 'none' }                  carry on as usual
//   { action: 'start-x11', command, args }  start the X11 copy, then quit
//   { action: 'give-up' }               the last X11 start never came up:
//                                       turn X11 mode off and carry on
// `pending` is the time an X11 start was last attempted, cleared by the X11
// copy once it is up. A platform given on the command line (by the X11 copy
// or by the person) is always respected.
function x11LaunchPlan({ platform, enabled, argv, env, execPath, pending }) {
  if (platform !== 'linux') return { action: 'none' };
  const args = (argv || []).slice(1).filter(a => typeof a === 'string');
  if (args.some(a => a.startsWith('--ozone-platform='))) return { action: 'none' };
  if (enabled !== true) return { action: 'none' };
  if (pending) return { action: 'give-up' };
  return {
    action: 'start-x11',
    // An AppImage starts again from the .AppImage file, since its mounted
    // copy goes away when this one quits.
    command: (env && env.APPIMAGE) || execPath,
    args: args.filter(a => a !== '--relaunch-retry').concat([X11_FLAG]),
  };
}

// The X11 copy is up when it was started with the flag.
function isX11Copy(argv) {
  return (argv || []).includes(X11_FLAG);
}

module.exports = { x11LaunchPlan, isX11Copy, X11_FLAG };
