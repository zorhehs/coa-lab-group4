# Configurable Cache Memory Simulator

**Technical Report — COA Lab Semester Project P07**

| | |
|---|---|
| Course | Computer Architecture & Organization (BSCS) |
| Institution | National University of Sciences & Technology, Balochistan Campus — Department of Computer Science |
| Group | 04 |
| Members | Aliyan Zulfiqar (leader), Shehroz Riaz |
| Repository | `coa-lab-group4` (tag `v1.0`) |
| Semester | Fall 2024 |

---

## Abstract

Cache memory bridges the speed gap between the processor and main memory, and its
effectiveness depends on a handful of design choices: the mapping function, the block
size, the replacement policy and the write policy. This project implements CACHE-SIM, a
trace-driven cache simulator in pure Python that makes those choices configurable and
observable. The simulator supports direct-mapped, N-way set-associative and fully
associative mapping, any power-of-two cache and block size, LRU, FIFO and random
replacement, write-back and write-through with write-allocate or no-write-allocate, and
classifies every miss as compulsory, capacity or conflict using a shadow fully-associative
cache. A browser-based GUI, styled as a bench instrument, decodes each address into tag,
index and offset, animates hits and misses on the cache array, and runs parameter sweeps
with charts. A trace generator produces sequential, loop, random, strided, matrix and
conflict patterns; real program traces from Valgrind are also accepted. The simulator is
verified by 39 unit tests derived from hand-worked textbook examples. Experiments
reproduce the expected behaviour of each parameter and quantify, for example, that a
two-entry victim cache reduces AMAT on a thrashing direct-mapped cache from 101 to 9.1
cycles.

**Index Terms**—cache memory, set-associative mapping, replacement policy, write policy, 3C miss classification, trace-driven simulation, victim cache, computer architecture education.

---

## 1. Introduction and Motivation

Lectures 13–14 [7] introduce the cache as a small, fast memory whose benefit rests on the
principle of locality, and present its design space: how a block of main memory maps to
a cache line, how large a block is, which line is replaced when a set is full, and how
writes are propagated. Textbook examples trace a handful of accesses by hand. That is
sufficient to understand the mechanism but not to *feel* the trade-offs: how much
associativity buys, when a larger block hurts, why write-through costs bandwidth.

The goal of this project is a tool that bridges that gap. It had to:

1. implement every mapping, replacement and write policy from the course, configurable
   independently (deliverable 1);
2. show the address breakdown into tag, index and offset for any configuration (2);
3. generate address traces with controllable locality and accept external ones (3);
4. visualise hits and misses and compare configurations with charts (4);
5. report hit/miss ratios and the breakdown of misses into compulsory, capacity and
   conflict, and be *demonstrably correct* against hand-worked examples (evaluation
   metrics).

A deliberate constraint was to use only the Python standard library, so that the
instructor and any student can run the full tool, including the GUI, with one command
and nothing to install.

## 2. Design and Architecture

### 2.1 Block diagram

**[Figure 1: `docs/architecture.svg`]** The engine (`core.py`) is fed by a parser or a
generator and a configuration. For each access it decodes the address, looks up the
set, applies the replacement and write policies, consults a shadow fully-associative
cache to classify a miss, optionally probes a victim cache, updates the statistics and
emits an *access event*. Two front ends consume the events: a CLI that prints tables and
writes CSV/SVG, and a web GUI served by a small HTTP server. Because the browser only
replays events, all cache logic lives in one tested module.

### 2.2 Cache geometry and address decoding

For cache size *C*, block size *B* and associativity *A*: lines *N* = *C*/*B*, sets
*S* = *N*/*A* (one set when fully associative), offset bits = log₂*B*, index bits =
log₂*S*, tag bits = address width − index − offset. Powers of two are enforced so the
fields are whole bit ranges. Decoding is three shift/mask operations:
`offset = a mod B`, `index = (a div B) mod S`, `tag = (a div B) div S`.

Example (1 KiB, 16 B, 4-way, 32-bit): 16 sets, 4/4/24 bits; `0x1A3C` → tag `0x1A`,
set 3, offset 12. **[screenshot: ADDRESS DECODE panel]**

### 2.3 Mapping and replacement

A set is a list of lines, each with valid, tag, dirty, an LRU timestamp and a FIFO
timestamp. Direct-mapped is the one-way case and fully associative is the one-set case,
so a single code path serves all three mappings. Invalid lines are filled first; once a
set is full the victim is the line with the oldest LRU timestamp (LRU), the oldest fill
timestamp (FIFO) or a seeded random choice (RANDOM). Hits refresh the LRU timestamp
only, which is exactly what distinguishes LRU from FIFO (§4.1 of the hand-worked
examples).

### 2.4 Write policies

Write-back marks the line dirty on a write hit and writes the whole block back only when
a dirty line is evicted. Write-through writes the word to memory on every write and never
has dirty lines. On a write miss, write-allocate fetches the block and then proceeds as a
hit; no-write-allocate writes the word around the cache and allocates nothing. Memory
traffic is accounted in bytes (block size per fetch or write-back, word size per
write-through), which lets the write policies be compared on bandwidth, not only on hit
ratio, where they are identical.

### 2.5 Miss classification (3C)

A miss is *compulsory* if the block has never been brought into the cache (infinite-cache
definition). Otherwise the simulator asks a shadow fully-associative LRU cache with the
same number of lines whether *it* would have missed: if so the miss is *capacity*, if not
it is *conflict* — the miss exists only because the mapping forced too many blocks into
one set. This is the standard definition [3] and gives useful invariants: a
fully-associative cache never reports conflict misses, and the conflict count is
precisely what extra associativity can remove.

### 2.6 Extension: victim cache

A 2–8 entry fully-associative FIFO buffer [4] receives evicted lines; a main-cache miss that
hits in the victim cache swaps the line back without a memory read. Dirty lines keep
their dirty bit through the swap and are written back only when they fall out of the
victim cache.

### 2.7 GUI

**[screenshot: full GUI]** The interface is organised like a bench instrument: a
configuration rack (segmented switches, no drop-downs), a geometry readout, a trace
source (presets, generator, paste/file), the address-decode display with per-bit colour
coding, the cache array with valid/dirty LEDs, tag and LRU-age bars, counters, an access
log and an experiments module with sweep charts. A transport bar steps or plays the trace
at an adjustable rate. Caches with more than 64 sets switch to an activity map with a
detail window around the active set, so even a 32 KiB cache of 4-byte lines (8192 lines)
stays legible.

## 3. Implementation Details

Table*: Code base by component

| component | file | size |
|---|---|---|
| engine (config, decode, cache, 3C, victim cache, events) | `src/cachesim/core.py` | ~420 lines |
| trace parser and six generators | `src/cachesim/traces.py` | ~200 |
| sweeps, CSV, text tables | `src/cachesim/experiments.py` | ~150 |
| SVG charts | `src/cachesim/charts.py` | ~170 |
| CLI (`run`, `decode`, `gen`, `sweep`, `serve`) | `src/cachesim/cli.py` | ~230 |
| HTTP server + JSON API | `src/cachesim/server.py` | ~190 |
| GUI | `src/web/{index.html,style.css,app.js}` | ~1300 |
| tests | `tests/` | 39 tests |

**Access events.** Each access returns an `AccessEvent` containing the decoded fields,
set and way, result (`HIT`, `MISS`, `VICTIM`), miss type, eviction details, memory
operations, a human-readable note and the touched set before and after. The GUI folds
the first *k* events into the array state to show step *k*; stepping backwards is
therefore free and always consistent with the Python engine.

**Trace formats.** `R/W addr` (hex or decimal), Dinero [5] `0/1 addr` and Valgrind lackey [6]
`L/S/M/I addr,size` are accepted, so real program traces
(`valgrind --tool=lackey --trace-mem=yes`) can be loaded unchanged (extension: real
program traces).

**Generators.** sequential, loop (repeated sweeps over an array), random, strided,
matrix (row- or column-major walk of an n×n matrix) and conflict (k blocks exactly one
cache size apart). All are deterministic from a seed and take an optional write ratio.

**Long traces.** The server returns detailed events for the first 4000 accesses and the
final statistics and cache state for the whole trace; the GUI adds an END step for them.

**Testing.** Every expected value in the tests was first worked by hand
(`docs/hand_worked_examples.md`). While writing the victim-cache test we mis-traced which
block was dirty after a swap; the simulator's per-access log showed the actual sequence
and the hand analysis was corrected — an example of the tool doing what it is for.

## 4. Evaluation and Results

All numbers come from `scripts/experiments.py` (tables in `results/summary.md`; every
table lists the CLI command that reproduces it). Reference configuration unless stated:
1 KiB, 16 B blocks, 4-way, LRU, write-back/write-allocate, hit 1 cycle, miss penalty 100.

### 4.1 Correctness against hand-worked examples

The Hennessy & Patterson [1] direct-mapped sequence (22, 26, 22, 26, 16, 3, 16, 18 on eight
one-word blocks) gives `M M H H M M H M`, hit ratio 0.375, with block 18 displacing 26
in set 2 — exactly the textbook table. LRU vs FIFO on the sequence 0, 4, 0, 8, 0 gives
two hits vs one. The conflict sequence 0, 4, 0, 4, 0, 4 on a 4-line direct-mapped cache
yields 2 compulsory + 4 conflict misses; the same count on a fully-associative cache with a
5-block working set yields 5 compulsory + 5 capacity. All 39 tests pass.

### 4.2 Associativity and replacement policy (Figure 4, `fig1_assoc_vs_policy_conflict.svg`)

Conflict trace: three blocks 1 KiB apart, repeated 16 times (48 accesses).

Table: Hit ratio vs mapping and replacement policy, conflict trace

| mapping | LRU | FIFO | RANDOM |
|---|---:|---:|---:|
| direct mapped | 0.000 | 0.000 | 0.000 |
| 2-way | 0.000 | 0.000 | 0.354 |
| 4-way / 8-way / full | 0.938 | 0.938 | 0.938 |

Three blocks cycling through one set need at least three ways. With two ways LRU and FIFO
both evict exactly the block needed next (the classic LRU pathology), while RANDOM
sometimes keeps it, so it is the *best* policy here. All 45 non-compulsory misses are
classified as conflict, and they vanish at 4 ways — the 3C counter tells the designer
directly that associativity, not capacity, is the fix.

### 4.3 Block size and spatial locality (Figure 5, `fig2_block_size_vs_trace.svg`)

Table: Miss ratio vs block size, 1 KiB 4-way LRU

| block | sequential | matrix row-major | matrix column-major | random |
|---|---:|---:|---:|---:|
| 4 B | 1.000 | 1.000 | 1.000 | 0.963 |
| 16 B | 0.250 | 0.250 | 1.000 | 0.938 |
| 64 B | 0.063 | 0.063 | 1.000 | 0.912 |
| 128 B | 0.031 | 0.031 | 1.000 | 0.914 |

For streaming access the miss ratio is 1/(words per block), halving with every doubling
of the block. Random access barely benefits. The column-major matrix walk (stride 128 B)
misses on every access regardless of block size: with 16 sets the 32 blocks of a column
all map to sets 0 and 8, so each column evicts the previous one — 768 of its 1024 misses
are conflict misses, versus zero for the row-major walk of the same data. This is the
simulator's clearest demonstration of why loop order matters.

### 4.4 Cache size and capacity misses (Figure 6, `fig3_cache_size_miss_types_loop_large.svg`)

A 2 KiB working set swept three times (`loop_large`, 1536 accesses):

Table: Cache size vs miss ratio and capacity misses, loop_large

| cache | 256 B | 512 B | 1 KiB | 2 KiB | 4 KiB |
|---|---:|---:|---:|---:|---:|
| miss ratio | 0.250 | 0.250 | 0.250 | 0.083 | 0.083 |
| capacity misses | 256 | 256 | 256 | 0 | 0 |

Below the working-set size every sweep re-fetches every block (capacity misses); at 2 KiB
only the 128 compulsory misses remain. The miss ratio does not improve gradually — it
drops in one step once the working set fits, a key lesson of the course.

### 4.5 Write policies and memory traffic (Figure 7, `fig4_write_policy_*.svg`)

Loop trace, 768 accesses, 25 % writes:

Table: Write policies on the loop trace

| policy | hit ratio | memory writes | traffic |
|---|---:|---:|---:|
| write-back, write-allocate | 0.958 | 0 | 0.50 KiB |
| write-through, write-allocate | 0.958 | 188 | 1.23 KiB |
| write-back, no-write-allocate | 0.936 | 17 | 0.57 KiB |
| write-through, no-write-allocate | 0.936 | 188 | 1.23 KiB |

Hit ratio is identical for WB and WT; the difference is bandwidth — write-through sends
every one of the 188 writes to memory, write-back sends none because the array fits in
the cache and nothing dirty is ever evicted. No-write-allocate lowers the hit ratio
because the lines written are not brought in for the later reads.

### 4.6 Victim cache (Figure 8, `fig5_victim_cache_amat.svg`)

Direct-mapped 1 KiB:

Table: AMAT (cycles) vs victim-cache entries, direct-mapped 1 KiB

| victim entries | conflict trace AMAT | strided AMAT |
|---|---:|---:|
| 0 | 101.0 | 101.0 |
| 2 | 9.1 | 101.0 |

Two entries are enough to catch all 45 conflict misses of the thrashing trace (AMAT
101 → 9.1 cycles), while a strided trace that never revisits a block gains nothing —
the victim cache only helps conflict misses, which is its design purpose.

### 4.7 All traces under one configuration (Figure 9, `fig6_all_traces_reference_config.svg`)

Table: Every trace under the reference configuration

| trace | hit ratio | compulsory | capacity | conflict |
|---|---:|---:|---:|---:|
| loop | 0.958 | 32 | 0 | 0 |
| sequential | 0.750 | 128 | 0 | 0 |
| matrix row | 0.750 | 256 | 0 | 0 |
| loop_large | 0.750 | 128 | 256 | 0 |
| random | 0.063 | 405 | 71 | 4 |
| matrix column | 0.000 | 256 | 0 | 768 |

Each trace isolates one kind of miss, which is what makes the set useful for teaching.

## 5. Conclusion

CACHE-SIM meets all five deliverables with a single, dependency-free code base that is
verified against hand-worked examples and exposes every course concept — mapping, block
size, replacement, write policy, the 3C miss model and AMAT — as a live control with
immediate visual feedback. The experiments reproduce the behaviours taught in L13–14 and
add quantitative detail: associativity removes conflict misses but only beyond the number
of competing blocks; block size helps streaming access and not random access; cache size
helps in a step at the working-set size; write-through costs bandwidth rather than hit
ratio; a tiny victim cache can rescue a direct-mapped cache from thrashing. Both
extensions (victim cache, real program traces) are implemented. Future work: a
multi-level hierarchy with AMAT composition, prefetching, and a timing model with
realistic DRAM latencies.

## References

1. J. L. Hennessy and D. A. Patterson, *Computer Organization and Design*, 5th ed., Morgan Kaufmann, 2014, ch. 5.
2. W. Stallings, *Computer Organization and Architecture*, 10th ed., Pearson, 2016, ch. 4.
3. M. D. Hill, *Aspects of Cache Memory and Instruction Buffer Performance*, PhD thesis, UC Berkeley, 1987 (the 3C model).
4. N. P. Jouppi, "Improving direct-mapped cache performance by the addition of a small fully-associative cache and prefetch buffers," *ISCA*, 1990.
5. J. Edler and M. D. Hill, *Dinero IV Trace-Driven Uniprocessor Cache Simulator*, 1998.
6. Valgrind Developers, *Lackey: an example tool*, Valgrind User Manual.
7. Course slides, Computer Architecture & Organization L13–L16, NUST Balochistan Campus, Fall 2024.

## Appendix

### A. Running the project

```
scripts/run_demo.sh                 # tests, traces, example, sweeps, figures, GUI
PYTHONPATH=src python3 -m cachesim serve
```

### B. Core of the access algorithm (`core.py`, abridged)

```python
way = self._find(index, tag)
allocate = (op == "R") or cfg.write_allocate
first_touch = block not in self.seen_blocks
if allocate: self.seen_blocks.add(block)
shadow_hit = self.shadow.access(block, allocate)
if way >= 0:                                  # hit
    line.last_used = self.clock
    if op == "W": (mark dirty) if WB else (write word to memory)
else:                                         # miss
    miss_type = "compulsory" if first_touch else ("capacity" if not shadow_hit else "conflict")
    if allocate:
        way = self._choose_victim(index)      # invalid first, then LRU / FIFO / RANDOM
        if evicting dirty line: write back (or move to victim cache)
        fetch block; fill tag/valid; dirty = (op == "W" and WB)
    else:
        write word to memory                  # no-write-allocate
```

### C. Step-by-step output for the textbook example

```
step op address      set  way result  miss type
   1  R 0x00000058     6    0 MISS    compulsory
   2  R 0x00000068     2    0 MISS    compulsory
   3  R 0x00000058     6    0 HIT
   4  R 0x00000068     2    0 HIT
   5  R 0x00000040     0    0 MISS    compulsory
   6  R 0x0000000C     3    0 MISS    compulsory
   7  R 0x00000040     0    0 HIT
   8  R 0x00000048     2    0 MISS    compulsory  evicted clean tag 0x3 from way 0
hit ratio 0.3750
```

### D. Figures

Figure 1 `docs/architecture.svg`; Figures 2–3 `docs/screenshot_decode.png` and
`docs/screenshot_gui.jpg`; Figures 4–9 `results/fig1…fig6*.svg`. All are regenerated by
`scripts/build_docs.py`.
