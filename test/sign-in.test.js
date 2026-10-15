'use strict';

// Single sign-on runs in the server view: the server's own move to its OIDC
// start sends the page to the identity provider and back. Only that round
// trip may leave the server, and nothing the page asks of the app works
// while it shows the provider.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSignInRoundTrip, SIGN_IN_WINDOW_MS } = require('../src/main/ipc-policy');
const { isTrustedMainFrame } = require('../src/main/ipc-security');

const SERVER = 'https://haven.example';
const IDP = 'https://login.idp.example';

function trip() {
  let clock = 1000;
  const t = createSignInRoundTrip({ now: () => clock });
  return { t, wait: (ms) => { clock += ms; } };
}

test('the sign-in round trip stays in the view, provider pages included, and ends at home', () => {
  const { t } = trip();
  assert.equal(t.decide(`${SERVER}/api/auth/oidc/start`, SERVER), 'stay');
  assert.equal(t.decide(`${IDP}/authorize?client_id=x`, SERVER, { redirect: true }), 'stay');
  assert.equal(t.decide(`${IDP}/login/password`, SERVER), 'stay', 'the provider form posts to itself');
  assert.equal(t.decide(`${IDP}/mfa`, SERVER, { redirect: true }), 'stay');
  assert.equal(t.decide(`${SERVER}/api/auth/oidc/callback?code=1&state=2`, SERVER, { redirect: true }), 'stay');
  assert.equal(t.isOpen(), false, 'back on the server closes it');
  assert.equal(t.decide(`${SERVER}/`, SERVER, { redirect: true }), 'stay');
  assert.equal(t.decide(`${IDP}/login`, SERVER), 'browser', 'the provider is not reachable afterwards');
});

test('only a redirect from the start names the provider', () => {
  const { t } = trip();
  t.decide(`${SERVER}/api/auth/oidc/start`, SERVER);
  assert.equal(t.decide('https://evil.example/', SERVER), 'browser', 'a page navigation is not the server redirect');
  assert.equal(t.decide(`${IDP}/authorize`, SERVER, { redirect: true }), 'browser', 'and it ended the round trip');
});

test('without the start there is no way out, and a redirect elsewhere still opens in the browser', () => {
  const { t } = trip();
  assert.equal(t.decide(`${IDP}/authorize`, SERVER, { redirect: true }), 'browser');
  t.decide(`${SERVER}/other`, SERVER);
  assert.equal(t.decide(`${IDP}/authorize`, SERVER, { redirect: true }), 'browser');
});

test('going anywhere else ends the round trip', () => {
  const { t } = trip();
  t.decide(`${SERVER}/api/auth/oidc/start`, SERVER);
  t.decide(`${IDP}/authorize`, SERVER, { redirect: true });
  assert.equal(t.decide('https://elsewhere.example/', SERVER), 'browser');
  assert.equal(t.decide(`${IDP}/login`, SERVER), 'browser');
  assert.equal(t.decide('ms-msdt:/id', SERVER), 'block');
});

test('the round trip expires', () => {
  const { t, wait } = trip();
  t.decide(`${SERVER}/api/auth/oidc/start`, SERVER);
  t.decide(`${IDP}/authorize`, SERVER, { redirect: true });
  wait(SIGN_IN_WINDOW_MS + 1);
  assert.equal(t.isOpen(), false);
  assert.equal(t.decide(`${IDP}/login`, SERVER), 'browser');
});

test('a server view showing the provider is not a trusted frame for its server', () => {
  const frame = { url: `${IDP}/login`, isDestroyed: () => false };
  const sender = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  assert.equal(isTrustedMainFrame(sender, frame, SERVER), false);
  frame.url = `${SERVER}/app.html`;
  assert.equal(isTrustedMainFrame(sender, frame, SERVER), true);
});

// Every channel the server page's preload can reach must check the sender's
// frame in main, so the provider page (or any page that is not the server's)
// gets nothing. Two read-only bootstrap calls only report the language.
test('every app preload channel checks its sender frame in main', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const main = read('main', 'main.js');
  const preload = read('main', 'app-preload.js');
  const channels = new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\('([a-z0-9:-]+)'/g)].map(m => m[1]));
  for (const c of ['window:enter-fullscreen', 'window:leave-fullscreen', 'dialog:alert', 'dialog:confirm', 'dialog:prompt']) channels.add(c);
  const BOOTSTRAP = new Set(['i18n:get-state-sync', 'i18n:is-active-server-sync']);
  const GUARDS = /fromActiveServer|fromAnyServer|fromAppScreen|fromWelcomeScreen|getTrustedServerUrlForFrame|serverListSender|serverListReader|serverCheckAllowed|requestServerListChange|isLanguageSenderAllowed|windowControlAllowed|pageDialog|event\.senderFrame !== requestFrame/;
  for (const channel of channels) {
    if (BOOTSTRAP.has(channel)) continue;
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = main.search(new RegExp(`(ipcMain\\.(handle|on)|handleFromActiveServer|handleFromAnyServer)\\('${escaped}'`));
    assert.ok(at >= 0, `${channel} has a handler in main`);
    const head = main.slice(at, at + 400);
    if (/^handleFrom(Active|Any)Server/.test(head)) continue;
    if (/^ipcMain\.on\('[a-z0-9:-]+', handler\)/.test(head)) {
      // The share flow's own listener answers only the frame it asked.
      assert.match(main, /if \(event\.sender !== targetContents \|\| event\.senderFrame !== requestFrame\) return;/, channel);
      continue;
    }
    assert.match(head, GUARDS, channel);
  }
});
