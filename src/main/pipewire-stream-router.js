const fs = require('fs');
const { spawn } = require('child_process');

function createJsonArrayParser(onValue, onError = () => {}) {
  let current = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  return (chunk) => {
    for (const char of chunk.toString()) {
      if (depth === 0) {
        if (char !== '[') continue;
        current = char;
        depth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      current += char;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
      }

      if (depth !== 0) continue;
      try {
        onValue(JSON.parse(current));
      } catch (err) {
        onError(err);
      }
      current = '';
    }
  };
}

function processParentPid(pid, readFileSync = fs.readFileSync) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    return Number.isSafeInteger(parent) && parent >= 0 ? parent : null;
  } catch {
    return null;
  }
}

function isProcessInTree(pid, rootPid, readFileSync = fs.readFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(rootPid) || rootPid <= 0) return false;

  for (let depth = 0; pid > 0 && depth < 64; depth++) {
    if (pid === rootPid) return true;
    const parent = processParentPid(pid, readFileSync);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return false;
}

function processExecutable(pid, readlinkSync = fs.readlinkSync) {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return '';
  }
}

function isExternalProcess(
  pid,
  rootPid,
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync
) {
  if (!Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(rootPid) || rootPid <= 0) return false;

  const executable = processExecutable(pid, readlinkSync);
  const rootExecutable = processExecutable(rootPid, readlinkSync);
  if (!executable || !rootExecutable || executable === rootExecutable) return false;

  for (let depth = 0; pid > 0 && depth < 64; depth++) {
    if (pid === rootPid) return false;
    const parent = processParentPid(pid, readFileSync);
    if (parent === null || parent === pid) return false;
    if (parent === 0) return true;
    pid = parent;
  }
  return false;
}

function metadataValue(value, type) {
  if (typeof value === 'string') return value;
  if (type === 'Spa:String:JSON') return JSON.stringify(value);
  return String(value);
}

class PipeWireStreamRouter {
  constructor({
    spawnProcess = spawn,
    // Optional synchronous injector (used by tests). When omitted,
    // pw-metadata runs via an async spawn so the main thread never blocks.
    runCommand = null,
    processExternal = isExternalProcess,
    logger = console,
  } = {}) {
    this._spawnProcess = spawnProcess;
    this._runCommand = runCommand;
    this._processExternal = processExternal;
    this._logger = logger;
    this._monitor = null;
    this._objects = new Map();
    this._metadataTargets = new Map();
    this._routes = new Map();
    // Each operation keeps its own identity and vetoes until both its move
    // and any repair finish. Neither stop() nor ID reuse replaces this entry.
    this._activeMoves = new Map();
    // Includes published routes and queued/in-flight restores so monitor
    // updates can invalidate them synchronously, even across stop()/start().
    this._routeOperations = new Set();
    this._warnedMetadata = false;
    // Async-session guards (see stop()): every start/stop bumps the
    // generation so late pw-metadata completions from a previous session can
    // neither publish routes nor clobber the new one, and every stop chains
    // its restoration after the previous one so an old `pw-metadata -d`
    // cannot wipe a route the new session just created.
    this._generation = 0;
    this._pendingRestore = Promise.resolve();
  }

  start(combinedSinkName, rootPid = process.pid) {
    this.stop();
    if (!combinedSinkName || !Number.isSafeInteger(rootPid) || rootPid <= 0) return false;

    this._combinedSinkName = combinedSinkName;
    this._rootPid = rootPid;

    let monitor;
    try {
      monitor = this._spawnProcess(
        'pw-dump',
        ['--monitor', '--no-colors', '--indent=0'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } catch (err) {
      this._logger.warn(`[ScreenShare] PipeWire stream monitor unavailable: ${err.message}`);
      return false;
    }
    if (!monitor?.stdout) return false;

    this._monitor = monitor;
    const parse = createJsonArrayParser(
      batch => {
        if (this._monitor === monitor) this._handleBatch(batch);
      },
      err => this._logger.warn(`[ScreenShare] Invalid pw-dump update: ${err.message}`)
    );
    monitor.stdout.on('data', parse);
    monitor.stdout.once('error', (err) => {
      if (this._monitor !== monitor) return;
      this._logger.warn(`[ScreenShare] PipeWire stream monitor output failed: ${err.message}`);
      this.stop();
    });
    monitor.once('error', (err) => {
      if (this._monitor !== monitor) return;
      this._logger.warn(`[ScreenShare] PipeWire stream monitor failed: ${err.message}`);
      this.stop();
    });
    monitor.once('close', () => {
      if (this._monitor !== monitor) return;
      this._logger.warn('[ScreenShare] PipeWire stream monitor stopped unexpectedly');
      this.stop();
    });
    return true;
  }

  stop() {
    this._generation++;
    const monitor = this._monitor;
    this._monitor = null;
    if (monitor) {
      try { monitor.kill(); } catch {}
    }

    // Snapshot the routes before clearing: restoration runs asynchronously
    // (pw-metadata via spawn) so the monitor detach above stays synchronous.
    // Operation identities and observed vetoes survive the graph clear.
    const routes = [...this._routes];
    this._objects.clear();
    this._metadataTargets.clear();
    this._routes.clear();
    this._warnedMetadata = false;

    // Chain after the previous stop's restoration: without this, an old
    // session's `pw-metadata -d` (already spawned) could land after the new
    // session's move and wipe a route that was just created.
    const previous = this._pendingRestore;
    const pending = previous.then(() => this._restoreAll(routes)).catch(() => false);
    this._pendingRestore = pending;
    // The chain link above already handles rejection; this extra guard keeps
    // intermediate links from ever surfacing as unhandled rejections.
    pending.catch(() => {});
    return pending;
  }

  async _restoreAll(routes) {
    const failedRoutes = [];
    for (const [nodeId, route] of routes) {
      try {
        if (!await this._restoreRoute(nodeId, route) && !await this._restoreRoute(nodeId, route)) {
          failedRoutes.push(nodeId);
        }
      } finally {
        if (this._activeMoves.get(nodeId) !== route && this._routes.get(nodeId) !== route) {
          this._routeOperations.delete(route);
        }
      }
    }
    if (failedRoutes.length) {
      this._logger.warn(
        `[ScreenShare] Could not restore PipeWire stream route(s): ${failedRoutes.join(', ')}`
      );
    }
    return failedRoutes.length === 0;
  }

  _sameStream(route, node) {
    if (node?.type !== 'PipeWire:Interface:Node') return false;
    const serial = Number(node.props['object.serial']);
    if (Number.isSafeInteger(route.streamSerial) && route.streamSerial > 0 &&
        Number.isSafeInteger(serial) && serial > 0) return serial === route.streamSerial;
    const clientId = node.props['client.id'];
    const name = node.props['node.name'];
    // A partial initial snapshot is not evidence of reuse. Compare the
    // fallback fields only when both identities actually provide them.
    if (clientId !== undefined && route.streamClientId && String(clientId) !== route.streamClientId) return false;
    if (name !== undefined && route.streamName && String(name) !== route.streamName) return false;
    return true;
  }

  _targetMatches(value, type, target) {
    if (value === null || value === undefined) return !target;
    if (!target) return false;
    if ((type || 'Spa:Id') !== (target.type || 'Spa:Id')) return false;
    return metadataValue(value, type) === metadataValue(target.value, target.type);
  }

  _observeTarget(route, entry) {
    if (Number(entry.value) === route.combinedSerial) {
      route.observedCombined = true;
      // Keep the user's latest choice, but note that our pending command
      // overwrote it. A repair must reapply that choice, not abandon the
      // stream at the combined sink or restore an older saved target.
      if (route.externallyChanged) route.targetOverwritten = true;
      return;
    }
    // A monitor's initial snapshot may still contain the pre-move target.
    // Own command echoes can arrive after the next command is issued. Keep
    // all submitted restore targets, not just the most recent one.
    if (route.phase === 'moving' && !route.externallyChanged &&
        this._targetMatches(entry.value, entry.type, route.previousTarget)) return;
    if (route.phase === 'moving' && !route.observedCombined && !route.externallyChanged &&
        !route.previousTarget && Number(entry.value) === route.originalSerial) {
      // Metadata can be announced after the node/link. Preserve a late
      // initial explicit target instead of mistaking it for an external veto.
      route.previousTarget = { value: entry.value, type: entry.type };
      return;
    }
    if (route.phase === 'restoring' && route.restoreTargets.some(target =>
      this._targetMatches(entry.value, entry.type, target)
    )) {
      if (route.externallyChanged) route.targetOverwritten = true;
      return;
    }
    route.externallyChanged = true;
    route.externalTarget = entry.value === null || entry.value === undefined
      ? null
      : { value: entry.value, type: entry.type };
    route.targetOverwritten = false;
  }

  _canRestore(nodeId, route) {
    if (route.invalidated || (route.externallyChanged && !route.targetOverwritten)) return false;
    const live = this._objects.get(nodeId);
    // Missing from a new monitor's partial graph is not a removal. Known
    // removals/reuse permanently veto the operation at ingestion time.
    if (live && !this._sameStream(route, live)) {
      route.invalidated = true;
      return false;
    }
    return true;
  }

  _observeObject(id, object) {
    // Ingestion never waits for the restore queue, including initial
    // snapshots. Non-node objects can reuse a numeric node ID as well.
    for (const route of this._routeOperations) {
      if (route.nodeId === id && !this._sameStream(route, object)) route.invalidated = true;
    }
  }

  _handleBatch(batch) {
    if (!Array.isArray(batch)) return;

    const generation = this._generation;
    for (const update of batch) {
      if (!Number.isSafeInteger(update?.id)) continue;
      if (update.info === null) {
        this._removeObject(update.id);
        continue;
      }
      this._updateObject(update);
    }
    // Route asynchronously: pw-metadata must never run synchronously on the
    // main thread (once per stream per pw-dump update would freeze the UI),
    // so this is intentionally fire-and-forget. Per-stream guards in
    // _activeMoves keep overlapping updates from moving the same node twice;
    // the generation check drops work from sessions ended while waiting.
    void this._routeEligibleStreams(generation).catch(() => false);
  }

  _updateObject(update) {
    const existing = this._objects.get(update.id);
    const type = update.type || existing?.type;

    if (type === 'PipeWire:Interface:Client' || type === 'PipeWire:Interface:Node') {
      const props = {
        ...(existing?.props || {}),
        ...(update.info?.props || {}),
      };
      const node = { type, props };
      this._objects.set(update.id, node);
      this._observeObject(update.id, node);
      return;
    }

    if (type === 'PipeWire:Interface:Link') {
      this._objects.set(update.id, {
        type,
        outputNode: update.info?.['output-node-id'] ?? existing?.outputNode,
        inputNode: update.info?.['input-node-id'] ?? existing?.inputNode,
      });
      this._observeObject(update.id, this._objects.get(update.id));
      return;
    }

    if (type !== 'PipeWire:Interface:Metadata') return;
    const props = { ...(existing?.props || {}), ...(update.props || {}) };
    this._objects.set(update.id, { type, props });
    this._observeObject(update.id, this._objects.get(update.id));
    if (props['metadata.name'] !== 'default') return;

    for (const entry of update.metadata || []) {
      const subject = Number(entry.subject);
      if (!Number.isSafeInteger(subject) || entry.key !== 'target.object') continue;
      for (const route of this._routeOperations) {
        if (route.nodeId === subject) {
          this._observeTarget(route, entry);
        }
      }
      if (entry.value === null || entry.value === undefined) {
        this._metadataTargets.delete(subject);
      } else {
        this._metadataTargets.set(subject, { type: entry.type, value: entry.value });
      }
    }
  }

  _removeObject(id) {
    // Preserve the veto on the operation itself, including removals in the
    // same generation. Do not launch a blind metadata delete for a removed ID
    // that can already belong to another stream by the time it executes.
    for (const route of this._routeOperations) {
      if (route.nodeId === id) route.invalidated = true;
    }
    const route = this._routes.get(id);
    if (route) {
      this._routes.delete(id);
      if (this._activeMoves.get(id) !== route) this._routeOperations.delete(route);
    }
    this._metadataTargets.delete(id);
    this._objects.delete(id);
  }

  async _routeEligibleStreams(generation = this._generation) {
    // Wait for any in-flight stop-restoration first: an old session's
    // `pw-metadata -d` must land before this session's move, never after.
    try { await this._pendingRestore; } catch {}
    if (generation !== this._generation) return;

    for (const nodeId of [...this._objects.keys()]) {
      if (generation !== this._generation) return;
      const pending = this._activeMoves.get(nodeId);
      if (pending) {
        // The promise covers the complete operation, including a late repair.
        // Removal never releases this slot early, even in the same session.
        try { await pending.promise; } catch {}
        try { await this._pendingRestore; } catch {}
        if (generation !== this._generation) return;
      }
      if (this._routes.has(nodeId) || this._activeMoves.has(nodeId)) continue;

      // Read all identity, eligibility and targets after waiting. A legitimate
      // replacement stream gets its own operation, not the old one's veto.
      const route = this._eligibleRoute(nodeId, generation);
      if (!route) continue;
      this._routeOperations.add(route);
      this._activeMoves.set(nodeId, route);
      route.promise = this._moveStream(nodeId, route);
      await route.promise;
    }
  }

  _externalAudioNode(nodeId) {
    const node = this._objects.get(nodeId);
    if (node?.type !== 'PipeWire:Interface:Node' ||
        node.props['media.class'] !== 'Stream/Output/Audio') return null;
    const nodeName = String(node.props['node.name'] || '');
    if (nodeName.startsWith(`output.${this._combinedSinkName}_`) ||
        node.props['node.virtual'] === true) return null;
    const client = this._objects.get(Number(node.props['client.id']));
    const props = { ...(client?.props || {}), ...node.props };
    if (props['client.api'] === 'pipewire-pulse' || !this._isExternalStream(props)) return null;
    return node;
  }

  _eligibleRoute(nodeId, generation) {
    const node = this._externalAudioNode(nodeId);
    if (!node) return null;
    const combinedSink = [...this._objects.values()].find(object =>
      object.type === 'PipeWire:Interface:Node' &&
      object.props['node.name'] === this._combinedSinkName
    );
    const combinedSerial = Number(combinedSink?.props['object.serial']);
    const originalSink = this._findLinkedSink(nodeId);
    const originalSerial = Number(originalSink?.props['object.serial']);
    if (!Number.isSafeInteger(combinedSerial) || combinedSerial <= 0 ||
        !Number.isSafeInteger(originalSerial) || originalSerial <= 0 ||
        originalSink.props['node.name'] === this._combinedSinkName) return null;
    let previousTarget = this._metadataTargets.get(nodeId) || null;
    if (Number(previousTarget?.value) === combinedSerial) previousTarget = null;
    return {
      nodeId,
      generation,
      originalSerial,
      previousTarget,
      combinedSerial,
      streamSerial: Number(node.props['object.serial']),
      streamClientId: String(node.props['client.id'] ?? ''),
      streamName: String(node.props['node.name'] || ''),
      phase: 'moving',
      invalidated: false,
      externallyChanged: false,
    };
  }

  async _moveStream(nodeId, route) {
    try {
      const moved = await this._runMetadata([
        '-n', 'default', String(nodeId), 'target.object', String(route.combinedSerial), 'Spa:Id',
      ]);
      if (!moved || route.invalidated) return;
      const live = this._objects.get(nodeId);
      if (live && !this._sameStream(route, live)) return;
      if (route.generation === this._generation && this._externalAudioNode(nodeId)) {
        // Its link may already point to the combined sink, which is the
        // expected result of the move (not a reason to undo a live share).
        // Retain externally changed routes too: do not retry/move them again
        // in this session, and their restore remains vetoed.
        route.phase = 'published';
        this._routes.set(nodeId, route);
        return;
      }
      // A stopped session can still have landed its move. Queue its repair
      // after previous restores; the operation's promise covers the repair
      // too, so no later move of this ID can race either of its commands.
      const previous = this._pendingRestore;
      const repair = previous.then(() => this._restoreAll([[nodeId, route]])).catch(() => false);
      this._pendingRestore = repair;
      await repair;
    } finally {
      if (this._activeMoves.get(nodeId) === route) this._activeMoves.delete(nodeId);
      if (this._routes.get(nodeId) !== route) this._routeOperations.delete(route);
    }
  }

  _findLinkedSink(nodeId) {
    for (const object of this._objects.values()) {
      if (object.type !== 'PipeWire:Interface:Link' || object.outputNode !== nodeId) continue;
      const target = this._objects.get(object.inputNode);
      if (target?.type === 'PipeWire:Interface:Node') return target;
    }
    return null;
  }

  _isExternalStream(props) {
    const access = String(props['pipewire.access.effective'] || props['pipewire.access'] || '');
    const securePid = Number(props['pipewire.sec.pid']);
    if (access.includes('flatpak')) {
      return Number.isSafeInteger(securePid) && securePid > 0 &&
        this._processExternal(securePid, this._rootPid);
    }

    const processIds = [
      Number(props['application.process.id']),
      securePid,
    ].filter(pid => Number.isSafeInteger(pid) && pid > 0);
    return processIds.length > 0 &&
      processIds.every(pid => this._processExternal(pid, this._rootPid));
  }

  async _restoreRoute(nodeId, route) {
    if (!this._canRestore(nodeId, route)) return true;
    route.phase = 'restoring';
    route.restoreTargets ||= [];
    // Observations are ordered: if our command overwrote a newer user target,
    // restore that newer target. If it is still current, _canRestore skips.
    const target = route.externallyChanged ? route.externalTarget : route.previousTarget;
    if (!target) {
      route.restoreTargets.push({ value: route.originalSerial, type: 'Spa:Id' });
      const restored = await this._runMetadata([
        '-n', 'default', String(nodeId), 'target.object', String(route.originalSerial), 'Spa:Id',
      ]);
      // Reuse or an external target change can arrive while the first command
      // is pending. Its completion must not issue a delete for the new stream.
      if (!this._canRestore(nodeId, route)) return true;
      if (route.externallyChanged && route.externalTarget) return false;
      route.restoreTargets.push(null);
      const released = await this._runMetadata(['-n', 'default', '-d', String(nodeId), 'target.object']);
      if (!this._canRestore(nodeId, route)) return true;
      if (route.externallyChanged && route.externalTarget) return false;
      return restored && released;
    }

    const { type = 'Spa:Id', value } = target;
    route.restoreTargets.push(target);
    const restored = await this._runMetadata([
      '-n', 'default', String(nodeId), 'target.object', metadataValue(value, type), type,
    ]);
    if (!this._canRestore(nodeId, route)) return true;
    // A different choice may have been overwritten by this command while it
    // was in flight. Request the bounded retry for the last observed choice.
    if (route.externallyChanged && !this._targetMatches(
      route.externalTarget?.value, route.externalTarget?.type, target
    )) return false;
    return restored;
  }

  // Runs pw-metadata without ever blocking the main thread. Prefers the
  // injected sync command when tests provide one; otherwise spawns the
  // binary asynchronously with a short timeout.
  async _runMetadata(args) {
    if (typeof this._runCommand === 'function') {
      let result;
      try {
        result = await this._runCommand('pw-metadata', args, {
          encoding: 'utf8',
          timeout: 500,
          windowsHide: true,
        });
      } catch (err) {
        this._warnMetadataOnce(err.message);
        return false;
      }
      if (!result?.error && (result?.status === 0 || result?.status === undefined)) return true;
      const detail = result?.error?.message || String(result?.stderr || '').trim() || 'command failed';
      this._warnMetadataOnce(detail);
      return false;
    }

    return new Promise(resolve => {
      let child;
      try {
        child = this._spawnProcess('pw-metadata', args, { windowsHide: true });
      } catch (err) {
        this._warnMetadataOnce(err.message);
        resolve(false);
        return;
      }
      if (!child?.once) {
        this._warnMetadataOnce('command failed');
        resolve(false);
        return;
      }
      let settled = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this._warnMetadataOnce('command failed');
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        done(false);
      }, 500);
      timer.unref?.();
      child.once('error', err => {
        this._warnMetadataOnce(err.message);
        done(false);
      });
      child.once('close', code => done(code === 0));
    });
  }

  _warnMetadataOnce(detail) {
    if (this._warnedMetadata) return;
    this._logger.warn(`[ScreenShare] Could not route native PipeWire audio: ${detail}`);
    this._warnedMetadata = true;
  }
}

module.exports = {
  PipeWireStreamRouter,
  createJsonArrayParser,
  isExternalProcess,
  isProcessInTree,
};
