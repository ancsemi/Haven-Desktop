'use strict';

// Start Menu identity of a copy run from source on Windows.
//
// Shared by main.js and scripts/brand-dev-electron.js, so it must not require
// electron.
//
// Windows takes the taskbar icon and name for an app id from the Start Menu
// shortcut that carries that id. Electron 42 writes its own shortcut the first
// time a notification shows: Programs\<exe ProductName>.lnk, starting the exe
// with no arguments. It leaves an existing shortcut of that name alone only
// when its target, working folder, app id and toast activator CLSID match what
// it expects; it never looks at the arguments or the icon.
//
// So brand-dev-electron.js stamps DEV_PRODUCT_NAME and the Haven icon into
// electron.exe, and main.js writes the shortcut under that same name with the
// fields Electron checks. Electron then finds it valid and keeps our arguments
// and icon, and there is only ever one entry.

// Start Menu shortcuts only exist on Windows, so these are always Windows
// paths, also when the tests run on the Linux build machine.
const path = require('path').win32;

// Not "Haven": that is the installed app's product name, and Electron would
// then take over the installed app's own shortcut.
const DEV_PRODUCT_NAME = 'Haven Desktop (source)';
const DEV_APP_ID = 'com.haven.desktop';
// Fixed, so the shortcut we write and the one Electron expects carry the same
// CLSID. Only a copy run from source uses it.
const DEV_TOAST_CLSID = '{BC947E6B-827D-4D92-A79A-ACBD875FDE50}';

function devShortcutName(productName = DEV_PRODUCT_NAME) {
  return `${productName}.lnk`;
}

function devShortcutOptions({ execPath, appPath, dev, icon, appId = DEV_APP_ID, clsid = DEV_TOAST_CLSID }) {
  const options = {
    target: execPath,
    args: `"${appPath}"${dev ? ' --dev' : ''}`,
    // Electron rewrites the shortcut, without our arguments, unless the
    // working folder is the exe's own folder.
    cwd: path.dirname(execPath),
    description: 'Haven Desktop (run from source)',
    appUserModelId: appId,
    toastActivatorClsid: clsid,
  };
  if (icon) {
    options.icon = icon;
    options.iconIndex = 0;
  }
  return options;
}

const samePath = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();
const bareClsid = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();

// True when the shortcut on disk already says what we would write.
function sameShortcut(current, wanted) {
  if (!current) return false;
  return samePath(current.target, wanted.target)
    && samePath(current.cwd, wanted.cwd)
    && current.args === wanted.args
    && (wanted.icon ? samePath(current.icon, wanted.icon) : !current.icon)
    && current.appUserModelId === wanted.appUserModelId
    && bareClsid(current.toastActivatorClsid) === bareClsid(wanted.toastActivatorClsid);
}

// A shortcut with our app id that starts some electron.exe and is not ours:
// the "Electron.lnk" an unbranded electron.exe makes, or one left by an old
// or test copy. It would compete with ours for the taskbar icon.
function isStaleDevShortcut(link, appId = DEV_APP_ID) {
  return !!link
    && link.appUserModelId === appId
    && path.basename(link.target || '').toLowerCase() === 'electron.exe';
}

module.exports = {
  DEV_PRODUCT_NAME,
  DEV_APP_ID,
  DEV_TOAST_CLSID,
  devShortcutName,
  devShortcutOptions,
  sameShortcut,
  isStaleDevShortcut,
};
