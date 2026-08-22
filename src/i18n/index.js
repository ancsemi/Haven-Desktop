const en = require('./locales/en');
const ptBR = require('./locales/pt-BR');

const DEFAULT_LOCALE = 'en';
const AUTOMATIC_LANGUAGE = 'auto';
const LEGACY_SYSTEM_LANGUAGE = 'system';
const SYSTEM_LANGUAGE = AUTOMATIC_LANGUAGE;

const LOCALES = Object.freeze({
  en,
  'pt-BR': ptBR,
});

const SUPPORTED_LOCALES = Object.freeze([
  Object.freeze({ code: 'en', name: 'English', direction: 'ltr' }),
  Object.freeze({ code: 'pt-BR', name: 'Português (Brasil)', direction: 'ltr' }),
]);

function normalizeLocale(value) {
  const candidate = String(value || '').trim().replace(/_/g, '-');
  if (!candidate) return null;

  const exact = SUPPORTED_LOCALES.find(({ code }) => code.toLowerCase() === candidate.toLowerCase());
  if (exact) return exact.code;

  const base = candidate.split('-')[0].toLowerCase();
  const baseMatch = SUPPORTED_LOCALES.find(({ code }) => code.split('-')[0].toLowerCase() === base);
  return baseMatch?.code || null;
}

function resolveLocale(preference, systemLanguages = []) {
  if (preference && preference !== AUTOMATIC_LANGUAGE && preference !== LEGACY_SYSTEM_LANGUAGE) {
    return normalizeLocale(preference) || DEFAULT_LOCALE;
  }

  for (const language of systemLanguages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

function interpolate(message, values = {}) {
  return String(message).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
  });
}

function translate(locale, key, values) {
  const resolved = normalizeLocale(locale) || DEFAULT_LOCALE;
  const message = LOCALES[resolved]?.[key] ?? LOCALES[DEFAULT_LOCALE]?.[key];
  return interpolate(message ?? key, values);
}

function createTranslator(locale) {
  return (key, values) => translate(locale, key, values);
}

function getLocaleMetadata(locale) {
  const resolved = normalizeLocale(locale) || DEFAULT_LOCALE;
  return SUPPORTED_LOCALES.find(({ code }) => code === resolved);
}

module.exports = {
  DEFAULT_LOCALE,
  AUTOMATIC_LANGUAGE,
  LEGACY_SYSTEM_LANGUAGE,
  SYSTEM_LANGUAGE,
  LOCALES,
  SUPPORTED_LOCALES,
  normalizeLocale,
  resolveLocale,
  translate,
  createTranslator,
  getLocaleMetadata,
};
