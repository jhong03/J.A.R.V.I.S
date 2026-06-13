// JARVIS Dashboard — renderer
// Everything UI-side: the clock, telemetry rendering, weather,
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
// Two engines, chosen by config.voice.engine:
//   "piper"   — bundled neural voice; main synthesizes + post-processes and
//               pushes the clip back via a 'voice:play' event (see main.js).
//   "browser" — the Web Speech API, used directly or as an automatic fallback
//               if Piper/ffmpeg fail. Tuned to rate 1.08 / pitch 0.88.
// Either way the reactor "speaking" pulse is synced to playback start/end.
let voiceEnabled = true;
let chosenVoice = null;
let ttsAudio = null;      // the currently-playing Piper clip, so we can interrupt it
let sysUtter = null;      // the currently-speaking Web Speech utterance
let onSpeechEnd = null;   // one-shot resolver, fired when a line finishes naturally

const usePiper = () => ((CFG.voice && CFG.voice.engine) || 'piper') === 'piper';
const setSpeaking = (on) => $('reactor').classList.toggle('speaking', on);

// Fire (once) whoever is waiting for the current line to finish.
function endSpeech() {
  setSpeaking(false);
  if (onSpeechEnd) { const f = onSpeechEnd; onSpeechEnd = null; f(); }
}

// Interrupt whatever's playing WITHOUT fulfilling the waiter — handlers are
// detached first so a cancel doesn't masquerade as a natural end.
function cancelCurrent() {
  if (sysUtter) { sysUtter.onend = sysUtter.onerror = null; sysUtter = null; }
  speechSynthesis.cancel();
  if (ttsAudio) { ttsAudio.onended = ttsAudio.onerror = null; ttsAudio.pause(); ttsAudio = null; }
  stopOrb();
  setSpeaking(false);
}

// User-initiated full stop (voice toggle): also releases any pending waiter.
function stopSpeaking() { cancelCurrent(); endSpeech(); }

// Play a clip pushed up from main (data URL). Keeps the reactor pulse synced to
// the Audio element, drives the voice orb, and resolves the waiter when it ends.
function playVoiceClip(src) {
  cancelCurrent();
  const a = new Audio(src);
  ttsAudio = a;
  const tapped = connectOrbSource(a); // route through the analyser for the orb
  a.onplay  = () => { setSpeaking(true); if (tapped) startOrb(); };
  a.onended = () => { if (ttsAudio === a) ttsAudio = null; stopOrb(); endSpeech(); };
  a.onerror = () => { if (ttsAudio === a) ttsAudio = null; stopOrb(); endSpeech(); };
  a.play().catch(() => { if (ttsAudio === a) ttsAudio = null; stopOrb(); endSpeech(); });
}
window.jarvis.onVoicePlay(({ audio }) => { if (voiceEnabled) playVoiceClip(audio); });

// ============================================================== voice orb ==
// The centerpiece pulses with the ACTUAL voice: a Web Audio analyser taps the
// playing Piper clip and a canvas draws a circular waveform + amplitude glow.
// The rAF loop runs ONLY while speaking; at rest the canvas is clear and the
// CSS #orb-glow breathing shows through (no idle main-thread cost). Browser-
// engine speech has no tappable stream, so it falls back to the .speaking pulse.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let orbCanvas = null, orbCtx = null, orbRAF = 0, orbDpr = 1;
let voiceAudioCtx = null, voiceAnalyser = null, voiceTime = null;

function initOrb() {
  orbCanvas = $('orb-canvas');
  if (!orbCanvas) return;
  orbCtx = orbCanvas.getContext('2d');
  sizeOrb();
  addEventListener('resize', sizeOrb, { passive: true });
}
function sizeOrb() {
  if (!orbCanvas) return;
  orbDpr = Math.min(devicePixelRatio || 1, 2);
  const r = orbCanvas.getBoundingClientRect();
  orbCanvas.width  = Math.max(1, Math.round(r.width  * orbDpr));
  orbCanvas.height = Math.max(1, Math.round(r.height * orbDpr));
}
function ensureVoiceAnalyser() {
  if (voiceAudioCtx) return;
  voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  voiceAnalyser = voiceAudioCtx.createAnalyser();
  voiceAnalyser.fftSize = 512;
  voiceAnalyser.smoothingTimeConstant = 0.8;
  voiceTime = new Uint8Array(voiceAnalyser.fftSize);
  voiceAnalyser.connect(voiceAudioCtx.destination);
}
// Route an Audio element through the analyser so the orb can read its level.
// Returns false if Web Audio is unavailable — caller then just uses the CSS pulse.
function connectOrbSource(audioEl) {
  if (!orbCtx) return false;
  try {
    ensureVoiceAnalyser();
    if (voiceAudioCtx.state === 'suspended') voiceAudioCtx.resume();
    voiceAudioCtx.createMediaElementSource(audioEl).connect(voiceAnalyser);
    return true;
  } catch (e) { console.warn('orb analyser tap failed:', e); return false; }
}
function startOrb() {
  if (!orbCtx || orbRAF || reducedMotion) return;
  $('reactor').classList.add('orb-live');
  const loop = () => { orbRAF = requestAnimationFrame(loop); drawOrb(); };
  orbRAF = requestAnimationFrame(loop);
}
function stopOrb() {
  if (orbRAF) { cancelAnimationFrame(orbRAF); orbRAF = 0; }
  if (orbCtx) orbCtx.clearRect(0, 0, orbCanvas.width, orbCanvas.height);
  const r = $('reactor'); if (r) r.classList.remove('orb-live');
}
function drawOrb() {
  if (!voiceAnalyser) return;
  voiceAnalyser.getByteTimeDomainData(voiceTime);
  const w = orbCanvas.width, h = orbCanvas.height, cx = w / 2, cy = h / 2, D = Math.min(w, h);
  orbCtx.clearRect(0, 0, w, h);

  // RMS level — speech sits low, so scale up and clamp to 0..1
  let sum = 0;
  for (let i = 0; i < voiceTime.length; i++) { const v = (voiceTime[i] - 128) / 128; sum += v * v; }
  const amp = Math.min(1, Math.sqrt(sum / voiceTime.length) * 3.4);

  // glowing core that swells with the level
  const coreR = D * (0.18 + amp * 0.14);
  const g = orbCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.7);
  g.addColorStop(0,   `rgba(165,242,255,${0.34 + amp * 0.5})`);
  g.addColorStop(0.5, `rgba(77,221,255,${0.16 + amp * 0.34})`);
  g.addColorStop(1,   'rgba(77,221,255,0)');
  orbCtx.fillStyle = g;
  orbCtx.beginPath(); orbCtx.arc(cx, cy, coreR * 1.7, 0, Math.PI * 2); orbCtx.fill();

  // circular waveform ring around the core
  const N = 128, baseR = D * (0.30 + amp * 0.05);
  orbCtx.beginPath();
  for (let i = 0; i <= N; i++) {
    const v = (voiceTime[Math.floor(i / N * (voiceTime.length - 1))] - 128) / 128;
    const ang = i / N * Math.PI * 2 - Math.PI / 2;
    const rr = baseR + v * D * 0.085;
    const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
    i ? orbCtx.lineTo(x, y) : orbCtx.moveTo(x, y);
  }
  orbCtx.closePath();
  orbCtx.lineWidth = Math.max(1, 1.4 * orbDpr);
  orbCtx.strokeStyle = `rgba(127,233,255,${0.5 + amp * 0.5})`;
  orbCtx.shadowColor = 'rgba(77,221,255,0.9)';
  orbCtx.shadowBlur = (5 + amp * 16) * orbDpr;
  orbCtx.stroke();
  orbCtx.shadowBlur = 0;
}

// Speak and resolve when the line actually finishes (with a safety cap so a
// failed/silent synth never hangs the caller, e.g. power-down).
function speakAndWait(text, maxMs = 7000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(done, maxMs);
    onSpeechEnd = () => { clearTimeout(timer); done(); };
    Promise.resolve(speak(text)).then((produced) => {
      if (produced === false) { clearTimeout(timer); onSpeechEnd = null; done(); }
    });
  });
}

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

// Returns false if nothing will play (voice off) so callers like speakAndWait
// don't wait on a line that never sounds. Otherwise audio plays and the waiter
// resolves on its natural end.
async function speak(text) {
  if (!voiceEnabled || !(CFG.voice && CFG.voice.enabled)) return false;
  cancelCurrent(); // interrupt whatever's talking before starting the next line

  if (usePiper()) {
    try {
      const r = await window.jarvis.voiceSpeak(text); // playback arrives via 'voice:play'
      if (r && r.ok) return;
      console.warn('Piper voice unavailable, using browser voice:', r && r.error);
    } catch (e) {
      console.warn('Piper voice error, using browser voice:', e);
    }
  }
  speakSystem(text);
}

function speakSystem(text) {
  const u = new SpeechSynthesisUtterance(text);
  sysUtter = u;
  if (!chosenVoice) pickVoice();
  if (chosenVoice) u.voice = chosenVoice;
  u.rate  = (CFG.voice && CFG.voice.rate)  || 1.08;
  u.pitch = (CFG.voice && CFG.voice.pitch) || 0.88;
  u.onstart = () => setSpeaking(true);
  u.onend   = () => { if (sysUtter === u) sysUtter = null; endSpeech(); };
  u.onerror = () => { if (sysUtter === u) sysUtter = null; endSpeech(); };
  speechSynthesis.speak(u);
}

// ================================================================== clock ==
function tickClock() {
  const n = new Date();
  $('clock-time').textContent = nowTime();
  $('clock-date').textContent = n.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  $('cm-time').textContent = nowTime(); // mini chrono on the media face
  $('cm-date').textContent = n.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short'
  }).toUpperCase();
  const ac = $('adv-clock'); if (ac) ac.textContent = nowTime(); // advanced page header
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

// ============================================================== core modes ==
// The reactor is a button: each press cycles the centre display.
const CORE_MODES = ['chrono', 'media', 'diag'];
const CORE_FACES = { chrono: 'clock', media: 'core-media', diag: 'core-diag' };
let coreMode = 'chrono';
let lastStats = null;     // most recent telemetry, feeds the diagnostics face
let modeSwapTimer = null;

function renderCoreDiag() {
  if (!lastStats) return;
  const s = lastStats;
  $('cd-cpu').textContent = `${s.cpu}%`;
  $('cd-mem').textContent = `${s.memUsedPct}%`;
  $('cd-cpu-bar').style.width = Math.min(s.cpu, 100) + '%';
  $('cd-mem-bar').style.width = Math.min(s.memUsedPct, 100) + '%';
  $('cd-rx').textContent = fmtBytes(s.netRxSec);
  $('cd-tx').textContent = fmtBytes(s.netTxSec);
  $('cd-up').textContent = fmtUptime(s.uptimeSec);
}

const MR_CIRC = 660; // media progress ring circumference (2πr, r=105)

function renderCoreMedia() {
  const playing = sp.authed && sp.trackId;
  $('cm-track').textContent  = playing ? (sp.title || '—') : (sp.authed ? 'NOTHING PLAYING' : 'NO MEDIA SIGNAL');
  $('cm-artist').textContent = playing ? (sp.artist || '—') : '—';
  $('cm-art').style.backgroundImage = playing && sp.image ? `url("${sp.image}")` : 'none';
  $('cm-art').classList.toggle('empty', !(playing && sp.image));
  if (!playing) $('mr-bar').style.strokeDashoffset = MR_CIRC;
}

let blipCtx = null;
function blip() { // short synthesized chirp — no asset, CSP-safe
  try {
    blipCtx = blipCtx || new AudioContext();
    const t = blipCtx.currentTime;
    const o = blipCtx.createOscillator(), g = blipCtx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(1320, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.07);
    g.gain.setValueAtTime(0.035, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(blipCtx.destination);
    o.start(t); o.stop(t + 0.1);
  } catch { /* audio is garnish — never let it break the UI */ }
}

function cycleCoreMode() {
  coreMode = CORE_MODES[(CORE_MODES.indexOf(coreMode) + 1) % CORE_MODES.length];
  blip();
  const r = $('reactor');
  r.classList.add('mode-switching');
  const shock = $('hud-shock');
  shock.classList.remove('shock'); void shock.offsetWidth; // restart the wave
  shock.classList.add('shock');
  clearTimeout(modeSwapTimer);
  modeSwapTimer = setTimeout(() => { // swap faces mid-flicker
    for (const [m, id] of Object.entries(CORE_FACES)) $(id).classList.toggle('hidden', m !== coreMode);
    $('core-mode-tag').textContent = coreMode.toUpperCase();
    $('media-ring').classList.toggle('hidden', coreMode !== 'media');
    r.classList.toggle('mode-media', coreMode === 'media');
    if (coreMode === 'diag') renderCoreDiag();
    if (coreMode === 'media') { renderCoreMedia(); tickSpotifyProgress(); }
  }, 160);
  setTimeout(() => r.classList.remove('mode-switching'), 520);
}

// =========================================================== notifications ==
const notified = new Set(); // de-dupe alert keys so we don't nag
const overFor = { cpu: 0, mem: 0, disk: 0 }; // consecutive hot polls per alert

// Speak once when a reading stays hot for alerts.sustainPolls in a row (default
// 3 ≈ 9s at the 3s cadence, so a one-poll spike stays silent); re-arm after
// rearmMs (omit to alert once per session). Tunable in Advanced Mode.
function sustainedAlert(key, hot, text, rearmMs) {
  const need = (CFG.alerts && CFG.alerts.sustainPolls) || 3;
  overFor[key] = hot ? overFor[key] + 1 : 0;
  if (overFor[key] < need || notified.has(key)) return;
  notified.add(key);
  notify(text, { warn: true, speak: true });
  if (rearmMs) setTimeout(() => notified.delete(key), rearmMs);
}

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
  lastStats = s;
  if (coreMode === 'diag') renderCoreDiag();

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

  const cooldown = ((a.cooldownMin || 5) * 60000);
  sustainedAlert('cpu', s.cpu >= (a.cpuPercent || 90),
    `Processor load has reached ${s.cpu} percent, ${CFG.userTitle}.`, cooldown);
  sustainedAlert('mem', s.memUsedPct >= (a.memPercent || 92),
    `Memory usage has reached ${s.memUsedPct} percent, ${CFG.userTitle}. Closing an application may be wise.`, cooldown);
  sustainedAlert('disk', s.diskPct >= 95,
    `Storage is ${s.diskPct} percent full, ${CFG.userTitle}. A cleanup may be in order.`);
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

// ================================================================ spotify ==
// One light state object; we resync from the API on each poll and tick the
// progress bar locally in between so it moves smoothly without hammering the API.
const sp = { authed: false, isPlaying: false, progressMs: 0, durationMs: 0, syncedAt: 0,
             trackId: null, title: null, artist: null, image: null };
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
    if (coreMode === 'media') renderCoreMedia();
    return;
  }

  sp.authed = true;
  $('sp-login').classList.add('hidden');
  if (!spPlaylistsLoaded) loadSpotifyPlaylists();

  if (!r.playing) {
    sp.isPlaying = false; sp.trackId = null;
    sp.title = sp.artist = sp.image = null;
    $('sp-now').classList.add('hidden');
    $('sp-controls').classList.add('hidden');
    $('sp-status').textContent = 'NOTHING PLAYING';
    if (coreMode === 'media') renderCoreMedia();
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
  sp.title = r.title; sp.artist = r.artist; sp.image = r.image;
  if (coreMode === 'media') renderCoreMedia();

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
  if (coreMode === 'media' && sp.trackId) {
    $('mr-bar').style.strokeDashoffset = MR_CIRC * (1 - pos / sp.durationMs);
  }
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

// Replace a bubble's text while keeping its .who label (first child).
function setBubbleText(d, text) {
  while (d.childNodes.length > 1) d.removeChild(d.lastChild);
  d.appendChild(document.createTextNode(text));
}

// Streaming chat: deltas from main fill the active JARVIS bubble token-by-token,
// so the reply appears as it generates instead of after the full round-trip.
let streamBubble = null;
window.jarvis.onClaudeDelta((chunk) => {
  if (!streamBubble) return;
  if (streamBubble.classList.contains('thinking')) {
    streamBubble.classList.remove('thinking');
    setBubbleText(streamBubble, '');     // drop the "Working on it…" placeholder
  }
  streamBubble.appendChild(document.createTextNode(chunk));
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
});

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
  const bubble = addMsg('jarvis', 'Working on it…', 'thinking');
  streamBubble = bubble; // deltas stream into this bubble as they arrive

  const r = await window.jarvis.askClaude(text);

  streamBubble = null;
  bubble.classList.remove('thinking');
  setBubbleText(bubble, r.text); // settle on the authoritative final text
  if (!r.ok) bubble.classList.add('error');
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  if (r.ok) speak(r.text);

  busy = false;
  $('send-btn').disabled = false;
  setConsoleState('live');
  input.focus();
}

// ============================================================= power down ==
let poweringDown = false;

async function powerDown() {
  if (poweringDown) return;
  poweringDown = true;

  const farewell = `Powering down. Goodbye, ${CFG.userTitle}.`;
  $('greeting').textContent = 'POWERING DOWN';
  setConsoleState('standby');
  addMsg('jarvis', farewell);

  const voiceOn = voiceEnabled && CFG.voice && CFG.voice.enabled;
  // Speak the farewell and WAIT for it to actually finish (Piper has synthesis
  // latency and plays async, so a fixed timeout would clip it). Dim the screen
  // partway through, then quit once the line is done.
  const spoken = voiceOn ? speakAndWait(farewell, 8000) : Promise.resolve();
  setTimeout(() => document.body.classList.add('powering-down'), voiceOn ? 700 : 200);
  await spoken;
  // window.close() as fallback — quits via window-all-closed if IPC fails.
  setTimeout(() => Promise.resolve(window.jarvis.quit()).catch(() => window.close()), 250);
}

// =============================================================== settings ==
// In-app settings page so end users can configure everything without touching
// config.json. Reads CFG into the form, writes a full config back through
// window.jarvis.saveConfig, then hot-re-renders the live bits.
const setVal = (id, v) => { const el = $(id); if (el) el.value = (v == null ? '' : v); };
const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
const getVal = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
const getNum = (id, d) => { const v = parseFloat(getVal(id)); return isNaN(v) ? d : v; };
const getChk = (id) => { const el = $(id); return el ? el.checked : false; };

function openSettings() {
  populateSettings();
  refreshSettingsSpotify();
  $('set-status').textContent = '';
  $('settings-overlay').classList.remove('hidden');
}
function closeSettings() { $('settings-overlay').classList.add('hidden'); }

function populateSettings() {
  const c = CFG;
  setVal('set-assistantName', c.assistantName);
  setVal('set-userTitle', c.userTitle);

  const v = c.voice || {};
  setChk('set-voice-enabled', v.enabled);
  setVal('set-voice-engine', v.engine || 'piper');

  const w = c.weather || {};
  setChk('set-weather-enabled', w.enabled);
  setVal('set-weather-label', w.label);
  setVal('set-weather-lat', w.latitude);
  setVal('set-weather-lon', w.longitude);

  const s = c.spotify || {};
  setChk('set-spotify-enabled', s.enabled);
  setVal('set-spotify-clientId', s.clientId);
  setVal('set-spotify-port', s.redirectPort);

  const cl = c.claude || {};
  setVal('set-claude-command', cl.command);
  setVal('set-claude-workingDir', cl.workingDir);
  setVal('set-claude-allowedTools', cl.allowedTools);
  setVal('set-claude-personality', cl.personality);

  const a = c.alerts || {};
  setVal('set-alert-cpu', a.cpuPercent);
  setVal('set-alert-mem', a.memPercent);
  setVal('set-alert-bat', a.batteryPercent);

  buildShortcutRows(c.shortcuts || []);
}

function buildShortcutRows(list) {
  $('set-shortcuts').innerHTML = '';
  list.forEach(s => addShortcutRow(s.name, s.target));
}
function addShortcutRow(name = '', target = '') {
  const row = document.createElement('div');
  row.className = 'set-sc-row';
  const n = document.createElement('input');
  n.className = 'sc-name'; n.type = 'text'; n.placeholder = 'Name'; n.value = name;
  const t = document.createElement('input');
  t.className = 'sc-target'; t.type = 'text'; t.placeholder = 'https://… or app.exe'; t.value = target;
  const del = document.createElement('button');
  del.className = 'set-sc-del'; del.type = 'button'; del.textContent = '✕'; del.title = 'Remove';
  del.addEventListener('click', () => row.remove());
  row.append(n, t, del);
  $('set-shortcuts').appendChild(row);
}

// Clone CFG (preserves deep keys like voice.piper) and overlay the form values.
function gatherSettings() {
  const next = JSON.parse(JSON.stringify(CFG));
  next.assistantName = getVal('set-assistantName') || 'JARVIS';
  next.userTitle = getVal('set-userTitle') || 'sir';

  next.voice = next.voice || {};
  next.voice.enabled = getChk('set-voice-enabled');
  next.voice.engine = getVal('set-voice-engine') || 'piper';

  next.weather = next.weather || {};
  next.weather.enabled = getChk('set-weather-enabled');
  next.weather.label = getVal('set-weather-label');
  next.weather.latitude = getNum('set-weather-lat', next.weather.latitude);
  next.weather.longitude = getNum('set-weather-lon', next.weather.longitude);

  next.spotify = next.spotify || {};
  next.spotify.enabled = getChk('set-spotify-enabled');
  next.spotify.clientId = getVal('set-spotify-clientId');
  next.spotify.redirectPort = getNum('set-spotify-port', 8888);

  next.claude = next.claude || {};
  next.claude.command = getVal('set-claude-command') || 'claude';
  next.claude.workingDir = getVal('set-claude-workingDir');
  next.claude.allowedTools = getVal('set-claude-allowedTools');
  next.claude.personality = getVal('set-claude-personality');

  next.alerts = next.alerts || {};
  next.alerts.cpuPercent = getNum('set-alert-cpu', 90);
  next.alerts.memPercent = getNum('set-alert-mem', 92);
  next.alerts.batteryPercent = getNum('set-alert-bat', 20);

  next.shortcuts = [...$('set-shortcuts').querySelectorAll('.set-sc-row')]
    .map(r => ({ name: r.querySelector('.sc-name').value.trim(), target: r.querySelector('.sc-target').value.trim() }))
    .filter(s => s.name && s.target);

  return next;
}

async function saveSettings() {
  const btn = $('settings-save');
  btn.disabled = true;
  $('set-status').textContent = 'Saving…';
  const r = await window.jarvis.saveConfig(gatherSettings());
  btn.disabled = false;
  if (!r || !r.ok) { $('set-status').textContent = (r && r.error) || 'Save failed.'; return; }
  CFG = await window.jarvis.getConfig();
  applyConfig();
  $('set-status').textContent = 'Saved ✓';
  notify('Settings updated.');
}

// Re-render the config-driven UI so most changes apply without a restart.
function applyConfig() {
  $('brand').textContent = (CFG.assistantName || 'JARVIS').toUpperCase().split('').join('.').replace(/\.$/, '');
  buildShortcuts();
  refreshWeather();
  refreshSpotify();
}

async function refreshSettingsSpotify() {
  const st = $('set-spotify-status');
  if (!(CFG.spotify && CFG.spotify.enabled)) { st.textContent = 'disabled'; return; }
  try {
    const r = await window.jarvis.spotifyState();
    st.textContent = (r && r.authed) ? 'connected ✓' : 'not connected';
  } catch { st.textContent = ''; }
}

// =============================================================== advanced ==
// Hidden power-user page (triple-click the reactor): live voice sliders, alert
// tuning, and diagnostics. Writes straight to config via config:save.
const errorLog = [];
addEventListener('error', (e) => { errorLog.unshift(String(e.message)); errorLog.splice(8); });
addEventListener('unhandledrejection', (e) => { errorLog.unshift(String(e.reason)); errorLog.splice(8); });

const getByPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setByPath(o, p, v) {
  const ks = p.split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null) x[ks[i]] = {}; x = x[ks[i]]; }
  x[ks[ks.length - 1]] = v;
}

const ADV_VOICE = [
  { p: 'voice.piper.lengthScale',                      label: 'Pace (lower = faster)',    min: 0.8, max: 1.3, step: 0.01, def: 0.94 },
  { p: 'voice.piper.sentenceSilence',                  label: 'Sentence pause (s)',       min: 0.05, max: 0.5, step: 0.01, def: 0.26 },
  { p: 'voice.piper.noiseScale',                       label: 'Expression',               min: 0.2, max: 0.9, step: 0.01, def: 0.72 },
  { p: 'voice.piper.noiseW',                           label: 'Phrasing variation',       min: 0.3, max: 1.0, step: 0.01, def: 0.85 },
  { p: 'voice.piper.postProcess.semitones',            label: 'Pitch (semitones)',        min: -4, max: 4, step: 0.5, def: 0 },
  { p: 'voice.piper.postProcess.lowShelfDb',           label: 'Warmth (low shelf dB)',    min: -2, max: 6, step: 0.5, def: 1 },
  { p: 'voice.piper.postProcess.highShelfDb',          label: 'Presence (high shelf dB)', min: -4, max: 5, step: 0.5, def: 2 },
  { p: 'voice.piper.postProcess.compRatio',            label: 'Compression ratio',        min: 1, max: 5, step: 0.5, def: 2.5 },
  { p: 'voice.piper.postProcess.robotic.combDecay',    label: 'Robotic — comb ring',      min: 0, max: 0.5, step: 0.02, def: 0.18 },
  { p: 'voice.piper.postProcess.robotic.flangerDepth', label: 'Robotic — flanger',        min: 0, max: 6, step: 0.5, def: 1.5 },
  { p: 'voice.piper.postProcess.robotic.chorusDepth',  label: 'Robotic — chorus',         min: 0, max: 5, step: 0.5, def: 2 }
];

function buildAdvVoice() {
  const wrap = $('adv-voice');
  wrap.innerHTML = '';
  ADV_VOICE.forEach((s, i) => {
    let val = getByPath(CFG, s.p); if (val == null) val = s.def;
    const row = document.createElement('label');
    row.className = 'adv-slider';
    row.innerHTML = `<span>${s.label}</span><output id="advo-${i}">${val}</output>`;
    const r = document.createElement('input');
    r.type = 'range'; r.min = s.min; r.max = s.max; r.step = s.step; r.value = val; r.dataset.idx = i;
    r.addEventListener('input', () => { $(`advo-${i}`).textContent = r.value; });
    row.appendChild(r);
    wrap.appendChild(row);
  });
}
function advVoiceConfig() {
  const next = JSON.parse(JSON.stringify(CFG));
  $('adv-voice').querySelectorAll('input[type=range]').forEach(r => {
    setByPath(next, ADV_VOICE[+r.dataset.idx].p, parseFloat(r.value));
  });
  return next;
}
async function saveAdvVoice() {
  const r = await window.jarvis.saveConfig(advVoiceConfig());
  if (r && r.ok) { CFG = await window.jarvis.getConfig(); applyConfig(); $('adv-voice-status').textContent = 'saved ✓'; }
  else $('adv-voice-status').textContent = (r && r.error) || 'save failed';
}
// Audition the current slider values WITHOUT saving — settings are untouched
// until the user clicks Save.
async function testAdvVoice() {
  $('adv-voice-status').textContent = 'testing…';
  const piper = advVoiceConfig().voice.piper;
  const text = `Voice diagnostics, ${CFG.userTitle}. All systems are operating within normal parameters.`;
  const r = await window.jarvis.voiceTest(piper, text);
  $('adv-voice-status').textContent = (r && r.ok) ? 'tested (not saved)' : ((r && r.error) || 'test failed');
}

function populateAdvAlerts() {
  const a = CFG.alerts || {};
  setVal('adv-alert-cpu', a.cpuPercent != null ? a.cpuPercent : 90);
  setVal('adv-alert-mem', a.memPercent != null ? a.memPercent : 92);
  setVal('adv-alert-bat', a.batteryPercent != null ? a.batteryPercent : 20);
  setVal('adv-alert-sustain', a.sustainPolls != null ? a.sustainPolls : 3);
  setVal('adv-alert-cooldown', a.cooldownMin != null ? a.cooldownMin : 5);
}
async function saveAdvAlerts() {
  const next = JSON.parse(JSON.stringify(CFG));
  next.alerts = next.alerts || {};
  next.alerts.cpuPercent = getNum('adv-alert-cpu', 90);
  next.alerts.memPercent = getNum('adv-alert-mem', 92);
  next.alerts.batteryPercent = getNum('adv-alert-bat', 20);
  next.alerts.sustainPolls = Math.max(1, getNum('adv-alert-sustain', 3));
  next.alerts.cooldownMin = Math.max(0, getNum('adv-alert-cooldown', 5));
  const r = await window.jarvis.saveConfig(next);
  if (r && r.ok) { CFG = await window.jarvis.getConfig(); $('adv-alert-status').textContent = 'saved ✓'; }
  else $('adv-alert-status').textContent = (r && r.error) || 'save failed';
}

async function renderDiag() {
  const rows = [];
  const add = (k, v, bad) => rows.push(`<span class="k">${k}</span><span class="v${bad ? ' bad' : ''}">${escapeHtml(String(v))}</span>`);
  const d = await window.jarvis.diag().catch(() => null);
  if (d) {
    add('App version', d.appVersion);
    add('Electron / Chrome / Node', `${d.electron} / ${d.chrome} / ${d.node}`);
    add('Platform', `${d.platform} · ${d.packaged ? 'packaged' : 'dev'}`);
    add('Config path', d.configPath);
    add('Voice engine', `${d.voiceEngine} (${d.voiceModel})`);
    add('Piper / ffmpeg', `${d.piperPresent ? 'ok' : 'MISSING'} / ${d.ffmpegPresent ? 'ok' : 'MISSING'}`, !d.piperPresent || !d.ffmpegPresent);
  }
  add('Spotify', sp.authed ? 'connected' : ((CFG.spotify && CFG.spotify.enabled) ? 'not connected' : 'disabled'));
  if (lastStats) {
    const s = lastStats;
    add('CPU / MEM / Disk', `${s.cpu}% / ${s.memUsedPct}% / ${s.diskPct}%`);
    add('Net ▼ / ▲', `${fmtBytes(s.netRxSec)} / ${fmtBytes(s.netTxSec)}`);
    add('Uptime', fmtUptime(s.uptimeSec));
  }
  add('Recent errors', errorLog.length ? errorLog.slice(0, 5).join('  ·  ') : 'none', errorLog.length > 0);
  $('adv-diag').innerHTML = rows.join('');
}

// --- Advanced Mode transition (no 3D) ------------------------------------
// Enter: the reactor rings spin up + the core presses down, then the dashboard
// fades away and the full-screen Advanced page fades in. Exit: the Advanced
// page just fades back to the dashboard — no extra motion.
let advState = 'dashboard'; // 'dashboard' | 'transitioning' | 'advanced'

function toggleAdvanced() {
  if (advState === 'transitioning') return;
  if (advState === 'dashboard') {
    buildAdvVoice(); populateAdvAlerts(); renderDiag();
    $('adv-voice-status').textContent = ''; $('adv-alert-status').textContent = '';
    playEnter();
  } else if (advState === 'advanced') {
    playExit();
  }
}

function playEnter() {
  advState = 'transitioning';
  const adv = $('advanced-overlay');
  adv.classList.remove('hidden');
  document.body.classList.add('adv-entering');   // rings whirl up + core presses down
  const shock = $('hud-shock');
  if (shock) { shock.classList.remove('shock'); void shock.offsetWidth; shock.classList.add('shock'); }
  setTimeout(() => {                              // …then the dashboard fades away and
    document.body.classList.add('adv-out');       // the Advanced page fades in
    requestAnimationFrame(() => adv.classList.add('shown'));
  }, 850);
  setTimeout(() => {
    advState = 'advanced';
    document.body.classList.remove('adv-entering');
  }, 1650);
}

function playExit() {
  advState = 'transitioning';
  const adv = $('advanced-overlay');
  adv.classList.remove('shown');                 // advanced fades out
  document.body.classList.remove('adv-out');     // dashboard slowly reappears — no extra motion
  setTimeout(() => { advState = 'dashboard'; adv.classList.add('hidden'); }, 750);
}

// ============================================================ HUD cursor ==
// The targeting reticle itself is an OS-level custom cursor (cursor: url in
// styles.css), rendered by the system compositor so it never stutters when the
// app is busy. JS only adds the one-shot "fire" pulse at the click point —
// event-driven, no per-frame work.
function initClickPulse() {
  const p = $('click-pulse');
  if (!p) return;
  document.addEventListener('mousedown', (e) => {
    p.style.left = e.clientX + 'px';
    p.style.top  = e.clientY + 'px';
    p.classList.remove('fire'); void p.offsetWidth; p.classList.add('fire'); // restart anim
  }, { passive: true });
}

// ================================================================== boot ==
function greetingText() {
  const h = new Date().getHours();
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  return `Good ${part}, ${CFG.userTitle}. All systems are online.`;
}

async function boot() {
  CFG = await window.jarvis.getConfig();

  initClickPulse();
  initOrb();
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
    if (!voiceEnabled) stopSpeaking();
    e.target.textContent = `VOICE: ${voiceEnabled ? 'ON' : 'OFF'}`;
  });
  $('session-reset').addEventListener('click', async () => {
    await window.jarvis.resetClaude();
    $('chat-log').innerHTML = '';
    addMsg('jarvis', `Fresh session started, ${CFG.userTitle}. What shall we work on?`);
  });
  $('power-btn').addEventListener('click', powerDown);
  $('reactor').addEventListener('click', cycleCoreMode);

  // hidden Advanced Mode — triple-click the core (forward) or empty space on the
  // advanced page (reverse) within 650ms. On the dashboard the 3 clicks also
  // cycle the face 3× — back to the start, so nothing else changes.
  const tripleClick = (el, fn) => {
    let times = [];
    el.addEventListener('click', (e) => {
      const t = performance.now();
      times = times.filter(x => t - x < 650); times.push(t);
      if (times.length >= 3) { times = []; fn(e); }
    });
  };
  tripleClick($('reactor'), () => { if (advState === 'dashboard') toggleAdvanced(); });
  tripleClick($('advanced-overlay'), (e) => {
    if (advState === 'advanced' && !e.target.closest('input, button, textarea, select, .adv-slider, label')) toggleAdvanced();
  });
  $('advanced-done').addEventListener('click', () => { if (advState === 'advanced') toggleAdvanced(); });
  $('adv-voice-test').addEventListener('click', testAdvVoice);
  $('adv-voice-save').addEventListener('click', saveAdvVoice);
  $('adv-alert-save').addEventListener('click', saveAdvAlerts);
  $('adv-diag-refresh').addEventListener('click', renderDiag);
  $('adv-reload').addEventListener('click', () => location.reload());

  // settings page
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  $('settings-restart').addEventListener('click', () => window.jarvis.relaunch());
  $('set-shortcut-add').addEventListener('click', () => addShortcutRow());
  // Close on backdrop click — but only if the press STARTED on the backdrop too.
  // A drag that begins inside the modal (e.g. selecting text in a field) and
  // ends over the backdrop fires `click` on the overlay; that must not close it.
  let setOverlayDown = false;
  $('settings-overlay').addEventListener('mousedown', (e) => { setOverlayDown = (e.target.id === 'settings-overlay'); });
  $('settings-overlay').addEventListener('click', (e) => {
    if (setOverlayDown && e.target.id === 'settings-overlay') closeSettings();
    setOverlayDown = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (advState === 'advanced') toggleAdvanced();
    else if (!$('settings-overlay').classList.contains('hidden')) closeSettings();
  });
  $('set-spotify-connect').addEventListener('click', async () => {
    $('set-spotify-status').textContent = 'authorizing…';
    await window.jarvis.saveConfig(gatherSettings()); // commit latest clientId/port first
    CFG = await window.jarvis.getConfig();
    const r = await window.jarvis.spotifyLogin();
    $('set-spotify-status').textContent = (r && r.ok) ? 'connected ✓' : ((r && r.error) || 'failed').toString().toLowerCase();
    applyConfig();
  });
  $('set-spotify-disconnect').addEventListener('click', async () => {
    await window.jarvis.spotifyLogout();
    $('set-spotify-status').textContent = 'disconnected';
    refreshSpotify();
  });

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
