const fs = require('fs');
const path = require('path');
const { LOCALES, DEFAULT_LOCALE } = require('../src/i18n');

const root = path.join(__dirname, '..');
const sourceRoot = path.join(root, 'src');
const referenceKeys = Object.keys(LOCALES[DEFAULT_LOCALE]).sort();
const errors = [];

for (const [locale, messages] of Object.entries(LOCALES)) {
  const keys = Object.keys(messages).sort();
  const missing = referenceKeys.filter(key => !Object.prototype.hasOwnProperty.call(messages, key));
  const extra = keys.filter(key => !Object.prototype.hasOwnProperty.call(LOCALES[DEFAULT_LOCALE], key));
  if (missing.length) errors.push(`${locale}: missing keys: ${missing.join(', ')}`);
  if (extra.length) errors.push(`${locale}: extra keys: ${extra.join(', ')}`);
  for (const key of referenceKeys) {
    if (!Object.prototype.hasOwnProperty.call(messages, key)) continue;
    const referencePlaceholders = [...LOCALES[DEFAULT_LOCALE][key].matchAll(/\{([A-Za-z0-9_]+)\}/g)]
      .map(match => match[1]).sort();
    const localePlaceholders = [...messages[key].matchAll(/\{([A-Za-z0-9_]+)\}/g)]
      .map(match => match[1]).sort();
    if (referencePlaceholders.join(',') !== localePlaceholders.join(',')) {
      errors.push(`${locale}: placeholder mismatch for ${key}`);
    }
  }
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:js|html)$/.test(entry.name) ? [fullPath] : [];
  });
}

const referencedKeys = new Set();
for (const file of sourceFiles(sourceRoot)) {
  if (file.includes(`${path.sep}i18n${path.sep}locales${path.sep}`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  const patterns = [
    /(?:\bt|\._t)\(\s*['"]([^'"]+)['"]/g,
    /\btranslate\(\s*[^,\n]+,\s*['"]([^'"]+)['"]/g,
    /['"](audio\.mode\.(?:include|exclude))['"]/g,
    /setI18n(?:Text|Title)\(\s*[^,\n]+,\s*['"]([^'"]+)['"]/g,
    /setTranslatedText\(\s*[^,\n]+,\s*['"]([^'"]+)['"]/g,
    /setErrorText\(\s*[^,\n]+,\s*[^,\n]+,\s*['"]([^'"]+)['"]/g,
    /createBanner\(\s*['"]([^'"]+)['"]/g,
    /createBanner\(\s*['"][^'"]+['"]\s*,\s*(?:null|\{[^}]*\})\s*,\s*['"]([^'"]+)['"]/g,
    /\b(?:error|message|detailReason)Key\s*[:=]\s*['"]([^'"]+)['"]/g,
    /setAppliedErrorDetail\(\s*['"]([^'"]+)['"]/g,
    /setAppliedErrorDetail\(\s*['"][^'"]+['"]\s*,\s*[^,\n]+,\s*['"]([^'"]+)['"]/g,
    /\[\s*['"][^'"]+['"]\s*,\s*['"]((?:audio|server|update)\.[^'"]+)['"]\s*\]/g,
    /data-(?:haven-)?i18n(?:-title|-aria-label)?=["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) referencedKeys.add(match[1]);
  }
}

for (const key of referencedKeys) {
  if (!Object.prototype.hasOwnProperty.call(LOCALES[DEFAULT_LOCALE], key)) {
    errors.push(`Source references unknown key: ${key}`);
  }
}

for (const key of referenceKeys) {
  if (!referencedKeys.has(key)) errors.push(`Catalog key is not referenced by source: ${key}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`i18n check passed: ${referenceKeys.length} keys across ${Object.keys(LOCALES).length} locales.`);
