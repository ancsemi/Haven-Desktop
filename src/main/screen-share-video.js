const HARDWARE_H264_PROFILE = 'packetization-mode=1;profile-level-id=42e01f';

function preferHardwareH264Codec(transceiver, codecs) {
  if (!transceiver?.setCodecPreferences || !Array.isArray(codecs)) return false;

  const preferred = codecs.find(codec => {
    if (codec.mimeType?.toLowerCase() !== 'video/h264') return false;
    const parameters = new Map(
      String(codec.sdpFmtpLine || '')
        .split(';')
        .map(parameter => parameter.trim().toLowerCase().split('=', 2))
    );
    return parameters.get('packetization-mode') === '1'
      && parameters.get('profile-level-id') === '42e01f';
  });
  if (!preferred) return false;

  // Keep the browser's complete fallback list and only move the hardware-
  // compatible constrained-baseline profile to the front.
  const preferences = [
    preferred,
    ...codecs.filter(codec => codec !== preferred),
  ];

  try {
    transceiver.setCodecPreferences(preferences);
    return true;
  } catch {
    return false;
  }
}

module.exports = { HARDWARE_H264_PROFILE, preferHardwareH264Codec };
