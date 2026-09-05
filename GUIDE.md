# ⬡ Haven Desktop — User Guide

Welcome to **Haven Desktop**, the standalone desktop client for [Haven](https://github.com/ancsemi/Haven). Everything the browser version can do — plus per-app audio, device switching, and native notifications.

---

## 📋 What You Need

- **Windows 10** (build 19041+) or **Windows 11**, or **Linux** (with PulseAudio or PipeWire)
- A running Haven server to connect to — or Haven installed locally if you want to host

> **Don't have a server?** The desktop app can detect and start one for you automatically, or guide you through setting one up from scratch.

---

## 📥 Installing

### Windows

1. Download the `.exe` installer from the [Latest Release](https://github.com/ancsemi/Haven-Desktop/releases/latest)
2. Double-click the `.exe` — Haven installs and launches automatically
3. That's it. No terminal, no dependencies, no setup wizards.

The installer creates a desktop shortcut and start menu entry. Uninstall from **Settings → Apps** like any other program.

### Linux (AppImage)

```bash
chmod +x Haven*.AppImage
./Haven*.AppImage
```

Or just double-click in most desktop environments. No installation needed — AppImages are portable.

Builds after 1.4.28 run without libfuse2, which distributions such as Fedora and Ubuntu 24.04 no longer ship. If an older build says it requires FUSE, start it with `./Haven*.AppImage --appimage-extract-and-run` instead.

### Linux (.deb)

```bash
sudo dpkg -i haven*.deb
```

Or double-click the `.deb` to install via your system's package manager. Haven appears in your application menu under **Network** / **Chat**.

---

## 🚀 First Launch

When you open Haven Desktop for the first time, you'll see a welcome screen with two options:

### Option 1 — Host My Server

Choose this if you run your own Haven server.

1. Click **Host My Server**
2. Haven searches common locations for a local Haven server (`server.js`)
3. If found, click **Start Server** — Haven starts it and connects automatically
4. If not found, click **Browse for server directory** to point Haven to it
5. Or click **Start Fresh Server Setup** to download and set up Haven from scratch

Haven detects your server in these locations (in order):
- The directory you used last time
- A sibling `Haven/` folder next to the desktop app
- `~/Haven`, `~/Desktop/Haven`, `~/Documents/Haven`

### Option 2 — Join a Server

Choose this if someone else is hosting.

1. Click **Join a Server**
2. Enter the server address (e.g. `https://haven.example.com` or `https://192.168.1.50:3000`)
3. Click **Connect**

> Haven auto-prefixes `https://` if you forget it. If the server uses a self-signed certificate (the default), Haven accepts it automatically for localhost connections.

### Remember My Choice

Check **"Remember my choice"** to skip the welcome screen on future launches. Haven will go straight to your server. You can reset this anytime from the system tray menu.

---

## ✨ Features Unique to Desktop

These features are **only** available in Haven Desktop — not in the browser version.

### 🔊 Per-Application Audio

Share audio from a **single application** during screen share — no other audio leaks through.

**How it works:**
1. Join a voice channel and click **Share Screen**
2. Haven shows a custom picker with your screens, windows, and running apps
3. Select a screen/window to share video from
4. Under **Application Audio**, select the specific app whose audio you want to share (e.g. a game, Spotify, a browser tab)
5. Click **Share** — your friends hear only that app's audio

**Technical details:**
- **Windows:** Uses WASAPI Process Loopback (same API as Discord) — requires Windows 10 build 19041+ (May 2020 Update)
- **Linux:** Creates a PulseAudio virtual null sink, routes the target app's audio to it, and captures from the sink monitor

> If you don't select a specific app, system audio is shared as usual.

### 🎧 Audio Device Switching

Switch your microphone or speakers mid-call without leaving voice chat.

1. Click **Settings** while in a voice channel
2. Under **Audio Input**, select a different microphone
3. Under **Audio Output**, select different speakers or headphones
4. Changes take effect immediately — no need to rejoin voice

### 🔔 Desktop Notifications

Haven Desktop uses native OS-level notifications instead of browser notifications.

- Notifications appear in your taskbar / notification center
- Click a notification to bring Haven to the foreground
- Works even when Haven is minimized to the system tray

### 🔽 Minimize to Tray

Closing Haven doesn't quit it — the app minimizes to your system tray. Click the tray icon to bring it back, or right-click for options:

- **Show Haven** — bring the window back
- **Server Running / Stopped** — current server status
- **Quit Haven** — fully exit the app and stop any running server

---

## 🖥️ Screen Sharing

Screen sharing in Haven Desktop works the same as the browser version, with the addition of the custom picker and per-app audio.

1. In a voice channel, click **🖥️ Share Screen**
2. The picker overlay appears showing:
   - **Screens** — your full monitors
   - **Application Windows** — individual app windows
   - **Application Audio** — running apps you can isolate audio from
3. Select a video source, optionally select an audio app, and click **Share**
4. Multiple users can share simultaneously — each stream appears in a tiled grid

When the user whose audio is being captured stops their screen share, the per-app audio pipeline is automatically cleaned up.

---

## 🛠️ Server Management

If you chose **Host My Server**, Haven Desktop manages your server process for you.

### Auto-Detection

Haven looks for a `server.js` file alongside a `package.json` with `"name": "haven"`. It checks:
1. Your last-used server path
2. A `Haven/` folder next to the desktop app
3. `~/Haven`, `~/Desktop/Haven`, `~/Documents/Haven`

### Starting & Stopping

- The server starts automatically when you launch Haven (if you chose Host mode with Remember enabled)
- Haven picks an available port starting from 3000
- Server log output is shown in the welcome screen while starting
- The server stops automatically when you quit Haven from the tray

### HTTPS Detection

Haven Desktop detects whether your server starts with HTTPS or HTTP by watching the server's output for "HTTPS enabled". The protocol is chosen automatically — no manual configuration needed.

---

## ⌨️ Keyboard Shortcuts

All browser shortcuts work in the desktop app, plus:

| Key | Action |
|-----|--------|
| `Escape` | Close the screen-share picker |

All Haven shortcuts (Ctrl+F for search, Shift+Enter for new line, @ for mentions, etc.) work identically.

---

## 📂 Configuration & Data

### Desktop App Settings

Haven Desktop stores its preferences (mode, server URL, window size) in the standard Electron config location:

| OS | Location |
|----|----------|
| Windows | `%APPDATA%\haven-desktop\config.json` |
| Linux | `~/.config/haven-desktop/config.json` |

### Haven Server Data

Your server data (messages, uploads, config) is stored separately in the Haven data directory — see the [Haven User Guide](https://github.com/ancsemi/Haven/blob/main/GUIDE.md#backing-up-your-data) for details.

---

## 🏗️ Building from Source

> **Most users don't need this.** Just download the installer above.

### Prerequisites

- **Node.js** 22.12+
- **npm** 10+
- **C++ Build Tools:**
  - **Windows:** Visual Studio Build Tools 2019+ with "Desktop development with C++"
  - **Linux:** `build-essential`, `libpulse-dev`

### Windows — No Terminal

1. Double-click **`Setup.bat`** — installs Node dependencies and builds the native module
2. Double-click **`Start Haven Desktop.bat`** — launches the app in dev mode
3. Double-click **`Build Installer.bat`** — creates a distributable `.exe` in `dist/`

### Terminal

```bash
git clone https://github.com/ancsemi/Haven-Desktop.git
cd Haven-Desktop

# Install dependencies
npm install

# Build the native audio addon
npm run build:native

# Run in dev mode
npm run dev
```

### Build Installers

```bash
# Windows (NSIS one-click installer)
npm run build:win

# Linux (AppImage + .deb)
npm run build:linux
```

Output goes to the `dist/` directory.

### Automated Builds (CI)

Push a version tag to build via GitHub Actions:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions builds the Windows `.exe` and Linux `.AppImage` / `.deb`, then publishes them as a GitHub Release.

---

## 🆘 Troubleshooting

| Problem | Fix |
|---------|-----|
| Server not detected | Make sure the folder contains both `server.js` and `package.json` with `"name": "haven"`. Use **Browse** to point Haven to the right directory. |
| "node.exe not found" or server won't start | Node.js must be installed system-wide. Download from [nodejs.org](https://nodejs.org/) and restart. |
| Per-app audio not available | The native module needs to be built (happens automatically for release builds). On Windows, requires build 19041+. On Linux, install `libpulse-dev` and rebuild. |
| Certificate error connecting to server | Haven Desktop auto-accepts self-signed certs for `localhost` / `127.0.0.1`. For remote servers, accept the cert in a browser first, or install a trusted cert on the server. |
| No sound from per-app capture | Make sure the target app is actually producing audio. Try selecting a different application. |
| App opens to blank screen | Check that the server is running and reachable at the configured URL. Try clearing settings by deleting the config file (see Configuration above). |
| Tray icon missing (Linux) | Some desktop environments need an app indicator extension. On GNOME, install `gnome-shell-extension-appindicator`. |
| Can't build native module | Ensure you have C++ build tools installed. On Windows: `npm install --global --production windows-build-tools`. On Linux: `sudo apt install build-essential libpulse-dev`. |

---

## 🏛️ Architecture

```
Haven-Desktop/
├── src/
│   ├── main/
│   │   ├── main.js             # Electron main process (lifecycle, windows, tray)
│   │   ├── preload.js          # Welcome window preload (IPC bridge)
│   │   ├── app-preload.js      # App window preload (per-app audio, screen picker, notifications)
│   │   ├── server-manager.js   # Detect, start, stop local Haven server
│   │   └── audio-capture.js    # Native addon loader & manager
│   └── renderer/
│       ├── welcome.html        # Welcome / setup screen
│       ├── welcome.css         # Welcome screen styles
│       └── welcome.js          # Welcome screen logic
├── native/
│   ├── binding.gyp             # Native addon build config
│   └── src/
│       ├── addon.cpp           # N-API entry point
│       ├── audio_capture.h     # Cross-platform interface
│       ├── win/                # Windows WASAPI process loopback
│       └── linux/              # Linux PulseAudio capture
├── assets/                     # App icons
├── electron-builder.yml        # Installer configuration
└── package.json
```

### How Per-App Audio Works

**Windows (WASAPI Process Loopback):**
Uses `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` to capture audio exclusively from a target process. The native addon runs in a background thread, captures 48 kHz float32 PCM, and streams it to the renderer via IPC.

**Linux (PulseAudio):**
Creates a virtual null sink, moves the target application's audio stream to it, records from the sink's monitor, and loops the audio back to the default output so the user still hears it.

**In the Renderer:**
PCM data arrives via IPC → `AudioWorkletNode` processes it → `MediaStreamDestination` produces a `MediaStreamTrack` → the track replaces the system-loopback audio on the screen-share `MediaStream`. Haven's existing `voice.js` requires zero modifications.

---

## 📝 License

Same license as Haven — AGPL-3.0. See [LICENSE](../Haven/LICENSE).

---

<p align="center">
  <b>⬡ Haven Desktop</b> — Private chat, reimagined for your desktop.
</p>
