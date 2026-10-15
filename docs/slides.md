# Presentation Outline — 18 slides, ~22 minutes

Group 04 · Aliyan Zulfiqar, Shehroz Riaz · P07 Configurable Cache Memory Simulator

Suggested split: Aliyan slides 1–9, Shehroz slides 10–18. Keep each slide to one idea;
every chart is in `results/`, every screenshot comes from the live GUI.

| # | Slide | Content | Speaker notes |
|---|---|---|---|
| 1 | Title | Project, course, group, members, repo URL | 20 s |
| 2 | Why caches | Processor–memory gap; locality; one picture of the memory hierarchy | 1 min. "A cache is a bet on locality." |
| 3 | The design space | Mapping · block size · replacement · write policy — the four knobs (L13–14) | 1 min. These four become the four rows of our configuration panel. |
| 4 | Project goals | The five deliverables + metrics from the brief; constraint: stdlib only | 1 min |
| 5 | Architecture | `docs/architecture.svg` block diagram | 1.5 min. Engine runs once, emits events; GUI replays. |
| 6 | Address decoding | Formulae for sets / bits; worked `0x1A3C` example; **screenshot of ADDRESS DECODE** | 1.5 min |
| 7 | Mapping & replacement | One code path for DM / N-way / FA; LRU vs FIFO vs RANDOM victim choice table | 1 min |
| 8 | Write policies | 2×2 table WB/WT × WA/NWA; what each costs in memory traffic | 1.5 min |
| 9 | 3C miss classification | Compulsory / capacity / conflict definitions; the shadow FA cache trick | 1.5 min. "Conflict misses are exactly what more ways can remove." |
| 10 | **Live demo** | Textbook example stepped in the GUI (`data/textbook_dm.trace`, 32 B DM) | 3 min. Show M M H H M M H M matching the textbook. |
| 11 | Verification | Hand-worked examples → 39 unit tests; the victim-cache hand error we caught | 1 min |
| 12 | Trace generator | Six patterns and what each isolates (table) | 1 min |
| 13 | Result: associativity × policy | `fig1_assoc_vs_policy_conflict.svg` | 1.5 min. RANDOM beats LRU at 2-way here — ask why. |
| 14 | Result: block size | `fig2_block_size_vs_trace.svg` — sequential halves per doubling; column-major stuck at 1.0 | 1.5 min. Loop order matters: 768 conflict misses. |
| 15 | Result: cache size | `fig3_cache_size_miss_types_loop_large.svg` — the working-set step | 1 min |
| 16 | Result: write policy & victim cache | `fig4_write_policy_traffic_loop.svg` + `fig5_victim_cache_amat.svg` | 1.5 min. WT same hit ratio, 2.5× traffic; VC 101 → 9.1 cycles. |
| 17 | Extensions & limits | Victim cache, real traces via Valgrind; not modelled: data, timing of DRAM, multi-level | 1 min |
| 18 | Summary | One line per deliverable; what we learned; Q&A | 1 min |

## Demo checklist (slide 10)

1. `scripts/run_demo.sh --no-gui` already run; GUI open at `http://127.0.0.1:8077`.
2. Preset `textbook_dm.trace`; CACHE SIZE **32**, BLOCK SIZE **4 B**, MAPPING **DM** (8 sets, one
   word per block) — the Hennessy & Patterson configuration.
3. Step with the → key; point at the bit split, the flashing cell, the counters. The last
   access (word 18) evicts 26 from set 2, as in the textbook.
4. Switch MAPPING to 2-WAY mid-trace: counters re-run instantly.
5. Load `conflict.trace`, 1K / 16 B / DM: all red. Set VICTIM $ = 2: blue victim hits.
   Run sweep X = ASSOC, SERIES = REPL.
