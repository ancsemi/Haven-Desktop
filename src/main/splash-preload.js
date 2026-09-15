const { ipcRenderer } = require('electron');
const { createTranslator } = require('../i18n');

let state = ipcRenderer.sendSync('i18n:get-state-sync');

function applyTranslations() {
  const t = createTranslator(state.locale);
  document.documentElement.lang = state.locale;
  document.documentElement.dir = state.direction;

  if (!document.getElementById('haven-connection-error')) {
    document.title = t('splash.windowTitle');
  }

  document.title = document.getElementById('haven-connection-error')
    ? t('connection.problemTitle')
    : t('splash.windowTitle');
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  });
}

function bindConnectionError() {
  const page = document.getElementById('haven-connection-error');
  if (!page) return;

  const t = createTranslator(state.locale);
  const params = new URLSearchParams(location.search);
  const url = params.get('url') || '';
  const primary = params.get('primary') || '';

  document.title = t('connection.problemTitle');
  const msg = document.getElementById('error-message');
  if (msg) msg.textContent = t('connection.problemMessage', { url });
  const urlEl = document.getElementById('error-url');
  if (urlEl) {
    urlEl.textContent = url;
    urlEl.hidden = !url;
  }

  document.getElementById('btn-retry')?.addEventListener('click', () => {
    ipcRenderer.send('nav:open-app', url);
  });
  document.getElementById('btn-welcome')?.addEventListener('click', () => {
    ipcRenderer.send('nav:back-to-welcome');
  });
  const back = document.getElementById('btn-back-server');
  if (back && primary && primary !== url) {
    back.hidden = false;
    back.addEventListener('click', () => {
      ipcRenderer.send('nav:switch-server', primary);
    });
  }

  // Every other server this app knows, so a home server that is down does
  // not mean retyping an address to reach a friend's (Haven #5666). The
  // failed one and the Go Back button's server are left out.
  const others = document.getElementById('error-others');
  const list = document.getElementById('error-others-list');
  if (others && list) {
    ipcRenderer.invoke('server-history:get').then((history) => {
      const entries = (history || [])
        .filter(h => h && h.url && h.url !== url && h.url !== primary)
        .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
      if (!entries.length) return;
      list.replaceChildren();
      for (const entry of entries) {
        let name;
        try { name = (entry.name && entry.name !== entry.url) ? entry.name : new URL(entry.url).hostname; }
        catch { name = entry.url; }
        const btn = document.createElement('button');
        btn.type = 'button';
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = name;
        const urlEl = document.createElement('span');
        urlEl.className = 'url';
        urlEl.textContent = entry.url;
        btn.append(nameEl, urlEl);
        btn.addEventListener('click', () => {
          ipcRenderer.send('nav:switch-server', entry.url);
        });
        list.appendChild(btn);
      }
      others.hidden = false;
    }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  bindConnectionError();
});
ipcRenderer.on('i18n:changed', (_event, nextState) => {
  state = nextState;
  applyTranslations();
  const msg = document.getElementById('error-message');
  if (msg) {
    const t = createTranslator(state.locale);
    const url = new URLSearchParams(location.search).get('url') || '';
    msg.textContent = t('connection.problemMessage', { url });
    document.title = t('connection.problemTitle');
  }
});
