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
      d.addEventListener('pointerdown', (ev) => { drag = true; d.setPointerCapture(ev.pointerId); pick(fromEvent(ev)); d.focus(); });
      d.addEventListener('pointermove', (ev) => { if (drag) pick(fromEvent(ev)); });
      d.addEventListener('pointerup', () => { drag = false; });
      d.addEventListener('pointercancel', () => { drag = false; });
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
      <label><span class="lbl">HIT TIME</span><input class="num-in" id="hitTime" type="number" step="0.5" min="0"></label>
      <label><span class="lbl">MISS PENALTY</span><input class="num-in" id="missPenalty" type="number" step="1" min="0"></label>
      <label><span class="lbl">RNG SEED</span><input class="num-in" id="seed" type="number" step="1" min="0"></label>`;
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

async function simulate(opts) {
  opts = opts || {};
  if (!state.traceText.trim()) { renderGeometryOnly(); return; }
  stopPlayback();
  setStatus('BUSY', 'amber');
  try {
    const res = await api('/api/simulate', { config: state.config, trace: state.traceText, event_limit: state.meta.event_limit });
    state.sim = res;
    state.traceCount = res.total_accesses;
    $('#configError').hidden = true;
    const max = maxStep();
    if (opts.goto === 'end') state.step = max;
    else if (opts.goto === 'start') state.step = 0;
    else state.step = Math.min(state.step, max);
    rebuildGrid();
    renderAll();
    setStatus(state.step >= max && max > 0 ? 'END' : 'IDLE', state.step >= max && max > 0 ? 'amber' : null);
  } catch (e) {
    $('#configError').textContent = e.message;
    $('#configError').hidden = false;
    setStatus('ERROR', 'red');
    renderGeometryOnly();
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
  const max = maxStep();
  n = Math.max(0, Math.min(max, n));
  if (n === state.step && !fromPlay) return;
  state.step = n;
  rebuildGrid();
  renderAll();
  if (!state.playing) setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'amber' : null);
}

/* ---- playback ---- */
function stepsPerSecond() { return Number($('#speed').value); }
function startPlayback() {
  if (!state.sim || atEnd()) return;
  state.playing = true;
  applyAnimSpeed();
  $('#btnPlay').textContent = '❚❚';
  $('#btnPlay').classList.add('playing');
  setStatus('RUN', 'green');
  const tick = () => {
    if (!state.playing) return;
    setStep(state.step + 1, true);
    if (atEnd()) { stopPlayback(); setStatus('END', 'amber'); return; }
    state.timer = setTimeout(tick, 1000 / stepsPerSecond());
  };
  tick();
}
function stopPlayback() {
  state.playing = false;
  clearTimeout(state.timer);
  applyAnimSpeed();
  $('#btnPlay').textContent = '▶';
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
  const chips = [
    ['MAP', map], ['SIZE', fmtBytes(g.cache_size)], ['BLK', g.block_size + ' B'],
    ['SETS', g.num_sets + '×' + g.ways], ['REPL', g.replacement],
    ['WR', g.write_policy + (g.write_allocate ? '/WA' : '/NWA')],
  ];
  if (g.victim_entries) chips.push(['VC', g.victim_entries]);
  $('#readoutStrip').innerHTML = chips.map(([k, v]) => `<span class="chip"><b>${k}</b>${esc(v)}</span>`).join('');
}

function renderGeometry() {
  const g = geometry();
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
function fieldsHTML(f, g) {
  return `
    <div class="field"><span class="lbl">TAG</span><span class="lcd">${esc(f.tag_hex)}</span></div>
    <div class="field"><span class="lbl">INDEX → SET</span><span class="lcd blue">${f.index} / ${g.num_sets}</span></div>
    <div class="field"><span class="lbl">OFFSET</span><span class="lcd green">${f.offset} (${hex(f.offset)})</span></div>
    <div class="field"><span class="lbl">BLOCK ADDRESS</span><span class="lcd dimmed">${f.block_address}</span></div>`;
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
    note = `<b>SET ${e.set_index}</b>${e.way === null ? '' : ` · WAY ${e.way}`} — ${esc(e.note)}`;
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
  $('#fieldsOut').innerHTML = f ? fieldsHTML(f, g) : '';
  $('#noteOut').innerHTML = note;
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
  set('#ledWb', !!(e && e.writeback), 'amber');
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

/* ---- trace timeline (top strip) ---- */
const traceView = { sim: null, base: null, w: 0, h: 20 };
function buildTraceBase() {
  const strip = $('#traceStrip');
  const w = Math.max(1, Math.floor(strip.clientWidth)), h = traceView.h, dpr = window.devicePixelRatio || 1;
  const base = document.createElement('canvas');
  base.width = Math.floor(w * dpr); base.height = Math.floor(h * dpr);
  const ctx = base.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0b0c0e'; ctx.fillRect(0, 0, w, h);
  const evs = state.sim.events, n = evs.length;
  if (n) {
    const colors = { HIT: '#58D68D', MISS: '#E8584F', VICTIM: '#5DADE2' };
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
  ctx.fillStyle = 'rgba(11,12,14,.72)';
  ctx.fillRect(Math.floor(x * dpr), 0, cv.width - Math.floor(x * dpr), cv.height);   // dim what has not run yet
  cur.hidden = false; cur.style.left = Math.max(0, Math.min(w - 2, x)) + 'px';
  const extra = state.sim.truncated ? ` · +${state.traceCount - n} MORE (END)` : '';
  lab.textContent = `${state.step} / ${maxStep()}${extra}`;
}
function traceSeek(ev) {
  if (!state.sim) return;
  const strip = $('#traceStrip'), r = strip.getBoundingClientRect();
  const n = state.sim.events.length;
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  stopPlayback();
  setStep(Math.round(frac * n));
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
  for (const g of [0.25, 0.5, 0.75]) { ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(3, Y(g)); ctx.lineTo(w - 3, Y(g)); ctx.stroke(); }
  const done = Math.min(state.step, n);
  const line = (from, to, color, width) => {
    if (to - from < 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = from; i < to; i++) { if (i === from) ctx.moveTo(X(i), Y(pts[i])); else ctx.lineTo(X(i), Y(pts[i])); }
    ctx.stroke();
  };
  line(0, n, 'rgba(88,214,141,.18)', 1);                       // whole trace, faint
  if (done > 1) {
    ctx.fillStyle = 'rgba(88,214,141,.12)'; ctx.beginPath(); ctx.moveTo(X(0), h - 4);
    for (let i = 0; i < done; i++) ctx.lineTo(X(i), Y(pts[i]));
    ctx.lineTo(X(done - 1), h - 4); ctx.closePath(); ctx.fill();
  }
  line(0, done, '#58D68D', 1.5);
  if (done > 0) {
    const cx = X(done - 1), cy = Y(pts[done - 1]);
    ctx.fillStyle = '#F5B942'; ctx.shadowColor = 'rgba(245,185,66,.8)'; ctx.shadowBlur = 6;
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
    const center = curSet >= 0 ? curSet : 0;
    const start = Math.max(0, Math.min(center - 3, g.num_sets - 8));
    rows = Array.from({ length: 8 }, (_, i) => start + i);
    const heat = $('#heatStrip');
    heat.hidden = false;
    heat.innerHTML = `<span class="heat-title">SET ACTIVITY MAP · ${g.num_sets} SETS · ONE SQUARE PER SET · DETAIL WINDOW SHOWS SETS ${start}–${start + 7}</span>` +
      state.heat.map((h, i) => `<i class="${h}${i === curSet ? ' cur' : ''}" title="set ${i}"></i>`).join('');
  }
  const rowsKey = `${rows[0]}:${rows.length}:${g.ways}`;
  if (arrayView.sim !== state.sim || arrayView.rowsKey !== rowsKey) {
    out.innerHTML = (g.num_sets > FULL_GRID_MAX_SETS ? `<div class="window-note">DETAIL WINDOW · SETS ${rows[0]}–${rows[rows.length - 1]} OF ${g.num_sets}</div>` : '') +
      rows.map((s) => `<div class="set-row" data-set="${s}"><span class="set-label">SET ${s}</span>${state.grid[s].map((line, w) => cellHTML(line, g.ways, w)).join('')}</div>`).join('');
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
      const ev = touched && e.evicted ? 'evict ' + hex(e.evicted.tag) + (e.evicted.dirty ? ' (dirty)' : '') : null;
      cell.classList.toggle('evicted-from', !!ev);
      if (ev) cell.dataset.ev = ev; else delete cell.dataset.ev;
    });
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
    revealIn(out.closest('.array-body'), row, !(state.playing && stepsPerSecond() > 10));
  }
  arrayView.lastStep = state.step;
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
const COUNTER_ITEMS = [
  ['accesses', 'ACCESSES', ''], ['hits', 'HITS', 'green'], ['misses', 'MISSES', 'red'],
  ['reads', 'READS', 'blue'], ['writes', 'WRITES', 'violet'],
  ['read_misses', 'READ MISSES', ''], ['write_misses', 'WRITE MISSES', ''],
  ['compulsory', 'COMPULSORY', 'amber'], ['capacity', 'CAPACITY', 'violet'], ['conflict', 'CONFLICT', 'red'],
  ['victim_hits', 'VICTIM HITS', 'blue'], ['writebacks', 'WRITE-BACKS', 'amber'],
  ['mem_reads', 'MEM READS', ''], ['mem_writes', 'MEM WRITES', ''],
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
  const n = Math.max(1, z('accesses'));
  $('#counterGrid').innerHTML = COUNTER_ITEMS.map(([k, l, c]) => `<div class="ctr ${c}" style="--pct:${Math.min(100, 100 * z(k) / n).toFixed(1)}%"><span class="lbl">${l}</span><span class="val ${c}">${z(k)}</span></div>`).join('') +
    `<div class="ctr"><span class="lbl">MEM TRAFFIC</span><span class="val">${s ? s.traffic_kib.toFixed(2) : '0.00'} KiB</span></div>`;
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
      return `<div class="log-row" data-i="${i + 1}"><span>${i + 1}</span><span class="op ${e.op}">${e.op}</span><span>${e.fields.hex}</span><span>${e.set_index}</span><span>${e.way === null ? '—' : e.way}</span><span class="r ${e.result}">${e.result === 'VICTIM' ? 'VICT' : e.result}${mt}</span></div>`;
    });
    if (state.sim.truncated) rows.push(`<div class="log-more">… ${state.traceCount - evs.length} more accesses (step to END for totals)</div>`);
    out.innerHTML = rows.join('');
    $('#logSub').textContent = `${state.traceCount} accesses${state.sim.truncated ? ` · first ${evs.length} steppable` : ''}`;
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
  if (cur) revealIn(out, cur, !(state.playing && stepsPerSecond() > 10));
  else if (state.step === 0) out.scrollTop = 0;
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
    setTrace(t.text, name);
    $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.name === name));
  } catch (e) { toast(e.message, true); }
}
function setTrace(text, name) {
  state.traceText = text;
  state.traceName = name;
  state.step = 0;
  logBuiltFor = null;
  $('#traceStatus').textContent = name;
  simulate({ goto: 'start' });
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
      setTrace(r.text, `generated ${kind} (${r.count})`);
      $$('.preset').forEach((b) => b.classList.remove('active'));
      toast(`generated ${r.count} accesses`);
    } catch (e) { toast(e.message, true); }
  });
}

/* ------------------------------------------------------------------ */
/*  Probe & inject                                                     */
/* ------------------------------------------------------------------ */
let probeTimer = null;
async function probe() {
  const v = $('#probeIn').value.trim();
  if (!v) { state.probe = null; renderDecode(); return; }
  try {
    state.probe = await api('/api/decode', { config: state.config, address: v });
    renderDecode();
  } catch (e) { state.probe = null; }
}
function inject(op) {
  const v = $('#probeIn').value.trim();
  if (!v) { toast('type an address in PROBE first', true); return; }
  let addr;
  try { addr = Number(BigInt(v.startsWith('0x') || v.startsWith('0X') ? v : (/[a-fA-F]/.test(v) ? '0x' + v : v))); } catch (e) { toast('bad address', true); return; }
  if (!Number.isFinite(addr) || addr < 0) { toast('bad address', true); return; }
  state.traceText = state.traceText.replace(/\s*$/, '') + `\n${op} ${hex(addr, 8)}\n`;
  state.traceName = state.traceName.replace(/ \+\d+$/, '') + (state.traceName.includes(' +') ? '' : '') ;
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
};
const COLORS = ['#F5B942', '#58D68D', '#5DADE2', '#E8584F', '#B388EB', '#F1948A', '#76D7C4'];

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
  setStatus('SWEEP', 'amber');
  $('#btnSweep').disabled = true;
  try {
    const r = await api('/api/sweep', {
      config: state.config, trace: state.traceText, param, values: SWEEP_VALUES[param],
      series_param: series || null, series_values: series ? SWEEP_VALUES[series] : null,
    });
    state.sweep = { rows: r.rows, param, series, trace: state.traceName, accesses: r.accesses };
    state.hiddenSeries.clear();
    renderSweep();
    $('#btnExportCsv').disabled = false;
    toast(`sweep done · ${r.rows.length} configurations`);
  } catch (e) { toast(e.message, true); }
  $('#btnSweep').disabled = false;
  setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'amber' : null);
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
      name: k.toUpperCase(), color: ['#F5B942', '#B388EB', '#E8584F'][i],
      values: cats.map((c) => { const r = sw.rows.find((x) => x.label === c && (x.series || '') === useSeries); return r && r.stats ? r.stats[k] : null; }),
    }));
    ylabel = 'MISSES' + (useSeries ? ' · ' + useSeries : '');
  } else {
    if (['writebacks', 'mem_reads', 'mem_writes'].includes(metric)) fmt = (v) => String(Math.round(v));
    if (metric === 'amat' || metric === 'traffic_kib') fmt = (v) => v.toFixed(2);
    series = seriesNames.map((s, i) => ({
      name: s || METRIC_LABELS[metric], color: COLORS[i % COLORS.length],
      values: cats.map((c) => { const r = sw.rows.find((x) => x.label === c && (x.series || '') === s); return r && r.stats ? r.stats[metric] : null; }),
    }));
  }
  series.forEach((s) => { s.hidden = state.hiddenSeries.has(s.name); });
  const title = `${METRIC_LABELS[metric]} vs ${SWEEP_LABELS[sw.param]}${sw.series ? ' · series: ' + SWEEP_LABELS[sw.series] : ''}`;
  state.sweepView = { cats, series, stacked, fmt, metric, metricLabel: METRIC_LABELS[metric], rows: sw.rows, seriesParam: sw.series };
  $('#chartOut').innerHTML = barChartSVG({ title, subtitle: `trace: ${sw.trace} · ${sw.accesses} accesses · base: ${cliEquivalent().replace('python -m cachesim run ', '')}`, cats, series, stacked, fmt, ylabel });
  hideChartTip();
  // table
  const cols = ['hit_ratio', 'miss_ratio', 'compulsory', 'capacity', 'conflict', 'writebacks', 'mem_reads', 'mem_writes', 'traffic_kib', 'amat'];
  const head = `<tr><th>SERIES</th><th>${SWEEP_LABELS[sw.param]}</th><th>SETS×WAYS</th>${cols.map((c) => `<th>${c.replace(/_/g, ' ').toUpperCase()}</th>`).join('')}</tr>`;
  const body = sw.rows.map((r) => {
    if (r.error) return `<tr><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td class="err" colspan="${cols.length + 1}">${esc(r.error)}</td></tr>`;
    return `<tr><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td>${r.geometry.num_sets}×${r.geometry.ways}</td>${cols.map((c) => { const v = r.stats[c]; return `<td>${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(c === 'amat' || c === 'traffic_kib' ? 2 : 4) : v}</td>`; }).join('')}</tr>`;
  }).join('');
  $('#sweepTable').innerHTML = `<table>${head}${body}</table>`;
}

async function compareTraces() {
  const names = $$('.preset').map((b) => b.dataset.name);
  if (!names.length) { toast('no preset traces', true); return; }
  setStatus('SWEEP', 'amber');
  $('#btnCompareTraces').disabled = true;
  try {
    const rows = [];
    for (const n of names) {
      if (!state.presetCache[n]) state.presetCache[n] = (await api('/api/traces/' + encodeURIComponent(n))).text;
      const r = await api('/api/simulate', { config: state.config, trace: state.presetCache[n], event_limit: 0 });
      rows.push({ param: 'trace', value: n, label: n.replace('.trace', ''), series: null, stats: r.stats,
        geometry: { num_sets: r.config.num_sets, ways: r.config.ways } });
    }
    state.sweep = { rows, param: 'trace', series: '', trace: 'all presets', accesses: rows.reduce((a, r) => a + r.stats.accesses, 0) };
    SWEEP_LABELS.trace = 'TRACE';
    renderSweep();
    $('#btnExportCsv').disabled = false;
  } catch (e) { toast(e.message, true); }
  $('#btnCompareTraces').disabled = false;
  setStatus(atEnd() ? 'END' : 'IDLE', atEnd() ? 'amber' : null);
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
function barChartSVG({ title, subtitle, cats, series, stacked, fmt, ylabel }) {
  const W = 820, H = 340, pl = 56, pr = 16, pt = 52, pb = 58;
  const pw = W - pl - pr, ph = H - pt - pb;
  let top;
  const shown = series.filter((s) => !s.hidden);
  if (stacked) top = niceMax(Math.max(...cats.map((_, ci) => shown.reduce((a, s) => a + (s.values[ci] || 0), 0)), 0));
  else top = niceMax(Math.max(...shown.flatMap((s) => s.values.filter((v) => v !== null)), 0));
  const y = (v) => pt + ph - ph * Math.min(v, top) / top;
  let o = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="JetBrains Mono, Menlo, monospace" font-size="11">`;
  o += `<text x="${pl}" y="22" fill="#F5B942" font-size="12" letter-spacing="2">${esc(title.toUpperCase())}</text>`;
  o += `<text x="${pl}" y="38" fill="#7E8591" font-size="9.5">${esc(subtitle)}</text>`;
  for (let i = 0; i <= 5; i++) {
    const yy = pt + ph - ph * i / 5, val = top * i / 5;
    o += `<line x1="${pl}" y1="${yy}" x2="${pl + pw}" y2="${yy}" stroke="#2A2D34" stroke-dasharray="2 4"/>`;
    o += `<text x="${pl - 8}" y="${yy}" fill="#7E8591" text-anchor="end" dominant-baseline="middle" font-size="10">${top > 1 ? +val.toFixed(2) : val.toFixed(2)}</text>`;
  }
  o += `<text x="14" y="${pt + ph / 2}" fill="#7E8591" font-size="9.5" transform="rotate(-90 14 ${pt + ph / 2})" text-anchor="middle" letter-spacing="1">${esc(ylabel)}</text>`;
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
        if (v > 0 && y0 - y1 > 12) o += `<text x="${gx + gw * 0.35}" y="${(y0 + y1) / 2}" fill="#0C0D0F" font-size="9.5" text-anchor="middle" dominant-baseline="middle">${fmt(v)}</text>`;
        acc += v;
      });
      o += `<text x="${gx + gw * 0.35}" y="${y(acc) - 4}" fill="#C9CDD4" font-size="9.5" text-anchor="middle">${fmt(acc)}</text>`;
    } else {
      shown.forEach((s) => {
        const si = series.indexOf(s), v = s.values[ci];
        const x = gx + shown.indexOf(s) * (bw + 3);
        if (v === null || v === undefined) { o += `<text x="${x + bw / 2}" y="${pt + ph - 6}" fill="#4C515B" font-size="9" text-anchor="middle">n/a</text>`; return; }
        o += `<rect class="bar" data-ci="${ci}" data-si="${si}" x="${x}" y="${Math.min(y(v), pt + ph - 2)}" width="${bw}" height="${Math.max(2, pt + ph - y(v))}" fill="${s.color}" opacity=".9"/>`;
        o += `<rect x="${x}" y="${y(v)}" width="${bw}" height="2" fill="#fff"/>`;
        o += `<text x="${x + bw / 2}" y="${y(v) - 4}" fill="#C9CDD4" font-size="9" text-anchor="middle">${fmt(v)}</text>`;
      });
    }
    o += `<text x="${pl + ci * gw + gw / 2}" y="${pt + ph + 16}" fill="#C9CDD4" text-anchor="middle" font-size="10.5">${esc(c)}</text>`;
  });
  o += `<line x1="${pl}" y1="${pt + ph}" x2="${pl + pw}" y2="${pt + ph}" stroke="#7E8591"/>`;
  let lx = pl; const ly = H - 16;
  series.forEach((s) => {
    o += `<g class="legend-item${s.hidden ? ' off' : ''}" data-name="${esc(s.name)}"><rect x="${lx - 4}" y="${ly - 9}" width="${13 + 6.5 * s.name.length + 10}" height="18" fill="transparent"/>` +
      `<circle cx="${lx + 4}" cy="${ly}" r="4" fill="${s.color}"/><text x="${lx + 13}" y="${ly}" fill="#C9CDD4" dominant-baseline="middle" font-size="10">${esc(s.name)}</text></g>`;
    lx += 13 + 6.5 * s.name.length + 22;
  });
  if (series.length > 1) o += `<text x="${W - pr}" y="${ly}" fill="#4C515B" font-size="9" text-anchor="end" dominant-baseline="middle">click a legend entry to hide / show it</text>`;
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
  if (row) { const idx = v.rows.indexOf(row); const tr = $('#sweepTable table') && $('#sweepTable table').rows[idx + 1]; if (tr) tr.classList.add('hot'); }
}

/* ---- help overlay & shortcuts ---- */
function toggleHelp(show) {
  const o = $('#helpOverlay');
  const vis = show === undefined ? o.hidden : show;
  o.hidden = !vis;
  if (vis) $('#btnHelpClose').focus(); else $('#btnHelp').blur();
}
function nudgeRate(delta) {
  const s = $('#speed');
  s.value = Math.max(Number(s.min), Math.min(Number(s.max), Number(s.value) + delta));
  s.dispatchEvent(new Event('input'));
  toast(`rate ${stepsPerSecond()} steps/s`);
}
function applyAnimSpeed() {
  // manual stepping gets the full animation; during playback it shortens with the rate so the array never lags
  const ms = state.playing ? Math.max(140, Math.min(650, Math.round(800 / stepsPerSecond()))) : 650;
  document.documentElement.style.setProperty('--anim-ms', ms + 'ms');
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
  $('#speed').addEventListener('input', () => { $('#speedOut').textContent = stepsPerSecond() + '/s'; applyAnimSpeed(); });
  $('#speedOut').textContent = stepsPerSecond() + '/s';
  applyAnimSpeed();

  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    const helpOpen = !$('#helpOverlay').hidden;
    if (e.key === 'Escape') {
      if (helpOpen) { e.preventDefault(); toggleHelp(false); return; }
      if (inField) { document.activeElement.blur(); return; }
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); toggleHelp(); return; }
    if (helpOpen) return;
    const n = e.shiftKey ? 10 : 1;
    if (e.key === ' ') { e.preventDefault(); $('#btnPlay').click(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlayback(); setStep(state.step + n); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlayback(); setStep(state.step - n); }
    else if (e.key === 'Home') { e.preventDefault(); $('#btnFirst').click(); }
    else if (e.key === 'End') { e.preventDefault(); $('#btnLast').click(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); nudgeRate(2); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeRate(-2); }
    else if (e.key === '/') { e.preventDefault(); $('#probeIn').focus(); $('#probeIn').select(); }
  });
  $('#btnHelp').addEventListener('click', () => toggleHelp());
  $('#btnHelpClose').addEventListener('click', () => toggleHelp(false));
  $('#helpOverlay').addEventListener('click', (e) => { if (e.target === $('#helpOverlay')) toggleHelp(false); });
  $('#chartOut').addEventListener('mousemove', chartHover);
  $('#chartOut').addEventListener('mouseleave', hideChartTip);
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
  $$('#ratePresets button').forEach((b) => b.addEventListener('click', () => { $('#speed').value = b.dataset.rate; $('#speed').dispatchEvent(new Event('input')); }));
  $('#speed').addEventListener('input', () => { $$('#ratePresets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === stepsPerSecond())); });
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
  $('#btnLoadPaste').addEventListener('click', () => {
    const t = $('#pasteArea').value;
    if (!t.trim()) { toast('nothing to load', true); return; }
    setTrace(t, 'pasted trace');
    $$('.preset').forEach((b) => b.classList.remove('active'));
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $('#pasteArea').value = rd.result.length > 200000 ? rd.result.slice(0, 200000) + '\n# (preview truncated; full file loaded)' : rd.result; setTrace(rd.result, f.name); $$('.preset').forEach((b) => b.classList.remove('active')); };
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
  $$('.deck .module').forEach((m, i) => m.style.setProperty('--i', i));
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
