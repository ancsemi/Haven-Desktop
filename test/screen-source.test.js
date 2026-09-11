'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRefreshedSource } = require('../src/main/screen-source');

test('rejects a source that was not offered by the picker', () => {
  const original = [{ id: 'window:1:0', name: 'Editor', display_id: '' }];
  const fresh = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '10' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), null);
});

test('keeps an exact refreshed source', () => {
  const original = [{ id: 'window:1:0', name: 'Editor', display_id: '' }];
  const fresh = [{ id: 'window:1:0', name: 'Editor', display_id: '' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'window:1:0'), fresh[0]);
});

test('rejects an exact ID reused by a different source', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '10' }];
  const fresh = [{ id: 'screen:0:0', name: 'Screen 2', display_id: '20' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), null);
});

test('rejects a screen without a stable display ID', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '' }];
  const fresh = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), null);
});

test('rejects a window whose title changed during selection', () => {
  const original = [{ id: 'window:1:0', name: 'Editor - Saving', display_id: '' }];
  const fresh = [{ id: 'window:1:0', name: 'Editor - Saved', display_id: '' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'window:1:0'), null);
});

test('resolves a changed screen ID only on the same display', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '10' }];
  const fresh = [
    { id: 'screen:4:0', name: 'Primary', display_id: '20' },
    { id: 'screen:5:0', name: 'Secondary', display_id: '10' },
  ];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), fresh[1]);
});

test('does not trust a window name after its native ID changes', () => {
  const original = [{ id: 'window:1:0', name: 'Editor', display_id: '' }];
  const fresh = [{ id: 'window:9:0', name: 'Editor', display_id: '' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'window:1:0'), null);
});

test('rejects ambiguous screen matches on the same display', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '10' }];
  const fresh = [
    { id: 'screen:4:0', name: 'Primary', display_id: '10' },
    { id: 'screen:5:0', name: 'Duplicate', display_id: '10' },
  ];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), null);
});

test('normalizes display ID types across enumerations', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: 10 }];
  const fresh = [{ id: 'screen:4:0', name: 'Primary', display_id: '10' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), fresh[0]);
});

test('never widens a missing window capture to a screen', () => {
  const original = [{ id: 'window:1:0', name: 'Editor', display_id: '10' }];
  const fresh = [{ id: 'screen:0:0', name: 'Editor', display_id: '10' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'window:1:0'), null);
});

test('does not fall back to an arbitrary screen', () => {
  const original = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '10' }];
  const fresh = [{ id: 'screen:1:0', name: 'Screen 2', display_id: '20' }];
  assert.equal(resolveRefreshedSource(original, fresh, 'screen:0:0'), null);
});
