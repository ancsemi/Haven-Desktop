'use strict';

// ═══════════════════════════════════════════════════════════
// Haven Desktop: the server page's own world
//
// The part of the app preload that has to run beside the page's scripts:
// it replaces page globals (alert, Notification, getDisplayMedia, the
// fullscreen API, RTCPeerConnection hooks) and reads Haven's app object.
// app-preload.js injects it before any page script runs. It holds nothing
// from Electron: it reaches the app only through the narrow bridge the
// preload exposes, and main checks every call again, so a page that takes
// this code apart gains nothing it could not ask for itself.
//
// installPageWorld is turned into source text, so it may not use anything
// from this file's scope; its helpers arrive in `deps`.
// ═══════════════════════════════════════════════════════════

function installPageWorld(bridge, deps) {
  const { BoundedPcmRing, screenShareVideo, SERVER_LOCALE_KEY } = deps;
  const { normalizeVideoEncoderPreference, applyVideoEncoderPreference } = screenShareVideo;

  // Events from the app, forwarded by the preload: one handler per kind.
  const handlers = new Map();
  function on(kind, fn) { handlers.set(kind, fn); }
  bridge.subscribe((kind, payload) => {
    const fn = handlers.get(kind);
    if (!fn) return;
    try { fn(payload); }
    catch (err) { console.warn(`[Haven Desktop] ${kind} handler failed:`, err); }
  });

  function t(key, values) {
    return bridge.t(key, values);
  }

  // The latest native capture status, so the share can stop waiting for
  // audio as soon as the capture reports a failure.
  let _lastNativeStatus = null;

  // The server page keeps its language in localStorage, and the app follows
  // it. Writes the preload makes itself run in the preload's own world, where
  // Storage is not hooked, so they never echo back here.
  function readServerLocalePreference() {
    try { return window.localStorage.getItem(SERVER_LOCALE_KEY); }
    catch { return null; } // storage blocked: the page has no saved language
  }
  if (typeof Storage !== 'undefined') {
    const nativeStorageSetItem = Storage.prototype.setItem;
    const nativeStorageRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      const result = nativeStorageSetItem.call(this, key, value);
      if (this === window.localStorage && key === SERVER_LOCALE_KEY) bridge.serverLocaleChanged(String(value));
      return result;
    };
    Storage.prototype.removeItem = function (key) {
      const result = nativeStorageRemoveItem.call(this, key);
      if (this === window.localStorage && key === SERVER_LOCALE_KEY) bridge.serverLocaleChanged('auto');
      return result;
    };
  }

  let lastReportedServerLanguage = '';
  function reportServerLanguageState() {
    const serverI18n = window.i18n;
    if (!serverI18n) return;
    const preference = String(serverI18n.preference || readServerLocalePreference() || 'auto');
    const locale = String(serverI18n.locale || document.documentElement?.lang || '');
    if (!locale) return;
    const signature = `${preference}:${locale}`;
    if (signature === lastReportedServerLanguage) return;
    lastReportedServerLanguage = signature;
    bridge.reportServerLanguage(preference, locale);
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(reportServerLanguageState, 0);
    setTimeout(reportServerLanguageState, 500);
    setTimeout(reportServerLanguageState, 2000);
    if (document.documentElement && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(reportServerLanguageState);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
  });
  document.addEventListener('haven:localechange', reportServerLanguageState);
  // The preload asks again when this page comes on screen.
  on('i18n:report-language', reportServerLanguageState);

  // ═══════════════════════════════════════════════════════════
  // JavaScript Dialog Overrides for BrowserView (issue #6)
  //
  // Electron's BrowserView doesn't natively support prompt(),
  // confirm(), or alert(). The bridge forwards them to the main
  // process, which shows OS-native dialogs and blocks the page until
  // the user answers: confirm() and prompt() are modal by spec and
  // callers expect a return value.
  // ═══════════════════════════════════════════════════════════

  window.prompt = (message, defaultValue) => bridge.dialog('prompt', String(message || ''), String(defaultValue || ''));
  window.confirm = (message) => bridge.dialog('confirm', String(message || ''), '');
  window.alert = (message) => { bridge.dialog('alert', String(message || ''), ''); };

  const _displayVideoTracks = new WeakSet();
  const _screenShareTransceivers = new WeakMap();
  const _encoderStatsTimers = new WeakMap();
  const _encoderStatsGenerations = new WeakMap();
  let _activeDisplayVideoTrack = null;
  // Latch for the GPU-confirmed badge. Every viewer peer reports its own stats
  // on its own timer and they all write to the same badge (last-wins), so once
  // any negotiated report proves hardware encoding for the current screen track
  // the badge stays confirmed until the track ends, instead of flickering
  // between confirmed/software as competing peer reports land.
  let _gpuConfirmedTrack = null;
  let _videoEncoderConfig = {
    preference: 'hardware',
    hardwareAvailable: false,
    hardwareStatus: 'unavailable',
  };

  function videoEncoderLabel(preference) {
    return {
      auto: t('screenPicker.automaticEncoder'),
      hardware: t('screenPicker.hardwareH264'),
      h264: 'H.264',
      vp8: 'VP8',
      vp9: 'VP9',
      av1: 'AV1',
      h265: 'H.265 / HEVC',
    }[preference] || preference;
  }

  function publishVideoEncoderStatus(status) {
    const detail = { ...status, timestamp: Date.now() };
    window.__havenShareVideoEncoder = detail;
    window.dispatchEvent(new CustomEvent('haven:share-video-encoder', { detail }));

    if (!document.body) return;
    let badge = document.getElementById('haven-video-encoder-status');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'haven-video-encoder-status';
      badge.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
        'padding:7px 10px', 'border-radius:7px', 'background:rgba(17,20,31,.94)',
        'border:1px solid rgba(128,105,232,.55)', 'color:#ddd',
        'font:12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 6px 22px rgba(0,0,0,.35)', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(badge);
    }

    if (status.powerEfficientEncoder === true && status.track) {
      _gpuConfirmedTrack = status.track;
    }
    const gpuLatched = !!_gpuConfirmedTrack &&
      _gpuConfirmedTrack.readyState === 'live' &&
      _gpuConfirmedTrack === _activeDisplayVideoTrack;
    if (!gpuLatched && _gpuConfirmedTrack?.readyState !== 'live') _gpuConfirmedTrack = null;
    const codec = status.mimeType?.replace(/^video\//i, '').toUpperCase()
      || videoEncoderLabel(status.preference);
    let acceleration = t('screenEncoder.browserManaged');
    if (gpuLatched || status.powerEfficientEncoder === true) {
      acceleration = t('screenEncoder.gpuConfirmed');
    }
    else if (status.powerEfficientEncoder === false) acceleration = t('screenEncoder.software');
    else if (status.hardwareAvailable && codec.includes('H264')) {
      acceleration = t('screenEncoder.gpuPending');
    } else if (!status.hardwareAvailable && status.preference === 'hardware') {
      acceleration = t('screenEncoder.gpuUnavailable');
    }

    badge.textContent = t('screenEncoder.status', { codec, acceleration });
    badge.title = [
      status.encoderImplementation,
      status.sdpFmtpLine,
      status.reason,
    ].filter(Boolean).join(' • ');
  }

  function clearVideoEncoderStatus() {
    document.getElementById('haven-video-encoder-status')?.remove();
    window.__havenShareVideoEncoder = null;
    _gpuConfirmedTrack = null;
  }

  function configureScreenShareTransceiver(track, transceiver) {
    if (!transceiver || transceiver.stopped) return;

    // Only screen-share video transceivers are ever configured. Relay and
    // voice transceivers share this prototype hook, so anything that is not a
    // live display video track is left completely untouched.
    if (track?.kind && track.kind !== 'video') return;

    if (!_displayVideoTracks.has(track) || track.readyState !== 'live') {
      if (_screenShareTransceivers.has(transceiver)) {
        try { transceiver.setCodecPreferences([]); } catch {}
        _screenShareTransceivers.delete(transceiver);
      }
      return;
    }

    const codecs = window.RTCRtpSender?.getCapabilities?.('video')?.codecs;
    const preference = normalizeVideoEncoderPreference(_videoEncoderConfig.preference);
    const result = applyVideoEncoderPreference(
      transceiver,
      codecs,
      preference,
      _videoEncoderConfig.hardwareAvailable
    );

    if (result.applied) {
      _screenShareTransceivers.set(transceiver, { ...result, track });
      publishVideoEncoderStatus({
        phase: 'requested',
        ...result,
        hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
        hardwareStatus: _videoEncoderConfig.hardwareStatus,
      });
      console.log(`[Haven Desktop] screen encoder requested: ${preference}`);
    } else {
      if (_screenShareTransceivers.has(transceiver)) {
        try { transceiver.setCodecPreferences([]); } catch {}
        _screenShareTransceivers.delete(transceiver);
      }
      publishVideoEncoderStatus({
        phase: 'fallback',
        preference,
        reason: result.reason,
        hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
        hardwareStatus: _videoEncoderConfig.hardwareStatus,
      });
    }
  }

  async function reportNegotiatedScreenEncoder(peer) {
    let hasLiveScreenTrack = false;
    let reported = false;
    for (const transceiver of peer.getTransceivers()) {
      const encoderState = _screenShareTransceivers.get(transceiver);
      if (!encoderState) continue;
      const track = transceiver.sender.track;
      if (track?.readyState !== 'live' || track !== _activeDisplayVideoTrack) {
        if (_screenShareTransceivers.get(transceiver) === encoderState) {
          _screenShareTransceivers.delete(transceiver);
        }
        continue;
      }
      hasLiveScreenTrack = true;
      try {
        const stats = await transceiver.sender.getStats();
        if (_screenShareTransceivers.get(transceiver) !== encoderState) continue;
        if (track.readyState !== 'live' || transceiver.sender.track !== track) {
          _screenShareTransceivers.delete(transceiver);
          continue;
        }
        const entries = [...stats.values()];
        const outbound = entries.find(stat =>
          stat.type === 'outbound-rtp'
          && (stat.kind === 'video' || stat.mediaType === 'video')
        );
        const codec = entries.find(stat => stat.id === outbound?.codecId);
        if (!outbound || !codec) continue;
        publishVideoEncoderStatus({
          phase: 'negotiated',
          preference: encoderState.preference,
          track,
          mimeType: codec.mimeType,
          sdpFmtpLine: codec.sdpFmtpLine || '',
          encoderImplementation: outbound.encoderImplementation || null,
          powerEfficientEncoder: outbound.powerEfficientEncoder,
          hardwareAvailable: _videoEncoderConfig.hardwareAvailable,
          hardwareStatus: _videoEncoderConfig.hardwareStatus,
          frameWidth: outbound.frameWidth,
          frameHeight: outbound.frameHeight,
          framesPerSecond: outbound.framesPerSecond,
        });
        console.log(
          `[Haven Desktop] negotiated screen encoder: ${codec.mimeType}`,
          outbound.encoderImplementation || ''
        );
        reported = true;
      } catch (error) {
        console.warn('[Haven Desktop] screen encoder stats unavailable:', error.message);
      }
    }
    if (!hasLiveScreenTrack && _activeDisplayVideoTrack?.readyState !== 'live') {
      clearVideoEncoderStatus();
    }
    return { hasLiveScreenTrack, reported };
  }

  function scheduleScreenEncoderReport(peer, attempt = 0, generation = null) {
    if (generation === null) {
      generation = (_encoderStatsGenerations.get(peer) || 0) + 1;
      _encoderStatsGenerations.set(peer, generation);
    }
    if (_encoderStatsGenerations.get(peer) !== generation) return;
    const previousTimer = _encoderStatsTimers.get(peer);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(async () => {
      _encoderStatsTimers.delete(peer);
      const result = await reportNegotiatedScreenEncoder(peer);
      if (_encoderStatsGenerations.get(peer) !== generation) return;
      if (result.hasLiveScreenTrack && !result.reported && attempt < 15) {
        scheduleScreenEncoderReport(peer, attempt + 1, generation);
      }
    }, attempt === 0 ? 500 : 2000);
    _encoderStatsTimers.set(peer, timer);
  }

  function installScreenShareEncodingOverride() {
    if (!window.RTCPeerConnection || !window.RTCRtpSender) return false;

    const peerPrototype = window.RTCPeerConnection.prototype;
    const originalAddTrack = peerPrototype.addTrack;
    const originalAddTransceiver = peerPrototype.addTransceiver;
    const originalCreateOffer = peerPrototype.createOffer;
    const originalCreateAnswer = peerPrototype.createAnswer;
    const originalSetRemoteDescription = peerPrototype.setRemoteDescription;
    const trackPrototype = window.MediaStreamTrack?.prototype;
    const originalTrackStop = trackPrototype?.stop;

    function configureTransceivers(peer) {
      // Scope the hook to transceivers carrying the live screen track. The
      // override patches every RTCPeerConnection in the page, including the
      // relay's, so iterating blindly would reset or re-preference
      // transceivers that have nothing to do with screen sharing.
      for (const transceiver of peer.getTransceivers()) {
        const track = transceiver?.sender?.track;
        if (!track || track.readyState !== 'live' || !_displayVideoTracks.has(track)) continue;
        configureScreenShareTransceiver(track, transceiver);
      }
    }

    peerPrototype.addTrack = function (track, ...streams) {
      const sender = originalAddTrack.call(this, track, ...streams);
      const transceiver = this.getTransceivers().find(item => item.sender === sender);
      configureScreenShareTransceiver(track, transceiver);
      return sender;
    };

    peerPrototype.addTransceiver = function (trackOrKind, init) {
      const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
      if (typeof trackOrKind !== 'string') {
        configureScreenShareTransceiver(trackOrKind, transceiver);
      }
      return transceiver;
    };

    peerPrototype.createOffer = function (...args) {
      configureTransceivers(this);
      return originalCreateOffer.apply(this, args);
    };

    peerPrototype.createAnswer = function (...args) {
      configureTransceivers(this);
      return originalCreateAnswer.apply(this, args);
    };

    peerPrototype.setRemoteDescription = function (...args) {
      const operation = originalSetRemoteDescription.apply(this, args);
      if (!operation?.then) return operation;
      return operation.then(result => {
        scheduleScreenEncoderReport(this);
        return result;
      });
    };

    if (trackPrototype && originalTrackStop) {
      trackPrototype.stop = function (...args) {
        const isDisplayTrack = _displayVideoTracks.has(this);
        const result = originalTrackStop.apply(this, args);
        if (isDisplayTrack && _activeDisplayVideoTrack === this) {
          _displayVideoTracks.delete(this);
          _activeDisplayVideoTrack = null;
          clearVideoEncoderStatus();
        }
        return result;
      };
    }

    return true;
  }

  if (!installScreenShareEncodingOverride()) {
    window.addEventListener('DOMContentLoaded', installScreenShareEncodingOverride, { once: true });
  }

  // ═══════════════════════════════════════════════════════════
  // HTML5 Fullscreen API Override
  //
  // BrowserView does not support the HTML5 Fullscreen API.
  // requestFullscreen() silently resolves but the element never
  // actually enters DOM fullscreen state; :fullscreen CSS never
  // applies and the visual doesn't change.  We implement fullscreen
  // entirely manually: a CSS class for visual fullscreen + IPC to
  // toggle the Electron window's native fullscreen.
  // ═══════════════════════════════════════════════════════════

  (function patchFullscreen() {
    let _fullscreenEl = null;

    // Inject the CSS that makes our manual fullscreen work.
    // Deferred to DOMContentLoaded because the preload runs before <head> exists.
    function injectStyle() {
      const style = document.createElement('style');
      style.textContent = `
        .haven-manual-fullscreen {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: unset !important;
          max-height: unset !important;
          z-index: 2147483647 !important;
          background: #000 !important;
          object-fit: contain !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          border-radius: 0 !important;
        }
      `;
      document.head.appendChild(style);
    }
    if (document.head) injectStyle();
    else window.addEventListener('DOMContentLoaded', injectStyle, { once: true });

    function enterFullscreen(el) {
      if (_fullscreenEl) exitFullscreen();
      _fullscreenEl = el;
      el.classList.add('haven-manual-fullscreen');
      bridge.fullscreen(true);
      document.dispatchEvent(new Event('fullscreenchange'));
    }

    function exitFullscreen() {
      if (_fullscreenEl) {
        _fullscreenEl.classList.remove('haven-manual-fullscreen');
        _fullscreenEl = null;
      }
      bridge.fullscreen(false);
      document.dispatchEvent(new Event('fullscreenchange'));
    }

    // Override requestFullscreen
    Element.prototype.requestFullscreen = function () {
      enterFullscreen(this);
      return Promise.resolve();
    };
    if (Element.prototype.webkitRequestFullscreen) {
      Element.prototype.webkitRequestFullscreen = function () {
        enterFullscreen(this);
      };
    }

    // Override exitFullscreen
    Document.prototype.exitFullscreen = function () {
      exitFullscreen();
      return Promise.resolve();
    };

    // Override document.fullscreenElement getter
    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      get() { return _fullscreenEl; },
      configurable: true,
    });
    Object.defineProperty(Document.prototype, 'webkitFullscreenElement', {
      get() { return _fullscreenEl; },
      configurable: true,
    });
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', {
      get() { return true; },
      configurable: true,
    });

    // Escape key exits fullscreen
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _fullscreenEl) {
        e.preventDefault();
        exitFullscreen();
      }
    }, true);
  })();

  // ─── Internal state ──────────────────────────────────────
  let _audioWorkletNode    = null;
  let _audioCtx            = null;
  let _audioDestination    = null;
  let _capturedAudioPid    = null;
  let _activeAudioCaptureId = null;
  let _activeShareId       = null;
  let _pendingShareId      = null;
  let _displayMediaPending = false;
  let _audioBufferQueue    = [];
  let _audioBufferedSamples = 0;
  let _audioPacketsReceived = 0;
  let _audioPreparationQueue = Promise.resolve();
  const _cancelledAudioPreparations = new Set();
  // ─── Global voice shortcut triggers ──────────────────────
  on('voice:mute-toggle',   () => document.getElementById('voice-mute-btn')?.click());
  on('voice:deafen-toggle', () => document.getElementById('voice-deafen-btn')?.click());
  on('voice:ptt-toggle',    () => _pttToggleOnce('hook'));

  // PTT hold mode (#184): main fires -down on key/mouse press and -up on
  // release. We unmute on press and re-mute on release iff that state
  // transition is needed: the mute button is a toggle, so we only click
  // it when its current visual state doesn't match the desired one.
  // The mic state is read from the app itself when it is there (window.app,
  // the object Haven's client exposes), and only from the mute button's class
  // when it is not. Each press and release is logged with the state it saw and
  // what it did, so a report from someone whose hold mode misbehaves can show
  // exactly where it stops: View, Toggle Developer Tools, then Console
  // (Haven #5603, #38).
  function _pttState() {
    const app = window.app || window._havenApp || null;
    const voice = app && app.voice;
    if (voice && typeof voice.isMuted === 'boolean') {
      return { app, isMuted: voice.isMuted, inVoice: !!voice.inVoice, source: 'app' };
    }
    // Haven hides both mute buttons (inline display:none) while you are not in
    // voice, so a shown one means you are in a call.
    const buttons = [document.getElementById('voice-mute-btn'), document.getElementById('voice-mute-btn-header')].filter(Boolean);
    if (!buttons.length) return null;
    const shown = buttons.find(b => b.style?.display !== 'none');
    const btn = shown || buttons[0];
    const pressed = btn.getAttribute('aria-pressed');
    const isMuted = (pressed === 'true' || pressed === 'false')
      ? pressed === 'true'
      : (btn.classList.contains('muted') || btn.classList.contains('is-muted'));
    return { app, isMuted, inVoice: !!shown, source: 'button', btn };
  }
  // Push to talk only acts in a voice call. Outside one the key used to flip
  // the saved mute state and play the mute sound, which made it look as if
  // you were in voice when you were not (Haven-Desktop #64).
  function _pttOutOfVoice(s, what) {
    if (s.inVoice !== false) return false;
    console.log(`[PTT] ${what}: not in voice, ignored`);
    return true;
  }
  function _pttSetTalking(shouldTalk, via = 'key') {
    const s = _pttState();
    const edge = shouldTalk ? 'down' : 'up';
    if (!s) { console.log(`[PTT] ${via} ${edge}: no voice state on the page yet, ignored`); return; }
    if (_pttOutOfVoice(s, `${via} ${edge}`)) return;
    // shouldTalk → want unmuted. Flip only when the state has to change, so
    // the input hook and the page's own key handler never fight.
    const needFlip = shouldTalk ? s.isMuted : !s.isMuted;
    console.log(`[PTT] ${via} ${edge}: muted=${s.isMuted} inVoice=${s.inVoice} via ${s.source}, ${needFlip ? 'toggling' : 'no change'}`);
    if (!needFlip) return;
    if (s.app && typeof s.app._toggleMute === 'function') {
      try { s.app._toggleMute(); return; } catch (err) { console.warn('[PTT] _toggleMute threw:', err); }
    }
    const btn = s.btn || document.getElementById('voice-mute-btn');
    if (btn) btn.click();
  }
  // Toggle mode: one press flips the mic. The global hook and the page's own
  // key handler can both see the same press (or the hook sees none at all,
  // as on Wayland), so a press within a quarter second of the last one is the
  // same press and is ignored (Haven #5724).
  let _pttLastToggle = 0;
  function _pttToggleOnce(via) {
    const now = Date.now();
    if (now - _pttLastToggle < 250) { console.log(`[PTT] ${via} toggle: same press as the last one, ignored`); return; }
    _pttLastToggle = now;
    const s = _pttState();
    if (!s) { console.log(`[PTT] ${via} toggle: no voice state on the page yet, ignored`); return; }
    if (_pttOutOfVoice(s, `${via} toggle`)) return;
    console.log(`[PTT] ${via} toggle: muted=${s.isMuted} inVoice=${s.inVoice} via ${s.source}`);
    if (s.app && typeof s.app._toggleMute === 'function') {
      try { s.app._toggleMute(); return; } catch (err) { console.warn('[PTT] _toggleMute threw:', err); }
    }
    const btn = s.btn || document.getElementById('voice-mute-btn');
    if (btn) btn.click();
  }
  on('voice:ptt-down', () => _pttSetTalking(true, 'hook'));
  on('voice:ptt-up',   () => _pttSetTalking(false, 'hook'));

  // ─── Hold-mode PTT while the Haven window itself is focused ──────────
  // The native input hook in main drives PTT, but on Windows several people
  // see hold mode go quiet while the Haven window is the focused one and work
  // again the moment it is minimised or behind a game (Haven #5603, #38). When
  // the page is focused it gets the key events itself, so the same binding is
  // followed here as well. _pttSetTalking only clicks when the state has to
  // flip, so whichever path fires second is a no-op, and the two never fight.
  // Toggle mode is followed here too, through _pttToggleOnce, which drops the
  // second sighting of one press. On Wayland the global hook gets nothing while
  // Haven is focused, so without this the toggle key never worked there.
  const _PTT_DOM_KEYS = {
    Space: ' ', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
    Return: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  const _PTT_LONE_MODS = {
    CommandOrControl: ['control', 'meta'], Control: ['control'], Ctrl: ['control'],
    Meta: ['meta'], Cmd: ['meta'], Super: ['meta'], Alt: ['alt'], Shift: ['shift'],
  };
  let _pttDomBinding = null;
  let _pttDomToggle = false;
  let _pttDomDown = false;
  function _parsePttAccel(accel) {
    const mouse = /^Mouse(\d+)$/i.exec(accel || '');
    if (mouse) return { mouseButton: parseInt(mouse[1], 10) - 1 };
    const parts = String(accel || '').split('+').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const key = parts.pop();
    const mods = { ctrl: false, alt: false, shift: false };
    for (const p of parts) {
      if (['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Meta', 'Cmd', 'Command', 'Super'].includes(p)) mods.ctrl = true;
      else if (p === 'Alt' || p === 'Option') mods.alt = true;
      else if (p === 'Shift') mods.shift = true;
      else return null;
    }
    const lone = _PTT_LONE_MODS[key];
    const keys = lone || [String(_PTT_DOM_KEYS[key] || key).toLowerCase()];
    return { mods, keys, lone: !!lone };
  }
  function _pttDomKeyMatches(e, b, isDown) {
    if (!b || b.mouseButton != null) return false;
    if (!b.keys.includes(String(e.key || '').toLowerCase())) return false;
    // The modifiers only have to be down on the press; by the release they
    // may already be up, and the release still has to count.
    if (!isDown || b.lone) return true;
    return (!b.mods.ctrl || e.ctrlKey || e.metaKey) && (!b.mods.alt || e.altKey) && (!b.mods.shift || e.shiftKey);
  }
  function _refreshPttDomBinding() {
    return Promise.resolve(bridge.shortcutsGet()).then((cfg) => {
      _pttDomToggle = !!cfg && cfg.pttMode === 'toggle';
      _pttDomBinding = (cfg && cfg.ptt) ? _parsePttAccel(cfg.ptt) : null;
      if (!_pttDomBinding && _pttDomDown) { _pttDomDown = false; _pttSetTalking(false); }
    }).catch(() => { _pttDomBinding = null; });
  }
  window.addEventListener('keydown', (e) => {
    if (_pttDomToggle) {
      if (!e.repeat && _pttDomKeyMatches(e, _pttDomBinding, true)) _pttToggleOnce('page');
      return;
    }
    if (e.repeat || _pttDomDown || !_pttDomKeyMatches(e, _pttDomBinding, true)) return;
    _pttDomDown = true;
    _pttSetTalking(true);
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!_pttDomDown || !_pttDomKeyMatches(e, _pttDomBinding, false)) return;
    _pttDomDown = false;
    _pttSetTalking(false);
  }, true);
  window.addEventListener('mousedown', (e) => {
    const b = _pttDomBinding;
    if (!b || b.mouseButton == null || e.button !== b.mouseButton) return;
    if (_pttDomToggle) { _pttToggleOnce('page'); return; }
    if (_pttDomDown) return;
    _pttDomDown = true;
    _pttSetTalking(true);
  }, true);
  window.addEventListener('mouseup', (e) => {
    const b = _pttDomBinding;
    if (!b || b.mouseButton == null || e.button !== b.mouseButton || !_pttDomDown) return;
    _pttDomDown = false;
    _pttSetTalking(false);
  }, true);
  window.addEventListener('DOMContentLoaded', () => { _refreshPttDomBinding(); });
  // The binding changed in Settings (havenDesktop.shortcuts.setConfig).
  on('shortcuts:changed', () => { _refreshPttDomBinding(); });

  // ─── Receive PCM chunks from native addon (main process) ─
  let _ipcDataCount = 0;
  // Track latest native capture status reported by the addon. Lets the
  // getDisplayMedia override abort its readiness wait early on hard failure
  // instead of always burning the full timeout.
  on('audio:capture-status', (status) => {
    if (!status?.captureId || status.captureId !== _activeAudioCaptureId) return;
    _lastNativeStatus = status; // already in the user's language (app-preload.js)
    const codeHex = '0x' + ((status?.code || 0) >>> 0).toString(16);
    console.log(`[Haven Desktop] native capture status: kind=${status?.kind} code=${codeHex} msg=${status?.message}`);
  });

  // Resolved share-audio mode reported by main once the picker handler decides
  // what audio path to use (application / system / none).
  // Forwarded to the page so the webapp can show a small mode indicator.
  // The preload sends the mode as main reported it and in the user's language,
  // again whenever the language changes.
  on('audio:share-mode', ({ raw, localized } = {}) => {
    if (raw?.captureId && raw.captureId !== _activeShareId) return;
    console.log('[Haven Desktop] share audio mode:', raw);
    window.__havenShareAudioMode = localized;
    window.dispatchEvent(new CustomEvent('haven:share-audio-mode', { detail: localized }));
  });
  on('audio:capture-data', (payload) => {
    if (!payload?.captureId || payload.captureId !== _activeAudioCaptureId) return;
    // Stale packets were already dropped in the preload (shouldDropAudioPacket).
    const pcmData = payload.data;
    // Build a Float32Array from whatever Electron's IPC delivers.
    // The main process now sends a plain ArrayBuffer (guaranteed offset-0),
    // but we still handle typed-array arrivals defensively.
    let samples;
    try {
      if (pcmData instanceof Float32Array) {
        samples = pcmData;
      } else if (pcmData instanceof ArrayBuffer) {
        samples = new Float32Array(pcmData);
      } else if (ArrayBuffer.isView(pcmData)) {
        // Buffer/Uint8Array: copy to a fresh aligned ArrayBuffer to avoid
        // RangeError when byteOffset is not 4-byte-aligned.
        const bytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
        const aligned = new ArrayBuffer(bytes.length);
        new Uint8Array(aligned).set(bytes);
        samples = new Float32Array(aligned);
      } else {
        console.warn('[Haven Desktop] audio:capture-data unknown format:', typeof pcmData);
        return;
      }
    } catch (e) {
      console.warn('[Haven Desktop] audio:capture-data conversion failed:', e.message);
      return;
    }

    // Periodic diagnostic: confirm data is arriving
    _ipcDataCount++;
    if (_ipcDataCount === 1 || _ipcDataCount % 500 === 0) {
      console.log(`[Haven Desktop] audio:capture-data chunk #${_ipcDataCount}, ${samples.length} samples, peak=${Math.max(...Array.from(samples.slice(0, 128)).map(Math.abs)).toFixed(4)}`);
    }

    if (_audioWorkletNode) {
      _audioWorkletNode.port.postMessage({ type: 'audio-data', samples }, [samples.buffer]);
    } else if (window._havenAppAudioPush) {
      window._havenAppAudioPush(samples);
    } else {
      const buffered = samples.length > 4800 ? samples.subarray(samples.length - 4800) : samples;
      _audioBufferQueue.push(buffered);
      _audioBufferedSamples += buffered.length;
      while (_audioBufferedSamples > 4800 && _audioBufferQueue.length > 1) {
        _audioBufferedSamples -= _audioBufferQueue.shift().length;
      }
    }
    _audioPacketsReceived++;
  });

  // The trusted picker runs in its own local BrowserWindow. Only after that
  // window records consent does main ask this preload to prepare the audio track.
  on('screen:prepare-share-cancel', (data = {}) => {
    const requestId = typeof data.requestId === 'string' ? data.requestId : null;
    if (!requestId) return;
    _cancelledAudioPreparations.add(requestId);
    if (_activeAudioCaptureId === requestId) teardownAudioPipeline(requestId);
  });

  on('screen:prepare-share', (data = {}) => {
    const requestId = typeof data.requestId === 'string' ? data.requestId : null;
    if (!requestId) return;
    _cancelledAudioPreparations.delete(requestId);

    const prepare = async () => {
      if (_cancelledAudioPreparations.delete(requestId)) return;

      teardownAudioPipeline(_activeAudioCaptureId);
      _activeShareId = requestId;
      _pendingShareId = requestId;
      _lastNativeStatus = null;

      const audioAppPid = data.audioAppPid;
      const wantsNativePipeline =
        (Number.isSafeInteger(audioAppPid) && audioAppPid > 0) || audioAppPid === 'system';
      let audioReady = true;
      if (wantsNativePipeline) {
        _activeAudioCaptureId = requestId;
        _capturedAudioPid = audioAppPid;
        try {
          audioReady = await buildAudioPipeline(() =>
            _cancelledAudioPreparations.has(requestId) || _activeAudioCaptureId !== requestId
          );
        } catch (err) {
          console.warn('[Haven Desktop] Local audio pipeline failed to build:', err.message);
          audioReady = false;
        }
      }

      if (_cancelledAudioPreparations.delete(requestId)) {
        teardownAudioPipeline(requestId);
        return;
      }
      if (!audioReady) teardownAudioPipeline(requestId);
      bridge.prepareShareResult(requestId, audioReady);
    };

    _audioPreparationQueue = _audioPreparationQueue.then(prepare, prepare);
  });

  // ═══════════════════════════════════════════════════════════
  // Screen-Share Picker  (injected as a full-screen overlay)
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // Audio-Capture Pipeline
  //
  // Receives PCM from the native addon via IPC, pipes it through
  // an AudioWorklet, and exposes a MediaStreamTrack that replaces
  // the system-loopback track on the screen-share MediaStream.
  // ═══════════════════════════════════════════════════════════

  async function buildAudioPipeline(isCancelled = () => false) {
    if (isCancelled()) return false;
    // Reset arrival counters so the getDisplayMedia override's readiness
    // check reflects ONLY this capture session, never a stale prior one.
    _audioPacketsReceived = 0;
    _ipcDataCount = 0;
    _audioBufferQueue = [];
    _audioBufferedSamples = 0;

    // Try AudioWorklet first, fall back to ScriptProcessorNode if it fails
    // (AudioWorklet blob URLs can fail in some Electron/BrowserView contexts)
    try {
      _audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      // Explicitly resume: BrowserView contexts may start suspended
      if (_audioCtx.state === 'suspended') await _audioCtx.resume();
      if (isCancelled()) return false;

      // Inline AudioWorklet processor (blob URL avoids CSP / file issues)
      const workletSrc = `
        ${BoundedPcmRing.toString()}
        class AppAudioProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this._ring = new BoundedPcmRing(4800); // Never retain more than 100 ms.

            this.port.onmessage = (e) => {
              if (e.data.type !== 'audio-data') return;
              this._ring.push(e.data.samples);
            };
          }

          process(_inputs, outputs) {
            const out = outputs[0];
            if (!out || !out.length) return true;
            const buf = out[0];
            const len = buf.length;

            this._ring.pull(buf);

            for (let ch = 1; ch < out.length; ch++) out[ch].set(buf);
            return true;
          }
        }
        registerProcessor('app-audio-processor', AppAudioProcessor);
      `;

      const blob = new Blob([workletSrc], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await _audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (isCancelled()) return false;

      _audioWorkletNode = new AudioWorkletNode(_audioCtx, 'app-audio-processor', {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });

      _audioDestination = _audioCtx.createMediaStreamDestination();
      _audioWorkletNode.connect(_audioDestination);
      // Also connect to AudioContext.destination (silenced) so Chromium's
      // audio thread actually drives the AudioWorklet process() callback.
      // Without this, MediaStreamDestination alone may not pump the graph.
      const silencer = _audioCtx.createGain();
      silencer.gain.value = 0;
      _audioWorkletNode.connect(silencer);
      silencer.connect(_audioCtx.destination);

      // Flush any PCM that arrived before the pipeline was ready
      _audioBufferQueue.forEach(buf =>
        _audioWorkletNode.port.postMessage({ type: 'audio-data', samples: buf }, [buf.buffer])
      );
      _audioBufferQueue = [];
      _audioBufferedSamples = 0;

      // Expose track globally so our getDisplayMedia override can grab it
      window._havenAppAudioTrack  = _audioDestination.stream.getAudioTracks()[0];
      window._havenAppAudioStream = _audioDestination.stream;

      // Monitor AudioContext: BrowserView can re-suspend unexpectedly
      window._havenAudioCtxMonitor = setInterval(() => {
        if (_audioCtx && _audioCtx.state === 'suspended') {
          console.warn('[Haven Desktop] AudioContext suspended, resuming');
          _audioCtx.resume().catch(() => {});
        }
      }, 2000);

      console.log('[Haven Desktop] Per-app audio pipeline active (AudioWorklet), ctx state:', _audioCtx.state);
      return true;
    } catch (err) {
      console.warn('[Haven Desktop] AudioWorklet pipeline failed, trying ScriptProcessor fallback:', err.message);
      // Clean up partial AudioWorklet state before fallback
      _audioWorkletNode = null;
      if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
      _audioDestination = null;
      if (isCancelled()) return false;
    }

    // ── Fallback: ScriptProcessorNode (works in all Electron versions) ──
    try {
      _audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (_audioCtx.state === 'suspended') await _audioCtx.resume();
      if (isCancelled()) return false;

      const bufSize = 1024;
      // Use 1 input channel (not 0).  A "generator" ScriptProcessor with
      // 0 inputs may not have its onaudioprocess callback pumped reliably
      // in Electron / BrowserView environments.  Connecting a live source
      // to the input guarantees Chromium's audio thread drives the node.
      const scriptNode = _audioCtx.createScriptProcessor(bufSize, 1, 2);
      const ring = new BoundedPcmRing(4800);
      let   _spProcessCount = 0;

      // Store a push function that the IPC handler can call
      window._havenAppAudioPush = (samples) => {
        ring.push(samples);
      };

      scriptNode.onaudioprocess = (e) => {
        _spProcessCount++;
        const out = e.outputBuffer.getChannelData(0);
        ring.pull(out);
        // Copy mono to stereo
        const out1 = e.outputBuffer.getChannelData(1);
        out1.set(out);
        // Periodic diagnostic
        if (_spProcessCount === 1 || _spProcessCount % 200 === 0) {
          const peak = Math.max(...Array.from(out.slice(0, 128)).map(Math.abs));
          console.log(`[Haven Desktop] ScriptProcessor process #${_spProcessCount}, avail=${ring.available}, peak=${peak.toFixed(4)}`);
        }
      };

      _audioDestination = _audioCtx.createMediaStreamDestination();
      scriptNode.connect(_audioDestination);

      // Drive the ScriptProcessor with a silent ConstantSourceNode so
      // Chromium's audio thread always pulls from it.
      const driver = _audioCtx.createConstantSource();
      driver.offset.value = 0;
      driver.connect(scriptNode);
      driver.start();
      // Also connect to context destination (silenced) as a second sink
      // to ensure the graph stays active.
      const silencer = _audioCtx.createGain();
      silencer.gain.value = 0;
      scriptNode.connect(silencer);
      silencer.connect(_audioCtx.destination);

      // Flush buffered PCM
      _audioBufferQueue.forEach(buf => window._havenAppAudioPush(buf));
      _audioBufferQueue = [];
      _audioBufferedSamples = 0;

      window._havenAppAudioTrack  = _audioDestination.stream.getAudioTracks()[0];
      window._havenAppAudioStream = _audioDestination.stream;

      // Monitor AudioContext: BrowserView can re-suspend unexpectedly
      window._havenAudioCtxMonitor = setInterval(() => {
        if (_audioCtx && _audioCtx.state === 'suspended') {
          console.warn('[Haven Desktop] AudioContext suspended, resuming');
          _audioCtx.resume().catch(() => {});
        }
      }, 2000);

      console.log('[Haven Desktop] Per-app audio pipeline active (ScriptProcessor fallback), ctx state:', _audioCtx.state);
      return true;
    } catch (err) {
      console.error('[Haven Desktop] Audio pipeline setup failed completely:', err);
      // Clean up on total failure
      if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
      _audioDestination = null;
      window._havenAppAudioPush = null;
      return false;
    }
  }

  function teardownAudioPipeline(captureId = _activeAudioCaptureId) {
    if (captureId && captureId !== _activeAudioCaptureId) return;
    // Stop native capture first so IPC messages stop arriving
    if (captureId) {
      Promise.resolve(bridge.stopCapture(captureId))
        .catch(err => console.warn('[Haven Desktop] could not stop the native capture:', err?.message || err));
    }
    if (window._havenAudioCtxMonitor) {
      clearInterval(window._havenAudioCtxMonitor);
      window._havenAudioCtxMonitor = null;
    }
    _audioWorkletNode?.disconnect();
    _audioWorkletNode = null;
    _audioCtx?.close().catch(() => {});
    _audioCtx         = null;
    _audioDestination = null;
    _capturedAudioPid = null;
    _activeAudioCaptureId = null;
    _audioBufferQueue = [];
    _audioBufferedSamples = 0;
    _audioPacketsReceived = 0;
    _ipcDataCount     = 0;
    window._havenAppAudioTrack  = null;
    window._havenAppAudioStream = null;
    window._havenAppAudioPush   = null;
    console.log('[Haven Desktop] Audio pipeline torn down');
  }
  // havenDesktop.audio.stopCapture() in the preload asks for this.
  on('audio:teardown', () => teardownAudioPipeline());

  // ═══════════════════════════════════════════════════════════
  // Override getDisplayMedia()
  //
  // After Electron's handler resolves with a video stream, we
  // swap the system-loopback audio track for our per-app track.
  // Haven's voice.js calls the same standard API: zero changes
  // needed on the server/browser code.
  //
  // NOTE: navigator.mediaDevices is not available at preload
  // time; it only exists once the renderer page has loaded.
  // We defer the override until DOMContentLoaded.
  // ═══════════════════════════════════════════════════════════

  function installGetDisplayMediaOverride() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      // Not ready yet (rare, but possible); retry briefly
      setTimeout(installGetDisplayMediaOverride, 100);
      return;
    }

    const _origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      if (_displayMediaPending) {
        throw new DOMException('A screen-share request is already open.', 'InvalidStateError');
      }
      _displayMediaPending = true;

      // Reset native status before each share so a stale "failed" from a
      // prior session doesn't poison the next attempt.
      _lastNativeStatus = null;

      let stream;
      try {
        stream = await _origGDM(constraints);
      } catch (error) {
        const failedShareId = _pendingShareId;
        _pendingShareId = null;
        if (failedShareId && _activeShareId === failedShareId) {
          teardownAudioPipeline(failedShareId);
          _activeShareId = null;
        }
        _displayMediaPending = false;
        throw error;
      }
      try {
        const shareId = _pendingShareId || _activeShareId;
        _pendingShareId = null;
        const captureId = shareId === _activeAudioCaptureId ? shareId : null;
        const capturedAudioPid = captureId ? _capturedAudioPid : null;
        const audioTracksFromElectron = stream.getAudioTracks().length;
        console.log(`[Haven Desktop] getDisplayMedia resolved (capturedAudioPid=${capturedAudioPid}, electron-audio-tracks=${audioTracksFromElectron}, per-app track ready=${!!window._havenAppAudioTrack})`);

        // Native capture is strict: wait for PCM and add only that track. An
        // application-capture failure stays silent instead of exposing all audio.
        if (capturedAudioPid) {
          const timeoutMs = 8000;
          const stepMs    = 20;
          const start     = Date.now();
          let lastLog     = 0;
          while ((Date.now() - start) < timeoutMs) {
            if (_activeAudioCaptureId !== captureId) break;
            if (_audioPacketsReceived > 0) break;
            if (_lastNativeStatus && _lastNativeStatus.kind === 'failed') {
              console.warn('[Haven Desktop] native capture reported FAILED during readiness wait');
              break;
            }
            if (Date.now() - lastLog > 1000) {
              lastLog = Date.now();
              console.log(`[Haven Desktop] waiting for first PCM packet... elapsed=${Date.now() - start}ms received=${_audioPacketsReceived} status=${_lastNativeStatus?.kind || 'none'}`);
            }
            await new Promise(resolve => setTimeout(resolve, stepMs));
          }

          if (_activeAudioCaptureId === captureId &&
              _audioPacketsReceived > 0 && window._havenAppAudioTrack) {
            // Remove any unexpected Electron track before attaching native audio.
            stream.getAudioTracks().forEach(t => { try { stream.removeTrack(t); t.stop(); } catch {} });
            stream.addTrack(window._havenAppAudioTrack);
            console.log(`[Haven Desktop] native audio track added (waited ${Date.now() - start}ms, ${_audioPacketsReceived} PCM chunks received)`);
          } else {
            console.warn('[Haven Desktop] readiness wait expired without PCM. Diagnostics:');
            console.warn('  capturedAudioPid:', capturedAudioPid);
            console.warn('  packetsReceived:', _audioPacketsReceived);
            console.warn('  ipcDataCount:', _ipcDataCount);
            console.warn('  havenAppAudioTrack present:', !!window._havenAppAudioTrack);
            console.warn('  audioCtx state:', _audioCtx?.state);
            console.warn('  audioWorkletNode present:', !!_audioWorkletNode);
            console.warn('  havenAppAudioPush present:', !!window._havenAppAudioPush);
            console.warn('  lastNativeStatus:', _lastNativeStatus);
            console.warn('  Continuing without audio to prevent a Haven voice loop.');
            stream.getAudioTracks().forEach(t => { try { stream.removeTrack(t); t.stop(); } catch {} });
            teardownAudioPipeline(captureId);
          }
        } else if (window._havenAppAudioTrack && !_activeAudioCaptureId) {
          // A track without an active selection is stale and must never leak into
          // a later "no audio" or "all system audio" share.
          teardownAudioPipeline();
        } else {
          console.log(`[Haven Desktop] no native capture requested; using Electron-provided audio (${audioTracksFromElectron} track(s))`);
        }

        const encoderConfig = await Promise.resolve(bridge.getEncoderConfig())
          .catch(() => _videoEncoderConfig);
        _videoEncoderConfig = {
          ...encoderConfig,
          preference: normalizeVideoEncoderPreference(encoderConfig.preference),
          hardwareAvailable: encoderConfig.hardwareAvailable === true,
        };
        stream.getVideoTracks().forEach((track, index) => {
          _displayVideoTracks.add(track);
          if (index === 0) _activeDisplayVideoTrack = track;
        });

        // An older video track must not tear down a newer share.
        stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
          if (_activeShareId !== shareId || _activeDisplayVideoTrack !== track) return;
          teardownAudioPipeline(captureId);
          clearVideoEncoderStatus();
          _activeDisplayVideoTrack = null;
          _activeShareId = null;
        }));

        return stream;
      } finally {
        _displayMediaPending = false;
      }
    };

    console.log('[Haven Desktop] getDisplayMedia override installed');
  }

  document.addEventListener('DOMContentLoaded', installGetDisplayMediaOverride);

  // ═══════════════════════════════════════════════════════════
  //  Desktop Notifications  (override browser Notification API)
  // ═══════════════════════════════════════════════════════════

  class HavenNotification {
    constructor(title, opts = {}) {
      bridge.notify({ title, body: opts.body || '', silent: opts.silent || false, channelCode: opts.channelCode });
      this._onclick = null;
    }
    set onclick(fn) { this._onclick = fn; }
    get onclick()   { return this._onclick; }
    close() {}
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
  }
  window.Notification = HavenNotification;

  // When user clicks a native notification, navigate to the channel
  on('notification-clicked', (channelCode) => {
    if (channelCode && window.app?.switchChannel) {
      window.app.switchChannel(channelCode);
    }
  });

  // Issue #5306: in-app navigation for cross-channel message links
  // (target="_blank" on /app.html?channel=…&message=… would otherwise
  // spawn a fresh BrowserWindow / second client instance on Linux).
  on('app:navigate-deep-link', ({ code, messageId, url } = {}) => {
    try {
      if (code && window.app?.switchChannel) {
        window.app.switchChannel(code);
        if (messageId && window.app?._jumpToMessage) {
          const id = parseInt(messageId, 10);
          if (id) setTimeout(() => { try { window.app._jumpToMessage(id); } catch {} }, 600);
        }
        return;
      }
    } catch {}
    // Fallback: full reload to the deep link if the SPA handlers aren't
    // available (e.g. login page).  The page's auth.js preserves the
    // ?channel/?message query across the auth bounce.
    if (url) { try { location.href = url; } catch {} }
  });
}

/**
 * The page world as one script: installPageWorld and the helpers it needs,
 * run against the bridge the preload exposes. The page's Content Security
 * Policy forbids building code from strings in either world, so the preload
 * runs this text as a script of its own (webFrame.executeJavaScript).
 */
function pageWorldSource() {
  const fs = require('fs');
  const path = require('path');
  const { BoundedPcmRing } = require('./screen-share-audio');
  const { SERVER_LOCALE_KEY } = require('../i18n/server-bridge');
  const videoSource = fs.readFileSync(path.join(__dirname, 'screen-share-video.js'), 'utf8');
  return [
    '(function () {',
    `const BoundedPcmRing = ${BoundedPcmRing.toString()};`,
    'const screenShareVideo = (function () {',
    'const module = { exports: {} };',
    videoSource,
    'return module.exports;',
    '})();',
    `(${installPageWorld.toString()})(window.__havenDesktopPage, {`,
    '  BoundedPcmRing,',
    '  screenShareVideo,',
    `  SERVER_LOCALE_KEY: ${JSON.stringify(SERVER_LOCALE_KEY)},`,
    '});',
    '})();',
  ].join('\n');
}

module.exports = { installPageWorld, pageWorldSource };

