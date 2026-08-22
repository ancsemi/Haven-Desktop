// ═══════════════════════════════════════════════════════════
// Haven Desktop — Server Manager
//
// Detects, starts, and manages a local Haven server process.
// ═══════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const net  = require('net');

class ServerManager {
  constructor(store, opts = {}) {
    this.store         = store;
    this._t            = opts.t || (key => key);
    this.serverProcess = null;
    this._running      = false;
    this._port         = null;
    this._showConsole  = opts.showConsole || false;
  }

  // ── Detect a Haven server in common locations ────────────
  detectServer() {
    const candidates = [];

    // Saved path first (from a previous successful launch)
    const saved = this.store.get('userPrefs.serverPath');
    if (saved) candidates.push(saved);

    // Sibling directory (Haven-Desktop lives next to Haven)
    const parent = path.resolve(__dirname, '..', '..', '..');
    candidates.push(path.join(parent, 'Haven'));
    candidates.push(path.join(parent, 'haven'));

    // Common user locations
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      candidates.push(path.join(home, 'Haven'));
      candidates.push(path.join(home, 'Desktop', 'Haven'));
      candidates.push(path.join(home, 'Documents', 'Haven'));
      // Haven Server installer default: %APPDATA%\HavenServer
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'HavenServer'));
      candidates.push(path.join(appData, 'Haven'));
      candidates.push(path.join(appData, 'haven'));
      // Common install locations (e.g. Windows AppData / Programs)
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      candidates.push(path.join(localAppData, 'Programs', 'Haven'));
      candidates.push(path.join(localAppData, 'Programs', 'haven'));
      candidates.push(path.join(localAppData, 'Programs', 'haven-server'));
      candidates.push(path.join(localAppData, 'Programs', 'HavenServer'));
      candidates.push(path.join(home, 'AppData', 'Local', 'Haven'));
    }

    for (const dir of candidates) {
      try {
        const sjs = path.join(dir, 'server.js');
        const pkg = path.join(dir, 'package.json');

        if (fs.existsSync(sjs) && fs.existsSync(pkg)) {
          // Haven's package.json is written with a UTF-8 BOM (the release
          // step bumps it with PowerShell's Set-Content -Encoding utf8).
          // require() strips a BOM automatically, but JSON.parse does not --
          // it throws on the leading U+FEFF, and the catch below swallowed
          // that, so every candidate silently failed and Haven Desktop
          // reported "No Haven server detected" with the server sitting
          // right next to it. Written as an escape, not a literal BOM, so
          // this line survives any editor round-trip.
          const json = JSON.parse(fs.readFileSync(pkg, 'utf-8').replace(/^\uFEFF/, ''));
          if (json.name === 'haven') {
            return { found: true, path: dir, version: json.version };
          }
        }
      } catch { /* continue */ }
    }

    return { found: false, path: null };
  }

  // ── Start the server ──────────────────────────────────────
  async startServer(serverDir) {
    if (this._running) return { success: true, port: this._port, url: `http://localhost:${this._port}` };

    const sjs = path.join(serverDir, 'server.js');
    if (!fs.existsSync(sjs)) {
      return { success: false, errorKey: 'server.error.fileNotFound' };
    }

    // Kill any zombie server process holding port 3000 from a previous crash
    await this._killProcessOnPort(3000);

    try {
      this._port = await this._findPort(3000);
    } catch {
      return { success: false, errorKey: 'server.error.noPort' };
    }

    return new Promise(resolve => {
      const env = { ...process.env, PORT: String(this._port) };

      // Use system `node` (Electron's binary is not plain Node)
      const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';

      // Cap the server process V8 heap at 512 MB and expose GC so the
      // memory watchdog in server.js can nudge it.  Together with the
      // reduced SQLite pragmas (cache_size 8 MB, mmap_size 32 MB), total
      // server memory stays well under 700 MB and prevents the Oilpan
      // "large allocation" OOM the user was seeing.
      const nodeArgs = ['--max-old-space-size=512', '--expose-gc', sjs];

      const spawnOpts = {
        cwd: serverDir,
        env,
        shell: false,
      };

      if (this._showConsole) {
        // Show server in its own visible console window
        spawnOpts.detached = true;
        spawnOpts.windowsHide = false;
        spawnOpts.stdio = ['pipe', 'pipe', 'pipe'];
        this.serverProcess = spawn(nodeCmd, nodeArgs, spawnOpts);
      } else {
        spawnOpts.stdio = ['pipe', 'pipe', 'pipe'];
        spawnOpts.windowsHide = true;
        this.serverProcess = spawn(nodeCmd, nodeArgs, spawnOpts);
      }

      let resolved  = false;
      let isHTTPS   = false;   // detect from server output

      const finish = (ok, extra) => {
        if (resolved) return;
        resolved = true;
        this._running = ok;
        const protocol = isHTTPS ? 'https' : 'http';
        this._url = `${protocol}://localhost:${this._port}`;
        if (ok) this.store.set('userPrefs.serverPath', serverDir);
        resolve({ success: ok, port: this._port, url: this._url, ...extra });
      };

      this.serverProcess.stdout.on('data', (d) => {
        const msg = d.toString();
        this._emitLog(msg);

        // Haven prints "🔒 HTTPS enabled" when SSL certs are loaded
        if (/https enabled/i.test(msg)) isHTTPS = true;

        // Haven prints "Haven running on port …" or similar when ready
        if (!resolved && /listening|running|started/i.test(msg)) {
          finish(true);
        }
      });

      this.serverProcess.stderr.on('data', (d) => {
        this._emitLog('[ERR] ' + d.toString());
      });

      this.serverProcess.on('error', (err) => finish(false, { error: err.message }));

      // ── Auto-restart on crash ───────────────────────────
      // If the server exits unexpectedly (OOM, unhandled error, etc.),
      // restart it automatically so the user doesn't have to manually
      // relaunch.  Uses a simple cooldown to avoid restart loops.
      this.serverProcess.on('exit', (code, signal) => {
        this._running = false;
        const intentional = this._intentionalStop;
        this._intentionalStop = false;

        if (intentional) return;      // stopServer() was called

        if (code !== 0 && code !== null) {
          const now = Date.now();
          const COOLDOWN_MS = 5000;
          if (now - (this._lastRestart || 0) < COOLDOWN_MS) {
            this._emitLog(this._t('server.log.crashLoop'));
            return;
          }
          this._lastRestart = now;
          this._emitLog(this._t('server.log.restarting', { code }));
          setTimeout(() => {
            if (!this._intentionalStop) {
              this.startServer(serverDir).catch(() => {});
            }
          }, 2000);
        }
      });

      // Fallback: assume ready after 15 s no matter what
      setTimeout(() => finish(true), 15000);
    });
  }

  // ── Stop the server ───────────────────────────────────────
  stopServer() {
    this._intentionalStop = true;
    if (this.serverProcess) {
      const pid = this.serverProcess.pid;
      try {
        // On Windows, SIGTERM doesn't always work — use taskkill for the process tree
        if (process.platform === 'win32' && pid) {
          const { execSync } = require('child_process');
          try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
        } else {
          this.serverProcess.kill('SIGTERM');
        }
      } catch {}
      this.serverProcess = null;
    }
    this._running = false;
    this._port    = null;
    return { success: true };
  }

  // ── Status ────────────────────────────────────────────────
  getStatus() {
    return {
      running: this._running,
      port:    this._port,
      url:     this._running ? (this._url || `http://localhost:${this._port}`) : null,
    };
  }

  isRunning() { return this._running; }

  // ── Log forwarding ────────────────────────────────────────
  // Main process calls onLog() to subscribe; server-manager calls _emitLog()
  onLog(cb)    { this._logCb = cb; }
  _emitLog(msg) { if (this._logCb) this._logCb(msg); }

  // ── Port scanner ──────────────────────────────────────────
  async _findPort(start) {
    const test = (p) => new Promise(r => {
      const s = net.createServer();
      s.unref();
      s.on('error', () => r(false));
      s.listen(p, () => s.close(() => r(true)));
    });

    for (let p = start; p < start + 100; p++) {
      if (await test(p)) return p;
    }
    throw new Error('NO_AVAILABLE_PORT');
  }

  // ── Kill zombie processes on a port (Windows & Unix) ────
  // After a crash, the old server may linger as a zombie holding the port.
  // This ensures a clean start by killing any process bound to the target port.
  async _killProcessOnPort(port) {
    return new Promise(resolve => {
      const { exec } = require('child_process');
      if (process.platform === 'win32') {
        // Find PID listening on the port
        exec(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, (err, stdout) => {
          if (err || !stdout) return resolve();
          const lines = stdout.trim().split('\n');
          const pids = new Set();
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1]);
            if (pid && pid !== process.pid) pids.add(pid);
          }
          if (pids.size === 0) return resolve();
          let killed = 0;
          for (const pid of pids) {
            exec(`taskkill /F /PID ${pid}`, (e) => {
              if (!e) console.log(`[Haven Desktop] Killed zombie process PID ${pid} on port ${port}`);
              killed++;
              if (killed === pids.size) {
                // Brief delay to let the OS release the port
                setTimeout(resolve, 500);
              }
            });
          }
        });
      } else {
        // Unix: lsof + kill
        exec(`lsof -ti:${port}`, (err, stdout) => {
          if (err || !stdout) return resolve();
          const pids = stdout.trim().split('\n').map(p => parseInt(p)).filter(p => p && p !== process.pid);
          if (pids.length === 0) return resolve();
          exec(`kill -9 ${pids.join(' ')}`, () => {
            console.log(`[Haven Desktop] Killed zombie process(es) on port ${port}: ${pids.join(', ')}`);
            setTimeout(resolve, 500);
          });
        });
      }
    });
  }
}

module.exports = { ServerManager };
