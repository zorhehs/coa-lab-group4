"""
Dependency-free SVG charts in the same "bench instrument" style as the GUI.

Used by the CLI (``sweep --svg``) and by ``scripts/experiments.py`` to produce
the figures in ``results/``.  Matplotlib is deliberately not required.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence
from xml.sax.saxutils import escape

BG = "#141518"
PANEL = "#1C1E23"
GRID = "#2A2D34"
TEXT = "#C9CDD4"
MUTED = "#7E8591"
AMBER = "#F5B942"
GREEN = "#58D68D"
RED = "#E8584F"
BLUE = "#5DADE2"
VIOLET = "#B388EB"
SERIES_COLORS = [AMBER, GREEN, BLUE, RED, VIOLET, "#F1948A", "#76D7C4"]
FONT = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"


def _nice_max(v: float) -> float:
    if v <= 0:
        return 1.0
    if v <= 1.0:
        return 1.0
    import math
    exp = math.floor(math.log10(v))
    base = 10 ** exp
    for m in (1, 2, 2.5, 5, 10):
        if v <= m * base:
            return m * base
    return 10 * base


def bar_chart_svg(title: str, categories: Sequence[str], series: Dict[str, Sequence[Optional[float]]],
                  ylabel: str = "", width: int = 760, height: int = 400, ymax: Optional[float] = None,
                  value_fmt: str = "{:.3f}", subtitle: str = "") -> str:
    """Grouped bar chart.  ``series`` maps a series name to one value per category."""
    pad_l, pad_r, pad_t, pad_b = 64, 24, 64, 64
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    names = list(series)
    allv = [v for vals in series.values() for v in vals if v is not None]
    top = ymax if ymax is not None else _nice_max(max(allv) if allv else 1.0)
    out: List[str] = []
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
               'font-family="%s" font-size="12">' % (width, height, width, height, FONT))
    out.append('<rect width="100%%" height="100%%" fill="%s"/>' % BG)
    out.append('<rect x="8" y="8" width="%d" height="%d" fill="%s" stroke="%s"/>' % (width - 16, height - 16, PANEL, GRID))
    out.append('<text x="%d" y="30" fill="%s" font-size="13" letter-spacing="2">%s</text>'
               % (pad_l, AMBER, escape(title.upper())))
    if subtitle:
        out.append('<text x="%d" y="46" fill="%s" font-size="11">%s</text>' % (pad_l, MUTED, escape(subtitle)))
    # grid + y axis
    ticks = 5
    for i in range(ticks + 1):
        y = pad_t + plot_h - plot_h * i / ticks
        val = top * i / ticks
        out.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-dasharray="2 4"/>'
                   % (pad_l, y, pad_l + plot_w, y, GRID))
        out.append('<text x="%d" y="%.1f" fill="%s" text-anchor="end" dominant-baseline="middle">%s</text>'
                   % (pad_l - 8, y, MUTED, ("%g" % val) if top > 1 else ("%.2f" % val)))
    if ylabel:
        out.append('<text x="14" y="%d" fill="%s" font-size="11" transform="rotate(-90 14 %d)" text-anchor="middle">%s</text>'
                   % (pad_t + plot_h // 2, MUTED, pad_t + plot_h // 2, escape(ylabel)))
    # bars
    n_cat = max(1, len(categories))
    group_w = plot_w / n_cat
    bar_gap = 3
    bar_w = max(4, (group_w * 0.7 - bar_gap * (len(names) - 1)) / max(1, len(names)))
    for ci, cat in enumerate(categories):
        gx = pad_l + ci * group_w + group_w * 0.15
        for si, name in enumerate(names):
            v = series[name][ci] if ci < len(series[name]) else None
            x = gx + si * (bar_w + bar_gap)
            color = SERIES_COLORS[si % len(SERIES_COLORS)]
            if v is None:
                out.append('<text x="%.1f" y="%d" fill="%s" font-size="10" text-anchor="middle">n/a</text>'
                           % (x + bar_w / 2, pad_t + plot_h - 6, MUTED))
                continue
            h = plot_h * min(v, top) / top
            y = pad_t + plot_h - h
            out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" opacity="0.9"/>'
                       % (x, y, bar_w, h, color))
            out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="2" fill="%s"/>' % (x, y, bar_w, "#FFFFFF"))
            out.append('<text x="%.1f" y="%.1f" fill="%s" font-size="9" text-anchor="middle">%s</text>'
                       % (x + bar_w / 2, y - 4, TEXT, escape(value_fmt.format(v))))
        out.append('<text x="%.1f" y="%d" fill="%s" text-anchor="middle">%s</text>'
                   % (pad_l + ci * group_w + group_w / 2, pad_t + plot_h + 18, TEXT, escape(str(cat))))
    out.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s"/>' % (pad_l, pad_t + plot_h, pad_l + plot_w, pad_t + plot_h, MUTED))
    # legend
    lx = pad_l
    ly = height - 22
    for si, name in enumerate(names):
        color = SERIES_COLORS[si % len(SERIES_COLORS)]
        out.append('<circle cx="%d" cy="%d" r="4" fill="%s"/>' % (lx + 4, ly, color))
        out.append('<text x="%d" y="%d" fill="%s" dominant-baseline="middle">%s</text>' % (lx + 14, ly, TEXT, escape(name)))
        lx += 14 + 7 * len(name) + 24
    out.append('</svg>')
    return "\n".join(out)


def line_chart_svg(title: str, xs: Sequence[str], series: Dict[str, Sequence[Optional[float]]],
                   ylabel: str = "", width: int = 760, height: int = 400, ymax: Optional[float] = None,
                   subtitle: str = "") -> str:
    """Line chart with markers; same frame as the bar chart."""
    pad_l, pad_r, pad_t, pad_b = 64, 24, 64, 64
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    names = list(series)
    allv = [v for vals in series.values() for v in vals if v is not None]
    top = ymax if ymax is not None else _nice_max(max(allv) if allv else 1.0)
    out: List[str] = []
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
               'font-family="%s" font-size="12">' % (width, height, width, height, FONT))
    out.append('<rect width="100%%" height="100%%" fill="%s"/>' % BG)
    out.append('<rect x="8" y="8" width="%d" height="%d" fill="%s" stroke="%s"/>' % (width - 16, height - 16, PANEL, GRID))
    out.append('<text x="%d" y="30" fill="%s" font-size="13" letter-spacing="2">%s</text>' % (pad_l, AMBER, escape(title.upper())))
    if subtitle:
        out.append('<text x="%d" y="46" fill="%s" font-size="11">%s</text>' % (pad_l, MUTED, escape(subtitle)))
    ticks = 5
    for i in range(ticks + 1):
        y = pad_t + plot_h - plot_h * i / ticks
        val = top * i / ticks
        out.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-dasharray="2 4"/>' % (pad_l, y, pad_l + plot_w, y, GRID))
        out.append('<text x="%d" y="%.1f" fill="%s" text-anchor="end" dominant-baseline="middle">%s</text>'
                   % (pad_l - 8, y, MUTED, ("%g" % val) if top > 1 else ("%.2f" % val)))
    if ylabel:
        out.append('<text x="14" y="%d" fill="%s" font-size="11" transform="rotate(-90 14 %d)" text-anchor="middle">%s</text>'
                   % (pad_t + plot_h // 2, MUTED, pad_t + plot_h // 2, escape(ylabel)))
    n = max(1, len(xs))
    step = plot_w / max(1, n - 1) if n > 1 else 0
    for xi, label in enumerate(xs):
        x = pad_l + xi * step if n > 1 else pad_l + plot_w / 2
        out.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="%s" stroke-dasharray="2 4"/>' % (x, pad_t, x, pad_t + plot_h, GRID))
        out.append('<text x="%.1f" y="%d" fill="%s" text-anchor="middle">%s</text>' % (x, pad_t + plot_h + 18, TEXT, escape(str(label))))
    for si, name in enumerate(names):
        color = SERIES_COLORS[si % len(SERIES_COLORS)]
        pts = []
        for xi, v in enumerate(series[name]):
            if v is None:
                continue
            x = pad_l + xi * step if n > 1 else pad_l + plot_w / 2
            y = pad_t + plot_h - plot_h * min(v, top) / top
            pts.append((x, y, v))
        if len(pts) > 1:
            out.append('<polyline fill="none" stroke="%s" stroke-width="2" points="%s"/>'
                       % (color, " ".join("%.1f,%.1f" % (x, y) for x, y, _ in pts)))
        for x, y, v in pts:
            out.append('<circle cx="%.1f" cy="%.1f" r="3.5" fill="%s" stroke="%s"/>' % (x, y, BG, color))
            out.append('<text x="%.1f" y="%.1f" fill="%s" font-size="9" text-anchor="middle">%.3g</text>' % (x, y - 8, TEXT, v))
    lx = pad_l
    ly = height - 22
    for si, name in enumerate(names):
        color = SERIES_COLORS[si % len(SERIES_COLORS)]
        out.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="2"/>' % (lx, ly, lx + 14, ly, color))
        out.append('<text x="%d" y="%d" fill="%s" dominant-baseline="middle">%s</text>' % (lx + 20, ly, TEXT, escape(name)))
        lx += 20 + 7 * len(name) + 24
    out.append('</svg>')
    return "\n".join(out)
