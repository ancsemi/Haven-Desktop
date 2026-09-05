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
      active = { id: captureId, ownerId, owner, cleanup };
      owner.once('destroyed', cleanup);
      owner.once('render-process-gone', cleanup);
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
  BoundedPcmRing,
  createAudioCaptureController,
  resolveAudioSelection,
  shouldDropAudioPacket,
};
