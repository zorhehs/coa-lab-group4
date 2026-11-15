# Hand-Worked Examples

These are the examples the unit tests (`tests/test_core.py`) check the simulator against.
Each one can also be reproduced in the GUI (paste the trace, set the configuration) or on
the command line.

Notation: *block addresses* are written as integers; the byte address is
`block × block_size`. M = miss, H = hit, V = victim-cache hit.

---

## 1. Address breakdown — 1 KiB, 16 B blocks, 4-way, 32-bit addresses

* lines = 1024 / 16 = 64, sets = 64 / 4 = 16
* offset bits = log₂16 = 4, index bits = log₂16 = 4, tag bits = 32 − 8 = 24

Address `0x1A3C` = `0000 0000 0000 0000 0001 1010 0011 1100`₂

| field | bits | value |
|---|---|---|
| offset | `1100` | 12 (0xC) |
| index | `0011` | 3 → set 3 |
| tag | `…0001 1010` | 0x1A |
| block address | `0x1A3C >> 4` | 0x1A3 = 419 |

```
python -m cachesim decode 0x1A3C --size 1024 --block 16 --assoc 4
```

---

## 2. Direct mapped — Hennessy & Patterson's example

Cache: 8 one-word (4 B) blocks → 32 B, direct mapped. Word addresses accessed:
22, 26, 22, 26, 16, 3, 16, 18. Index = word mod 8.

| # | word | binary | index | tag | result | set after |
|---|---|---|---|---|---|---|
| 1 | 22 | 10110 | 6 | 2 | M (compulsory) | set 6 ← 22 |
| 2 | 26 | 11010 | 2 | 3 | M (compulsory) | set 2 ← 26 |
| 3 | 22 | 10110 | 6 | 2 | **H** | |
| 4 | 26 | 11010 | 2 | 3 | **H** | |
| 5 | 16 | 10000 | 0 | 2 | M (compulsory) | set 0 ← 16 |
| 6 | 3 | 00011 | 3 | 0 | M (compulsory) | set 3 ← 3 |
| 7 | 16 | 10000 | 0 | 2 | **H** | |
| 8 | 18 | 10010 | 2 | 2 | M (compulsory) — evicts 26 | set 2 ← 18 |

Result: `M M H H M M H M`, hit ratio 3/8 = 0.375, 5 compulsory misses, 0 conflict
(block 18 had never been loaded, so by the infinite-cache definition its miss is
compulsory even though it displaces 26).

```
python -m cachesim run --trace data/textbook_dm.trace --size 32 --block 4 --assoc 1 --steps
```

---

## 3. LRU vs FIFO — 2-way, 4 sets (128 B, 16 B blocks)

Blocks 0, 4, 8 all have index 0 (block mod 4 = 0). Sequence: **0, 4, 0, 8, 0**.

**LRU**

| access | set 0 before (MRU first) | result | set 0 after |
|---|---|---|---|
| 0 | — | M | [0] |
| 4 | [0] | M | [4, 0] |
| 0 | [4, 0] | H | [0, 4] |
| 8 | [0, 4] | M — evict LRU = **4** | [8, 0] |
| 0 | [8, 0] | **H** | [0, 8] |

Pattern `M M H M H`, 2 hits.

**FIFO**

| access | set 0 before (newest first) | result | set 0 after |
|---|---|---|---|
| 0 | — | M | [0] |
| 4 | [0] | M | [4, 0] |
| 0 | [4, 0] | H (order unchanged) | [4, 0] |
| 8 | [4, 0] | M — evict oldest fill = **0** | [8, 4] |
| 0 | [8, 4] | **M** | [0, 8] |

Pattern `M M H M M`, 1 hit. The hit on block 0 did not refresh it under FIFO, so it was
thrown out first.

**LRU thrash**: sequence 0, 4, 8, 0, 4, 8 with 2 ways → every access misses
(`M M M M M M`); three blocks cycling through two ways is the classic case where LRU is
worst.

---

## 4. Conflict vs capacity misses

**Conflict** — direct mapped, 4 blocks (64 B / 16 B). Blocks 0 and 4 share set 0.
Sequence 0, 4, 0, 4, 0, 4:

| access | result | type | why |
|---|---|---|---|
| 0 | M | compulsory | first touch |
| 4 | M | compulsory | first touch |
| 0 | M | **conflict** | a 4-line fully-associative cache would still hold 0 |
| 4 | M | conflict | |
| 0 | M | conflict | |
| 4 | M | conflict | |

→ compulsory 2, capacity 0, conflict 4.

**Capacity** — fully associative, 4 blocks, LRU. Sequence 0,1,2,3,4,0,1,2,3,4:
the working set (5 blocks) is larger than the cache, every access after the first four
evicts the block that will be needed next.

→ all 10 miss: compulsory 5, **capacity 5**, conflict 0 (a fully-associative LRU cache
can never have a conflict miss).

**FIFO in a fully-associative cache** — 4 blocks, sequence 0,1,2,3,0,4,0. The shadow
cache is LRU: the re-use of 0 makes 1 the oldest, so 4 evicts 1 and the last access hits.
FIFO ignores the re-use, evicts 0 (first filled) for 4, and the last access misses.

→ LRU: 5 misses, conflict 0. FIFO: 6 misses, the last one labelled **conflict** because
the LRU shadow still holds block 0. It is a replacement-policy loss, not a mapping one.

**Same four blocks, 2-way**: sequence (0,1,2,3) × 3 → `MMMM HHHH HHHH`, no conflict,
because the four blocks fit in the four lines.

---

## 5. Spatial locality — 1 KiB direct mapped, 16 B blocks

Reading words 0, 4, 8, 12, 16, 20, 24, 28 (8 words, two blocks):
`M H H H M H H H` — one miss per block of 4 words → miss ratio 0.25 = 1 / (words per block).
(Figure 2 in the report shows this scaling with block size on the sequential trace.)

---

## 6. Write policies — direct mapped, 4 × 16 B lines

**Write-back, write-allocate**

| access | result | memory | note |
|---|---|---|---|
| W 0 | M | read 1 block | line 0 allocated, **dirty** |
| R 64 | M | read 1 block, **write 1 block** | block 4 maps to set 0, evicts dirty block 0 → write-back |

Totals: mem reads 2, write-backs 1, traffic 3 × 16 = 48 B.

**Write-through, write-allocate**

| access | result | memory |
|---|---|---|
| W 0 | M | read 1 block + write 1 word |
| W 4 | H | write 1 word |
| R 64 | M | read 1 block (evicted line is clean: no write-back) |

Totals: mem writes 2, write-backs 0, traffic 2 × 16 + 2 × 4 = 40 B.

**Dirty lines left at the end** (write-back): `W 0`, `W 16`, `W 4` → M, M, H. Two blocks
fetched (32 B), nothing evicted, so 0 memory writes during the trace, but lines 0 and 1
are both dirty. Flushing them costs 2 block writes: writes incl. flush 2, traffic incl.
flush 32 + 2 × 16 = 64 B. The same trace under write-through leaves nothing to flush.

**No-write-allocate** (write-through): `W 0` → miss, 1 word written to memory, **nothing
allocated**, no block read. A following `R 0` is a miss again, and is **compulsory**
because the block has still never been fetched.

---

## 7. Victim cache — direct mapped, 4 lines, 2-entry victim cache

Sequence 0, 4, 0, 4, 0, 4 (the conflict example of §4):

| access | main cache | victim cache | result |
|---|---|---|---|
| 0 | M, set 0 ← 0 | | M |
| 4 | M, evict 0 → VC, set 0 ← 4 | [0] | M |
| 0 | miss in main, **found in VC**; evict 4 → VC, set 0 ← 0 | [4] | **V** |
| 4 | found in VC | [0] | V |
| 0 | found in VC | [4] | V |
| 4 | found in VC | [0] | V |

Pattern `M M V V V V`: only 2 memory reads instead of 6. AMAT with hit 1, miss 100,
victim 2: (1 + 2/6·100 + 4/6·2) ≈ 35.7 vs 101 without the victim cache.

**Dirty data survives the swap** (1-entry VC, write-back):

| access | effect | write-backs |
|---|---|---|
| W 0 | block 0 dirty in set 0 | 0 |
| R 64 | evict dirty 0 → VC (no write-back yet) | 0 |
| R 0 | victim hit; 0 returns to set 0 **still dirty**; 4 → VC | 0 |
| R 128 | evict dirty 0 → VC, pushing clean 4 out | 0 |
| R 192 | evict clean 8 → VC, pushing **dirty 0** out → write-back | **1** |

---

## 8. AMAT

Direct mapped, 4 lines, hit 1 cycle, miss penalty 100. Sequence 0, 0, 0, 1 (blocks):
2 misses of 4 → miss ratio 0.5 → AMAT = 1 + 0.5 × 100 = 51 cycles.
