# Haven Desktop Changelog

## v1.4.25

### Fixed
- **Right-click did nothing on selected text or links.** The desktop app's `BrowserView` has no built-in context menu, and Haven's handler only built a menu for misspelled words — so right-clicking normal text, an input, or a link offered no Copy/Cut/Paste/Select All, and copying only worked for images. The context menu now adds standard Cut/Copy/Paste/Select All (driven by the selection's edit flags) and a Copy Link item, on top of the existing spellcheck suggestions.

---

## v1.4.24

### Fixed
- **Desktop app refused to launch on Windows after the v1.4.23 update (#5422).** v1.4.23 shipped a truncated `src/main/main.js` — the last 11 lines, including the closing brace of `installLinuxDesktopEntry()`, got chopped off in transit between editors. Electron loaded the asar, hit `SyntaxError: Unexpected end of input` halfway through main bootstrap, and surfaced the "A JavaScript error occurred in the main process" dialog instead of opening a window. Reinstalling didn't help — the same broken file shipped inside the installer. Rebuilt `main.js` from a known-good base and re-applied the v1.4.23 title-bar fix on top, then parse-checked every file in `src/main/` before tagging.

---

## v1.4.23

### Fixed
- **Window title stuck on "Loading Haven…" forever.** The splash page that the main `BrowserWindow` loads while a server's `BrowserView` boots has `<title>Loading Haven…</title>`, and `BrowserView`s are a separate `webContents` whose `<title>` does NOT propagate up to the host window. So once the splash was covered by the actual Haven UI, the OS chrome went on saying "Loading Haven…" indefinitely — looking, to many users, like the app had hung even though it was fully usable underneath. The active view's title is now mirrored to `mainWindow.setTitle()` on `did-finish-load`, `did-fail-load`, every `page-title-updated`, and every `switchToServer` swap, with a "Haven" fallback when the page title is empty or itself still says "Loading Haven".

---

## v1.4.22

### Added
- **`clipboard:write-image` IPC for renderer image-copy (Haven 3.21.0 followup).** New main-process IPC handler accepts a data URL or raw base64 PNG and writes it to the OS clipboard via Electron's `clipboard.writeImage` + `nativeImage`. Exposed on the renderer as `window.havenDesktop.clipboardWriteImage`. The renderer now prefers this path over `navigator.clipboard.write` for right-click → Copy image because the browser API was silently rejecting the write with `NotAllowedError`: the user-gesture token gets dropped across the async fetch + decode chain, and Chromium refuses any subsequent clipboard write without an active gesture. The main-process clipboard has no such restriction. Falls back to the web API + final text-URL fallback when the desktop hook isn't present.

---

## v1.4.21

### Added
- **Opt-in G-Sync / VRR FPS-drop workarounds (#35).** Two new toggles in `Settings → Debug` (Desktop only): "Disable GPU vsync (Nvidia G-Sync fix)" and "Remove Chromium frame-rate cap (Nvidia G-Sync fix)". Both apply Chromium command-line switches (`--disable-gpu-vsync` and `--disable-frame-rate-limit`) at app boot, working around the upstream Chromium issue where renderers on Nvidia G-Sync displays get stuck negotiating a tiny refresh rate after the window is hidden or restored and never recover — symptom is the whole app dropping to ~5 FPS until you force a fixed refresh rate in Nvidia Control Panel. Off by default because both flags can introduce visible tearing on non-VRR monitors. Require a restart to take effect.

### Fixed
- **Haven Desktop settings checkboxes and keybind recorders unresponsive until the matching left-nav item was clicked (#36).** The Shortcuts section's record buttons and the Desktop App / Debug section's preference change-listeners were only wired up *on* the click of the left-nav item that owns them. If you opened Settings and scrolled straight to a checkbox or a keybind recorder, nothing happened until you happened to click "Shortcuts" or "Desktop App" in the nav, at which point the section initialised and started behaving. Haven now eagerly initialises both Desktop sections the moment Settings opens, so every control is responsive immediately regardless of where you scroll. (Renderer change in Haven 3.19.x.)

---

## v1.4.20

### Fixed
- **Useless "Failed to register shortcut" toast (#184).** When binding a Mouse4/Mouse5 or bare-modifier PTT key on a machine where `uiohook-napi` couldn't load, the renderer used to show a one-size-fits-all "may already be in use, or the desktop app version doesn't support this binding type yet" toast with no actionable next step. The desktop IPC handler now returns a structured outcome per shortcut (`{ ok, reason }` where reason is `ok` / `uiohook-unavailable` / `conflict`) and the renderer translates each into a specific toast that tells the user what's actually wrong and what to do about it (install libuiohook, pick a different combo, etc.). Pairs with the Haven server-side renderer update.

---

## v1.4.19

### Changed
- **Clearer logging when `uiohook-napi` can't load (#184).** Bare-modifier and Mouse4/Mouse5 PTT bindings depend on the optional `uiohook-napi` native module. When it fails to load — most commonly on Linux distros that don't have `libuiohook` system-installed — the console previously just said "uiohook-napi unavailable". The warning now includes a platform-specific install hint (Arch pacman + yay incantation, Debian/Ubuntu apt packages, macOS Accessibility/Input Monitoring permission, Windows reinstall/rebuild suggestion) so users on Linux in particular don't have to dig through GitHub issues to find the right command. Same hint also fires on `uIOhook.start()` failures.

---

## v1.4.18

### Changed
- **Splash screen now uses the official Haven hex-H logo** instead of the generic solid-purple hexagon glyph. Same gentle pulse animation, just the real brand mark while the server view loads.

---

## v1.4.17

### Fixed
- **Screen-share encoder stalled when Haven was hidden behind another window (#5379).** Chromium treats a window covered by another full-size window as "occluded" and starts throttling its renderer, which stalls the WebRTC screen-share encoder and introduces audio/video desync that persists for the rest of the share. Haven Desktop already disabled `backgroundThrottling` on the server views, but Chromium's *native* occlusion detection (a separate code path on Windows) was still kicking in. Disabled the `CalculateNativeWinOcclusion` feature so renderers stay awake when the window is merely behind another window. This does NOT cover the explicit-minimize case — that one is still subject to OS-level suspension and would require re-enabling the `disable-renderer-backgrounding` flag, which was removed in 1.3.4 because it starved the renderer event loop. Workaround for minimize: shrink the window instead of minimizing it during a screen-share session.

---

## v1.4.16

### Added
- **Splash screen while the server view loads.** Launching Haven Desktop used to drop you on a flat dark rectangle for 30-40 s on cold-start cross-tunnel HTTPS handshakes (the BrowserView was already full-size and just blank while the renderer fetched). The main window now loads a small `splash.html` (hex logo, spinner, "Loading Haven…") immediately on creation, and the active BrowserView is kept at 0×0 until its first `did-finish-load`. A 20 s safety-net timer expands the view anyway if the server is unreachable, so you'll see the browser's own error page instead of an eternal spinner. Background-preloaded server views stay at 0×0 until you actually switch to them, then the switch-to handler expands them to full size.

---

## v1.4.15

### Fixed
- **Ctrl+Shift+Home was hijacked globally by Haven Desktop.** The "Reset to Welcome Screen" escape hatch was registered as a system-wide shortcut, meaning it would fire even when Haven wasn't focused (interfering with text editors, terminals, and other apps that use Ctrl+Shift+Home to select text). It is now a regular in-app menu accelerator under View, so it only works when Haven is the active window.

---

## v1.4.14

### Fixed
- **Spurious "Couldn't connect to that server" toast shown on launch.** Background preloads (`scheduleBackgroundServerPreload`) were triggering the error toast on the primary view when a background server failed to load at startup. Added a `!background` guard so the toast only fires for user-initiated connections.
- **Haven sometimes wouldn't open after a quick close-then-relaunch (Windows error 32).** Chromium's single-instance lock can take a moment to release after the previous process exits. If you relaunched before the OS fully freed the lock file, Haven would silently quit and you'd have to click again. Haven now waits 1.5 seconds and relaunches itself automatically in that case, so the window always appears without any extra effort on your part.

---

## v1.4.13

### Added
- **#184 (final item): OS-level PTT for bare modifiers and mouse buttons.** The recorder UI in 3.11.x can already capture lone modifiers (`Shift`/`Alt`/`Ctrl`/`CommandOrControl`) and `Mouse4`/`Mouse5`, but Electron's `globalShortcut.register()` rejects those bindings — they only worked when Haven was focused. Desktop now loads the optional `uiohook-napi` dependency and routes those bindings through OS-level input hooks so they fire even when Haven is in the background. Ordinary keyboard accelerators continue to use Electron's built-in `globalShortcut`. PTT also now respects the recorder's `pttMode` setting: in `hold` mode the renderer unmutes on key/button down and re-mutes on key/button up; in `toggle` mode a single press flips the mute state.
- **`pttMode` accepted by `shortcuts:register`.** The renderer recorder has been writing this field since 3.11; it was previously dropped by the IPC handler's allow-list. Now persisted and honoured.

### Fixed
- **#5346: native screenshare/audio addon crashed at runtime with `undefined symbol: pa_simple_new` on PipeWire-pulse systems (CachyOS / Arch family).** The Linux build only linked `libpulse` (`-lpulse`) but the `pa_simple_*` API the addon actually calls lives in a separate library, `libpulse-simple` (`-lpulse-simple`). On most distros some other dependency drags `libpulse-simple.so.0` into the process incidentally, but on CachyOS with PipeWire's pulse compatibility shim the symbol isn't resolved at all and the AppImage crashes the moment `pa_simple_new` is called — exactly matching the reported `LD_PRELOAD=/usr/lib/libpulse-simple.so.0` workaround. `binding.gyp` now passes both libraries to `pkg-config`, with a `-lpulse -lpulse-simple` fallback.

### Notes
- `uiohook-napi` is declared as an *optional* dependency. If it fails to install (no native toolchain, unsupported platform), Haven still launches and ordinary keyboard shortcuts still work — only the bare-modifier / mouse-button bindings are no-op'd. A console warning is logged at startup in that case.

---

## v1.4.12

### Fixed
- **#184: "Screenshare canceled or not supported" error after picking a source.** `desktopCapturer` source IDs aren't stable — Windows can re-enumerate the source set between the moment the picker opens and the moment the renderer attaches the stream, leaving the originally picked ID gone. The handler now re-enumerates at attach time and falls back gracefully (exact ID → same name + display_id → any screen on the same display → first available screen) instead of returning an empty stream and surfacing a generic error.

## v1.4.11

### Fixed
- **Mic speaking indicator would permanently stop illuminating after extended voice chat sessions.** The indicator was driven by server echo (the `voice-speaking` event relayed back through the server), but if the socket briefly lost voice-room membership during a reconnect or network hiccup, the echo never arrived — and since the client only emits on the `false → true` speech transition, it never recovered. The indicator is now driven directly by the local audio analyser, making it instant and reliable.
- **Hard page reload during screen sharing kicked the user from their voice session every ~2 minutes.** The memory monitor was set to reload the renderer at 512 MB with a 2-minute cooldown. Screen sharing easily consumes that much memory, triggering a predictable reload cycle. The threshold is now 1536 MB (1.5 GB), the soft-trim threshold is 500 MB, and the reload cooldown is 5 minutes. Additionally, the hard reload is now skipped entirely if the user is currently in voice or screen sharing — only the soft DOM trim runs instead.

---

### Fixed
- **Per-app audio: game audio apps sometimes not appearing in the audio picker** (e.g. Terraria). The audio app enumeration was only querying the default console audio endpoint (`eConsole`). Engines like MonoGame/XNA (Terraria), FMOD, and OpenAL can register their audio sessions on a different render endpoint, so those apps were invisible in the picker. Enumeration now iterates all active render endpoints via `IMMDeviceEnumerator::EnumAudioEndpoints`, with per-PID deduplication across endpoints.
- **Voice activity indicators go dark when Haven is minimized.** Chromium was throttling `setInterval` calls and auto-suspending the `AudioContext` when the window lost focus, making mic/voice indicators freeze until the window was restored. `backgroundThrottling` is now disabled on all server views so audio processing continues normally in the background.

---

## v1.4.9

### Fixed
- **Per-app audio capture was failing on most Windows machines** (contributed by metheos, PR #27). `ActivateAudioInterfaceAsync` was returning `0x8000000E` because the `ActivateHandler` COM object didn't implement `IAgileObject`/`IMarshal`, so Windows couldn't marshal the async completion callback across thread contexts. The handler now registers a Free-Threaded Marshaler via `CoCreateFreeThreadedMarshaler`, which is required for WASAPI process loopback async activation to succeed. Additionally: startup synchronization replaced the old Win32 event handle + atomic bool with a proper `condition_variable` + state enum (timeout extended 4s to 12s); the N-API PCM callback now copies audio data into JS-owned `ArrayBuffer` memory to eliminate external buffer ownership hazards; `main.js` adds a `safeCallback` guard to prevent double-invoke of the `DisplayMedia` callback, retries `desktopCapturer.getSources` without thumbnails when WGC init fails on some Windows builds, and uses a `requestId` to prevent stale picker responses from resolving the wrong share request.

---

## v1.4.8

### Fixed
- **Screen share completely broken — clicking the screen-share button did nothing, no picker, no error.** The 1.4.7 release shipped `src/main/app-preload.js` with literal `\n`, `\u2014`, and `\\'` escape sequences embedded in the source of the `installGetDisplayMediaOverride()` function instead of actual newlines, em-dashes, and a quote. That made the whole preload a JavaScript syntax error, so it never loaded — no `screen:show-picker` IPC listener, no `getDisplayMedia` override, no notifications override, nothing. Main would fire the picker IPC, the renderer would never respond, main would silently time out after 60 seconds and reject the call. Restored the block to valid JS.

---

## v1.4.7

### Fixed
- **Silent screen shares on machines where Windows Process Loopback API is unavailable.** When per-app or system-clean capture failed (`ActivateAudioInterfaceAsync` returning `E_INVALIDARG` etc.), the `getDisplayMedia` override stripped Electron's loopback audio track up front and then sat waiting for native PCM that never came, leaving every share dead-silent. Main now always asks Electron for a loopback track when any audio mode is selected, and the override only strips it after native PCM is confirmed flowing. Native failure now keeps Electron loopback so the share is at least audible (with a console warning that Haven voice may echo — the share-mode badge already surfaces this state).

---

## v1.4.6

### Fixed
- **Defunct server lockup, take three.** The previous "Haven Not Found" / "Connection Problem" dialogs let the user pick "Keep Loading", which silently kept the retry loop hammering a dead server with no UI to escape — and even a passive close via X / Esc still left the user stranded mid-load.  Both dialogs are gone now: load-content waits drop from 15 s to 5 s, the transient-error retry budget drops from ~30 s to ~1 s, and any failed load just snaps secondary servers back to the primary view (with a toast) or kicks a primary failure to the welcome screen automatically.  The user is never asked to make a choice during a connection failure.

---

## v1.4.5

### Fixed
- **Clicking a Haven message link from one channel to another spawned a brand-new desktop client / second window** (issue #5306, surfaced on Linux).  `target="_blank"` deep-links to `/app.html?channel=…&message=…` were caught by `setWindowOpenHandler` and given `action: 'allow'` because they're same-origin, opening a fresh popup BrowserWindow.  We now detect Haven app deep-links specifically (path matches `/app(.html)?` or `/c/<code>`, or has `channel=`/`message=` query) and dispatch `app:navigate-deep-link` over IPC; the renderer hops to the channel and `_jumpToMessage`s in-place inside the existing view.  Game / asset pop-outs (e.g. `/games/foo.html`) still get a real child window.
- **Defunct server lockup:** the "Haven Not Found" and "Connection Problem" dialogs only acted on the explicit "Go Back" button — clicking "Keep Loading" or closing the dialog with X / Esc left the user staring at a non-Haven page with no UI to escape, while the BrowserView's transient-error retry loop kept hammering the dead server.  Any answer that isn't an explicit "Keep Loading" (X close, Esc, default click-through) now snaps secondary servers back to the primary view, or kicks the user back to the welcome screen for the primary, so they're never frozen on an infinite reconnect.

---

## v1.4.4

### Fixed
- **Per-app screen-share audio fell back to silence** when WASAPI process-loopback couldn't bind to the chosen PID (game running elevated, transient PID, etc.).  We now chain per-app capture → system-minus-Haven (clean system audio that excludes our own voice) → Electron raw loopback as a final last-resort, so the user *always* gets some audio.  A small coloured badge in the share viewer now tells the streamer which mode they ended up in (green = per-app, blue = clean system, orange = fallback to clean system, red = Electron loopback / may include voice).
- **Server-icon notification dots not appearing for messages from a different/background server** — the `notification-badge` IPC used strict `webContents` identity to figure out which server fired it, so a renderer reload (transient navigation, crash recovery) silently broke the lookup and no other open view ever lit up that server's dot.  Sender lookup now falls back to URL-match via `e.sender.getURL()`, and the per-server map is broadcast to **every** open BrowserView (not just the active one), so every sidebar updates its dots in real time.  The same fallback applies to `report-known-server-urls` so background views' filter sets survive reloads.

---

## v1.4.3

### Fixed
- **"Haven Not Found" / "Connection Problem" popups would trap the app forever if the user wasn't there to click a button.** Both load-failure dialogs now auto-dismiss after 30 seconds and quietly perform the default action (return to welcome, or switch back to your primary server). The popup message now mentions the auto-return so it's not surprising. The native dialog stays on screen until the user closes it; the underlying view has already been cleaned up by then so the buttons are effectively no-ops.

---

## v1.4.2

### Fixed
- **App crashed on launch with `Cannot read properties of undefined (reading 'isDestroyed')`** — the transient-error retry added in 1.4.1 dereferenced `view.webContents` after the background-preload view had already been destroyed. Retries now bail out cleanly if the view (or its `webContents`) is gone, ignore subframe load failures, and never run for background pre-load views (those are best-effort and were already cleaned up silently).

---

## v1.4.1

### Fixed
- **Taskbar badge filtered to visible servers** — the taskbar badge now only lights up for servers whose unread indicators are actually visible in at least one open server view. Previously, background-preloaded views could trigger the badge for servers that had no icon in any sidebar, making the badge appear with nothing to point to.

---

## v1.4.0

### Added
- **Background server view preloading** — secondary servers are preloaded in the background so switching between them is nearly instant. (#5269)
- **Server history sync to web client** — Desktop's known server list is now shared with the Haven web client on startup, so servers you've used in the app appear without re-entering the URL.

### Fixed
- **Server history cleanup** — server history entries are now deduplicated, validated, and legacy/malformed entries are cleaned up on read.

---

## v1.3.0

### Added
- **Server history and server picker** — the login page now remembers previously connected servers and lets you pick from them instead of re-typing the URL each time.
- **Hide menu bar setting** — a new toggle in Settings → Desktop App hides the native menu bar (alt to show temporarily). Windows and Linux only.
- **Privacy toggle for server address** — the server address shown in the desktop footer can now be hidden, matching the web privacy toggle.

### Fixed
- **Image copy permissions** — clipboard-write and clipboard-read permissions are now properly granted so copying images from chat works correctly in the desktop app.
- **Per-app audio crash on Linux** — added safety wrapping to per-app audio capture callbacks to prevent a crash when the audio pipeline is torn down mid-capture on Linux. (#5254)
- **Local server detection improvements** — local server paths are now persisted more reliably, and additional installer paths are recognized on first run, reducing "server not found" false negatives. (#22)
- **AppData install paths** — server discovery now includes AppData install locations so self-hosted instances installed there are detected automatically.
- **.deb sandbox permissions** — the Debian package now auto-fixes the chrome-sandbox SUID bit during post-install, resolving the startup failure on some Linux distributions.
- **License references** — updated all license headers and references to AGPL-3.0.

---

## v1.2.0

### Fixed
- **Per-app audio pipeline overhaul** (#165) — several bugs in the per-app audio path that together caused silence for viewers:
  - ScriptProcessor fallback now uses 0 input channels (was 1 with nothing connected), which is more reliable in Chromium.
  - IPC PCM data handler now correctly handles typed arrays with non-zero byte offsets and unknown buffer types instead of potentially misreading data.
  - WASAPI capture loop now adapts to the device's actual mix format (channel count and sample type) when the preferred 48kHz stereo float32 initialization fails. Previously it hardcoded stereo float32 interleaving regardless of what the OS reported, which could produce garbled audio on systems with surround-sound or 16-bit mix formats. (#209)

---

## v1.1.9

### Fixed
- **Fullscreen reverted to v1.1.6 approach** — the overlay-based fullscreen rewrite from v1.1.7 broke MP4 embed fullscreen. Reverted to the original CSS class toggle (`haven-manual-fullscreen`) that was working in v1.1.6. Removed all the extra BrowserView resync handlers, `enter-html-full-screen` interceptors, custom fullscreen button injection, and DOM-manipulation overlay code that was causing the regression.

---

## v1.1.8

### Fixed
- **MP4 fullscreen regression** — v1.1.7's deferred BrowserView resync on un-maximize fired during fullscreen transitions (Windows fires `unmaximize` when leaving fullscreen), stomping the overlay with stale dimensions. Added a fullscreen transition guard so the deferred calls are skipped during/after fullscreen exit.
- **Gray/purple box after un-maximize** — the deferred resync now also sends a renderer-side `resize` event to force CSS viewport recalculation, eliminating the gray strip left by stale `100vh` values.
- **"Haven Not Found" false positive on login pages** — the isHaven check only looked for `#app-body` which doesn't exist on the Haven login page. Now also recognizes `.auth-page` and Haven page titles, so connecting to a friend's server no longer falsely triggers the "not a Haven server" dialog.
- **Server switching destroys session** — clicking a friend's server icon and encountering any issue (load timeout, non-Haven page) offered "Change Server" which wiped all preferences and returned to the Welcome screen. Secondary server failures now offer "Go Back to My Server" and cleanly return to the primary server without resetting anything.
- **Tray menu "Change Server" while on secondary** — the tray menu now shows "Back to My Server" when viewing a secondary server, switching back without resetting.

---

## v1.1.7

### Fixed
- **Game pop-out blocked in desktop** — the "Pop Out" button on games (e.g. Shippy Container) was blocked because Electron denied all `window.open` calls. Same-origin popups now open in a real child window.
- **Gray box after un-maximizing** — double-clicking the title bar to restore from maximized could leave a gray/purple box covering part of the app because `getContentSize()` returned stale values during the OS animation. The BrowserView now re-syncs after a delay, matching the existing fullscreen exit behavior.

---

## v1.1.6

### Fixed
- **Per-application audio pipeline fallback** (#165) — per-app audio capture failed silently in some Electron BrowserView environments where AudioWorklet blob URLs were blocked. Added a ScriptProcessorNode fallback when AudioWorklet fails, explicit AudioContext.resume() for suspended contexts, and a final fallback to system loopback audio if the entire pipeline fails.
- **Reduced memory trend log spam** — memory usage delta logs now only print when the change exceeds 10 MB, cutting down unnecessary console output.

---

## v1.1.5

### Fixed
- **Notification click now navigates to the right channel** — clicking a native OS notification now opens the app and switches to the channel or DM where the message was sent, instead of just bringing the window to focus.

---

## v1.1.4

### New Features
- **Start Hidden to Tray** — when "Start on Login" is enabled, a new "Start Hidden to Tray" option lets the app launch minimized to the system tray instead of opening a window. Both options are in Settings → Desktop App.
- **Voice join/leave OS notifications** — the desktop app now shows native OS notifications when someone joins or leaves a voice channel you're in.

### Fixed
- **Settings sections not visible** — the Shortcuts and Desktop App sections in Settings were showing in the navigation but the actual content panels stayed hidden. Both now display correctly when running in the desktop app.

---

## v1.1.3

### Fixed
- **Fullscreen now actually works** — video fullscreen (from the native controls' button or the `...` menu), stream tile fullscreen buttons, and stream/webcam PiP overlay fullscreen buttons all failed silently inside Electron's BrowserView layer. Implemented a complete manual fullscreen override in the preload that intercepts `requestFullscreen()` calls and handles them via CSS + IPC, making fullscreen work everywhere in the app.
- **WGC ProcessFrame log spam eliminated** — the terminal was flooded with `wgc_capture_session.cc ProcessFrame failed` errors during any voice/screen-share session. Switched from `--log-level=3` (browser process only) to `--disable-logging`, which suppresses Chromium C++ logging across all subprocesses including the GPU process where the spam originates.
- **Screen sharing broken by preload crash** — a DOM injection in the fullscreen patch ran before the HTML document existed, throwing an error that silently killed the rest of the preload script. Screen sharing, notifications, and other Desktop features stopped working. Fixed by deferring the CSS injection to `DOMContentLoaded`.
- **PiP permissions** — added `picture-in-picture` and `fullscreen` to Electron's session permission grants so native PiP controls display correctly.

---

## v1.1.2

### Updated
- Bundled Haven server updated to v2.7.2, which fixes two scroll-position bugs: new root messages no longer leave the feed scrolled slightly short of the bottom, and switching channels / DMs now reliably lands at the latest message instead of a random earlier position.

---

## v1.1.1

### Bug Fixes
- **Renderer freeze from sync dialog deadlocks** — `window.prompt()` was implemented via a VBScript `InputBox` spawned by `cscript.exe` with a 5-minute `execSync` timeout. If the dialog spawned behind the app window, the main process blocked for up to 5 minutes with no way to dismiss it. Replaced with a native Electron dialog that returns instantly. Also removed the `disable-renderer-backgrounding` Chromium flag, which was preventing timer throttling and starving the renderer event loop.
- **Renderer freeze from reflow storm** — the memory-check soft GC was calling `getBoundingClientRect()` on every image via `executeJavaScript` every 10 seconds, forcing 50+ synchronous layout recalculations per cycle. Removed layout-triggering calls entirely; the soft GC now only trims DOM node count (O(1)). Health checks replaced `executeJavaScript` with `webContents.isCrashed()` to avoid blocking the main process.
- **Progressive slowdown from memory pressure** — default V8 heap (384 MB) and GPU memory budget (128 MB) were too tight for Haven’s DOM-heavy UI with RGB theme cycling and embedded media, causing frequent GC pauses. V8 heap raised to 512 MB, GPU budget to 256 MB, and tray menu rebuild interval reduced from 10s to 60s.
- **Soft-GC message trim cap misaligned** — the Electron soft GC trimmed messages to 200, but the client already caps at 100, leaving up to 100 stale messages (~1200 DOM nodes) that were never cleaned up. Aligned the cap to 100.

### Added
- **Memory trend tracking** — a rolling-window telemetry system samples renderer memory every 30 seconds and logs a trend summary every ~2.5 minutes (e.g. `Memory trend: 85→142 MB (+57) ↑ over 10 min`). Renderer-side `[Haven Perf]` console messages are forwarded to the main process for server-log visibility without needing DevTools.

### Improved
- **Zombie process cleanup** — the server manager now kills any leftover process holding the configured port before starting, preventing "port in use" failures after crashes.
- **Server auto-restart** — if the server process exits unexpectedly, it restarts after 2 seconds with a cooldown to prevent loops.
- **Crash recovery** — after exhausting retry attempts, the app now performs a full BrowserView tear-down and rebuild instead of giving up permanently.

---

## v1.1.0

### Bug Fixes
- **SSL error flood causing blank screen + OOM crash** — when connecting to a Haven server over HTTPS with a self-signed certificate, the existing `certificate-error` handler only covered page navigation. WebSocket reconnection attempts (Socket.IO) and fetch/XHR requests still hit Chromium's native `ssl_client_socket_impl` layer, which rejected the cert and logged an error object for every single failed handshake. During reconnection storms, thousands of these errors accumulated in the renderer's heap until Oilpan's garbage collector couldn't allocate, causing a fatal OOM crash and a blank screen. Fix: `setCertificateVerifyProc` on the default session now accepts all certificates at the session level, which covers *all* connection types (navigation, WebSocket, fetch, XHR) before the C++ TLS code ever sees a failure. The SSL error flood no longer occurs, so the renderer never OOMs.
- **Infinite crash-reload loop** — the v1.0.9 `render-process-gone` handler would reload the page unconditionally on every crash, creating an infinite crash → reload → crash cycle if the underlying cause persisted. Crash recovery now has a retry limit of 3 with exponential back-off (1.5 s → 3 s → 6 s), and resets the counter after 60 seconds of stability.

---

## v1.0.9

### Added
- **Global voice keyboard shortcuts** — mute, deafen, and push-to-talk can now be assigned to system-wide hotkeys in Settings → Keyboard Shortcuts. Shortcuts work even when Haven Desktop isn't the focused window.

### Bug Fixes
- **Blank app window** — the renderer window could go completely blank during server restarts, reconnects, or rapid view transitions. Root cause: `webContents.send()` fires through Electron's native C++ IPC layer *before* throwing a catchable JS exception, so a simple `try/catch` isn't enough — the native send to a disposed render frame still corrupts the renderer's IPC channel. Fix:
  1. A new `safeSend()` helper checks `wc.mainFrame` (which returns `undefined` when the frame is disposed) *before* calling `send()`, preventing the native code from ever attempting the IPC send.
  2. Server log forwarding is now batched to 50 ms intervals instead of firing synchronously for every line of stdout — this eliminates the rapid-fire IPC bursts during startup/reconnect.
  3. A `render-process-gone` crash-recovery handler on each BrowserView automatically reloads the page if the renderer dies for any reason, so the screen can never stay permanently blank.

---

## v1.0.8

### Bug Fixes
- **Auto-launch no longer broken after server load failure** — a bug introduced in v1.0.7 (alongside the FCM/installer update) caused the app to forget your saved server on any load failure or startup hiccup, permanently dropping you back to the welcome screen on every subsequent launch. The fix: your server preferences (path, URL, mode) are now preserved across failures so the next launch retries automatically. Use Ctrl+Shift+Home to intentionally reset and return to the welcome screen.

---

## v1.0.7

### Bug Fixes
- **Taskbar badge now reliably appears for unread messages** — three bugs were causing the overlay badge to fail or behave erratically: (1) a `focus` event cleared the badge immediately whenever the window was focused, even with unreads remaining; (2) an `isFocused()` guard on the IPC handler blocked the badge from being set while the app was open but you were in a different channel; (3) `flashFrame` was firing unconditionally, causing taskbar flicker even when the window was already in focus. All three are fixed.

### Improvements
- **Haven-branded notification badge** — the overlay icon is now a Haven hexagon with the app's signature purple gradient and a "!" mark, instead of a plain fuchsia circle.

---

## v1.0.6

### Improvements
- **Screen share picker — audio/cancel/share always visible** — the Application Audio selection and Cancel/Share buttons are now pinned outside the scrollable area. Only the screen and window list scrolls, so you never need to scroll down to find the buttons.
- **"No Audio" option added to screen share picker** — a new 🔇 No Audio button lets you share your screen with no audio at all. The existing System Audio option now correctly shows a 🔊 speaker icon instead of the muted speaker.

### Bug Fixes
- **Ghost voice-chat state on app restart** — closing the app while in a voice channel no longer causes the app to "think" you’re still in voice on the next launch (blocking you from joining again). The saved voice channel is now cleared on each fresh page load; auto-rejoin on network blips within the same session is unaffected.

---

## v1.0.5

### Bug Fixes
- **Windows volume ducking** — The desktop app no longer causes Windows to lower its own volume (or other apps') in the volume mixer when voice activity is detected. The audio capture stream is now categorized as `AudioCategory_Other`, opting out of Windows' automatic communications ducking behavior.

---

## v1.0.4

### New Features
- **Auto-update system** — When a new version is available, a banner appears at the bottom of the screen. Click "Download" to fetch the update, then "Restart & Install" to apply it. No manual downloads needed.

### Bug Fixes
- **Tray icon now shows correctly** in packaged builds (assets were not being bundled).
- **Soft-lock recovery** — If the app gets stuck on a blank screen (e.g. saved server became unreachable), press **Ctrl+Shift+Home** to reset back to the welcome screen. A 15-second page-load timeout also offers to take you back automatically.
- **Wayland screen-share picker** — Improved dismiss behavior: background overlay click, better ESC handling, and focus restoration after closing the picker.

---

## v1.0.3

- Initial public release.
