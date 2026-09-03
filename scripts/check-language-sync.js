const assert = require('assert');
const {
  serverLocaleForDesktop,
  desktopLocaleForServer,
  reconcileLanguagePreferences,
} = require('../src/i18n/server-bridge');

assert.equal(serverLocaleForDesktop('pt-BR'), 'pt');
assert.equal(serverLocaleForDesktop('auto'), 'auto');
assert.equal(desktopLocaleForServer('pt'), 'pt-BR');
assert.equal(desktopLocaleForServer('fr'), null);

assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'auto', isPreferenceStored: false }, 'pt'),
  { action: 'update-desktop', preference: 'pt-BR' }
);
assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'pt-BR', isPreferenceStored: true }, 'auto'),
  { action: 'update-server', preference: 'pt' }
);
assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'auto', isPreferenceStored: true }, 'auto'),
  { action: 'none' }
);
assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'en', isPreferenceStored: true }, 'fr'),
  { action: 'preserve-server', preference: 'fr' }
);
assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'auto', isPreferenceStored: false }, null),
  { action: 'none' }
);
assert.deepEqual(
  reconcileLanguagePreferences({ preference: 'pt-BR', isPreferenceStored: true }, 'en', { isActive: false }),
  { action: 'defer' }
);

console.log('Language synchronization checks passed.');
