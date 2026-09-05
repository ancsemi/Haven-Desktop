'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PROTOCOL_VERSION = 3;
const MAX_ACTIVE_PEERS = 32;
const MAX_PEER_GENERATIONS = 256;
const MAX_SDP_SIZE = 49152;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NEGOTIATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SOURCE_KINDS = new Set([
  'linux-x11-screen',
  'linux-x11-window',
  'linux-pipewire',
  'windows-monitor',
  'windows-window',
  'test',
]);

function encodeField(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeField(value) {
  return Buffer.from(String(value || ''), 'base64').toString('utf8');
}

function firstIceServer(iceServers, prefix) {
  for (const server of Array.isArray(iceServers) ? iceServers : []) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    const url = urls.find(candidate => typeof candidate === 'string' && candidate.startsWith(prefix));
    if (url) {
      return {
        url,
        username: typeof server.username === 'string' ? server.username : '',
        credential: typeof server.credential === 'string' ? server.credential : '',
      };
    }
  }
  return { url: '', username: '', credential: '' };
}

function turnIceServers(iceServers) {
  const result = [];
  for (const server of Array.isArray(iceServers) ? iceServers : []) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    for (const url of urls) {
      if (typeof url !== 'string' || !/^turns?:/.test(url)) continue;
      result.push({
        url,
        username: typeof server.username === 'string' ? server.username : '',
        credential: typeof server.credential === 'string' ? server.credential : '',
      });
      if (result.length >= 16) return result;
    }
  }
  return result;
}

function encodeTurnServers(servers) {
  return servers.map(server => [server.url, server.username, server.credential]
    .map(encodeField).join(',')).join(';');
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.round(number) : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

class NativeScreenManager {
  constructor(options = {}) {
    this._selectSource = options.selectSource;
    this._spawn = options.spawn || spawn;
    this._execFile = options.execFile || (options.spawnSync
      ? (file, args, execOptions, callback) => {
          const result = options.spawnSync(file, args, execOptions);
          const error = result.error || (result.status
            ? Object.assign(new Error(`native helper exited (${result.status})`), {
                code: result.status,
              })
            : null);
          queueMicrotask(() => callback(error, result.stdout || '', result.stderr || ''));
        }
      : execFile);
    this._existsSync = options.existsSync || fs.existsSync;
    this._resourcesPath = options.resourcesPath || process.resourcesPath || '';
    this._projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
    this._platform = options.platform || process.platform;
    this._env = options.env || process.env;
    this._registryPath = options.registryPath || '';
    this._helperPath = options.helperPath || null;
    this._isOwnerActive = options.isOwnerActive || (() => true);
    this._getAudioCapabilities = options.getAudioCapabilities || (() => ({
      supported: false,
      modes: [],
    }));
    this._startAudioCapture = options.startAudioCapture || null;
    this._stopAudioCapture = options.stopAudioCapture || null;
    this._session = null;
    this._starting = false;
    this._pendingStart = null;
    this._capabilities = null;
    this._probePromise = null;
  }

  getCapabilities() {
    if (this._capabilities) return Promise.resolve(this._capabilities);
    if (this._probePromise) return this._probePromise;
    this._probePromise = this._probeCapabilities()
      .then(capabilities => {
        if (capabilities.supported) this._capabilities = capabilities;
        return capabilities;
      })
      .finally(() => { this._probePromise = null; });
    return this._probePromise;
  }

  async _probeCapabilities() {
    const finish = capabilities => capabilities;
    if (!['linux', 'win32'].includes(this._platform)) {
      return finish({ supported: false, reason: 'unsupported-platform' });
    }

    const helperPath = this._findHelperPath();
    if (!helperPath) return finish({ supported: false, reason: 'native-helper-unavailable' });

    let result;
    try {
      result = await new Promise(resolve => {
        this._execFile(helperPath, ['--probe'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          env: this._helperEnv(),
        }, (error, stdout, stderr) => {
          resolve({
            error: error && typeof error.code !== 'number' ? error : null,
            status: error && typeof error.code === 'number' ? error.code : 0,
            stdout,
            stderr,
          });
        });
      });
    } catch (err) {
      return finish({ supported: false, reason: 'native-helper-probe-failed', detail: err.message });
    }

    if (result.error) {
      return finish({
        supported: false,
        reason: 'native-helper-probe-failed',
        detail: result.error.message,
      });
    }

    let capabilities;
    try {
      capabilities = JSON.parse(String(result.stdout || '').trim());
    } catch {
      return finish({
        supported: false,
        reason: result.status === 0
          ? 'native-helper-protocol-error'
          : 'native-helper-probe-failed',
        detail: String(result.stderr || '').trim() || undefined,
      });
    }

    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      return finish({ supported: false, reason: 'native-helper-protocol-error' });
    }
    if (capabilities.protocolVersion !== PROTOCOL_VERSION) {
      return finish({
        ...capabilities,
        supported: false,
        reason: 'native-helper-protocol-mismatch',
      });
    }
    if (!capabilities.supported) {
      return finish({
        ...capabilities,
        supported: false,
        reason: capabilities.reason || 'native-helper-unsupported',
      });
    }
    if (result.status !== 0) {
      return finish({
        ...capabilities,
        supported: false,
        reason: 'native-helper-probe-failed',
        detail: String(result.stderr || '').trim() || undefined,
      });
    }

    const backends = Array.isArray(capabilities.captureBackends)
      ? capabilities.captureBackends
      : [];
    const wayland = this._platform === 'linux' &&
      String(this._env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
    if (wayland && !backends.includes('pipewire-portal')) {
      return finish({ ...capabilities, supported: false, reason: 'wayland-portal-unavailable' });
    }

    const codecs = Array.isArray(capabilities.codecs)
      ? capabilities.codecs.filter(codec =>
          codec && ['H264', 'AV1', 'H265'].includes(codec.name) &&
          typeof codec.encoder === 'string' && codec.encoder.length <= 64
        )
      : [];
    if (!codecs.some(codec => codec.name === 'H264')) {
      return finish({
        ...capabilities,
        codecs,
        supported: false,
        reason: 'native-h264-unavailable',
      });
    }
    let audio = { supported: false, modes: [] };
    try {
      const hostAudio = this._getAudioCapabilities() || {};
      const helperAudio = capabilities.audio || {};
      const helperFormatSupported = helperAudio.supported === true &&
        helperAudio.codec === 'OPUS' && helperAudio.sampleRate === 48000 &&
        helperAudio.channels === 1;
      const modes = helperFormatSupported && Array.isArray(hostAudio.modes)
        ? hostAudio.modes.filter(mode => mode === 'application' || mode === 'system')
        : [];
      audio = {
        supported: hostAudio.supported === true && modes.length > 0,
        modes,
        codec: helperAudio.codec === 'OPUS' ? 'OPUS' : null,
        sampleRate: helperAudio.sampleRate === 48000 ? 48000 : null,
        channels: helperAudio.channels === 1 ? 1 : null,
      };
    } catch {}

    return finish({ ...capabilities, codecs, audio });
  }

  async start(owner, options = {}) {
    if (!owner || owner.isDestroyed?.()) return { started: false, reason: 'invalid-owner' };
    if (this._starting) return { started: false, reason: 'native-screen-start-pending' };
    this._starting = true;
    options = options && typeof options === 'object' ? options : {};
    const pending = { owner, controller: new AbortController() };
    this._pendingStart = pending;
    const invalidateOwner = () => pending.controller.abort();
    const invalidateNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame !== false) invalidateOwner();
    };
    const ownerListeners = [
      ['destroyed', invalidateOwner],
      ['render-process-gone', invalidateOwner],
      ['did-start-navigation', invalidateNavigation],
    ];
    for (const [event, listener] of ownerListeners) owner.on?.(event, listener);
    try {
      return await this._start(owner, options, pending.controller);
    } finally {
      for (const [event, listener] of ownerListeners) {
        owner.removeListener?.(event, listener);
      }
      if (this._pendingStart === pending) this._pendingStart = null;
      this._starting = false;
    }
  }

  async _start(owner, options, controller) {
    const { signal } = controller;
    if (typeof this._selectSource !== 'function') {
      return { started: false, reason: 'source-selector-unavailable' };
    }

    const capabilities = await this.getCapabilities();
    if (signal.aborted) {
      return { started: false, cancelled: true, reason: 'native-screen-start-cancelled' };
    }
    if (!capabilities.supported) return { started: false, reason: capabilities.reason };
    if (owner.isDestroyed?.() || !this._isOwnerActive(owner)) {
      return { started: false, reason: 'inactive-view' };
    }
    if (this._session) {
      if (this._session.owner !== owner) {
        return { started: false, reason: 'native-screen-owned-by-another-view' };
      }
      await this.stop(owner);
    }

    const source = await this._selectSource(owner, capabilities, signal, options);
    if (signal.aborted) {
      return { started: false, cancelled: true, reason: 'native-screen-start-cancelled' };
    }
    if (owner.isDestroyed?.() || !this._isOwnerActive(owner)) {
      return { started: false, reason: 'inactive-view' };
    }
    if (!source) return { started: false, cancelled: true };
    if (!SOURCE_KINDS.has(source.kind)) return { started: false, reason: 'unsupported-source' };

    const availableCodecs = capabilities.codecs.map(codec => codec.name);
    const allowedCodecs = Array.isArray(options.codecs)
      ? options.codecs.map(codec => String(codec).toUpperCase())
          .filter(codec => availableCodecs.includes(codec))
      : availableCodecs;
    const requestedCodec = String(source.codecPreference || options.codecPreference || 'AUTO').toUpperCase();
    const codec = requestedCodec !== 'AUTO' && allowedCodecs.includes(requestedCodec)
      ? requestedCodec
      : ['H264', 'AV1', 'H265'].find(candidate => allowedCodecs.includes(candidate));
    if (!codec) return { started: false, reason: 'native-codec-unavailable' };

    const requestedAudio = source.audio && typeof source.audio === 'object'
      ? source.audio
      : null;
    const audioMode = requestedAudio?.mode === 'include' || requestedAudio?.mode === 'exclude'
      ? requestedAudio.mode
      : 'none';
    const audioPid = Number(requestedAudio?.pid);
    const hasAudio = capabilities.audio?.supported === true && audioMode !== 'none' &&
      Number.isSafeInteger(audioPid) && audioPid > 0 &&
      typeof this._startAudioCapture === 'function';

    const helperPath = this._findHelperPath();
    if (!helperPath) return { started: false, reason: 'native-helper-unavailable' };

    const sessionId = crypto.randomBytes(15).toString('base64url');
    let child;
    try {
      child = this._spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this._helperEnv(),
      });
    } catch (err) {
      return { started: false, reason: 'native-helper-spawn-failed', detail: err.message };
    }
    const session = {
      id: sessionId,
      owner,
      child,
      peers: new Set(),
      peerAdds: 0,
      peerNegotiations: new Map(),
      stdoutBuffer: '',
      stopping: false,
      readyResolve: null,
      readyReject: null,
      stoppedResolve: null,
      stopPromise: null,
      audioInput: child.stdio?.[3] || null,
      audioStarted: false,
      audioBackpressured: false,
    };
    this._session = session;
    this._wireProcess(session);
    this._wireOwner(session);

    let startupTimer;
    try {
      const ready = new Promise((resolve, reject) => {
        session.readyResolve = resolve;
        session.readyReject = reject;
      });
      ready.catch(() => {});
      const stun = firstIceServer(options.iceServers, 'stun:');
      const turnServers = turnIceServers(options.iceServers);
      this._send(session, 'START', [
        sessionId,
        source.kind,
        source.handle || '',
        boundedInteger(source.x, 0, -100000, 100000),
        boundedInteger(source.y, 0, -100000, 100000),
        boundedInteger(source.width, 0, 0, 16384),
        boundedInteger(source.height, 0, 0, 16384),
        boundedInteger(options.resolution, 0, 0, 4320),
        boundedInteger(options.frameRate, 30, 1, 120),
        boundedInteger(options.bitrate, 8000000, 250000, 50000000),
        options.iceTransportPolicy === 'relay' ? 'relay' : 'all',
        stun.url,
        encodeTurnServers(turnServers),
        codec,
        hasAudio ? '1' : '0',
      ]);
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          const timeout = source.kind === 'linux-pipewire' ? 125000 : 10000;
          startupTimer = setTimeout(() => reject(new Error('native helper startup timed out')), timeout);
        }),
      ]);
      if (this._session !== session) throw new Error('native helper exited during startup');
      if (owner.isDestroyed?.() || !this._isOwnerActive(owner)) {
        await this.stop(owner, true);
        return { started: false, reason: 'inactive-view' };
      }
      if (hasAudio) {
        session.audioInput?.on?.('drain', () => {
          if (this._session === session) session.audioBackpressured = false;
        });
        session.audioStarted = true;
        const audioStarted = await Promise.resolve(this._startAudioCapture(
          { mode: audioMode, pid: audioPid, sessionId: session.id, owner },
          samples => this._writeAudio(session, samples),
          status => this._handleAudioStatus(session, status)
        ));
        if (!audioStarted) throw new Error('Native screen audio capture failed to start');
        if (this._session !== session) {
          throw new Error('Native screen audio capture failed during startup');
        }
        if (owner.isDestroyed?.() || !this._isOwnerActive(owner)) {
          await this.stop(owner, true);
          return { started: false, reason: 'inactive-view' };
        }
      }
      return { started: true, sessionId, codec, hasAudio };
    } catch (err) {
      if (this._session === session) {
        await this.stop(owner, true);
      } else {
        try { session.child.kill(); } catch {}
      }
      return {
        started: false,
        reason: 'native-helper-start-failed',
        detail: err.message,
        cancelled: /cancelled/i.test(String(err.message || '')),
      };
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
  }

  async stop(owner, force = false, expectedSessionId = null) {
    const session = this._session;
    if (!session) {
      if (expectedSessionId) return false;
      const pending = this._pendingStart;
      if (pending && (force || pending.owner === owner)) pending.controller.abort();
      return true;
    }
    this._assertOwner(owner, session, force);
    if (expectedSessionId && expectedSessionId !== session.id) return false;
    if (session.stopPromise) return session.stopPromise;

    session.stopping = true;
    session.readyReject?.(new Error('Native screen startup cancelled'));
    session.readyResolve = null;
    session.readyReject = null;
    session.stopPromise = (async () => {
      this._stopAudio(session);
      const stopped = new Promise(resolve => { session.stoppedResolve = resolve; });
      let sent = false;
      try {
        this._send(session, 'STOP', [session.id]);
        sent = true;
      } catch {}
      let stopTimer;
      if (sent) {
        await Promise.race([
          stopped,
          new Promise(resolve => { stopTimer = setTimeout(resolve, 1500); }),
        ]);
      }
      if (stopTimer) clearTimeout(stopTimer);
      if (this._session === session) {
        this._detachOwner(session);
        try { session.child.kill(); } catch {}
        this._session = null;
      }
      return true;
    })();
    return session.stopPromise;
  }

  async addPeer(owner, data = {}) {
    const session = this._requireSession(owner, data);
    const peerId = this._validPeerId(data.peerId);
    if (session.peers.has(peerId)) return true;
    if (session.peers.size >= MAX_ACTIVE_PEERS) {
      throw new Error('Native screen peer limit reached');
    }
    if (session.peerAdds >= MAX_PEER_GENERATIONS) {
      throw new Error('Native screen peer generation limit reached');
    }
    session.peerAdds++;
    session.peers.add(peerId);
    this._send(session, 'ADD_PEER', [session.id, peerId]);
    return true;
  }

  async removePeer(owner, data = {}) {
    const session = this._requireSession(owner, data);
    const peerId = this._validPeerId(data.peerId);
    session.peers.delete(peerId);
    session.peerNegotiations.delete(peerId);
    this._send(session, 'REMOVE_PEER', [session.id, peerId]);
    return true;
  }

  async setRemoteDescription(owner, data = {}) {
    const session = this._requireSession(owner, data);
    const peerId = this._validPeerId(data.peerId);
    this._requireNegotiation(session, peerId, data.negotiationId);
    const description = data.description;
    if (!description || description.type !== 'answer' || typeof description.sdp !== 'string' ||
        Buffer.byteLength(description.sdp, 'utf8') > MAX_SDP_SIZE) {
      throw new Error('Invalid native screen answer');
    }
    this._send(session, 'REMOTE_DESCRIPTION', [session.id, peerId, 'answer', description.sdp]);
    return true;
  }

  async addIceCandidate(owner, data = {}) {
    const session = this._requireSession(owner, data);
    const peerId = this._validPeerId(data.peerId);
    this._requireNegotiation(session, peerId, data.negotiationId);
    const candidate = data.candidate;
    if (candidate == null) {
      this._send(session, 'ICE', [session.id, peerId, '', '', '', '', '1']);
      return true;
    }
    if (typeof candidate !== 'object' || typeof candidate.candidate !== 'string' ||
        candidate.candidate.length > 2048) {
      throw new Error('Invalid native screen ICE candidate');
    }
    this._send(session, 'ICE', [
      session.id,
      peerId,
      candidate.candidate,
      candidate.sdpMid || '',
      Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : '',
      candidate.usernameFragment || '',
      '0',
    ]);
    return true;
  }

  cleanup() {
    this._pendingStart?.controller.abort();
    if (!this._session) return;
    const session = this._session;
    this._stopAudio(session);
    session.readyReject?.(new Error('Native screen owner was destroyed'));
    session.readyResolve = null;
    session.readyReject = null;
    this._detachOwner(session);
    try { session.child.kill(); } catch {}
    this._session = null;
  }

  _findHelperPath() {
    const binary = this._platform === 'win32' ? 'haven_screen_share.exe' : 'haven_screen_share';
    const candidates = [
      this._helperPath,
      this._resourcesPath && path.join(this._resourcesPath, 'native', binary),
      path.join(this._projectRoot, 'native', 'build', 'Release', binary),
    ].filter(Boolean);
    return candidates.find(candidate => this._existsSync(candidate)) || null;
  }

  _helperEnv() {
    const env = {
      ...this._env,
      GST_XINITTHREADS: '1',
      HAVEN_NATIVE_SCREEN_PROTOCOL: String(PROTOCOL_VERSION),
    };
    const runtimeCandidates = [
      this._resourcesPath && path.join(this._resourcesPath, 'native', 'gstreamer'),
      path.join(this._projectRoot, 'native', 'runtime', 'gstreamer'),
    ].filter(Boolean);
    const runtime = runtimeCandidates.find(candidate => this._existsSync(candidate));
    if (!runtime || !this._existsSync(runtime)) return env;

    const plugins = path.join(runtime, 'plugins');
    const scanner = path.join(
      runtime,
      'libexec',
      this._platform === 'win32' ? 'gst-plugin-scanner.exe' : 'gst-plugin-scanner'
    );
    env.GST_PLUGIN_PATH_1_0 = plugins;
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = plugins;
    env.GST_PLUGIN_SCANNER_1_0 = scanner;
    if (this._registryPath) env.GST_REGISTRY_1_0 = this._registryPath;
    if (this._platform === 'win32') {
      env.PATH = `${path.join(runtime, 'bin')}${path.delimiter}${env.PATH || ''}`;
    } else {
      env.LD_LIBRARY_PATH = `${path.join(runtime, 'lib')}${path.delimiter}${env.LD_LIBRARY_PATH || ''}`;
    }
    return env;
  }

  _wireProcess(session) {
    session.child.stdout.setEncoding('utf8');
    session.child.stderr.setEncoding('utf8');
    session.child.stdout.on('data', chunk => {
      session.stdoutBuffer += chunk;
      let newline;
      while ((newline = session.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
        if (line) this._handleLine(session, line);
      }
    });
    session.child.stderr.on('data', chunk => {
      const message = String(chunk || '').trim();
      if (message) console.warn('[NativeScreen helper]', message);
    });
    const handleStreamError = err => this._handleProcessEnd(session, null, null, err);
    for (const stream of [
      session.child.stdin,
      session.child.stdout,
      session.child.stderr,
      session.audioInput,
    ]) {
      stream?.on?.('error', handleStreamError);
    }
    session.child.on('error', err => this._handleProcessEnd(session, null, null, err));
    session.child.on('exit', (code, signal) => this._handleProcessEnd(session, code, signal));
  }

  _wireOwner(session) {
    const endSession = () => {
      if (this._session === session) this.cleanup();
    };
    const navigate = (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame !== false) endSession();
    };
    session.ownerListeners = [
      ['destroyed', endSession],
      ['render-process-gone', endSession],
      ['did-start-navigation', navigate],
    ];
    for (const [event, listener] of session.ownerListeners) {
      session.owner.on?.(event, listener);
    }
  }

  _detachOwner(session) {
    for (const [event, listener] of session.ownerListeners || []) {
      session.owner.removeListener?.(event, listener);
    }
    session.ownerListeners = [];
  }

  _handleLine(session, line) {
    if (this._session !== session) return;
    const fields = line.split('\t');
    const event = fields.shift();
    const values = fields.map(decodeField);
    if (values[0] !== session.id) return;

    if (event === 'READY') {
      session.readyResolve?.();
      session.readyResolve = null;
      session.readyReject = null;
      return;
    }
    if (event === 'STOPPED') {
      session.stoppedResolve?.();
      return;
    }
    if (event === 'OFFER') {
      const [, peerId, sdp] = values;
      if (!session.peers.has(peerId)) return;
      const negotiationId = crypto.randomBytes(15).toString('base64url');
      session.peerNegotiations.set(peerId, negotiationId);
      this._emitSignal(session, {
        type: 'offer',
        sessionId: session.id,
        negotiationId,
        peerId: Number(peerId),
        description: { type: 'offer', sdp },
      });
      return;
    }
    if (event === 'ICE') {
      const [, peerId, candidate, sdpMid, sdpMLineIndex, usernameFragment, end] = values;
      const negotiationId = session.peerNegotiations.get(peerId);
      if (!negotiationId) return;
      this._emitSignal(session, {
        type: 'ice-candidate',
        sessionId: session.id,
        negotiationId,
        peerId: Number(peerId),
        candidate: end === '1' ? null : {
          candidate,
          sdpMid: sdpMid || null,
          sdpMLineIndex: sdpMLineIndex === '' ? null : Number(sdpMLineIndex),
          usernameFragment: usernameFragment || null,
        },
      });
      return;
    }
    if (event === 'ERROR') {
      const [, peerId, message, fatal] = values;
      const failedDuringStartup = fatal === '1' && !!session.readyReject;
      if (failedDuringStartup) {
        session.readyReject(new Error(message || 'Native screen helper failed to start'));
        session.readyResolve = null;
        session.readyReject = null;
      }
      this._emitSignal(session, {
        type: 'error',
        sessionId: session.id,
        peerId: peerId ? Number(peerId) : null,
        message,
        fatal: fatal === '1',
      });
      if (fatal === '1' && !failedDuringStartup && this._session === session) {
        this._stopAudio(session);
        session.stoppedResolve?.();
        this._detachOwner(session);
        this._session = null;
        try { session.child.kill(); } catch {}
      }
    }
  }

  _handleProcessEnd(session, code, signal, error = null) {
    if (this._session !== session) return;
    this._stopAudio(session);
    session.readyReject?.(error || new Error(`native helper exited (${code ?? signal ?? 'unknown'})`));
    session.readyResolve = null;
    session.readyReject = null;
    session.stoppedResolve?.();
    this._detachOwner(session);
    this._session = null;
    if (error) {
      try { session.child.kill(); } catch {}
    }
    if (!session.stopping) {
      this._emitSignal(session, {
        type: 'error',
        sessionId: session.id,
        peerId: null,
        message: error?.message || `Native screen helper exited unexpectedly (${code ?? signal ?? 'unknown'})`,
        fatal: true,
      });
    }
  }

  _send(session, command, fields) {
    if (!session.child.stdin.writable) throw new Error('Native screen helper is not writable');
    session.child.stdin.write([command, ...fields.map(encodeField)].join('\t') + '\n');
  }

  _writeAudio(session, samples) {
    if (this._session !== session || !session.audioInput?.writable ||
        session.audioBackpressured || !samples) return;
    let bytes;
    if (samples instanceof Float32Array) {
      bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    } else if (ArrayBuffer.isView(samples)) {
      bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    } else if (samples instanceof ArrayBuffer) {
      bytes = Buffer.from(samples);
    } else {
      return;
    }
    if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) return;
    try {
      session.audioBackpressured = !session.audioInput.write(bytes);
    } catch (err) {
      this._handleProcessEnd(session, null, null, err);
    }
  }

  _handleAudioStatus(session, status) {
    if (this._session !== session || session.stopping || !status || status.kind !== 'failed') return;
    this._emitSignal(session, {
      type: 'error',
      sessionId: session.id,
      peerId: null,
      message: status.message || 'Native screen audio capture failed',
      fatal: true,
    });
    this._stopAudio(session);
    session.stoppedResolve?.();
    this._detachOwner(session);
    this._session = null;
    try { session.child.kill(); } catch {}
  }

  _stopAudio(session) {
    if (!session || (!session.audioStarted && !session.audioInput)) return;
    const wasStarted = session.audioStarted;
    session.audioStarted = false;
    session.audioBackpressured = false;
    if (wasStarted) {
      try {
        this._stopAudioCapture?.({ sessionId: session.id, owner: session.owner });
      } catch {}
    }
    try { session.audioInput?.end(); } catch {}
    session.audioInput = null;
  }

  _emitSignal(session, signal) {
    if (!session.owner || session.owner.isDestroyed?.()) return;
    try { session.owner.send('native-screen:signal', signal); } catch {}
  }

  _assertOwner(owner, session, force = false) {
    if (!force && owner !== session.owner) throw new Error('Native screen session belongs to another view');
  }

  _requireSession(owner, data) {
    const session = this._session;
    if (!session) throw new Error('No active native screen session');
    this._assertOwner(owner, session);
    if (!SESSION_ID_PATTERN.test(String(data.sessionId || '')) || data.sessionId !== session.id) {
      throw new Error('Stale native screen session');
    }
    return session;
  }

  _validPeerId(peerId) {
    const value = Number(peerId);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid native screen peer');
    return String(value);
  }

  _requireNegotiation(session, peerId, negotiationId) {
    if (!NEGOTIATION_ID_PATTERN.test(String(negotiationId || '')) ||
        session.peerNegotiations.get(peerId) !== negotiationId) {
      throw new Error('Stale native screen negotiation');
    }
  }
}

module.exports = {
  NativeScreenManager,
  NEGOTIATION_ID_PATTERN,
  PROTOCOL_VERSION,
  decodeField,
  encodeField,
};
