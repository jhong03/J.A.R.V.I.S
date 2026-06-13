# JARVIS Dashboard

A JARVIS-inspired personal desktop dashboard (Electron) with live system telemetry,
a clock/arc-reactor centerpiece, weather, an embedded Claude Code
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
  session id for memory), Spotify, and the `app:quit` handler for graceful shutdown.
- **preload.js** — context-isolated bridge. Exposes a single `window.jarvis` object;
  the renderer never touches Node directly. Add a method here for every new IPC handler.
- **src/index.html / styles.css / renderer.js** — the UI. Renderer talks only through
  `window.jarvis.*`.
- **config.json** — all feature toggles and secrets. Features are off by default and
  gated on an `enabled` flag (see weather/spotify). **Git-ignored** (may hold
  personal values); `config.example.json` is the committed template — keep it in
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
  and `voice.piper.postProcess.{semitones,lowShelf*,highShelf*,comp*,robotic.*}` —
  the `robotic` block stacks comb echo (`aecho`), `flanger`, and `chorus`
  (detuned doubling, the strongest "synthetic AI" tell) for the futuristic edge.
  If ffmpeg is absent, main falls back to plain Piper WAV (no deepening).
- **`browser`** — the Web Speech API (`speechSynthesis`, rate 1.08 / pitch 0.88),
  used as an automatic fallback if Piper/ffmpeg fail, or if `engine` is `"browser"`.

Both engines are git-ignored under `vendor/` (Piper + model + ffmpeg, large
binaries); restore with `npm run setup-voice` (script in `scripts/`). Packaging
copies them to `resources/{piper,ffmpeg}` via `build.extraResources`; main
resolves the dirs with `app.isPackaged`. CSP needed `media-src 'self' data:` for
the audio to play. The first startup greeting may be silent until a user gesture
(Chromium autoplay). The audio is handed over as a data URL, not a file path,
because the sandboxed renderer can't load `file://` under our CSP.

## Voice orb (centerpiece)

The reactor centerpiece pulses with the **actual** JARVIS voice, not a timed
animation. `playVoiceClip()` (renderer) routes the playing Piper `Audio` element
through a Web Audio `AnalyserNode` (`connectOrbSource`); while speaking, an rAF
loop (`drawOrb`) reads the time-domain data and paints a circular waveform +
amplitude-scaled glow onto `#orb-canvas`. **rAF runs only while speaking** — at
rest the canvas is clear and a pure-CSS `#orb-glow` breathing shows through (no
idle main-thread cost, learned from the cursor jank saga). Browser-engine speech
has no tappable stream, so it falls back to the generic `.speaking` CSS pulse;
`prefers-reduced-motion` skips the canvas. The reactor still cycles
CHRONO/MEDIA/DIAG faces on click — the orb layer sits behind them.

## Advanced Mode (full-screen page)

Triple-click the reactor core (3 clicks <650ms) runs a transition into a
**full-screen Advanced page** — NOT a modal. Triple-click empty space on the
advanced page (or Esc / EXIT) reverses it. State machine `advState`
(`'dashboard' | 'transitioning' | 'advanced'`) guards re-entry; trigger wiring is
`tripleClick()` in boot (reactor → forward, `#advanced-overlay` bg → reverse).

**Transition (renderer `playEnter`/`playExit`, pure CSS — no WebGL).** A Möbius/
Three.js version was built and then **scrapped at the user's request** (looked off
across several iterations); `three.min.js` was deleted. Current:
- **Enter** (`playEnter`): `body.adv-entering` whirls the reactor side rings up
  (`.ring-outer/mid/inner` animation-duration → 4s/2s/1s) and presses the core down
  (`#reactor` → `scale(0.84)`), `#hud-shock` fires; after ~850ms `body.adv-out` fades
  the dashboard away (opacity+scale+blur) and `#advanced-overlay.shown` fades the page in.
- **Exit** (`playExit`): just removes `.shown` + `.adv-out` so the page fades out and the
  dashboard slowly returns — no ring spin / press (user wanted exit plain).

Advanced page content (`#advanced-page`, full-bleed, amber "restricted core" theme,
corner brackets, header with live `#adv-clock` + EXIT, responsive `.adv-panel` grid):
- **Voice Lab** — live sliders (`ADV_VOICE` spec, get/`setByPath` into a config clone)
  for every `voice.piper`/`postProcess`/`robotic` knob. **Test** auditions via the
  `voice:test` IPC with **unsaved overrides** (never persists — main's `synthVoice(sender,
  text, piperCfg)` is shared by `voice:speak` and `voice:test`); **Save** persists via
  `config:save`.
- **Alert Tuning** — thresholds + `alerts.sustainPolls` + `alerts.cooldownMin` (now
  config-read by `sustainedAlert()`, not hardcoded).
- **Diagnostics** — versions/paths/engine status from a new `sys:diag` IPC, live
  `lastStats`, Spotify auth, a renderer `errorLog`; REFRESH + RELOAD UI.
- **Reserved block** (`.adv-reserved`) — user wants to discuss MORE tools to add here.

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

## Email — REMOVED (2026-06-12)

The IMAP/COMMS feature was **removed entirely** at the user's request (panel, settings
section, `email:check`/`email:test` handlers, `imapflow` dependency, config keys).
Context: Microsoft killed password/app-password IMAP for personal Outlook accounts
(Sept 2024) — live-tested, `AUTHENTICATE failed` for both the primary address and the
login alias — and the user opted to drop email rather than switch to Gmail or build
OAuth2. Don't resurrect it without being asked; OAuth2 (Azure app + XOAUTH2) is the
only viable Outlook path if it ever comes back.

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

## Session log — 2026-06-11

All renderer-only (`src/`), **uncommitted at end of session** — review + commit next time.

- **Panel bracket fix** — the corner brackets are `::before/::after` on `.panel`, which
  was also the scroll container, so they scrolled away with overflowing content (e.g.
  MEDIA full of playlists). Now `.panel` is a non-scrolling frame (`overflow: hidden`,
  flex column) holding the brackets; new inner `.panel-scroll` div (both side panels)
  owns `overflow-y` + the 14/16px padding.
- **Spoken alerts completed** — new `sustainedAlert()` helper in renderer.js: a reading
  must stay hot 3 consecutive polls (~9s at the 3s cadence) before speaking; re-arm via
  timeout. CPU moved onto it (was single-sample), memory (`alerts.memPercent`, was
  gauge-color only) and disk ≥95% (once per session, no re-arm) now speak too. Battery
  untouched (condition-based re-arm).
- **Reactor is now a real `<button>`** that cycles core faces: **CHRONO → MEDIA → DIAG**.
  Stark-HUD interactions: hover = corner reticle brackets lock in + conic radar sweep
  ring + disc brightens + `◂ MODE ▸` tag; press = 3% compression + shockwave ring;
  switch = `steps(1)` digital flicker, tick flare, WebAudio chirp (`blip()`, no asset,
  fail-safe). All have `prefers-reduced-motion` fallbacks. New modes: append to
  `CORE_MODES` + a `.core-face` div + `CORE_FACES` entry.
- **MEDIA face** — mini time/date up top (driven from `tickClock`), circular album art,
  track/artist, and a **playback progress ring** (`#mr-bar`, r=105, C=660) sweeping the
  inner orbit, driven by `tickSpotifyProgress` with a 1s linear stroke transition; the
  static bright arc dims to 15% in this mode. `sp` now caches title/artist/image.
- **DIAG face** — CPU/MEM micro-bars + NET ▼▲ + uptime inside the glow disc, fed from
  `lastStats` each poll while active.
- **Crash fix — transient TLS resets** (committed `6fdb073`, in the rebuilt installer).
  After prolonged uptime the app crashed with a dialog: `Uncaught Exception: read
  ECONNRESET at TLSWrap.onStreamRead`. A long-lived TLS socket (Spotify's 4s poll, or
  IMAP) gets reset by the remote and undici surfaces it as an uncaught error not tied to
  any awaited request. Fix in main.js: `process.on('uncaughtException'/'unhandledRejection')`
  that swallows transient network errors (`isTransientNet()` — ECONNRESET/ETIMEDOUT/
  UND_ERR_* etc.) and logs the rest without quitting; plus a `client.on('error')` guard on
  the ImapFlow client. Note: user's Outlook IMAP is the likely flaky source (MS is
  retiring basic IMAP auth) — Gmail app password is steadier.
- **Chat streaming** — the console felt slow: it spawned `claude -p --output-format json`
  and waited for the *whole* response before showing anything (measured ~17s cold / ~6s
  warm even for a one-word reply — that's CLI cold-start + model, not the dashboard).
  Now main runs `--output-format stream-json --verbose --include-partial-messages`, parses
  the NDJSON event stream, and forwards `text_delta` chunks over a new `claude:delta`
  channel; renderer fills the JARVIS bubble token-by-token (`streamBubble` + `setBubbleText`),
  then settles on the authoritative `result` text and speaks it. Perceived latency only —
  the model round-trip is unchanged; first message of a session is slowest (MCP init).
- **MEDIA label fix** — `#core-mode-tag` ("CHRONO/MEDIA/DIAG") sat at `top:66%` visible at
  rest, so in MEDIA mode "MEDIA" crowded under the song title. Now hidden at rest
  (`opacity:0`), shown only on hover/focus (where it already gained `◂ ▸` arrows); nudged to
  `top:72%`.
- **Voice tuned + settled** — several rounds with the user. Reference target was the actual
  movie JARVIS (Paul Bettany — YouTube `6i5hho2aD-E`); user chose to stay offline and tune
  Piper toward the *character* rather than wire ElevenLabs for a true match. Final direction:
  natural expressive intonation (`noiseScale 0.72`, `noiseW 0.85`), neutral pitch
  (`semitones 0`, low shelf trimmed — earlier passes were too bassy/flat), measured pace
  (`lengthScale 0.98`, `sentenceSilence 0.28`), robotic sheen back ON via comb+flanger plus a
  **new `chorus` stage in the ffmpeg chain** (`buildVoiceFilter` in main.js;
  `robotic.{chorusDepth,chorusDelayMs,chorusSpeed}`) for the synthetic doubling. Values synced
  into `config.example.json` so installs ship this sound.
- **HUD targeting-cursor (Iron Man reticle)** — user asked for a crosshair cursor. First
  build was a JS-tracked SVG overlay (mousemove → rAF transform): it **froze every 3 s**
  while everything else stayed smooth. Two partial fixes failed (removing the always-on
  spin animation; caching telemetry). Root lesson: in Electron, mouse input routes through
  the main process → renderer main thread, so *any* periodic work shows up as JS-cursor
  stutter — a tracked overlay is unfixable in principle. Final approach: the reticle is a
  **real OS custom cursor** (`cursor: url('assets/reticle.svg') 16 16`) rendered by the
  system compositor — immune to app jank. Hover over interactive controls swaps to
  `reticle-lock.svg` (tighter brackets, dashed inner ring) via plain CSS; a one-shot
  `#click-pulse` ring (positioned on mousedown by `initClickPulse()`) gives fire feedback.
  Cursor SVGs must stay **32 px** — Chromium rejects larger cursors near viewport edges.
- **Telemetry poll lightened** (kept even though it wasn't the cursor cause) — on Windows
  several `systeminformation` calls shell out to wmic/PowerShell; `stats:get` now fetches
  `osInfo` once and caches `fsSize` 30 s / `battery` 15 s, leaving only
  currentLoad/mem/networkStats on the 3 s hot path.

## Session log — 2026-06-12

- **Email feature removed end-to-end** (see "Email — REMOVED" above for the why and the
  full inventory). Came out of debugging the recurring `IMAP connection error: read
  ECONNRESET`: live IMAP test showed Outlook rejects app passwords outright
  (`AUTHENTICATE failed` for both the primary address and the login alias — MS killed
  basic auth for personal accounts Sept 2024). Built a TEST CONNECTION button + clear
  error surfacing first, then the user chose full removal instead; that intermediate
  work was removed again with the feature (never committed).
- **Settings drag-select fix** — drag-selecting text that ended over the dimmed backdrop
  closed the settings overlay: `click` fires on the *common ancestor* of mousedown/mouseup,
  i.e. the overlay. Now closes only if the press also started on the backdrop. Bonus:
  `#settings-modal { user-select: text }` (HUD disables selection globally) so settings
  text is selectable/copyable.

## Session log — 2026-06-13

Big feature session, **all committed + pushed** at the end. Touched `main.js`, `preload.js`,
`src/index.html`, `src/renderer.js`, `src/styles.css`, `config.json`, `config.example.json`.

- **Voice orb** — centerpiece pulses with the real voice via a Web Audio analyser + canvas
  waveform (see the **Voice orb** section). User picked "orb idle + keep faces on click".
- **Voice tweak** — slightly faster + a touch less robotic: `lengthScale 0.98→0.94`,
  `sentenceSilence 0.28→0.26`, `chorusDepth 2.5→2`, `flangerDepth 2→1.5`, `combDecay 0.22→0.18`.
- **Alert mechanism explained + made tunable** — `sustainedAlert()` is an intentional anti-nag
  debounce: over threshold for `alerts.sustainPolls` (3) consecutive polls, then muted for
  `alerts.cooldownMin` (5 min; disk once/session; battery until charging). Made sustain +
  cooldown config-driven so Advanced Mode can tune them.
- **Advanced Mode** — full-screen amber page (see its section): Voice Lab sliders, Alert Tuning,
  Diagnostics (`sys:diag` IPC), reserved block. Triple-click to enter.
- **Möbius transition: built then SCRAPPED.** Spent a long arc trying a Three.js Möbius that
  morphs from the reactor core (wireframe → normal-arrows → solid ribbon → wind-up-from-flat-ring,
  fixed horizontal). User never liked it; finally asked to remove it entirely. Replaced with a
  simple CSS transition: rings spin up + core presses down + dashboard fades → advanced; exit just
  fades back. `three.min.js` deleted. **Lesson: the user wanted a subtle in-place reactor effect,
  not a 3D set-piece — don't reach for WebGL/Three.js here again unless asked.**
- **Test Voice = audition only** — `voice:test` IPC plays the slider values with **unsaved
  overrides** so users never lose their saved voice settings (was accidentally saving before).

## Ideas / next steps

- 💬 **Advanced Mode — more tools wanted** (user flagged): brainstorm additional power-user
  features for the reserved block (e.g. log viewer, config import/export, theme toggles,
  voice A/B presets, manual telemetry refresh, restart-to-engine switch).
- 🧪 **Tune the new Advanced transition feel** if the user wants — ring whirl speed (4s/2s/1s),
  core press depth (`scale(0.84)`), the ~850ms beat before the fade, fade speed (0.7s).
- 📦 **Rebuild the installer** — `npm run dist` so the `.exe` includes today's work (orb, voice,
  Advanced Mode, new transition). The built installer predates all of it.
- 🎚️ **Voice — settled for now** ("sounds ok"); user may want another pass later. Knobs in
  `config.json` → `voice.piper` + `postProcess` (incl. the `robotic.chorus*` stage); current
  values are mirrored in `config.example.json`. Restart needed after edits (config read once
  at startup). If a true movie-JARVIS match is ever wanted, ElevenLabs as a third engine is
  the path.

- 💡 **Discussed this session, user interested:** voice input (whisper.cpp in `vendor/`,
  push-to-talk), Claude intent routing (map console replies to existing IPC handlers),
  spoken morning briefing on boot, calendar panel via ICS URL, tray icon + global
  summon hotkey, boot-sequence animation, UI sound design.
- 💡 Possible polish on today's work: collapse the MEDIA panel's now-playing block when
  the core is in media mode (info is duplicated); FOCUS timer as a fourth core face;
  nudge `#core-mode-tag` top % if it crowds the date line.
- 💡 Custom app icon (`.ico`) from `preview.png` — currently uses the default Electron
  icon; would also let `signAndEditExecutable` re-enable exe metadata stamping.
- 💡 Test-install the built `.exe` to confirm first-run config seeding works end-to-end
  on a clean machine.
- 💡 Per-field "test" buttons in settings (e.g. verify the weather coordinates).
- 💡 Voice-driven playlists via the Claude console ("play my Focus playlist") —
  map a Claude intent to `spotify:play`.
- 💡 Code signing — unsigned installer trips SmartScreen on other machines.
