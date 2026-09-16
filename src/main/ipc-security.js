'use strict';

function getHttpOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isTrustedMainFrame(sender, frame, expectedUrl) {
  if (!sender || !frame) return false;
  try {
    if (sender.isDestroyed?.() || frame.isDestroyed?.()) return false;
    if (frame !== sender.mainFrame) return false;

    const expectedOrigin = getHttpOrigin(expectedUrl);
    if (!expectedOrigin) return false;
    return getHttpOrigin(frame.url) === expectedOrigin &&
      getHttpOrigin(sender.getURL?.()) === expectedOrigin;
  } catch {
    return false;
  }
}

module.exports = { getHttpOrigin, isTrustedMainFrame };
