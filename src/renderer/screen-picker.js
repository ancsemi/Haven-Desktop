'use strict';

const picker = window.havenScreenPicker;

function setText(id, value) {
  document.getElementById(id).textContent = String(value || '');
}

function imageDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value) ? value : null;
}

function normalizePreference(value) {
  const normalized = String(value || '').toLowerCase();
  return ['auto', 'hardware', 'h264', 'vp8', 'vp9', 'av1', 'h265'].includes(normalized)
    ? normalized
    : 'auto';
}

function browserEncoderAvailability(hardwareAvailable) {
  const codecs = window.RTCRtpSender?.getCapabilities?.('video')?.codecs || [];
  const names = new Set(codecs.map(codec => String(codec.mimeType || '').toLowerCase()));
  return {
    auto: true,
    hardware: hardwareAvailable && names.has('video/h264'),
    h264: names.has('video/h264'),
    vp8: names.has('video/vp8'),
    vp9: names.has('video/vp9'),
    av1: names.has('video/av1'),
    h265: names.has('video/h265') || names.has('video/hevc'),
  };
}

picker.onData(data => {
  if (!data || typeof data.requestId !== 'string') {
    picker.submit({ cancelled: true });
    return;
  }

  const copy = data.copy || {};
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const audioApps = Array.isArray(data.audioApps) ? data.audioApps : [];
  const audioCapabilities = data.audioCapabilities || {};
  const encoder = data.videoEncoder || {};
  const nativeMode = data.nativeMode === true;
  const portalOnly = data.portalOnly === true && sources.length === 1;

  document.documentElement.lang = data.locale || 'en';
  document.documentElement.dir = data.direction === 'rtl' ? 'rtl' : 'ltr';
  document.title = copy.title || document.title;
  setText('picker-title', copy.title);
  setText('picker-subtitle', portalOnly ? copy.portalSubtitle : nativeMode ? copy.nativeSubtitle : copy.subtitle);
  setText('screens-title', copy.screens);
  setText('windows-title', copy.windows);
  setText('video-title', copy.videoEncoder);
  setText('audio-title', copy.audio);
  setText('application-audio-title', copy.applicationAudio);
  setText('cancel', copy.cancel);
  setText('share', portalOnly ? copy.continue : copy.share);

  const screens = document.getElementById('screens');
  const windows = document.getElementById('windows');
  const share = document.getElementById('share');
  let selectedSource = portalOnly ? sources[0].id : null;
  let selectedAudio = 'none';
  let selectedEncoder = normalizePreference(encoder.preference);
  share.disabled = !selectedSource;

  const selectSource = (button, sourceId) => {
    document.querySelectorAll('.source.selected').forEach(element => {
      element.classList.remove('selected');
      element.setAttribute('aria-pressed', 'false');
    });
    button.classList.add('selected');
    button.setAttribute('aria-pressed', 'true');
    selectedSource = sourceId;
    share.disabled = false;
  };

  if (!portalOnly) {
    for (const source of sources) {
      if (!source || typeof source.id !== 'string') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.setAttribute('aria-pressed', 'false');

      const previewUrl = imageDataUrl(source.thumbnail);
      if (previewUrl) {
        const preview = document.createElement('img');
        preview.src = previewUrl;
        preview.alt = '';
        button.appendChild(preview);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'preview-placeholder';
        placeholder.textContent = copy.noPreview || '';
        button.appendChild(placeholder);
      }

      const name = document.createElement('div');
      name.className = 'source-name';
      name.textContent = String(source.name || source.id);
      name.title = name.textContent;
      button.appendChild(name);
      button.addEventListener('click', () => selectSource(button, source.id));
      (source.id.startsWith('screen:') ? screens : windows).appendChild(button);
    }
  }
  document.getElementById('screens-section').hidden = portalOnly || screens.children.length === 0;
  document.getElementById('windows-section').hidden = portalOnly || windows.children.length === 0;

  const nativeCodecs = new Set((Array.isArray(encoder.codecs) ? encoder.codecs : [])
    .map(codec => String(codec?.name || codec).toLowerCase()));
  const availability = nativeMode
    ? {
        auto: nativeCodecs.has('h264'),
        hardware: false,
        h264: nativeCodecs.has('h264'),
        vp8: false,
        vp9: false,
        av1: nativeCodecs.has('av1'),
        h265: nativeCodecs.has('h265'),
      }
    : browserEncoderAvailability(encoder.hardwareAvailable === true);
  const encoderOptions = [
    ['hardware', copy.hardwareH264],
    ['auto', copy.automaticEncoder],
    ['h264', 'H.264'],
    ['vp8', 'VP8'],
    ['vp9', 'VP9'],
    ['av1', 'AV1'],
    ['h265', 'H.265 / HEVC'],
  ];
  const select = document.getElementById('video-encoder');
  for (const [value, label] of encoderOptions) {
    if (nativeMode && value === 'hardware') continue;
    if (value !== 'hardware' && !availability[value]) continue;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'hardware' && !availability.hardware
      ? `${label} - ${copy.unavailable}`
      : label;
    option.disabled = value === 'hardware' && !availability.hardware;
    select.appendChild(option);
  }
  if (!availability[selectedEncoder]) selectedEncoder = 'auto';
  select.value = selectedEncoder;
  select.addEventListener('change', () => { selectedEncoder = normalizePreference(select.value); });

  const nativeEncoders = (Array.isArray(encoder.codecs) ? encoder.codecs : [])
    .map(codec => `${codec.name} (${codec.encoder})`).join(', ');
  const encoderNote = nativeMode
    ? String(copy.nativeEncodingAvailable || '').replace('{encoders}', nativeEncoders)
    : encoder.hardwareAvailable === true
      ? copy.hardwareEncodingAvailable
      : String(copy.hardwareEncodingUnavailable || '').replace('{status}', encoder.hardwareStatus || 'unavailable');
  setText('video-note', `${encoderNote || ''} ${availability.h265 ? copy.h265Available : copy.h265Unavailable}`.trim());

  const modes = document.getElementById('audio-modes');
  const apps = document.getElementById('audio-apps');
  const selectAudio = (button, value) => {
    document.querySelectorAll('.audio-option.selected').forEach(element => {
      element.classList.remove('selected');
      element.setAttribute('aria-pressed', 'false');
    });
    button.classList.add('selected');
    button.setAttribute('aria-pressed', 'true');
    selectedAudio = value;
  };
  const addAudioOption = (parent, label, value, selected = false, icon = null) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `audio-option${selected ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const iconUrl = imageDataUrl(icon);
    if (iconUrl) {
      const image = document.createElement('img');
      image.src = iconUrl;
      image.alt = '';
      button.appendChild(image);
    }
    const text = document.createElement('span');
    text.textContent = String(label || '');
    button.appendChild(text);
    button.addEventListener('click', () => selectAudio(button, value));
    parent.appendChild(button);
    return button;
  };

  addAudioOption(modes, copy.noAudio, 'none', true);
  if (audioCapabilities.system === true) {
    addAudioOption(modes, copy.systemAudio, 'system');
  } else {
    const unavailable = document.createElement('span');
    unavailable.className = 'empty';
    unavailable.textContent = copy.systemUnavailable || '';
    modes.appendChild(unavailable);
  }

  if (audioCapabilities.application === true && audioApps.length) {
    for (const app of audioApps) {
      if (!Number.isSafeInteger(app?.pid) || app.pid <= 0) continue;
      const label = app.active === false
        ? `${app.name || app.pid} (${copy.silent || ''})`
        : app.name || String(app.pid);
      const button = addAudioOption(apps, label, app.pid, false, app.icon);
      if (app.active === false) {
        button.classList.add('silent');
        button.title = copy.silentDescription || '';
      }
    }
  }
  if (!apps.children.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = audioCapabilities.application === true
      ? copy.noApplications || ''
      : copy.applicationUnavailable || '';
    apps.appendChild(empty);
  }

  let submitted = false;
  const submit = cancelled => {
    if (submitted) return;
    submitted = true;
    picker.submit(cancelled ? {
      requestId: data.requestId,
      cancelled: true,
    } : {
      requestId: data.requestId,
      sourceId: selectedSource,
      audioAppPid: selectedAudio,
      videoEncoderPreference: selectedEncoder,
    });
  };
  document.getElementById('cancel').addEventListener('click', () => submit(true));
  share.addEventListener('click', () => submit(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') submit(true);
  });
});
