/* Two-column IEEE-style paginator for build/report.html (inlined by scripts/build_docs.py).
 *
 * The source blocks live in #src (header, h2/h3, p, lists, pre, figure, .tblwrap).  They are
 * flowed into fixed-size .page boxes: a page is a vertical stack of "rows", each either a
 * full-width block (header, figure.wide, .tblwrap.wide) or a two-column row.  Paragraphs are
 * split at line boundaries, headings are kept with the following lines, two-column rows that
 * end a text run (before a wide block or at the end) are balanced, and a wide block that does
 * not fit floats to the top of the next page while the text keeps flowing.
 * CSS multicol with column-span was tried first; Chrome's pagination of it overflows.
 */
'use strict';
window.__paginated = new Promise((resolve, reject) => {
  window.addEventListener('load', async () => {
    try {
      if (document.fonts) await document.fonts.ready;
      resolve(paginate());
    } catch (e) { console.error('paginate failed: ' + (e.stack || e)); reject(e); }
  });
});

function paginate() {
  const MM = 96 / 25.4;
  const PAGE_W = 176.98 * MM, PAGE_H = 256.36 * MM;   // A4 minus 0.65in sides, 0.75in top, 0.85in bottom
  const GAP = 0.2 * 96;
  const COL_W = (PAGE_W - GAP) / 2;
  const src = document.getElementById('src');
  const out = document.getElementById('pages');
  // flatten: abstract paragraphs become blocks of their own
  const blocks = [];
  for (const el of Array.from(src.children)) {
    if (el.classList.contains('abstract')) {
      for (const c of Array.from(el.children)) { c.classList.add('abs'); blocks.push(c); }
    } else blocks.push(el);
  }
  const isWide = (b) => b.tagName === 'HEADER' || b.classList.contains('wide');
  const isHeading = (b) => b.tagName === 'H2' || b.tagName === 'H3';
  const lineH = parseFloat(getComputedStyle(document.body).lineHeight) || 12;
  const stats = { pages: 0, splits: 0, deferred: 0 };

  let page = null, rows = null, y = 0, row = null, col = null, colIdx = 0, rowBlocks = [], deferred = [];

  const newPage = () => {
    page = document.createElement('div'); page.className = 'page';
    page.style.width = PAGE_W + 'px'; page.style.height = PAGE_H + 'px';
    out.appendChild(page); stats.pages++; y = 0; row = null; col = null;
    // floated wide blocks go first
    const keep = [];
    for (const b of deferred) {
      if (!placeWide(b, true)) keep.push(b);
    }
    deferred = keep;
  };
  const measureWide = (b) => { page.appendChild(b); const h = b.getBoundingClientRect().height; page.removeChild(b); return h; };
  const placeWide = (b, force) => {
    const h = measureWide(b);
    if (y + h > PAGE_H + 0.5 && !force) return false;
    if (y + h > PAGE_H + 0.5 && y > 0) return false;
    page.appendChild(b); y += h; return true;
  };
  const newRow = (height) => {
    row = document.createElement('div'); row.className = 'row'; row.style.height = height + 'px';
    for (let i = 0; i < 2; i++) { const c = document.createElement('div'); c.className = 'col'; c.style.width = COL_W + 'px'; row.appendChild(c); }
    page.appendChild(row); colIdx = 0; col = row.children[0]; rowBlocks = [];
  };
  const used = (c) => c.lastElementChild ? c.lastElementChild.getBoundingClientRect().bottom - c.getBoundingClientRect().top : 0;
  const fits = (c) => used(c) <= c.clientHeight + 0.5;
  const remaining = (c) => c.clientHeight - used(c);

  const nextCol = () => {
    if (colIdx === 0) { colIdx = 1; col = row.children[1]; return true; }
    return false;
  };

  // split paragraph p (already appended to col, overflowing) at the last line that fits; returns the tail paragraph or null
  const splitParagraph = (p, c) => {
    const limit = c.getBoundingClientRect().top + c.clientHeight - parseFloat(getComputedStyle(p).paddingBottom);
    const range = document.createRange(); range.selectNodeContents(p);
    const lines = [];
    for (const r of range.getClientRects()) {
      const key = Math.round(r.top);
      let L = lines.find((l) => Math.abs(l.top - key) < 2);
      if (!L) { L = { top: r.top, bottom: r.bottom, left: r.left }; lines.push(L); }
      else { L.bottom = Math.max(L.bottom, r.bottom); L.left = Math.min(L.left, r.left); }
    }
    lines.sort((a, b) => a.top - b.top);
    const idx = lines.findIndex((l) => l.bottom > limit + 0.5);
    if (idx <= 0) return null;                        // nothing fits, or everything fits
    const line = lines[idx];
    const caret = document.caretRangeFromPoint(line.left + 1, line.top + Math.min(4, (line.bottom - line.top) / 2));
    if (!caret || !p.contains(caret.startContainer)) return null;
    const tail = document.createRange(); tail.setStart(caret.startContainer, caret.startOffset); tail.setEndAfter(p.lastChild);
    const frag = tail.extractContents();
    const p2 = p.cloneNode(false); p2.classList.add('cont'); p2.appendChild(frag);
    stats.splits++;
    return p2;
  };

  const placeBlock = (b) => {
    for (let guard = 0; ; guard++) {
      if (guard > 50) throw new Error('block cannot be placed: ' + b.tagName + ' ' + b.textContent.slice(0, 60));
      if (!row) {
        if (y > PAGE_H - 3 * lineH) newPage();
        if (!row) newRow(PAGE_H - y);
      }
      col.appendChild(b); rowBlocks.push(b);
      if (fits(col)) {
        if (isHeading(b) && remaining(col) < 2.2 * lineH) {   // keep heading with its text
          col.removeChild(b); rowBlocks.pop();
        } else return;
      } else {
        col.removeChild(b); rowBlocks.pop();
        if (b.tagName === 'P') {
          col.appendChild(b); rowBlocks.push(b);
          const tail = splitParagraph(b, col);
          if (tail && fits(col)) { b = tail; }               // continue with the tail in the next column
          else if (tail) { /* still overflowing: undo */ b.append(...Array.from(tail.childNodes)); col.removeChild(b); rowBlocks.pop(); }
          else { if (b.parentNode) { col.removeChild(b); rowBlocks.pop(); } }
        }
      }
      if (!nextCol()) { finishRow(false); newPage(); }
    }
  };

  // balance the current row if it ends a text run and is not full; then close it
  const finishRow = (balance) => {
    if (!row) return;
    const [a, c] = row.children;
    if (balance) {
      const total = used(a) + used(c);
      let target = Math.ceil(total / 2) + lineH;
      const saved = rowBlocks.slice();
      const texts = saved.map((b) => b.cloneNode(true));
      // tails created by splitting are already in rowBlocks; rebuild from the row's original blocks by re-joining 'cont' tails
      const originals = [];
      for (const b of saved) {
        if (b.classList.contains('cont') && originals.length && originals[originals.length - 1].tagName === 'P') {
          originals[originals.length - 1].append(' ', ...Array.from(b.cloneNode(true).childNodes));
        } else originals.push(b.cloneNode(true));
      }
      const avail = parseFloat(row.style.height) || target;
      for (let attempt = 0; attempt < 400; attempt++) {
        if (target > avail) target = avail;
        a.innerHTML = ''; c.innerHTML = ''; row.style.height = target + 'px';
        colIdx = 0; col = a; rowBlocks = [];
        let ok = true;
        for (const b0 of originals) {
          let b = b0.cloneNode(true);
          let placed = false;
          while (!placed) {
            col.appendChild(b); rowBlocks.push(b);
            if (fits(col) && !(isHeading(b) && remaining(col) < 2.2 * lineH)) { placed = true; break; }
            col.removeChild(b); rowBlocks.pop();
            if (b.tagName === 'P') {
              col.appendChild(b); rowBlocks.push(b);
              const tail = splitParagraph(b, col);
              if (tail && fits(col)) b = tail; else { if (tail) b.append(...Array.from(tail.childNodes)); col.removeChild(b); rowBlocks.pop(); }
            }
            if (colIdx === 0) { colIdx = 1; col = c; } else { ok = false; break; }
          }
          if (!ok) break;
        }
        if (ok || target >= avail) break;
        target += lineH;
      }
      row.style.height = Math.max(used(a), used(c)) + 'px';
    }
    y += row.getBoundingClientRect().height;
    row = null; col = null; rowBlocks = [];
  };

  newPage();
  for (const b of blocks) {
    if (isWide(b)) {
      if (b.tagName === 'HEADER') { placeWide(b, true); continue; }
      const h = measureWide(b);
      if (row) {
        const [a, c] = row.children;
        const projected = y + Math.ceil((used(a) + used(c)) / 2) + 2 * lineH + h;
        if (projected <= PAGE_H) { finishRow(true); if (!placeWide(b, true)) { deferred.push(b); stats.deferred++; } continue; }
        deferred.push(b); stats.deferred++; continue;                     // float to next page, keep flowing text
      }
      if (!placeWide(b, false)) { deferred.push(b); stats.deferred++; }
      continue;
    }
    placeBlock(b);
  }
  finishRow(true);
  while (deferred.length) newPage();
  src.remove();
  console.log('paginated', JSON.stringify(stats));
  return stats;
}
