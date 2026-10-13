// The share picker's audio modes. 'window' shares the audio of whichever
// window is being shared (#5760), and is where the picker starts unless the
// person picked something else last time.
const AUDIO_MODES = ['window', 'system', 'none'];

function normalizeAudioMode(value) {
  return AUDIO_MODES.includes(value) ? value : 'window';
}

// "window:<HWND>:<n>" on Windows: the window handle as a number.
function windowHandleOf(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId || ''));
  if (!match) return null;
  const handle = Number(match[1]);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

// Pairs each shared-window source with the process behind it. Returns the
// pairs for the picker ({sourceId: {pid, name}}) and the full list of PIDs
// that may be captured: the audio apps plus those window processes, which
// may have no audio session at the moment (a game that goes quiet when it
// loses focus). Main builds both lists, so a picker answer outside them is
// still refused.
function pairWindowAudio(sources, audioApps, windowProcesses) {
  const byHandle = new Map();
  for (const w of Array.isArray(windowProcesses) ? windowProcesses : []) {
    if (!w || !Number.isSafeInteger(w.hwnd) || !Number.isSafeInteger(w.pid) || w.pid <= 0) continue;
    if (typeof w.identity !== 'string' || !w.identity) continue;
    byHandle.set(w.hwnd, w);
  }
  const windowAudio = {};
  const capturable = [...audioApps];
  for (const source of Array.isArray(sources) ? sources : []) {
    const handle = windowHandleOf(source && source.id);
    const owner = handle && byHandle.get(handle);
    if (!owner) continue;
    windowAudio[source.id] = { pid: owner.pid, name: owner.name || String(owner.pid) };
    if (!capturable.some(app => app.pid === owner.pid)) {
      capturable.push({ pid: owner.pid, name: owner.name, identity: owner.identity, active: false, fromWindow: true });
    }
  }
  return { windowAudio, capturable };
}

function resolveAudioSelection(value, audioApps, capabilities) {
  if (value === 'system' && capabilities?.system === true) {
    return { type: 'system', app: null };
  }

  if (Number.isSafeInteger(value) && value > 0) {
    const app = audioApps.find(candidate => candidate.pid === value);
    if (app) return { type: 'application', app };
  }

  return { type: 'none', app: null };
}

function shouldDropAudioPacket(capturedAt, now = Date.now(), maxAgeMs = 150) {
  return !Number.isFinite(capturedAt) || now - capturedAt > maxAgeMs;
}

class BoundedPcmRing {
  constructor(capacity) {
    this._data = new Float32Array(capacity);
    this._read = 0;
    this._write = 0;
    this._available = 0;
  }

  get available() {
    return this._available;
  }

  push(samples) {
    if (!samples?.length) return 0;
    const capacity = this._data.length;
    let dropped = Math.max(0, this._available + samples.length - capacity);

    if (samples.length >= capacity) {
      this._data.set(samples.subarray(samples.length - capacity));
      this._read = 0;
      this._write = 0;
      this._available = capacity;
      return dropped;
    }

    if (dropped) {
      this._read = (this._read + dropped) % capacity;
      this._available -= dropped;
    }
    for (let i = 0; i < samples.length; i++) {
      this._data[this._write] = samples[i];
      this._write = (this._write + 1) % capacity;
    }
    this._available += samples.length;
    return dropped;
  }

  pull(output) {
    if (this._available < output.length) {
      output.fill(0);
      this._read = this._write;
      this._available = 0;
      return false;
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this._data[this._read];
      this._read = (this._read + 1) % this._data.length;
    }
    this._available -= output.length;
    return true;
  }
}

function createAudioCaptureController(stopCapture) {
  let active = null;

  const detach = () => {
    if (!active) return null;
    const current = active;
    active = null;
    current.owner.removeListener('destroyed', current.cleanup);
    current.owner.removeListener('render-process-gone', current.cleanup);
    current.owner.removeListener('did-start-navigation', current.navigationCleanup);
    return current;
  };

  const stop = (captureId = null, ownerId = null) => {
    if (!active) return false;
    if (captureId && active.id !== captureId) return false;
    if (ownerId && active.ownerId !== ownerId) return false;
    detach();
    stopCapture();
    return true;
  };

  return {
    start(captureId, owner) {
      stop();
      const ownerId = owner.id;
      const cleanup = () => stop(captureId, ownerId);
      const navigationCleanup = (_event, _url, isInPlace, isMainFrame) => {
        if (!isInPlace && isMainFrame !== false) cleanup();
      };
      active = { id: captureId, ownerId, owner, cleanup, navigationCleanup };
      owner.once('destroyed', cleanup);
      owner.once('render-process-gone', cleanup);
      owner.on('did-start-navigation', navigationCleanup);
    },
    stop,
    clear(captureId) {
      if (!active || active.id !== captureId) return false;
      detach();
      return true;
    },
    isActive(captureId) {
      return active?.id === captureId;
    },
    hasActive() {
      return active !== null;
    },
  };
}

module.exports = {
  AUDIO_MODES,
  BoundedPcmRing,
  createAudioCaptureController,
  normalizeAudioMode,
  pairWindowAudio,
  resolveAudioSelection,
  shouldDropAudioPacket,
  windowHandleOf,
};
