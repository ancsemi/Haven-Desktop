const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVideoEncoderPreference,
  getAvailableVideoEncoderPreferences,
  applyVideoEncoderPreference,
} = require('../src/main/screen-share-video');

const vp8 = { mimeType: 'video/VP8' };
const rtx = { mimeType: 'video/rtx' };
const red = { mimeType: 'video/red' };
const ulpfec = { mimeType: 'video/ulpfec' };
const flexfec = { mimeType: 'video/flexfec-03' };
const h264Packet0 = {
  mimeType: 'video/H264',
  sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f',
};
const hardwareH264 = {
  mimeType: 'video/H264',
  sdpFmtpLine: 'PROFILE-LEVEL-ID=42E01F;level-asymmetry-allowed=1;packetization-mode=1',
};

test('normalizes invalid encoder preferences to hardware', () => {
  assert.equal(normalizeVideoEncoderPreference('vp9'), 'vp9');
  assert.equal(normalizeVideoEncoderPreference('invalid'), 'hardware');
});

test('hardware preference requests compatible H.264 and keeps transport codecs', () => {
  let preferences;
  const transceiver = {
    setCodecPreferences(codecs) { preferences = codecs; },
  };

  const result = applyVideoEncoderPreference(
    transceiver,
    [vp8, rtx, h264Packet0, red, hardwareH264, ulpfec, flexfec],
    'hardware',
    true
  );

  assert.equal(result.applied, true);
  assert.equal(result.codec, 'h264');
  assert.deepEqual(preferences, [
    hardwareH264, h264Packet0, rtx, red, ulpfec, flexfec,
  ]);
});

test('hardware preference does not mistake an H.264 profile for an encoder implementation', () => {
  let preferences;
  const transceiver = {
    setCodecPreferences(codecs) { preferences = codecs; },
  };

  assert.equal(
    getAvailableVideoEncoderPreferences([h264Packet0], true).hardware,
    true
  );
  const result = applyVideoEncoderPreference(
    transceiver,
    [h264Packet0, rtx],
    'hardware',
    true
  );

  assert.equal(result.applied, true);
  assert.deepEqual(preferences, [h264Packet0, rtx]);
});

test('hardware preference stays automatic when hardware is unavailable', () => {
  let called = false;
  const transceiver = {
    setCodecPreferences() { called = true; },
  };

  const result = applyVideoEncoderPreference(
    transceiver,
    [vp8, hardwareH264],
    'hardware',
    false
  );

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'hardware-unavailable');
  assert.equal(called, false);
});

test('explicit VP9 preference excludes other primary codecs', () => {
  const vp9Profile2 = { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=2' };
  const vp9Profile0 = { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' };
  let preferences;
  const transceiver = {
    setCodecPreferences(codecs) { preferences = codecs; },
  };

  const result = applyVideoEncoderPreference(
    transceiver,
    [vp8, vp9Profile2, rtx, vp9Profile0],
    'vp9',
    false
  );

  assert.equal(result.applied, true);
  assert.deepEqual(preferences, [vp9Profile0, vp9Profile2, rtx]);
});

test('automatic preference restores Chromium defaults', () => {
  let preferences;
  const transceiver = {
    setCodecPreferences(codecs) { preferences = codecs; },
  };

  const result = applyVideoEncoderPreference(transceiver, [vp8], 'auto');

  assert.equal(result.applied, true);
  assert.deepEqual(preferences, []);
});

test('reports only encoder preferences exposed by Chromium', () => {
  assert.deepEqual(
    getAvailableVideoEncoderPreferences(
      [vp8, hardwareH264, { mimeType: 'video/HEVC' }],
      true
    ),
    {
      auto: true,
      hardware: true,
      h264: true,
      vp8: true,
      vp9: false,
      av1: false,
      h265: true,
    }
  );
});

test('falls back safely when Chromium rejects codec preferences', () => {
  const transceiver = {
    setCodecPreferences() { throw new Error('invalid codec'); },
  };

  const result = applyVideoEncoderPreference(
    transceiver,
    [hardwareH264],
    'h264',
    true
  );

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'rejected');
});
