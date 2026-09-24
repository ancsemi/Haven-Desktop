'use strict';

// Which server certificates Haven Desktop accepts without asking.
//
// A Haven server often uses a certificate it made itself, which no authority
// vouches for. The app used to accept every certificate from every host, so
// anyone on the same network could pose as a remote server and collect the
// passwords and messages sent to it. The rule now:
//   - a certificate the system already trusts is accepted as usual;
//   - this computer and the local network stay automatic, since that is
//     where a server's own certificate is the normal case;
//   - any other host's own certificate is accepted once the user trusts it,
//     and is remembered by fingerprint, so a different one asks again.

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** This computer, a private (RFC 1918) or link-local address, or a .local name. */
function isLocalHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.startsWith('::ffff:')) return isLocalHost(h.slice(7));
  if (h === '::1') return true;
  // fe80::/10 link-local and fc00::/7 unique local
  return /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
}

/**
 * What to do with a server's certificate:
 *   'system'         the system trusts it, so Chromium's own verdict stands
 *   'local'          this computer or the local network: accept
 *   'pinned'         the certificate the user trusted before: accept
 *   'changed'        not the one the user trusted before: ask again
 *   'grandfathered'  a server used before certificates were checked:
 *                    accept once and remember it
 *   'unknown'        never seen: ask
 */
function certDecision({ hostname, errorCode, fingerprint }, { pins = {}, grandfathered = [] } = {}) {
  if (errorCode === 0) return 'system';
  const host = normalizeHost(hostname);
  if (isLocalHost(host)) return 'local';
  const pinned = Object.prototype.hasOwnProperty.call(pins, host) ? pins[host] : null;
  if (pinned) return pinned === fingerprint ? 'pinned' : 'changed';
  if (grandfathered.includes(host)) return 'grandfathered';
  return 'unknown';
}

module.exports = { normalizeHost, isLocalHost, certDecision };
