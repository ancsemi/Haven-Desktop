const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HARDWARE_H264_PROFILE,
  preferHardwareH264Codec,
} = require('../src/main/screen-share-video');

test('prefers compatible H.264 while retaining every fallback', () => {
  const vp8 = { mimeType: 'video/VP8' };
  const incompatibleH264 = {
    mimeType: 'video/H264',
    sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f',
  };
  const preferredH264 = {
    mimeType: 'video/H264',
    sdpFmtpLine: 'PROFILE-LEVEL-ID=42E01F;level-asymmetry-allowed=1;packetization-mode=1',
  };
  let preferences;
  const transceiver = {
    setCodecPreferences(codecs) { preferences = codecs; },
  };

  assert.equal(preferHardwareH264Codec(
    transceiver,
    [vp8, incompatibleH264, preferredH264]
  ), true);
  assert.deepEqual(preferences, [preferredH264, vp8, incompatibleH264]);
});

test('leaves negotiation untouched without compatible H.264', () => {
  let called = false;
  const transceiver = {
    setCodecPreferences() { called = true; },
  };

  assert.equal(preferHardwareH264Codec(
    transceiver,
    [{ mimeType: 'video/VP8' }]
  ), false);
  assert.equal(called, false);
});

test('falls back safely when Chromium rejects codec preferences', () => {
  const transceiver = {
    setCodecPreferences() { throw new Error('invalid codec'); },
  };
  const codecs = [{
    mimeType: 'video/H264',
    sdpFmtpLine: HARDWARE_H264_PROFILE,
  }];

  assert.equal(preferHardwareH264Codec(transceiver, codecs), false);
});
