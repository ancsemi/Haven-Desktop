'use strict';

// Checking a new server before joining it (Haven Desktop #62).
//
// The Join screen and the server picker fetch /api/health before opening a
// server. A server on a public address usually has its own certificate, and
// the certificate rules only ask about hosts the user is opening as a server,
// which used to mean hosts already saved. A new one was refused before the
// user was ever asked. The screen now says which server it is about to check,
// main keeps that host for a short while, and the trust question is asked as
// for any saved server. Trusting is still the user's choice.

const { normalizeHost } = require('./cert-trust');

const CHECK_WINDOW_MS = 2 * 60 * 1000;
const MAX_CHECK_HOSTS = 16;
const HEALTH_TIMEOUT_MS = 8000;

/** The host of an http(s) URL, or '' for anything else. */
function hostOfHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return normalizeHost(url.hostname);
  } catch {
    return '';
  }
}

/**
 * Hosts a local screen is checking right now. Each one counts as a server
 * host for CHECK_WINDOW_MS, and remembers whether the user trusted its
 * certificate during that time, so a check that failed while the question
 * was open knows to try again.
 */
function createServerCheckHosts({ now = Date.now, windowMs = CHECK_WINDOW_MS, max = MAX_CHECK_HOSTS } = {}) {
  const hosts = new Map(); // host -> { expires, trusted }

  function prune() {
    const t = now();
    for (const [host, entry] of hosts) if (entry.expires <= t) hosts.delete(host);
  }

  return {
    /** Start checking url's host. False when url is not an http(s) URL. */
    add(url) {
      const host = hostOfHttpUrl(url);
      if (!host) return false;
      prune();
      hosts.delete(host);
      hosts.set(host, { expires: now() + windowMs, trusted: false });
      while (hosts.size > max) hosts.delete(hosts.keys().next().value);
      return true;
    },
    has(host) {
      prune();
      return hosts.has(normalizeHost(host));
    },
    /** The user trusted host's certificate; noted only while it is being checked. */
    markTrusted(host) {
      prune();
      const entry = hosts.get(normalizeHost(host));
      if (entry) entry.trusted = true;
    },
    trustedDuringCheck(url) {
      prune();
      return !!hosts.get(hostOfHttpUrl(url))?.trusted;
    },
  };
}

/** True for one of the app's own screens (a file:// page in its main frame). */
function isLocalScreenFrame(sender, frame) {
  if (!sender || !frame) return false;
  try {
    if (sender.isDestroyed?.() || frame.isDestroyed?.()) return false;
    if (frame !== sender.mainFrame) return false;
    return String(frame.url || '').startsWith('file://') &&
      String(sender.getURL?.() || '').startsWith('file://');
  } catch (err) {
    console.warn('[server-check] could not read the sender frame', err?.message || err);
    return false;
  }
}

/** The https:// form of an http:// URL, or null. Haven serves HTTPS on its port. */
function httpsFallbackUrl(url) {
  return /^http:\/\//i.test(String(url || '')) ? 'https://' + String(url).slice(7) : null;
}

/**
 * Fetch url/api/health once. The timeout is held back while a certificate
 * question for the server is open, so a slow answer does not fail the check.
 * Resolves to the Response, or null when the request failed.
 */
async function fetchHealth(url, { fetch, questionPending, timeoutMs = HEALTH_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const controller = new AbortController();
  let timer = null;
  let done = false;
  const arm = () => {
    timer = setTimer(async () => {
      let pending = false;
      try { pending = await questionPending(url); } catch (err) {
        console.warn('[server-check] could not ask about a certificate question', err?.message || err);
      }
      if (done) return;
      if (pending) arm(); else controller.abort();
    }, timeoutMs);
  };
  arm();
  try {
    return await fetch(url + '/api/health', { signal: controller.signal });
  } catch {
    return null; // unreachable, refused or timed out: the caller reports it
  } finally {
    done = true;
    clearTimer(timer);
  }
}

/**
 * The Join screen and server picker check. Tells main which server is being
 * checked, fetches its health, and when that fails while the user was asked
 * about the certificate, waits for the answer and tries once more after a
 * yes. An http:// address that cannot be reached is tried once as https://.
 * Resolves to { ok, url, response }, url being the address that answered.
 */
async function checkServer(url, deps) {
  const { begin, waitForTrust } = deps;
  const attempt = async (target) => {
    await begin(target);
    let res = await fetchHealth(target, deps);
    if (res && res.ok) return res;
    if (await waitForTrust(target)) res = await fetchHealth(target, deps);
    return res;
  };
  const res = await attempt(url);
  if (res && res.ok) return { ok: true, url, response: res };
  const secure = !res && httpsFallbackUrl(url);
  if (secure) {
    const retry = await attempt(secure);
    if (retry && retry.ok) return { ok: true, url: secure, response: retry };
  }
  return { ok: false, url, response: res };
}

module.exports = {
  CHECK_WINDOW_MS,
  HEALTH_TIMEOUT_MS,
  hostOfHttpUrl,
  createServerCheckHosts,
  isLocalScreenFrame,
  httpsFallbackUrl,
  fetchHealth,
  checkServer,
};
