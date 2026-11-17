#!/usr/bin/env node
/* Headless-Chrome helper for building the submission documents (docs only;
 * the simulator itself needs nothing but Python).
 *
 *   node scripts/chrome_tools.js jobs.json
 *
 * jobs.json is a list of jobs, run in one Chrome session:
 *   {"type": "svg2png", "src": "results/fig1.svg", "out": "build/png/fig1.png", "scale": 2}
 *   {"type": "shots",   "outdir": "build/shots"}            GUI screenshots (starts the simulator server itself)
 *   {"type": "pdf",     "html": "build/report.html", "out": "docs/report.pdf", "footer": "text"}
 *
 * Requires Google Chrome and Node 22+ (built-in fetch and WebSocket).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
const DEBUG_PORT = 9333;
const GUI_PORT = 8099;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file://' + path.resolve(ROOT, p);

async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return await r.text(); } catch (e) { /* retry */ }
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + url);
}

/* ---- minimal Chrome DevTools Protocol client ---------------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) c.listeners.forEach((l) => l(m));
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method) { return new Promise((res) => { const l = (m) => { if (m.method === method) { this.listeners = this.listeners.filter((x) => x !== l); res(m.params); } }; this.listeners.push(l); }); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page script failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url) { const loaded = this.once('Page.loadEventFired'); await this.send('Page.navigate', { url }); await loaded; }
  async viewport(w, h, scale) { await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false }); }
  async shot(out, clip) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: clip ? { ...clip, scale: 1 } : undefined });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log('wrote ' + path.relative(ROOT, out));
  }
}

/* ---- jobs ---------------------------------------------------------------- */
async function svg2png(cdp, job) {
  const svg = fs.readFileSync(path.resolve(ROOT, job.src), 'utf8');
  const w = Number((svg.match(/\bwidth="(\d+)/) || [])[1] || 800);
  const h = Number((svg.match(/\bheight="(\d+)/) || [])[1] || 400);
  await cdp.viewport(w, h, job.scale || 2);
  await cdp.goto(fileUrl(job.src));
  await sleep(200);
  await cdp.shot(path.resolve(ROOT, job.out));
}

const SCENES = {
  // the "hero" shot used in README and report: thrashing trace rescued by a 2-entry victim cache
  gui_full: `state.config.cache_size = 1024; state.config.block_size = 16; state.config.associativity = 1;
             state.config.victim_entries = 2; syncConfigUI();
             state.sim = null; await loadPreset('conflict.trace'); await waitSim(); setStep(7); stopPlayback();`,
  // reference configuration with the worked example 0x1A3C probed in the ADDRESS DECODE module
  gui_decode: `state.config.cache_size = 1024; state.config.block_size = 16; state.config.associativity = 4;
               state.config.victim_entries = 0; syncConfigUI();
               state.sim = null; await loadPreset('loop.trace'); await waitSim(); setStep(0);
               const i = $('#probeIn'); i.focus(); i.value = '0x1A3C'; await probe(); renderDecode();`,
  // Hennessy & Patterson direct-mapped example at its last step (word 18 evicts 26 from set 2)
  gui_textbook: `state.config.cache_size = 32; state.config.block_size = 4; state.config.associativity = 1;
                 state.config.victim_entries = 0; syncConfigUI();
                 state.sim = null; await loadPreset('textbook_dm.trace'); await waitSim(); setStep(8); stopPlayback();`,
};
const PRELUDE = `const waitSim = async () => { const t0 = Date.now(); while (!state.sim && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 40)); if (!state.sim) throw new Error('simulate timed out'); };
                 const t1 = Date.now(); while (!(typeof state !== 'undefined' && state.meta && state.sim)) { if (Date.now() - t1 > 15000) throw new Error('GUI did not initialise'); await new Promise(r => setTimeout(r, 40)); }`;

async function shots(cdp, job) {
  const outdir = path.resolve(ROOT, job.outdir);
  const server = spawn('python3', ['-m', 'cachesim', 'serve', '--no-browser', '--port', String(GUI_PORT)],
    { cwd: ROOT, env: { ...process.env, PYTHONPATH: 'src' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    await waitHttp(`http://127.0.0.1:${GUI_PORT}/api/meta`, 15000);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const [name, script] of Object.entries(SCENES)) {
      await cdp.viewport(1600, 1000, 2);
      await cdp.goto(`http://127.0.0.1:${GUI_PORT}/`);
      await cdp.eval(`(async () => { ${PRELUDE} ${script} await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`);
      await cdp.shot(path.join(outdir, name + '.png'));
      if (name === 'gui_decode') {
        const rect = await cdp.eval(`(() => { const r = document.querySelector('#modDecode').getBoundingClientRect(); return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 }; })()`);
        await cdp.shot(path.join(outdir, name + '_crop.png'), rect);
      }
    }
  } finally {
    server.kill('SIGINT');
  }
}

async function pdf(cdp, job) {
  await cdp.goto(fileUrl(job.html));
  await cdp.eval('(async () => { if (document.fonts) await document.fonts.ready; if (window.__paginated) await Promise.race([window.__paginated, new Promise((_, rej) => setTimeout(() => rej(new Error("pagination timed out")), 30000))]); return "ok"; })()');
  await sleep(300);
  const foot = (job.footer || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const r = await cdp.send('Page.printToPDF', {
    paperWidth: 8.27, paperHeight: 11.69,          // A4 in inches
    marginTop: (job.margins || {}).top ?? 0.75, marginBottom: (job.margins || {}).bottom ?? 0.8,
    marginLeft: (job.margins || {}).left ?? 0.75, marginRight: (job.margins || {}).right ?? 0.75,
    printBackground: true, preferCSSPageSize: false, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font-family:Menlo,monospace;font-size:7.5pt;color:#7E8591;padding:0 0.65in;display:flex;justify-content:space-between;">
                       <span>${foot}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
  const out = path.resolve(ROOT, job.out);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  const pages = (fs.readFileSync(out, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`wrote ${path.relative(ROOT, out)} (${pages} pages)`);
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found; set CHROME=/path/to/chrome');
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cachesim-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--allow-file-access-from-files', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20000);
    const targets = JSON.parse(await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 5000));
    const page = targets.find((t) => t.type === 'page');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.listeners.push((m) => {
      if (m.method === 'Runtime.consoleAPICalled') console.log('[page]', m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') console.log('[page error]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    for (const job of jobs) {
      if (job.type === 'svg2png') await svg2png(cdp, job);
      else if (job.type === 'shots') await shots(cdp, job);
      else if (job.type === 'pdf') await pdf(cdp, job);
      else throw new Error('unknown job type ' + job.type);
    }
  } finally {
    if (cdp) cdp.ws.close();
    chrome.kill('SIGKILL');
    // Chrome may still be flushing its profile as it exits: retry, and never fail the build over a temp folder
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (e) { /* left for the OS temp cleaner */ }
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
