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
  sync when adding config keys.

Design rule: **all privileged work happens in main**; the renderer gets data via IPC.
Tokens/passwords never reach the renderer. CSP in index.html is tight — when adding a
remote image/host, widen the specific directive (e.g. `img-src` for album art).

## Visual system

Bright HUD restyle (palette documented at the top of styles.css): cyan `#4DDDFF` on
deep blue-black, muted labels `#8FB6CC` (kept ≥4.5:1 contrast — don't dim them back),
blueprint grid background, glowing corner brackets on panels, chamfered (clip-path)
buttons, solid-cyan EXECUTE as the one primary CTA. Fonts: Rajdhani + Share Tech Mono.
`prefers-reduced-motion` fallbacks exist for every animation — preserve them.

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

`npm run dist` → `dist\JARVIS Dashboard Setup 1.0.0.exe` (one-click NSIS, ~75 MB).
- The installer **bundles config.json including secrets** — blank them before building
  for anyone else.
- Unsigned → SmartScreen warning on other machines.
- The Claude console requires the `claude` CLI on the target machine; everything else
  works standalone.
- No app icon yet (`author` also missing in package.json) — electron-builder warns.

## Conventions

- Keep replies/spoken text plain (no markdown) — JARVIS reads responses aloud.
- New remote calls go through main + IPC, not direct from renderer.
- Match existing code style: terse section banners, plain-spoken comments.
- Never commit `config.json` or `dist/` (both carry secrets); they're git-ignored.

## Ideas / next steps

- 💡 Voice-driven playlists via the Claude console ("play my Focus playlist") —
  map a Claude intent to `spotify:play`.
- 💡 App icon + `author` field in package.json for a cleaner installer.
