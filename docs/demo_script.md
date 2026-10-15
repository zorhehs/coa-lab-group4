# Demo Video Script (target 6–7 minutes, YouTube unlisted)

Group 04 · Aliyan Zulfiqar, Shehroz Riaz · P07 Configurable Cache Memory Simulator

Record the screen at 1920×1080 with the GUI full-screen; narrate over it. Before
recording run `scripts/run_demo.sh --no-gui` so `results/` is fresh, then
`PYTHONPATH=src python3 -m cachesim serve`.

| time | what is on screen | narration |
|---|---|---|
| 0:00–0:30 | Title card, then `docs/architecture.svg` | "This is CACHE-SIM, our configurable cache memory simulator for project P07. It's pure Python with a browser front end. The engine runs an address trace once and records what happened on every access; the GUI replays it so we can step in both directions." |
| 0:30–1:30 | GUI, default `loop.trace`, 1 KiB 4-way. Hover over CONFIGURATION and GEOMETRY | "Every design knob from the lectures is a switch: cache size, block size, mapping from direct-mapped to fully associative, LRU/FIFO/random replacement, write-back or write-through, allocate or not. The geometry readout updates live: 16 sets, 4 ways, and the 24/4/4 bit split." |
| 1:30–2:45 | ADDRESS DECODE. Type `0x1A3C` in PROBE, then press → a few times | "The probe decodes any address: offset 12, index 3, tag 0x1A. Now stepping the trace: each step is one access. Watch the bits, the cell flashing in set 3, and the counters. A red flash is a miss — the first touch of a block is compulsory." |
| 2:45–3:45 | Paste `textbook_dm.trace`, CACHE 64 B, BLOCK 4 B, DM. Step through all eight | "This is the direct-mapped example from Hennessy and Patterson. Miss, miss, hit, hit, miss, miss, hit, miss — the same table as the book. Our unit tests check this and seven other hand-worked cases." |
| 3:45–4:45 | Load `conflict.trace`, DM: all red. Switch to 2-WAY (still red), 4-WAY (green). Then back to DM and VICTIM $ = 2 (blue) | "Three blocks one cache-size apart share one set. Direct-mapped and 2-way thrash — every miss is a conflict miss. Four ways fix it. Or keep direct-mapped and add a two-entry victim cache: the blue victim hits avoid the memory reads and AMAT drops from 101 to 9 cycles." |
| 4:45–5:45 | EXPERIMENTS: X = BLOCK, load `matrix_col.trace` then `matrix_row.trace`; RUN SWEEP each | "Sweeps compare configurations on one trace. Walking a matrix row-major, bigger blocks halve the miss ratio each time. Column-major, the stride is 128 bytes, every column maps onto two sets, and the miss ratio stays at 100 percent whatever the block size — 768 conflict misses. Loop order matters." |
| 5:45–6:30 | X = WRITE, SERIES = ALLOC, METRIC = TRAFFIC on `loop.trace` | "Write policies don't change the hit ratio; they change bandwidth. Write-through sends all 188 writes to memory, write-back sends none here. Export CSV gives the table for the report." |
| 6:30–7:00 | Terminal: `python3 -m cachesim run --trace data/textbook_dm.trace --size 32 --block 4 --assoc 1 --steps`, then the `results/` folder | "Everything in the GUI is also on the command line, which is how all the figures in our report were generated. Code, tests, traces and results are in the repository. Thank you." |
