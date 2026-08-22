// ═══════════════════════════════════════════════════════════
// Haven Desktop — Audio Capture Manager
//
// Provides per-application audio capture via native addons:
//   • Windows  →  WASAPI Process Loopback (Win 10 2004+)
//   • Linux    →  PulseAudio sink-input isolation
//
// The native addon (native/build/Release/haven_audio.node) is
// compiled from C++ during `npm run build:native`.  If it is
// missing, all methods degrade gracefully (no crash, no audio).
// ═══════════════════════════════════════════════════════════

const path = require('path');

class AudioCaptureManager {
  constructor(opts = {}) {
    this._t        = opts.t || (key => key);
    this._addon    = null;
    this._capturing = false;
    this._callback  = null;
    this._loadAddon();
  }

  // ── Load the compiled native module ─────────────────────
  _loadAddon() {
    const searchPaths = [
      path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'haven_audio.node'),
      path.join(__dirname, '..', '..', 'native', 'build', 'Debug',   'haven_audio.node'),
    ];

    // When running from a packaged app, resources live in a different place
    if (process.resourcesPath) {
      searchPaths.push(path.join(process.resourcesPath, 'native', 'haven_audio.node'));
    }

    for (const p of searchPaths) {
      try {
        this._addon = require(p);
        console.log(`[AudioCapture] Native addon loaded: ${p}`);
        return;
      } catch { /* try next */ }
    }

    console.warn('[AudioCapture] Native addon not found — per-app audio unavailable.');
    console.warn('[AudioCapture] Run  npm run build:native  to compile it.');
  }

  // ── Public API ──────────────────────────────────────────

  /** Is per-app capture supported on this OS? */
  isSupported() {
    if (!this._addon) return false;
    try { return this._addon.isSupported(); }
    catch { return false; }
  }

  /**
   * List applications currently producing audio.
   * @returns {Array<{pid:number, name:string, icon?:string}>}
   */
  getAudioApplications() {
    if (!this._addon) return [];
    try {
      return this._addon.getAudioApplications().map(app => ({
        ...app,
        name: app.name === 'Unknown' ? this._t('audio.unknownApplication') : app.name,
        nameKey: app.name === 'Unknown' ? 'audio.unknownApplication' : undefined,
      }));
    }
    catch (e) { console.error('[AudioCapture] getAudioApplications:', e); return []; }
  }

  _localizeStatus(status) {
    if (!status?.message) return status;
    const rawMessage = status.message;
    const exact = new Map([
      ['OpenProcess failed for target PID — process may have exited or be protected', 'audio.status.openProcessFailed'],
      ['WASAPI activation timed out (>12s)', 'audio.status.wasapiTimeout'],
      ['capture stopped', 'audio.status.captureStopped'],
      ['ActivateAudioInterfaceAsync returned failure (process loopback API may be unavailable)', 'audio.status.wasapiUnavailable'],
      ['Process loopback denied (target may be a protected/UWP process)', 'audio.status.wasapiDenied'],
      ['ActivateCompleted reported failure', 'audio.status.wasapiActivationFailed'],
      ['IAudioClient::Initialize failed for both preferred and mix formats', 'audio.status.wasapiFormatFailed'],
      ['Initialize failed and GetMixFormat returned no format', 'audio.status.wasapiNoFormat'],
      ['GetService(IAudioCaptureClient) failed', 'audio.status.wasapiServiceFailed'],
      ['IAudioClient::Start failed', 'audio.status.wasapiStartFailed'],
      ['WASAPI process loopback active', 'audio.status.wasapiActive'],
      ['GetNextPacketSize repeatedly failed — aborting capture', 'audio.status.wasapiPacketFailed'],
      ['GetBuffer repeatedly failed — aborting capture', 'audio.status.wasapiBufferFailed'],
      ['Exclude-mode capture is not supported on Linux (PulseAudio/PipeWire)', 'audio.status.linuxExcludeUnsupported'],
      ['pulse capture stopped', 'audio.status.pulseStopped'],
      ['pa_context_connect failed (PulseAudio/PipeWire daemon not reachable)', 'audio.status.pulseUnavailable'],
      ['pa_context_get_sink_input_info_list returned NULL', 'audio.status.pulseEnumerationFailed'],
      ['pulse capture active', 'audio.status.pulseActive'],
    ]);

    let messageKey = exact.get(rawMessage);
    let messageValues = {};
    if (!messageKey) {
      const wasapiMatch = /^activating (EXCLUDE|INCLUDE)-mode process loopback for PID (\d+)$/.exec(rawMessage);
      if (wasapiMatch) {
        const modeKey = wasapiMatch[1] === 'EXCLUDE' ? 'audio.mode.exclude' : 'audio.mode.include';
        messageKey = 'audio.status.activatingWasapi';
        messageValues = {
          mode: this._t(modeKey),
          modeKey,
          pid: wasapiMatch[2],
        };
      }

      const pulseMatch = /^preparing pulse capture for PID (\d+)$/.exec(rawMessage);
      if (!messageKey && pulseMatch) {
        messageKey = 'audio.status.preparingPulse';
        messageValues = { pid: pulseMatch[1] };
      }

      const inputMatch = /^No PulseAudio sink input found for PID (\d+) \(the app may have stopped producing audio\)$/.exec(rawMessage);
      if (!messageKey && inputMatch) {
        messageKey = 'audio.status.pulseInputMissing';
        messageValues = { pid: inputMatch[1] };
      }

      const createMatch = /^pa_simple_new failed: (.+)$/.exec(rawMessage);
      if (!messageKey && createMatch) {
        messageKey = 'audio.status.pulseCreateFailed';
        messageValues = { error: createMatch[1] };
      }
    }

    if (messageKey) {
      return {
        ...status,
        message: this._t(messageKey, messageValues),
        messageKey,
        messageValues,
        rawMessage,
      };
    } else {
      return status;
    }
  }

  /**
   * Start capturing audio.
   * @param {number} pid               Target process ID
   * @param {Object} opts              Capture options
   * @param {'include'|'exclude'} [opts.mode='include']
   *                                   include: capture FROM this PID tree
   *                                   exclude: capture all system audio EXCEPT this PID tree
   *                                   (Windows only — Linux returns failure for exclude)
   * @param {function} opts.onData     Receives Float32Array PCM chunks (48 kHz mono)
   * @param {function} [opts.onStatus] Receives {kind, message, code} status events.
   *                                   kinds: 'starting' | 'started' | 'failed' | 'stopped'
   * @returns {boolean} true if synchronous activation succeeded
   */
  startCapture(pid, opts) {
    if (!this._addon) {
      const error = new Error(this._t('audio.error.addonUnavailable'));
      error.messageKey = 'audio.error.addonUnavailable';
      throw error;
    }

    // Backwards-compatible: startCapture(pid, fn) → include-mode.
    if (typeof opts === 'function') {
      opts = { mode: 'include', onData: opts };
    }
    const mode    = (opts && opts.mode) === 'exclude' ? 'exclude' : 'include';
    const onData  = opts && opts.onData;
    const onStatus = opts && opts.onStatus;
    if (typeof onData !== 'function') {
      const error = new Error(this._t('audio.error.callbackRequired'));
      error.messageKey = 'audio.error.callbackRequired';
      throw error;
    }

    if (this._capturing) this.stopCapture();

    this._callback   = onData;
    this._onStatus   = onStatus || null;
    this._capturing  = true;
    this._lastDataAt = Date.now();
    this._initFailed = false;
    this._lastStatus = null;

    const dataWrap = (pcm) => {
      this._lastDataAt = Date.now();
      if (this._callback) this._callback(pcm);
    };

    const statusWrap = (nativeStatus) => {
      const s = this._localizeStatus(nativeStatus);
      this._lastStatus = s;
      if (s && s.kind === 'failed') this._initFailed = true;
      console.log(`[AudioCapture] native status: ${s?.kind} (code=0x${(s?.code >>> 0).toString(16)}) — ${nativeStatus?.message}`);
      if (this._onStatus) {
        try { this._onStatus(s); } catch (e) { console.warn('[AudioCapture] onStatus threw:', e.message); }
      }
    };

    try {
      const ok = this._addon.startCapture(pid, mode, dataWrap, statusWrap);
      if (!ok) {
        this._capturing = false;
        this._callback  = null;
        const reason = this._lastStatus?.message || this._t('audio.error.startReturnedFalse');
        console.warn(`[AudioCapture] start failed (mode=${mode}, pid=${pid}): ${reason}`);
        return false;
      }
      console.log(`[AudioCapture] Capturing PID ${pid} (mode=${mode})`);

      // Watchdog: if no data arrives for 12 seconds after start, the native
      // capture thread likely went silent on us (target PID exited, etc).
      // Bumped from 8s because some sources (paused games) take a while to
      // produce real audio; the native heartbeat keeps lastDataAt fresh.
      this._watchdog = setTimeout(() => {
        if (this._capturing && Date.now() - this._lastDataAt > 11000) {
          console.warn('[AudioCapture] No data received in 11s — stopping capture');
          this.stopCapture();
        }
      }, 12000);

      return true;
    } catch (e) {
      this._capturing = false;
      this._callback  = null;
      throw e;
    }
  }

  /** Stop active capture. */
  stopCapture() {
    clearTimeout(this._watchdog);
    if (this._addon && this._capturing) {
      try { this._addon.stopCapture(); } catch { /* */ }
    }
    this._capturing = false;
    this._callback  = null;
  }

  /**
   * Opt Haven's audio sessions out of Windows ducking.
   * Call after audio starts playing (sessions must exist).
   * @returns {number} number of sessions opted out
   */
  optOutOfDucking() {
    if (!this._addon?.optOutOfDucking) return 0;
    try { return this._addon.optOutOfDucking(); }
    catch (e) { console.warn('[AudioCapture] optOutOfDucking:', e.message); return 0; }
  }

  /** Release all resources. */
  cleanup() {
    this.stopCapture();
    if (this._addon?.cleanup) { try { this._addon.cleanup(); } catch { /* */ } }
  }
}

module.exports = { AudioCaptureManager };
