# Haven Desktop — ⚠️ PUBLIC BETA

**Private chat, reimagined for your desktop.**

> **This is a beta release.** Bugs are expected — your feedback is what makes it better.
> Please [open an issue](https://github.com/ancsemi/Haven-Desktop/issues) if something breaks or feels off. All reports are welcome.

Haven Desktop is a standalone Electron application that connects to any [Haven](https://github.com/ancsemi/Haven) server — with features that go beyond the browser.

> **⬡ You need a Haven server to use this app.**
> Haven Desktop is a client — it connects to a Haven server running on your (or a friend's) machine.
> If you don't have one yet, **[download Haven](https://github.com/ancsemi/Haven)** first and follow the [setup guide](https://github.com/ancsemi/Haven/blob/main/GUIDE.md).

---

## 📥 Download & Install

**Just download, run, done.** No terminal, no setup, no dependencies.

| Platform | Download |
|---|---|
| **Windows** (.exe) | [Latest Release](https://github.com/ancsemi/Haven-Desktop/releases/latest) |
| **Linux** (.AppImage) | [Latest Release](https://github.com/ancsemi/Haven-Desktop/releases/latest) |
| **Linux** (.deb) | [Latest Release](https://github.com/ancsemi/Haven-Desktop/releases/latest) |

> **Windows:** Double-click the `.exe` → Haven installs and launches automatically.
> **Linux AppImage:** `chmod +x Haven*.AppImage && ./Haven*.AppImage` — or just double-click in most desktop environments.
> **Linux .deb:** `sudo dpkg -i haven*.deb` — or double-click to install via your package manager.

---

## ✨ Key Features

| Feature | Description |
|---|---|
| **Per-Application Audio** | Share audio from a **single application** during screen share — just like Discord. Powered by native WASAPI (Windows) and PulseAudio (Linux) hooks. |
| **Audio Device Switching** | Switch your microphone and speaker mid-call without leaving voice chat. |
| **Desktop Notifications** | Native OS-level notifications via the taskbar / system tray. |
| **Host or Join** | Run your own Haven server from the app, or connect to someone else's. Auto-detects local servers. |
| **One-Click Install** | NSIS installer (Windows) and AppImage / .deb (Linux). Download, run, done. |
| **Minimize to Tray** | Stays running quietly in your system tray. |
| **Rich Presence** | See what everyone is playing and listening to in the member list and on their profile. Games via **Steam**; music via **Last.fm** (which covers Spotify, Apple Music, YouTube Music, Navidrome and Plex in one connection), Spotify directly, or Haven's own player. Optional, hidden while you're Invisible, never saved to the database. |

---

## 🖥️ Supported Platforms

- **Windows 10** (build 19041+) / **Windows 11**
- **Linux** (PulseAudio or PipeWire with `pipewire-pulse`)

> Per-app audio on Windows requires build 19041+ (Windows 10 version 2004, May 2020 Update).

---

## 🛠️ Building from Source

> **Most users don't need this.** Just download the installer above. This section is for developers who want to contribute or build locally.

### Prerequisites

- **Node.js** 22.12+
- **npm** 10+
- **C++ Build Tools:**
  - **Windows:** Visual Studio Build Tools 2019+ with the "Desktop development with C++" workload
  - **Linux:** `build-essential`, `libpulse-dev`, `libx11-dev`, `libxtst-dev`, `libxinerama-dev`, `libxt-dev`, `libxrandr-dev`, `libxfixes-dev`

### Quick Start (Windows — No Terminal)

1. Double-click **`Setup.bat`** — installs everything
2. Double-click **`Start Haven Desktop.bat`** — launches the app
3. Double-click **`Build Installer.bat`** — creates a distributable `.exe` in `dist/`

### Quick Start (Terminal)

```bash
# Clone the repo
git clone https://github.com/ancsemi/Haven-Desktop.git
cd Haven-Desktop

# Install dependencies
npm install

# Build the native audio addon
npm run build:native

# Run in dev mode
npm run dev
```

### Build Installers Locally

```bash
# Windows (NSIS one-click installer)
npm run build:win

# Linux (AppImage + .deb)
npm run build:linux
```

Output goes to the `dist/` directory.

### Automated Builds (CI)

Push a version tag to build automatically via GitHub Actions:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions builds the Windows `.exe` and Linux `.AppImage` / `.deb`, then publishes them as a GitHub Release. No local build tools required.

---

## 🏗️ Architecture

```
Haven-Desktop/
├── src/
│   ├── main/
│   │   ├── main.js             # Electron main process
│   │   ├── preload.js          # Welcome window preload
│   │   ├── app-preload.js      # App window preload (per-app audio, screen picker)
│   │   ├── server-manager.js   # Detect, start, stop Haven server
│   │   └── audio-capture.js    # Native addon loader / manager
│   └── renderer/
│       ├── welcome.html        # Welcome / setup screen
│       ├── welcome.css
│       └── welcome.js
├── native/
│   ├── binding.gyp             # Native addon build config
│   └── src/
│       ├── addon.cpp           # N-API entry point
│       ├── audio_capture.h     # Cross-platform interface
│       ├── win/
│       │   ├── wasapi_capture.h
│       │   └── wasapi_capture.cpp   # Windows WASAPI process loopback
│       └── linux/
│           ├── pulse_capture.h
│           └── pulse_capture.cpp    # Linux PulseAudio capture
├── assets/                     # Icons
├── package.json
├── electron-builder.yml
└── README.md
```

### How Per-App Audio Works

**Windows (WASAPI Process Loopback):**
The app uses the Windows 10 2004+ `ActivateAudioInterfaceAsync` API with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` to capture audio exclusively from a target process. This is the same API Discord uses. The native addon runs in a background thread, captures 48 kHz float32 PCM, and streams it to the renderer via IPC.

**Linux (PulseAudio):**
The app creates a virtual null sink, moves the target application's audio stream to it, records from the sink's monitor, and loops the audio back to the default output so the user still hears it.

**In the Renderer:**
PCM data arrives via IPC → `AudioWorkletNode` processes it → `MediaStreamDestination` produces a `MediaStreamTrack` → the track replaces the system-loopback audio on the screen share `MediaStream`. Haven's existing `voice.js` requires **zero modifications**.

---

## 💬 Feedback & Bug Reports

This is a **beta release** — your feedback directly shapes the app. If something doesn't work, looks wrong, or could be better:

1. **[Open an issue](https://github.com/ancsemi/Haven-Desktop/issues)** with as much detail as you can
2. Include your OS, Haven server version, and steps to reproduce

Every report helps. Thank you for testing.

---

## ⬡ Haven Server

Haven Desktop is just the client. **You need a Haven server to connect to.**

| | Link |
|---|---|
| **Haven Server** | [github.com/ancsemi/Haven](https://github.com/ancsemi/Haven) |
| **Setup Guide** | [GUIDE.md](https://github.com/ancsemi/Haven/blob/main/GUIDE.md) |
| **Website** | [ancsemi.github.io/Haven](https://ancsemi.github.io/Haven/) |

---

## 📝 License

Same license as Haven — AGPL-3.0. See [LICENSE](https://github.com/ancsemi/Haven/blob/main/LICENSE).

---

*Made with ♠ by [ANCsemi](https://github.com/ancsemi)*
