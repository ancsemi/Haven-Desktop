const { ipcRenderer } = require('electron');
const { createTranslator } = require('../i18n');

let state = ipcRenderer.sendSync('i18n:get-state-sync');

function applyTranslations() {
  const t = createTranslator(state.locale);
  document.documentElement.lang = state.locale;
  document.documentElement.dir = state.direction;
  document.title = t('splash.windowTitle');

  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  });
}

document.addEventListener('DOMContentLoaded', applyTranslations);
ipcRenderer.on('i18n:changed', (_event, nextState) => {
  state = nextState;
  applyTranslations();
});
