const SERVER_LOCALE_KEY = 'haven_locale';
const SERVER_SUPPORTED_LOCALES = new Set(['auto', 'en', 'fr', 'de', 'es', 'pl', 'ru', 'zh', 'pt']);
const DESKTOP_TO_SERVER_LOCALE = Object.freeze({ auto: 'auto', en: 'en', 'pt-BR': 'pt' });
const SERVER_TO_DESKTOP_LOCALE = Object.freeze({ auto: 'auto', en: 'en', pt: 'pt-BR' });

function serverLocaleForDesktop(preference) {
  return DESKTOP_TO_SERVER_LOCALE[preference] || 'auto';
}

function desktopLocaleForServer(preference) {
  return SERVER_TO_DESKTOP_LOCALE[preference] || null;
}

function reconcileLanguagePreferences(desktopState, serverPreference, { isActive = true } = {}) {
  if (!isActive) return { action: 'defer' };
  const validServerPreference = SERVER_SUPPORTED_LOCALES.has(serverPreference)
    ? serverPreference
    : null;
  const mappedDesktopPreference = desktopLocaleForServer(validServerPreference);

  if (validServerPreference && !mappedDesktopPreference) {
    return { action: 'preserve-server', preference: validServerPreference };
  }
  if (desktopState.isPreferenceStored) {
    const desired = serverLocaleForDesktop(desktopState.preference);
    return desired === validServerPreference
      ? { action: 'none' }
      : { action: 'update-server', preference: desired };
  }
  if (mappedDesktopPreference) {
    return { action: 'update-desktop', preference: mappedDesktopPreference };
  }
  return { action: 'none' };
}

module.exports = {
  SERVER_LOCALE_KEY,
  serverLocaleForDesktop,
  desktopLocaleForServer,
  reconcileLanguagePreferences,
};
