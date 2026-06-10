# JARVIS Dashboard

A JARVIS-inspired personal desktop dashboard (Electron) with live system telemetry,
a clock/arc-reactor centerpiece, weather, optional IMAP email, an embedded Claude Code
console, and Spotify now-playing + playlists.

Repo: https://github.com/jhong03/J.A.R.V.I.S (remote `origin`, branch `main`).

## ⚠️ Project lives in a nested folder

The real project (package.json, main.js, src/) is at
`C:\Users\User\Downloads\jarvis-dashboard\jarvis-dashboard\` — one level below the
workspace root. The workspace root has an unrelated placeholder package.json with no
`start` script.

```
npm install --prefix .\jarvis-dashboard
npm start   --prefix .\jarvis-dashboard      # runs "electron ."
npm run dist --prefix .\jarvis-dashboard     # NSIS installer → dist\
```

## ⚠️ Launch & reload gotchas

- **`ELECTRON_RUN_AS_NODE=1` is set in VSCode-spawned terminals.** It forces Electron
  to boot as plain Node, so `require('electron')` returns a path string and the app
  crashes with `Cannot read properties of undefined (reading 'whenReady')`. Clear it
  before launching: `Remove-Item Env:\ELECTRON_RUN_AS_NODE` (PowerShell).
- **Ctrl+R only reloads the renderer** (`src/`). Changes to `main.js`, `preload.js`,
  or `config.json` need a full quit + relaunch (config is read once at startup).
- First install downloads a ~110 MB Electron binary (slow, not a hang).

## Architecture

- **main.js** — Electron main process. Owns the window and all Node-side capability:
  system telemetry (`systeminformation`), app launching (allow-listed against config
  shortcuts), the Claude Code CLI bridge (`claude -p --output-format json`, resumes a
  session id for memory), optional IMAP email (`imapflow`), Spotify, and the
  `app:quit` handler for graceful shutdown.
- **preload.js** — context-isolated bridge. Exposes a single `window.jarvis` object;
  the renderer never touches Node directly. Add a method here for every new IPC handler.
- **src/index.html / styles.css / renderer.js** — the UI. Renderer talks only through
  `window.jarvis.*`.
- **config.json** — all feature toggles and secrets. Features are off by default and
  gated on an `enabled` flag (see weather/email/spotify). **Git-ignored** (holds the
  IMAP app password); `config.example.json` is the committed template — keep it in
  sync when adding config keys. **Location:** in dev it's the project-local file; in a
  packaged install it lives under `userData/config.json` (writable — the asar is read-only)
  and is seeded from the bundled `config.example.json` on first run. The in-app
  **Settings page** (⚙ in the top bar) reads/writes it via `config:get`/`config:save`,
  so end users never edit JSON. `config:save` hot-swaps the in-memory copy so live
  handlers pick changes up without a restart.

Design rule: **all privileged work happens in main**; the renderer gets data via IPC.
Tokens/passwords never reach the renderer. CSP in index.html is tight — when adding a
remote image/host, widen the specific directive (e.g. `img-src` for album art).

## Visual system

Bright HUD restyle (palette documented at the top of styles.css): cyan `#4DDDFF` on
deep blue-black, muted labels `#8FB6CC` (kept ≥4.5:1 contrast — don't dim them back),
blueprint grid background, glowing corner brackets on panels, chamfered (clip-path)
buttons, solid-cyan EXECUTE as the one primary CTA. Fonts: Rajdhani + Share Tech Mono.
`prefers-reduced-motion` fallbacks exist for every animation — preserve them.

## Voice

Two engines, chosen by `config.voice.engine`:
- **`piper`** (default, the JARVIS voice) — a bundled offline neural TTS with an
  ffmpeg post chain that deepens/warms it toward the cinematic timbre. The
  renderer's `speak()` invokes `window.jarvis.voiceSpeak(text)` → `voice:speak`
  in main.js. Main spawns `vendor/piper/piper.exe` (model `en_GB-alan-medium`)
  with `--output_raw`, **pipes the raw PCM straight into `vendor/ffmpeg/ffmpeg.exe`**
  (pitch shift via `asetrate`/`atempo`, low/high shelf EQ, `acompressor`), writes
  a temp WAV, and pushes it back as a `data:audio/wav` URL over a **`voice:play`**
  event (`preload` exposes `onVoicePlay`). The renderer plays it through an
  `Audio` element, driving the reactor `.speaking` pulse on play/end. All knobs
  are config-read: `voice.piper.{model,lengthScale,noiseScale,noiseW,sentenceSilence}`
  and `voice.piper.postProcess.{semitones,lowShelf*,highShelf*,comp*}`. If ffmpeg
  is absent, main falls back to plain Piper WAV (no deepening).
- **`browser`** — the Web Speech API (`speechSynthesis`, rate 1.08 / pitch 0.88),
  used as an automatic fallback if Piper/ffmpeg fail, or if `engine` is `"browser"`.

Both engines are git-ignored under `vendor/` (Piper + model + ffmpeg, large
binaries); restore with `npm run setup-voice` (script in `scripts/`). Packaging
copies them to `resources/{piper,ffmpeg}` via `build.extraResources`; main
resolves the dirs with `app.isPackaged`. CSP needed `media-src 'self' data:` for
the audio to play. The first startup greeting may be silent until a user gesture
(Chromium autoplay). The audio is handed over as a data URL, not a file path,
because the sandboxed renderer can't load `file://` under our CSP.

## Power down

Top-bar `⏻ POWER` button → `powerDown()` in renderer.js: farewell line (spoken if
voice on), body fade via `.powering-down`, then `window.jarvis.quit()` → `app:quit`
IPC → `app.quit()`. Falls back to `window.close()` if IPC fails (e.g. stale main
process), so the window never sticks half-faded.

## Spotify feature

- **Auth:** Authorization Code + PKCE (no client secret). A one-shot loopback HTTP
  server on `redirectPort` captures the OAuth `?code`; tokens saved to
  `userData/spotify-tokens.json` (mode 600) and auto-refreshed.
- **IPC handlers (main.js):** `spotify:state` (auth + now-playing), `spotify:login`,
  `spotify:logout`, `spotify:playlists`, `spotify:control` (next/previous/play/pause),
  `spotify:play` (start a context_uri).
- **UI:** "MEDIA" panel at top of the right column — album art, track/artist, smoothed
  progress bar, transport controls, clickable playlists (**capped at 5** so the panel
  doesn't squeeze the sections below it). Polls `spotify:state` every 4s.
- **Premium gating:** now-playing + playlists work on any account; transport/play-context
  need Premium and an active device (handlers return clear 403/404 messages).
- Setup: app at developer.spotify.com/dashboard with Redirect URI exactly
  `http://127.0.0.1:8888/callback`; clientId in config.json.
- Status: **verified working end-to-end** (now-playing, playlists, transport).

## Email (COMMS panel)

IMAP unread check via `imapflow` (`email:check` in main.js). Needs an *app password*
(Gmail: myaccount.google.com/apppasswords, requires 2FA). Outlook personal accounts
are unreliable — Microsoft is retiring basic IMAP auth; prefer Gmail.

## Distribution

`npm run dist` → `dist\JARVIS Dashboard Setup 1.0.0.exe` (one-click NSIS).
- The installer bundles the **clean `config.example.json`** (not personal `config.json`,
  which is excluded from `build.files`) plus the voice engine (`vendor/piper` + `vendor/ffmpeg`
  via `extraResources`). It ships **no secrets** — each install seeds its own
  `userData/config.json` on first run, configured via the in-app Settings page. So
  `vendor/` must be populated (`npm run setup-voice`) before building.
- Installer is large (~300 MB) because it bundles ffmpeg + the Piper model.
- Unsigned → SmartScreen warning on other machines.
- The Claude console requires the `claude` CLI on the target machine; everything else
  works standalone.
- No app icon yet — electron-builder warns and falls back to the default Electron icon.

## Conventions

- Keep replies/spoken text plain (no markdown) — JARVIS reads responses aloud.
- New remote calls go through main + IPC, not direct from renderer.
- Match existing code style: terse section banners, plain-spoken comments.
- Never commit `config.json` or `dist/` (both carry secrets); they're git-ignored.

## Session log — 2026-06-10

Big session. All committed and pushed to `origin/main` (commits `ce50180`,
`7e948fa`); installer built. State at end of session:

- **Fixed npm install** — failure was a corrupt npm cache (`ERR_SSL_CIPHER_OPERATION_FAILED`),
  not a code issue. `npm cache clean --force` + reinstall fixed it. Note: on this
  machine the project is at the **workspace root**, not the nested folder the top of
  this file describes (that note reflects a different clone).
- **Neural voice (Piper + ffmpeg)** — replaced the robotic Web Speech voice with a
  bundled offline Piper TTS (`en_GB-alan-medium`) deepened/warmed via an ffmpeg chain
  (pitch/EQ/compression + a faint robotic sheen). See the **Voice** section. Current
  tuning in config: `semitones 0` (user set), `lengthScale 0.90`, `noiseScale 0.33`,
  robotic comb+flanger on. Binaries live in git-ignored `vendor/` — restore with
  `npm run setup-voice`.
- **Settings page** — in-app ⚙ overlay (top bar) so non-technical users configure
  everything without editing JSON. `config:save` writes + hot-swaps config. See the
  **config.json** bullet under Architecture.
- **Distribution hardening** — config moved to writable `userData` on packaged builds
  (seeded from `config.example.json` on first run); installer bundles the clean template
  + voice engine, **no secrets**. `signAndEditExecutable: false` in `build.win` works
  around electron-builder's winCodeSign symlink failure on Windows. Built
  `dist\JARVIS Dashboard Setup 1.0.0.exe` (~193 MB).
- **Power-down fix** — farewell now waits for the audio to finish before quitting
  (was clipped by the async Piper playback).

## Ideas / next steps

- 💡 Custom app icon (`.ico`) from `preview.png` — currently uses the default Electron
  icon; would also let `signAndEditExecutable` re-enable exe metadata stamping.
- 💡 Test-install the built `.exe` to confirm first-run config seeding works end-to-end
  on a clean machine.
- 💡 Per-field "test" buttons in settings (e.g. test the IMAP email connection).
- 💡 Voice-driven playlists via the Claude console ("play my Focus playlist") —
  map a Claude intent to `spotify:play`.
- 💡 Code signing — unsigned installer trips SmartScreen on other machines.
