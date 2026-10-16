"""
Command-line interface.

    python -m cachesim run    --trace data/loop.trace --size 1024 --block 16 --assoc 4
    python -m cachesim run    --gen loop array_bytes=512 iterations=3 --steps
    python -m cachesim decode 0x1A3C --size 1024 --block 16 --assoc 4
    python -m cachesim gen    random count=500 range_bytes=8192 -o data/random.trace
    python -m cachesim sweep  --trace data/loop.trace --param associativity --values 1,2,4,8,0
    python -m cachesim serve  --port 8077
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List, Tuple

from . import __version__
from .core import Cache, CacheConfig, ConfigError, decode
from .experiments import METRICS, SWEEPABLE, rows_to_csv, sweep, table
from .traces import (GENERATOR_PARAMS, TraceError, format_trace, generate, parse_trace)


def _add_config_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("cache configuration")
    g.add_argument("--size", type=int, default=1024, help="cache size in bytes (default 1024)")
    g.add_argument("--block", type=int, default=16, help="block size in bytes (default 16)")
    g.add_argument("--assoc", default="1", help="ways per set; 1 = direct mapped, 0/full = fully associative")
    g.add_argument("--repl", default="LRU", choices=["LRU", "FIFO", "RANDOM", "lru", "fifo", "random"])
    g.add_argument("--write", default="WB", choices=["WB", "WT", "wb", "wt"], help="WB write-back, WT write-through")
    g.add_argument("--no-allocate", action="store_true", help="no-write-allocate on write miss")
    g.add_argument("--addr-bits", type=int, default=32)
    g.add_argument("--victim", type=int, default=0, help="victim cache entries (extension)")
    g.add_argument("--hit-time", type=float, default=1.0)
    g.add_argument("--miss-penalty", type=float, default=100.0)
    g.add_argument("--seed", type=int, default=1)


def _config_from_args(a: argparse.Namespace) -> CacheConfig:
    return CacheConfig(cache_size=a.size, block_size=a.block, associativity=a.assoc,
                       replacement=a.repl, write_policy=a.write, write_allocate=not a.no_allocate,
                       address_bits=a.addr_bits, victim_entries=a.victim, hit_time=a.hit_time,
                       miss_penalty=a.miss_penalty, seed=a.seed)


def _kv(pairs: List[str]) -> dict:
    out = {}
    for p in pairs:
        if "=" not in p:
            raise TraceError("expected key=value, got %r" % p)
        k, v = p.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _load_trace(a: argparse.Namespace) -> Tuple[List[Tuple[str, int]], str]:
    if a.trace:
        with open(a.trace) as fh:
            return parse_trace(fh.read()), a.trace
    if a.gen:
        return generate(a.gen, **_kv(a.gen_args)), "generated:%s" % a.gen
    raise TraceError("give --trace FILE or --gen KIND")


def cmd_run(a: argparse.Namespace) -> int:
    cfg = _config_from_args(a)
    trace, name = _load_trace(a)
    cache = Cache(cfg)
    events = cache.run(trace, keep_events=None if a.steps else 0)
    res = cache.results()
    if a.json:
        print(json.dumps({"config": cfg.to_dict(), "trace": name, "stats": res,
                          "events": [e.to_dict() for e in events] if a.steps else []}, indent=2))
        return 0
    print("CACHE-SIM %s   trace: %s (%d accesses)" % (__version__, name, len(trace)))
    print("  %s, %d B, block %d B, %d sets x %d ways | %s | %s"
          % (cfg.mapping_name, cfg.cache_size, cfg.block_size, cfg.num_sets, cfg.ways,
             cfg.replacement, cfg.write_name))
    print("  address: %d bits = tag %d | index %d | offset %d"
          % (cfg.address_bits, cfg.tag_bits, cfg.index_bits, cfg.offset_bits))
    if a.steps:
        print()
        print("  %5s %2s %-10s %5s %4s %-7s %-10s %s" % ("step", "op", "address", "set", "way", "result", "miss type", "note"))
        for e in events:
            print("  %5d %2s 0x%08X %5d %4s %-7s %-10s %s"
                  % (e.step, e.op, e.address, e.set_index, "-" if e.way is None else e.way,
                     e.result, e.miss_type or "", e.note))
    print()
    print("  accesses %d  hits %d  misses %d   hit ratio %.4f  miss ratio %.4f"
          % (res["accesses"], res["hits"], res["misses"], res["hit_ratio"], res["miss_ratio"]))
    print("  misses by type: compulsory %d  capacity %d  conflict %d"
          % (res["compulsory"], res["capacity"], res["conflict"]))
    print("  memory: reads %d  writes %d  write-backs %d  traffic %.2f KiB  victim hits %d"
          % (res["mem_reads"], res["mem_writes"], res["writebacks"], res["traffic_kib"], res["victim_hits"]))
    print("  AMAT = %.3f cycles (hit %.1f, penalty %.1f)" % (res["amat"], cfg.hit_time, cfg.miss_penalty))
    return 0


def cmd_decode(a: argparse.Namespace) -> int:
    cfg = _config_from_args(a)
    try:
        addr = int(a.address, 0)
    except ValueError:
        raise ValueError("not an address: %r (use decimal, 0x hex or 0b binary)" % a.address)
    if addr < 0:
        raise ValueError("address must not be negative: %r" % a.address)
    f = decode(cfg, addr)
    d = f.to_dict()
    if a.json:
        print(json.dumps(d, indent=2))
        return 0
    print("address %s  (%d-bit)" % (d["hex"], cfg.address_bits))
    print("  binary : %s %s %s" % (d["tag_binary"], d["index_binary"] or "-", d["offset_binary"]))
    print("  tag    : %s  (%d bits)" % (d["tag_hex"], cfg.tag_bits))
    print("  index  : %d  (%d bits) -> set %d of %d" % (f.index, cfg.index_bits, f.index, cfg.num_sets))
    print("  offset : %d  (%d bits)" % (f.offset, cfg.offset_bits))
    print("  block  : %d" % f.block_address)
    return 0


def cmd_gen(a: argparse.Namespace) -> int:
    params = _kv(a.gen_args)
    trace = generate(a.kind, **params)
    text = format_trace(trace, header="generator: %s %s\n%d accesses"
                        % (a.kind, " ".join("%s=%s" % kv for kv in params.items()), len(trace)))
    if a.output:
        with open(a.output, "w") as fh:
            fh.write(text)
        print("wrote %d accesses to %s" % (len(trace), a.output))
    else:
        sys.stdout.write(text)
    return 0


def cmd_sweep(a: argparse.Namespace) -> int:
    cfg = _config_from_args(a)
    trace, name = _load_trace(a)
    values = [v.strip() for v in a.values.split(",")]
    series_values = [v.strip() for v in a.series_values.split(",")] if a.series_values else None
    rows = sweep(cfg, trace, a.param, values, a.series, series_values)
    if a.csv:
        with open(a.csv, "w") as fh:
            fh.write(rows_to_csv(rows))
        print("wrote %s" % a.csv)
    if a.svg:
        from .charts import bar_chart_svg
        cats = []
        series = {}
        for r in rows:
            if r["label"] not in cats:
                cats.append(r["label"])
        for r in rows:
            series.setdefault(r["series"] or a.metric, [None] * len(cats))
            if "stats" in r:
                series[r["series"] or a.metric][cats.index(r["label"])] = r["stats"][a.metric]
        svg = bar_chart_svg("%s vs %s" % (METRICS[a.metric], SWEEPABLE[a.param]), cats, series,
                            ylabel=METRICS[a.metric], subtitle="trace: %s" % name)
        with open(a.svg, "w") as fh:
            fh.write(svg)
        print("wrote %s" % a.svg)
    if not a.csv and not a.svg or a.print:
        cols = ["hit_ratio", "miss_ratio", "compulsory", "capacity", "conflict", "writebacks", "amat"]
        if a.param == "victim_entries" or cfg.victim_entries:
            cols.insert(5, "victim_hits")
        if a.metric not in cols:
            cols.append(a.metric)
        print(table(rows, cols))
    return 0


def cmd_serve(a: argparse.Namespace) -> int:
    from .server import serve
    serve(host=a.host, port=a.port, open_browser=not a.no_browser)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="cachesim", description="Configurable cache memory simulator (COA Lab P07)")
    p.add_argument("--version", action="version", version="cachesim " + __version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="simulate a trace and print statistics")
    r.add_argument("--trace", help="trace file")
    r.add_argument("--gen", choices=sorted(GENERATOR_PARAMS), help="generate a trace instead of reading one")
    r.add_argument("gen_args", nargs="*", help="generator parameters key=value")
    r.add_argument("--steps", action="store_true", help="print every access")
    r.add_argument("--json", action="store_true")
    _add_config_args(r)
    r.set_defaults(fn=cmd_run)

    d = sub.add_parser("decode", help="show the tag / index / offset breakdown of an address")
    d.add_argument("address", help="e.g. 0x1A3C or 6716")
    d.add_argument("--json", action="store_true")
    _add_config_args(d)
    d.set_defaults(fn=cmd_decode)

    g = sub.add_parser("gen", help="generate a trace file")
    g.add_argument("kind", choices=sorted(GENERATOR_PARAMS))
    g.add_argument("gen_args", nargs="*", help="generator parameters key=value")
    g.add_argument("-o", "--output")
    g.set_defaults(fn=cmd_gen)

    s = sub.add_parser("sweep", help="run a parameter sweep")
    s.add_argument("--trace")
    s.add_argument("--gen", choices=sorted(GENERATOR_PARAMS))
    s.add_argument("gen_args", nargs="*")
    s.add_argument("--param", required=True, choices=sorted(SWEEPABLE))
    s.add_argument("--values", required=True, help="comma separated, e.g. 1,2,4,8,0")
    s.add_argument("--series", choices=sorted(SWEEPABLE), help="second parameter to plot as series")
    s.add_argument("--series-values")
    s.add_argument("--metric", default="hit_ratio", choices=sorted(METRICS))
    s.add_argument("--csv")
    s.add_argument("--svg")
    s.add_argument("--print", action="store_true", help="also print the table when writing files")
    _add_config_args(s)
    s.set_defaults(fn=cmd_sweep)

    v = sub.add_parser("serve", help="start the web GUI")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8077)
    v.add_argument("--no-browser", action="store_true")
    v.set_defaults(fn=cmd_serve)

    a = p.parse_args(argv)
    try:
        return a.fn(a)
    except (ConfigError, TraceError, OSError, ValueError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
