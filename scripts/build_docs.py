#!/usr/bin/env python3
"""Build the submission documents for COA Lab project P07 (Group 04).

    uv run --with python-pptx scripts/build_docs.py all      # screenshots, figures, report.pdf, slides.pptx
    uv run --with python-pptx scripts/build_docs.py report   # docs/report.md  -> docs/report.pdf
    uv run --with python-pptx scripts/build_docs.py slides   # build/*        -> docs/slides.pptx
    python3 scripts/build_docs.py figures                     # SVG figures -> build/png (Chrome only)
    python3 scripts/build_docs.py shots                       # GUI screenshots -> build/shots, docs/screenshot_*.{jpg,png}

The simulator itself needs only the Python standard library.  This build script is a
docs-only tool chain: Google Chrome (rasterising, PDF printing), Node 22+ (Chrome
automation, scripts/chrome_tools.js) and python-pptx (slides only).
"""
from __future__ import annotations

import glob
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DOCS = ROOT / "docs"
RESULTS = ROOT / "results"

# GUI colour tokens (src/web/style.css) so the documents match the instrument theme
C = dict(bg="111216", panel="181A1E", panel2="141619", panel3="1E2126", bezel="24272D", bezel_hi="2C3037",
         text="D3D6DC", muted="868C97", dim="5A5F69", amber="62CFC9", amber_dim="2F6B68", green="8FCB7A",
         red="E06558", blue="6A9BE0", violet="A796DB", lcd="0A0B0D", white="F1F2F4")

FOOTER = "COA Lab P07 · Configurable Cache Memory Simulator · Group 04 (Aliyan Zulfiqar, Shehroz Riaz)"


def run(cmd, **kw):
    print("$", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, cwd=ROOT, **kw)


def chrome_jobs(jobs):
    BUILD.mkdir(exist_ok=True)
    jf = BUILD / "jobs.json"
    jf.write_text(json.dumps(jobs, indent=1))
    run(["node", ROOT / "scripts" / "chrome_tools.js", jf])


# ---------------------------------------------------------------------------
# figures and screenshots
# ---------------------------------------------------------------------------
def svg_sources():
    return [DOCS / "architecture.svg"] + sorted(RESULTS.glob("fig*.svg"))


def png_for(svg: Path) -> Path:
    return BUILD / "png" / (svg.stem + ".png")


def build_figures():
    chrome_jobs([{"type": "svg2png", "src": str(s.relative_to(ROOT)), "out": str(png_for(s).relative_to(ROOT)), "scale": 2}
                 for s in svg_sources()])


def build_shots():
    chrome_jobs([{"type": "shots", "outdir": "build/shots"}])
    from PIL import Image  # bundled with python-pptx
    full = Image.open(BUILD / "shots" / "gui_full.png").convert("RGB")
    full.save(DOCS / "screenshot_gui.jpg", quality=88, optimize=True)      # README + report hero shot
    Image.open(BUILD / "shots" / "gui_decode_crop.png").save(DOCS / "screenshot_decode.png", optimize=True)
    Image.open(BUILD / "shots" / "gui_textbook.png").convert("RGB").save(DOCS / "screenshot_textbook.jpg", quality=88, optimize=True)
    print("wrote docs/screenshot_gui.jpg docs/screenshot_decode.png docs/screenshot_textbook.jpg")


# ---------------------------------------------------------------------------
# Markdown -> HTML (the subset used by docs/report.md)
# ---------------------------------------------------------------------------
CAPTIONS = {
    "architecture": "System block diagram. The engine runs the trace once and emits one event per access; both front ends only replay events.",
    "screenshot_decode": "ADDRESS DECODE module probing 0x1A3C in the reference configuration (1 KiB, 16 B, 4-way): tag 0x1A, set 3, offset 12.",
    "screenshot_gui": "The GUI after seven accesses of the conflict trace on a direct-mapped cache with a 2-entry victim cache: the thrashing blocks are found in the victim cache (blue).",
    "fig1_assoc_vs_policy_conflict": "Hit ratio vs associativity and replacement policy on the conflict trace.",
    "fig2_block_size_vs_trace": "Miss ratio vs block size for four access patterns (1 KiB, 4-way, LRU).",
    "fig3_cache_size_miss_types_loop_large": "Miss breakdown vs cache size for loop_large; capacity misses vanish once the 2 KiB working set fits.",
    "fig4_write_policy": "Memory traffic (left) and memory write operations (right) by write policy on the loop trace.",
    "fig5_victim_cache_amat": "AMAT vs victim-cache size on a direct-mapped 1 KiB cache.",
    "fig6_all_traces_reference_config": "Hit ratio of every trace under the reference configuration.",
}


def inline(s: str) -> str:
    s = html.escape(s, quote=False)
    codes: list[str] = []

    def stash(m):
        codes.append("<code>%s</code>" % m.group(1))
        return "\x00%d\x00" % (len(codes) - 1)

    s = re.sub(r"`([^`]+)`", stash, s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], s)
    return s


ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]


def figure(stems: list[str], num: int | None, caption_key: str, cls="") -> str:
    imgs = []
    for stem in stems:
        for cand in (BUILD / "png" / (stem + ".png"), DOCS / (stem + ".png"), DOCS / (stem + ".jpg")):
            if cand.exists():
                imgs.append('<img src="%s" alt="%s">' % (html.escape(cand.resolve().as_uri()), stem))
                break
        else:
            raise SystemExit("missing image for %s (run `figures` / `shots` first)" % stem)
    label = ("Fig. %d. " % num) if num else ""
    return '<figure class="%s">%s<figcaption><b>%s</b>%s</figcaption></figure>' % (
        cls, "".join(imgs), label, html.escape(CAPTIONS[caption_key]))


def md_to_html(md: str) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    pending_figs: list[str] = []          # figures to flush at the end of the current subsection
    fig_counter = 0
    table_counter = 0
    table_caption = None
    table_wide = False
    para: list[str] = []

    def flush_para():
        nonlocal para
        if para:
            text = " ".join(para).strip()
            para = []
            figs_here = []
            # **[Figure N: `path`]**  and  **[screenshot: ...]** markers inside paragraphs
            def fig_marker(m):
                nonlocal fig_counter
                fig_counter += 1
                stem = Path(m.group(2)).stem
                figs_here.append(figure([stem], fig_counter, stem, cls="wide"))
                return ""
            def shot_marker(m):
                nonlocal fig_counter
                what = m.group(1).lower()
                key = "screenshot_decode" if "decode" in what else "screenshot_gui"
                fig_counter += 1
                figs_here.append(figure([key], fig_counter, key, cls="wide shot" + (" gui" if key == "screenshot_gui" else "")))
                return ""
            text = re.sub(r"\*\*\[Figure (\d+): `([^`]+)`\]\*\*\s*", fig_marker, text)
            text = re.sub(r"\s*\*\*\[screenshot: ([^\]]+)\]\*\*", shot_marker, text)
            if text.strip():
                out.append("<p>%s</p>" % inline(text))
            out.extend(figs_here)

    def flush_figs():
        nonlocal pending_figs
        out.extend(pending_figs)
        pending_figs = []

    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            flush_para()
            j = i + 1
            while j < len(lines) and not lines[j].startswith("```"):
                j += 1
            out.append("<pre><code>%s</code></pre>" % html.escape("\n".join(lines[i + 1:j])))
            i = j + 1
            continue
        if ln.startswith("#"):
            flush_para()
            level = len(ln) - len(ln.lstrip("#"))
            title = ln[level:].strip()
            if level <= 3:
                flush_figs()
            m = re.search(r"\s*\(Figure (\d+), `([^`]+)`\)", title)
            if m:
                fig_counter += 1
                pat = m.group(2)
                stems = [Path(p).stem for p in sorted(glob.glob(str(RESULTS / pat)))]
                if "*" in pat:  # the write-policy pair: traffic first, then memory writes
                    stems = sorted(stems, key=lambda s: 0 if "traffic" in s else 1)
                    pending_figs.append(figure(stems, fig_counter, "fig4_write_policy", cls="wide pair"))
                else:
                    pending_figs.append(figure(stems, fig_counter, stems[0], cls="wide chart"))
                title = title[:m.start()]
            anchor = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            # IEEE numbering: "2. Design" -> "II. Design", "2.3 Mapping" -> "C. Mapping"
            m_sec = re.match(r"(\d+)\.\s+(.*)", title)
            m_sub = re.match(r"(\d+)\.(\d+)\s+(.*)", title)
            if level == 2 and m_sec:
                title = "%s. %s" % (ROMAN[int(m_sec.group(1))], m_sec.group(2))
            elif level == 3 and m_sub:
                title = "%s. %s" % (chr(ord("A") + int(m_sub.group(2)) - 1), m_sub.group(3))
            if level == 1:
                out.append("<h1>%s</h1>" % inline(title))
            else:
                out.append('<h%d id="%s">%s</h%d>' % (level, anchor, inline(title), level))
            i += 1
            continue
        if ln.startswith("Table:") or ln.startswith("Table*:"):
            flush_para()
            table_wide = ln.startswith("Table*:")
            table_caption = ln.split(":", 1)[1].strip()
            i += 1
            continue
        if ln.strip() == "---":
            flush_para()
            out.append("<hr>")
            i += 1
            continue
        if ln.startswith("|"):
            flush_para()
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            aligns = ["right" if c.endswith(":") and c.startswith("-") else "left" for c in rows[1]] if len(rows) > 1 else []
            head = rows[0]
            body = rows[2:] if len(rows) > 2 else []
            kv = all(h == "" for h in head)      # title-page key/value table
            t = []
            if table_caption:
                table_counter += 1
                t.append('<div class="tblwrap%s"><div class="tcap">TABLE %s<br><span>%s</span></div>' % (" wide" if table_wide else "", ROMAN[table_counter], html.escape(table_caption)))
            t.append('<table class="%s">' % ("kv" if kv else "data"))
            if not kv:
                t.append("<thead><tr>%s</tr></thead>" % "".join(
                    '<th style="text-align:%s">%s</th>' % (aligns[k] if k < len(aligns) else "left", inline(c)) for k, c in enumerate(head)))
            t.append("<tbody>")
            for r in body:
                t.append("<tr>%s</tr>" % "".join(
                    '<td style="text-align:%s">%s</td>' % (aligns[k] if k < len(aligns) else "left", inline(c)) for k, c in enumerate(r)))
            t.append("</tbody></table>")
            if table_caption:
                t.append("</div>")
                table_caption = None
            out.append("".join(t))
            continue
        m_item = re.match(r"^(\d+)\.\s+(.*)", ln) or re.match(r"^-\s+(.*)", ln)
        if m_item:
            flush_para()
            ordered = ln[0].isdigit()
            items = []
            while i < len(lines):
                m2 = re.match(r"^(?:\d+\.|-)\s+(.*)", lines[i])
                if m2:
                    items.append(m2.group(1))
                elif lines[i].startswith("  ") and items:
                    items[-1] += " " + lines[i].strip()
                else:
                    break
                i += 1
            tag = "ol" if ordered else "ul"
            out.append("<%s>%s</%s>" % (tag, "".join("<li>%s</li>" % inline(t) for t in items), tag))
            continue
        if ln.strip() == "":
            flush_para()
            i += 1
            continue
        para.append(ln.strip())
        i += 1
    flush_para()
    flush_figs()
    return "\n".join(out)


REPORT_CSS = """
:root { --ink:#000; --rule:#000; --mono:'Courier New',Courier,monospace; }
@page { size: A4; margin: 0; }
html, body { margin:0; padding:0; }
body { font-family: 'Times New Roman', Times, serif; font-size: 10pt; line-height: 1.2; color: var(--ink); }
#src { display: none; }
.page { position: relative; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.row { display: flex; gap: 0.2in; align-items: stretch; overflow: hidden; }
.col { height: 100%; overflow: hidden; text-align: justify; hyphens: auto; }
.col > :first-child { padding-top: 0; }
* { margin: 0; }
header.ieee { text-align: center; padding: 0 0 14pt; }
header.ieee h1 { font-size: 24pt; font-weight: normal; line-height: 1.15; padding: 0 0 8pt; }
header.ieee .subtitle { font-size: 11pt; padding: 0 0 12pt; }
header.ieee .authors { display: flex; justify-content: center; gap: 48pt; }
header.ieee .author .name { font-size: 11pt; }
header.ieee .author .aff { font-size: 9.5pt; font-style: italic; padding-top: 2pt; line-height: 1.25; }
header.ieee .meta { font-size: 9pt; padding-top: 10pt; }
h2 { font-size: 10pt; font-weight: normal; font-variant: small-caps; text-align: center; padding: 11pt 0 5pt; }
h3 { font-size: 10pt; font-style: italic; font-weight: normal; padding: 8pt 0 3pt; }
p { text-indent: 0.14in; }
p.cont { text-indent: 0; }
p.abs { font-weight: bold; text-indent: 0; padding-bottom: 5pt; }
li { padding-bottom: 1pt; }
ol, ul { padding: 2pt 0 5pt 16pt; }
code { font-family: var(--mono); font-size: 8.5pt; }
pre { font-family: var(--mono); font-size: 6.9pt; line-height: 1.25; border: 0.5pt solid #999; padding: 4pt 5pt; margin: 4pt 0 7pt; white-space: pre-wrap; }
pre code { font-size: inherit; }
hr { display: none; }
.tblwrap { padding: 6pt 0 8pt; }
.tblwrap.wide table { width: 100%; max-width: 165mm; }
.tcap { font-size: 8pt; text-align: center; margin-bottom: 3pt; line-height: 1.3; }
.tcap span { font-variant: small-caps; }
table { border-collapse: collapse; margin: 0 auto; font-size: 8pt; }
table.data th { font-weight: normal; font-variant: small-caps; border-top: 0.8pt solid var(--rule); border-bottom: 0.5pt solid var(--rule); padding: 2pt 6pt; }
table.data td { padding: 1.5pt 6pt; }
table.data tbody tr:last-child td { border-bottom: 0.8pt solid var(--rule); }
figure { padding: 6pt 0 8pt; text-align: center; }
figure img { width: 100%; display: block; margin: 0 auto; }
figure.wide img { max-width: 150mm; }
figure.shot img { max-width: 150mm; }
figure.gui img { max-width: 140mm; }
figure.pair img { display: inline-block; width: 49.2%; margin: 0; vertical-align: top; }
figure.pair img + img { margin-left: 1.2%; }
figcaption { font-size: 8pt; margin-top: 4pt; text-align: center; max-width: 160mm; margin-left: auto; margin-right: auto; line-height: 1.25; }
ol.refs { list-style: none; padding-left: 0; counter-reset: ref; font-size: 8pt; }
ol.refs li { counter-increment: ref; padding-left: 1.7em; text-indent: -1.7em; padding-bottom: 2pt; text-align: left; }
ol.refs li::before { content: "[" counter(ref) "] "; }
#appendix ~ p { text-align: left; text-indent: 0; }
#appendix ~ p code { white-space: nowrap; }
"""


def build_report():
    md = (DOCS / "report.md").read_text()
    head_md = md.split("## Abstract")[0]
    meta = dict(re.findall(r"^\| ([A-Za-z][\w ]*?) \| (.+?) \|$", head_md, re.M))
    title = re.search(r"^# (.+)$", head_md, re.M).group(1)
    subtitle = re.search(r"^\*\*(.+?)\*\*$", head_md, re.M).group(1)
    authors = []
    for m in meta["Members"].split(","):
        m = m.strip()
        leader = "(leader)" in m
        name = re.sub(r"\s*\(leader\)", "", m)
        authors.append('<div class="author"><div class="name">%s</div><div class="aff">%sDepartment of Computer Science<br>National University of Sciences &amp; Technology, Balochistan Campus</div></div>'
                       % (html.escape(name), "Group leader<br>" if leader else "Group member<br>"))
    header = ('<header class="ieee"><h1>%s</h1><div class="subtitle">%s</div><div class="authors">%s</div>'
              '<div class="meta">%s &middot; Group %s &middot; %s &middot; repository %s</div></header>') % (
        html.escape(title), html.escape(subtitle), "".join(authors),
        html.escape(meta["Course"]), html.escape(meta["Group"]), html.escape(meta["Semester"]), inline(meta["Repository"]))
    body = md_to_html(md)
    body = body[body.index('<h2 id="abstract">'):]
    body = re.sub(r'<h2 id="abstract">Abstract</h2>\s*<p>', '<div class="abstract"><p><i>Abstract</i>&mdash;', body, count=1)
    body = re.sub(r"(<p><strong>Index Terms</strong>.*?</p>)", r"\1</div>", body, count=1, flags=re.S)
    body = body.replace('<h2 id="references">References</h2>\n<ol>', '<h2 id="references">References</h2>\n<ol class="refs">')
    # scripts/paginate.js flows #src into fixed A4 pages (CSS multicol with column-span mis-paginates in Chrome)
    script = (ROOT / "scripts" / "paginate.js").read_text()
    doc = ("<!doctype html><html><head><meta charset='utf-8'><title>%s &mdash; Group 04</title><style>%s</style></head>"
           "<body><div id='src'>%s%s</div><div id='pages'></div><script>%s</script></body></html>") % (
        html.escape(title), REPORT_CSS, header, body, script)
    BUILD.mkdir(exist_ok=True)
    (BUILD / "report.html").write_text(doc)
    chrome_jobs([{"type": "pdf", "html": "build/report.html", "out": "docs/report.pdf", "footer": FOOTER,
                  "margins": {"top": 0.75, "bottom": 0.85, "left": 0.65, "right": 0.65}}])
    pages = len(re.findall(rb"/Type\s*/Page[^s]", (DOCS / "report.pdf").read_bytes()))
    print("docs/report.pdf: %d pages (limit 12)" % pages)
    if pages > 12:
        raise SystemExit("report exceeds 12 pages")


# ---------------------------------------------------------------------------
# slides (python-pptx)
# ---------------------------------------------------------------------------
def build_slides():
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    from pptx.util import Emu, Inches, Pt
    from PIL import Image

    MONO, SANS = "Consolas", "Calibri"      # ship with PowerPoint on macOS and Windows (JetBrains Mono / Inter are not installed)
    W, H = Inches(13.333), Inches(7.5)
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    blank = prs.slide_layouts[6]
    rgb = lambda h: RGBColor.from_string(h)
    N_SLIDES = 18

    # ---- primitives ------------------------------------------------------
    def rect(slide, x, y, w, h, fill, line=None, shape=MSO_SHAPE.RECTANGLE, radius=None, lw=0.75):
        s = slide.shapes.add_shape(shape, x, y, w, h)
        s.fill.solid(); s.fill.fore_color.rgb = rgb(fill)
        if line:
            s.line.color.rgb = rgb(line); s.line.width = Pt(lw)
        else:
            s.line.fill.background()
        s.shadow.inherit = False
        if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
            s.adjustments[0] = radius
        return s

    def text(slide, x, y, w, h, runs, size=18, color="text", font=SANS, bold=False, align=PP_ALIGN.LEFT,
             anchor=MSO_ANCHOR.TOP, spacing=None, line_spacing=None, margin=Inches(0.05)):
        """runs: str | list[str] (paragraphs) | list[list[(text, {opts})]]"""
        tb = slide.shapes.add_textbox(x, y, w, h)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = anchor
        tf.margin_left = tf.margin_right = margin
        tf.margin_top = tf.margin_bottom = Inches(0.03)
        paras = [runs] if isinstance(runs, str) else runs
        for pi, p in enumerate(paras):
            para = tf.paragraphs[0] if pi == 0 else tf.add_paragraph()
            para.alignment = align
            if line_spacing:
                para.line_spacing = line_spacing
            pr = [(p, {})] if isinstance(p, str) else p
            for t, o in pr:
                r = para.add_run()
                r.text = t
                f = r.font
                f.size = Pt(o.get("size", size)); f.bold = o.get("bold", bold); f.name = o.get("font", font)
                f.color.rgb = rgb(C.get(o.get("color", color), o.get("color", color)))
                sp = o.get("spacing", spacing)
                if sp is not None:
                    f._element.set("spc", str(int(sp * 100)))
        return tb

    def bullets(slide, x, y, w, h, items, size=18, color="text", gap=6, marker="▸", mcolor="amber"):
        tb = slide.shapes.add_textbox(x, y, w, h)
        tf = tb.text_frame; tf.word_wrap = True
        tf.margin_left = tf.margin_right = Inches(0.05)
        for i, it in enumerate(items):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.space_after = Pt(gap)
            runs = [(it, {})] if isinstance(it, str) else it
            m = p.add_run(); m.text = marker + "  "; m.font.name = MONO; m.font.size = Pt(size); m.font.color.rgb = rgb(C[mcolor])
            for t, o in runs:
                r = p.add_run(); r.text = t
                r.font.size = Pt(o.get("size", size)); r.font.bold = o.get("bold", False)
                r.font.name = o.get("font", SANS); r.font.color.rgb = rgb(C.get(o.get("color", color), o.get("color", color)))
        return tb

    def panel(slide, x, y, w, h, title=None, sub=None):
        rect(slide, x, y, w, h, C["panel"], C["bezel"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.03)
        if title:
            rect(slide, x + Inches(0.18), y + Inches(0.17), Inches(0.05), Inches(0.22), C["amber"])
            text(slide, x + Inches(0.26), y + Inches(0.08), w - Inches(0.4), Inches(0.4),
                 [[(title.upper(), {"font": MONO, "bold": True, "color": "white", "spacing": 2, "size": 13})] +
                  ([("   " + sub, {"font": SANS, "color": "muted", "size": 12})] if sub else [])])
            rect(slide, x + Inches(0.01), y + Inches(0.5), w - Inches(0.02), Emu(6350), C["bezel"])
        return y + (Inches(0.62) if title else Inches(0.15))

    def lcd(slide, x, y, w, h, value, label, color="amber", vsize=30):
        text(slide, x, y, w, Inches(0.3), label.upper(), size=9, color="muted", font=MONO, spacing=1.2)
        rect(slide, x, y + Inches(0.28), w, h - Inches(0.28), C["lcd"], C["bezel_hi"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        text(slide, x, y + Inches(0.28), w, h - Inches(0.28), value, size=vsize, color=color, font=MONO, bold=True,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    def chip(slide, x, y, label, value, w=Inches(1.25), vcolor="amber"):
        rect(slide, x, y, w, Inches(0.34), C["lcd"], C["bezel_hi"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.15)
        text(slide, x, y, w, Inches(0.34), [[(label + " ", {"color": "muted", "size": 11}), (value, {"color": vcolor, "size": 11, "bold": True})]],
             font=MONO, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        return x + w + Inches(0.1)

    def table(slide, x, y, w, cols, rows, header=True, rh=Inches(0.4), size=13, mono_cols=(), first_col_w=None, highlight=None, widths=None):
        n = len(cols)
        given = widths is not None
        widths = list(widths) if given else [w / n] * n
        if first_col_w and not given:
            widths = [first_col_w] + [(w - first_col_w) / (n - 1)] * (n - 1)
        all_rows = ([cols] if header else []) + rows
        for ri, r in enumerate(all_rows):
            is_head = header and ri == 0
            cx = x
            fill = C["panel3"] if is_head else (C["panel2"] if ri % 2 else C["panel"])
            rect(slide, x, y, w, rh, fill, C["bezel"])
            for ci, cell in enumerate(r):
                cw = widths[ci]
                col = "amber" if is_head else ("white" if ci == 0 else "text")
                if highlight and not is_head and (ri - 1, ci) in highlight:
                    col = highlight[(ri - 1, ci)]
                text(slide, cx, y, cw, rh, cell, size=11 if is_head else size, color=col,
                     font=MONO if (is_head or ci in mono_cols) else SANS, bold=is_head or ci == 0,
                     align=PP_ALIGN.LEFT if ci == 0 else PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE,
                     spacing=1 if is_head else None, margin=Inches(0.1))
                cx += cw
            y += rh
        return y

    def image(slide, path, x, y, w, h, frame=True):
        with Image.open(path) as im:
            iw, ih = im.size
        scale = min(w / iw, h / ih)
        pw, ph = int(iw * scale), int(ih * scale)
        px, py = x + (w - pw) // 2, y + (h - ph) // 2
        if frame:
            rect(slide, px - Inches(0.06), py - Inches(0.06), pw + Inches(0.12), ph + Inches(0.12), C["panel"], C["bezel"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.02)
        slide.shapes.add_picture(str(path), px, py, pw, ph)
        return px, py, pw, ph

    def new_slide(title=None, sub=None, notes=""):
        s = prs.slides.add_slide(blank)
        s.background.fill.solid(); s.background.fill.fore_color.rgb = rgb(C["bg"])
        n = len(prs.slides)
        if title:
            rect(s, Inches(0.5), Inches(0.42), Inches(0.09), Inches(0.5), C["amber"])
            text(s, Inches(0.7), Inches(0.3), Inches(10.2), Inches(0.7), title.upper(), size=26, color="amber", font=MONO, bold=True, spacing=3, anchor=MSO_ANCHOR.MIDDLE)
            if sub:
                text(s, Inches(0.7), Inches(0.92), Inches(11), Inches(0.4), sub, size=14, color="muted", anchor=MSO_ANCHOR.TOP)
            rect(s, Inches(0.5), Inches(1.33), W - Inches(1.0), Emu(6350), C["bezel"])
        # footer strip
        rect(s, 0, H - Inches(0.42), W, Emu(6350), C["bezel"])
        text(s, Inches(0.5), H - Inches(0.4), Inches(9), Inches(0.35),
             "CACHE-SIM  ·  P07 CONFIGURABLE CACHE MEMORY SIMULATOR  ·  GROUP 04  ·  ALIYAN ZULFIQAR  ·  SHEHROZ RIAZ",
             size=9, color="dim", font=MONO, spacing=1, anchor=MSO_ANCHOR.MIDDLE)
        rect(s, W - Inches(1.45), H - Inches(0.36), Inches(0.95), Inches(0.27), C["lcd"], C["bezel_hi"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.2)
        text(s, W - Inches(1.45), H - Inches(0.36), Inches(0.95), Inches(0.27), "%02d / %d" % (n, N_SLIDES), size=10, color="amber", font=MONO, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        if notes:
            s.notes_slide.notes_text_frame.text = notes
        return s

    def figure_slide(title, sub, png, notes, caption=None, takeaways=None):
        s = new_slide(title, sub, notes)
        if takeaways:
            px, py, pw, ph = image(s, png, Inches(0.5), Inches(1.5), Inches(8.3), Inches(5.3))
            yy = panel(s, Inches(9.05), Inches(1.5), Inches(3.8), Inches(5.3), "readout")
            bullets(s, Inches(9.2), yy + Inches(0.05), Inches(3.5), Inches(4.4), takeaways, size=14, gap=10)
        else:
            image(s, png, Inches(0.5), Inches(1.5), W - Inches(1.0), Inches(5.3))
        if caption:
            text(s, Inches(0.5), H - Inches(0.75), W - Inches(1.0), Inches(0.3), caption, size=10, color="muted", font=MONO, align=PP_ALIGN.CENTER)
        return s

    png = lambda stem: BUILD / "png" / (stem + ".png")
    shot = lambda name: BUILD / "shots" / (name + ".png")

    # =====================================================================
    # 1 title
    s = new_slide(notes="20 s. Title. Introduce the group, the project code P07 and that the repository is coa-lab-group4, tag v1.0.")
    rect(s, 0, 0, W, Inches(0.08), C["amber"])
    text(s, Inches(0.9), Inches(1.2), Inches(11), Inches(0.5), "COA LAB · SEMESTER PROJECT P07 · GROUP 04", size=14, color="amber", font=MONO, spacing=4)
    text(s, Inches(0.9), Inches(1.75), Inches(11.5), Inches(1.3), "CACHE-SIM", size=72, color="white", font=MONO, bold=True, spacing=6)
    text(s, Inches(0.9), Inches(3.0), Inches(11.5), Inches(0.8), "Configurable Cache Memory Simulator", size=32, color="text")
    text(s, Inches(0.9), Inches(3.7), Inches(11.5), Inches(0.5), "trace-driven engine · step-by-step web GUI · 3C miss classification · experiments", size=16, color="muted")
    x = Inches(0.9)
    for lab, val in [("MAP", "DM"), ("SIZE", "1 KiB"), ("BLK", "16 B"), ("REPL", "LRU"), ("WR", "WB/WA"), ("VC", "2")]:
        x = chip(s, x, Inches(4.45), lab, val, w=Inches(1.35))
    text(s, Inches(0.9), Inches(5.35), Inches(7), Inches(0.4), "Aliyan Zulfiqar (group leader)  ·  Shehroz Riaz", size=20, color="white", bold=True)
    text(s, Inches(0.9), Inches(5.8), Inches(9), Inches(0.4), "Computer Architecture & Organization · BSCS · NUST Balochistan Campus, Department of Computer Science", size=14, color="muted")
    text(s, Inches(0.9), Inches(6.2), Inches(9), Inches(0.4), "github: coa-lab-group4 · tag v1.0 · Python standard library only", size=13, color="amber", font=MONO)

    # 2 why caches
    s = new_slide("Why caches", "the processor–memory gap and the principle of locality",
                  "1 min. \"A cache is a bet on locality.\" Walk down the hierarchy: each level is bigger and slower; the cache only pays off because programs reuse addresses (temporal) and their neighbours (spatial).")
    levels = [("REGISTERS", "~1 cycle", "bytes", 3.0), ("L1 CACHE", "1–4 cycles", "KiB", 4.4), ("L2 / L3 CACHE", "10–40 cycles", "MiB", 5.8), ("MAIN MEMORY (DRAM)", "~100+ cycles", "GiB", 7.2)]
    y = Inches(1.7)
    for name, lat, cap, w in levels:
        rect(s, Inches(0.6), y, Inches(w), Inches(0.78), C["panel"], C["bezel"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        text(s, Inches(0.75), y, Inches(3.3), Inches(0.78), [[(name, {"font": MONO, "bold": True, "color": "white", "size": 15})], [(cap, {"color": "muted", "size": 12})]], anchor=MSO_ANCHOR.MIDDLE)
        text(s, Inches(0.6) + Inches(w) - Inches(2.2), y, Inches(2.1), Inches(0.78), lat, size=16, color="amber", font=MONO, align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
        y += Inches(0.95)
    text(s, Inches(0.6), y + Inches(0.05), Inches(7.5), Inches(0.5), "faster, smaller ↑        ↓ larger, slower", size=12, color="dim", font=MONO)
    yy = panel(s, Inches(8.4), Inches(1.6), Inches(4.45), Inches(5.0), "locality")
    text(s, Inches(8.6), yy, Inches(4.1), Inches(0.9), "“A cache is a bet on locality.”", size=20, color="white", bold=True)
    bullets(s, Inches(8.6), yy + Inches(0.9), Inches(4.1), Inches(3.5), [
        [("Temporal: ", {"bold": True, "color": "white"}), ("an address used now is likely used again soon (loops, stacks).", {})],
        [("Spatial: ", {"bold": True, "color": "white"}), ("neighbouring addresses are likely used soon (arrays, code).", {})],
        [("The design choices decide how much of each a cache can exploit.", {"color": "amber"})],
    ], size=15, gap=10)

    # 3 design space
    s = new_slide("The design space", "the four knobs from L13–14 — they become the four rows of our configuration rack",
                  "1 min. These four choices are the whole design space the course covers; every one of them is an independent switch in the simulator.")
    knobs = [("Mapping", "where can a block live?", ["direct mapped (1 way)", "N-way set associative", "fully associative (1 set)"]),
             ("Block size", "how much is fetched per miss?", ["4 B … 128 B (powers of two)", "larger → spatial locality", "larger → fewer lines, pollution"]),
             ("Replacement", "which line is evicted?", ["LRU — least recently used", "FIFO — oldest fill", "RANDOM — seeded"]),
             ("Write policy", "when does memory see a write?", ["write-back / write-through", "write-allocate / no-write-allocate", "cost = traffic, not hit ratio"])]
    for k, (name, q, opts) in enumerate(knobs):
        x = Inches(0.5) + k * Inches(3.13)
        yy = panel(s, x, Inches(1.6), Inches(2.98), Inches(4.9), name)
        text(s, x + Inches(0.15), yy, Inches(2.7), Inches(0.7), q, size=14, color="muted")
        bullets(s, x + Inches(0.15), yy + Inches(0.75), Inches(2.75), Inches(3.3), opts, size=14, gap=10)
        rect(s, x + Inches(0.2), Inches(6.15), Inches(2.58), Inches(0.08), C["amber"] if k == 0 else C["bezel_hi"])
    text(s, Inches(0.5), Inches(6.4), W - Inches(1), Inches(0.4), "plus: cache size, address width, hit time / miss penalty, victim-cache entries", size=13, color="dim", font=MONO, align=PP_ALIGN.CENTER)

    # 4 goals
    s = new_slide("Project goals", "the five deliverables of the brief, plus one self-imposed constraint",
                  "1 min. Read the five deliverables; stress that the evaluation metrics (hit/miss ratio, 3C breakdown, correctness against hand-worked examples) are what the experiments section proves.")
    goals = ["Implement every mapping, replacement and write policy — each configurable independently",
             "Show the address breakdown into tag / index / offset for any configuration",
             "Generate traces with controllable locality, and accept external (real) traces",
             "Visualise hits and misses step by step; compare configurations with charts",
             "Report hit / miss ratios and the compulsory / capacity / conflict breakdown — verified against hand-worked examples"]
    yy = panel(s, Inches(0.5), Inches(1.6), Inches(8.2), Inches(5.0), "deliverables")
    for i, g in enumerate(goals):
        y = yy + Inches(0.05) + i * Inches(0.86)
        rect(s, Inches(0.7), y + Inches(0.08), Inches(0.55), Inches(0.55), C["lcd"], C["bezel_hi"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.2)
        text(s, Inches(0.7), y + Inches(0.08), Inches(0.55), Inches(0.55), str(i + 1), size=18, color="amber", font=MONO, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, Inches(1.4), y, Inches(7.2), Inches(0.8), g, size=15, color="text", anchor=MSO_ANCHOR.MIDDLE)
    yy = panel(s, Inches(8.95), Inches(1.6), Inches(3.9), Inches(5.0), "constraint")
    text(s, Inches(9.1), yy, Inches(3.6), Inches(1.0), "Python standard library only.", size=20, color="white", bold=True)
    bullets(s, Inches(9.1), yy + Inches(0.9), Inches(3.6), Inches(3.5), [
        "nothing to install — one command runs tests, experiments and the GUI",
        "charts are written as SVG by our own code",
        "the GUI is plain HTML / CSS / JS served by http.server"], size=14, gap=10)

    # 5 architecture
    figure_slide("Architecture", "one tested engine, two front ends that only replay events", png("architecture"),
                 "1.5 min. Engine runs once, emits events; GUI replays. Point out the shadow fully-associative cache (3C classifier) and the victim cache as separate boxes feeding stats. Because the browser only replays per-access events, stepping backwards is free and the GUI can never disagree with the CLI.")

    # 6 address decoding
    s = new_slide("Address decoding", "geometry → bit fields, for any power-of-two configuration",
                  "1.5 min. Derive the field widths live: lines = C / B, sets = lines / A, offset bits = log2 B, index bits = log2 S, tag = the rest. Then show 0x1A3C decoded in the GUI's ADDRESS DECODE module: tag 0x1A, set 3, offset 12.")
    yy = panel(s, Inches(0.5), Inches(1.55), Inches(5.2), Inches(2.75), "formulae")
    text(s, Inches(0.7), yy, Inches(4.9), Inches(2.1), [
        [("lines   N = C / B", {})], [("sets    S = N / A      (1 if fully associative)", {})],
        [("offset  = log₂ B", {})], [("index   = log₂ S", {})], [("tag     = address bits − index − offset", {})]],
        size=14, color="text", font=MONO, line_spacing=1.25)
    yy = panel(s, Inches(5.95), Inches(1.55), Inches(6.9), Inches(2.75), "worked example", "1 KiB · 16 B blocks · 4-way · 32-bit")
    x = Inches(6.15)
    for lab, val, col in [("sets", "16", "amber"), ("offset", "4 b", "green"), ("index", "4 b", "blue"), ("tag", "24 b", "amber")]:
        lcd(s, x, yy - Inches(0.05), Inches(1.5), Inches(1.0), val, lab, col, vsize=22); x += Inches(1.62)
    text(s, Inches(6.15), yy + Inches(1.1), Inches(6.5), Inches(0.9), [[("0x1A3C  →  tag ", {"color": "muted"}), ("0x1A", {"color": "amber", "bold": True}), ("   set ", {"color": "muted"}), ("3", {"color": "blue", "bold": True}), ("   offset ", {"color": "muted"}), ("12", {"color": "green", "bold": True})]], size=18, font=MONO)
    image(s, shot("gui_decode_crop"), Inches(0.5), Inches(4.45), W - Inches(1.0), Inches(2.55))

    # 7 mapping & replacement
    s = new_slide("Mapping & replacement", "one code path for DM, N-way and fully associative",
                  "1 min. Direct-mapped is the one-way case and fully associative is the one-set case, so one set-lookup routine serves all three. The only difference between LRU and FIFO is that a hit refreshes the LRU timestamp — show the 0,4,0,8,0 example: LRU 2 hits, FIFO 1 hit.")
    yy = panel(s, Inches(0.5), Inches(1.55), Inches(5.6), Inches(5.1), "one set lookup")
    bullets(s, Inches(0.7), yy, Inches(5.2), Inches(2.4), [
        [("direct mapped", {"bold": True, "color": "white"}), (" = 1 way per set", {})],
        [("N-way", {"bold": True, "color": "white"}), (" = S sets × N ways", {})],
        [("fully associative", {"bold": True, "color": "white"}), (" = 1 set × N ways", {})],
        "invalid lines are filled first; then the policy picks a victim"], size=15, gap=8)
    text(s, Inches(0.7), yy + Inches(2.5), Inches(5.2), Inches(0.4), "sequence 0, 4, 0, 8, 0 on 2 one-word lines", size=12, color="muted", font=MONO)
    lcd(s, Inches(0.7), yy + Inches(2.95), Inches(2.4), Inches(1.3), "2 hits", "LRU", "green", vsize=26)
    lcd(s, Inches(3.3), yy + Inches(2.95), Inches(2.4), Inches(1.3), "1 hit", "FIFO", "red", vsize=26)
    yy = panel(s, Inches(6.35), Inches(1.55), Inches(6.5), Inches(5.1), "victim choice")
    table(s, Inches(6.55), yy, Inches(6.1), ["policy", "victim when the set is full", "on a hit"], [
        ["LRU", "oldest last-used timestamp", "refresh timestamp"],
        ["FIFO", "oldest fill timestamp", "nothing"],
        ["RANDOM", "seeded random way", "nothing"]], rh=Inches(0.62), size=14, first_col_w=Inches(1.3))
    text(s, Inches(6.55), yy + Inches(2.75), Inches(6.1), Inches(1.4), "Hits refresh the LRU timestamp only — that single line of code is the entire difference between LRU and FIFO.", size=14, color="amber")

    # 8 write policies
    s = new_slide("Write policies", "write-back vs write-through × write-allocate vs no-write-allocate",
                  "1.5 min. Hit ratio is the same for write-back and write-through; the difference is memory traffic. On the loop trace write-through sends all 188 writes to memory, write-back sends none because nothing dirty is ever evicted. No-write-allocate lowers the hit ratio instead, because written lines are not brought in for later reads.")
    cells = [("WRITE-BACK · WRITE-ALLOCATE", "dirty bit on write hit; whole block written back on eviction; write miss fetches the block", "0 memory writes · 0.50 KiB", "green"),
             ("WRITE-THROUGH · WRITE-ALLOCATE", "every write goes to memory immediately; never any dirty lines", "188 memory writes · 1.23 KiB", "red"),
             ("WRITE-BACK · NO-WRITE-ALLOCATE", "write miss writes the word around the cache; nothing allocated", "17 memory writes · hit ratio 0.936", "amber"),
             ("WRITE-THROUGH · NO-WRITE-ALLOCATE", "the simplest hardware; the most bandwidth", "188 memory writes · hit ratio 0.936", "red")]
    for k, (name, desc, num, col) in enumerate(cells):
        x = Inches(0.5) + (k % 2) * Inches(6.2); y = Inches(1.55) + (k // 2) * Inches(2.45)
        yy = panel(s, x, y, Inches(6.05), Inches(2.3), name)
        text(s, x + Inches(0.2), yy - Inches(0.05), Inches(5.7), Inches(0.9), desc, size=14, color="text")
        text(s, x + Inches(0.2), yy + Inches(0.95), Inches(5.7), Inches(0.5), num, size=16, color=col, font=MONO, bold=True)
    text(s, Inches(0.5), Inches(6.5), W - Inches(1), Inches(0.4), "loop trace · 768 accesses · 25 % writes · 1 KiB 4-way LRU — traffic counted in bytes: block per fetch / write-back, word per write-through", size=11, color="dim", font=MONO, align=PP_ALIGN.CENTER)

    # 9 3C
    s = new_slide("3C miss classification", "compulsory · capacity · conflict — decided per miss with a shadow fully-associative cache",
                  "1.5 min. \"Conflict misses are exactly what more ways can remove.\" The shadow cache has the same number of lines but no mapping restriction; if it would also have missed, the miss is capacity, otherwise the mapping caused it. Invariant: a fully-associative cache never reports conflict misses.")
    defs = [("compulsory", "amber", "the block has never been in the cache (infinite-cache definition)"),
            ("capacity", "violet", "a fully-associative cache of the same size would also miss — the working set is too big"),
            ("conflict", "red", "only the mapping caused it: too many live blocks fell into one set")]
    for k, (name, col, d) in enumerate(defs):
        x = Inches(0.5) + k * Inches(4.15)
        rect(s, x, Inches(1.55), Inches(4.0), Inches(2.1), C["panel"], C["bezel"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.04)
        rect(s, x + Inches(0.2), Inches(1.75), Inches(0.3), Inches(0.3), C[col])
        text(s, x + Inches(0.6), Inches(1.62), Inches(3.3), Inches(0.5), name.upper(), size=18, color=col, font=MONO, bold=True, spacing=2)
        text(s, x + Inches(0.2), Inches(2.2), Inches(3.6), Inches(1.4), d, size=15, color="text")
    yy = panel(s, Inches(0.5), Inches(3.9), W - Inches(1.0), Inches(2.75), "classifier", "runs on every miss")
    steps = [("block never seen?", "compulsory", "amber"), ("shadow FA cache misses too?", "capacity", "violet"), ("otherwise", "conflict", "red")]
    x = Inches(0.8)
    for q, a, col in steps:
        rect(s, x, yy + Inches(0.1), Inches(3.6), Inches(1.45), C["lcd"], C["bezel_hi"], MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
        text(s, x, yy + Inches(0.15), Inches(3.6), Inches(0.6), q, size=14, color="muted", font=MONO, align=PP_ALIGN.CENTER)
        text(s, x, yy + Inches(0.7), Inches(3.6), Inches(0.7), "→ " + a.upper(), size=20, color=col, font=MONO, bold=True, align=PP_ALIGN.CENTER)
        x += Inches(4.0)
    text(s, Inches(0.8), yy + Inches(1.65), Inches(11.5), Inches(0.4), "invariant: a fully-associative cache never reports conflict misses; the conflict count is precisely what extra associativity can remove", size=12, color="amber", font=MONO)

    # 10 live demo
    s = new_slide("Live demo", "the textbook direct-mapped example, stepped in the GUI",
                  "3 min. LIVE: GUI open at http://127.0.0.1:8077 (scripts/run_demo.sh already run). Preset textbook_dm.trace; CACHE SIZE 32, BLOCK SIZE 4 B, MAPPING DM (8 sets, one word per block) — the Hennessy & Patterson configuration. Step with the → key; point at the bit split, the flashing cell and the counters. Show M M H H M M H M matching the textbook; the last access (word 18) evicts 26 from set 2. Then switch MAPPING to 2-WAY mid-trace: counters re-run instantly. Finally load conflict.trace at 1K / 16 B / DM: all red; set VICTIM $ = 2: blue victim hits; run a sweep with X = ASSOC, SERIES = REPL. This slide is the fallback if the live GUI fails.")
    image(s, shot("gui_textbook"), Inches(0.5), Inches(1.5), Inches(8.6), Inches(5.4))
    yy = panel(s, Inches(9.3), Inches(1.5), Inches(3.55), Inches(5.4), "demo script")
    bullets(s, Inches(9.45), yy, Inches(3.3), Inches(4.7), [
        [("textbook_dm.trace", {"font": MONO, "color": "white"}), (" · 32 B · 4 B · DM", {})],
        "step with → : M M H H M M H M",
        "word 18 evicts 26 from set 2 — as in the textbook",
        "flip MAPPING to 2-WAY: counters re-run",
        [("conflict.trace", {"font": MONO, "color": "white"}), (" 1K/16B/DM: all red; VICTIM $ = 2: blue", {})],
        "sweep X = ASSOC, SERIES = REPL"], size=13, gap=8)

    # 11 verification
    s = new_slide("Verification", "hand-worked examples first, then 39 unit tests that reproduce them",
                  "1 min. Every expected value was worked by hand before it became a test. Tell the victim-cache story: while writing that test we mis-traced which block was dirty after a swap; the simulator's per-access log showed the real sequence and the hand analysis was corrected — the tool doing what it is for.")
    lcd(s, Inches(0.5), Inches(1.6), Inches(2.6), Inches(1.5), "39 / 39", "unit tests passing", "green", vsize=30)
    lcd(s, Inches(3.3), Inches(1.6), Inches(2.6), Inches(1.5), "8", "hand-worked cases", "amber", vsize=30)
    table(s, Inches(0.5), Inches(3.35), Inches(5.4), ["hand-worked case", "expected", "✓"], [
        ["H&P direct-mapped sequence", "M M H H M M H M · 0.375", "✓"],
        ["LRU vs FIFO (0,4,0,8,0)", "2 hits vs 1 hit", "✓"],
        ["conflict vs capacity", "2+4 conf · 5+5 cap", "✓"],
        ["write policies, traffic", "bytes per policy", "✓"],
        ["victim cache swap", "dirty bit survives", "✓"]], rh=Inches(0.5), size=12, widths=[Inches(2.35), Inches(2.55), Inches(0.5)], mono_cols=(1,), highlight={(i, 2): "green" for i in range(5)})
    yy = panel(s, Inches(6.2), Inches(1.6), Inches(6.65), Inches(5.0), "the error we caught")
    text(s, Inches(6.4), yy, Inches(6.3), Inches(4.2), [
        [("Writing the victim-cache test, we mis-traced which block was dirty after a swap.", {"color": "white", "bold": True})],
        [("", {})],
        [("The simulator's per-access log showed the actual sequence — dirty bits travel with the block into the victim cache and are written back only when they fall out of it.", {})],
        [("", {})],
        [("The hand analysis was corrected, not the code: the tool did what it is for.", {"color": "amber"})]], size=15, color="text")

    # 12 trace generator
    s = new_slide("Trace generator", "six deterministic patterns — each isolates one kind of miss",
                  "1 min. All generators are deterministic from a seed and take a write ratio. Point out that the matrix walk in column-major order is the same data as row-major but produces 768 conflict misses. Real program traces (Valgrind lackey) load unchanged.")
    table(s, Inches(0.5), Inches(1.55), W - Inches(1.0), ["pattern", "what it does", "what it isolates", "reference hit ratio"], [
        ["sequential", "walk an array once", "compulsory misses, spatial locality", "0.750"],
        ["loop", "sweep a 512 B array 4×", "temporal locality — mostly hits", "0.958"],
        ["loop_large", "sweep 2 KiB 3× (bigger than cache)", "capacity misses", "0.750"],
        ["random", "uniform random words", "almost no locality", "0.063"],
        ["strided", "one access per block, never revisited", "nothing to reuse", "0.000"],
        ["matrix row / col", "n×n walk, row- or column-major", "loop order → conflict misses", "0.750 / 0.000"],
        ["conflict", "k blocks exactly one cache size apart", "conflict misses, LRU pathology", "0.938 (4-way)"]],
        rh=Inches(0.56), size=13, first_col_w=Inches(2.2), mono_cols=(3,))
    text(s, Inches(0.5), Inches(6.2), W - Inches(1.0), Inches(0.5), "formats accepted: R/W addr · Dinero 0/1 addr · Valgrind lackey L/S/M/I addr,size   —   reference configuration 1 KiB · 16 B · 4-way · LRU · WB/WA", size=11, color="dim", font=MONO, align=PP_ALIGN.CENTER)

    # 13–15 results
    figure_slide("Result: associativity × policy", "conflict trace: three blocks 1 KiB apart, repeated 16× (48 accesses)", png("fig1_assoc_vs_policy_conflict"),
                 "1.5 min. RANDOM beats LRU at 2-way here — ask the audience why. Three blocks cycle through one set, so with two ways LRU and FIFO always evict exactly the block needed next; RANDOM sometimes keeps it. All 45 non-compulsory misses are conflict misses and vanish at 4 ways: the 3C counter tells you associativity, not capacity, is the fix.",
                 takeaways=[[("2-way, LRU / FIFO: ", {"bold": True, "color": "white"}), ("0.000 — the classic LRU pathology", {})],
                            [("2-way, RANDOM: ", {"bold": True, "color": "white"}), ("0.354 — sometimes keeps the right block", {})],
                            [("≥ 4-way: ", {"bold": True, "color": "white"}), ("0.938 — only the 3 compulsory misses remain", {})],
                            [("all 45 extra misses are conflict misses", {"color": "amber"})]])
    figure_slide("Result: block size", "miss ratio vs block size, 1 KiB 4-way LRU", png("fig2_block_size_vs_trace"),
                 "1.5 min. Streaming access halves its miss ratio with every doubling of the block (1 / words per block). Random barely benefits. The column-major matrix walk is stuck at 1.0 whatever the block size: with 16 sets, the 32 blocks of a column all map to sets 0 and 8, so each column evicts the previous one — 768 of its 1024 misses are conflict misses versus zero for the row-major walk. Loop order matters.",
                 takeaways=[[("sequential / row-major: ", {"bold": True, "color": "white"}), ("1.000 → 0.031, halving per doubling", {})],
                            [("random: ", {"bold": True, "color": "white"}), ("0.963 → 0.914 — barely moves", {})],
                            [("column-major: ", {"bold": True, "color": "white"}), ("1.000 at every block size", {})],
                            [("768 conflict misses — loop order matters", {"color": "red"})]])
    figure_slide("Result: cache size", "loop_large: 2 KiB working set swept three times", png("fig3_cache_size_miss_types_loop_large"),
                 "1 min. Below the working-set size every sweep re-fetches every block — those are capacity misses. At 2 KiB they disappear in one step and only the 128 compulsory misses remain. Cache size does not help gradually: it helps once the working set fits.",
                 takeaways=[[("256 B – 1 KiB: ", {"bold": True, "color": "white"}), ("miss ratio 0.250, 256 capacity misses", {})],
                            [("2 KiB and up: ", {"bold": True, "color": "white"}), ("miss ratio 0.083, 0 capacity misses", {})],
                            [("the working-set step, not a slope", {"color": "amber"})]])

    # 16 write policy + victim cache
    s = new_slide("Result: write policy & victim cache", "bandwidth, not hit ratio — and a two-entry buffer that rescues a thrashing cache",
                  "1.5 min. Left: write-through has the same hit ratio as write-back but 2.5× the memory traffic (1.23 KiB vs 0.50 KiB) because all 188 writes go to memory. Right: a two-entry victim cache catches all 45 conflict misses of the thrashing trace and brings AMAT from 101 to 9.1 cycles, while the strided trace, which never revisits a block, gains nothing.")
    image(s, png("fig4_write_policy_traffic_loop"), Inches(0.5), Inches(1.5), Inches(6.1), Inches(3.6))
    image(s, png("fig5_victim_cache_amat"), Inches(6.75), Inches(1.5), Inches(6.1), Inches(3.6))
    lcd(s, Inches(0.7), Inches(5.3), Inches(2.7), Inches(1.3), "2.5×", "WT traffic vs WB", "red", vsize=28)
    text(s, Inches(3.6), Inches(5.5), Inches(2.9), Inches(1.1), "same hit ratio 0.958 — 188 word writes vs 0 write-backs", size=13, color="text", anchor=MSO_ANCHOR.MIDDLE)
    lcd(s, Inches(6.95), Inches(5.3), Inches(2.9), Inches(1.3), "101 → 9.1", "AMAT with 2-entry VC", "green", vsize=26)
    text(s, Inches(10.0), Inches(5.5), Inches(2.8), Inches(1.1), "all 45 conflict misses caught; strided trace unchanged", size=13, color="text", anchor=MSO_ANCHOR.MIDDLE)

    # 17 extensions & limits
    s = new_slide("Extensions & limits", "what we added beyond the brief, and what the model leaves out",
                  "1 min. Both optional extensions are implemented: the victim cache and real program traces via Valgrind. Be honest about the limits: no data values, no DRAM timing model, single level. These are the obvious next steps.")
    yy = panel(s, Inches(0.5), Inches(1.55), Inches(6.05), Inches(5.1), "extensions", "implemented")
    bullets(s, Inches(0.7), yy, Inches(5.7), Inches(4.3), [
        [("Victim cache: ", {"bold": True, "color": "white"}), ("2–8 entry fully-associative FIFO buffer; swap on hit, dirty bits preserved", {})],
        [("Real program traces: ", {"bold": True, "color": "white"}), ("valgrind --tool=lackey --trace-mem=yes output loads unchanged", {})],
        [("Memory traffic in bytes: ", {"bold": True, "color": "white"}), ("write policies compared on bandwidth", {})],
        [("AMAT: ", {"bold": True, "color": "white"}), ("hit time, miss penalty and victim-hit cost are live controls", {})],
        [("Reproducible experiments: ", {"bold": True, "color": "white"}), ("every table lists the CLI command that regenerates it", {})]], size=14, gap=9, mcolor="green")
    yy = panel(s, Inches(6.8), Inches(1.55), Inches(6.05), Inches(5.1), "not modelled", "future work")
    bullets(s, Inches(7.0), yy, Inches(5.7), Inches(4.3), [
        "data values — only addresses are simulated",
        "DRAM timing — a single miss penalty instead of row/column latency",
        "multi-level hierarchy with AMAT composition (L1 → L2)",
        "prefetching and non-blocking misses",
        "instruction vs data caches"], size=14, gap=9, mcolor="red")

    # 18 summary
    s = new_slide("Summary", "one line per deliverable", "1 min. One line per deliverable, then what we learned, then questions. Repository coa-lab-group4, tag v1.0; the demo video link is in the README.")
    done = [("mapping · replacement · write policy", "all configurable independently, one code path"),
            ("address breakdown", "tag / index / offset for any geometry, live in the GUI"),
            ("trace generation", "six patterns + Dinero / Valgrind input"),
            ("visualisation", "step-by-step cache array, counters, sweeps with charts"),
            ("metrics & correctness", "hit/miss, 3C, AMAT — 39 tests from hand-worked examples")]
    yy = panel(s, Inches(0.5), Inches(1.55), Inches(7.9), Inches(5.1), "deliverables")
    for i, (a, b) in enumerate(done):
        y = yy + i * Inches(0.84)
        text(s, Inches(0.7), y, Inches(0.5), Inches(0.7), "✓", size=22, color="green", font=MONO, bold=True, anchor=MSO_ANCHOR.MIDDLE)
        text(s, Inches(1.2), y, Inches(7.0), Inches(0.8), [[(a, {"bold": True, "color": "white", "font": MONO, "size": 14})], [(b, {"color": "text", "size": 13})]], anchor=MSO_ANCHOR.MIDDLE)
    yy = panel(s, Inches(8.65), Inches(1.55), Inches(4.2), Inches(5.1), "what we learned")
    bullets(s, Inches(8.85), yy, Inches(3.85), Inches(3.4), [
        "associativity removes conflict misses — but only beyond the number of competing blocks",
        "block size helps streaming, not random access",
        "cache size helps in a step at the working set",
        "write-through costs bandwidth, not hit ratio",
        "a tiny victim cache can rescue a direct-mapped cache"], size=13, gap=7)
    text(s, Inches(8.85), Inches(5.9), Inches(3.85), Inches(0.6), "Questions?", size=24, color="amber", font=MONO, bold=True)

    assert len(prs.slides) == N_SLIDES, len(prs.slides)
    out = DOCS / "slides.pptx"
    prs.save(out)
    print("wrote docs/slides.pptx (%d slides)" % len(prs.slides))


# ---------------------------------------------------------------------------
def main(argv):
    what = argv[1] if len(argv) > 1 else "all"
    if what in ("shots", "all"):
        build_shots()
    if what in ("figures", "all"):
        build_figures()
    if what in ("report", "all"):
        build_report()
    if what in ("slides", "all"):
        build_slides()
    if what not in ("shots", "figures", "report", "slides", "all"):
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
