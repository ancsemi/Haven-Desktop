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
    this._routing = new Set();
    // In-flight pw-metadata moves by node, surviving stop()/start() so a new
    // session waits for an older session's move + late repair instead of
    // racing it and getting wiped.
    this._activeMoves = new Map();
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
    // Also snapshot the live node identity for in-flight moves: the late
    // repair must be able to tell a removed/reused ID apart from the original
    // stream even after the graph below is cleared.
    const routes = [...this._routes];
    for (const [nodeId, active] of this._activeMoves) {
      // Keep the first snapshot: start() calls stop() internally, so a
      // restart would otherwise overwrite the pre-clear identity with absent.
      if (active.atStop !== undefined) continue;
      const live = this._objects.get(nodeId);
      if (live?.type === 'PipeWire:Interface:Node') {
        active.atStop = {
          present: true,
          serial: Number(live.props['object.serial']),
          clientId: Number(live.props['client.id']),
          name: String(live.props['node.name'] || ''),
        };
      } else {
        active.atStop = { present: false };
      }
    }
    this._objects.clear();
    this._metadataTargets.clear();
    this._routes.clear();
    this._routing.clear();
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
      if (route.externallyChanged) continue;
      if (!await this._restoreRoute(nodeId, route) && !await this._restoreRoute(nodeId, route)) {
        failedRoutes.push(nodeId);
      }
    }
    if (failedRoutes.length) {
      this._logger.warn(
        `[ScreenShare] Could not restore PipeWire stream route(s): ${failedRoutes.join(', ')}`
      );
    }
    return failedRoutes.length === 0;
  }

  _markStaleInvalid(nodeId, observerGeneration) {
    const active = this._activeMoves.get(nodeId);
    if (active && active.generation !== observerGeneration) active.invalidated = true;
  }

  _handleBatch(batch) {
    if (!Array.isArray(batch)) return;

    const generation = this._generation;
    for (const update of batch) {
      if (!Number.isSafeInteger(update?.id)) continue;
      if (update.info === null) {
        this._removeObject(update.id, generation);
        continue;
      }
      this._updateObject(update, generation);
    }
    // Route asynchronously: pw-metadata must never run synchronously on the
    // main thread (once per stream per pw-dump update would freeze the UI),
    // so this is intentionally fire-and-forget. Per-stream guards in
    // _routing keep overlapping updates from moving the same node twice, and
    // the generation check drops work from sessions ended while waiting.
    void this._routeEligibleStreams(generation).catch(() => false);
  }

  _updateObject(update, observerGeneration = this._generation) {
    const existing = this._objects.get(update.id);
    const type = update.type || existing?.type;

    if (type === 'PipeWire:Interface:Client' || type === 'PipeWire:Interface:Node') {
      // ID reuse observed as an in-place serial/owner change invalidates a
      // late repair for an older session's stream with the same numeric ID.
      if (type === 'PipeWire:Interface:Node' && existing?.type === 'PipeWire:Interface:Node') {
        const active = this._activeMoves.get(update.id);
        if (active && active.generation !== observerGeneration) {
          const nextSerial = Number(update.info?.props?.['object.serial']);
          const prevSerial = Number(existing.props?.['object.serial']);
          const nextClient = update.info?.props?.['client.id'];
          const nextName = update.info?.props?.['node.name'];
          const serialChanged = Number.isSafeInteger(nextSerial) &&
            Number.isSafeInteger(active.streamSerial) && nextSerial !== active.streamSerial;
          const ownerChanged = (nextClient !== undefined &&
              Number(nextClient) !== active.streamClientId) ||
            (nextName !== undefined && String(nextName) !== active.streamName);
          // Only treat it as reuse when the update actually carries identity
          // keys; benign prop updates must not invalidate.
          if ((Number.isSafeInteger(nextSerial) || nextClient !== undefined || nextName !== undefined) &&
              (serialChanged || ownerChanged ||
                (Number.isSafeInteger(nextSerial) && Number.isSafeInteger(prevSerial) && nextSerial !== prevSerial))) {
            active.invalidated = true;
          }
        }
      }
      const props = {
        ...(existing?.props || {}),
        ...(update.info?.props || {}),
      };
      this._objects.set(update.id, { type, props });
      return;
    }

    if (type === 'PipeWire:Interface:Link') {
      this._objects.set(update.id, {
        type,
        outputNode: update.info?.['output-node-id'] ?? existing?.outputNode,
        inputNode: update.info?.['input-node-id'] ?? existing?.inputNode,
      });
      return;
    }

    if (type !== 'PipeWire:Interface:Metadata') return;
    const props = { ...(existing?.props || {}), ...(update.props || {}) };
    this._objects.set(update.id, { type, props });
    if (props['metadata.name'] !== 'default') return;

    for (const entry of update.metadata || []) {
      const subject = Number(entry.subject);
      if (!Number.isSafeInteger(subject) || entry.key !== 'target.object') continue;
      const route = this._routes.get(subject);
      if (route) {
        if (Number(entry.value) !== route.combinedSerial) {
          route.externallyChanged = true;
        }
        continue;
      }
      if (this._routing.has(subject)) continue;
      if (entry.value === null || entry.value === undefined) {
        this._metadataTargets.delete(subject);
      } else {
        this._metadataTargets.set(subject, { type: entry.type, value: entry.value });
      }
    }
  }

  _removeObject(id, generation = this._generation) {
    const route = this._routes.get(id);
    if (route) {
      // Best-effort cleanup of a removed node. Skipped when stale: after a
      // stop/restart the same node id may belong to the new session, and our
      // `-d` would wipe the route it just created.
      if (generation === this._generation) {
        void this._runMetadata(['-n', 'default', '-d', String(id), 'target.object']).catch(() => false);
      }
      this._routes.delete(id);
    }
    this._routing.delete(id);
    this._metadataTargets.delete(id);
    this._objects.delete(id);
    // A removal observed by a newer session means an older session's in-flight
    // stream with the same ID is gone (or churned): its late repair must not
    // touch whatever reuses the ID afterwards.
    this._markStaleInvalid(id, generation);
  }

  async _routeEligibleStreams(generation = this._generation) {
    // Wait for any in-flight stop-restoration first: an old session's
    // `pw-metadata -d` must land before this session's move, never after.
    try { await this._pendingRestore; } catch {}
    if (generation !== this._generation) return;

    // Veto stale repairs from positive evidence in the current graph: if this
    // session observes an in-flight older ID with a different serial/owner,
    // the older stream was reused — its late repair must not touch the new
    // one, even across later stop() clears. Absence alone is not evidence
    // (the monitor may simply not have announced the node yet).
    for (const [id, active] of this._activeMoves) {
      if (active.generation === generation) continue;
      const live = this._objects.get(id);
      if (live?.type !== 'PipeWire:Interface:Node') continue;
      const liveSerial = Number(live.props['object.serial']);
      if (Number.isSafeInteger(active.streamSerial) && Number.isSafeInteger(liveSerial)) {
        if (liveSerial !== active.streamSerial) active.invalidated = true;
      } else if (Number(live.props['client.id']) !== Number(active.streamClientId) ||
          String(live.props['node.name'] || '') !== String(active.streamName || '')) {
        active.invalidated = true;
      }
    }

    const combinedSinkFor = () => [...this._objects.values()].find(object =>
      object.type === 'PipeWire:Interface:Node' &&
      object.props['node.name'] === this._combinedSinkName
    );
    let combinedSink = combinedSinkFor();
    let combinedSerial = Number(combinedSink?.props['object.serial']);
    if (!Number.isSafeInteger(combinedSerial) || combinedSerial <= 0) return;

    for (const [nodeId, node] of this._objects) {
      if (generation !== this._generation) return;
      if (node.type !== 'PipeWire:Interface:Node' ||
          node.props['media.class'] !== 'Stream/Output/Audio' ||
          this._routes.has(nodeId) || this._routing.has(nodeId)) continue;

      const nodeName = String(node.props['node.name'] || '');
      if (nodeName.startsWith(`output.${this._combinedSinkName}_`) ||
          node.props['node.virtual'] === true) continue;

      const clientId = Number(node.props['client.id']);
      const client = this._objects.get(clientId);
      const props = { ...(client?.props || {}), ...node.props };
      if (props['client.api'] === 'pipewire-pulse' || !this._isExternalStream(props)) continue;

      const originalSink = this._findLinkedSink(nodeId);
      const originalSerial = Number(originalSink?.props['object.serial']);
      if (!Number.isSafeInteger(originalSerial) || originalSerial <= 0 ||
          originalSink.props['node.name'] === this._combinedSinkName) continue;

      let previousTarget = this._metadataTargets.get(nodeId) || null;
      if (Number(previousTarget?.value) === combinedSerial) previousTarget = null;

      // Stream identity for ID-reuse safety (see wait below).
      const streamSerial = Number(node.props['object.serial']);
      const streamClientId = Number(node.props['client.id']);
      const streamName = String(node.props['node.name'] || '');

      // An older session may still have this node in flight (move or late
      // repair). Wait for it before moving so our move lands after its
      // repair, never before. Continuations run in attach order, so awaiting
      // the older promise guarantees its repair is already chained via
      // _pendingRestore by the time we proceed to await it below.
      const pending = this._activeMoves.get(nodeId);
      if (pending && pending.generation !== generation) {
        try { await pending.promise; } catch {}
        try { await this._pendingRestore; } catch {}
        if (generation !== this._generation) return;
        if (this._routes.has(nodeId) || this._routing.has(nodeId)) continue;
        // The graph may have changed while waiting: the ID may have been
        // removed or reused by a different (possibly own) stream. Re-fetch
        // and re-validate identity plus eligibility from scratch. A mismatch
        // against the older session's stream also invalidates its late
        // repair, which must survive later stop() clears (see repair).
        const freshNode = this._objects.get(nodeId);
        if (!freshNode || freshNode.type !== 'PipeWire:Interface:Node' ||
            freshNode.props['media.class'] !== 'Stream/Output/Audio') {
          pending.invalidated = true;
          continue;
        }
        const freshStreamSerial = Number(freshNode.props['object.serial']);
        const oldSerial = Number(pending.streamSerial);
        const oldMatches = Number.isSafeInteger(oldSerial) && Number.isSafeInteger(freshStreamSerial)
          ? freshStreamSerial === oldSerial
          : Number(freshNode.props['client.id']) === Number(pending.streamClientId) &&
            String(freshNode.props['node.name'] || '') === String(pending.streamName || '');
        if (!oldMatches) {
          pending.invalidated = true;
          continue;
        }
        if (Number.isSafeInteger(streamSerial) && Number.isSafeInteger(freshStreamSerial)) {
          if (freshStreamSerial !== streamSerial) continue;
        } else if (Number(freshNode.props['client.id']) !== streamClientId ||
            String(freshNode.props['node.name'] || '') !== streamName) {
          continue;
        }
        const freshName = String(freshNode.props['node.name'] || '');
        if (freshName.startsWith(`output.${this._combinedSinkName}_`) ||
            freshNode.props['node.virtual'] === true) continue;
        const freshClientId = Number(freshNode.props['client.id']);
        const freshClient = this._objects.get(freshClientId);
        const freshProps = { ...(freshClient?.props || {}), ...freshNode.props };
        if (freshProps['client.api'] === 'pipewire-pulse' ||
            !this._isExternalStream(freshProps)) continue;
        // The graph may have been rebuilt while waiting; re-validate targets.
        combinedSink = combinedSinkFor();
        combinedSerial = Number(combinedSink?.props['object.serial']);
        if (!Number.isSafeInteger(combinedSerial) || combinedSerial <= 0) return;
        const freshSink = this._findLinkedSink(nodeId);
        const freshSerial = Number(freshSink?.props['object.serial']);
        if (!Number.isSafeInteger(freshSerial) || freshSerial <= 0 ||
            freshSink.props['node.name'] === this._combinedSinkName) continue;
        if (freshSerial !== originalSerial) continue;
        previousTarget = this._metadataTargets.get(nodeId) || null;
        if (Number(previousTarget?.value) === combinedSerial) previousTarget = null;
      }

      this._routing.add(nodeId);
      let moved = false;
      let movePromise = null;
      try {
        movePromise = this._runMetadata([
          '-n', 'default', String(nodeId), 'target.object', String(combinedSerial), 'Spa:Id',
        ]);
        this._activeMoves.set(nodeId, {
          promise: movePromise,
          generation,
          streamSerial,
          streamClientId,
          streamName,
        });
        moved = await movePromise;
      } finally {
        this._routing.delete(nodeId);
      }
      // The session may have ended while pw-metadata was in flight. The move
      // itself may still have landed, so queue a best-effort restore that
      // returns the stream to its previous target instead of leaving it
      // hijacked. The repair is chained via _pendingRestore and skips when a
      // newer session already owns the node, so it can neither wipe a route
      // the new session just created nor publish a route for a dead session.
      // The _activeMoves entry is kept until the repair finishes so a newer
      // session waits for both instead of racing the restore.
      if (generation !== this._generation) {
        if (moved && !this._routes.has(nodeId)) {
          const orphanRoute = {
            originalSerial,
            previousTarget,
            combinedSerial,
            streamSerial,
            streamClientId,
            streamName,
            externallyChanged: false,
          };
          // Identity at stop() time, if the move was still in flight then.
          // stop() snapshots before clearing _objects, so a removal/reuse
          // already announced still protects the repair after the clear.
          // Invalidations observed by later sessions (removal/reuse while
          // waiting, or removal deltas) are carried over and re-checked
          // inside the task, so a second stop() clearing the graph cannot
          // resurrect a blind restore.
          const activeAtCompletion = this._activeMoves.get(nodeId);
          const sameEntry = activeAtCompletion?.generation === generation ? activeAtCompletion : undefined;
          const atStop = sameEntry?.atStop;
          const invalidatedAtCreation = sameEntry?.invalidated === true;
          const repair = (async () => {
            try {
              const previous = this._pendingRestore;
              const task = previous.then(async () => {
                if (this._routes.has(nodeId)) return true;
                // New evidence wins over an old snapshot: any session that
                // observed removal/reuse of this ID vetoes the blind repair,
                // even if a later stop() cleared the graph afterwards.
                if (invalidatedAtCreation) return true;
                if (this._activeMoves.get(nodeId)?.invalidated === true) return true;
                // If the graph at stop() already showed a different stream
                // (or no stream) for this ID, the original is gone: never
                // restore blindly after the clear.
                if (atStop) {
                  if (!atStop.present) return true;
                  if (Number.isSafeInteger(streamSerial) && Number.isSafeInteger(atStop.serial)) {
                    if (atStop.serial !== streamSerial) return true;
                  } else if (atStop.clientId !== streamClientId || atStop.name !== streamName) {
                    return true;
                  }
                }
                // Bind the repair to the original stream: if the numeric ID
                // was reused by a different (possibly own) stream meanwhile,
                // leave it alone instead of moving someone else's audio.
                const live = this._objects.get(nodeId);
                if (live?.type === 'PipeWire:Interface:Node') {
                  const liveSerial = Number(live.props['object.serial']);
                  if (Number.isSafeInteger(streamSerial) && Number.isSafeInteger(liveSerial)) {
                    if (liveSerial !== streamSerial) return true;
                  } else if (Number(live.props['client.id']) !== streamClientId ||
                      String(live.props['node.name'] || '') !== streamName) {
                    return true;
                  }
                  const liveClient = this._objects.get(Number(live.props['client.id']));
                  const liveProps = { ...(liveClient?.props || {}), ...live.props };
                  if (!this._isExternalStream(liveProps)) return true;
                }
                return this._restoreRoute(nodeId, orphanRoute);
              }).catch(() => false);
              this._pendingRestore = task;
              task.catch(() => {});
              return await task;
            } finally {
              const current = this._activeMoves.get(nodeId);
              if (current?.generation === generation) this._activeMoves.delete(nodeId);
            }
          })();
          this._activeMoves.set(nodeId, {
            promise: repair,
            generation,
            streamSerial,
            streamClientId,
            streamName,
            invalidated: invalidatedAtCreation === true ? true : undefined,
          });
        } else {
          const current = this._activeMoves.get(nodeId);
          if (current?.generation === generation) this._activeMoves.delete(nodeId);
        }
        return;
      }
      const current = this._activeMoves.get(nodeId);
      if (current?.generation === generation) this._activeMoves.delete(nodeId);
      if (moved) this._routes.set(nodeId, {
        originalSerial,
        previousTarget,
        combinedSerial,
        streamSerial,
        streamClientId,
        streamName,
        externallyChanged: false,
      });
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
    if (!route.previousTarget) {
      const restored = await this._runMetadata([
        '-n', 'default', String(nodeId), 'target.object', String(route.originalSerial), 'Spa:Id',
      ]);
      const released = await this._runMetadata(['-n', 'default', '-d', String(nodeId), 'target.object']);
      return restored && released;
    }

    const { type = 'Spa:Id', value } = route.previousTarget;
    return this._runMetadata([
      '-n', 'default', String(nodeId), 'target.object', metadataValue(value, type), type,
    ]);
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
