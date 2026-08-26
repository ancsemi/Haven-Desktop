const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

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
    if (commandEnd < 0) return 0;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : 0;
  } catch {
    return 0;
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

function metadataValue(value, type) {
  if (typeof value === 'string') return value;
  if (type === 'Spa:String:JSON') return JSON.stringify(value);
  return String(value);
}

class PipeWireStreamRouter {
  constructor({
    spawnProcess = spawn,
    runCommand = spawnSync,
    processInTree = isProcessInTree,
    logger = console,
  } = {}) {
    this._spawnProcess = spawnProcess;
    this._runCommand = runCommand;
    this._processInTree = processInTree;
    this._logger = logger;
    this._monitor = null;
    this._objects = new Map();
    this._metadataTargets = new Map();
    this._routes = new Map();
    this._routing = new Set();
    this._warnedMetadata = false;
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
    const monitor = this._monitor;
    this._monitor = null;
    if (monitor) {
      try { monitor.kill(); } catch {}
    }

    const failedRoutes = [];
    for (const [nodeId, route] of this._routes) {
      if (!this._restoreRoute(nodeId, route) && !this._restoreRoute(nodeId, route)) {
        failedRoutes.push(nodeId);
      }
    }
    if (failedRoutes.length) {
      this._logger.warn(
        `[ScreenShare] Could not restore PipeWire stream route(s): ${failedRoutes.join(', ')}`
      );
    }
    this._objects.clear();
    this._metadataTargets.clear();
    this._routes.clear();
    this._routing.clear();
    this._warnedMetadata = false;
  }

  _handleBatch(batch) {
    if (!Array.isArray(batch)) return;

    for (const update of batch) {
      if (!Number.isSafeInteger(update?.id)) continue;
      if (update.info === null) {
        this._removeObject(update.id);
        continue;
      }
      this._updateObject(update);
    }
    this._routeEligibleStreams();
  }

  _updateObject(update) {
    const existing = this._objects.get(update.id);
    const type = update.type || existing?.type;

    if (type === 'PipeWire:Interface:Client' || type === 'PipeWire:Interface:Node') {
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
      if (this._routes.has(subject) || this._routing.has(subject)) continue;
      if (entry.value === null || entry.value === undefined) {
        this._metadataTargets.delete(subject);
      } else {
        this._metadataTargets.set(subject, { type: entry.type, value: entry.value });
      }
    }
  }

  _removeObject(id) {
    const route = this._routes.get(id);
    if (route) {
      this._runMetadata(['-n', 'default', '-d', String(id), 'target.object']);
      this._routes.delete(id);
    }
    this._routing.delete(id);
    this._metadataTargets.delete(id);
    this._objects.delete(id);
  }

  _routeEligibleStreams() {
    const combinedSink = [...this._objects.values()].find(object =>
      object.type === 'PipeWire:Interface:Node' &&
      object.props['node.name'] === this._combinedSinkName
    );
    const combinedSerial = Number(combinedSink?.props['object.serial']);
    if (!Number.isSafeInteger(combinedSerial) || combinedSerial <= 0) return;

    for (const [nodeId, node] of this._objects) {
      if (node.type !== 'PipeWire:Interface:Node' ||
          node.props['media.class'] !== 'Stream/Output/Audio' ||
          this._routes.has(nodeId) || this._routing.has(nodeId)) continue;

      const nodeName = String(node.props['node.name'] || '');
      if (nodeName.startsWith(`output.${this._combinedSinkName}_`) ||
          node.props['node.virtual'] === true) continue;

      const clientId = Number(node.props['client.id']);
      const client = this._objects.get(clientId);
      const props = { ...(client?.props || {}), ...node.props };
      if (props['client.api'] === 'pipewire-pulse' || this._isOwnStream(props)) continue;
      if (!props['application.process.id'] && !props['application.name']) continue;

      const originalSink = this._findLinkedSink(nodeId);
      const originalSerial = Number(originalSink?.props['object.serial']);
      if (!Number.isSafeInteger(originalSerial) || originalSerial <= 0 ||
          originalSink.props['node.name'] === this._combinedSinkName) continue;

      let previousTarget = this._metadataTargets.get(nodeId) || null;
      if (Number(previousTarget?.value) === combinedSerial) previousTarget = null;
      this._routing.add(nodeId);
      const moved = this._runMetadata([
        '-n', 'default', String(nodeId), 'target.object', String(combinedSerial), 'Spa:Id',
      ]);
      this._routing.delete(nodeId);
      if (moved) this._routes.set(nodeId, { originalSerial, previousTarget });
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

  _isOwnStream(props) {
    const access = String(props['pipewire.access.effective'] || props['pipewire.access'] || '');
    const securePid = Number(props['pipewire.sec.pid']);
    if (access.includes('flatpak')) {
      return this._processInTree(securePid, this._rootPid);
    }

    const processIds = [
      Number(props['application.process.id']),
      securePid,
    ];
    return processIds.some(pid => this._processInTree(pid, this._rootPid));
  }

  _restoreRoute(nodeId, route) {
    if (!route.previousTarget) {
      const restored = this._runMetadata([
        '-n', 'default', String(nodeId), 'target.object', String(route.originalSerial), 'Spa:Id',
      ]);
      const released = this._runMetadata(['-n', 'default', '-d', String(nodeId), 'target.object']);
      return restored && released;
    }

    const { type = 'Spa:Id', value } = route.previousTarget;
    return this._runMetadata([
      '-n', 'default', String(nodeId), 'target.object', metadataValue(value, type), type,
    ]);
  }

  _runMetadata(args) {
    try {
      const result = this._runCommand('pw-metadata', args, {
        encoding: 'utf8',
        timeout: 500,
        windowsHide: true,
      });
      if (!result?.error && (result?.status === 0 || result?.status === undefined)) return true;
      if (!this._warnedMetadata) {
        const detail = result?.error?.message || String(result?.stderr || '').trim() || 'command failed';
        this._logger.warn(`[ScreenShare] Could not route native PipeWire audio: ${detail}`);
        this._warnedMetadata = true;
      }
    } catch (err) {
      if (!this._warnedMetadata) {
        this._logger.warn(`[ScreenShare] Could not route native PipeWire audio: ${err.message}`);
        this._warnedMetadata = true;
      }
    }
    return false;
  }
}

module.exports = {
  PipeWireStreamRouter,
  createJsonArrayParser,
  isProcessInTree,
};
