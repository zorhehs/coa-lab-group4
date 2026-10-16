"""
Address-trace parsing and generation.

Trace file format (one access per line, ``#`` starts a comment)::

    R 0x00001A3C      # read
    W 0x00001A40      # write
    0 1A3C            # Dinero style: 0 = read, 1 = write (hex without prefix)
    L 04010000,4      # Valgrind "lackey" style: L load, S store, M modify (= R then W)

For ``R`` / ``W`` lines, addresses with a ``0x`` prefix (or any hex letter) are
hexadecimal and bare digits are decimal, which matches how textbook examples are
written.  Dinero (``0``/``1``) and lackey (``L``/``S``/``M``/``I``) lines are
always hexadecimal, as those tools emit them.
"""
from __future__ import annotations

import random
import re
from typing import Any, Dict, Iterable, List, Tuple

Access = Tuple[str, int]

_OP_MAP = {
    "R": "R", "W": "W", "READ": "R", "WRITE": "W",
    "0": "R", "1": "W",
    "L": "R", "S": "W",
}


class TraceError(ValueError):
    pass


def parse_address(token: str, force_hex: bool = False) -> int:
    t = token.strip().lower()
    if "," in t:                     # lackey style "addr,size"
        t = t.split(",", 1)[0]
    if t.startswith("0x"):
        return int(t, 16)
    if force_hex:
        if re.fullmatch(r"[0-9a-f]+", t):
            return int(t, 16)
        raise TraceError("bad address %r" % token)
    if t.startswith("0b"):
        return int(t, 2)
    if re.fullmatch(r"[0-9a-f]+", t) and re.search(r"[a-f]", t):
        return int(t, 16)
    if re.fullmatch(r"[0-9]+", t):
        return int(t, 10)
    raise TraceError("bad address %r" % token)


def parse_trace(text: str, include_instr: bool = False) -> List[Access]:
    """Parse trace text into a list of ``(op, address)`` tuples."""
    out: List[Access] = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        if raw.lstrip().startswith("=="):   # valgrind banner / summary lines
            continue
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.replace("\t", " ").split()
        if len(parts) == 1:          # bare address = read
            parts = ["R", parts[0]]
        op_tok, addr_tok = parts[0].upper(), parts[1]
        if op_tok == "I":            # instruction fetch (lackey)
            if include_instr:
                op_tok = "L"
            else:
                continue
        if op_tok in ("2", "3", "4"):  # dinero: 2 = instruction fetch, 3 / 4 = escape records
            if op_tok == "2" and include_instr:
                op_tok = "0"
            else:
                continue
        try:
            addr = parse_address(addr_tok, force_hex=op_tok in ("0", "1", "L", "S", "M"))
        except TraceError as e:
            raise TraceError("line %d: %s" % (lineno, e))
        if op_tok == "M":            # modify = read followed by write
            out.append(("R", addr))
            out.append(("W", addr))
            continue
        if op_tok not in _OP_MAP:
            raise TraceError("line %d: unknown operation %r" % (lineno, parts[0]))
        out.append((_OP_MAP[op_tok], addr))
    return out


def format_trace(accesses: Iterable[Access], header: str = "") -> str:
    lines = []
    if header:
        lines.extend("# " + h for h in header.splitlines())
    lines.extend("%s 0x%08X" % (op, addr) for op, addr in accesses)
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Generators
# --------------------------------------------------------------------------- #
def _positive(**params: Any) -> None:
    for name, value in params.items():
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise TraceError("%s must be a positive number (got %r)" % (name, value))


def _with_writes(addrs: List[int], write_ratio: float, rng: random.Random) -> List[Access]:
    return [("W" if rng.random() < write_ratio else "R", a) for a in addrs]


def gen_sequential(start: int = 0, count: int = 256, stride: int = 4,
                   write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Walk memory once: start, start+stride, ...  (streaming / array scan)."""
    _positive(stride=stride)
    rng = random.Random(seed)
    return _with_writes([start + i * stride for i in range(count)], write_ratio, rng)


def gen_loop(start: int = 0, array_bytes: int = 256, stride: int = 4, iterations: int = 4,
             write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Repeatedly sweep an array (the classic for-loop over a working set)."""
    _positive(stride=stride)
    rng = random.Random(seed)
    one_pass = [start + i for i in range(0, array_bytes, stride)]
    return _with_writes(one_pass * iterations, write_ratio, rng)


def gen_random(start: int = 0, range_bytes: int = 4096, count: int = 256, align: int = 4,
               write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Uniformly random word addresses inside a range (worst case for locality)."""
    _positive(align=align, range_bytes=range_bytes)
    rng = random.Random(seed)
    n = max(1, range_bytes // align)
    addrs = [start + rng.randrange(n) * align for _ in range(count)]
    return _with_writes(addrs, write_ratio, rng)


def gen_strided(start: int = 0, stride: int = 64, count: int = 256,
                write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Fixed large stride, e.g. walking one column of a row-major matrix."""
    _positive(stride=stride)
    rng = random.Random(seed)
    return _with_writes([start + i * stride for i in range(count)], write_ratio, rng)


def gen_matrix(n: int = 16, elem: int = 4, order: str = "row", start: int = 0,
               write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Traverse an n x n matrix of ``elem``-byte values in row- or column-major order."""
    _positive(n=n, elem=elem)
    rng = random.Random(seed)
    addrs = []
    if order == "row":
        for i in range(n):
            for j in range(n):
                addrs.append(start + (i * n + j) * elem)
    else:
        for j in range(n):
            for i in range(n):
                addrs.append(start + (i * n + j) * elem)
    return _with_writes(addrs, write_ratio, rng)


def gen_conflict(block_size: int = 16, cache_size: int = 1024, blocks: int = 3,
                 repeats: int = 8, write_ratio: float = 0.0, seed: int = 1) -> List[Access]:
    """Addresses exactly cache_size apart: same index, different tags (thrashing)."""
    rng = random.Random(seed)
    addrs = [k * cache_size for k in range(blocks)] * repeats
    return _with_writes(addrs, write_ratio, rng)


GENERATORS = {
    "sequential": gen_sequential,
    "loop": gen_loop,
    "random": gen_random,
    "strided": gen_strided,
    "matrix": gen_matrix,
    "conflict": gen_conflict,
}

GENERATOR_PARAMS: Dict[str, Dict[str, object]] = {
    "sequential": {"start": 0, "count": 256, "stride": 4, "write_ratio": 0.0, "seed": 1},
    "loop": {"start": 0, "array_bytes": 256, "stride": 4, "iterations": 4, "write_ratio": 0.0, "seed": 1},
    "random": {"start": 0, "range_bytes": 4096, "count": 256, "align": 4, "write_ratio": 0.0, "seed": 1},
    "strided": {"start": 0, "stride": 64, "count": 256, "write_ratio": 0.0, "seed": 1},
    "matrix": {"n": 16, "elem": 4, "order": "row", "start": 0, "write_ratio": 0.0, "seed": 1},
    "conflict": {"block_size": 16, "cache_size": 1024, "blocks": 3, "repeats": 8, "write_ratio": 0.0, "seed": 1},
}


def generate(kind: str, **params) -> List[Access]:
    if kind not in GENERATORS:
        raise TraceError("unknown generator %r (choose from %s)" % (kind, ", ".join(GENERATORS)))
    defaults = dict(GENERATOR_PARAMS[kind])
    for k, v in params.items():
        if k not in defaults:
            raise TraceError("generator %r has no parameter %r" % (kind, k))
        if isinstance(defaults[k], float):
            defaults[k] = float(v)
        elif isinstance(defaults[k], int):
            defaults[k] = int(v)
        else:
            defaults[k] = v
    return GENERATORS[kind](**defaults)  # type: ignore[arg-type]
