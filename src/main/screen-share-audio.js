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

module.exports = { createAudioCaptureController, resolveAudioSelection };
