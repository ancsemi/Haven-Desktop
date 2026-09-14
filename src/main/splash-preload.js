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
