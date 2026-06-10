// JARVIS Dashboard — Electron main process
// Owns: the window, system telemetry, app launching, the Claude Code bridge,
// and the optional IMAP email check. The renderer never touches Node directly.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const si = require('systeminformation');

// ---------------------------------------------------------------- config ---
const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error('Could not read config.json:', e.message);
}

// ---------------------------------------------------------------- window ---
function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#04080f',
    autoHideMenuBar: true,
    title: 'JARVIS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // win.setFullScreen(true); // uncomment for the full cinematic experience
}

app.whenReady().then(() => { loadSpotifyTokens(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------------------------------------------------------------- config ---
ipcMain.handle('config:get', () => config);

// ------------------------------------------------------------- telemetry ---
ipcMain.handle('stats:get', async () => {
  try {
    const [load, mem, fsSize, battery, net, os, time] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.battery(),
      si.networkStats(),
      si.osInfo(),
      Promise.resolve(si.time())
    ]);

    const mainDisk = fsSize && fsSize.length
      ? fsSize.reduce((a, b) => (b.size > a.size ? b : a))
      : null;
    const netIface = net && net.length ? net[0] : null;

    return {
      ok: true,
      cpu: Math.round(load.currentLoad || 0),
      cores: (load.cpus || []).map(c => Math.round(c.load)),
      memUsedPct: Math.round((mem.active / mem.total) * 100),
      memUsedGb: (mem.active / 1073741824).toFixed(1),
      memTotalGb: (mem.total / 1073741824).toFixed(1),
      diskPct: mainDisk ? Math.round(mainDisk.use) : 0,
      diskFreeGb: mainDisk ? ((mainDisk.size - mainDisk.used) / 1073741824).toFixed(0) : '0',
      battery: {
        has: !!battery.hasBattery,
        pct: Math.round(battery.percent || 0),
        charging: !!battery.isCharging
      },
      netRxSec: netIface ? netIface.rx_sec : 0,
      netTxSec: netIface ? netIface.tx_sec : 0,
      hostname: os.hostname,
      distro: os.distro,
      uptimeSec: time.uptime
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ------------------------------------------------------------ power down ---
// The renderer plays its shutdown sequence first, then asks us to quit.
ipcMain.handle('app:quit', () => { app.quit(); });

// ------------------------------------------------------------- shortcuts ---
ipcMain.handle('apps:launch', async (_e, target) => {
  // Only launch targets that exist in config.json — the renderer cannot
  // ask the main process to run arbitrary strings.
  const allowed = (config.shortcuts || []).some(s => s.target === target);
  if (!allowed) return { ok: false, error: 'Target not in configured shortcuts.' };
  try {
    if (/^https?:\/\//i.test(target) || /^ms-settings:/i.test(target)) {
      await shell.openExternal(target);
    } else {
      // Resolves through the shell so bare names like "notepad.exe" work.
      spawn(target, { shell: true, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ------------------------------------------------------ Claude Code bridge ---
// Runs the locally installed Claude Code CLI in print mode:
//   claude -p --output-format json [--resume <id>] [--allowedTools ...]
// The prompt is written to stdin (never interpolated into the command line),
// and the JSON response gives us the text plus a session_id we reuse so the
// conversation has memory across messages.
let claudeSessionId = null;

ipcMain.handle('claude:ask', async (_e, userPrompt) => {
  const c = config.claude || {};
  const cmd = c.command || 'claude';

  const args = ['-p', '--output-format', 'json'];
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  if (c.allowedTools) args.push('--allowedTools', c.allowedTools);

  // Personality is injected once, at the start of a fresh session.
  const prompt = claudeSessionId || !c.personality
    ? userPrompt
    : `[Persona for this whole conversation: ${c.personality}]\n\n${userPrompt}`;

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, {
        shell: true, // claude is a .cmd shim on Windows
        cwd: c.workingDir || app.getPath('home'),
        windowsHide: true,
        env: process.env
      });
    } catch (e) {
      return resolve({ ok: false, text: `Could not start Claude Code: ${e.message}` });
    }

    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve({ ok: false, text: 'Claude Code timed out after 180 seconds, sir.' });
    }, 180000);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timeout);
      resolve({ ok: false, text: `Could not start Claude Code: ${e.message}. Is it installed and on your PATH?` });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(out);
        if (parsed.session_id) claudeSessionId = parsed.session_id;
        resolve({ ok: true, text: parsed.result || '(empty response)' });
      } catch (_) {
        const fallback = out.trim() || err.trim();
        resolve({
          ok: code === 0 && !!fallback,
          text: fallback || `Claude Code exited with code ${code} and no output.`
        });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
});

ipcMain.handle('claude:reset', () => {
  claudeSessionId = null;
  return { ok: true };
});

// ------------------------------------------------------------------ email ---
// Optional IMAP unread check. Off by default; enable in config.json.
ipcMain.handle('email:check', async () => {
  const ec = config.email || {};
  if (!ec.enabled) return { ok: false, disabled: true };
  try {
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: ec.host,
      port: ec.port || 993,
      secure: true,
      auth: { user: ec.user, pass: ec.password },
      logger: false
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let unseenCount = 0;
    const latest = [];
    try {
      const unseen = await client.search({ seen: false });
      unseenCount = unseen.length;
      const recent = unseen.slice(-5).reverse();
      for await (const msg of client.fetch(recent, { envelope: true })) {
        latest.push({
          from: (msg.envelope.from && msg.envelope.from[0] &&
                 (msg.envelope.from[0].name || msg.envelope.from[0].address)) || 'Unknown',
          subject: msg.envelope.subject || '(no subject)',
          date: msg.envelope.date
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, unseen: unseenCount, latest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------- spotify ---
// Optional Spotify integration — "now playing" plus your playlists.
// Off by default. To enable: set spotify.enabled and a clientId in config.json,
// then register http://127.0.0.1:<redirectPort>/callback as a Redirect URI for
// your app at https://developer.spotify.com/dashboard.
// Auth is the Authorization Code + PKCE flow, so no client secret is stored.
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

let spotifyTokens = null;     // { access_token, refresh_token, expires_at }
let spotifyAuthServer = null; // the transient loopback server during login

function spotifyTokenPath() { return path.join(app.getPath('userData'), 'spotify-tokens.json'); }

function loadSpotifyTokens() {
  try { spotifyTokens = JSON.parse(fs.readFileSync(spotifyTokenPath(), 'utf8')); }
  catch (_) { spotifyTokens = null; }
}
function saveSpotifyTokens(t) {
  spotifyTokens = t;
  try { fs.writeFileSync(spotifyTokenPath(), JSON.stringify(t), { mode: 0o600 }); }
  catch (e) { console.error('Could not save Spotify tokens:', e.message); }
}
function clearSpotifyTokens() {
  spotifyTokens = null;
  try { fs.unlinkSync(spotifyTokenPath()); } catch (_) {}
}

function spotifyCfg() {
  const s = config.spotify || {};
  const port = s.redirectPort || 8888;
  return { ...s, port, redirectUri: `http://127.0.0.1:${port}/callback` };
}

// base64url for PKCE — no '+', '/', or '=' padding.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function refreshSpotifyToken() {
  const sc = spotifyCfg();
  if (!spotifyTokens || !spotifyTokens.refresh_token) throw new Error('Not authenticated');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: spotifyTokens.refresh_token,
      client_id: sc.clientId
    })
  });
  if (!r.ok) {
    // 400/401 here means the grant was revoked — drop it so the UI re-prompts.
    if (r.status === 400 || r.status === 401) clearSpotifyTokens();
    throw new Error(`Token refresh failed (${r.status})`);
  }
  const j = await r.json();
  saveSpotifyTokens({
    access_token: j.access_token,
    refresh_token: j.refresh_token || spotifyTokens.refresh_token, // Spotify may omit it
    expires_at: Date.now() + (j.expires_in - 30) * 1000
  });
}

async function spotifyAccessToken() {
  if (!spotifyTokens) throw new Error('Not authenticated');
  if (!spotifyTokens.expires_at || Date.now() >= spotifyTokens.expires_at) {
    await refreshSpotifyToken();
  }
  return spotifyTokens.access_token;
}

// Thin Web API wrapper. Returns parsed JSON, or null for 204 (no content —
// e.g. nothing playing, or a successful playback command). Throws on errors,
// tagging the Error with .status so callers can special-case 403/404.
async function spotifyApi(endpoint, { method = 'GET', body } = {}) {
  const token = await spotifyAccessToken();
  const r = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// One-shot loopback OAuth: spin up a local server on the redirect port, open
// the consent screen in the user's browser, capture ?code, swap it for tokens.
function startSpotifyLogin() {
  return new Promise((resolve) => {
    const sc = spotifyCfg();
    if (!sc.clientId) return resolve({ ok: false, error: 'No Spotify clientId in config.json.' });

    const verifier  = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state     = b64url(crypto.randomBytes(16));

    if (spotifyAuthServer) { try { spotifyAuthServer.close(); } catch (_) {} spotifyAuthServer = null; }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { spotifyAuthServer.close(); } catch (_) {}
      spotifyAuthServer = null;
      resolve(result);
    };

    const replyPage = (msg) =>
      `<!doctype html><meta charset="utf-8"><body style="background:#04080f;color:#7FE9FF;` +
      `font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;` +
      `height:100vh;margin:0"><div style="text-align:center"><h2 style="letter-spacing:.2em">${msg}</h2>` +
      `<p style="color:#5A7E93">You can close this window and return to JARVIS.</p></div></body>`;

    spotifyAuthServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, sc.redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(replyPage('Authorization failed.'));
        return finish({ ok: false, error: 'Authorization was denied or the response was invalid.' });
      }
      try {
        const tr = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: sc.redirectUri,
            client_id: sc.clientId,
            code_verifier: verifier
          })
        });
        const tj = await tr.json();
        if (!tr.ok) throw new Error(tj.error_description || `Token exchange failed (${tr.status})`);
        saveSpotifyTokens({
          access_token: tj.access_token,
          refresh_token: tj.refresh_token,
          expires_at: Date.now() + (tj.expires_in - 30) * 1000
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(replyPage('Spotify connected.'));
        finish({ ok: true });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(replyPage('Connection failed.'));
        finish({ ok: false, error: e.message });
      }
    });

    spotifyAuthServer.on('error', (e) =>
      finish({ ok: false, error: `Local auth server error: ${e.message}` }));

    spotifyAuthServer.listen(sc.port, '127.0.0.1', () => {
      shell.openExternal('https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: sc.clientId,
        response_type: 'code',
        redirect_uri: sc.redirectUri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        scope: SPOTIFY_SCOPES
      }));
    });

    setTimeout(() => finish({ ok: false, error: 'Spotify login timed out.' }), 120000);
  });
}

ipcMain.handle('spotify:login', () => startSpotifyLogin());

ipcMain.handle('spotify:logout', () => { clearSpotifyTokens(); return { ok: true }; });

ipcMain.handle('spotify:state', async () => {
  const sc = spotifyCfg();
  if (!sc.enabled) return { ok: false, disabled: true };
  if (!sc.clientId) return { ok: false, error: 'No clientId configured.' };
  if (!spotifyTokens) return { ok: true, authed: false };
  try {
    const d = await spotifyApi('/me/player/currently-playing?additional_types=track,episode');
    if (!d || !d.item) return { ok: true, authed: true, playing: false };
    const it = d.item;
    const imgs = (it.album && it.album.images) || it.images || [];
    // images come largest-first; the ~300px middle one is crisp at panel size.
    const image = imgs.length ? (imgs[1] || imgs[0]).url : null;
    return {
      ok: true, authed: true, playing: true,
      isPlaying: !!d.is_playing,
      id: it.id,
      title: it.name,
      artist: (it.artists || []).map(a => a.name).join(', ') || (it.show && it.show.name) || '',
      album: (it.album && it.album.name) || '',
      image,
      progressMs: d.progress_ms || 0,
      durationMs: it.duration_ms || 0
    };
  } catch (e) {
    if (!spotifyTokens) return { ok: true, authed: false }; // grant was cleared mid-refresh
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('spotify:playlists', async () => {
  const sc = spotifyCfg();
  if (!sc.enabled || !spotifyTokens) return { ok: false };
  try {
    const d = await spotifyApi('/me/playlists?limit=20');
    const items = (d.items || []).filter(Boolean).map(p => ({
      id: p.id, uri: p.uri, name: p.name,
      tracks: (p.tracks && p.tracks.total) || 0,
      image: (p.images && p.images.length) ? p.images[p.images.length - 1].url : null
    }));
    return { ok: true, items };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('spotify:control', async (_e, action) => {
  const sc = spotifyCfg();
  if (!sc.enabled || !spotifyTokens) return { ok: false };
  try {
    if      (action === 'next')     await spotifyApi('/me/player/next',     { method: 'POST' });
    else if (action === 'previous') await spotifyApi('/me/player/previous', { method: 'POST' });
    else if (action === 'pause')    await spotifyApi('/me/player/pause',    { method: 'PUT' });
    else if (action === 'play')     await spotifyApi('/me/player/play',     { method: 'PUT' });
    else return { ok: false, error: 'Unknown action.' };
    return { ok: true };
  } catch (e) {
    if (e.status === 403) return { ok: false, error: 'Playback control requires Spotify Premium.' };
    if (e.status === 404) return { ok: false, error: 'No active device. Start Spotify on a device first.' };
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('spotify:play', async (_e, contextUri) => {
  const sc = spotifyCfg();
  if (!sc.enabled || !spotifyTokens) return { ok: false };
  try {
    await spotifyApi('/me/player/play', {
      method: 'PUT',
      body: contextUri ? { context_uri: contextUri } : undefined
    });
    return { ok: true };
  } catch (e) {
    if (e.status === 403) return { ok: false, error: 'Playback control requires Spotify Premium.' };
    if (e.status === 404) return { ok: false, error: 'No active device. Open Spotify on a device first.' };
    return { ok: false, error: e.message };
  }
});
