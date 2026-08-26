const HARDWARE_H264_PROFILE = 'packetization-mode=1;profile-level-id=42e01f';
const VIDEO_ENCODER_PREFERENCES = new Set([
  'auto', 'hardware', 'h264', 'vp8', 'vp9', 'av1', 'h265',
]);
const AUXILIARY_CODECS = new Set([
  'video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03',
]);

function normalizeVideoEncoderPreference(value) {
  return VIDEO_ENCODER_PREFERENCES.has(value) ? value : 'hardware';
}

function codecFamily(codec) {
  const mimeType = codec?.mimeType?.toLowerCase();
  if (mimeType === 'video/hevc') return 'h265';
  return mimeType?.startsWith('video/') ? mimeType.slice(6) : null;
}

function fmtpParameters(codec) {
  return new Map(
    String(codec?.sdpFmtpLine || '')
      .split(';')
      .map(parameter => parameter.trim().toLowerCase().split('=', 2))
  );
}

function isHardwareH264Profile(codec) {
  if (codecFamily(codec) !== 'h264') return false;
  const parameters = fmtpParameters(codec);
  return parameters.get('packetization-mode') === '1'
    && parameters.get('profile-level-id') === '42e01f';
}

function getAvailableVideoEncoderPreferences(codecs, hardwareAvailable = false) {
  const families = new Set((Array.isArray(codecs) ? codecs : []).map(codecFamily));
  const hasHardwareH264 = hardwareAvailable
    && (Array.isArray(codecs) ? codecs : []).some(isHardwareH264Profile);
  return {
    auto: true,
    hardware: hasHardwareH264,
    h264: families.has('h264'),
    vp8: families.has('vp8'),
    vp9: families.has('vp9'),
    av1: families.has('av1'),
    h265: families.has('h265'),
  };
}

function codecRank(codec, family) {
  const parameters = fmtpParameters(codec);
  if (family === 'h264') {
    if (isHardwareH264Profile(codec)) return 0;
    if (parameters.get('packetization-mode') === '1') return 1;
    return 2;
  }
  if (family === 'vp9') return parameters.get('profile-id') === '0' ? 0 : 1;
  return 0;
}

function applyVideoEncoderPreference(
  transceiver,
  codecs,
  requestedPreference,
  hardwareAvailable = false
) {
  const preference = normalizeVideoEncoderPreference(requestedPreference);
  if (!transceiver?.setCodecPreferences || !Array.isArray(codecs)) {
    return { applied: false, preference, reason: 'unsupported' };
  }

  if (preference === 'auto') {
    try {
      transceiver.setCodecPreferences([]);
      return { applied: true, preference, codec: 'auto' };
    } catch {
      return { applied: false, preference, reason: 'rejected' };
    }
  }

  if (preference === 'hardware' && !hardwareAvailable) {
    return { applied: false, preference, reason: 'hardware-unavailable' };
  }

  const family = preference === 'hardware' ? 'h264' : preference;
  let primaryCodecs = codecs.filter(codec => codecFamily(codec) === family);
  if (preference === 'hardware' && !primaryCodecs.some(isHardwareH264Profile)) {
    return { applied: false, preference, reason: 'hardware-codec-unavailable' };
  }

  if (!primaryCodecs.length) {
    return { applied: false, preference, reason: 'codec-unavailable' };
  }

  primaryCodecs = primaryCodecs
    .map((codec, index) => ({ codec, index }))
    .sort((left, right) =>
      codecRank(left.codec, family) - codecRank(right.codec, family)
      || left.index - right.index
    )
    .map(item => item.codec);

  const auxiliaryCodecs = codecs.filter(codec =>
    AUXILIARY_CODECS.has(codec?.mimeType?.toLowerCase())
  );

  try {
    transceiver.setCodecPreferences([...primaryCodecs, ...auxiliaryCodecs]);
    return {
      applied: true,
      preference,
      codec: family,
      mimeType: primaryCodecs[0].mimeType,
      sdpFmtpLine: primaryCodecs[0].sdpFmtpLine || '',
    };
  } catch {
    return { applied: false, preference, codec: family, reason: 'rejected' };
  }
}

module.exports = {
  HARDWARE_H264_PROFILE,
  normalizeVideoEncoderPreference,
  getAvailableVideoEncoderPreferences,
  applyVideoEncoderPreference,
};
