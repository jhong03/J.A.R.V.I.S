// JARVIS Dashboard — renderer
// Everything UI-side: the clock, telemetry rendering, weather, email,
// the notification feed, the Claude console, and the spoken voice.

let CFG = {};
const $ = (id) => document.getElementById(id);

// ============================================================== utilities ==
function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}
function fmtBytes(bps) {
  if (bps > 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  return (bps / 1024).toFixed(0) + ' KB/s';
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}

// ================================================================== voice ==
let voiceEnabled = true;
let chosenVoice = null;

function pickVoice() {
  const wanted = (CFG.voice && CFG.voice.preferredVoiceContains || 'United Kingdom').toLowerCase();
  const voices = speechSynthesis.getVoices();
  chosenVoice =
    voices.find(v => v.name.toLowerCase().includes(wanted) || v.lang === 'en-GB' && v.name.toLowerCase().includes('male')) ||
    voices.find(v => v.lang === 'en-GB') ||
    voices.find(v => v.lang.startsWith('en')) ||
    null;
}
speechSynthesis.onvoiceschanged = pickVoice;

function speak(text) {
  if (!voiceEnabled || !(CFG.voice && CFG.voice.enabled)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (!chosenVoice) pickVoice();
  if (chosenVoice) u.voice = chosenVoice;
  u.rate  = (CFG.voice && CFG.voice.rate)  || 1.0;
  u.pitch = (CFG.voice && CFG.voice.pitch) || 0.9;
  u.onstart = () => $('reactor').classList.add('speaking');
  u.onend   = () => $('reactor').classList.remove('speaking');
  u.onerror = () => $('reactor').classList.remove('speaking');
  speechSynthesis.speak(u);
}

// ================================================================== clock ==
function tickClock() {
  const n = new Date();
  $('clock-time').textContent = nowTime();
  $('clock-date').textContent = n.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function buildTicks() {
  // 60 tick marks around the outer ring; every 5th is brighter.
  const g = $('outer-ticks');
  let html = '';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r1 = 186, r2 = i % 5 === 0 ? 176 : 181;
    const x1 = 200 + r1 * Math.cos(a), y1 = 200 + r1 * Math.sin(a);
    const x2 = 200 + r2 * Math.cos(a), y2 = 200 + r2 * Math.sin(a);
    html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${i % 5 === 0 ? 'major' : ''}"/>`;
  }
  g.innerHTML = html;
}

// =========================================================== notifications ==
const notified = new Set(); // de-dupe alert keys so we don't nag

function notify(text, opts = {}) {
  const feed = $('notif-feed');
  const li = document.createElement('li');
  if (opts.warn) li.classList.add('warn');
  li.innerHTML = `<span class="t">${nowTime()}</span>${text}`;
  feed.prepend(li);
  while (feed.children.length > 8) feed.removeChild(feed.lastChild);
  if (opts.speak) speak(text);
}

// =============================================================== telemetry ==
const CIRC = 264; // gauge circle circumference

function setGauge(id, pct, valText, warn) {
  const el = $(id);
  el.querySelector('.bar').style.strokeDashoffset = CIRC - (CIRC * Math.min(pct, 100) / 100);
  el.querySelector('.g-val').innerHTML = valText;
  el.classList.toggle('warn', !!warn);
}

async function refreshStats() {
  const s = await window.jarvis.getStats();
  if (!s.ok) return;

  const a = CFG.alerts || {};
  setGauge('g-cpu',  s.cpu,        `${s.cpu}<small>%</small>`,        s.cpu >= (a.cpuPercent || 90));
  setGauge('g-mem',  s.memUsedPct, `${s.memUsedPct}<small>%</small>`, s.memUsedPct >= (a.memPercent || 92));
  setGauge('g-disk', s.diskPct,    `${s.diskPct}<small>%</small>`,    s.diskPct >= 95);

  if (s.battery.has) {
    const low = !s.battery.charging && s.battery.pct <= (a.batteryPercent || 20);
    setGauge('g-pwr', s.battery.pct,
      `${s.battery.pct}<small>%${s.battery.charging ? '⚡' : ''}</small>`, low);
    if (low && !notified.has('battery')) {
      notified.add('battery');
      notify(`Power reserves at ${s.battery.pct} percent. I suggest connecting a charger, ${CFG.userTitle}.`, { warn: true, speak: true });
    }
    if (s.battery.charging) notified.delete('battery');
  } else {
    setGauge('g-pwr', 100, `AC<small></small>`, false);
  }

  // per-core bars
  const cores = $('cores');
  if (cores.children.length !== s.cores.length) {
    cores.innerHTML = s.cores.map(() => '<div class="core"></div>').join('');
  }
  [...cores.children].forEach((bar, i) => {
    bar.style.height = Math.max(4, s.cores[i]) + '%';
  });

  // readouts
  $('ds-mem').textContent    = `${s.memUsedGb} / ${s.memTotalGb} GB`;
  $('ds-disk').textContent   = `${s.diskFreeGb} GB`;
  $('ds-uptime').textContent = fmtUptime(s.uptimeSec);
  $('host-readout').textContent = `HOST ${s.hostname}`;
  $('net-readout').textContent  = `NET ▼ ${fmtBytes(s.netRxSec)} ▲ ${fmtBytes(s.netTxSec)}`;

  if (s.cpu >= (a.cpuPercent || 90) && !notified.has('cpu')) {
    notified.add('cpu');
    notify(`Processor load has reached ${s.cpu} percent, ${CFG.userTitle}.`, { warn: true, speak: true });
    setTimeout(() => notified.delete('cpu'), 5 * 60000); // re-arm after 5 min
  }
}

// ================================================================ weather ==
const WX_CODES = {
  0: 'CLEAR SKIES', 1: 'MAINLY CLEAR', 2: 'PARTLY CLOUDY', 3: 'OVERCAST',
  45: 'FOG', 48: 'FOG', 51: 'LIGHT DRIZZLE', 53: 'DRIZZLE', 55: 'HEAVY DRIZZLE',
  61: 'LIGHT RAIN', 63: 'RAIN', 65: 'HEAVY RAIN', 80: 'SHOWERS', 81: 'SHOWERS',
  82: 'VIOLENT SHOWERS', 95: 'THUNDERSTORM', 96: 'THUNDERSTORM', 99: 'THUNDERSTORM'
};

async function refreshWeather() {
  const w = CFG.weather || {};
  if (!w.enabled) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${w.latitude}&longitude=${w.longitude}&current=temperature_2m,weather_code,wind_speed_10m`;
    const r = await fetch(url);
    const j = await r.json();
    const c = j.current;
    $('weather-strip').classList.remove('hidden');
    $('wx-label').textContent = w.label || 'LOCAL';
    $('wx-temp').textContent  = Math.round(c.temperature_2m) + '°C';
    $('wx-desc').textContent  = WX_CODES[c.weather_code] || '—';
    $('wx-wind').textContent  = `WIND ${Math.round(c.wind_speed_10m)} KM/H`;
  } catch (_) { /* offline — leave hidden */ }
}

// ================================================================== email ==
let lastUnseen = null;

async function refreshEmail() {
  const r = await window.jarvis.checkEmail();
  if (r.disabled) { $('email-count').textContent = 'NOT CONFIGURED'; return; }
  if (!r.ok) { $('email-count').textContent = 'OFFLINE'; return; }

  $('email-count').textContent = r.unseen === 0 ? 'INBOX CLEAR' : `${r.unseen} UNREAD`;
  $('email-list').innerHTML = r.latest.map(m =>
    `<li><span class="t">${m.from}</span>${m.subject}</li>`).join('');

  if (lastUnseen !== null && r.unseen > lastUnseen) {
    const n = r.unseen - lastUnseen;
    notify(`You have ${n} new message${n > 1 ? 's' : ''}, ${CFG.userTitle}.`, { speak: true });
  }
  lastUnseen = r.unseen;
}

// ================================================================ spotify ==
// One light state object; we resync from the API on each poll and tick the
// progress bar locally in between so it moves smoothly without hammering the API.
const sp = { authed: false, isPlaying: false, progressMs: 0, durationMs: 0, syncedAt: 0, trackId: null };
let spPlaylistsLoaded = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

async function refreshSpotify() {
  if (!(CFG.spotify && CFG.spotify.enabled)) { $('sp-status').textContent = 'NOT CONFIGURED'; return; }

  const r = await window.jarvis.spotifyState();
  if (r.disabled) { $('sp-status').textContent = 'NOT CONFIGURED'; return; }
  if (!r.ok) { $('sp-status').textContent = (r.error || 'OFFLINE').toUpperCase(); return; }

  if (!r.authed) {
    sp.authed = false; spPlaylistsLoaded = false;
    $('sp-now').classList.add('hidden');
    $('sp-controls').classList.add('hidden');
    $('sp-playlists').innerHTML = '';
    $('sp-status').textContent = 'NOT CONNECTED';
    $('sp-login').classList.remove('hidden');
    return;
  }

  sp.authed = true;
  $('sp-login').classList.add('hidden');
  if (!spPlaylistsLoaded) loadSpotifyPlaylists();

  if (!r.playing) {
    sp.isPlaying = false; sp.trackId = null;
    $('sp-now').classList.add('hidden');
    $('sp-controls').classList.add('hidden');
    $('sp-status').textContent = 'NOTHING PLAYING';
    return;
  }

  $('sp-status').textContent = '';
  $('sp-now').classList.remove('hidden');
  $('sp-controls').classList.remove('hidden');

  const changed = r.id !== sp.trackId;
  sp.trackId = r.id;
  sp.isPlaying = r.isPlaying;
  sp.progressMs = r.progressMs;
  sp.durationMs = r.durationMs;
  sp.syncedAt = Date.now();

  $('sp-track').textContent = r.title || '—';
  $('sp-track').title = r.title || '';
  $('sp-artist').textContent = r.artist || '—';
  $('sp-art').style.backgroundImage = r.image ? `url("${r.image}")` : 'none';
  $('sp-playpause').textContent = r.isPlaying ? '❚❚' : '▶';
  tickSpotifyProgress();

  if (changed && r.title) notify(`Now playing: ${r.title} — ${r.artist}`);
}

// Advance the bar between polls, extrapolating from the last synced position.
function tickSpotifyProgress() {
  if (!sp.authed || !sp.durationMs) return;
  let pos = sp.progressMs + (sp.isPlaying ? Date.now() - sp.syncedAt : 0);
  pos = Math.min(pos, sp.durationMs);
  $('sp-progress-fill').style.width = (pos / sp.durationMs * 100) + '%';
  $('sp-pos').textContent = fmtMs(pos);
  $('sp-dur').textContent = fmtMs(sp.durationMs);
}

async function loadSpotifyPlaylists() {
  const r = await window.jarvis.spotifyPlaylists();
  if (!r.ok) return;
  spPlaylistsLoaded = true;
  const ul = $('sp-playlists');
  ul.innerHTML = r.items.slice(0, 5).map(p =>
    `<li data-uri="${escapeHtml(p.uri)}"><span class="n">${escapeHtml(p.name)}</span><span class="c">${p.tracks}</span></li>`
  ).join('');
  [...ul.children].forEach(li => li.addEventListener('click', async () => {
    const res = await window.jarvis.spotifyPlay(li.dataset.uri);
    if (res.ok) notify(`Starting ${li.querySelector('.n').textContent}, ${CFG.userTitle}.`);
    else notify(res.error || 'Could not start playback.', { warn: true });
    setTimeout(refreshSpotify, 700);
  }));
}

// =============================================================== shortcuts ==
function buildShortcuts() {
  const wrap = $('shortcuts');
  wrap.innerHTML = '';
  (CFG.shortcuts || []).forEach(s => {
    const b = document.createElement('button');
    b.className = 'shortcut';
    b.textContent = s.name;
    b.addEventListener('click', async () => {
      const r = await window.jarvis.launch(s.target);
      notify(r.ok ? `${s.name} launched.` : `Could not launch ${s.name}: ${r.error}`, { warn: !r.ok });
    });
    wrap.appendChild(b);
  });
}

// ================================================================ console ==
let busy = false;

function addMsg(who, text, cls = '') {
  const log = $('chat-log');
  const d = document.createElement('div');
  d.className = `msg ${who} ${cls}`.trim();
  d.innerHTML = `<span class="who">${who === 'user' ? 'YOU' : (CFG.assistantName || 'JARVIS')}</span>`;
  d.appendChild(document.createTextNode(text));
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function setConsoleState(state) {
  const lamp = $('console-lamp'), status = $('console-status');
  lamp.className = 'lamp';
  if (state === 'busy') { lamp.classList.add('busy'); status.textContent = 'PROCESSING'; }
  else if (state === 'live') { lamp.classList.add('live'); status.textContent = 'ONLINE'; }
  else { status.textContent = 'STANDBY'; }
}

async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || busy) return;

  input.value = '';
  busy = true;
  $('send-btn').disabled = true;
  setConsoleState('busy');
  addMsg('user', text);
  const thinking = addMsg('jarvis', 'Working on it…', 'thinking');

  const r = await window.jarvis.askClaude(text);

  thinking.remove();
  addMsg('jarvis', r.text, r.ok ? '' : 'error');
  if (r.ok) speak(r.text);

  busy = false;
  $('send-btn').disabled = false;
  setConsoleState('live');
  input.focus();
}

// ============================================================= power down ==
let poweringDown = false;

function powerDown() {
  if (poweringDown) return;
  poweringDown = true;

  const farewell = `Powering down. Goodbye, ${CFG.userTitle}.`;
  $('greeting').textContent = 'POWERING DOWN';
  setConsoleState('standby');
  addMsg('jarvis', farewell);
  speak(farewell);

  // Let the farewell land, then dim the interface and ask main to quit.
  setTimeout(() => {
    document.body.classList.add('powering-down');
    // window.close() as fallback — quits via window-all-closed if IPC fails.
    setTimeout(() => Promise.resolve(window.jarvis.quit()).catch(() => window.close()), 1400);
  }, voiceEnabled && CFG.voice && CFG.voice.enabled ? 1600 : 400);
}

// ================================================================== boot ==
function greetingText() {
  const h = new Date().getHours();
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  return `Good ${part}, ${CFG.userTitle}. All systems are online.`;
}

async function boot() {
  CFG = await window.jarvis.getConfig();

  $('brand').textContent = (CFG.assistantName || 'JARVIS')
    .toUpperCase().split('').join('.').replace(/\.$/, '');
  buildTicks();
  buildShortcuts();
  tickClock();
  setInterval(tickClock, 1000);

  await refreshStats();
  setInterval(refreshStats, 3000);

  refreshWeather();
  setInterval(refreshWeather, 15 * 60000);

  refreshEmail();
  const emailMins = (CFG.email && CFG.email.checkEveryMinutes) || 5;
  setInterval(refreshEmail, emailMins * 60000);

  refreshSpotify();
  setInterval(refreshSpotify, 4000);     // resync now-playing from the API
  setInterval(tickSpotifyProgress, 1000); // smooth the bar in between

  // top-bar greeting + spoken welcome
  const g = greetingText();
  $('greeting').textContent = g.toUpperCase().replace(/[.,]/g, '');
  setConsoleState('live');
  notify('Interface initialized. All monitoring systems active.');
  addMsg('jarvis', `${g} How may I assist you?`);
  setTimeout(() => speak(g), 900); // small delay so voices have loaded

  // console wiring
  $('send-btn').addEventListener('click', sendMessage);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
  $('voice-toggle').addEventListener('click', (e) => {
    voiceEnabled = !voiceEnabled;
    if (!voiceEnabled) speechSynthesis.cancel();
    e.target.textContent = `VOICE: ${voiceEnabled ? 'ON' : 'OFF'}`;
  });
  $('session-reset').addEventListener('click', async () => {
    await window.jarvis.resetClaude();
    $('chat-log').innerHTML = '';
    addMsg('jarvis', `Fresh session started, ${CFG.userTitle}. What shall we work on?`);
  });
  $('power-btn').addEventListener('click', powerDown);

  // spotify transport + connect
  $('sp-controls').addEventListener('click', async (e) => {
    const btn = e.target.closest('.sp-ctl');
    if (!btn) return;
    const act = btn.dataset.act === 'playpause' ? (sp.isPlaying ? 'pause' : 'play') : btn.dataset.act;
    const r = await window.jarvis.spotifyControl(act);
    if (!r.ok) notify(r.error || 'Playback control failed.', { warn: true });
    setTimeout(refreshSpotify, 400);
  });
  $('sp-login').addEventListener('click', async () => {
    $('sp-status').textContent = 'AWAITING AUTHORIZATION…';
    const r = await window.jarvis.spotifyLogin();
    if (r.ok) { notify('Spotify connected.'); refreshSpotify(); }
    else $('sp-status').textContent = (r.error || 'CONNECTION FAILED').toUpperCase();
  });

  $('chat-input').focus();
}

boot();
