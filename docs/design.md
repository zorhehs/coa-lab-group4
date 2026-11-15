# Design and Architecture

## 1. Overview

CACHE-SIM is a *trace-driven, functional* cache simulator: it does not model the data
stored in the cache, only the **tags, valid / dirty bits and replacement state** that
decide whether an access hits or misses and what traffic it causes. That is exactly the
level at which cache design decisions are studied in the course (L13–14): mapping
function, block size, replacement policy and write policy.

```
                       ┌──────────────────────────────────────────────┐
   trace file /        │                 cachesim (Python)            │
   generator ────────► │  traces.py ──► core.Cache ──► Stats / Events │
                       │                   │  ▲                        │
                       │        decode() ──┘  │ shadow FA cache (3C)   │
                       │                      │ victim cache (ext.)    │
                       │  experiments.py (sweeps)   charts.py (SVG)    │
                       │  cli.py ◄──── server.py (HTTP + JSON API)     │
                       └───────────────┬───────────────▲──────────────┘
                                       │ events, stats │ config, trace
                                       ▼               │
                       ┌──────────────────────────────────────────────┐
                       │  web/ (browser GUI, bench-instrument theme)   │
                       │  decode view · cache array · counters · log  │
                       │  step / play transport · sweeps and charts   │
                       └──────────────────────────────────────────────┘
```

The engine runs the trace **once**; every access produces an `AccessEvent` that records
the address fields, the set and way touched, the result, the miss type, any eviction or
write-back, and the touched set *before and after*. The GUI replays those events, so
stepping backwards and forwards is instantaneous and the browser never re-implements
cache logic (single source of truth).

See `docs/architecture.svg` for the block diagram used in the report.

## 2. Cache geometry

Given cache size *C*, block size *B* and associativity *A* (ways per set; 0 = fully
associative):

| quantity | formula |
|---|---|
| number of lines | *N* = *C* / *B* |
| ways | *A* (or *N* when fully associative) |
| sets | *S* = *N* / *A* |
| offset bits | log₂ *B* |
| index bits | log₂ *S* (0 for fully associative) |
| tag bits | address bits − index bits − offset bits |

All sizes must be powers of two so the fields are whole bit ranges. `CacheConfig`
validates this and raises `ConfigError` with a readable message (the GUI shows it in the
configuration panel instead of silently ignoring the setting).

**Address decode** (`core.decode`):

```
offset        = address & (B − 1)
block_address = address >> offset_bits
index         = block_address & (S − 1)
tag           = block_address >> index_bits
```

Example, 1 KiB / 16 B / 4-way (16 sets): `0x1A3C` → offset `0xC`, index `3`, tag `0x1A`.

## 3. Access algorithm

```
access(op, addr):
    f = decode(addr)
    set = sets[f.index]
    way = find way with valid and tag == f.tag
    allocate = (op == R) or write_allocate
    first_touch = block never allocated before          (compulsory test)
    shadow_hit = shadowFA.access(block, allocate)        (capacity/conflict test)

    if way found:                                  ── HIT ──
        update LRU timestamp
        if op == W: WB → mark dirty ; WT → write word to memory
    else:                                          ── MISS ──
        miss_type = compulsory if first_touch
                    else capacity if not shadow_hit
                    else conflict
        if victim cache enabled and block in victim cache: result = VICTIM (no memory read)
        if allocate:
            way = first invalid way, else victim by policy (LRU / FIFO / RANDOM)
            if evicting a valid line:
                victim cache enabled → move line to victim cache (write back if VC overflows a dirty line)
                else dirty → write back block
            fetch block from memory (unless it came from the victim cache)
            fill tag, valid, timestamps; dirty = (op == W and WB)
            if op == W and WT: write word to memory
        else:                                      (write miss, no-write-allocate)
            write word straight to memory
```

### Replacement policies

| policy | victim choice | hit updates |
|---|---|---|
| LRU | smallest `last_used` | `last_used` ← clock |
| FIFO | smallest `inserted` | none |
| RANDOM | `random.Random(seed)` | none |

Invalid ways are always filled first, so the policies only matter once a set is full.
The seed makes RANDOM reproducible (the same trace always gives the same result, which
matters for the tests and for the report).

### Write policies

| | write hit | write miss (write-allocate) | write miss (no-write-allocate) | eviction |
|---|---|---|---|---|
| **write-back** | set dirty | fetch block, set dirty | write word to memory | dirty → write block back |
| **write-through** | write word to memory | fetch block, write word to memory | write word to memory | nothing |

Memory traffic is accounted in bytes: a block fetch or write-back moves *B* bytes, a
write-through moves one `word_size` (4 B).

**Dirty lines left at the end.** A write-back cache that never evicts a dirty line shows
no memory writes during the trace, but it still owes memory one block write per dirty
line. The simulator counts those lines (`dirty_lines`, main cache plus victim cache) and
reports *flushed* totals that add the debt: `mem_writes_flushed = mem_writes + dirty_lines`
and `traffic_flushed = traffic + dirty_lines × B`. The per-step counters are unchanged, so
hand-worked traces still match; write-back and write-through are compared on the flushed
totals, where every write has reached memory under both policies.

## 4. Miss classification (3C model)

Following Hill's three-C model:

* **Compulsory** — the block has never been brought into the cache before (an infinite
  cache would also miss). With no-write-allocate a write miss does not bring the block
  in, so a later read of it is still compulsory.
* **Capacity** — not compulsory, and a **fully-associative LRU cache of the same number
  of lines** would also miss. The simulator keeps that *shadow cache* alongside the real
  one and consults it on every access.
* **Conflict** — not compulsory, and the shadow fully-associative cache would have hit:
  the miss is caused only by the mapping (too few ways for the blocks competing for that
  set).

The shadow cache is always LRU, whatever the real cache uses. With FIFO or RANDOM
replacement a fully-associative cache can therefore miss on a block the LRU shadow still
holds; that miss is labelled *conflict* although no mapping restriction exists. Read it as
"lost to the replacement policy, relative to LRU".

This is the standard definition used by Dinero-style simulators. It makes some results
intuitive to verify: a fully-associative **LRU** cache can never report a conflict miss
(it is the shadow cache), and a direct-mapped cache thrashing between two blocks reports two compulsory misses and then
only conflict misses.

Victim-cache hits are still counted as misses of the main cache (and classified) but they
do not cost a memory read; the counters report them separately as *victim hits*.

## 5. Victim cache (extension)

A small fully-associative buffer (2–8 entries) that holds lines evicted from the main
cache (Jouppi, 1990). On a main-cache miss the victim cache is probed; a hit swaps the
line back without a memory access. Lines leave the victim cache FIFO; a dirty line that
falls out is written back then. In the GUI the victim cache appears as a strip under the
cache array; in the counters as VICTIM HITS; in AMAT as `victim_hit_ratio × victim_penalty`.

## 6. Metrics

| metric | definition |
|---|---|
| hit ratio | hits / accesses (main cache only) |
| miss ratio | 1 − hit ratio |
| memory miss ratio | (misses − victim hits) / accesses |
| AMAT | `hit_time + memory_miss_ratio × miss_penalty + victim_hit_ratio × victim_penalty` |
| traffic | bytes moved between cache and memory (fetches + write-backs + write-throughs) |
| dirty lines | dirty lines still held (main + victim cache), i.e. block writes still owed |
| traffic incl. flush | traffic + dirty lines × block size |

## 7. Traces

`traces.py` parses three common formats (R/W, Dinero `0/1`, Valgrind lackey `L/S/M/I`)
and generates six synthetic patterns, each deterministic from a seed:

| generator | pattern | what it demonstrates |
|---|---|---|
| sequential | one pass over an array | spatial locality: miss ratio = 1 / (words per block) |
| loop | repeated passes over an array | temporal locality; capacity misses once the array exceeds the cache |
| random | uniform random words in a range | almost no locality |
| strided | fixed large stride | one miss per access when stride ≥ block size |
| matrix | n×n row-major or column-major walk | power-of-two strides mapping onto few sets → conflict misses |
| conflict | k blocks exactly one cache size apart | textbook set thrashing; needs ≥ k ways |

## 8. GUI architecture

* `server.py` is a `ThreadingHTTPServer` serving `src/web` and a JSON API
  (`/api/meta`, `/api/traces`, `/api/generate`, `/api/decode`, `/api/simulate`, `/api/sweep`).
* `app.js` keeps a small state object (config, trace text, simulation result, current
  step). `rebuildGrid(step)` folds the `set_after` snapshots of the first *step* events
  into an array that the CACHE ARRAY panel renders; the touched cell gets a one-shot CSS
  animation (green hit, red miss, blue victim hit).
* Long traces: the server keeps detailed events for the first 4000 accesses and returns
  full final statistics and the final cache state; the GUI adds an END step that shows
  them.
* Charts are generated as inline SVG by `app.js` (GUI) and `charts.py` (CLI / report) in
  the same visual style; no plotting library is required.

## 9. Design decisions

* **Standard library only.** The grader can run it on any machine with Python; nothing to
  `pip install`, no version conflicts. The GUI is a static page talking to the same engine
  the CLI uses, so GUI and report numbers can never disagree.
* **Events, not re-execution, for stepping.** Replaying snapshots makes backwards
  stepping trivial and keeps all cache logic in one place (Python), where it is unit
  tested.
* **Tests before trust.** Every policy has a hand-worked example in
  `docs/hand_worked_examples.md` that the test suite checks, including an eviction
  sequence for the victim cache that we initially got wrong by hand and fixed by tracing
  the simulator's log — the tool is useful precisely because the bookkeeping is easy to
  get wrong.
