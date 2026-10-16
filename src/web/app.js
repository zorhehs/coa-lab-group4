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

const STATUS_TEXT = { IDLE: 'Idle', BUSY: 'Simulating…', RUN: 'Playing', END: 'End of trace', ERROR: 'Error', SWEEP: 'Sweeping…' };
function setStatus(txt, led) {
  $('#statusTxt').textContent = STATUS_TEXT[txt] || txt;
  const el = $('#statusLed');
  el.className = 'led' + (led ? ' on-' + led : '') + (txt === 'RUN' ? ' blink' : '');
  $('#busyBar').hidden = !(txt === 'BUSY' || txt === 'SWEEP');
}

/* ------------------------------------------------------------------ */
/*  Configuration controls                                             */
/* ------------------------------------------------------------------ */
const fmtSize = (v) => (v >= 1024 ? (v / 1024) + ' KiB' : v + ' B');
const SIZE_OPTS = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].map((v) => [v, fmtSize(v)]);
const CONTROLS = [
  { group: 'Geometry' },
  { key: 'cache_size', label: 'Cache size', opts: SIZE_OPTS },
  { key: 'block_size', label: 'Block size', opts: [4, 8, 16, 32, 64, 128].map((v) => [v, v + ' bytes']) },
  { key: 'associativity', label: 'Mapping', opts: [[1, 'Direct mapped'], [2, '2-way set associative'], [4, '4-way set associative'], [8, '8-way set associative'], [16, '16-way set associative'], [0, 'Fully associative']] },
  { group: 'Policies' },
  { key: 'replacement', label: 'Replacement', opts: [['LRU', 'LRU (least recently used)'], ['FIFO', 'FIFO (oldest fill)'], ['RANDOM', 'Random']] },
  { key: 'write_policy', label: 'Write policy', opts: [['WB', 'Write-back'], ['WT', 'Write-through']] },
  { key: 'write_allocate', label: 'On write miss', opts: [[true, 'Write-allocate'], [false, 'No-write-allocate']] },
  { group: 'Address and extensions' },
  { key: 'address_bits', label: 'Address width', opts: [[16, '16 bits'], [24, '24 bits'], [32, '32 bits']] },
  { key: 'victim_entries', label: 'Victim cache', opts: [[0, 'Off'], [2, '2 entries'], [4, '4 entries'], [8, '8 entries']] },
];
const PRESETS = [
  ['textbook', 'Textbook (H&P): 32 B, 4 B lines, direct mapped', { cache_size: 32, block_size: 4, associativity: 1, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }],
  ['reference', 'Reference: 1 KiB, 16 B, 4-way LRU, write-back', { cache_size: 1024, block_size: 16, associativity: 4, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }],
  ['l1', 'L1-like: 32 KiB, 64 B, 8-way', { cache_size: 32768, block_size: 64, associativity: 8, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }],
  ['thrash', 'Thrash: 1 KiB direct mapped (try conflict.trace, then a victim cache)', { cache_size: 1024, block_size: 16, associativity: 1, replacement: 'LRU', write_policy: 'WB', write_allocate: true, victim_entries: 0 }],
];

function buildConfigControls() {
  const body = $('#configBody');
  body.innerHTML = '';
  const presetRow = document.createElement('label');
  presetRow.className = 'field';
  presetRow.innerHTML = `<span>Preset</span><select id="presetSel"><option value="">Custom</option>${PRESETS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}</select>`;
  body.appendChild(presetRow);
  $('#presetSel').addEventListener('change', (e) => {
    const p = PRESETS.find((x) => x[0] === e.target.value);
    if (!p) return;
    Object.assign(state.config, p[2]); syncConfigUI(); scheduleSimulate(); toast(p[1]);
  });
  for (const c of CONTROLS) {
    if (c.group) {
      const h = document.createElement('div'); h.className = 'group-title'; h.textContent = c.group; body.appendChild(h); continue;
    }
    const row = document.createElement('label');
    row.className = 'field';
    row.innerHTML = `<span>${c.label}</span><select data-key="${c.key}">${c.opts.map(([v, l]) => `<option value='${JSON.stringify(v)}'>${esc(l)}</option>`).join('')}</select>`;
    row.querySelector('select').addEventListener('change', (e) => { state.config[c.key] = JSON.parse(e.target.value); syncConfigUI(); scheduleSimulate(); });
    body.appendChild(row);
  }
  const th = document.createElement('div'); th.className = 'group-title'; th.textContent = 'Timing (cycles)'; body.appendChild(th);
  const timing = document.createElement('div');
  timing.innerHTML = `
      <label class="field"><span>Hit time</span><input id="hitTime" type="number" step="0.5" min="0"></label>
      <label class="field"><span>Miss penalty</span><input id="missPenalty" type="number" step="1" min="0"></label>
      <label class="field"><span>Random seed</span><input id="seed" type="number" step="1" min="0"></label>`;
  body.appendChild(timing);
  for (const [id, key] of [['#hitTime', 'hit_time'], ['#missPenalty', 'miss_penalty'], ['#seed', 'seed']]) {
    $(id).addEventListener('change', (e) => { state.config[key] = Number(e.target.value); scheduleSimulate(); });
  }
}

function syncConfigUI() {
  for (const c of CONTROLS) {
    if (c.group) continue;
    const sel = document.querySelector(`select[data-key="${c.key}"]`);
    if (sel) sel.value = JSON.stringify(state.config[c.key]);
  }
  const match = PRESETS.find(([, , p]) => Object.keys(p).every((k) => state.config[k] === p[k]));
  $('#presetSel').value = match ? match[0] : '';
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
  $('#btnPlay').innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>';
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
  $('#btnPlay').innerHTML = '<svg viewBox="0 0 16 16"><path d="M5 3v10l8-5z"/></svg>';
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
  const names = { MAP: 'Mapping', SIZE: 'Size', BLK: 'Block', SETS: 'Sets × ways', REPL: 'Replacement', WR: 'Write', VC: 'Victim cache' };
  $('#readoutStrip').innerHTML = chips.map(([k, v]) => `<span class="chip"><b>${names[k] || k}</b>${esc(v)}</span>`).join('');
}

function renderGeometry() {
  const g = geometry();
  const tagStoreBits = g.num_blocks * (g.tag_bits + 1 + (g.write_policy === 'WB' ? 1 : 0));
  const overhead = 100 * tagStoreBits / (g.cache_size * 8);
  const tagStore = tagStoreBits / 8;
  const rows = [
    ['Sets', g.num_sets], ['Ways', g.ways], ['Lines', g.num_blocks],
    ['Words per line', g.block_size / g.word_size],
    ['Tag / index / offset', `${g.tag_bits} / ${g.index_bits} / ${g.offset_bits} bits`],
    ['Tag store', `${tagStore >= 1024 ? (tagStore / 1024).toFixed(2) + ' KiB' : Math.round(tagStore) + ' B'} <small>${overhead.toFixed(1)} % overhead</small>`],
  ];
  $('#geoTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const total = g.address_bits;
  const pct = (b) => (100 * b / total).toFixed(2) + '%';
  $('#bitRuler').innerHTML =
    `<span class="tag" style="width:${pct(g.tag_bits)}">tag ${g.tag_bits}</span>` +
    (g.index_bits ? `<span class="idx" style="width:${pct(g.index_bits)}">index ${g.index_bits}</span>` : '') +
    `<span class="off" style="width:${pct(g.offset_bits)}">offset ${g.offset_bits}</span>`;
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
  return grp('tag', f.tag_binary, `Tag · ${f.tag_bits} bits`) +
    grp('idx', f.index_binary, f.index_bits ? `Index · ${f.index_bits} bits` : 'No index (fully associative)') +
    grp('off', f.offset_binary, `Offset · ${f.offset_bits} bits`);
}
function fieldsHTML(f, g) {
  return `
    <div class="field-box"><span>Tag</span><span class="lcd">${esc(f.tag_hex)}</span></div>
    <div class="field-box"><span>Index → set</span><span class="lcd blue">${f.index} of ${g.num_sets}</span></div>
    <div class="field-box"><span>Offset</span><span class="lcd green">${f.offset} (${hex(f.offset)})</span></div>
    <div class="field-box"><span>Block address</span><span class="lcd dimmed">${f.block_address}</span></div>`;
}

const decodeView = { badgeKey: '' };
function renderDecode() {
  const g = geometry();
  const e = currentEvent();
  const probeActive = state.probe && document.activeElement === $('#probeIn') && $('#probeIn').value.trim();
  let f = null, op = '·', badge = '', note = '';
  if (probeActive) {
    f = state.probe.fields; op = '?';
    note = `<b>Probe:</b> address decoded for the current geometry (not an access). Use Inject to append it to the trace.`;
  } else if (e) {
    f = e.fields; op = e.op;
    const mt = e.miss_type ? `<small>${e.miss_type}</small>` : '';
    badge = `<div class="result-badge ${e.result}">${e.result === 'VICTIM' ? 'Victim hit' : (e.result === 'HIT' ? 'Hit' : 'Miss')}${mt}</div>`;
    note = `<b>Set ${e.set_index}${e.way === null ? '' : `, way ${e.way}`}:</b> ${esc(e.note)}`;
    if (isEndSummary()) note = `<b>End: access ${state.traceCount} of ${state.traceCount}</b> (stepping covers the first ${state.sim.events.length}; statistics show whole-trace totals). ` + note;
  } else if (state.sim) {
    note = `Press play or step forward. Each step is one memory access from the trace.`;
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
  let note = 'Memory bus idle';
  if (e) {
    const parts = [];
    const bs = state.sim ? state.sim.config.block_size : 0;
    if (e.mem_read) parts.push(`fetch ${bs} B`);
    if (e.writeback) parts.push(`write back ${bs} B`);
    else if (e.mem_write) parts.push(`write ${state.sim ? state.sim.config.word_size : 4} B`);
    if (e.result === 'VICTIM') parts.push('swap with victim cache');
    note = parts.length ? parts.join(' · ') : 'No memory traffic';
  }
  $('#busNote').textContent = note;
}

/* ---- trace timeline (top strip) ---- */
const traceView = { sim: null, base: null, w: 0, h: 15 };
function buildTraceBase() {
  const strip = $('#traceStrip');
  const w = Math.max(1, Math.floor(strip.clientWidth)), h = traceView.h, dpr = window.devicePixelRatio || 1;
  const base = document.createElement('canvas');
  base.width = Math.floor(w * dpr); base.height = Math.floor(h * dpr);
  const ctx = base.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#F3F4F6'; ctx.fillRect(0, 0, w, h);
  const evs = state.sim.events, n = evs.length;
  if (n) {
    const colors = { HIT: '#2DA44E', MISS: '#CF222E', VICTIM: '#0969DA' };
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
    strip.classList.add('empty'); cur.hidden = true; lab.textContent = 'No trace loaded';
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
  ctx.fillStyle = 'rgba(243,244,246,.72)';
  ctx.fillRect(Math.floor(x * dpr), 0, cv.width - Math.floor(x * dpr), cv.height);   // dim what has not run yet
  cur.hidden = false; cur.style.left = Math.max(0, Math.min(w - 2, x)) + 'px';
  const extra = state.sim.truncated ? ` · +${state.traceCount - n} more` : '';
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
  const w = Math.max(1, Math.floor(cv.clientWidth)), h = 48;
  if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.sim || !state.sim.events.length) { val.textContent = '—'; return; }
  if (sparkView.sim !== state.sim) { sparkView.pts = state.sim.events.map((e) => e.stats_after.hit_ratio); sparkView.sim = state.sim; }
  const pts = sparkView.pts, n = pts.length;
  const X = (i) => 3 + (w - 6) * i / Math.max(1, n - 1), Y = (v) => 4 + (h - 8) * (1 - v);
  for (const g of [0.25, 0.5, 0.75]) { ctx.strokeStyle = 'rgba(0,0,0,.06)'; ctx.beginPath(); ctx.moveTo(3, Y(g)); ctx.lineTo(w - 3, Y(g)); ctx.stroke(); }
  const done = Math.min(state.step, n);
  const line = (from, to, color, width) => {
    if (to - from < 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = from; i < to; i++) { if (i === from) ctx.moveTo(X(i), Y(pts[i])); else ctx.lineTo(X(i), Y(pts[i])); }
    ctx.stroke();
  };
  line(0, n, 'rgba(26,127,55,.22)', 1);                        // whole trace, faint
  if (done > 1) {
    ctx.fillStyle = 'rgba(26,127,55,.12)'; ctx.beginPath(); ctx.moveTo(X(0), h - 4);
    for (let i = 0; i < done; i++) ctx.lineTo(X(i), Y(pts[i]));
    ctx.lineTo(X(done - 1), h - 4); ctx.closePath(); ctx.fill();
  }
  line(0, done, '#1A7F37', 1.5);
  if (done > 0) {
    const cx = X(done - 1), cy = Y(pts[done - 1]);
    ctx.fillStyle = '#0969DA'; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  val.textContent = done > 0 ? pts[done - 1].toFixed(3) : '—';
}

const arrayView = { sim: null, rowsKey: '', lastStep: -1 };
function renderArray() {
  const out = $('#arrayOut');
  if (!state.sim) {
    out.innerHTML = `<div class="array-empty">${EMPTY_ARRAY_SVG}<span>Load a trace to populate the array</span><span>Pick a preset, generate a pattern, or paste a trace in the sidebar.</span></div>`;
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
    heat.innerHTML = `<span class="heat-title">Set activity map: ${g.num_sets} sets, one square per set. The detail window below shows sets ${start}–${start + 7}.</span>` +
      state.heat.map((h, i) => `<i class="${h}${i === curSet ? ' cur' : ''}" title="set ${i}"></i>`).join('');
  }
  const rowsKey = `${rows[0]}:${rows.length}:${g.ways}`;
  if (arrayView.sim !== state.sim || arrayView.rowsKey !== rowsKey) {
    out.innerHTML = (g.num_sets > FULL_GRID_MAX_SETS ? `<div class="window-note">Detail window: sets ${rows[0]}–${rows[rows.length - 1]} of ${g.num_sets}</div>` : '') +
      rows.map((s) => `<div class="set-row" data-set="${s}"><span class="set-label">set ${s}</span>${state.grid[s].map((line, w) => cellHTML(line, g.ways, w)).join('')}</div>`).join('');
    arrayView.sim = state.sim; arrayView.rowsKey = rowsKey;
    const wh = $('#wayHead');
    wh.hidden = false;
    wh.innerHTML = '<span class="set-label"></span>' + Array.from({ length: g.ways }, (_, w) => `<span class="way">way ${w}</span>`).join('');
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
      cells.push(v ? `<div class="cell"><span class="d${v.dirty ? ' on' : ''}"></span><span class="tagv">blk ${hex(v.block)}</span></div>`
        : `<div class="cell empty"><span class="d"></span><span class="tagv">— —</span></div>`);
    }
    vc.innerHTML = `<span class="set-label">Victim cache (${g.victim_entries} entries, FIFO)</span>${cells.join('')}`;
  } else vc.hidden = true;
}

/* ---- counters ---- */
const COUNTER_ITEMS = [
  ['accesses', 'Accesses', ''], ['hits', 'Hits', 'green'], ['misses', 'Misses', 'red'],
  ['reads', 'Reads', 'blue'], ['writes', 'Writes', 'violet'],
  ['read_misses', 'Read misses', ''], ['write_misses', 'Write misses', ''],
  ['compulsory', 'Compulsory', 'amber'], ['capacity', 'Capacity', 'violet'], ['conflict', 'Conflict', 'red'],
  ['victim_hits', 'Victim hits', 'blue'], ['writebacks', 'Write-backs', 'amber'],
  ['mem_reads', 'Memory reads', ''], ['mem_writes', 'Memory writes', ''],
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
    `<div class="ctr"><span class="lbl">Memory traffic</span><span class="val">${s ? s.traffic_kib.toFixed(2) : '0.00'} KiB</span></div>`;
  $('#countersSub').textContent = isEndSummary() ? 'whole trace' : (state.sim ? `after step ${state.step}` : 'at current step');
  renderSpark();
}

/* ---- log ---- */
let logBuiltFor = null;
function renderLog() {
  const out = $('#logOut');
  if (!state.sim) { out.innerHTML = '<div class="log-empty">No trace loaded.</div>'; $('#logSub').textContent = ''; logBuiltFor = null; return; }
  const evs = state.sim.events;
  if (logBuiltFor !== state.sim) {
    logBuiltFor = state.sim;
    const rows = evs.map((e, i) => {
      const mt = e.miss_type ? `<small>${e.miss_type}</small>` : '';
      return `<div class="log-row" data-i="${i + 1}"><span>${i + 1}</span><span class="op ${e.op}">${e.op}</span><span>${e.fields.hex}</span><span>${e.set_index}</span><span>${e.way === null ? '—' : e.way}</span><span class="r ${e.result}">${e.result === 'VICTIM' ? 'Victim' : (e.result === 'HIT' ? 'Hit' : 'Miss')}${mt}</span></div>`;
    });
    if (state.sim.truncated) rows.push(`<div class="log-more">… ${state.traceCount - evs.length} more accesses (run to the end for whole-trace totals)</div>`);
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
  if (cur) revealIn(out, cur, !(state.playing && stepsPerSecond() > 10));
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
  const sel = $('#genKinds');
  sel.innerHTML = kinds.map((k) => `<option value="${k}">${k}</option>`).join('');
  const pick = (k) => {
    sel.value = k;
    const params = state.meta.generators[k];
    $('#genForm').innerHTML = Object.entries(params).map(([p, v]) => {
      if (p === 'order') return `<label><span>${p}</span><select data-param="order"><option value="row">row-major</option><option value="col">column-major</option></select></label>`;
      return `<label><span>${p.replace(/_/g, ' ')}</span><input data-param="${p}" type="number" step="${typeof v === 'number' && !Number.isInteger(v) ? '0.05' : '1'}" value="${v}"></label>`;
    }).join('');
    $('#genForm').dataset.kind = k;
  };
  sel.addEventListener('change', () => pick(sel.value));
  pick(kinds.includes('loop') ? 'loop' : kinds[0]);
  $('#btnGenerate').addEventListener('click', async () => {
    const kind = $('#genForm').dataset.kind;
    const params = {};
    $('#genForm').querySelectorAll('input[data-param]').forEach((i) => { params[i.dataset.param] = Number(i.value); });
    const ord = $('#genForm').querySelector('select[data-param="order"]');
    if (ord) params.order = ord.value;
    try {
      const r = await api('/api/generate', { kind, params });
      setTrace(r.text, `generated ${kind} (${r.count})`);
      $$('.preset').forEach((b) => b.classList.remove('active'));
      toast(`Generated ${r.count} accesses`);
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
  if (!v) { toast('Type an address in the probe field first', true); return; }
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
  toast(`${op === 'R' ? 'Read' : 'Write'} of ${hex(addr)} appended to the trace`);
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
const COLORS = ['#0969DA', '#1A7F37', '#BC4C00', '#CF222E', '#8250DF', '#0E8A8A', '#9A6700'];
const CHART = { font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif', title: '#1F2328', sub: '#59636E', grid: '#E9EBEF', axis: '#8B949E', text: '#1F2328', muted: '#8B949E', onBar: '#FFFFFF' };

function buildExperimentControls() {
  const fill = (el, items, cur, onpick) => {
    el.innerHTML = items.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    el.value = cur;
    el.addEventListener('change', () => onpick(el.value));
  };
  const sweepable = state.meta.sweepable || {};
  const params = Object.entries(SWEEP_LABELS).map(([k, l]) => [k, sweepable[k] || l]);
  fill($('#sweepParam'), params, state.sweepParam, (v) => { state.sweepParam = v; });
  fill($('#sweepSeries'), [['', 'None']].concat(params), state.sweepSeries, (v) => { state.sweepSeries = v; });
  const metrics = state.meta.metrics || {};
  fill($('#sweepMetric'), Object.entries(METRIC_LABELS).map(([k, l]) => [k, metrics[k] || (k === 'misstypes' ? 'Misses by type' : l)]), state.sweepMetric, (v) => { state.sweepMetric = v; if (state.sweep) renderSweep(); });
}

async function runSweep() {
  if (!state.traceText.trim()) { toast('Load a trace first', true); return; }
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
    toast(`Sweep done: ${r.rows.length} configurations`);
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
      name: k, color: ['#BF8700', '#8250DF', '#CF222E'][i],
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
  const head = `<tr><th>Series</th><th>${SWEEP_LABELS[sw.param]}</th><th>Sets × ways</th>${cols.map((c) => `<th>${c.replace(/_/g, ' ')}</th>`).join('')}</tr>`;
  const body = sw.rows.map((r) => {
    if (r.error) return `<tr><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td class="err" colspan="${cols.length + 1}">${esc(r.error)}</td></tr>`;
    return `<tr><td>${esc(r.series || '—')}</td><td>${esc(r.label)}</td><td>${r.geometry.num_sets}×${r.geometry.ways}</td>${cols.map((c) => { const v = r.stats[c]; return `<td>${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(c === 'amat' || c === 'traffic_kib' ? 2 : 4) : v}</td>`; }).join('')}</tr>`;
  }).join('');
  $('#sweepTable').innerHTML = `<table>${head}${body}</table>`;
}

async function compareTraces() {
  const names = $$('.preset').map((b) => b.dataset.name);
  if (!names.length) { toast('No preset traces', true); return; }
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
  let o = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family='${CHART.font}' font-size="11">`;
  o += `<text x="${pl}" y="22" fill="${CHART.title}" font-size="13" font-weight="600">${esc(title)}</text>`;
  o += `<text x="${pl}" y="38" fill="${CHART.sub}" font-size="10">${esc(subtitle)}</text>`;
  for (let i = 0; i <= 5; i++) {
    const yy = pt + ph - ph * i / 5, val = top * i / 5;
    o += `<line x1="${pl}" y1="${yy}" x2="${pl + pw}" y2="${yy}" stroke="${CHART.grid}"/>`;
    o += `<text x="${pl - 8}" y="${yy}" fill="${CHART.muted}" text-anchor="end" dominant-baseline="middle" font-size="10">${top > 1 ? +val.toFixed(2) : val.toFixed(2)}</text>`;
  }
  o += `<text x="14" y="${pt + ph / 2}" fill="${CHART.sub}" font-size="10" transform="rotate(-90 14 ${pt + ph / 2})" text-anchor="middle">${esc(ylabel)}</text>`;
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
        if (v > 0 && y0 - y1 > 12) o += `<text x="${gx + gw * 0.35}" y="${(y0 + y1) / 2}" fill="${CHART.onBar}" font-size="9.5" font-weight="600" text-anchor="middle" dominant-baseline="middle">${fmt(v)}</text>`;
        acc += v;
      });
      o += `<text x="${gx + gw * 0.35}" y="${y(acc) - 4}" fill="${CHART.text}" font-size="9.5" text-anchor="middle">${fmt(acc)}</text>`;
    } else {
      shown.forEach((s) => {
        const si = series.indexOf(s), v = s.values[ci];
        const x = gx + shown.indexOf(s) * (bw + 3);
        if (v === null || v === undefined) { o += `<text x="${x + bw / 2}" y="${pt + ph - 6}" fill="${CHART.muted}" font-size="9" text-anchor="middle">n/a</text>`; return; }
        o += `<rect class="bar" data-ci="${ci}" data-si="${si}" x="${x}" y="${Math.min(y(v), pt + ph - 2)}" width="${bw}" height="${Math.max(2, pt + ph - y(v))}" fill="${s.color}" opacity=".9"/>`;
        o += `<text x="${x + bw / 2}" y="${y(v) - 4}" fill="${CHART.text}" font-size="9" text-anchor="middle">${fmt(v)}</text>`;
      });
    }
    o += `<text x="${pl + ci * gw + gw / 2}" y="${pt + ph + 16}" fill="${CHART.text}" text-anchor="middle" font-size="10.5">${esc(c)}</text>`;
  });
  o += `<line x1="${pl}" y1="${pt + ph}" x2="${pl + pw}" y2="${pt + ph}" stroke="${CHART.axis}"/>`;
  let lx = pl; const ly = H - 16;
  series.forEach((s) => {
    o += `<g class="legend-item${s.hidden ? ' off' : ''}" data-name="${esc(s.name)}"><rect x="${lx - 4}" y="${ly - 9}" width="${13 + 6.5 * s.name.length + 10}" height="18" fill="transparent"/>` +
      `<rect x="${lx}" y="${ly - 4}" width="9" height="9" rx="2" fill="${s.color}"/><text x="${lx + 14}" y="${ly}" fill="${CHART.text}" dominant-baseline="middle" font-size="10.5">${esc(s.name)}</text></g>`;
    lx += 13 + 6.5 * s.name.length + 22;
  });
  if (series.length > 1) o += `<text x="${W - pr}" y="${ly}" fill="${CHART.muted}" font-size="9.5" text-anchor="end" dominant-baseline="middle">Click a legend entry to hide or show it</text>`;
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
      `<div class="row"><span>Hit ratio</span><span class="val">${st.hit_ratio.toFixed(3)}</span></div>` +
      `<div class="row"><span>AMAT</span><span class="val">${st.amat.toFixed(2)} cycles</span></div>` +
      `<div class="row"><span>Compulsory / capacity / conflict</span><span class="val">${st.compulsory} / ${st.capacity} / ${st.conflict}</span></div>` +
      (row.geometry ? `<div class="row"><span>Sets × ways</span><span class="val">${row.geometry.num_sets} × ${row.geometry.ways}</span></div>` : '');
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
  toast(`Rate: ${stepsPerSecond()} steps per second`);
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
  new ResizeObserver(() => { renderTraceStrip(); renderSpark(); }).observe(strip);
  // main tabs (Simulation / Experiments)
  $('#mainTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    $$('#mainTabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    $$('.main-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === 'sim') { renderArray(); }
  });
  // bottom panel
  $('#btnLogToggle').addEventListener('click', () => {
    const p = $('#bottomPanel'); p.classList.toggle('collapsed');
    $('#btnLogToggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
  });
  $('#logFilter').addEventListener('input', applyLogFilter);

  $('#traceTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    $$('#traceTabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    $$('#modTrace .tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  });
  $('#btnLoadPaste').addEventListener('click', () => {
    const t = $('#pasteArea').value;
    if (!t.trim()) { toast('Nothing to load', true); return; }
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
    try { await navigator.clipboard.writeText(cliEquivalent()); toast('Command copied'); } catch (e) { toast('Clipboard unavailable', true); }
  });

  $('#btnSweep').addEventListener('click', runSweep);
  $('#btnCompareTraces').addEventListener('click', compareTraces);
  $('#btnExportCsv').addEventListener('click', exportCsv);
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
  $('#footVersion').textContent = 'CACHE-SIM ' + state.meta.version;
  buildConfigControls();
  syncConfigUI();
  buildGenerator();
  buildExperimentControls();
  $('#chartOut').innerHTML = `<div class="chart-empty"><svg viewBox="0 0 54 36" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 32h46M4 32V4"/><rect x="10" y="18" width="7" height="14"/><rect x="22" y="10" width="7" height="22"/><rect x="34" y="22" width="7" height="10"/><rect x="46" y="6" width="4" height="26" stroke-dasharray="2 2"/></svg><span>No sweep yet. Choose an axis and a metric, then run the sweep.</span></div>`;
  wire();
  renderGeometryOnly();
  renderArray();
  renderCounters();
  const traces = await loadPresets();
  const first = traces.find((t) => t.name === 'loop.trace') || traces[0];
  if (first) await loadPreset(first.name);
  else { setStatus('IDLE'); toast('No traces in data/. Generate one or paste a trace.'); }
}

init();
