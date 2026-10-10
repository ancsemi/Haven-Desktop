'use strict';

// What the auto-updater has found, kept in the main process so the update
// banner does not depend on a page being open at the moment the check
// answers. The start-up check used to answer while the server page was still
// loading, the one message it sent was lost, and nothing asked again until
// the next launch (Haven-Desktop #63). Pages now ask for this state when they
// load, and the app checks again every few hours while it stays open.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createUpdateState() {
  let found = null;        // { version, downloaded }
  let dismissed = false;   // the user closed the banner for this version
  let downloading = false;

  return {
    // A check found `version`. Returns true when the pages should be told:
    // a version not seen before, or one the user has not closed the banner
    // on. A check the user asked for (`asked`) always shows it again.
    available(version, asked = false) {
      const v = String(version || '');
      if (!found || found.version !== v) {
        found = { version: v, downloaded: false };
        dismissed = false;
        return true;
      }
      if (asked) dismissed = false;
      if (found.downloaded) return false;
      return !dismissed;
    },
    downloaded() {
      downloading = false;
      if (!found) found = { version: '', downloaded: true };
      found.downloaded = true;
      dismissed = false;
    },
    setDownloading(on) { downloading = !!on; },
    isDownloading() { return downloading; },
    dismiss() { if (found) dismissed = true; },
    // What a page that has just loaded should show, or null for nothing.
    forPage() {
      if (!found || dismissed) return null;
      return found.downloaded
        ? { status: 'downloaded', version: found.version }
        : { status: 'available', version: found.version };
    },
    // A background check is pointless once the update is downloading or
    // waiting to be installed.
    shouldCheck() { return !downloading && !(found && found.downloaded); },
  };
}

module.exports = { createUpdateState, CHECK_INTERVAL_MS };
