# JARVIS Dashboard

A personal, JARVIS-inspired desktop command center for Windows. Dark holographic interface, live system telemetry, an arc-reactor clock, weather, notifications, email, app shortcuts — and a console wired to your locally installed Claude Code, with spoken replies in a calm British voice.

![Preview](preview.png)

---

## 1. Prerequisites

1. **Node.js 18+** — https://nodejs.org (LTS is fine). Verify with `node -v`.
2. **Claude Code** installed and signed in:
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
   Run `claude` once in a terminal and complete the login. The dashboard talks to this same CLI, so if `claude -p "hello"` works in your terminal, the dashboard will work too.
   Docs: https://docs.claude.com/en/docs/claude-code/overview
3. **A UK English voice (optional but recommended)** — Windows Settings → Time & Language → Speech → Manage voices → add **English (United Kingdom)**. The dashboard auto-selects it for that composed, butler-AI delivery.

## 2. Install & run

```
cd jarvis-dashboard
npm install
npm start
```

First launch downloads Electron (~100 MB, one time). The dashboard greets you out loud and goes live.

To build an installable .exe:

```
npm run dist
```

The installer lands in the `dist/` folder.

## 3. Configure — `config.json`

Everything personal lives in one file. Edit it, restart the app.

| Key | What it does |
|---|---|
| `assistantName`, `userTitle` | Branding and how it addresses you ("sir", "boss", your name…) |
| `voice.preferredVoiceContains` | Substring matched against installed voice names, e.g. `"United Kingdom"` or `"Ryan"` |
| `voice.rate` / `voice.pitch` | Speaking speed and depth (0.9 pitch ≈ composed and low) |
| `claude.workingDir` | The folder Claude Code operates in. Point it at a projects folder to scope its reach |
| `claude.allowedTools` | Tools Claude may use **without asking**. Default `Read,Glob,Grep` = it can look but not touch |
| `claude.personality` | The persona injected at the start of every session |
| `shortcuts` | Quick-access tiles. `target` can be an .exe name, full path, URL, or `ms-settings:` page |
| `email` | IMAP unread checker (see below) |
| `weather` | Open-Meteo coordinates — free, no API key |
| `alerts` | Thresholds for spoken CPU / memory / battery warnings |

### Letting JARVIS actually do things

By default Claude Code runs **read-only** from the dashboard — it can search and read files but not modify anything or run commands. To let it act, expand `claude.allowedTools`, for example:

```json
"allowedTools": "Read,Glob,Grep,Write,Edit,Bash(git *)"
```

Add capabilities deliberately and keep `workingDir` scoped to folders you're comfortable with — anything you allow here runs without a confirmation prompt. Permission syntax: https://docs.claude.com/en/docs/claude-code/overview

### Email (optional)

Set `email.enabled` to `true` and fill in IMAP details. For Gmail, create an **App Password** (Google Account → Security → 2-Step Verification → App passwords) — never your real password. The COMMS panel then shows unread count and the latest senders, and JARVIS announces new mail aloud.

> Note on notifications: Windows does not let apps read *other* apps' toast notifications, so the NOTIFICATIONS panel is the dashboard's own feed — system alerts (high CPU, low battery), new mail, launches, and anything JARVIS wants to tell you.

## 4. Using the console

- Type and hit **Enter** / **EXECUTE**. Replies stream into the log and are spoken aloud; the reactor core pulses while JARVIS speaks.
- The conversation has memory — follow-ups work ("now rename it", "what about the second one"). **NEW SESSION** starts fresh.
- **VOICE: ON/OFF** mutes speech without disabling it in config.
- Tasks run through Claude Code with your machine as context: "find the largest files in my Downloads folder", "summarize the README in my project", "draft a .gitignore for a Python project and save it" (requires Write permission).

## 5. Ideas to extend

- **Voice input**: add push-to-talk via a local speech-to-text like Vosk or whisper.cpp, feeding the transcript into the same console.
- **Always-on display**: uncomment `win.setFullScreen(true)` in `main.js` and run it on a spare monitor.
- **Auto-start**: drop a shortcut to `npm start` (or the built .exe) into `shell:startup`.

## A note on the theme

The interface is an original design *inspired by* the holographic style of cinematic AI assistants — it uses no studio assets, and the voice is a standard system/web TTS voice, not an imitation of any actor. It's built for personal use.
