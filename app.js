/* Aktivita PWA — sledování chůze a denní aktivity
   Data: Apple Zdraví (přes Zkratky → Firebase Firestore REST), GPS procházky, import Časové osy Google.
   Bez frameworků, bez Firebase SDK (jen REST API). */
'use strict';
const VERSION = '1.0.0';

/* ================= Pomocné funkce ================= */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const nf = (n, d = 0) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d }).format(isFinite(n) ? n : 0);
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => { const x = midnight(d); return addDays(x, -((x.getDay() + 6) % 7)); };
const wd = d => (d.getDay() + 6) % 7; // 0 = pondělí
const DOW = ['P', 'Ú', 'S', 'Č', 'P', 'S', 'N'];
const DOWS = ['po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];
const DOWL = ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'];
const MON = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const MONG = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
const MONS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const fmtLong = d => `${DOWL[wd(d)]} ${d.getDate()}. ${MONG[d.getMonth()]} ${d.getFullYear()}`;
const fmtShort = d => `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
const fmtTime = d => `${d.getHours()}:${pad(d.getMinutes())}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { if (typeof v === 'number') return isFinite(v) ? v : 0; if (v == null) return 0; const x = parseFloat(String(v).replace(/[\s ]/g, '').replace(',', '.')); return isFinite(x) ? x : 0; };
const fmtDur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; };
const fmtDurHM = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const km = m => nf(m / 1000, m < 100000 ? 2 : 1);
function hav(a, b, c, d) { const R = 6371000, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms); }
const plural = (n, a, b, c) => n === 1 ? a : n >= 2 && n <= 4 ? b : c;
function randId(n = 24) { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => a[x % a.length]).join(''); }

/* ================= Úložiště (IndexedDB) ================= */
const DB = {
  db: null, mem: {},
  open() { return new Promise(res => { try { const r = indexedDB.open('aktivita', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => res(); } catch (e) { res(); } }); },
  get(k) { return new Promise(res => { if (!this.db) return res(this.mem[k]); try { const q = this.db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch (e) { res(undefined); } }); },
  set(k, v) { return new Promise(res => { if (!this.db) { this.mem[k] = v; return res(); } try { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => res(); } catch (e) { res(); } }); }
};

/* ================= Nastavení a data ================= */
const DEF = { goals: { kcal: 300, exMin: 30, steps: 8000 }, stride: 0.75, fb: { projectId: '', apiKey: '', secret: '' }, challenge: { id: 'praha', start: null }, lastSync: 0 };
let S = (() => { try { const s = JSON.parse(localStorage.getItem('aktivita_settings') || '{}'); return { ...DEF, ...s, goals: { ...DEF.goals, ...(s.goals || {}) }, fb: { ...DEF.fb, ...(s.fb || {}) }, challenge: { ...DEF.challenge, ...(s.challenge || {}) } }; } catch (e) { return structuredClone(DEF); } })();
const saveS = () => { try { localStorage.setItem('aktivita_settings', JSON.stringify(S)); } catch (e) { } };
let D = { days: {}, demo: {}, events: [], walks: [], tl: { walks: [] } };
async function loadData() { for (const k of Object.keys(D)) { const v = await DB.get(k); if (v) D[k] = v; } reindex(); }
async function saveData(...keys) { for (const k of (keys.length ? keys : Object.keys(D))) await DB.set(k, D[k]); reindex(); }

/* Index procházek podle dne + cache odvozených dnů */
let IDX = { walksByDay: {}, outings: [], outByDay: {}, dayCache: {} };
function reindex() {
  const w = {};
  for (const x of D.walks) (w[dkey(new Date(x.start))] ||= []).push({ ...x, src: 'gps' });
  for (const x of (D.tl.walks || [])) (w[dkey(new Date(x.start))] ||= []).push({ ...x, src: 'tl' });
  IDX.walksByDay = w;
  IDX.outings = computeOutings();
  const o = {}; for (const x of IDX.outings) (o[dkey(new Date(x.start))] ||= []).push(x);
  IDX.outByDay = o; IDX.dayCache = {};
}

/* Den = data ze Zdraví (Firebase), jinak odhad z procházek (GPS / Časová osa) */
function getDay(k) {
  if (IDX.dayCache[k]) return IDX.dayCache[k];
  const h = D.days[k] || D.demo[k];
  const walks = IDX.walksByDay[k] || [];
  let r;
  if (h) r = { steps: num(h.steps), distM: num(h.distM), kcal: num(h.kcal), exMin: num(h.exMin), flights: num(h.flights), hourly: h.hourly, updatedAt: h.updatedAt, has: true, est: false, demo: !D.days[k] };
  else {
    const g = walks.filter(x => x.src === 'gps').reduce((s, x) => s + num(x.distM), 0);
    const t = walks.filter(x => x.src === 'tl').reduce((s, x) => s + num(x.distM), 0);
    const m = Math.max(g, t);
    if (m > 0) {
      const steps = Math.round(m / S.stride);
      const mins = walks.filter(x => x.src === (g >= t ? 'gps' : 'tl')).reduce((s, x) => s + (new Date(x.end) - new Date(x.start)) / 60000, 0);
      r = { steps, distM: m, kcal: Math.round(steps * 0.04), exMin: Math.round(mins), flights: 0, has: true, est: true };
    } else r = { steps: 0, distM: 0, kcal: 0, exMin: 0, flights: 0, has: false, est: false };
  }
  r.walks = walks; r.outings = IDX.outByDay[k] || [];
  r.pMove = r.kcal / S.goals.kcal; r.pEx = r.exMin / S.goals.exMin; r.pSteps = r.steps / S.goals.steps;
  r.closed = r.has && r.pMove >= 1 && r.pEx >= 1 && r.pSteps >= 1;
  return (IDX.dayCache[k] = r);
}

/* Odchody/příchody ze Zkratek → výlety mimo domov */
function computeOutings() {
  const ev = D.events.map(e => ({ ...e, t: new Date(e.time) })).filter(e => !isNaN(e.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].type !== 'leave') continue;
    const l = ev[i]; const a = ev[i + 1];
    if (a && a.type === 'arrive' && a.t - l.t < 24 * 3600e3) {
      const same = dkey(l.t) === dkey(a.t);
      out.push({ id: 'o' + l.t.getTime(), start: l.t.toISOString(), end: a.t.toISOString(), durS: (a.t - l.t) / 1000, steps: same ? Math.max(0, num(a.steps) - num(l.steps)) : null, distM: same ? Math.max(0, num(a.distM) - num(l.distM)) : null, src: 'out' });
      i++;
    } else if (!a && Date.now() - l.t < 12 * 3600e3) {
      out.push({ id: 'o' + l.t.getTime(), start: l.t.toISOString(), end: null, ongoing: true, durS: (Date.now() - l.t) / 1000, steps: null, distM: null, src: 'out' });
    }
  }
  return out;
}

/* ================= Firebase Firestore (REST) ================= */
function toFields(o) { const f = {}; for (const [k, v] of Object.entries(o)) { if (v === undefined) continue; f[k] = toVal(v); } return f; }
function toVal(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  return { mapValue: { fields: toFields(v) } };
}
function fromVal(v) {
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; for (const [k, v] of Object.entries(f || {})) o[k] = fromVal(v); return o; }
const FB = {
  ok() { const f = S.fb; return !!(f.projectId && f.apiKey && f.secret); },
  base() { const f = S.fb; return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(f.projectId.trim())}/databases/(default)/documents/u/${encodeURIComponent(f.secret.trim())}`; },
  key() { return 'key=' + encodeURIComponent(S.fb.apiKey.trim()); },
  async err(r) { let t = ''; try { const j = await r.json(); t = j.error?.message || ''; } catch (e) { } return new Error(`HTTP ${r.status}${t ? ' – ' + t : ''}`); },
  async list(col) {
    const out = []; let tok = '';
    do {
      const r = await fetch(`${this.base()}/${col}?pageSize=300&${this.key()}${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`);
      if (!r.ok) throw await this.err(r);
      const j = await r.json();
      for (const d of (j.documents || [])) out.push({ id: decodeURIComponent(d.name.split('/').pop()), ...fromFields(d.fields) });
      tok = j.nextPageToken || '';
    } while (tok);
    return out;
  },
  async put(col, id, obj) {
    const r = await fetch(`${this.base()}/${col}/${encodeURIComponent(id)}?${this.key()}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: toFields(obj) }) });
    if (!r.ok) throw await this.err(r); return r.json();
  },
  async del(col, id) { const r = await fetch(`${this.base()}/${col}/${encodeURIComponent(id)}?${this.key()}`, { method: 'DELETE' }); if (!r.ok) throw await this.err(r); }
};
function normDay(d) {
  const o = { steps: num(d.steps), distM: d.distM != null ? num(d.distM) : num(d.distKm) * 1000, kcal: num(d.kcal), exMin: num(d.exMin), flights: num(d.flights), updatedAt: d.updatedAt || '' };
  if (Array.isArray(d.hourly) && d.hourly.length === 24) o.hourly = d.hourly.map(num);
  return o;
}
function normEvent(e) {
  const t = String(e.type || '').toLowerCase();
  const type = /odch|leave|out/.test(t) ? 'leave' : /pri|pří|arriv|home|dom/.test(t) ? 'arrive' : null;
  const time = new Date(e.time); if (!type || isNaN(time)) return null;
  return { id: e.id, type, time: time.toISOString(), steps: num(e.steps), distM: num(e.distM) };
}
const encPts = (pts) => pts.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2] || 0}`).join(';');
const decPts = (s) => typeof s === 'string' && s ? s.split(';').map(x => x.split(',').map(Number)) : (Array.isArray(s) ? s : []);
const walkToFB = w => ({ start: w.start, end: w.end, distM: Math.round(w.distM), durS: Math.round(w.durS), steps: w.steps, pts: encPts(w.pts) });

function setDot(st) { const d = $('#syncDot'); d.className = 'syncdot' + (st === 'on' ? ' on' : st === 'err' ? ' err' : ''); }
let syncing = false;
async function sync(silent) {
  if (!FB.ok()) { setDot(''); if (!silent) toast('Nejdřív vyplň Firebase v Nastavení'); return; }
  if (syncing) return; syncing = true; setDot('');
  try {
    const [days, events, walks] = await Promise.all([FB.list('days'), FB.list('events'), FB.list('walks')]);
    for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d.id)) D.days[d.id] = normDay(d);
    D.events = events.map(normEvent).filter(Boolean);
    const remote = new Set();
    for (const w of walks) { remote.add(w.id); const ex = D.walks.find(x => x.id === w.id); const obj = { id: w.id, start: w.start, end: w.end, distM: num(w.distM), durS: num(w.durS), steps: num(w.steps), pts: decPts(w.pts) }; if (ex) Object.assign(ex, obj); else D.walks.push(obj); }
    for (const w of D.walks) if (!remote.has(w.id)) { try { await FB.put('walks', w.id, walkToFB(w)); } catch (e) { } }
    await saveData('days', 'events', 'walks');
    S.lastSync = Date.now(); saveS(); setDot('on');
    if (!silent) toast(`Synchronizováno · ${days.length} dní, ${events.length} událostí`);
    if (curView !== 'settings') renderAll();
  } catch (e) { setDot('err'); if (!silent) toast('Synchronizace selhala: ' + e.message, 5000); console.warn(e); }
  finally { syncing = false; }
}

/* ================= Kroužky (SVG) ================= */
let ringUid = 0;
const RING = [{ c: '#fa114f', c2: '#ff3b77', bg: '#3b0a17', ic: '→' }, { c: '#92e82a', c2: '#b4ff3f', bg: '#203508', ic: '»' }, { c: '#1eeaef', c2: '#5cfaff', bg: '#0b3436', ic: '↑' }];
function ringsSVG(p, { size = 300, icons = false, anim = true } = {}) {
  const id = 'rg' + (++ringUid), sw = size * 0.105, gap = size * 0.012, c = size / 2;
  let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Kroužky aktivity"><defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="${sw * 0.12}" flood-color="#000" flood-opacity=".7"/></filter></defs>`;
  for (let i = 0; i < 3; i++) {
    const r = c - sw / 2 - i * (sw + gap), C = 2 * Math.PI * r, v = Math.max(0, p[i] || 0), R = RING[i];
    s += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${R.bg}" stroke-width="${sw}"/>`;
    const arc = (val, col, extra = '') => { const off = C * (1 - Math.min(val, 1)); return `<circle class="${anim ? 'ring-anim' : ''}" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${anim ? C : off}" data-off="${off}" transform="rotate(-90 ${c} ${c})" ${extra}/>`; };
    if (v > 0.003) s += arc(v, R.c);
    if (v > 1) s += arc(Math.min(v - 1, 1), R.c2, `filter="url(#${id})"`);
    if (icons) s += `<text x="${c}" y="${c - r}" text-anchor="middle" dominant-baseline="central" font-size="${sw * 0.62}" font-weight="900" fill="#000">${R.ic}</text>`;
  }
  return s + '</svg>';
}
function animateRings(root) { requestAnimationFrame(() => requestAnimationFrame(() => root.querySelectorAll('.ring-anim').forEach(el => el.style.strokeDashoffset = el.dataset.off))); }

/* ================= Navigace ================= */
let curView = 'today';
function show(v) {
  curView = v;
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === 'v-' + v));
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo(0, 0); render(v);
}
function render(v) { ({ today: renderToday, stats: renderStats, walk: renderWalk, awards: renderAwards, settings: renderSettings })[v]?.(); }
function renderAll() { render(curView); }

/* ================= SOUHRN (den) ================= */
let selDate = midnight(new Date());
function renderToday() {
  const today = midnight(new Date()), k = dkey(selDate), d = getDay(k);
  const diff = Math.round((today - selDate) / 864e5);
  $('#todaySub').textContent = diff === 0 ? 'Dnes' : diff === 1 ? 'Včera' : DOWL[wd(selDate)];
  $('#todayTitle').textContent = `${selDate.getDate()}. ${MONG[selDate.getMonth()]} ${selDate.getFullYear()}`;
  // týdenní pás
  const ws = startOfWeek(selDate);
  $('#wkLabel').textContent = `${ws.getDate()}. ${ws.getMonth() + 1}. – ${addDays(ws, 6).getDate()}. ${addDays(ws, 6).getMonth() + 1}.`;
  let h = '';
  for (let i = 0; i < 7; i++) {
    const dd = addDays(ws, i), x = getDay(dkey(dd)), fut = dd > today;
    h += `<button class="d ${+dd === +selDate ? 'sel' : ''} ${+dd === +today ? 'today' : ''}" data-k="${dkey(dd)}" ${fut ? 'disabled style="opacity:.35"' : ''}><span class="lbl">${DOW[i]}</span>${ringsSVG(fut ? [0, 0, 0] : [x.pMove, x.pEx, x.pSteps], { size: 40, anim: false })}</button>`;
  }
  $('#weekStrip').innerHTML = h;
  $('#weekStrip').querySelectorAll('button[data-k]').forEach(b => b.onclick = () => { selDate = parseKey(b.dataset.k); renderToday(); });
  $('#wkNext').disabled = addDays(ws, 7) > today; $('#wkNext').style.opacity = addDays(ws, 7) > today ? .35 : 1;
  // velké kroužky
  $('#bigRing').innerHTML = ringsSVG([d.pMove, d.pEx, d.pSteps], { size: 300, icons: true });
  animateRings($('#bigRing'));
  const est = d.est ? '<span class="badge-est">odhad z procházek</span>' : d.demo ? '<span class="badge-est">ukázka</span>' : '';
  $('#dayMetrics').innerHTML = d.has ? `
    <div class="metric"><div class="t">Pohyb ${est}</div><div class="v c-move">${nf(d.kcal)}/${nf(S.goals.kcal)} <small>KCAL</small></div></div>
    <div class="metric"><div class="t">Cvičení</div><div class="v c-ex">${nf(d.exMin)}/${nf(S.goals.exMin)} <small>MIN</small></div></div>
    <div class="metric"><div class="t">Kroky</div><div class="v c-st">${nf(d.steps)}/${nf(S.goals.steps)} <small>KROKŮ</small></div></div>`
    : `<div class="empty">Pro tento den zatím nejsou data.<br><span class="small">Data posílá Zkratka ze Zdraví (viz Nastavení → Zkratky), nebo zaznamenej procházku.</span></div>`;
  const outT = d.outings.reduce((s, o) => s + (o.durS || 0), 0);
  $('#dayMore').innerHTML = `<div class="kv">
    <div><div class="k">Vzdálenost</div><div class="v">${km(d.distM)} <small>KM</small></div></div>
    <div><div class="k">Vystoupaná patra</div><div class="v">${nf(d.flights)}</div></div>
    <div><div class="k">Procházky</div><div class="v">${d.walks.length}</div></div>
    <div><div class="k">Čas mimo domov</div><div class="v" style="font-size:24px">${outT ? fmtDurHM(outT) : '—'}</div></div></div>`;
  // 24h pás
  let strip = '';
  const pos = t => { const x = new Date(t); return ((x - parseKey(k)) / 864e5) * 100; };
  for (const o of d.outings) strip += `<i class="seg2" title="Mimo domov" style="left:${pos(o.start)}%;width:${Math.max(.6, pos(o.end || new Date()) - pos(o.start))}%;background:var(--orange);opacity:.55"></i>`;
  for (const w of d.walks) strip += `<i class="seg2" style="left:${pos(w.start)}%;width:${Math.max(.6, pos(w.end) - pos(w.start))}%;background:${w.src === 'gps' ? 'var(--ex)' : 'var(--blue)'};top:10px;bottom:10px"></i>`;
  let hourly = '';
  if (d.hourly) hourly = `<div style="margin-top:14px"><div class="small">Kroky po hodinách</div>${barChart(d.hourly.map((v, i) => ({ v, l: i % 6 === 0 ? i + '' : '' })), { color: 'var(--orange)', h: 120 })}</div>`;
  $('#dayStripCard').innerHTML = `<h3>Průběh dne</h3><div class="small"><span class="c-or">■</span> mimo domov &nbsp; <span class="c-ex">■</span> GPS procházka &nbsp; <span class="c-bl">■</span> Časová osa</div>
    <div class="strip">${strip}</div><div class="strip-axis"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>${hourly}`;
  // seznam aktivit dne
  const items = [...d.outings, ...d.walks].sort((a, b) => new Date(a.start) - new Date(b.start));
  $('#dayLists').innerHTML = items.length ? `<h2>Aktivity dne</h2><div class="card">${items.map(walkItem).join('')}</div>` : '';
  bindWalkItems($('#dayLists'), items);
  $('#insights').innerHTML = insightsHTML();
}

/* ================= Graf (SVG sloupce) ================= */
function barChart(data, { h = 170, color = 'var(--orange)', goal = null, avg = null, fmt = v => nf(v), hiIdx = -1 } = {}) {
  const W = 340, top = 14, bottom = 18, n = data.length || 1;
  const max = Math.max(1, ...data.map(x => x.v), goal || 0, avg || 0) * 1.08;
  const bw = W / n, gw = Math.max(1.5, bw * (n > 40 ? .55 : .62));
  const y = v => top + (h - top - bottom) * (1 - v / max);
  let s = `<svg class="chart" viewBox="0 0 ${W + 34} ${h}">`;
  for (const t of [0, .5, 1]) { const yy = y(max / 1.08 * t); s += `<line x1="0" x2="${W}" y1="${yy}" y2="${yy}" stroke="#2a2a2c" stroke-dasharray="${t ? '2 3' : ''}"/><text x="${W + 4}" y="${yy + 3}">${fmt(max / 1.08 * t)}</text>`; }
  data.forEach((x, i) => {
    const bh = Math.max(0, h - bottom - y(x.v)); const xx = i * bw + (bw - gw) / 2;
    if (x.v > 0) s += `<rect x="${xx}" y="${y(x.v)}" width="${gw}" height="${Math.max(bh, 1.5)}" rx="${Math.min(3, gw / 2)}" fill="${color}" opacity="${hiIdx < 0 || hiIdx === i ? 1 : .45}"><title>${esc(x.t || '')} ${fmt(x.v)}</title></rect>`;
    if (x.l) s += `<text x="${i * bw + bw / 2}" y="${h - 4}" text-anchor="middle">${esc(x.l)}</text>`;
  });
  if (goal) s += `<line x1="0" x2="${W}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--ex)" stroke-width="1.2" stroke-dasharray="5 4"/><text x="2" y="${y(goal) - 3}" style="fill:var(--ex)">cíl</text>`;
  if (avg) s += `<line x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/><text x="${W - 2}" y="${y(avg) - 3}" text-anchor="end" style="fill:#fff">Ø</text>`;
  return s + '</svg>';
}

/* ================= Důležité informace (chytré přehledy) ================= */
function rangeStats(from, n, m = 'steps') { let s = 0, c = 0; const arr = []; for (let i = 0; i < n; i++) { const x = getDay(dkey(addDays(from, i))); arr.push(x.has ? x[m] : 0); if (x.has) { s += x[m]; c++; } } return { avg: c ? s / c : 0, sum: s, c, arr }; }
function insightsHTML() {
  const t = midnight(new Date()), out = [];
  const l7 = rangeStats(addDays(t, -6), 7), p7 = rangeStats(addDays(t, -13), 7);
  if (l7.c >= 2) {
    const dl = p7.c ? (l7.avg - p7.avg) / p7.avg * 100 : null;
    out.push(`<div class="insight"><div class="tag c-or">🔥 Kroky</div><p>V posledních 7 dnech jsi ušel v průměru ${nf(l7.avg)} kroků.${dl != null ? ` <span class="delta ${dl >= 0 ? 'up' : 'down'}">${dl >= 0 ? '▲' : '▼'} ${nf(Math.abs(dl))} % proti předchozímu týdnu</span>` : ''}</p>
      ${barChart(l7.arr.map((v, i) => ({ v, l: DOW[wd(addDays(t, -6 + i))] })), { h: 120, color: '#5a5a5e', avg: l7.avg, hiIdx: 6 })}</div>`);
  }
  const y = t.getFullYear(), jan1 = new Date(y, 0, 1), ly = new Date(y - 1, 0, 1);
  const cy = rangeStats(jan1, Math.round((t - jan1) / 864e5) + 1), py = rangeStats(ly, Math.round((jan1 - ly) / 864e5));
  if (cy.c >= 14 && py.c >= 14) {
    const more = cy.avg >= py.avg, mx = Math.max(cy.avg, py.avg);
    out.push(`<div class="insight"><div class="tag c-or">🔥 Kroky</div><p>Ve srovnání s loňským rokem letos chodíš v průměru ${more ? 'více' : 'méně'}.</p>
      <div class="bigstat"><div class="num" style="font-size:30px">${nf(cy.avg)} <small>kroků/den</small></div></div><div class="hbar" style="width:${cy.avg / mx * 100}%;background:var(--orange)">${y}</div>
      <div class="bigstat" style="margin-top:10px"><div class="num" style="font-size:30px">${nf(py.avg)} <small>kroků/den</small></div></div><div class="hbar" style="width:${py.avg / mx * 100}%;background:#3a3a3c">${y - 1}</div></div>`);
  }
  // nejaktivnější den v týdnu (90 dní)
  const byW = Array.from({ length: 7 }, () => ({ s: 0, c: 0 }));
  for (let i = 0; i < 90; i++) { const dd = addDays(t, -i), x = getDay(dkey(dd)); if (x.has) { byW[wd(dd)].s += x.steps; byW[wd(dd)].c++; } }
  const wa = byW.map(x => x.c ? x.s / x.c : 0);
  if (byW.filter(x => x.c).length >= 5) {
    const bi = wa.indexOf(Math.max(...wa)), wi = wa.indexOf(Math.min(...wa.filter(v => v > 0)));
    out.push(`<div class="insight"><div class="tag c-st">📅 Týdenní rytmus</div><p>Nejvíc chodíš v ${['pondělí', 'úterý', 'středu', 'čtvrtek', 'pátek', 'sobotu', 'neděli'][bi]} (Ø ${nf(wa[bi])} kroků), nejméně v ${['pondělí', 'úterý', 'středu', 'čtvrtek', 'pátek', 'sobotu', 'neděli'][wi]}.</p>
      ${barChart(wa.map((v, i) => ({ v, l: DOWS[i] })), { h: 110, color: 'var(--st)', hiIdx: bi })}<div class="small">Posledních 90 dní</div></div>`);
  }
  // měsíc vs. minulý měsíc (stejný počet dní)
  const m1 = new Date(y, t.getMonth(), 1), pm = new Date(y, t.getMonth() - 1, 1), nd = t.getDate();
  const cm = rangeStats(m1, nd, 'distM'), pmm = rangeStats(pm, Math.min(nd, new Date(y, t.getMonth(), 0).getDate()), 'distM');
  if (cm.c >= 3) {
    const dl = pmm.sum ? (cm.sum - pmm.sum) / pmm.sum * 100 : null;
    out.push(`<div class="insight"><div class="tag c-ex">🗺️ Vzdálenost</div><p>Tento měsíc jsi zatím ušel ${km(cm.sum)} km.${dl != null ? ` <span class="delta ${dl >= 0 ? 'up' : 'down'}">${dl >= 0 ? '▲' : '▼'} ${nf(Math.abs(dl))} % proti stejnému období minulého měsíce</span>` : ''}</p></div>`);
  }
  // chytrý cíl
  const l30 = []; for (let i = 0; i < 30; i++) { const x = getDay(dkey(addDays(t, -i))); if (x.has) l30.push(x.steps); }
  if (l30.length >= 14) {
    const met = l30.filter(v => v >= S.goals.steps).length, med = [...l30].sort((a, b) => a - b)[Math.floor(l30.length / 2)];
    let tip = '';
    if (met / l30.length >= .8) tip = `Cíl plníš skoro pořád — zkus ho zvýšit na <b>${nf(Math.ceil(med * 1.1 / 500) * 500)}</b> kroků.`;
    else if (met / l30.length < .3) tip = `Cíl je teď možná moc vysoko — realistický cíl podle mediánu je <b>${nf(Math.round(med / 500) * 500)}</b> kroků.`;
    else tip = 'Cíl máš nastavený tak akorát. 👍';
    out.push(`<div class="insight"><div class="tag" style="color:var(--yellow)">🎯 Cíl kroků</div><p>Za posledních 30 dní jsi cíl ${nf(S.goals.steps)} kroků splnil ${met}× z ${l30.length} dní.</p><div class="small" style="font-size:15px;color:#ddd">${tip}</div></div>`);
  }
  return out.length ? out.join('') : '<div class="empty">Přehledy se objeví, až bude k dispozici aspoň pár dní dat.</div>';
}

/* ================= STATISTIKY ================= */
let per = 'W', perAnchor = midnight(new Date()), perMetric = 'steps';
const MET = {
  steps: { n: 'Kroky', u: 'kroků', c: 'var(--orange)', f: v => nf(v), goal: () => S.goals.steps },
  distM: { n: 'Vzdálenost', u: 'km', c: 'var(--blue)', f: v => km(v), goal: () => null },
  kcal: { n: 'Pohyb', u: 'kcal', c: 'var(--move)', f: v => nf(v), goal: () => S.goals.kcal },
  exMin: { n: 'Cvičení', u: 'min', c: 'var(--ex)', f: v => nf(v), goal: () => S.goals.exMin },
  flights: { n: 'Patra', u: 'pater', c: 'var(--purple)', f: v => nf(v), goal: () => null }
};
function perRange(p, a) {
  if (p === 'D') return { from: a, to: a, label: fmtLong(a) };
  if (p === 'W') { const f = startOfWeek(a); return { from: f, to: addDays(f, 6), label: `${f.getDate()}. ${MONG[f.getMonth()]} – ${addDays(f, 6).getDate()}. ${MONG[addDays(f, 6).getMonth()]} ${addDays(f, 6).getFullYear()}` }; }
  if (p === 'M') { const f = new Date(a.getFullYear(), a.getMonth(), 1); return { from: f, to: new Date(a.getFullYear(), a.getMonth() + 1, 0), label: `${MON[a.getMonth()]} ${a.getFullYear()}` }; }
  if (p === '6M') { const t = new Date(a.getFullYear(), a.getMonth() + 1, 0), f = new Date(a.getFullYear(), a.getMonth() - 5, 1); return { from: f, to: t, label: `${MONS[f.getMonth()]} ${f.getFullYear()} – ${MONS[t.getMonth()]} ${t.getFullYear()}` }; }
  return { from: new Date(a.getFullYear(), 0, 1), to: new Date(a.getFullYear(), 11, 31), label: `rok ${a.getFullYear()}` };
}
function shiftAnchor(p, a, dir) {
  if (p === 'D') return addDays(a, dir);
  if (p === 'W') return addDays(a, 7 * dir);
  if (p === 'M') return new Date(a.getFullYear(), a.getMonth() + dir, Math.min(a.getDate(), 28));
  if (p === '6M') return new Date(a.getFullYear(), a.getMonth() + 6 * dir, 1);
  return new Date(a.getFullYear() + dir, a.getMonth(), 1);
}
function collect(from, to) {
  const today = midnight(new Date()), out = [];
  for (let d = new Date(from); d <= to && d <= today; d = addDays(d, 1)) out.push({ d: new Date(d), k: dkey(d), x: getDay(dkey(d)) });
  return out;
}
function summarize(list, m) {
  const w = list.filter(e => e.x.has); const sum = w.reduce((s, e) => s + e.x[m], 0);
  const best = w.reduce((b, e) => !b || e.x[m] > b.x[m] ? e : b, null);
  return { sum, avg: w.length ? sum / w.length : 0, n: w.length, best, goalMet: w.filter(e => e.x.pSteps >= 1).length, closed: w.filter(e => e.x.closed).length };
}
function renderStats() {
  const M = MET[perMetric], r = perRange(per, perAnchor), today = midnight(new Date());
  $('#perLabel').textContent = r.label;
  $('#perNext').style.opacity = r.to >= today ? .3 : 1; $('#perNext').disabled = r.to >= today;
  const list = collect(r.from, r.to), sm = summarize(list, perMetric);
  const pr = perRange(per, shiftAnchor(per, perAnchor, -1)), psm = summarize(collect(pr.from, pr.to), perMetric);
  const delta = psm.n && sm.n ? (sm.avg - psm.avg) / (psm.avg || 1) * 100 : null;
  const dHTML = delta != null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${nf(Math.abs(delta))} %</span> <span class="small">proti předchozímu období</span>` : '';
  let chart = '', mainLab = per === 'D' ? 'CELKEM' : 'PRŮMĚR / DEN', mainVal = per === 'D' ? (list[0]?.x[perMetric] || 0) : sm.avg;
  if (per === 'D') {
    const x = list[0]?.x;
    if (x?.hourly && perMetric === 'steps') chart = barChart(x.hourly.map((v, i) => ({ v, l: i % 6 === 0 ? i + ':00' : '' })), { color: M.c });
    else {
      // srovnání dne s 30denním průměrem pro všechny metriky
      const base = summarizeAll(collect(addDays(perAnchor, -30), addDays(perAnchor, -1)));
      chart = Object.entries(MET).map(([k, mm]) => { const v = x?.[k] || 0, a = base[k] || 0, mx = Math.max(v, a, 1); return `<div style="margin:10px 0"><div class="row between small"><span>${mm.n}</span><span>${mm.f(v)} ${mm.u} · Ø30 ${mm.f(a)}</span></div><div class="progress"><i style="width:${v / mx * 100}%;background:${mm.c}"></i></div></div>`; }).join('');
    }
  } else if (per === 'W' || per === 'M') {
    const days = []; for (let d = new Date(r.from); d <= r.to; d = addDays(d, 1)) { const x = getDay(dkey(d)); days.push({ v: d <= today && x.has ? x[perMetric] : 0, l: per === 'W' ? DOW[wd(d)] : ([1, 8, 15, 22, 29].includes(d.getDate()) ? d.getDate() + '' : ''), t: fmtShort(d) }); }
    chart = barChart(days, { color: M.c, goal: M.goal(), avg: sm.avg, fmt: M.f });
  } else if (per === '6M') {
    const wk = []; let ws = startOfWeek(r.from);
    while (ws <= r.to) { const s2 = summarize(collect(ws, addDays(ws, 6)), perMetric); wk.push({ v: s2.avg, l: ws.getDate() <= 7 ? MONS[ws.getMonth()] : '', t: 'týden od ' + fmtShort(ws) }); ws = addDays(ws, 7); }
    chart = barChart(wk, { color: M.c, goal: M.goal(), avg: sm.avg, fmt: M.f }) + '<div class="small">Sloupec = průměr na den v týdnu</div>';
  } else {
    const mo = []; for (let i = 0; i < 12; i++) { const f = new Date(r.from.getFullYear(), i, 1); const s2 = summarize(collect(f, new Date(f.getFullYear(), i + 1, 0)), perMetric); mo.push({ v: s2.avg, l: MON[i][0].toUpperCase(), t: MON[i] }); }
    chart = barChart(mo, { color: M.c, goal: M.goal(), avg: sm.avg, fmt: M.f }) + '<div class="small">Sloupec = průměr na den v měsíci</div>';
  }
  $('#statMain').innerHTML = `<div class="bigstat"><div class="lab">${mainLab}</div><div class="num">${M.f(mainVal)} <small>${M.u}</small></div><div>${per !== 'D' ? dHTML : ''}</div></div><div style="margin-top:10px">${chart}</div>`;
  const g = [
    ['Celkem', `${M.f(sm.sum)} <span class="small">${M.u}</span>`],
    ['Ø na den', `${M.f(sm.avg)}`],
    ['Nejlepší den', sm.best ? `${M.f(sm.best.x[perMetric])}<div class="small">${fmtShort(sm.best.d)}</div>` : '—'],
    ['Dny s daty', `${sm.n} <span class="small">/ ${list.length}</span>`],
    ['Splněný cíl kroků', `${sm.goalMet}×`],
    ['Uzavřené kroužky', `${sm.closed}×`]
  ];
  $('#statGrid').innerHTML = per === 'D' ? '' : g.map(([l, n]) => `<div class="card"><div class="l">${l}</div><div class="n">${n}</div></div>`).join('');
  // doplňky
  let ex = '';
  if (per === 'Y' || per === '6M') ex += `<h2>Kalendář aktivity</h2><div class="card">${heatmap(r.from, r.to)}<div class="small" style="margin-top:6px">Barva = podíl splnění cíle kroků (${nf(S.goals.steps)})</div></div>`;
  if (per !== 'D' && per !== 'W' && sm.n >= 7) {
    const byW = Array.from({ length: 7 }, () => ({ s: 0, c: 0 })); list.filter(e => e.x.has).forEach(e => { byW[wd(e.d)].s += e.x[perMetric]; byW[wd(e.d)].c++; });
    ex += `<h2>Podle dne v týdnu</h2><div class="card">${barChart(byW.map((x, i) => ({ v: x.c ? x.s / x.c : 0, l: DOWS[i] })), { color: M.c, h: 130, fmt: M.f })}</div>`;
  }
  if (per === 'W' || per === 'M') {
    const rows = list.filter(e => e.x.has).reverse().map(e => `<div class="item"><div style="width:44px">${ringsSVG([e.x.pMove, e.x.pEx, e.x.pSteps], { size: 40, anim: false })}</div><div class="main"><div class="ttl">${DOWL[wd(e.d)]} ${fmtShort(e.d)}</div><div class="meta">${nf(e.x.steps)} kroků · ${km(e.x.distM)} km · ${nf(e.x.kcal)} kcal · ${nf(e.x.exMin)} min${e.x.est ? ' · odhad' : ''}</div></div></div>`).join('');
    if (rows) ex += `<h2>Jednotlivé dny</h2><div class="card">${rows}</div>`;
  }
  $('#statExtra').innerHTML = ex;
}
function summarizeAll(list) { const o = {}; for (const m of Object.keys(MET)) o[m] = summarize(list, m).avg; return o; }
function heatmap(from, to) {
  const today = midnight(new Date()); let s = ''; const st = startOfWeek(from);
  for (let d = new Date(st); d <= to; d = addDays(d, 1)) {
    if (d < from || d > today) { s += '<i style="opacity:.25"></i>'; continue; }
    const x = getDay(dkey(d)); if (!x.has) { s += `<i title="${fmtShort(d)}"></i>`; continue; }
    const p = Math.min(1.5, x.pSteps), a = .15 + Math.min(1, p) * .85;
    s += `<i title="${fmtShort(d)}: ${nf(x.steps)} kroků" style="background:${p >= 1 ? `rgba(146,232,42,${p >= 1.5 ? 1 : .8})` : `rgba(30,234,239,${a * .8})`}"></i>`;
  }
  return `<div class="heat">${s}</div>`;
}

/* ================= PROCHÁZKY: GPS záznam ================= */
let T = null, tickH = null, liveMap = null, livePoly = null, liveDot = null, wakeLock = null;
function saveLive() { try { T ? localStorage.setItem('aktivita_live', JSON.stringify({ ...T, watchId: null })) : localStorage.removeItem('aktivita_live'); } catch (e) { } }
async function requestWake() { try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) { wakeLock = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && T?.active) { requestWake(); if (T.lastTs && Date.now() - T.lastTs > 60000) T.gap = true; renderWalk(); } });
function startWalk() {
  if (!('geolocation' in navigator)) return toast('Tento prohlížeč nepodporuje polohu');
  T = { active: true, paused: false, startTs: Date.now(), pausedMs: 0, pauseTs: 0, pts: [], distM: 0, acc: null, lastTs: Date.now(), gap: false };
  beginWatch(); requestWake(); saveLive(); renderWalk();
}
function beginWatch() {
  T.watchId = navigator.geolocation.watchPosition(onPos, e => { if (e.code === 1) toast('Přístup k poloze zamítnut – povol ho v Nastavení iPhonu → Soukromí → Polohové služby', 5000); else { const el = document.getElementById('lvAcc'); if (el) el.textContent = 'hledám signál GPS…'; } }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  clearInterval(tickH); tickH = setInterval(tick, 1000);
}
function onPos(p) {
  if (!T || T.paused) return;
  const { latitude: la, longitude: lo, accuracy: ac } = p.coords; T.acc = ac; T.lastTs = Date.now();
  if (ac > 40) return tick();
  const t = Math.round((p.timestamp - T.startTs) / 1000), last = T.pts[T.pts.length - 1];
  if (last) { const d = hav(last[0], last[1], la, lo), dt = t - last[2]; if (d < 4) return tick(); if (dt > 0 && d / dt > 8) return; T.distM += d; }
  T.pts.push([+la.toFixed(6), +lo.toFixed(6), t]); saveLive();
  if (liveMap && window.L) { livePoly.addLatLng([la, lo]); liveDot.setLatLng([la, lo]); liveMap.panTo([la, lo]); }
  tick();
}
function elapsed() { return T ? ((T.paused ? T.pauseTs : Date.now()) - T.startTs - T.pausedMs) / 1000 : 0; }
function tick() {
  if (!T || curView !== 'walk') return;
  const e = elapsed(), pace = T.distM > 30 ? e / (T.distM / 1000) : 0;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('lvTime', fmtDur(e)); set('lvKm', km(T.distM)); set('lvPace', pace ? fmtDur(pace) : '–:––'); set('lvSteps', nf(T.distM / S.stride));
  set('lvAcc', T.acc ? `přesnost GPS ±${Math.round(T.acc)} m` : 'čekám na GPS…');
}
function pauseWalk() { if (!T) return; if (T.paused) { T.pausedMs += Date.now() - T.pauseTs; T.paused = false; } else { T.paused = true; T.pauseTs = Date.now(); } saveLive(); renderWalk(); }
function stopWalk() {
  openSheet(`<h3>Ukončit procházku?</h3><p class="sub">${km(T.distM)} km · ${fmtDur(elapsed())}</p>
    <button class="btn primary block" id="swSave">Uložit</button><div style="height:8px"></div>
    <button class="btn block" id="swCont">Pokračovat</button><div style="height:8px"></div>
    <button class="btn danger block" id="swDel">Zahodit</button>`);
  $('#swCont').onclick = closeSheet;
  $('#swDel').onclick = () => { endTracking(); closeSheet(); toast('Procházka zahozena'); renderWalk(); };
  $('#swSave').onclick = async () => {
    const e = elapsed(), w = { id: 'w' + T.startTs, start: new Date(T.startTs).toISOString(), end: new Date().toISOString(), distM: Math.round(T.distM), durS: Math.round(e), steps: Math.round(T.distM / S.stride), pts: T.pts };
    endTracking(); closeSheet();
    if (w.distM < 20) { toast('Procházka je moc krátká, neukládám'); return renderWalk(); }
    D.walks.push(w); await saveData('walks'); toast('Procházka uložena 🎉');
    if (FB.ok()) FB.put('walks', w.id, walkToFB(w)).catch(err => toast('Do Firebase se neuložilo: ' + err.message));
    renderWalk();
  };
}
function endTracking() { if (T?.watchId != null) navigator.geolocation.clearWatch(T.watchId); clearInterval(tickH); T = null; saveLive(); try { wakeLock?.release(); } catch (e) { } wakeLock = null; liveMap = null; }
function renderWalk() {
  const c = $('#trackerCard');
  if (!T) {
    c.innerHTML = `<div class="sub">Záznam trasy přes GPS</div><button class="startbtn" id="btnStart"><span style="font-size:40px">🚶</span>Start</button>
      <div class="small">Při záznamu nech aplikaci otevřenou – displej zůstane rozsvícený.<br>Kroky během dne měří Zdraví i bez ní.</div>`;
    $('#btnStart').onclick = startWalk;
  } else {
    c.innerHTML = `<div class="row between"><span class="pill">${T.paused ? '⏸ Pozastaveno' : '<span class="syncdot on"></span> Nahrávám'}</span><span class="small" id="lvAcc"></span></div>
      <div class="time" id="lvTime">0:00</div>
      <div class="tg"><div><div class="n" id="lvKm">0</div><div class="small">km</div></div><div><div class="n" id="lvPace">–:––</div><div class="small">min/km</div></div><div><div class="n" id="lvSteps">0</div><div class="small">kroků (odhad)</div></div></div>
      <div class="map" id="liveMap"></div>
      ${T.gap ? '<div class="warn">⚠️ Při zamčeném displeji nebo jiné aplikaci iOS polohu nezaznamenává – trasa může mít mezeru (spojí se rovnou čarou).</div>' : ''}
      ${!('wakeLock' in navigator) ? '<div class="warn">Tento iOS neumí držet displej rozsvícený – vypni dočasně automatický zámek obrazovky.</div>' : ''}
      <div class="grid2"><button class="btn" id="btnPause">${T.paused ? '▶︎ Pokračovat' : '⏸ Pauza'}</button><button class="btn danger" id="btnStop">■ Konec</button></div>`;
    $('#btnPause').onclick = pauseWalk; $('#btnStop').onclick = stopWalk;
    if (window.L) {
      liveMap = L.map('liveMap', { zoomControl: false, attributionControl: false }).setView(T.pts.length ? T.pts[T.pts.length - 1] : [50.2092, 15.8328], 16);
      tiles().addTo(liveMap);
      livePoly = L.polyline(T.pts.map(p => [p[0], p[1]]), { color: '#92e82a', weight: 5 }).addTo(liveMap);
      liveDot = L.circleMarker(T.pts.length ? T.pts[T.pts.length - 1] : [50.2092, 15.8328], { radius: 7, color: '#fff', weight: 2, fillColor: '#1eeaef', fillOpacity: 1 }).addTo(liveMap);
    }
    tick();
  }
  renderWalkList();
}
const tiles = () => L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© OpenStreetMap, © CARTO' });

/* Historie procházek */
let walkFilter = 'all', walkLimit = 40;
function allActivities() {
  const a = [...D.walks.map(w => ({ ...w, src: 'gps' })), ...(D.tl.walks || []).map(w => ({ ...w, src: 'tl' })), ...IDX.outings];
  return a.filter(x => walkFilter === 'all' || x.src === walkFilter).sort((x, y) => new Date(y.start) - new Date(x.start));
}
function walkItem(x) {
  const s = new Date(x.start), e = x.end ? new Date(x.end) : null;
  const ic = x.src === 'gps' ? ['🚶', '#203508'] : x.src === 'tl' ? ['🗺️', '#0a2440'] : ['🏠', '#3a1e05'];
  const title = x.src === 'gps' ? 'Procházka (GPS)' : x.src === 'tl' ? (x.type === 'running' ? 'Běh (Časová osa)' : 'Chůze (Časová osa)') : (x.ongoing ? 'Právě jsi venku' : 'Mimo domov');
  const right = x.distM != null ? `${km(x.distM)} km` : (x.durS ? fmtDurHM(x.durS) : '');
  const meta = `${DOWS[wd(s)]} ${fmtShort(s)} · ${fmtTime(s)}${e ? '–' + fmtTime(e) : ''}${x.steps != null && x.src !== 'tl' ? ` · ${nf(x.steps)} kroků` : ''}`;
  return `<div class="item" data-id="${esc(x.id)}" style="cursor:pointer"><div class="ic" style="background:${ic[1]}">${ic[0]}</div><div class="main"><div class="ttl">${title}</div><div class="meta">${meta}</div></div><div class="right">${right}<div class="small">›</div></div></div>`;
}
function bindWalkItems(root, list) { root.querySelectorAll('.item[data-id]').forEach(el => el.onclick = () => { const x = list.find(y => y.id === el.dataset.id); if (x) walkDetail(x); }); }
function renderWalkList() {
  const list = allActivities(), el = $('#walkList');
  if (!list.length) { el.innerHTML = `<div class="empty">Zatím žádné procházky.<br><span class="small">Zaznamenej GPS procházku, nastav Zkratky pro odchody z domu, nebo importuj Časovou osu Google (Nastavení → Data).</span></div>`; return; }
  el.innerHTML = list.slice(0, walkLimit).map(walkItem).join('') + (list.length > walkLimit ? `<button class="btn block" id="moreW" style="margin-top:10px">Zobrazit další (${list.length - walkLimit})</button>` : '');
  bindWalkItems(el, list);
  const m = $('#moreW'); if (m) m.onclick = () => { walkLimit += 40; renderWalkList(); };
}
function walkDetail(x) {
  const s = new Date(x.start), e = x.end ? new Date(x.end) : new Date();
  let pts = (x.pts || []).map(p => [p[0], p[1]]);
  let related = [];
  if (x.src === 'out') related = [...D.walks.map(w => ({ ...w, src: 'gps' })), ...(D.tl.walks || []).map(w => ({ ...w, src: 'tl' }))].filter(w => new Date(w.start) >= s && new Date(w.start) <= e);
  if (!pts.length && related.length) pts = related.flatMap(w => (w.pts || []).map(p => [p[0], p[1]]));
  const dur = x.durS || (e - s) / 1000, pace = x.distM > 30 ? dur / (x.distM / 1000) : 0;
  openSheet(`<div class="grab"></div><h3>${x.src === 'gps' ? 'Procházka (GPS)' : x.src === 'tl' ? 'Chůze z Časové osy' : 'Mimo domov'}</h3>
    <div class="sub">${fmtLong(s)} · ${fmtTime(s)}${x.end ? '–' + fmtTime(e) : ' (probíhá)'}</div>
    ${pts.length > 1 ? '<div class="map" id="detMap"></div>' : ''}
    <div class="statgrid" style="margin:12px 0">
      <div class="card"><div class="l">Vzdálenost</div><div class="n">${x.distM != null ? km(x.distM) + ' km' : '—'}</div></div>
      <div class="card"><div class="l">Čas</div><div class="n">${fmtDur(dur)}</div></div>
      <div class="card"><div class="l">Tempo</div><div class="n">${pace ? fmtDur(pace) + ' /km' : '—'}</div></div>
      <div class="card"><div class="l">Kroky</div><div class="n">${x.steps != null ? nf(x.steps) : x.distM ? '~' + nf(x.distM / S.stride) : '—'}</div></div>
    </div>
    ${x.src === 'out' && x.steps == null ? '<div class="small">Kroky se počítají jen když odchod i příchod proběhly ve stejný den.</div>' : ''}
    ${related.length ? `<div class="small">Během pobytu venku: ${related.length} zaznamenaná procházka/y.</div>` : ''}
    <div class="grid2" style="margin-top:12px">
      ${pts.length > 1 ? '<button class="btn" id="dGm">📍 Google Mapy</button><button class="btn" id="dGpx">⬇︎ GPX</button>' : ''}
      ${x.src === 'gps' ? '<button class="btn danger" id="dDel">Smazat</button>' : ''}
      <button class="btn" id="dClose">Zavřít</button></div>`);
  if (pts.length > 1 && window.L) setTimeout(() => { const m = L.map('detMap', { attributionControl: false }); tiles().addTo(m); const pl = L.polyline(pts, { color: x.src === 'tl' ? '#0a84ff' : '#92e82a', weight: 5 }).addTo(m); L.circleMarker(pts[0], { radius: 6, color: '#92e82a', fillOpacity: 1 }).addTo(m); L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fa114f', fillOpacity: 1 }).addTo(m); m.fitBounds(pl.getBounds(), { padding: [20, 20] }); }, 60);
  $('#dClose').onclick = closeSheet;
  const gm = $('#dGm'); if (gm) gm.onclick = () => window.open(gmapsUrl(pts), '_blank');
  const gx = $('#dGpx'); if (gx) gx.onclick = () => downloadFile(`prochazka-${dkey(s)}.gpx`, gpx(x, pts), 'application/gpx+xml');
  const dl = $('#dDel'); if (dl) dl.onclick = async () => { D.walks = D.walks.filter(w => w.id !== x.id); await saveData('walks'); if (FB.ok()) FB.del('walks', x.id).catch(() => { }); closeSheet(); toast('Smazáno'); renderAll(); };
}
function gmapsUrl(pts) {
  const f = p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`, n = pts.length, wp = [];
  for (let i = 1; i <= 8 && n > 2; i++) wp.push(f(pts[Math.round(i * (n - 1) / 9)]));
  return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${f(pts[0])}&destination=${f(pts[n - 1])}${wp.length ? '&waypoints=' + encodeURIComponent(wp.join('|')) : ''}`;
}
function gpx(x, pts) {
  const st = new Date(x.start).getTime();
  const trk = (x.pts || []).length ? x.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<time>${new Date(st + p[2] * 1000).toISOString()}</time>` : ''}</trkpt>`).join('') : pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Aktivita PWA" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Procházka ${esc(fmtShort(new Date(x.start)))}</name><trkseg>${trk}</trkseg></trk></gpx>`;
}
async function downloadFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= ÚSPĚCHY ================= */
function allDayKeys() { return [...new Set([...Object.keys(D.days), ...Object.keys(D.demo), ...Object.keys(IDX.walksByDay)])].sort(); }
function streaks(test) {
  const keys = allDayKeys(); if (!keys.length) return { cur: 0, best: 0 };
  let best = 0, run = 0; const today = midnight(new Date());
  for (let d = parseKey(keys[0]); d <= today; d = addDays(d, 1)) { if (test(getDay(dkey(d)))) { run++; best = Math.max(best, run); } else run = 0; }
  let cur = 0, d = today; if (!test(getDay(dkey(d)))) d = addDays(d, -1);
  while (test(getDay(dkey(d)))) { cur++; d = addDays(d, -1); }
  return { cur, best };
}
const HOME = [50.2092, 15.8328]; // Hradec Králové – centrum
const CHALLENGES = [
  { id: 'snezka', n: 'Na Sněžku', to: 'Sněžka', ll: [50.7360, 15.7398] },
  { id: 'praha', n: 'Do Prahy', to: 'Praha', ll: [50.0875, 14.4213] },
  { id: 'brno', n: 'Do Brna', to: 'Brno', ll: [49.1951, 16.6068] },
  { id: 'viden', n: 'Do Vídně', to: 'Vídeň', ll: [48.2082, 16.3738] },
  { id: 'berlin', n: 'Do Berlína', to: 'Berlín', ll: [52.5200, 13.4050] },
  { id: 'rim', n: 'Do Říma', to: 'Řím', ll: [41.9028, 12.4964] }
].map(c => ({ ...c, m: hav(HOME[0], HOME[1], c.ll[0], c.ll[1]) }));
function renderAwards() {
  const sc = streaks(x => x.closed), ss = streaks(x => x.has && x.pSteps >= 1), today = midnight(new Date());
  let dots = ''; for (let i = 29; i >= 0; i--) { const x = getDay(dkey(addDays(today, -i))); dots += `<i style="display:inline-block;width:9px;height:9px;border-radius:50%;margin:1px;background:${x.closed ? 'var(--ex)' : x.pSteps >= 1 ? 'var(--st)' : x.has ? '#3a3a3c' : '#1c1c1e'}"></i>`; }
  $('#streakCard').innerHTML = `<div class="grid2">
    <div><div class="small">🔥 Série uzavřených kroužků</div><div class="bigstat"><div class="num">${sc.cur} <small>dní</small></div></div><div class="small">rekord ${sc.best}</div></div>
    <div><div class="small">👟 Série cíle kroků</div><div class="bigstat"><div class="num">${ss.cur} <small>dní</small></div></div><div class="small">rekord ${ss.best}</div></div></div>
    <div style="margin-top:12px">${dots}</div><div class="small">Posledních 30 dní · <span class="c-ex">●</span> všechny kroužky · <span class="c-st">●</span> cíl kroků</div>`;
  // výzva
  const ch = CHALLENGES.find(c => c.id === S.challenge.id) || CHALLENGES[1];
  if (!S.challenge.start) { S.challenge.start = dkey(addDays(today, -6)); saveS(); }
  let walked = 0; for (let d = parseKey(S.challenge.start); d <= today; d = addDays(d, 1)) walked += getDay(dkey(d)).distM;
  const p = Math.min(1, walked / ch.m), l30 = rangeStats(addDays(today, -29), 30, 'distM'), perDay = l30.c ? l30.sum / 30 : 0;
  const eta = p < 1 && perDay > 0 ? Math.ceil((ch.m - walked) / perDay) : null;
  $('#challengeCard').innerHTML = `<div class="chips">${CHALLENGES.map(c => `<button class="chip ${c.id === ch.id ? 'on' : ''}" data-c="${c.id}">${c.n}</button>`).join('')}</div>
    <div class="row between" style="margin-top:8px"><b>Hradec Králové → ${esc(ch.to)}</b><span class="small">${nf(ch.m / 1000)} km vzdušnou čarou</span></div>
    <div class="progress" style="height:14px"><i style="width:${p * 100}%"></i></div>
    <div class="row between small"><span>${km(walked)} km ušlo (od ${fmtShort(parseKey(S.challenge.start))})</span><span>${nf(p * 100)} %</span></div>
    <p class="sub" style="margin:10px 0 6px">${p >= 1 ? '🏁 Výzva splněna! Gratuluju!' : eta ? `Při tvém tempu (Ø ${km(perDay)} km/den) dorazíš za cca <b style="color:#fff">${eta} dní</b> – kolem ${fmtShort(addDays(today, eta))}.` : 'Začni chodit a uvidíš odhad příchodu.'}</p>
    <button class="btn sm" id="chReset">Začít výzvu znovu ode dneška</button>`;
  $('#challengeCard').querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.challenge = { id: b.dataset.c, start: dkey(today) }; saveS(); renderAwards(); });
  $('#chReset').onclick = () => { S.challenge.start = dkey(today); saveS(); renderAwards(); };
  // rekordy
  const keys = allDayKeys(); let bs = null, bd = null, bk = null;
  for (const k of keys) { const x = getDay(k); if (!x.has) continue; if (!bs || x.steps > bs.v) bs = { v: x.steps, k }; if (!bd || x.distM > bd.v) bd = { v: x.distM, k }; if (!bk || x.kcal > bk.v) bk = { v: x.kcal, k }; }
  const wks = {}, mos = {}; for (const k of keys) { const x = getDay(k); if (!x.has) continue; const w = dkey(startOfWeek(parseKey(k))); wks[w] = (wks[w] || 0) + x.steps; mos[k.slice(0, 7)] = (mos[k.slice(0, 7)] || 0) + x.steps; }
  const bw = Object.entries(wks).sort((a, b) => b[1] - a[1])[0], bm = Object.entries(mos).sort((a, b) => b[1] - a[1])[0];
  const lw = [...D.walks, ...(D.tl.walks || [])].sort((a, b) => b.distM - a.distM)[0];
  const rec = [
    ['👟', 'Nejvíc kroků za den', bs ? `${nf(bs.v)}` : '—', bs ? fmtShort(parseKey(bs.k)) : ''],
    ['📏', 'Nejdelší vzdálenost za den', bd ? `${km(bd.v)} km` : '—', bd ? fmtShort(parseKey(bd.k)) : ''],
    ['🔥', 'Nejvíc kalorií za den', bk ? `${nf(bk.v)} kcal` : '—', bk ? fmtShort(parseKey(bk.k)) : ''],
    ['🚶', 'Nejdelší procházka', lw ? `${km(lw.distM)} km` : '—', lw ? fmtShort(new Date(lw.start)) : ''],
    ['📆', 'Nejlepší týden', bw ? `${nf(bw[1])} kroků` : '—', bw ? 'od ' + fmtShort(parseKey(bw[0])) : ''],
    ['🗓️', 'Nejlepší měsíc', bm ? `${nf(bm[1])} kroků` : '—', bm ? `${MON[+bm[0].slice(5) - 1]} ${bm[0].slice(0, 4)}` : ''],
    ['⛓️', 'Nejdelší série kroužků', `${sc.best} dní`, '']
  ];
  $('#recordsCard').innerHTML = rec.map(r => `<div class="item"><div class="ic" style="background:#2c2c2e">${r[0]}</div><div class="main"><div class="ttl">${r[1]}</div><div class="meta">${r[3]}</div></div><div class="right">${r[2]}</div></div>`).join('');
  // odznaky
  $('#badgeGrid').innerHTML = badges(sc, ss).map(b => `<div><div class="medal ${b.n > 0 ? 'on' : 'off'}">${b.i}${b.n > 1 ? `<span class="cnt">${b.n}×</span>` : ''}</div><div class="bname">${b.t}</div><div class="bdesc">${b.d}</div></div>`).join('');
}
function badges(sc, ss) {
  const keys = allDayKeys(), days = keys.map(k => getDay(k)).filter(x => x.has);
  const cnt = f => days.filter(f).length;
  const tot = days.reduce((s, x) => s + x.steps, 0), totM = days.reduce((s, x) => s + x.distM, 0);
  const gw = D.walks, mos = {}; keys.forEach(k => { const x = getDay(k); if (x.has) mos[k.slice(0, 7)] = (mos[k.slice(0, 7)] || 0) + x.steps; });
  let perfectWeeks = 0; const wk = {}; keys.forEach(k => { const w = dkey(startOfWeek(parseKey(k))); (wk[w] ||= []).push(getDay(k).closed); }); for (const v of Object.values(wk)) if (v.length === 7 && v.every(Boolean)) perfectWeeks++;
  return [
    { i: '👣', t: 'První krůčky', d: 'První den s daty', n: days.length ? 1 : 0 },
    { i: '🔟', t: '10 000 kroků', d: 'Za jeden den', n: cnt(x => x.steps >= 10000) },
    { i: '🚀', t: '20 000 kroků', d: 'Za jeden den', n: cnt(x => x.steps >= 20000) },
    { i: '🏃', t: 'Půlmaraton', d: '21,1 km za den', n: cnt(x => x.distM >= 21100) },
    { i: '⭕', t: 'Kroužky', d: 'Všechny 3 uzavřené', n: cnt(x => x.closed) },
    { i: '💥', t: 'Dvojitý pohyb', d: '200 % cíle pohybu', n: cnt(x => x.pMove >= 2) },
    { i: '🔥', t: 'Týden v kuse', d: '7 dní série kroužků', n: sc.best >= 7 ? 1 : 0 },
    { i: '🌋', t: 'Měsíc v kuse', d: '30 dní série kroužků', n: sc.best >= 30 ? 1 : 0 },
    { i: '💯', t: 'Stovka', d: '100 dní série cíle kroků', n: ss.best >= 100 ? 1 : 0 },
    { i: '🏅', t: 'Perfektní týden', d: 'Po–Ne vše uzavřeno', n: perfectWeeks },
    { i: '📅', t: '300 000 / měsíc', d: 'Kroků za měsíc', n: Object.values(mos).filter(v => v >= 300000).length },
    { i: '🌍', t: 'Milionář', d: '1 000 000 kroků celkem', n: tot >= 1e6 ? Math.floor(tot / 1e6) : 0 },
    { i: '🛤️', t: '1 000 km', d: 'Celková vzdálenost', n: totM >= 1e6 ? 1 : 0 },
    { i: '🌅', t: 'Ranní ptáče', d: 'GPS procházka před 7:00', n: gw.filter(w => new Date(w.start).getHours() < 7).length },
    { i: '🌙', t: 'Noční chodec', d: 'GPS procházka po 21:00', n: gw.filter(w => new Date(w.start).getHours() >= 21).length },
    { i: '🧭', t: 'Průzkumník', d: '10 GPS procházek', n: gw.length >= 10 ? 1 : 0 },
    { i: '🥾', t: 'Výletník', d: 'Procházka 10+ km', n: [...gw, ...(D.tl.walks || [])].filter(w => w.distM >= 10000).length },
    { i: '🏔️', t: 'Horal', d: '50 pater za den', n: cnt(x => x.flights >= 50) }
  ];
}

/* ================= NASTAVENÍ ================= */
function renderSettings() {
  $('#ver').textContent = VERSION;
  $('#setGoals').innerHTML = `<h3>Cíle a osobní údaje</h3>
    <div class="grid2"><div class="field"><label>Pohyb (kcal)</label><input type="number" inputmode="numeric" id="gK" value="${S.goals.kcal}"></div>
    <div class="field"><label>Cvičení (min)</label><input type="number" inputmode="numeric" id="gE" value="${S.goals.exMin}"></div>
    <div class="field"><label>Kroky</label><input type="number" inputmode="numeric" id="gS" value="${S.goals.steps}"></div>
    <div class="field"><label>Délka kroku (m)</label><input type="number" inputmode="decimal" step="0.01" id="gL" value="${S.stride}"></div></div>
    <div class="small">Délka kroku slouží k odhadu kroků z GPS (≈ výška × 0,415). Při výšce 180 cm ≈ 0,75 m.</div>
    <button class="btn primary block" id="gSave" style="margin-top:10px">Uložit cíle</button>`;
  $('#gSave').onclick = () => { S.goals = { kcal: num($('#gK').value) || 300, exMin: num($('#gE').value) || 30, steps: num($('#gS').value) || 8000 }; S.stride = num($('#gL').value) || .75; saveS(); IDX.dayCache = {}; toast('Uloženo'); };

  const f = S.fb;
  $('#setFirebase').innerHTML = `<h3>Firebase (synchronizace)</h3>
    <div class="field"><label>Project ID</label><input id="fP" autocapitalize="off" autocorrect="off" value="${esc(f.projectId)}" placeholder="např. aktivita-kuba"></div>
    <div class="field"><label>Web API Key</label><input id="fK" autocapitalize="off" autocorrect="off" value="${esc(f.apiKey)}" placeholder="AIza…"></div>
    <div class="field"><label>Tajný klíč (část adresy dat)</label><div class="row"><input id="fS" autocapitalize="off" autocorrect="off" value="${esc(f.secret)}"><button class="btn sm" id="fGen">Nový</button></div></div>
    <div class="grid2"><button class="btn primary" id="fSave">Uložit</button><button class="btn" id="fTest">Otestovat</button></div>
    <div id="fRes"></div>
    <details style="margin-top:10px"><summary class="small">Pravidla zabezpečení Firestore (zkopíruj do Firebase)</summary><code id="rulesCode">${esc(rulesText())}</code><button class="btn sm" data-copy="rulesCode" style="margin-top:6px">Kopírovat</button></details>
    <div class="small" style="margin-top:8px">Poslední synchronizace: ${S.lastSync ? new Date(S.lastSync).toLocaleString('cs-CZ') : 'nikdy'}</div>`;
  $('#fGen').onclick = () => { $('#fS').value = randId(); };
  $('#fSave').onclick = () => { S.fb = { projectId: $('#fP').value.trim(), apiKey: $('#fK').value.trim(), secret: $('#fS').value.trim() }; saveS(); toast('Uloženo'); renderSettings(); };
  $('#fTest').onclick = async () => {
    S.fb = { projectId: $('#fP').value.trim(), apiKey: $('#fK').value.trim(), secret: $('#fS').value.trim() }; saveS();
    const r = $('#fRes'); if (!FB.ok()) { r.innerHTML = '<div class="warn">Vyplň všechna tři pole.</div>'; return; }
    r.innerHTML = '<div class="small">Testuji…</div>';
    try { await FB.put('meta', 'ping', { t: new Date().toISOString(), app: VERSION }); const d = await FB.list('days'); const ev = await FB.list('events'); r.innerHTML = `<div class="ok">✅ Spojení funguje. V databázi je ${d.length} dní a ${ev.length} odchodů/příchodů.</div>`; sync(true); }
    catch (e) { r.innerHTML = `<div class="warn">❌ ${esc(e.message)}<br>Zkontroluj Project ID, API klíč a jestli jsou v Firestore vložená pravidla se stejným tajným klíčem.</div>`; }
  };

  const base = FB.ok() ? FB.base() : 'https://firestore.googleapis.com/v1/projects/PROJECT_ID/databases/(default)/documents/u/TAJNY_KLIC';
  const key = FB.ok() ? S.fb.apiKey : 'API_KLIC';
  $('#setShortcut').innerHTML = `<h3>Zkratky – hodnoty ke zkopírování</h3>
    <div class="small">Podrobný postup je v PDF návodu. Sem se vrať pro přesné adresy.</div>
    <div class="field"><label>① Adresa pro denní data – začátek (za ní přijde proměnná Datum)</label><code id="c1">${esc(base)}/days/</code><button class="btn sm" data-copy="c1">Kopírovat</button></div>
    <div class="field"><label>② Konec adresy (za proměnnou Datum)</label><code id="c2">?key=${esc(key)}</code><button class="btn sm" data-copy="c2">Kopírovat</button></div>
    <div class="field"><label>③ JSON denních dat (metoda PATCH) – na místa v [ ] vlož proměnné</label><code id="c3">{"fields":{"steps":{"integerValue":"[Kroky]"},"distM":{"integerValue":"[Metry]"},"kcal":{"integerValue":"[Kcal]"},"exMin":{"integerValue":"[Cvičení]"},"flights":{"integerValue":"[Patra]"},"updatedAt":{"stringValue":"[Teď]"}}}</code><button class="btn sm" data-copy="c3">Kopírovat</button></div>
    <div class="field"><label>④ Adresa pro odchod/příchod (metoda POST)</label><code id="c4">${esc(base)}/events?key=${esc(key)}</code><button class="btn sm" data-copy="c4">Kopírovat</button></div>
    <div class="field"><label>⑤ JSON odchodu/příchodu</label><code id="c5">{"fields":{"type":{"stringValue":"[Vstup zkratky]"},"time":{"stringValue":"[Teď]"},"steps":{"integerValue":"[Kroky]"},"distM":{"integerValue":"[Metry]"}}}</code><button class="btn sm" data-copy="c5">Kopírovat</button></div>
    <div class="field"><label>⑥ Odkaz na spuštění GPS procházky</label><code id="c6">${esc(location.origin + location.pathname)}?start=walk</code><button class="btn sm" data-copy="c6">Kopírovat</button></div>
    ${FB.ok() ? '' : '<div class="warn">Nejdřív vyplň a ulož Firebase – pak tu budou tvoje skutečné adresy.</div>'}`;

  $('#setData').innerHTML = `<h3>Data</h3>
    <button class="btn block" id="dTl">🗺️ Importovat Časovou osu Google (Timeline.json)</button><input type="file" id="fileTl" accept=".json,application/json" hidden>
    <div class="small" style="margin:4px 0 10px">Mapy Google → profil → Vaše časová osa → ⋯ → Exportovat data časové osy. Zpracuje se jen v telefonu. Teď: ${D.tl.walks?.length || 0} procházek.</div>
    <button class="btn block" id="dMan">✍️ Zadat den ručně</button><div style="height:8px"></div>
    <div class="grid2"><button class="btn" id="dExp">⬇︎ Záloha</button><button class="btn" id="dImp">⬆︎ Obnovit</button></div><input type="file" id="fileBk" accept=".json,application/json" hidden>
    <div style="height:8px"></div>
    <button class="btn block" id="dDemo">${Object.keys(D.demo).length ? '🧹 Smazat ukázková data' : '🧪 Načíst ukázková data'}</button>
    <div style="height:8px"></div><button class="btn danger block" id="dClr">Smazat data v tomto zařízení</button>
    <div class="small" style="margin-top:6px">Mazání nesmaže data ve Firebase – po synchronizaci se vrátí.</div>`;
  $('#dTl').onclick = () => $('#fileTl').click();
  $('#fileTl').onchange = e => importTimeline(e.target.files[0]);
  $('#dMan').onclick = manualDay;
  $('#dExp').onclick = () => downloadFile(`aktivita-zaloha-${dkey(new Date())}.json`, JSON.stringify({ app: 'aktivita', v: VERSION, settings: { ...S, fb: { ...S.fb, apiKey: '' } }, days: D.days, events: D.events, walks: D.walks, tl: D.tl }), 'application/json');
  $('#dImp').onclick = () => $('#fileBk').click();
  $('#fileBk').onchange = async e => { try { const j = JSON.parse(await e.target.files[0].text()); if (j.app !== 'aktivita') throw new Error('Není to záloha Aktivity'); Object.assign(D.days, j.days || {}); D.events = j.events || D.events; for (const w of (j.walks || [])) if (!D.walks.find(x => x.id === w.id)) D.walks.push(w); if (j.tl?.walks) D.tl = j.tl; await saveData(); toast('Záloha obnovena'); renderSettings(); } catch (err) { toast('Chyba: ' + err.message); } };
  $('#dDemo').onclick = async () => { if (Object.keys(D.demo).length) D.demo = {}; else D.demo = makeDemo(); await saveData('demo'); toast(Object.keys(D.demo).length ? 'Ukázková data načtena' : 'Ukázková data smazána'); renderSettings(); };
  $('#dClr').onclick = () => { openSheet(`<h3>Opravdu smazat?</h3><p class="sub">Smaže dny, procházky a importovanou Časovou osu v tomto zařízení.</p><button class="btn danger block" id="cY">Smazat</button><div style="height:8px"></div><button class="btn block" id="cN">Zrušit</button>`); $('#cN').onclick = closeSheet; $('#cY').onclick = async () => { D = { days: {}, demo: {}, events: [], walks: [], tl: { walks: [] } }; await saveData(); closeSheet(); toast('Smazáno'); renderSettings(); }; };
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); toast('Zkopírováno'); } catch (e) { toast('Kopírování selhalo – podrž text a zkopíruj ručně'); } });
}
function rulesText() {
  const s = S.fb.secret || 'SEM_VLOZ_TAJNY_KLIC';
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /u/{key}/{document=**} {
      allow read, write: if key == '${s}';
    }
  }
}`;
}
function manualDay() {
  const k = dkey(selDate), d = D.days[k] || {};
  openSheet(`<div class="grab"></div><h3>Zadat den ručně</h3><div class="small">Hodí se pro doplnění starších dnů z aplikace Zdraví.</div>
    <div class="field"><label>Datum</label><input type="date" id="mD" value="${k}" max="${dkey(new Date())}"></div>
    <div class="grid2"><div class="field"><label>Kroky</label><input type="number" id="mS" value="${d.steps ?? ''}"></div><div class="field"><label>Vzdálenost (km)</label><input type="number" step="0.01" id="mK" value="${d.distM != null ? d.distM / 1000 : ''}"></div>
    <div class="field"><label>Pohyb (kcal)</label><input type="number" id="mC" value="${d.kcal ?? ''}"></div><div class="field"><label>Cvičení (min)</label><input type="number" id="mE" value="${d.exMin ?? ''}"></div>
    <div class="field"><label>Patra</label><input type="number" id="mF" value="${d.flights ?? ''}"></div></div>
    <button class="btn primary block" id="mSave">Uložit</button><div style="height:8px"></div><button class="btn block" id="mCancel">Zrušit</button>`);
  $('#mD').onchange = () => { const x = D.days[$('#mD').value] || {}; $('#mS').value = x.steps ?? ''; $('#mK').value = x.distM != null ? x.distM / 1000 : ''; $('#mC').value = x.kcal ?? ''; $('#mE').value = x.exMin ?? ''; $('#mF').value = x.flights ?? ''; };
  $('#mCancel').onclick = closeSheet;
  $('#mSave').onclick = async () => {
    const key = $('#mD').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return toast('Neplatné datum');
    const o = { steps: Math.round(num($('#mS').value)), distM: Math.round(num($('#mK').value) * 1000), kcal: Math.round(num($('#mC').value)), exMin: Math.round(num($('#mE').value)), flights: Math.round(num($('#mF').value)), updatedAt: new Date().toISOString() };
    D.days[key] = o; await saveData('days'); closeSheet(); toast('Den uložen');
    if (FB.ok()) FB.put('days', key, o).catch(e => toast('Firebase: ' + e.message));
    renderAll();
  };
}
function makeDemo() {
  const o = {}, t = midnight(new Date());
  for (let i = 0; i < 430; i++) {
    const d = addDays(t, -i), w = wd(d), base = [7200, 9800, 8600, 11000, 6500, 5200, 8800][w], season = 1 + .15 * Math.sin((d.getMonth() - 3) / 12 * 2 * Math.PI);
    const steps = Math.max(800, Math.round(base * season * (.55 + Math.random() * .9)));
    o[dkey(d)] = { steps, distM: Math.round(steps * .74), kcal: Math.round(steps * .038 + 60 + Math.random() * 80), exMin: Math.round(steps / 260 + Math.random() * 12), flights: Math.round(Math.random() * 14) };
  }
  return o;
}

/* Import Časové osy Google (formát Android, iOS i starší Takeout) */
function parseLL(s) {
  if (!s) return null;
  if (typeof s === 'object') { if (s.latLng) return parseLL(s.latLng); if ('latitudeE7' in s) return [s.latitudeE7 / 1e7, s.longitudeE7 / 1e7]; if ('latE7' in s) return [s.latE7 / 1e7, s.lngE7 / 1e7]; return null; }
  const m = String(s).match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? [+m[1], +m[2]] : null;
}
const WALKT = /walk|on_foot|foot|hiking|running|chůze/i;
async function importTimeline(file) {
  if (!file) return;
  toast('Načítám Časovou osu…', 10000);
  try {
    const j = JSON.parse(await file.text());
    const segs = Array.isArray(j) ? j : (j.semanticSegments || []);
    const path = [], acts = [];
    for (const s of segs) {
      if (s.timelinePath) { const st = new Date(s.startTime).getTime(); for (const p of s.timelinePath) { const ll = parseLL(p.point); if (!ll) continue; const t = p.time ? new Date(p.time).getTime() : st + num(p.durationMinutesOffsetFromStartTime) * 60000; if (!isNaN(t)) path.push([t, ll[0], ll[1]]); } }
      if (s.activity) { const a = s.activity, type = a.topCandidate?.type || ''; if (WALKT.test(type)) acts.push({ start: new Date(s.startTime), end: new Date(s.endTime), distM: num(a.distanceMeters), type: /run/i.test(type) ? 'running' : 'walking', a: parseLL(a.start), b: parseLL(a.end) }); }
    }
    for (const o of (j.timelineObjects || [])) {
      const a = o.activitySegment; if (!a || !WALKT.test(a.activityType || '')) continue;
      const pts = (a.simplifiedRawPath?.points || a.waypointPath?.waypoints || []).map(parseLL).filter(Boolean);
      acts.push({ start: new Date(a.duration?.startTimestamp), end: new Date(a.duration?.endTimestamp), distM: num(a.distance), type: /RUN/.test(a.activityType) ? 'running' : 'walking', a: parseLL(a.startLocation), b: parseLL(a.endLocation), pts });
    }
    path.sort((x, y) => x[0] - y[0]);
    const lb = t => { let lo = 0, hi = path.length; while (lo < hi) { const m = (lo + hi) >> 1; path[m][0] < t ? lo = m + 1 : hi = m; } return lo; };
    const walks = [];
    for (const a of acts) {
      if (isNaN(a.start) || isNaN(a.end)) continue;
      let pts = a.pts && a.pts.length ? a.pts : [];
      if (!pts.length) { for (let i = lb(a.start.getTime()); i < path.length && path[i][0] <= a.end.getTime(); i++) pts.push([path[i][1], path[i][2]]); }
      if (a.a) pts.unshift(a.a); if (a.b) pts.push(a.b);
      if (pts.length > 300) { const st = pts.length / 300; pts = Array.from({ length: 300 }, (_, i) => pts[Math.floor(i * st)]); }
      let dm = a.distM; if (!dm && pts.length > 1) for (let i = 1; i < pts.length; i++) dm += hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      walks.push({ id: 'tl' + a.start.getTime(), start: a.start.toISOString(), end: a.end.toISOString(), distM: Math.round(dm), type: a.type, pts: pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]) });
    }
    const map = new Map((D.tl.walks || []).map(w => [w.id, w])); walks.forEach(w => map.set(w.id, w));
    D.tl = { walks: [...map.values()], importedAt: new Date().toISOString() };
    await saveData('tl');
    toast(`Načteno: ${walks.length} ${plural(walks.length, 'procházka', 'procházky', 'procházek')} (${km(walks.reduce((s, w) => s + w.distM, 0))} km)`, 4000);
    renderAll();
  } catch (e) { toast('Import selhal: ' + e.message, 5000); console.error(e); }
}

/* ================= Spodní list (sheet) ================= */
function openSheet(html) { $('#sheet').innerHTML = html; $('#sheetBg').classList.add('show'); }
function closeSheet() { $('#sheetBg').classList.remove('show'); $('#sheet').innerHTML = ''; }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

/* ================= Start aplikace ================= */
async function init() {
  await DB.open(); await loadData();
  document.querySelectorAll('#tabbar button').forEach(b => b.onclick = () => show(b.dataset.v));
  $('#wkPrev').onclick = () => { selDate = addDays(selDate, -7); renderToday(); };
  $('#wkNext').onclick = () => { const n = addDays(selDate, 7), t = midnight(new Date()); selDate = n > t ? t : n; renderToday(); };
  $('#btnPickDate').onclick = () => { const p = $('#datePicker'); p.max = dkey(new Date()); p.value = dkey(selDate); p.showPicker ? p.showPicker() : p.click(); };
  $('#datePicker').onchange = e => { if (e.target.value) { selDate = parseKey(e.target.value); renderToday(); } };
  $('#btnSync').onclick = () => sync(false);
  $('#periodSeg').querySelectorAll('button').forEach(b => b.onclick = () => { per = b.dataset.p; $('#periodSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderStats(); });
  $('#metricChips').querySelectorAll('button').forEach(b => b.onclick = () => { perMetric = b.dataset.m; $('#metricChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderStats(); });
  $('#perPrev').onclick = () => { perAnchor = shiftAnchor(per, perAnchor, -1); renderStats(); };
  $('#perNext').onclick = () => { const n = shiftAnchor(per, perAnchor, 1); perAnchor = n > midnight(new Date()) ? midnight(new Date()) : n; renderStats(); };
  $('#walkFilter').querySelectorAll('button').forEach(b => b.onclick = () => { walkFilter = b.dataset.f; walkLimit = 40; $('#walkFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderWalkList(); });
  // nedokončená procházka po pádu/zavření aplikace
  try { const live = JSON.parse(localStorage.getItem('aktivita_live') || 'null'); if (live?.active) { T = { ...live, gap: true }; beginWatch(); } } catch (e) { }
  const q = new URLSearchParams(location.search);
  if (q.get('start') === 'walk') { show('walk'); if (!T) toast('Klepni na Start pro záznam procházky'); }
  else show(q.get('view') || 'today');
  if (FB.ok()) { setDot('on'); sync(true); }
  // aktualizace při návratu do aplikace (např. po Zkratce)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && FB.ok() && Date.now() - S.lastSync > 60000) sync(true); });
  // půlnoc / obnova dne
  setInterval(() => { if (curView === 'today' && !T) { const t = midnight(new Date()); if (+selDate > +t) selDate = t; } }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}
init();
