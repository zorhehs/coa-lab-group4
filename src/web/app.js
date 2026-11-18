/* ==================================================================
   CACHE-SIM front end.  Talks to the Python simulator over /api/*.
   The server runs the whole trace once and returns one event per
   access (with the touched set before/after); stepping, playback and
   the cache-array animation are then done entirely in the browser.
   ================================================================== */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (n, w) => '0x' + n.toString(16).toUpperCase().padStart(w || 0, '0');
const fmtBytes = (b) => (b >= 1024 && b % 1024 === 0) ? (b / 1024) + ' KiB' : b + ' B';

const state = {
  meta: null,
  config: {},
  traceText: '',
  traceName: '',
  traceCount: 0,
  sim: null,            // last /api/simulate response
  step: 0,              // 0 .. maxStep
  playing: false,
  timer: null,
  grid: [],             // [set][way] -> {valid, tag, dirty, age}
  heat: [],             // last outcome per set ('h' | 'm' | 'v')
  probe: null,          // /api/decode result for the probe input
  sweep: null,          // last sweep rows
  sweepParam: 'associativity',
  sweepSeries: '',
  sweepMetric: 'hit_ratio',
  sweepView: null,       // what the chart currently shows (for the hover tooltip)
  hiddenSeries: new Set(), // chart series switched off via the legend
  arrayFocus: null,        // set index the detail window is centred on (large caches), null = follow the access
  sweepSort: null,         // {col, dir} for the results table
  presetCache: {},
};

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */
async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { throw new Error('bad response from server'); }
  if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 4200 : 2200);
}

// palette for the canvases and the sweep chart, read once from the stylesheet tokens
let themeCache = null;
function theme() {
  if (!themeCache) {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    themeCache = { accent: v('--accent'), teal: v('--teal'), green: v('--green'), red: v('--red'), blue: v('--blue'), violet: v('--violet'),
      accentRgb: v('--accent-rgb'), greenRgb: v('--green-rgb'), tintRgb: v('--tint-rgb'), veil: v('--veil'), lcd: v('--lcd'), text: v('--text'), muted: v('--muted'), dim: v('--dim'), hair: v('--hair-2') };
  }
  return themeCache;
}

function setStatus(txt, led) {
  $('#statusTxt').textContent = txt;
  const el = $('#statusLed');
  el.className = 'led' + (led ? ' on-' + led : '') + (txt === 'RUN' ? ' blink' : '');
  $('#busyBar').hidden = !(txt === 'BUSY' || txt === 'SWEEP');
}

/* ------------------------------------------------------------------ */
/*  Configuration controls                                             */
/* ------------------------------------------------------------------ */
const SIZE_OPTS = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].map((v) => [v, v >= 1024 ? (v / 1024) + 'K' : String(v)]);
const fmtSize = (v) => (v >= 1024 ? (v / 1024) + ' KiB' : v + ' B');
const CONTROLS = [
  { section: 'GEOMETRY', sub: 'size · line · placement' },
  { key: 'cache_size', label: 'CACHE SIZE', kind: 'detent', opts: SIZE_OPTS, readout: fmtSize },
  { key: 'block_size', label: 'BLOCK SIZE', kind: 'detent', opts: [4, 8, 16, 32, 64, 128].map((v) => [v, String(v)]), readout: (v) => v + ' B' },
  { key: 'associativity', label: 'MAPPING', kind: 'detent', opts: [[1, 'DM'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [0, 'FA']],
    readout: (v) => (v === 0 ? 'FULL' : (v === 1 ? 'DIRECT' : v + '-WAY')) },
  { section: 'POLICIES', sub: 'replacement · write' },
  { key: 'replacement', label: 'REPLACE', kind: 'seg', opts: [['LRU', 'LRU'], ['FIFO', 'FIFO'], ['RANDOM', 'RANDOM']] },
  { key: 'write_policy', label: 'WRITE', kind: 'seg', opts: [['WB', 'WRITE-BACK'], ['WT', 'WRITE-THRU']] },
  { key: 'write_allocate', label: 'ON W-MISS', kind: 'seg', opts: [[true, 'ALLOCATE'], [false, 'NO-ALLOC']] },
  { section: 'ADDRESS · EXTENSIONS', sub: '' },
  { key: 'address_bits', label: 'ADDR BITS', kind: 'seg', opts: [[16, '16'], [24, '24'], [32, '32']] },
  { key: 'victim_entries', label: 'VICTIM $', kind: 'seg', opts: [[0, 'OFF'], [2, '2'], [4, '4'], [8, '8']], green: true },
];
const QUICK_SETS = [
  ['TEXTBOOK', { cache_size: 32, block_size: 4, associativity: 1, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }, 'Hennessy & Patterson: 8 one-word blocks, direct mapped'],
  ['REFERENCE', { cache_size: 1024, block_size: 16, associativity: 4, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }, '1 KiB · 16 B · 4-way LRU · write-back / write-allocate'],
  ['L1-LIKE', { cache_size: 32768, block_size: 64, associativity: 8, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }, '32 KiB · 64 B · 8-way, like a real L1 data cache'],
  ['THRASH', { cache_size: 1024, block_size: 16, associativity: 1, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }, '1 KiB direct mapped: load conflict.trace, then try VICTIM $ = 2'],
];

function positionIndicator(seg) {
  const ind = seg.querySelector('.ind');
  if (!ind) return;
  const a = seg.querySelector('button.active');
  if (!a) { ind.style.opacity = 0; return; }
  ind.style.opacity = 1;
  ind.style.left = a.offsetLeft + 'px'; ind.style.top = a.offsetTop + 'px';
  ind.style.width = a.offsetWidth + 'px'; ind.style.height = a.offsetHeight + 'px';
}

function buildConfigControls() {
  const body = $('#configBody');
  body.innerHTML = '';
  // quick-set: whole configurations in one click
  const qs = document.createElement('div');
  qs.className = 'quick-set';
  qs.innerHTML = `<span class="lbl">QUICK SET</span><div class="seg seg-ind" id="quickSeg">${QUICK_SETS.map(([n, , d], i) => `<button data-i="${i}" title="${esc(d)}">${n}</button>`).join('')}<i class="ind"></i></div>`;
  body.appendChild(qs);
  qs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const [name, cfg, desc] = QUICK_SETS[Number(b.dataset.i)];
    Object.assign(state.config, cfg); syncConfigUI(); scheduleSimulate(); toast(`${name} · ${desc}`);
  }));
  for (const c of CONTROLS) {
    if (c.section) {
      const h = document.createElement('div');
      h.className = 'cfg-section';
      h.innerHTML = `<span>${c.section}</span>${c.sub ? `<em>${c.sub}</em>` : ''}`;
      body.appendChild(h);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'cfg-row' + (c.kind === 'detent' ? ' detent-row' : '');
    row.innerHTML = `<span class="lbl">${c.label}</span>`;
    if (c.kind === 'detent') {
      const n = c.opts.length;
      const d = document.createElement('div');
      d.className = 'detent'; d.dataset.key = c.key; d.tabIndex = 0;
      d.setAttribute('role', 'slider'); d.setAttribute('aria-label', c.label);
      d.innerHTML = `<div class="track">${c.opts.map((_, i) => `<i class="tick" style="left:${100 * i / (n - 1)}%"></i>`).join('')}<div class="fill"></div><div class="knob"></div></div>` +
        `<div class="scale">${c.opts.map(([, l], i) => `<span style="left:${100 * i / (n - 1)}%" class="${n > 7 && i % 2 === 1 && i !== n - 1 ? 'minor' : ''}">${l}</span>`).join('')}</div>`;
      const pick = (i) => {
        i = Math.max(0, Math.min(n - 1, i));
        const v = c.opts[i][0];
        if (state.config[c.key] !== v) { state.config[c.key] = v; syncConfigUI(); scheduleSimulate(); }
      };
      const fromEvent = (ev) => { const r = d.querySelector('.track').getBoundingClientRect(); return Math.round((ev.clientX - r.left) / r.width * (n - 1)); };
      let drag = false;
      // while the pointer is down the knob follows it directly (no easing); the easing is for keyboard / preset changes
      d.addEventListener('pointerdown', (ev) => { drag = true; d.setPointerCapture(ev.pointerId); pick(fromEvent(ev)); d.classList.add('dragging'); d.focus(); });
      d.addEventListener('pointermove', (ev) => { if (drag) pick(fromEvent(ev)); });
      d.addEventListener('pointerup', () => { drag = false; d.classList.remove('dragging'); });
      d.addEventListener('pointercancel', () => { drag = false; d.classList.remove('dragging'); });
      d.addEventListener('keydown', (ev) => {
        const i = c.opts.findIndex(([v]) => v === state.config[c.key]);
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') pick(i + 1);
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') pick(i - 1);
        else if (ev.key === 'Home') pick(0);
        else if (ev.key === 'End') pick(n - 1);
        else return;
        ev.preventDefault(); ev.stopPropagation();
      });
      row.appendChild(d);
      const ro = document.createElement('span');
      ro.className = 'lcd lcd-sm readout'; ro.dataset.key = c.key;
      row.appendChild(ro);
    } else {
      const seg = document.createElement('div');
      seg.className = 'seg seg-ind' + (c.green ? ' green' : '');
      seg.dataset.key = c.key;
      for (const [v, lbl] of c.opts) {
        const b = document.createElement('button');
        b.textContent = lbl;
        b.dataset.value = JSON.stringify(v);
        b.addEventListener('click', () => { state.config[c.key] = v; syncConfigUI(); scheduleSimulate(); });
        seg.appendChild(b);
      }
      const ind = document.createElement('i'); ind.className = 'ind'; seg.appendChild(ind);
      row.appendChild(seg);
    }
    body.appendChild(row);
  }
  const th = document.createElement('div');
  th.className = 'cfg-section';
  th.innerHTML = '<span>TIMING</span><em>cycles, for AMAT · seed for RANDOM</em>';
  body.appendChild(th);
  const timing = document.createElement('div');
  timing.className = 'timing-grid';
  timing.innerHTML = `
      <label><span class="lbl">HIT TIME</span><span class="num-wrap has-unit"><input class="num-in" id="hitTime" type="number" step="0.5" min="0"><i class="unit">cyc</i></span></label>
      <label><span class="lbl">MISS PENALTY</span><span class="num-wrap has-unit"><input class="num-in" id="missPenalty" type="number" step="1" min="0"><i class="unit">cyc</i></span></label>
      <label><span class="lbl">RNG SEED</span><span class="num-wrap"><input class="num-in" id="seed" type="number" step="1" min="0"></span></label>`;
  body.appendChild(timing);
  for (const [id, key] of [['#hitTime', 'hit_time'], ['#missPenalty', 'miss_penalty'], ['#seed', 'seed']]) {
    $(id).addEventListener('change', (e) => { state.config[key] = Number(e.target.value); scheduleSimulate(); });
  }
  new ResizeObserver(() => syncConfigUI()).observe(body);
}

function syncConfigUI() {
  for (const c of CONTROLS) {
    if (c.section) continue;
    const cur = state.config[c.key];
    if (c.kind === 'detent') {
      const d = document.querySelector(`.detent[data-key="${c.key}"]`);
      if (!d) continue;
      let i = c.opts.findIndex(([v]) => v === cur);
      if (i < 0) i = 0;
      const pct = 100 * i / (c.opts.length - 1);
      d.querySelector('.knob').style.left = pct + '%';
      d.querySelector('.fill').style.width = pct + '%';
      d.querySelectorAll('.tick').forEach((t, k) => t.classList.toggle('on', k <= i));
      d.querySelectorAll('.scale span').forEach((s, k) => s.classList.toggle('active', k === i));
      d.setAttribute('aria-valuetext', c.readout(cur));
      const ro = document.querySelector(`.readout[data-key="${c.key}"]`);
      if (ro && ro.textContent !== c.readout(cur)) { ro.textContent = c.readout(cur); restartAnimation(ro, 'tick', ['tick']); }
    } else {
      const seg = document.querySelector(`.seg[data-key="${c.key}"]`);
      if (!seg) continue;
      const s = JSON.stringify(cur);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === s));
      positionIndicator(seg);
    }
  }
  const qseg = $('#quickSeg');
  if (qseg) {
    qseg.querySelectorAll('button').forEach((b) => {
      const p = QUICK_SETS[Number(b.dataset.i)][1];
      b.classList.toggle('active', Object.keys(p).every((k) => state.config[k] === p[k]));
    });
    positionIndicator(qseg);
  }
  $('#hitTime').value = state.config.hit_time;
  $('#missPenalty').value = state.config.miss_penalty;
  $('#seed').value = state.config.seed;
}

function cliEquivalent() {
  const c = state.config;
  const parts = ['python -m cachesim run', '--trace data/' + (state.traceName || 'trace.trace'),
    '--size ' + c.cache_size, '--block ' + c.block_size, '--assoc ' + c.associativity,
    '--repl ' + c.replacement, '--write ' + c.write_policy];
  if (!c.write_allocate) parts.push('--no-allocate');
  if (c.address_bits !== 32) parts.push('--addr-bits ' + c.address_bits);
  if (c.victim_entries) parts.push('--victim ' + c.victim_entries);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/*  Simulation                                                         */
/* ------------------------------------------------------------------ */
let simTimer = null;
function scheduleSimulate() {
  clearTimeout(simTimer);
  simTimer = setTimeout(simulate, 120);
}

let simSeq = 0;                                   // a response older than the latest request is dropped
// returns true (applied), 'stale' (superseded by a newer request), 'trace' (bad trace) or false (bad config)
async function simulate(opts) {
  opts = opts || {};
  if (!state.traceText.trim()) { renderGeometryOnly(); return false; }
  stopPlayback();
  setStatus('BUSY', 'accent');
  const seq = ++simSeq;
  try {
    const res = await api('/api/simulate', { config: state.config, trace: state.traceText, event_limit: state.meta.event_limit });
    if (seq !== simSeq) return 'stale';
    if (!res.total_accesses) throw new Error('trace: no accesses in the trace');
    state.sim = res;
    state.traceCount = res.total_accesses;
    $('#configError').hidden = true;
    const max = maxStep();
    if (opts.goto === 'end') state.step = max;
    else if (opts.goto === 'start') state.step = 0;
    else state.step = Math.min(state.step, max);
    rebuildGrid();
    renderAll();
    setStatus(state.step >= max && max > 0 ? 'END' : 'IDLE', state.step >= max && max > 0 ? 'accent' : null);
    return true;
  } catch (e) {
    if (seq !== simSeq) return 'stale';
    if (/^trace:/i.test(e.message)) {
      toast(e.message, true);                   // a bad trace line: the caller keeps the previous trace
      setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'accent' : null);
      return 'trace';
    } else {
      $('#configError').textContent = e.message;
      $('#configError').hidden = false;
      setStatus('ERROR', 'red');
      renderGeometryOnly();
    }
    return false;
  }
}

function maxStep() {
  if (!state.sim) return 0;
  return state.sim.events.length + (state.sim.truncated ? 1 : 0);
}
function atEnd() { return state.sim && state.step >= maxStep() && maxStep() > 0; }
function isEndSummary() { return state.sim && state.sim.truncated && state.step === maxStep(); }
function currentEvent() {
  if (!state.sim || state.step === 0) return null;
  if (isEndSummary()) return state.sim.last_event;   // final access of a long trace
  return state.sim.events[state.step - 1];
}
function currentStats() {
  if (!state.sim) return null;
  if (isEndSummary()) return state.sim.stats;
  if (state.step === 0) return null;
  return state.sim.events[state.step - 1].stats_after;
}

function emptyGrid(cfg) {
  const g = [];
  for (let s = 0; s < cfg.num_sets; s++) {
    const row = [];
    for (let w = 0; w < cfg.ways; w++) row.push({ valid: false, tag: null, dirty: false, age: null });
    g.push(row);
  }
  return g;
}

function rebuildGrid() {
  const cfg = state.sim.config;
  if (isEndSummary()) {
    state.grid = state.sim.final_state;
    state.heat = new Array(cfg.num_sets).fill('f');
    for (let s = 0; s < cfg.num_sets; s++) if (!state.grid[s].some((w) => w.valid)) state.heat[s] = '';
    return;
  }
  state.grid = emptyGrid(cfg);
  state.heat = new Array(cfg.num_sets).fill('');
  const evs = state.sim.events;
  for (let i = 0; i < state.step; i++) {
    const e = evs[i];
    state.grid[e.set_index] = e.set_after;
    state.heat[e.set_index] = e.result === 'HIT' ? 'h' : (e.result === 'VICTIM' ? 'v' : 'm');
  }
}

function setStep(n, fromPlay) {
  if (!state.sim) return;
  state.arrayFocus = null;
  const max = maxStep();
  n = Math.max(0, Math.min(max, n));
  if (n === state.step && !fromPlay) return;
  state.step = n;
  rebuildGrid();
  renderAll();
  if (!state.playing) setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'accent' : null);
}

/* ---- playback ---- */
const RATES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];        // accesses per second, one slider stop each
function stepsPerSecond() { return RATES[Number($('#speed').value)] || 1; }
function rateLabel(r) { return r >= 1 ? `${r} / s` : `1 / ${Math.round(1 / r)} s`; }
function setRate(r) {
  let best = 0;
  RATES.forEach((v, i) => { if (Math.abs(v - r) < Math.abs(RATES[best] - r)) best = i; });
  $('#speed').value = best;
  $('#speed').dispatchEvent(new Event('input'));
}
function startPlayback() {
  if (!state.sim || atEnd()) return;
  state.playing = true;
  applyAnimSpeed();
  $('#btnPlay').classList.add('playing');
  setStatus('RUN', 'green');
  let due = performance.now();
  const tick = () => {
    if (!state.playing) return;
    setStep(state.step + 1, true);
    if (atEnd()) { stopPlayback(); setStatus('END', 'accent'); return; }
    due += 1000 / stepsPerSecond();
    const now = performance.now();
    if (due < now - 250) due = now;             // fell far behind (hidden tab): resume at the rate, no burst
    state.timer = setTimeout(tick, Math.max(0, due - now));
  };
  tick();
}
function stopPlayback() {
  state.playing = false;
  clearTimeout(state.timer);
  applyAnimSpeed();
  $('#btnPlay').classList.remove('playing');
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                          */
/* ------------------------------------------------------------------ */
function renderAll() {
  renderReadoutStrip();
  renderGeometry();
  renderDecode();
  renderArray();
  renderCounters();
  renderLog();
  renderTraceStrip();
  $('#stepOut').textContent = state.sim ? `${state.step} / ${maxStep()}` : '0 / 0';
}

function renderGeometryOnly() {
  renderReadoutStrip();
  renderGeometry();
}

function geometry() {
  // derived geometry, from the last successful simulation or computed locally
  if (state.sim && JSON.stringify(cfgSubset(state.sim.config)) === JSON.stringify(cfgSubset(state.config))) return state.sim.config;
  const c = state.config;
  const num_blocks = c.cache_size / c.block_size;
  const pow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  const invalid = !pow2(c.cache_size) || !pow2(c.block_size) || num_blocks < 1 || c.associativity > num_blocks ||
    (c.associativity > 1 && num_blocks % c.associativity !== 0);
  if (invalid) return Object.assign({}, c, { invalid: true, num_blocks: NaN, ways: NaN, num_sets: NaN, offset_bits: NaN, index_bits: NaN, tag_bits: NaN });
  const fa = c.associativity === 0 || c.associativity === num_blocks;
  const ways = fa ? num_blocks : c.associativity;
  const num_sets = Math.max(1, num_blocks / ways);
  const log2 = (n) => Math.round(Math.log2(n));
  const offset_bits = log2(c.block_size), index_bits = log2(num_sets);
  return Object.assign({}, c, {
    num_blocks, ways, num_sets, offset_bits, index_bits, tag_bits: c.address_bits - index_bits - offset_bits,
    is_fully_associative: fa,
    mapping_name: fa ? 'Fully associative' : (ways === 1 ? 'Direct mapped' : ways + '-way set associative'),
    write_name: (c.write_policy === 'WB' ? 'Write-back' : 'Write-through') + (c.write_allocate ? ' / write-allocate' : ' / no-write-allocate'),
  });
}
function cfgSubset(c) {
  return ['cache_size', 'block_size', 'associativity', 'replacement', 'write_policy', 'write_allocate', 'address_bits', 'victim_entries'].map((k) => c[k]);
}

function renderReadoutStrip() {
  const g = geometry();
  const map = g.is_fully_associative ? 'FULL' : (g.ways === 1 ? 'DM' : g.ways + '-WAY');
  const parts = [map, fmtBytes(g.cache_size), g.block_size + ' B', g.num_sets + '×' + g.ways, g.replacement, g.write_policy + (g.write_allocate ? '/WA' : '/NWA')];
  if (g.victim_entries) parts.push('VC ' + g.victim_entries);
  $('#brandCfg').textContent = g.invalid ? 'invalid configuration' : parts.join(' · ');
  const chips = [];
  if (state.traceName) {
    chips.push(['TRACE', state.traceName], ['ACCESSES', String(state.traceCount || 0)]);
    if (state.sim && state.sim.masked_addresses) chips.push(['MASKED', `${state.sim.masked_addresses} addr > ${g.address_bits} b`]);
  } else chips.push(['TRACE', 'none loaded']);
  $('#readoutStrip').innerHTML = chips.map(([k, v]) => `<span class="chip"><b>${k}</b>${esc(v)}</span>`).join('');
}

function renderGeometry() {
  const g = geometry();
  if (g.invalid) {                                   // the server's message is under CONFIGURATION; show dashes, not fractions
    $('#geoGrid').innerHTML = ['SETS', 'WAYS', 'LINES', 'TAG BITS', 'INDEX BITS', 'OFFSET BITS'].map((k) => `<div class="geo"><span class="lbl">${k}</span><span class="lcd dimmed">—</span></div>`).join('');
    $('#geoSchematic').innerHTML = '<div class="schem-caption">invalid geometry — see the message under CONFIGURATION</div>';
    $('#bitRuler').innerHTML = ''; $('#bitScale').innerHTML = '';
    $('#cliEquiv').textContent = cliEquivalent();
    return;
  }
  const items = [
    ['SETS', g.num_sets], ['WAYS', g.ways], ['LINES', g.num_blocks],
    ['TAG BITS', g.tag_bits], ['INDEX BITS', g.index_bits], ['OFFSET BITS', g.offset_bits],
  ];
  $('#geoGrid').innerHTML = items.map(([k, v]) => `<div class="geo"><span class="lbl">${k}</span><span class="lcd">${v}</span></div>`).join('');
  // schematic: one square per line (clipped to 8 × 8), the real shape of the array
  const R = Math.min(g.num_sets, 8), C = Math.min(g.ways, 8);
  const moreR = g.num_sets > 8, moreC = g.ways > 8;
  let cells = '';
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) cells += '<i></i>';
    if (moreC) cells += '<i class="more">…</i>';
  }
  if (moreR) { for (let c = 0; c < C + (moreC ? 1 : 0); c++) cells += '<i class="more">⋮</i>'; }
  const tagStoreBits = g.num_blocks * (g.tag_bits + 1 + (g.write_policy === 'WB' ? 1 : 0));
  const overhead = 100 * tagStoreBits / (g.cache_size * 8);
  const tagStore = tagStoreBits / 8;
  $('#geoSchematic').innerHTML =
    `<div class="schem-grid" style="grid-template-columns: repeat(${C + (moreC ? 1 : 0)}, 11px)">${cells}</div>` +
    `<div class="schem-caption"><b>${g.num_sets}</b> sets × <b>${g.ways}</b> way${g.ways > 1 ? 's' : ''}<br>` +
    `each line <b>${g.block_size} B</b> = ${g.block_size / g.word_size} words<br>` +
    `tag store <b>${tagStore >= 1024 ? (tagStore / 1024).toFixed(2) + ' KiB' : Math.round(tagStore) + ' B'}</b> · ${overhead.toFixed(1)} % overhead</div>`;
  const total = g.address_bits;
  const pct = (b) => (100 * b / total).toFixed(2) + '%';
  $('#bitRuler').innerHTML =
    `<span class="tag" style="width:${pct(g.tag_bits)}">TAG ${g.tag_bits}</span>` +
    (g.index_bits ? `<span class="idx" style="width:${pct(g.index_bits)}">IDX ${g.index_bits}</span>` : '') +
    `<span class="off" style="width:${pct(g.offset_bits)}">OFF ${g.offset_bits}</span>`;
  const hi = total - 1, idxHi = g.offset_bits + g.index_bits - 1;
  $('#bitScale').innerHTML =
    `<span style="width:${pct(g.tag_bits)}"><i>${hi}</i><i>${g.offset_bits + g.index_bits}</i></span>` +
    (g.index_bits ? `<span style="width:${pct(g.index_bits)}"><i>${idxHi}</i><i>${g.offset_bits}</i></span>` : '') +
    `<span style="width:${pct(g.offset_bits)}"><i>${g.offset_bits - 1}</i><i>0</i></span>`;
  $('#cliEquiv').textContent = cliEquivalent();
}

/* ---- address decode ---- */
function bitsHTML(f) {
  const grp = (cls, bits, cap) => {
    if (!bits.length) return `<div class="grp ${cls} empty"><div class="row"></div><span class="cap">${cap}</span></div>`;
    const cells = bits.split('').map((b) => `<span class="bit${b === '1' ? ' one' : ''}">${b}</span>`).join('');
    return `<div class="grp ${cls}"><div class="row">${cells}</div><span class="cap">${cap}</span></div>`;
  };
  return grp('tag', f.tag_binary, `TAG · ${f.tag_bits} b`) +
    grp('idx', f.index_binary, f.index_bits ? `INDEX · ${f.index_bits} b` : 'NO INDEX (FA)') +
    grp('off', f.offset_binary, `OFFSET · ${f.offset_bits} b`);
}
function fieldsHTML(f, g, e) {
  const hit = e && e.result === 'HIT';
  return `
    <div class="field"><span class="lbl">TAG${hit ? ' · MATCH' : ''}</span><span class="lcd${hit ? ' match' : ''}" id="tagLcd">${esc(f.tag_hex)}</span></div>
    <div class="field"><span class="lbl">INDEX → SET</span><span class="lcd blue${e ? ' link' : ''}" id="idxLcd">${f.index} / ${g.num_sets}</span></div>
    <div class="field"><span class="lbl">OFFSET</span><span class="lcd green">${f.offset} (${hex(f.offset)})</span></div>
    <div class="field"><span class="lbl">BLOCK ADDRESS</span><span class="lcd dimmed">${f.block_address}</span></div>`;
}

// one or two plain sentences about the current access, for people following along
const MISS_WHY = {
  compulsory: 'this block has never been in the cache before',
  capacity: 'the cache is too small to have kept this block',
  conflict: 'another block took its place in this set, though the cache had room elsewhere',
};
function explain(e, g) {
  const verb = e.op === 'R' ? 'Read' : 'Write';
  const where = g.num_sets > 1 ? `Index bits pick <b>set ${e.set_index}</b>` : 'Every line is searched';
  let s = `${verb} <b>${esc(e.fields.hex)}</b>. ${where}; the tag is <b>${esc(e.fields.tag_hex)}</b>. `;
  if (e.result === 'HIT') {
    s += `That tag is already in way ${e.way}, so this is a <b class="g">hit</b>: no trip to memory.`;
    if (e.op === 'W') s += e.mem_write ? ' The word is also written through to memory.' : ' The line is marked dirty and written back later.';
    return s;
  }
  if (e.result === 'VICTIM') s += 'Not in the set, but found in the <b class="b">victim cache</b>, so it is swapped back in without a memory read.';
  else s += `No line in the set holds it: a <b class="r">miss</b>${e.miss_type ? ` (${e.miss_type}: ${MISS_WHY[e.miss_type]})` : ''}.`;
  if (e.way === null || e.way === undefined) return s + ' With no-write-allocate the word goes straight to memory and the cache is left unchanged.';
  if (e.result !== 'VICTIM') s += ` The block is fetched from memory into way ${e.way}.`;
  if (e.evicted) {
    s += ` It replaces tag <b>${hex(e.evicted.tag)}</b>`;
    s += e.evicted.to_victim ? ', which moves to the victim cache.' : (e.evicted.writeback ? ', which was dirty and is written back to memory first.' : ', which was clean and is simply dropped.');
  }
  if (e.op === 'W') s += e.mem_write && !e.writeback ? ' The word is written through to memory.' : (g.write_policy === 'WB' ? ' The line is marked dirty.' : '');
  return s;
}

const decodeView = { badgeKey: '' };
function renderDecode() {
  const g = geometry();
  const e = currentEvent();
  const probeActive = state.probe && document.activeElement === $('#probeIn') && $('#probeIn').value.trim();
  let f = null, op = '·', badge = '', note = '';
  if (probeActive) {
    f = state.probe.fields; op = '?';
    note = `<b>PROBE</b> address decoded for the current geometry (not an access). Use INJECT to append it to the trace.`;
  } else if (e) {
    f = e.fields; op = e.op;
    const mt = e.miss_type ? `<small>${e.miss_type.toUpperCase()}</small>` : '';
    badge = `<div class="result-badge ${e.result}">${e.result === 'VICTIM' ? 'VICTIM HIT' : e.result}${mt}</div>`;
    note = explain(e, state.sim.config);
    if (isEndSummary()) note = `<b>END · access ${state.traceCount} of ${state.traceCount}</b> (stepping covers the first ${state.sim.events.length}; counters show whole-trace totals) — ` + note;
  } else if (state.sim) {
    note = `Press ▶ or step forward. Each step is one memory access from the trace.`;
  }
  $('#addrOut').textContent = f ? f.hex : '— — — —';
  $('#addrOut').classList.toggle('dimmed', !f);
  const ob = $('#opBadge'); ob.textContent = op; ob.className = 'op-badge ' + (op === 'R' || op === 'W' ? op : '');
  const badgeKey = e && !probeActive ? `${state.step}:${e.fields.hex}:${e.result}` : '';
  const animBadge = badge && badgeKey !== decodeView.badgeKey;
  decodeView.badgeKey = badgeKey;
  $('#resultBadge').outerHTML = badge ? badge.replace('class="result-badge', `class="result-badge${animBadge ? ' anim' : ''}`) : '<div class="result-badge" id="resultBadge"></div>';
  if (badge) $('.result-badge').id = 'resultBadge';
  $('#bitsOut').innerHTML = f ? bitsHTML(f) : bitsHTML({ tag_binary: '', index_binary: '', offset_binary: '', tag_bits: g.tag_bits, index_bits: g.index_bits, offset_bits: g.offset_bits });
  $('#fieldsOut').innerHTML = f ? fieldsHTML(f, g, probeActive ? null : e) : '';
  const noteEl = $('#noteOut');
  noteEl.className = 'note' + (e && !probeActive ? ' ' + e.result : '');
  if (noteEl.dataset.key !== note) {
    noteEl.dataset.key = note;
    noteEl.innerHTML = note;
    if (e && !probeActive) restartAnimation(noteEl, 'anim', ['anim']);
  }
}

/* ---- cache array ---- */
const FULL_GRID_MAX_SETS = 64;
function cellHTML(line, ways, way) {
  const ageBars = ways > 1
    ? `<span class="age">${Array.from({ length: ways }, (_, i) => `<i class="${line.age !== null && line.age !== undefined && i < ways - line.age ? 'on' : ''}"></i>`).join('')}</span>` : '';
  const tag = line.valid ? hex(line.tag) : '— —';
  return `<div class="cell${line.valid ? '' : ' empty'}" data-way="${way}">
    <span class="v${line.valid ? ' on' : ''}" title="valid"></span><span class="d${line.dirty ? ' on' : ''}" title="dirty"></span>
    <span class="tagv">${tag}</span>${ageBars}</div>`;
}

// patch one cell in place so CSS transitions / animations can run between steps
function patchCell(cell, line, ways) {
  cell.classList.toggle('empty', !line.valid);
  cell.querySelector('.v').classList.toggle('on', !!line.valid);
  cell.querySelector('.d').classList.toggle('on', !!line.dirty);
  const tag = line.valid ? hex(line.tag) : '— —';
  const tv = cell.querySelector('.tagv');
  if (tv.textContent !== tag) tv.textContent = tag;
  const age = cell.querySelector('.age');
  if (age) {
    const hasAge = line.age !== null && line.age !== undefined;
    Array.from(age.children).forEach((i, k) => i.classList.toggle('on', hasAge && k < ways - line.age));
  }
}

function restartAnimation(el, cls, remove) {
  el.classList.remove(...remove);
  void el.offsetWidth;                       // reflow so the same animation can play again
  el.classList.add(cls);
}


// scroll an element into view inside its own scroll container without moving the page
function revealIn(container, el, smooth) {
  if (!container || !el) return;
  const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
  let delta = 0;
  if (r.top < c.top + 4) delta = r.top - c.top - 4;
  else if (r.bottom > c.bottom - 4) delta = r.bottom - c.bottom + 4;
  if (delta) container.scrollTo({ top: container.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
}

const EMPTY_ARRAY_SVG = `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="40" height="10" rx="1"/><rect x="4" y="22" width="40" height="10" rx="1"/><rect x="4" y="36" width="40" height="6" rx="1" stroke-dasharray="3 3"/><circle cx="9" cy="13" r="1.5"/><circle cx="9" cy="27" r="1.5"/><path d="M18 13h20M18 27h20" stroke-dasharray="2 3"/></svg>`;

// memory-bus LEDs under the array: what the current access cost the memory system
function renderBus(e, pulse) {
  const set = (id, on, color) => {
    const el = $(id);
    el.className = 'led' + (on ? ' on-' + color : '');
    if (on && pulse) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }
  };
  set('#ledMemR', !!(e && e.mem_read), 'blue');
  set('#ledMemW', !!(e && e.mem_write), 'violet');
  set('#ledWb', !!(e && e.writeback), 'teal');
  set('#ledVc', !!(e && e.result === 'VICTIM'), 'blue');
  let note = 'memory bus idle';
  if (e) {
    const parts = [];
    const bs = state.sim ? state.sim.config.block_size : 0;
    if (e.mem_read) parts.push(`fetch ${bs} B`);
    if (e.writeback) parts.push(`write back ${bs} B`);
    else if (e.mem_write) parts.push(`write ${state.sim ? state.sim.config.word_size : 4} B`);
    if (e.result === 'VICTIM') parts.push('swap with victim cache');
    note = parts.length ? parts.join(' · ') : 'no memory traffic';
  }
  $('#busNote').textContent = note;
}


/* ---- decode -> array connector: INDEX readout down the panel edge into the highlighted set ---- */
function renderConnector() {
  const svg = $('#connector');
  if (!svg) return;
  const e = currentEvent();
  const idx = $('#idxLcd');
  const row = e && !isEndSummary() ? $(`#arrayOut .set-row[data-set="${e.set_index}"]`) : null;
  const probeActive = document.activeElement === $('#probeIn') && $('#probeIn').value.trim();
  if (!e || !idx || !row || probeActive) { svg.innerHTML = ''; return; }
  const body = $('#arrayOut').closest('.array-body');
  const R = svg.getBoundingClientRect(), a = idx.getBoundingClientRect(), b = row.getBoundingClientRect(), v = body.getBoundingClientRect();
  const label = row.querySelector('.set-label').getBoundingClientRect();
  const rail = 5;                                   // runs along the left panel edge, never over content
  const sx = a.left + a.width / 2 - R.left, sy = a.bottom - R.top;
  const ex = label.left - R.left + 2;
  let ey = b.top + b.height / 2 - R.top;
  const vt = v.top - R.top, vb = v.bottom - R.top;
  const visible = ey >= vt + 6 && ey <= vb - 6;
  let d = `M${sx.toFixed(1)},${sy.toFixed(1)} V${(sy + 7).toFixed(1)} H${rail}`;
  let out;
  if (visible) {
    d += ` V${ey.toFixed(1)} H${(ex - 8).toFixed(1)}`;
    out = `<path d="${d}"/><path class="head" d="M${(ex - 8).toFixed(1)},${(ey - 4).toFixed(1)} l7,4 -7,4 z"/>`;
  } else {
    const cy = ey < vt ? vt + 6 : vb - 6;           // the set is scrolled out of the window: point at the edge
    d += ` V${cy.toFixed(1)}`;
    out = `<path d="${d}"/><path class="head" d="M${rail - 4},${(ey < vt ? cy + 6 : cy - 6).toFixed(1)} l4,${ey < vt ? -6 : 6} 4,${ey < vt ? 6 : -6} z"/>`;
  }
  const txt = `SET ${e.set_index}`;
  // label sits on the rail just above where the wire turns into the set, clear of the decode text
  const turnY = visible ? ey : (ey < vt ? vt + 6 : vb - 6);
  const lx = rail + 8, ly = Math.max(sy + 20, turnY - 10);
  // the row already says which set it is; name it only when that row is scrolled out of view
  if (!visible) out += `<rect class="lblbg" x="${lx - 4}" y="${ly - 9}" width="${txt.length * 6.3 + 8}" height="13" rx="2"/><text x="${lx}" y="${ly + 1}">${txt}</text>`;
  svg.innerHTML = out;
}

/* ---- trace timeline (top strip) ---- */
const traceView = { sim: null, base: null, w: 0, h: 20 };
function buildTraceBase() {
  const strip = $('#traceStrip');
  const w = Math.max(1, Math.floor(strip.clientWidth)), h = traceView.h, dpr = window.devicePixelRatio || 1;
  const base = document.createElement('canvas');
  base.width = Math.floor(w * dpr); base.height = Math.floor(h * dpr);
  const ctx = base.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = theme().lcd; ctx.fillRect(0, 0, w, h);
  const evs = state.sim.events, n = evs.length;
  if (n) {
    const colors = { HIT: theme().green, MISS: theme().red, VICTIM: theme().blue };
    const px = w / n;
    if (px >= 1.5) {
      for (let i = 0; i < n; i++) { ctx.fillStyle = colors[evs[i].result]; ctx.fillRect(i * px, 2, Math.max(1, px - 0.5), h - 4); }
    } else {
      // more accesses than pixels: each column shows the majority result, with a thin minority band
      const cols = Math.floor(w);
      for (let x = 0; x < cols; x++) {
        const a = Math.floor(x * n / cols), b = Math.max(a + 1, Math.floor((x + 1) * n / cols));
        let hit = 0, miss = 0, vic = 0;
        for (let i = a; i < b; i++) { const r = evs[i].result; if (r === 'HIT') hit++; else if (r === 'VICTIM') vic++; else miss++; }
        const tot = b - a;
        const hh = Math.round((h - 4) * hit / tot), vh = Math.round((h - 4) * vic / tot);
        ctx.fillStyle = colors.MISS; ctx.fillRect(x, 2, 1, h - 4);
        ctx.fillStyle = colors.VICTIM; ctx.fillRect(x, 2 + (h - 4) - hh - vh, 1, vh);
        ctx.fillStyle = colors.HIT; ctx.fillRect(x, 2 + (h - 4) - hh, 1, hh);
      }
    }
  }
  traceView.base = base; traceView.w = w; traceView.sim = state.sim;
}
function renderTraceStrip() {
  const strip = $('#traceStrip'), cv = $('#traceCanvas'), cur = $('#traceCursor'), lab = $('#traceLabel');
  if (!state.sim || !state.sim.events.length) {
    strip.classList.add('empty'); cur.hidden = true; lab.textContent = 'NO TRACE LOADED';
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
    traceView.sim = null;
    return;
  }
  strip.classList.remove('empty');
  const w = Math.floor(strip.clientWidth), h = traceView.h, dpr = window.devicePixelRatio || 1;
  if (traceView.sim !== state.sim || traceView.w !== w) buildTraceBase();
  if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(traceView.base, 0, 0);
  const n = state.sim.events.length, done = Math.min(state.step, n);
  const x = w * done / n;
  ctx.fillStyle = theme().veil;
  ctx.fillRect(Math.floor(x * dpr), 0, cv.width - Math.floor(x * dpr), cv.height);   // dim what has not run yet
  cur.hidden = false; cur.style.left = Math.max(0, Math.min(w - 2, x)) + 'px';
  const extra = state.sim.truncated ? ` · +${state.traceCount - n} MORE (END)` : '';
  lab.textContent = `${state.step} / ${maxStep()}${extra}`;
}
function traceSeek(ev) {
  if (!state.sim) return;
  const strip = $('#traceStrip'), r = strip.getBoundingClientRect();
  const n = maxStep();
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  stopPlayback();
  setStep(frac > 0.995 ? n : Math.round(frac * n));    // the far right edge always reaches END
}

/* ---- hit-ratio sparkline in COUNTERS ---- */
const sparkView = { sim: null, pts: null };
function renderSpark() {
  const cv = $('#sparkHit'), val = $('#sparkVal');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(cv.clientWidth)), h = 44;
  if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.sim || !state.sim.events.length) { val.textContent = '—'; return; }
  if (sparkView.sim !== state.sim) { sparkView.pts = state.sim.events.map((e) => e.stats_after.hit_ratio); sparkView.sim = state.sim; }
  const pts = sparkView.pts, n = pts.length;
  const X = (i) => 3 + (w - 6) * i / Math.max(1, n - 1), Y = (v) => 4 + (h - 8) * (1 - v);
  for (const g of [0.25, 0.5, 0.75]) { ctx.strokeStyle = `rgba(${theme().tintRgb},.08)`; ctx.beginPath(); ctx.moveTo(3, Y(g)); ctx.lineTo(w - 3, Y(g)); ctx.stroke(); }
  const done = Math.min(state.step, n);
  const line = (from, to, color, width) => {
    if (to - from < 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = from; i < to; i++) { if (i === from) ctx.moveTo(X(i), Y(pts[i])); else ctx.lineTo(X(i), Y(pts[i])); }
    ctx.stroke();
  };
  line(0, n, `rgba(${theme().greenRgb},.18)`, 1);                       // whole trace, faint
  if (done > 1) {
    ctx.fillStyle = `rgba(${theme().greenRgb},.12)`; ctx.beginPath(); ctx.moveTo(X(0), h - 4);
    for (let i = 0; i < done; i++) ctx.lineTo(X(i), Y(pts[i]));
    ctx.lineTo(X(done - 1), h - 4); ctx.closePath(); ctx.fill();
  }
  line(0, done, theme().green, 1.5);
  if (done > 0) {
    const cx = X(done - 1), cy = Y(pts[done - 1]);
    ctx.fillStyle = theme().accent; ctx.shadowColor = `rgba(${theme().accentRgb},.8)`; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  }
  val.textContent = done > 0 ? pts[done - 1].toFixed(3) : '—';
}

const arrayView = { sim: null, rowsKey: '', lastStep: -1 };
function renderArray() {
  const out = $('#arrayOut');
  if (!state.sim) {
    out.innerHTML = `<div class="array-empty">${EMPTY_ARRAY_SVG}<span>LOAD A TRACE TO POPULATE THE ARRAY</span><span style="letter-spacing:.04em;color:var(--dim)">presets · generator · paste / file — in TRACE SOURCE</span></div>`;
    $('#heatStrip').hidden = true; $('#victimOut').hidden = true; $('#wayHead').hidden = true;
    arrayView.sim = null; arrayView.rowsKey = ''; arrayView.lastStep = -1;
    renderBus(null, false);
    return;
  }
  const g = state.sim.config;
  const e = currentEvent();
  $('#arraySub').textContent = `${g.num_sets} sets × ${g.ways} ways · ${g.num_blocks} lines · ${fmtBytes(g.cache_size)} · ${g.mapping_name.toLowerCase()}`;
  const curSet = e ? e.set_index : -1;
  const forward = arrayView.sim === state.sim && state.step === arrayView.lastStep + 1 && !!e && !isEndSummary();
  let rows;
  if (g.num_sets <= FULL_GRID_MAX_SETS) {
    rows = Array.from({ length: g.num_sets }, (_, i) => i);
    $('#heatStrip').hidden = true;
  } else {
    const center = state.arrayFocus !== null ? state.arrayFocus : (curSet >= 0 ? curSet : 0);
    const start = Math.max(0, Math.min(center - 3, g.num_sets - 8));
    rows = Array.from({ length: 8 }, (_, i) => start + i);
    const heat = $('#heatStrip');
    heat.hidden = false;
    heat.innerHTML = `<span class="heat-title">SET ACTIVITY MAP · ${g.num_sets} SETS · ONE SQUARE PER SET · DETAIL WINDOW SHOWS SETS ${start}–${start + 7}</span>` +
      state.heat.map((h, i) => `<i class="${h}${i === curSet ? ' cur' : ''}" data-set="${i}" title="set ${i} — click to show it in the detail window"></i>`).join('');
  }
  const rowsKey = `${rows[0]}:${rows.length}:${g.ways}`;
  if (arrayView.sim !== state.sim || arrayView.rowsKey !== rowsKey) {
    out.innerHTML = (g.num_sets > FULL_GRID_MAX_SETS ? `<div class="window-note">DETAIL WINDOW · SETS ${rows[0]}–${rows[rows.length - 1]} OF ${g.num_sets}<input class="lcd-input jump" id="jumpSet" type="number" min="0" max="${g.num_sets - 1}" placeholder="go to set" title="Centre the detail window on a set (Enter)"></div>` : '') +
      rows.map((s, k) => `<div class="set-row${k % 2 ? ' alt' : ''}" data-set="${s}"><span class="set-label">SET ${s}</span>${state.grid[s].map((line, w) => cellHTML(line, g.ways, w)).join('')}</div>`).join('');
    const jump = $('#jumpSet');
    if (jump) jump.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { state.arrayFocus = Math.max(0, Math.min(g.num_sets - 1, Number(jump.value) || 0)); renderArray(); } ev.stopPropagation(); });
    arrayView.sim = state.sim; arrayView.rowsKey = rowsKey;
    const wh = $('#wayHead');
    wh.hidden = false;
    wh.innerHTML = '<span class="set-label">WAY</span>' + Array.from({ length: g.ways }, (_, w) => `<span class="way">${w}</span>`).join('');
  }
  renderBus(e, forward);
  // patch every visible cell; mark the cell touched by the current access
  const resultCls = e ? (e.result === 'HIT' ? 'hitcell' : (e.result === 'VICTIM' ? 'victimcell' : 'misscell')) : '';
  for (const row of out.querySelectorAll('.set-row')) {
    const s = Number(row.dataset.set);
    const isCur = s === curSet;
    row.classList.toggle('current', isCur);
    row.querySelectorAll('.cell').forEach((cell, w) => {
      patchCell(cell, state.grid[s][w], g.ways);
      const touched = isCur && e && e.way === w;
      cell.classList.toggle('hitcell', touched && resultCls === 'hitcell');
      cell.classList.toggle('misscell', touched && resultCls === 'misscell');
      cell.classList.toggle('victimcell', touched && resultCls === 'victimcell');
      cell.classList.toggle('tagmatch', touched && resultCls === 'hitcell');
    });
    let note = row.querySelector('.row-note');
    const evText = isCur && e && e.evicted ? `evicted ${hex(e.evicted.tag)}${e.evicted.dirty ? ' (dirty' + (e.evicted.writeback ? ', written back' : (e.evicted.to_victim ? ', to victim cache' : '')) + ')' : (e.evicted.to_victim ? ' (to victim cache)' : '')}` : '';
    if (evText) {
      if (!note) { note = document.createElement('span'); note.className = 'row-note'; row.appendChild(note); }
      note.textContent = '← ' + evText;
    } else if (note) note.remove();
    if (isCur && forward) {
      if (e.way === null || e.way === undefined) {
        restartAnimation(row, 'anim-miss', ['anim-miss']);      // nothing allocated (no-write-allocate)
      } else {
        const cell = row.querySelectorAll('.cell')[e.way];
        if (cell) {
          const cls = e.result === 'HIT' ? 'anim-hit' : (e.result === 'VICTIM' ? 'anim-victim' : 'anim-miss');
          restartAnimation(cell, cls, ['anim-hit', 'anim-miss', 'anim-victim']);
          if (e.result !== 'HIT') restartAnimation(cell.querySelector('.tagv'), 'anim-in', ['anim-in']);
          if (e.evicted) {
            cell.querySelectorAll('.ghost').forEach((x) => x.remove());
            const ghost = document.createElement('span');
            ghost.className = 'ghost' + (e.evicted.dirty ? ' dirty' : '');
            ghost.textContent = '⟶ ' + hex(e.evicted.tag);
            ghost.addEventListener('animationend', () => ghost.remove());
            cell.appendChild(ghost);
          }
        }
      }
    }
  }
  if (curSet >= 0 && g.num_sets <= FULL_GRID_MAX_SETS) {
    const row = out.querySelector(`.set-row[data-set="${curSet}"]`);
    revealIn(out.closest('.array-body'), row, !(state.playing && stepsPerSecond() > 8));
  }
  arrayView.lastStep = state.step;
  renderConnector();
  // victim cache strip
  const vc = $('#victimOut');
  if (g.victim_entries) {
    vc.hidden = false;
    const entries = isEndSummary() ? state.sim.victim_state : (e ? e.victim_after : []);
    const cells = [];
    for (let i = 0; i < g.victim_entries; i++) {
      const v = entries[i];
      cells.push(v ? `<div class="cell"><span class="d${v.dirty ? ' on' : ''}"></span><span class="tagv">BLK ${hex(v.block)}</span></div>`
        : `<div class="cell empty"><span class="d"></span><span class="tagv">— —</span></div>`);
    }
    vc.innerHTML = `<span class="set-label">VICTIM CACHE · ${g.victim_entries} × FA · FIFO</span>${cells.join('')}`;
  } else vc.hidden = true;
}

/* ---- counters ---- */
const COUNTER_GROUPS = [
  ['ACCESSES', [['accesses', 'TOTAL', ''], ['reads', 'READS', 'blue'], ['writes', 'WRITES', 'violet'],
                ['hits', 'HITS', 'green'], ['misses', 'MISSES', 'red'], ['read_misses', 'READ MISSES', ''], ['write_misses', 'WRITE MISSES', '']]],
  ['MISSES BY TYPE', [['compulsory', 'COMPULSORY', 'teal'], ['capacity', 'CAPACITY', 'violet'], ['conflict', 'CONFLICT', 'red'], ['victim_hits', 'VICTIM HITS', 'blue']]],
  ['MEMORY', [['mem_reads', 'READS', ''], ['mem_writes', 'WRITES', ''], ['writebacks', 'WRITE-BACKS', 'teal'],
              ['dirty_lines', 'DIRTY LINES', '']]],
];
function renderCounters() {
  const s = currentStats();
  const z = (k) => (s ? s[k] : 0);
  const setLcd = (sel, txt) => { const el = $(sel); if (el.textContent !== txt) { el.textContent = txt; restartAnimation(el, 'tick', ['tick']); } };
  setLcd('#hitRatio', s ? s.hit_ratio.toFixed(3) : '0.000');
  setLcd('#missRatio', s ? s.miss_ratio.toFixed(3) : '0.000');
  setLcd('#amat', s ? s.amat.toFixed(2) : '0.00');
  const m = Math.max(1, z('misses'));
  $('#missBar .comp').style.width = (100 * z('compulsory') / m) + '%';
  $('#missBar .cap').style.width = (100 * z('capacity') / m) + '%';
  $('#missBar .conf').style.width = (100 * z('conflict') / m) + '%';
  $('#mixComp').textContent = z('compulsory');
  $('#mixCap').textContent = z('capacity');
  $('#mixConf').textContent = z('conflict');
  $('#kpiMissFoot').textContent = s ? `${z('misses')} of ${z('accesses')} accesses missed` : 'no accesses yet';
  $('#kpiTraffic').innerHTML = `${s ? s.traffic_kib.toFixed(2) : '0.00'}<small> KiB</small>`;
  $('#kpiTrafficFoot').textContent = s && s.dirty_lines ? `${s.traffic_flushed_kib.toFixed(2)} KiB once ${s.dirty_lines} dirty lines are flushed` : 'bytes moved to and from memory';
  const n = Math.max(1, z('accesses'));
  // what the current access changed: compare with the statistics after the previous step
  const prev = s && !isEndSummary() ? (state.step >= 2 ? state.sim.events[state.step - 2].stats_after : null) : null;
  const d = (k) => (s && !isEndSummary() ? s[k] - (prev ? prev[k] : 0) : 0);
  // build the grid once, then patch values in place so the meters slide instead of being redrawn every step
  const grid = $('#counterGrid');
  if (!grid.firstChild) {
    const item = ([k, l, c]) => `<div class="ctr ${c}" data-k="${k}"><span class="lbl">${l}</span><span class="val ${c}"><span class="n">0</span></span></div>`;
    const traffic = `<div class="ctr" data-k="traffic"><span class="lbl">TRAFFIC</span><span class="val"><span class="n">0.00 KiB</span></span></div>` +
      `<div class="ctr" data-k="trafficFlushed" title="traffic if every dirty line were written back now"><span class="lbl">WITH FLUSH</span><span class="val"><span class="n">0.00 KiB</span></span></div>`;
    grid.innerHTML = COUNTER_GROUPS.map(([title, items], gi) =>
      `<div class="ctr-group"><h5>${title}</h5><div class="ctr-list">${items.map(item).join('')}${gi === COUNTER_GROUPS.length - 1 ? traffic : ''}</div></div>`).join('');
  }
  const setCtr = (el, text, pct, delta) => {
    const num = el.querySelector('.n');
    if (num.textContent !== text) num.textContent = text;
    el.style.setProperty('--pct', pct.toFixed(1) + '%');
    const old = el.querySelector('.delta');
    if (old) old.remove();
    if (delta) { const i = document.createElement('i'); i.className = 'delta'; i.textContent = delta; el.querySelector('.val').appendChild(i); }
  };
  for (const [, items] of COUNTER_GROUPS) {
    for (const [k] of items) {
      const dv = d(k);
      setCtr(grid.querySelector(`.ctr[data-k="${k}"]`), String(z(k)), Math.min(100, 100 * z(k) / n), dv > 0 ? `+${dv}` : '');
    }
  }
  setCtr(grid.querySelector('.ctr[data-k="traffic"]'), `${s ? s.traffic_kib.toFixed(2) : '0.00'} KiB`, 0,
    s && !isEndSummary() && s.traffic_bytes > (prev ? prev.traffic_bytes : 0) ? `+${s.traffic_bytes - (prev ? prev.traffic_bytes : 0)} B` : '');
  setCtr(grid.querySelector('.ctr[data-k="trafficFlushed"]'), `${s ? s.traffic_flushed_kib.toFixed(2) : '0.00'} KiB`, 0, '');
  $('#countersSub').textContent = isEndSummary() ? 'final · whole trace' : (state.sim ? `after step ${state.step}` : 'at current step');
  renderSpark();
}

/* ---- log ---- */
let logBuiltFor = null;
function renderLog() {
  const out = $('#logOut');
  if (!state.sim) { out.innerHTML = '<div class="log-empty">NO ACCESSES YET</div>'; $('#logSub').textContent = ''; logBuiltFor = null; return; }
  const evs = state.sim.events;
  if (logBuiltFor !== state.sim) {
    logBuiltFor = state.sim;
    const rows = evs.map((e, i) => {
      const mt = e.miss_type ? `<small>${e.miss_type.slice(0, 4).toUpperCase()}</small>` : (e.result === 'VICTIM' ? '<small>VC</small>' : '');
      return `<div class="log-row" data-i="${i + 1}"><span>${i + 1}</span><span class="op ${e.op}">${e.op}</span><span>${e.fields.hex}</span><span>${e.set_index}</span><span>${e.way === null ? '—' : e.way}</span><span class="r ${e.result}"><em>${e.result === 'VICTIM' ? 'VICT' : e.result}</em>${mt}</span></div>`;
    });
    if (state.sim.truncated) rows.push(`<div class="log-more">… ${state.traceCount - evs.length} more accesses (step to END for totals)</div>`);
    out.innerHTML = rows.join('');
    $('#logSub').textContent = `${state.traceCount} accesses${state.sim.truncated ? ` · first ${evs.length} steppable` : ''}`;
    applyLogFilter();
  }
  const rows = out.children;
  for (let i = 0; i < evs.length; i++) {
    const r = rows[i];
    const n = i + 1;
    r.classList.toggle('current', n === state.step);
    r.classList.toggle('done', n < state.step || isEndSummary());
    r.classList.toggle('pending', n > state.step && !isEndSummary());
  }
  const cur = out.querySelector('.log-row.current');
  if (cur) revealIn(out, cur, !(state.playing && stepsPerSecond() > 8));
  else if (state.step === 0) out.scrollTop = 0;
}

function applyLogFilter() {
  const q = ($('#logFilter').value || '').trim().toLowerCase();
  $$('#logOut .log-row').forEach((r) => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); });
}

/* ------------------------------------------------------------------ */
/*  Trace source                                                       */
/* ------------------------------------------------------------------ */
// tiny access-pattern icon per trace family (12 × 12 viewBox)
function traceGlyph(name) {
  const n = name.toLowerCase();
  let body;
  if (n.includes('conflict')) body = '<polyline points="1,9.5 3,2.5 5,9.5 7,2.5 9,9.5 11,2.5"/>';
  else if (n.includes('loop')) body = '<polyline points="1,10.5 4,1.5 4,10.5 7,1.5 7,10.5 10,1.5 10,10.5"/>';
  else if (n.includes('random')) body = '<circle cx="2.5" cy="8" r=".9"/><circle cx="5" cy="3" r=".9"/><circle cx="7.5" cy="9.5" r=".9"/><circle cx="9.5" cy="5" r=".9"/><circle cx="4" cy="6" r=".9"/>';
  else if (n.includes('strided')) body = '<polyline points="1,10.5 3,10.5 3,8 5,8 5,5.5 7,5.5 7,3 9,3 9,1.5 11,1.5"/>';
  else if (n.includes('matrix_col') || n.includes('col')) body = '<path d="M2 2v8M6 2v8M10 2v8" /><path d="M1.5 10l.5.8.5-.8M5.5 10l.5.8.5-.8M9.5 10l.5.8.5-.8"/>';
  else if (n.includes('matrix')) body = '<path d="M2 2h8M2 6h8M2 10h8"/><path d="M10 1.5l.8.5-.8.5M10 5.5l.8.5-.8.5M10 9.5l.8.5-.8.5"/>';
  else if (n.includes('sequential')) body = '<polyline points="1,10.5 11,1.5"/><polyline points="8,1.5 11,1.5 11,4.5"/>';
  else body = '<rect x="2" y="1.5" width="8" height="9" rx="1"/><path d="M4 4h4M4 6h4M4 8h2"/>';
  return `<svg viewBox="0 0 12 12">${body}</svg>`;
}

async function loadPresets() {
  const { traces } = await api('/api/traces');
  const list = $('#presetList');
  list.innerHTML = traces.map((t) => `<button class="preset" data-name="${esc(t.name)}"><i class="glyph">${traceGlyph(t.name)}</i><span class="name">${esc(t.name.replace(/\.trace$/, ''))}</span><span class="count">${t.accesses}</span><span class="desc">${esc(t.description)}</span></button>`).join('');
  list.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => loadPreset(b.dataset.name)));
  return traces;
}
async function loadPreset(name) {
  try {
    const t = await api('/api/traces/' + encodeURIComponent(name));
    state.presetCache[name] = t.text;
    if (await setTrace(t.text, name) === true) $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.name === name));
  } catch (e) { toast(e.message, true); }
}
// load a new trace; if the server rejects it (bad line) the previously loaded trace stays in place.
// Returns true when this trace is now the one shown, 'stale' when a later load superseded it, false on a bad trace.
async function setTrace(text, name) {
  const prev = { text: state.traceText, name: state.traceName, step: state.step };
  state.traceText = text;
  state.traceName = name;
  state.step = 0;
  logBuiltFor = null;
  $('#traceStatus').textContent = name;
  const r = await simulate({ goto: 'start' });
  if (r === 'stale') return 'stale';
  if (r !== 'trace') return true;                 // config errors keep the new trace for later
  state.traceText = prev.text;
  state.traceName = prev.name;
  state.step = prev.step;
  logBuiltFor = null;
  $('#traceStatus').textContent = prev.name || 'none loaded';
  if (prev.text.trim()) await simulate();
  return false;
}

function buildGenerator() {
  const kinds = Object.keys(state.meta.generators);
  const seg = $('#genKinds');
  seg.innerHTML = kinds.map((k) => `<button data-kind="${k}">${k.toUpperCase()}</button>`).join('');
  const pick = (k) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
    const params = state.meta.generators[k];
    $('#genForm').innerHTML = Object.entries(params).map(([p, v]) => {
      if (p === 'order') return `<label><span class="lbl">${p}</span><div class="seg" data-param="order"><button data-v="row" class="active">ROW</button><button data-v="col">COL</button></div></label>`;
      return `<label><span class="lbl">${p.replace(/_/g, ' ')}</span><input class="num-in" data-param="${p}" type="number" step="${typeof v === 'number' && !Number.isInteger(v) ? '0.05' : '1'}" value="${v}"></label>`;
    }).join('');
    $('#genForm').querySelectorAll('.seg[data-param] button').forEach((b) => b.addEventListener('click', () => {
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#genForm').dataset.kind = k;
  };
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => pick(b.dataset.kind)));
  pick('loop');
  $('#btnGenerate').addEventListener('click', async () => {
    const kind = $('#genForm').dataset.kind;
    const params = {};
    $('#genForm').querySelectorAll('input[data-param]').forEach((i) => { params[i.dataset.param] = Number(i.value); });
    const ord = $('#genForm').querySelector('.seg[data-param="order"] button.active');
    if (ord) params.order = ord.dataset.v;
    try {
      const r = await api('/api/generate', { kind, params });
      if (await setTrace(r.text, `generated ${kind} (${r.count})`) === true) {
        $$('.preset').forEach((b) => b.classList.remove('active'));
        toast(`generated ${r.count} accesses`);
      }
    } catch (e) { toast(e.message, true); }
  });
}

/* ------------------------------------------------------------------ */
/*  Probe & inject                                                     */
/* ------------------------------------------------------------------ */
let probeTimer = null;
async function probe() {
  const inp = $('#probeIn'), v = inp.value.trim();
  if (!v) { state.probe = null; inp.classList.remove('bad'); renderDecode(); return; }
  try {
    state.probe = await api('/api/decode', { config: state.config, address: v });
    inp.classList.remove('bad');
  } catch (e) { state.probe = null; inp.classList.add('bad'); }
  renderDecode();
}
// INJECT uses the same parse as PROBE (and as a trace line), so the two never disagree
async function inject(op) {
  const v = $('#probeIn').value.trim();
  if (!v) { toast('type an address in PROBE first', true); return; }
  clearTimeout(probeTimer);
  await probe();
  if (!state.probe) { toast(`bad address: ${v}`, true); return; }
  const addr = state.probe.address_in;
  state.traceText = state.traceText.replace(/\s*$/, '') + `\n${op} ${hex(addr, 8)}\n`;
  const m = state.traceName.match(/^(.*) \+(\d+)$/);
  state.traceName = m ? `${m[1]} +${Number(m[2]) + 1}` : `${state.traceName} +1`;
  $('#traceStatus').textContent = state.traceName;
  logBuiltFor = null;
  $('#probeIn').blur();
  simulate({ goto: 'end' });
  toast(`${op === 'R' ? 'read' : 'write'} of ${hex(addr)} appended`);
}

/* ------------------------------------------------------------------ */
/*  Experiments                                                        */
/* ------------------------------------------------------------------ */
const SWEEP_VALUES = {
  associativity: [1, 2, 4, 8, 0],
  block_size: [4, 8, 16, 32, 64, 128],
  cache_size: [256, 512, 1024, 2048, 4096, 8192, 16384],
  replacement: ['LRU', 'FIFO', 'RANDOM'],
  write_policy: ['WB', 'WT'],
  write_allocate: [true, false],
  victim_entries: [0, 2, 4, 8],
};
const SWEEP_LABELS = {
  associativity: 'ASSOC', block_size: 'BLOCK', cache_size: 'SIZE', replacement: 'REPL',
  write_policy: 'WRITE', write_allocate: 'ALLOC', victim_entries: 'VICTIM',
};
const METRIC_LABELS = {
  hit_ratio: 'HIT RATIO', miss_ratio: 'MISS RATIO', amat: 'AMAT', misstypes: 'MISS TYPES',
  traffic_kib: 'TRAFFIC', writebacks: 'WRITE-BACKS', mem_reads: 'MEM READS', mem_writes: 'MEM WRITES',
  traffic_flushed_kib: 'TRAFFIC + FLUSH',
};
const seriesColors = () => [theme().accent, theme().teal, theme().blue, theme().violet, theme().green, theme().red, theme().muted];

function buildExperimentControls() {
  const mk = (el, items, cur, onpick) => {
    el.innerHTML = items.map(([v, l]) => `<button data-v="${v}"${v === cur ? ' class="active"' : ''}>${l}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onpick(b.dataset.v);
    }));
  };
  mk($('#sweepParam'), Object.entries(SWEEP_LABELS), state.sweepParam, (v) => { state.sweepParam = v; });
  mk($('#sweepSeries'), [['', 'NONE']].concat(Object.entries(SWEEP_LABELS)), state.sweepSeries, (v) => { state.sweepSeries = v; });
  mk($('#sweepMetric'), Object.entries(METRIC_LABELS), state.sweepMetric, (v) => { state.sweepMetric = v; });
}

async function runSweep() {
  if (!state.traceText.trim()) { toast('load a trace first', true); return; }
  const param = state.sweepParam;
  let series = state.sweepSeries;
  if (series === param) series = '';
  setStatus('SWEEP', 'accent');
  $('#btnSweep').disabled = true;
  try {
    const r = await api('/api/sweep', {
      config: state.config, trace: state.traceText, param, values: SWEEP_VALUES[param],
      series_param: series || null, series_values: series ? SWEEP_VALUES[series] : null,
    });
    state.sweep = { rows: r.rows, param, series, trace: state.traceName, accesses: r.accesses };
    state.hiddenSeries.clear();
    state.sweepSort = null;
    renderSweep();
    $('#btnExportCsv').disabled = false;
    toast(`sweep done · ${r.rows.length} configurations`);
  } catch (e) { toast(e.message, true); }
  $('#btnSweep').disabled = false;
  setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'accent' : null);
}

function renderSweep() {
  const sw = state.sweep;
  const metric = state.sweepMetric;
  const cats = [], seriesNames = [];
  for (const r of sw.rows) { if (!cats.includes(r.label)) cats.push(r.label); const s = r.series || ''; if (!seriesNames.includes(s)) seriesNames.push(s); }
  let series, stacked = false, fmt = (v) => v.toFixed(3), ylabel = METRIC_LABELS[metric];
  if (metric === 'misstypes') {
    stacked = true; fmt = (v) => String(Math.round(v));
    const useSeries = seriesNames.length > 1 ? seriesNames[0] : '';
    series = ['compulsory', 'capacity', 'conflict'].map((k, i) => ({
      name: k.toUpperCase(), color: [theme().teal, theme().violet, theme().red][i],
      values: cats.map((c) => { const r = sw.rows.find((x) => x.label === c && (x.series || '') === useSeries); return r && r.stats ? r.stats[k] : null; }),
    }));
    ylabel = 'MISSES' + (useSeries ? ' · ' + useSeries : '');
  } else {
    if (['writebacks', 'mem_reads', 'mem_writes', 'dirty_lines', 'mem_writes_flushed'].includes(metric)) fmt = (v) => String(Math.round(v));
    if (metric === 'amat' || metric === 'traffic_kib' || metric === 'traffic_flushed_kib') fmt = (v) => v.toFixed(2);
    series = seriesNames.map((s, i) => ({
      name: s || METRIC_LABELS[metric], color: seriesColors()[i % 7],
      values: cats.map((c) => { const r = sw.rows.find((x) => x.label === c && (x.series || '') === s); return r && r.stats ? r.stats[metric] : null; }),
    }));
  }
  series.forEach((s) => { s.hidden = state.hiddenSeries.has(s.name); });
  const title = `${METRIC_LABELS[metric]} vs ${SWEEP_LABELS[sw.param]}${sw.series ? ' · series: ' + SWEEP_LABELS[sw.series] : ''}`;
  const sweepable = (state.meta && state.meta.sweepable) || {};
  const xlabel = sw.param === 'trace' ? 'TRACE' : (sweepable[sw.param] || SWEEP_LABELS[sw.param]).toUpperCase();
  state.sweepView = { cats, series, stacked, fmt, metric, metricLabel: METRIC_LABELS[metric], rows: sw.rows, seriesParam: sw.series };
  $('#chartOut').innerHTML = barChartSVG({ title, subtitle: `trace: ${sw.trace} · ${sw.accesses} accesses · base: ${cliEquivalent().replace('python -m cachesim run ', '')}`, cats, series, stacked, fmt, ylabel, xlabel });
  hideChartTip();
  // table
  const cols = ['hit_ratio', 'miss_ratio', 'compulsory', 'capacity', 'conflict', 'writebacks', 'mem_reads', 'mem_writes', 'traffic_kib', 'amat'];
  const sortKey = (r, col) => {
    if (r.error) return null;
    if (col === 'series') return r.series || '';
    if (col === 'label') return sw.rows.indexOf(r);              // keeps the sweep order
    if (col === 'geometry') return r.geometry.num_sets * 1000 + r.geometry.ways;
    return r.stats[col];
  };
  const sort = state.sweepSort;
  let rowsSorted = sw.rows.slice();
  if (sort) {
    rowsSorted.sort((x, y) => {
      const kx = sortKey(x, sort.col), ky = sortKey(y, sort.col);
      if (kx === null) return 1; if (ky === null) return -1;
      const c = typeof kx === 'string' ? kx.localeCompare(ky) : kx - ky;
      return sort.dir === 'asc' ? c : -c;
    });
  }
  const th = (col, label) => `<th data-col="${col}" class="${sort && sort.col === col ? 'sorted ' + sort.dir : ''}" title="sort by ${label.toLowerCase()}">${label}<i class="sort-ind"></i></th>`;
  const head = `<tr>${th('series', 'SERIES')}${th('label', SWEEP_LABELS[sw.param])}${th('geometry', 'SETS×WAYS')}${cols.map((c) => th(c, c.replace(/_/g, ' ').toUpperCase())).join('')}</tr>`;
  const body = rowsSorted.map((r) => {
    const i = sw.rows.indexOf(r);
    if (r.error) return `<tr data-i="${i}"><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td class="err" colspan="${cols.length + 1}">${esc(r.error)}</td></tr>`;
    return `<tr data-i="${i}"><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td>${r.geometry.num_sets}×${r.geometry.ways}</td>${cols.map((c) => { const v = r.stats[c]; return `<td class="${sort && sort.col === c ? 'sorted' : ''}">${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(c === 'amat' || c === 'traffic_kib' ? 2 : 4) : v}</td>`; }).join('')}</tr>`;
  }).join('');
  $('#sweepTable').innerHTML = `<table>${head}${body}</table>`;
}

async function compareTraces() {
  const names = $$('.preset').map((b) => b.dataset.name);
  if (!names.length) { toast('no preset traces', true); return; }
  setStatus('SWEEP', 'accent');
  $('#btnCompareTraces').disabled = true;
  try {
    const rows = [];
    const cfg = JSON.parse(JSON.stringify(state.config));   // one configuration for the whole comparison
    for (const n of names) {
      if (!state.presetCache[n]) state.presetCache[n] = (await api('/api/traces/' + encodeURIComponent(n))).text;
      const r = await api('/api/simulate', { config: cfg, trace: state.presetCache[n], event_limit: 0 });
      rows.push({ param: 'trace', value: n, label: n.replace('.trace', ''), series: null, stats: r.stats,
        geometry: { num_sets: r.config.num_sets, ways: r.config.ways } });
    }
    state.sweep = { rows, param: 'trace', series: '', trace: 'all presets', accesses: rows.reduce((a, r) => a + r.stats.accesses, 0) };
    SWEEP_LABELS.trace = 'TRACE';
    state.hiddenSeries.clear();
    state.sweepSort = null;
    renderSweep();
    $('#btnExportCsv').disabled = false;
  } catch (e) { toast(e.message, true); }
  $('#btnCompareTraces').disabled = false;
  setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'accent' : null);
}

function exportCsv() {
  const sw = state.sweep; if (!sw) return;
  const cols = ['hit_ratio', 'miss_ratio', 'compulsory', 'capacity', 'conflict', 'victim_hits', 'writebacks', 'mem_reads', 'mem_writes', 'traffic_kib', 'amat'];
  const lines = [['series', sw.param, 'label'].concat(cols).join(',')];
  for (const r of sw.rows) {
    if (r.error) { lines.push([r.series || '', r.value, r.label, 'ERROR ' + r.error].join(',')); continue; }
    lines.push([r.series || '', r.value, r.label].concat(cols.map((c) => r.stats[c])).join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sweep_${sw.param}_${(sw.trace || 'trace').replace(/[^a-z0-9]+/gi, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---- SVG bar chart (grouped or stacked), instrument style ---- */
function niceMax(v) {
  if (v <= 0) return 1;
  if (v <= 1) return 1;
  const exp = Math.floor(Math.log10(v)), base = Math.pow(10, exp);
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
}
function barChartSVG({ title, subtitle, cats, series, stacked, fmt, ylabel, xlabel }) {
  const W = 820, H = 356, pl = 56, pr = 16, pt = 52, pb = 74;
  const pw = W - pl - pr, ph = H - pt - pb;
  let top;
  const shown = series.filter((s) => !s.hidden);
  if (stacked) top = niceMax(Math.max(...cats.map((_, ci) => shown.reduce((a, s) => a + (s.values[ci] || 0), 0)), 0));
  else top = niceMax(Math.max(...shown.flatMap((s) => s.values.filter((v) => v !== null)), 0));
  const y = (v) => pt + ph - ph * Math.min(v, top) / top;
  let o = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">`;
  const T = theme();
  o += `<text x="${pl}" y="22" fill="${T.accent}" font-size="12" letter-spacing="1">${esc(title.toUpperCase())}</text>`;
  o += `<text x="${pl}" y="38" fill="${T.muted}" font-size="9.5">${esc(subtitle)}</text>`;
  for (let i = 0; i <= 5; i++) {
    const yy = pt + ph - ph * i / 5, val = top * i / 5;
    o += `<line x1="${pl}" y1="${yy}" x2="${pl + pw}" y2="${yy}" stroke="${T.hair}" stroke-dasharray="2 4"/>`;
    o += `<text x="${pl - 8}" y="${yy}" fill="${T.muted}" text-anchor="end" dominant-baseline="middle" font-size="10">${top > 1 ? +val.toFixed(2) : val.toFixed(2)}</text>`;
  }
  o += `<text x="14" y="${pt + ph / 2}" fill="${T.muted}" font-size="9.5" transform="rotate(-90 14 ${pt + ph / 2})" text-anchor="middle" letter-spacing="1">${esc(ylabel)}</text>`;
  const gw = pw / Math.max(1, cats.length);
  const n = stacked ? 1 : Math.max(1, shown.length);
  const bw = Math.max(4, (gw * 0.7 - 3 * (n - 1)) / n);
  cats.forEach((c, ci) => {
    const gx = pl + ci * gw + gw * 0.15;
    if (stacked) {
      let acc = 0;
      series.forEach((s) => {
        const v = s.values[ci]; if (v === null || v === undefined || s.hidden) return;
        const y0 = y(acc), y1 = y(acc + v);
        o += `<rect class="bar" data-ci="${ci}" data-si="${series.indexOf(s)}" x="${gx + (gw * 0.7 - bw) / 2}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1)}" fill="${s.color}" opacity=".9"/>`;
        if (v > 0 && y0 - y1 > 12) o += `<text x="${gx + gw * 0.35}" y="${(y0 + y1) / 2}" fill="${T.lcd}" font-size="9.5" text-anchor="middle" dominant-baseline="middle">${fmt(v)}</text>`;
        acc += v;
      });
      o += `<text x="${gx + gw * 0.35}" y="${y(acc) - 4}" fill="${T.text}" font-size="9.5" text-anchor="middle">${fmt(acc)}</text>`;
    } else {
      shown.forEach((s) => {
        const si = series.indexOf(s), v = s.values[ci];
        const x = gx + shown.indexOf(s) * (bw + 3);
        if (v === null || v === undefined) { o += `<text x="${x + bw / 2}" y="${pt + ph - 6}" fill="${T.dim}" font-size="9" text-anchor="middle">n/a</text>`; return; }
        o += `<rect class="bar" data-ci="${ci}" data-si="${si}" x="${x}" y="${Math.min(y(v), pt + ph - 2)}" width="${bw}" height="${Math.max(2, pt + ph - y(v))}" fill="${s.color}" opacity=".9"/>`;
        o += `<rect x="${x}" y="${y(v)}" width="${bw}" height="2" fill="#fff"/>`;
        o += `<text x="${x + bw / 2}" y="${y(v) - 4}" fill="${T.text}" font-size="9" text-anchor="middle">${fmt(v)}</text>`;
      });
    }
    o += `<text x="${pl + ci * gw + gw / 2}" y="${pt + ph + 16}" fill="${T.text}" text-anchor="middle" font-size="10.5">${esc(c)}</text>`;
  });
  o += `<line x1="${pl}" y1="${pt + ph}" x2="${pl + pw}" y2="${pt + ph}" stroke="${T.muted}"/>`;
  if (xlabel) o += `<text x="${pl + pw / 2}" y="${pt + ph + 34}" fill="${T.muted}" font-size="9.5" text-anchor="middle" letter-spacing="1">${esc(xlabel)}</text>`;
  let lx = pl; const ly = H - 16;
  series.forEach((s) => {
    o += `<g class="legend-item${s.hidden ? ' off' : ''}" data-name="${esc(s.name)}"><rect x="${lx - 4}" y="${ly - 9}" width="${13 + 6.5 * s.name.length + 10}" height="18" fill="transparent"/>` +
      `<circle cx="${lx + 4}" cy="${ly}" r="4" fill="${s.color}"/><text x="${lx + 13}" y="${ly}" fill="${T.text}" dominant-baseline="middle" font-size="10">${esc(s.name)}</text></g>`;
    lx += 13 + 6.5 * s.name.length + 22;
  });
  if (series.length > 1) o += `<text x="${W - pr}" y="${ly}" fill="${T.dim}" font-size="9" text-anchor="end" dominant-baseline="middle">click a legend entry to hide / show it</text>`;
  return o + '</svg>';
}


/* ---- chart tooltip: hover a bar for its numbers; the matching table row lights up ---- */
function hideChartTip() {
  const tip = $('#chartTip'); if (tip) tip.hidden = true;
  const svg = $('#chartOut svg'); if (svg) { svg.classList.remove('hovering'); svg.querySelectorAll('rect.bar.hot').forEach((r) => r.classList.remove('hot')); }
  $$('#sweepTable tr.hot').forEach((r) => r.classList.remove('hot'));
}
function chartHover(ev) {
  const bar = ev.target.closest ? ev.target.closest('rect.bar') : null;
  const svg = $('#chartOut svg');
  const v = state.sweepView;
  if (!bar || !svg || !v) { hideChartTip(); return; }
  const ci = Number(bar.dataset.ci), si = Number(bar.dataset.si);
  const cat = v.cats[ci];
  let tip = $('#chartTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'chartTip'; tip.className = 'chart-tip'; $('#chartOut').appendChild(tip); }
  const seriesName = v.series[si] ? v.series[si].name : '';
  const lines = v.series.map((s, k) => {
    const val = s.values[ci];
    return `<div class="row${k === si ? ' hot' : ''}"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><span class="val">${val === null || val === undefined ? 'n/a' : v.fmt(val)}</span></div>`;
  }).join('');
  // full stats of the hovered configuration from the sweep table
  const wanted = v.stacked ? '' : (v.seriesParam ? seriesName : '');
  const row = v.rows.find((r) => r.label === cat && (r.series || '') === (v.stacked ? (v.rows.find((x) => x.label === cat) || {}).series || '' : wanted)) || v.rows.find((r) => r.label === cat);
  let extra = '';
  if (row && row.stats) {
    const st = row.stats;
    extra = `<div class="sep"></div>` +
      `<div class="row"><span>hit ratio</span><span>${st.hit_ratio.toFixed(3)}</span></div>` +
      `<div class="row"><span>AMAT</span><span>${st.amat.toFixed(2)} cyc</span></div>` +
      `<div class="row"><span>misses C/C/C</span><span>${st.compulsory} / ${st.capacity} / ${st.conflict}</span></div>` +
      (row.geometry ? `<div class="row"><span>sets × ways</span><span>${row.geometry.num_sets} × ${row.geometry.ways}</span></div>` : '');
  }
  tip.innerHTML = `<b>${esc(cat)}${v.seriesParam && !v.stacked ? ' · ' + esc(seriesName) : ''}</b>${lines}${extra}`;
  tip.hidden = false;
  const host = $('#chartOut').getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = ev.clientX - host.left + 14, y = ev.clientY - host.top - th - 12;
  if (x + tw > host.width - 4) x = ev.clientX - host.left - tw - 14;
  if (y < 4) y = ev.clientY - host.top + 16;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
  svg.classList.add('hovering');
  svg.querySelectorAll('rect.bar').forEach((r) => r.classList.toggle('hot', Number(r.dataset.ci) === ci && (v.stacked || Number(r.dataset.si) === si)));
  const trs = $$('#sweepTable tbody tr, #sweepTable tr');
  trs.forEach((tr) => tr.classList.remove('hot'));
  if (row) { const idx = v.rows.indexOf(row); const tr = $(`#sweepTable tr[data-i="${idx}"]`); if (tr) tr.classList.add('hot'); }
}

/* ---- help overlay & shortcuts ---- */
/* ---- setup drawer: docked beside the stage on wide screens, an overlay otherwise ---- */
const DOCK_MIN = 1500;
function setupDocked() { return window.innerWidth >= DOCK_MIN; }
function setupIsOpen() { return document.body.classList.contains('setup-open'); }
function toggleSetup(open, section) {
  const want = open === undefined ? !setupIsOpen() : open;
  document.body.classList.toggle('setup-open', want);
  $('#btnSetup').setAttribute('aria-expanded', String(want));
  try { localStorage.setItem('cachesim.setup', want ? '1' : '0'); } catch (err) { /* not remembered */ }
  if (want && section === 'trace') $('#modTrace').scrollIntoView({ block: 'start', behavior: 'smooth' });
  // the stage changes width when the drawer docks: redraw what is measured in pixels
  setTimeout(() => { renderTraceStrip(); renderSpark(); renderConnector(); }, 300);
}
function initSetupDrawer() {
  let saved = null;
  try { saved = localStorage.getItem('cachesim.setup'); } catch (err) { /* ignore */ }
  const open = saved === null ? setupDocked() : saved === '1';
  document.body.classList.toggle('setup-open', open);
  $('#btnSetup').setAttribute('aria-expanded', String(open));
  requestAnimationFrame(() => document.body.classList.add('setup-ready'));
  // segmented controls reflow (2 x 2 on narrow screens, drawer width): keep each highlight on its button
  const segObserver = new ResizeObserver((entries) => entries.forEach((en) => positionIndicator(en.target)));
  const watchSegs = () => $$('.seg-ind').forEach((seg) => { if (!seg.dataset.watched) { seg.dataset.watched = '1'; segObserver.observe(seg); } });
  watchSegs();
  new MutationObserver(watchSegs).observe($('#configBody'), { childList: true, subtree: true });
}

/* ---- light / dark theme ---- */
function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function applyTheme(t) {
  document.body.classList.add('theme-swap');                // swap colours at once, no half-faded frame
  if (t === 'light') document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('cachesim.theme', t); } catch (err) { /* not remembered */ }
  themeCache = null; traceView.sim = null;                   // canvases read colours from the theme
  renderTraceStrip(); renderSpark();
  if (state.sweep) renderSweep();
  $('#btnTheme').title = t === 'light' ? 'Switch to dark mode (T)' : 'Switch to light mode (T)';
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('theme-swap')));
}

function toggleHelp(show) {
  const o = $('#helpOverlay');
  const vis = show === undefined ? o.hidden : show;
  o.hidden = !vis;
  if (vis) $('#btnHelpClose').focus(); else $('#btnHelp').blur();
}
function nudgeRate(delta) {
  const s = $('#speed');
  s.value = Math.max(Number(s.min), Math.min(Number(s.max), Number(s.value) + Math.sign(delta)));
  s.dispatchEvent(new Event('input'));
  toast(`speed ${rateLabel(stepsPerSecond())}`);
}
function applyAnimSpeed() {
  // Manual stepping and slow playback get the full, staged animation: the address decodes, the set
  // lights up, then the line shows the result.  As the rate rises the animation shortens so the
  // array never lags behind, and above 4 accesses per second the stages collapse into one.
  const rate = stepsPerSecond();
  const interval = 1000 / rate;
  const ms = state.playing ? Math.max(140, Math.min(900, Math.round(interval * 0.7))) : 800;
  const staged = !state.playing || rate <= 4;
  const root = document.documentElement.style;
  root.setProperty('--anim-ms', ms + 'ms');
  root.setProperty('--stage', (staged ? Math.round(ms * 0.3) : 0) + 'ms');
  root.setProperty('--glide', Math.max(90, Math.min(320, Math.round(interval * 0.45))) + 'ms');
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */
function wire() {
  $('#btnFirst').addEventListener('click', () => { stopPlayback(); setStep(0); });
  $('#btnBack').addEventListener('click', () => { stopPlayback(); setStep(state.step - 1); });
  $('#btnStep').addEventListener('click', () => { stopPlayback(); setStep(state.step + 1); });
  $('#btnLast').addEventListener('click', () => { stopPlayback(); setStep(maxStep()); });
  $('#btnPlay').addEventListener('click', () => { if (state.playing) { stopPlayback(); setStatus('IDLE'); } else { if (atEnd()) setStep(0); startPlayback(); } });
  $('#speed').addEventListener('input', () => {
    $('#speedOut').textContent = rateLabel(stepsPerSecond());
    applyAnimSpeed();
    try { localStorage.setItem('cachesim.rate', String(stepsPerSecond())); } catch (err) { /* private mode: not remembered */ }
  });
  let savedRate = NaN;
  try { savedRate = Number(localStorage.getItem('cachesim.rate')); } catch (err) { /* ignore */ }
  if (savedRate > 0 && RATES.indexOf(savedRate) >= 0) $('#speed').value = RATES.indexOf(savedRate);
  $('#speedOut').textContent = rateLabel(stepsPerSecond());
  applyAnimSpeed();

  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    const helpOpen = !$('#helpOverlay').hidden;
    if (e.key === 'Escape') {
      if (helpOpen) { e.preventDefault(); toggleHelp(false); return; }
      if (inField) { document.activeElement.blur(); return; }
      if (setupIsOpen() && !setupDocked()) { e.preventDefault(); toggleSetup(false); return; }
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); toggleHelp(); return; }
    if (helpOpen) return;
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleSetup(); return; }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); return; }
    const n = e.shiftKey ? 10 : 1;
    if (e.key === ' ') { e.preventDefault(); $('#btnPlay').click(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlayback(); setStep(state.step + n); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlayback(); setStep(state.step - n); }
    else if (e.key === 'Home') { e.preventDefault(); $('#btnFirst').click(); }
    else if (e.key === 'End') { e.preventDefault(); $('#btnLast').click(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); nudgeRate(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeRate(-1); }
    else if (e.key === '/') { e.preventDefault(); $('#probeIn').focus(); $('#probeIn').select(); }
  });
  $('#btnHelp').addEventListener('click', () => toggleHelp());
  $('#btnSetup').addEventListener('click', () => toggleSetup());
  $('#btnTheme').addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));
  $('#btnTheme').title = currentTheme() === 'light' ? 'Switch to dark mode (T)' : 'Switch to light mode (T)';
  $('#btnSetupClose').addEventListener('click', () => toggleSetup(false));
  $('#setupScrim').addEventListener('click', () => toggleSetup(false));
  $('#readoutStrip').addEventListener('click', () => toggleSetup(true, 'trace'));
  $('#inspTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.itab'); if (!b) return;
    $$('#inspTabs .itab').forEach((t) => t.classList.toggle('active', t === b));
    $$('#modInspector .insp-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    $('#logFilter').hidden = b.dataset.tab !== 'log';
    if (b.dataset.tab === 'log') renderLog(); else renderCounters();
  });
  $('#btnHelpClose').addEventListener('click', () => toggleHelp(false));
  $('#helpOverlay').addEventListener('click', (e) => { if (e.target === $('#helpOverlay')) toggleHelp(false); });
  $('#chartOut').addEventListener('mousemove', chartHover);
  $('#chartOut').addEventListener('mouseleave', hideChartTip);
  $('#sweepTable').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]'); if (!th || !state.sweep) return;
    const col = th.dataset.col, cur = state.sweepSort;
    state.sweepSort = cur && cur.col === col ? (cur.dir === 'desc' ? { col, dir: 'asc' } : null) : { col, dir: 'desc' };
    renderSweep();
  });
  $('#chartOut').addEventListener('click', (e) => {
    const it = e.target.closest ? e.target.closest('.legend-item') : null;
    if (!it || !state.sweep) return;
    const name = it.dataset.name;
    if (state.hiddenSeries.has(name)) state.hiddenSeries.delete(name); else state.hiddenSeries.add(name);
    renderSweep();
  });
  // trace timeline: click / drag to seek
  const strip = $('#traceStrip');
  let scrubbing = false;
  strip.addEventListener('pointerdown', (e) => { scrubbing = true; strip.setPointerCapture(e.pointerId); traceSeek(e); });
  strip.addEventListener('pointermove', (e) => { if (scrubbing) traceSeek(e); });
  strip.addEventListener('pointerup', () => { scrubbing = false; });
  strip.addEventListener('pointercancel', () => { scrubbing = false; });
  // rate presets
  const markPreset = () => $$('#ratePresets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === stepsPerSecond()));
  $$('#ratePresets button').forEach((b) => b.addEventListener('click', () => setRate(Number(b.dataset.rate))));
  $('#speed').addEventListener('input', markPreset);
  markPreset();
  // sticky offsets follow the real top-bar height; canvases follow their width
  const syncTop = () => document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
  syncTop();
  new ResizeObserver(syncTop).observe($('.topbar'));
  new ResizeObserver(() => { renderTraceStrip(); renderSpark(); }).observe(strip);

  $('#traceTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    $$('#traceTabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    $$('#modTrace .tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  });
  $('#btnLoadPaste').addEventListener('click', async () => {
    const t = $('#pasteArea').value;
    if (!t.trim()) { toast('nothing to load', true); return; }
    if (await setTrace(t, 'pasted trace') === true) $$('.preset').forEach((b) => b.classList.remove('active'));
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $('#pasteArea').value = rd.result.length > 200000 ? rd.result.slice(0, 200000) + '\n# (preview truncated; full file loaded)' : rd.result; setTrace(rd.result, f.name).then((ok) => { if (ok === true) $$('.preset').forEach((b) => b.classList.remove('active')); }); };
    rd.readAsText(f);
    e.target.value = '';
  });

  $('#probeIn').addEventListener('input', () => { clearTimeout(probeTimer); probeTimer = setTimeout(probe, 120); });
  $('#probeIn').addEventListener('focus', () => { if ($('#probeIn').value.trim()) probe(); });
  $('#probeIn').addEventListener('blur', () => setTimeout(renderDecode, 150));
  $('#btnInjectR').addEventListener('click', () => inject('R'));
  $('#btnInjectW').addEventListener('click', () => inject('W'));
  $('#btnCopyCli').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cliEquivalent()); toast('command copied'); } catch (e) { toast('clipboard unavailable', true); }
  });

  $('#btnSweep').addEventListener('click', runSweep);
  $('#btnCompareTraces').addEventListener('click', compareTraces);
  $('#btnExportCsv').addEventListener('click', exportCsv);
  $('#sweepMetric').addEventListener('click', () => { if (state.sweep) renderSweep(); });
  $('#logFilter').addEventListener('input', applyLogFilter);
  $('#heatStrip').addEventListener('click', (e) => { const i = e.target.closest('i[data-set]'); if (i) { state.arrayFocus = Number(i.dataset.set); renderArray(); } });
  $('#arrayOut').closest('.array-body').addEventListener('scroll', () => renderConnector(), { passive: true });
  new ResizeObserver(() => renderConnector()).observe($('.stage-main'));
  $('#logOut').addEventListener('click', (e) => { const r = e.target.closest('.log-row'); if (r) { stopPlayback(); setStep(Number(r.dataset.i)); } });
}

async function init() {
  try {
    state.meta = await api('/api/meta');
  } catch (e) {
    toast('cannot reach the simulator server: ' + e.message, true);
    setStatus('ERROR', 'red');
    return;
  }
  const d = state.meta.defaults;
  state.config = {
    cache_size: d.cache_size, block_size: d.block_size, associativity: d.associativity, replacement: d.replacement,
    write_policy: d.write_policy, write_allocate: d.write_allocate, address_bits: d.address_bits,
    victim_entries: d.victim_entries, hit_time: d.hit_time, miss_penalty: d.miss_penalty, seed: d.seed,
    word_size: d.word_size, victim_penalty: d.victim_penalty,
  };
  // a friendlier starting point than the engine defaults: 1 KiB, 16 B, 4-way
  state.config.associativity = 4;
  $('#footVersion').textContent = 'CACHE-SIM v' + state.meta.version;
  $$('.stage .module').forEach((m, i) => m.style.setProperty('--i', i));
  initSetupDrawer();
  buildConfigControls();
  syncConfigUI();
  buildGenerator();
  buildExperimentControls();
  $('#chartOut').innerHTML = `<div class="chart-empty"><svg viewBox="0 0 54 36" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 32h46M4 32V4"/><rect x="10" y="18" width="7" height="14"/><rect x="22" y="10" width="7" height="22"/><rect x="34" y="22" width="7" height="10"/><rect x="46" y="6" width="4" height="26" stroke-dasharray="2 2"/></svg><span>NO SWEEP YET · CHOOSE AN AXIS AND PRESS RUN SWEEP</span></div>`;
  wire();
  renderGeometryOnly();
  renderArray();
  renderCounters();
  const traces = await loadPresets();
  const first = traces.find((t) => t.name === 'loop.trace') || traces[0];
  if (first) await loadPreset(first.name);
  else { setStatus('IDLE'); toast('no traces in data/ — generate one or paste'); }
}

init();
