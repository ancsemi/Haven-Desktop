'use strict';

function normalizeServerUrl(serverUrl) {
  let value = String(serverUrl || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.search = '';
    let pathname = parsed.pathname || '/';
    pathname = pathname.replace(/\/+$/, '') || '/';
    pathname = pathname.replace(/\/app(?:\.html)?$/i, '') || '/';
    pathname = pathname.replace(/\/+$/, '') || '/';
    return pathname === '/' ? parsed.origin : parsed.origin + pathname;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

// Reject obvious garbage (e.g. "https://https", bare words with no TLD)
// while still allowing localhost and IP literals.
function isValidServerHost(serverUrl) {
  try {
    const host = new URL(serverUrl).hostname;
    if (!host) return false;
    if (host === 'localhost') return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4
    if (host.includes(':')) return true; // IPv6 / bracketed
    return host.includes('.') && !/^https?$/i.test(host);
  } catch { return false; }
}

// Dedup + clean a stored serverHistory list. Re-normalizes URLs (lowercases
// host, strips /app paths) and drops malformed entries left over from earlier
// versions that didn't validate input.
function sanitizeServerHistory(list) {
  const seen = new Set();
  const out = [];
  for (const entry of (list || [])) {
    if (!entry || !entry.url) continue;
    const normalizedUrl = normalizeServerUrl(entry.url);
    if (!normalizedUrl || !isValidServerHost(normalizedUrl)) continue;
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    out.push({ ...entry, url: normalizedUrl });
  }
  return out;
}

module.exports = { normalizeServerUrl, isValidServerHost, sanitizeServerHistory };
