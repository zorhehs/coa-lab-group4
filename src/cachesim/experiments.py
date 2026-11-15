"""
Parameter sweeps and comparison tables.

A sweep runs the same trace against many configurations and collects the
statistics so they can be charted (GUI) or written to CSV / SVG (scripts).
"""
from __future__ import annotations

import csv
import io
from typing import Any, Dict, List, Optional, Sequence

from .core import Cache, CacheConfig, ConfigError

SWEEPABLE = {
    "associativity": "Associativity (ways, 0 = full)",
    "block_size": "Block size (bytes)",
    "cache_size": "Cache size (bytes)",
    "replacement": "Replacement policy",
    "write_policy": "Write policy",
    "write_allocate": "Write allocate",
    "victim_entries": "Victim cache entries",
}

METRICS = {
    "hit_ratio": "Hit ratio",
    "miss_ratio": "Miss ratio",
    "amat": "AMAT (cycles)",
    "compulsory": "Compulsory misses",
    "capacity": "Capacity misses",
    "conflict": "Conflict misses",
    "victim_hits": "Victim hits",
    "writebacks": "Write-backs",
    "mem_reads": "Memory reads",
    "mem_writes": "Memory writes",
    "traffic_kib": "Memory traffic (KiB)",
    "dirty_lines": "Dirty lines left in cache",
    "mem_writes_flushed": "Memory writes incl. final flush",
    "traffic_flushed_kib": "Memory traffic incl. final flush (KiB)",
}


def _coerce(param: str, value: Any) -> Any:
    if param in ("associativity", "block_size", "cache_size", "victim_entries"):
        if isinstance(value, str) and value.strip().lower() in ("full", "fa"):
            return 0
        return int(value)
    if param == "write_allocate":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "wa", "allocate")
        return bool(value)
    return str(value).upper()


def label_for(param: str, value: Any) -> str:
    if param == "associativity":
        v = int(value)
        return "Full" if v == 0 else ("DM" if v == 1 else "%d-way" % v)
    if param in ("block_size", "cache_size"):
        v = int(value)
        return "%d KiB" % (v // 1024) if v >= 1024 and v % 1024 == 0 else "%d B" % v
    if param == "write_allocate":
        return "WA" if value else "NWA"
    if param == "victim_entries":
        return "VC=%d" % int(value)
    return str(value)


def sweep(base: CacheConfig, trace, param: str, values: Sequence[Any],
          series_param: Optional[str] = None, series_values: Optional[Sequence[Any]] = None
          ) -> List[Dict[str, Any]]:
    """Return one row per (series value, param value) with the full stats dict.

    Configurations that are impossible (e.g. 8-way in a 4-block cache) are
    reported with ``"error"`` instead of ``"stats"`` so the caller can skip them.
    """
    if param not in SWEEPABLE:
        raise ValueError("cannot sweep %r" % param)
    if series_param and series_param not in SWEEPABLE:
        raise ValueError("cannot sweep %r" % series_param)
    if series_param and not series_values:
        raise ValueError("series values are required when a series parameter is given")
    series = list(series_values or [None]) if series_param else [None]
    rows: List[Dict[str, Any]] = []
    base_d = base.to_dict()
    for sv in series:
        for v in values:
            d = {k: base_d[k] for k in CacheConfig.__dataclass_fields__}  # type: ignore[attr-defined]
            d[param] = _coerce(param, v)
            if series_param:
                d[series_param] = _coerce(series_param, sv)
            row: Dict[str, Any] = {
                "param": param, "value": d[param], "label": label_for(param, d[param]),
                "series": (label_for(series_param, d[series_param]) if series_param else None),
            }
            try:
                cfg = CacheConfig.from_dict(d)
                cache = Cache(cfg)
                cache.run(trace, keep_events=0)
                row["stats"] = cache.results()
                row["geometry"] = {"num_sets": cfg.num_sets, "ways": cfg.ways,
                                   "tag_bits": cfg.tag_bits, "index_bits": cfg.index_bits,
                                   "offset_bits": cfg.offset_bits}
            except ConfigError as e:
                row["error"] = str(e)
            rows.append(row)
    return rows


def rows_to_csv(rows: List[Dict[str, Any]], metrics: Sequence[str] = tuple(METRICS)) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["series", "param", "value", "label"] + list(metrics))
    for r in rows:
        if "error" in r:
            w.writerow([r["series"], r["param"], r["value"], r["label"], "ERROR: " + r["error"]])
            continue
        w.writerow([r["series"], r["param"], r["value"], r["label"]] +
                   [("%.4f" % r["stats"][m]) if isinstance(r["stats"][m], float) else r["stats"][m]
                    for m in metrics])
    return buf.getvalue()


def table(rows: List[Dict[str, Any]], metrics: Sequence[str] = ("hit_ratio", "miss_ratio",
          "compulsory", "capacity", "conflict", "writebacks", "amat")) -> str:
    """Plain-text table for the CLI."""
    headers = ["series", "config"] + [METRICS[m] for m in metrics]
    body = []
    for r in rows:
        if "error" in r:
            body.append([r["series"] or "-", r["label"], "error: " + r["error"]] + [""] * (len(metrics) - 1))
        else:
            cells = []
            for m in metrics:
                v = r["stats"][m]
                cells.append("%.4f" % v if isinstance(v, float) else str(v))
            body.append([r["series"] or "-", r["label"]] + cells)
    widths = [max(len(str(x)) for x in col) for col in zip(headers, *body)]
    fmt = "  ".join("%%-%ds" % w for w in widths)
    out = [fmt % tuple(headers), fmt % tuple("-" * w for w in widths)]
    out += [fmt % tuple(row) for row in body]
    return "\n".join(out)
