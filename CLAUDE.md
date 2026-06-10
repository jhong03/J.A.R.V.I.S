# JARVIS Dashboard

A JARVIS-inspired personal desktop dashboard (Electron) with live system telemetry,
a clock/arc-reactor centerpiece, weather, optional IMAP email, an embedded Claude Code
console, and Spotify now-playing + playlists.

## ⚠️ Project lives in a nested folder

The real project (package.json, main.js, src/) is at
`C:\Users\User\Downloads\jarvis-dashboard\jarvis-dashboard\` — one level below the
workspace root. The workspace root has an unrelated placeholder package.json with no
`start` script.

Run npm against the nested dir:
```
npm install --prefix .\jarvis-dashboard
npm start   --prefix .\jarvis-dashboard      # runs "electron ."
```
First install downloads a ~110 MB Electron binary (slow, not a hang).

## Architecture

- **main.js** — Electron main process. Owns the window and all Node-side capability:
  system telemetry (`systeminformation`), app launching (allow-listed against config
  shortcuts), the Claude Code CLI bridge (`claude -p --output-format json`, resumes a
  session id for memory), optional IMAP email (`imapflow`), and Spotify.
- **preload.js** — context-isolated bridge. Exposes a single `window.jarvis` object;
  the renderer never touches Node directly. Add a method here for every new IPC handler.
- **src/index.html / styles.css / renderer.js** — the UI. Renderer talks only through
  `window.jarvis.*`. Visual system: cyan reactor theme, Rajdhani + Share Tech Mono.
- **config.json** — all feature toggles and secrets. Features are off by default and
  gated on an `enabled` flag (see weather/email/spotify).

Design rule: **all privileged work happens in main**; the renderer gets data via IPC.
Tokens/passwords never reach the renderer. CSP in index.html is tight — when adding a
remote image/host, widen the specific directive (e.g. `img-src` for album art).

## Spotify feature (added this session)

- **Auth:** Authorization Code + PKCE (no client secret). A one-shot loopback HTTP
  server on `redirectPort` captures the OAuth `?code`; tokens saved to
  `userData/spotify-tokens.json` (mode 600) and auto-refreshed.
- **IPC handlers (main.js):** `spotify:state` (auth + now-playing), `spotify:login`,
  `spotify:logout`, `spotify:playlists`, `spotify:control` (next/previous/play/pause),
  `spotify:play` (start a context_uri).
- **UI:** "MEDIA" panel at top of the right column — album art, track/artist, a locally
  smoothed progress bar, transport controls, and clickable playlists. Polls `spotify:state`
  every 4s, ticks the progress bar every 1s.
- **Premium gating:** now-playing + playlists work on any account; transport/play-context
  need Premium and an active device (handlers return clear 403/404 messages).
- **Config block** (`config.json`):
  ```json
  "spotify": { "enabled": true, "clientId": "<id>", "redirectPort": 8888 }
  ```

### One-time setup (developer.spotify.com/dashboard)
1. Create an app, copy the **Client ID** (already filled into config.json).
2. Add Redirect URI **exactly** `http://127.0.0.1:8888/callback` in the app settings.
3. With `spotify.enabled: true`, restart, click **CONNECT SPOTIFY**, authorize in browser.

## Current state / next steps

- ✅ Spotify code complete; all files syntax-check; app boots cleanly.
- ✅ User enabled Spotify in config and added a real `clientId`.
- ⬜ **Not yet verified end-to-end:** the user must register the redirect URI in the
  Spotify dashboard, then test the CONNECT SPOTIFY → authorize → now-playing flow.
- 💡 Optional idea raised: let JARVIS start playlists by voice via the Claude console
  ("play my Focus playlist") — would map a Claude intent to `spotify:play`.

## Conventions

- Keep replies/spoken text plain (no markdown) — JARVIS reads responses aloud.
- New remote calls go through main + IPC, not direct from renderer.
- Match existing code style: terse section banners, plain-spoken comments.
