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
  constructor() {
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
    try { return this._addon.getAudioApplications(); }
    catch (e) { console.error('[AudioCapture] getAudioApplications:', e); return []; }
  }

  /**
   * Start capturing audio.
   * @param {number} pid               Target process ID
   * @param {Object} opts              Capture options
   * @param {'include'|'exclude'|'system'} [opts.mode='include']
   *                                   include: capture FROM this PID tree
   *                                   exclude: capture all system audio EXCEPT this PID tree
   *                                   (Windows only — Linux returns failure for exclude)
   * @param {function} opts.onData     Receives Float32Array PCM chunks (48 kHz mono)
   * @param {function} [opts.onStatus] Receives {kind, message, code} status events.
   *                                   kinds: 'starting' | 'started' | 'failed' | 'stopped'
   * @returns {boolean} true if synchronous activation succeeded
   */
  startCapture(pid, opts) {
    if (!this._addon) throw new Error('Native audio capture addon not available');

    // Backwards-compatible: startCapture(pid, fn) → include-mode.
    if (typeof opts === 'function') {
      opts = { mode: 'include', onData: opts };
    }
    const requestedMode = opts && opts.mode;
    const mode = requestedMode === 'exclude' || requestedMode === 'system'
      ? requestedMode
      : 'include';
    const onData  = opts && opts.onData;
    const onStatus = opts && opts.onStatus;
    if (typeof onData !== 'function') throw new Error('startCapture: onData callback required');

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

    const statusWrap = (s) => {
      this._lastStatus = s;
      if (s && s.kind === 'failed') this._initFailed = true;
      console.log(`[AudioCapture] native status: ${s?.kind} (code=0x${(s?.code >>> 0).toString(16)}) — ${s?.message}`);
      if (this._onStatus) {
        try { this._onStatus(s); } catch (e) { console.warn('[AudioCapture] onStatus threw:', e.message); }
      }
    };

    try {
      const ok = this._addon.startCapture(pid, mode, dataWrap, statusWrap);
      if (!ok) {
        this._capturing = false;
        this._callback  = null;
        const reason = this._lastStatus?.message || 'native startCapture returned false';
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
