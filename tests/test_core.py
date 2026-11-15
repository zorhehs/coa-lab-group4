"""
Correctness tests against hand-worked examples.

Every expected value below was worked by hand first (see
docs/hand_worked_examples.md); the simulator is checked against them, not the
other way around.  Run with:  python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from cachesim import Cache, CacheConfig, ConfigError, decode, simulate  # noqa: E402


def run_blocks(cfg, block_addrs, op="R"):
    """Access a list of *block* addresses (word 0 of each block)."""
    cache = Cache(cfg)
    events = [cache.access(op, b * cfg.block_size) for b in block_addrs]
    return cache, events


def pattern(events):
    return "".join("H" if e.result == "HIT" else ("V" if e.result == "VICTIM" else "M") for e in events)


class TestGeometry(unittest.TestCase):
    def test_1k_16b_4way(self):
        cfg = CacheConfig(cache_size=1024, block_size=16, associativity=4)
        self.assertEqual(cfg.num_blocks, 64)
        self.assertEqual(cfg.num_sets, 16)
        self.assertEqual((cfg.tag_bits, cfg.index_bits, cfg.offset_bits), (24, 4, 4))

    def test_direct_mapped(self):
        cfg = CacheConfig(cache_size=32, block_size=4, associativity=1)
        self.assertEqual(cfg.num_sets, 8)
        self.assertEqual(cfg.index_bits, 3)
        self.assertEqual(cfg.mapping_name, "Direct mapped")

    def test_fully_associative(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=0)
        self.assertTrue(cfg.is_fully_associative)
        self.assertEqual(cfg.num_sets, 1)
        self.assertEqual(cfg.index_bits, 0)
        self.assertEqual(cfg.ways, 4)
        self.assertEqual(CacheConfig(cache_size=64, block_size=16, associativity=4).mapping_name,
                         "Fully associative")

    def test_invalid_configs(self):
        with self.assertRaises(ConfigError):
            CacheConfig(cache_size=1000)
        with self.assertRaises(ConfigError):
            CacheConfig(cache_size=64, block_size=16, associativity=8)
        with self.assertRaises(ConfigError):
            CacheConfig(block_size=3)
        with self.assertRaises(ConfigError):
            CacheConfig(replacement="MRU")

    def test_from_dict_accepts_full(self):
        cfg = CacheConfig.from_dict({"cache_size": 256, "block_size": 32, "associativity": "full"})
        self.assertTrue(cfg.is_fully_associative)


class TestAddressDecode(unittest.TestCase):
    def test_1a3c(self):
        cfg = CacheConfig(cache_size=1024, block_size=16, associativity=4)
        f = decode(cfg, 0x1A3C)
        self.assertEqual(f.offset, 0xC)
        self.assertEqual(f.index, 3)
        self.assertEqual(f.tag, 0x1A)
        self.assertEqual(f.block_address, 0x1A3)
        self.assertEqual(len(f.binary), 32)
        self.assertEqual(f.tag_binary + f.index_binary + f.offset_binary, f.binary)
        self.assertEqual(f.index_binary, "0011")
        self.assertEqual(f.offset_binary, "1100")

    def test_fully_associative_has_no_index(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=0)
        f = decode(cfg, 0x1A3C)
        self.assertEqual(f.index, 0)
        self.assertEqual(f.index_binary, "")
        self.assertEqual(f.tag, 0x1A3C >> 4)

    def test_decode_masks_to_address_width(self):
        cfg = CacheConfig(cache_size=256, block_size=16, address_bits=16)
        self.assertEqual(decode(cfg, 0x1_0010).address, 0x0010)


class TestTextbookDirectMapped(unittest.TestCase):
    """Hennessy & Patterson style: 8 one-word blocks, word addresses
    22, 26, 22, 26, 16, 3, 16, 18 -> miss miss hit hit miss miss hit miss."""

    def test_sequence(self):
        cfg = CacheConfig(cache_size=32, block_size=4, associativity=1)
        cache, ev = run_blocks(cfg, [22, 26, 22, 26, 16, 3, 16, 18])
        self.assertEqual(pattern(ev), "MMHHMMHM")
        self.assertEqual([e.set_index for e in ev], [6, 2, 6, 2, 0, 3, 0, 2])
        # the last access replaces block 26 (tag 3) in set 2 with block 18 (tag 2)
        self.assertEqual(ev[-1].evicted["tag"], 3)
        self.assertEqual(ev[-1].set_after[0]["tag"], 2)
        self.assertEqual(cache.results()["hit_ratio"], 3 / 8)
        # all five misses are first touches
        self.assertEqual(cache.results()["compulsory"], 5)


class TestReplacementPolicies(unittest.TestCase):
    """2-way set associative, 4 sets. Blocks 0, 4, 8 all map to set 0."""

    def cfg(self, repl):
        return CacheConfig(cache_size=128, block_size=16, associativity=2, replacement=repl)

    def test_lru_vs_fifo_differ(self):
        seq = [0, 4, 0, 8, 0]
        _, lru = run_blocks(self.cfg("LRU"), seq)
        _, fifo = run_blocks(self.cfg("FIFO"), seq)
        # LRU: 0M 4M 0H 8M(evicts 4) 0H  -> 2 hits
        self.assertEqual(pattern(lru), "MMHMH")
        self.assertEqual(lru[3].evicted["tag"], 1)       # block 4 has tag 1
        # FIFO: 0M 4M 0H 8M(evicts 0, oldest fill) 0M -> 1 hit
        self.assertEqual(pattern(fifo), "MMHMM")
        self.assertEqual(fifo[3].evicted["tag"], 0)

    def test_lru_thrash(self):
        _, ev = run_blocks(self.cfg("LRU"), [0, 4, 8] * 2)
        self.assertEqual(pattern(ev), "MMMMMM")

    def test_random_is_reproducible_and_valid(self):
        cfg = CacheConfig(cache_size=128, block_size=16, associativity=2, replacement="RANDOM", seed=7)
        a = pattern(run_blocks(cfg, [0, 4, 8, 0, 4, 8, 12, 0])[1])
        b = pattern(run_blocks(cfg, [0, 4, 8, 0, 4, 8, 12, 0])[1])
        self.assertEqual(a, b)
        self.assertEqual(a[:2], "MM")            # empty ways fill first

    def test_lru_age_ranks(self):
        cache, ev = run_blocks(self.cfg("LRU"), [0, 4, 0])
        ranks = [w["age"] for w in ev[-1].set_after]
        self.assertEqual(ranks, [0, 1])          # way 0 (block 0) most recent


class TestMissClassification(unittest.TestCase):
    def test_conflict_misses(self):
        # direct mapped, 4 blocks; blocks 0 and 4 share set 0 -> conflict thrash
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1)
        cache, ev = run_blocks(cfg, [0, 4, 0, 4, 0, 4])
        self.assertEqual(pattern(ev), "MMMMMM")
        self.assertEqual([e.miss_type for e in ev], ["compulsory", "compulsory"] + ["conflict"] * 4)
        r = cache.results()
        self.assertEqual((r["compulsory"], r["capacity"], r["conflict"]), (2, 0, 4))

    def test_capacity_misses(self):
        # fully associative, 4 blocks, working set of 5 blocks cycled -> capacity
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=0, replacement="LRU")
        cache, ev = run_blocks(cfg, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4])
        self.assertEqual(pattern(ev), "MMMMMMMMMM")
        r = cache.results()
        self.assertEqual((r["compulsory"], r["capacity"], r["conflict"]), (5, 5, 0))

    def test_same_sequence_2way_is_conflict_free(self):
        # 4 blocks as 2-way: blocks 0..3 fit, so repeated sweeps hit after warm-up
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=2)
        cache, ev = run_blocks(cfg, [0, 1, 2, 3] * 3)
        self.assertEqual(pattern(ev), "MMMM" + "HHHH" * 2)
        self.assertEqual(cache.results()["conflict"], 0)

    def test_spatial_locality_within_block(self):
        cfg = CacheConfig(cache_size=1024, block_size=16, associativity=1)
        cache = Cache(cfg)
        ev = [cache.access("R", a) for a in range(0, 32, 4)]   # 8 words, 2 blocks
        self.assertEqual(pattern(ev), "MHHHMHHH")


    def test_fully_associative_lru_never_reports_conflict_but_fifo_can(self):
        # 4 lines, blocks 0 1 2 3, re-use 0, bring in 4, then 0 again.
        # LRU evicts 1 for block 4, so the last access hits.  FIFO evicts 0 (oldest fill),
        # so the last access misses although the LRU shadow cache still holds block 0:
        # that miss is reported as "conflict" even though the cache is fully associative.
        blocks = [0, 1, 2, 3, 0, 4, 0]
        lru, _ = run_blocks(CacheConfig(cache_size=64, block_size=16, associativity=0, replacement="LRU"), blocks)
        self.assertEqual(lru.stats.conflict, 0)
        self.assertEqual(lru.stats.misses, 5)
        fifo, ev = run_blocks(CacheConfig(cache_size=64, block_size=16, associativity=0, replacement="FIFO"), blocks)
        self.assertEqual(ev[-1].result, "MISS")
        self.assertEqual(ev[-1].miss_type, "conflict")
        self.assertEqual(fifo.stats.conflict, 1)


class TestWritePolicies(unittest.TestCase):
    def test_write_back_marks_dirty_and_writes_back_on_eviction(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, write_policy="WB")
        cache = Cache(cfg)
        e1 = cache.access("W", 0)             # miss, allocate, dirty
        self.assertEqual(e1.result, "MISS")
        self.assertTrue(e1.mem_read)
        self.assertTrue(e1.dirty_after)
        self.assertEqual(cache.stats.mem_writes, 0)
        e2 = cache.access("R", 64)            # same set (index 0), evicts dirty block 0
        self.assertTrue(e2.writeback)
        self.assertTrue(e2.evicted["dirty"])
        self.assertEqual(cache.stats.writebacks, 1)
        self.assertEqual(cache.stats.mem_writes, 1)
        self.assertEqual(cache.stats.traffic_bytes, 16 * 3)   # 2 fetches + 1 write-back

    def test_write_through_writes_every_time(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, write_policy="WT", write_allocate=True)
        cache = Cache(cfg)
        cache.access("W", 0)                  # miss: fetch + write through
        cache.access("W", 4)                  # hit: write through
        cache.access("R", 64)                 # evicts block 0: clean, no write-back
        s = cache.stats
        self.assertEqual(s.mem_writes, 2)
        self.assertEqual(s.writebacks, 0)
        self.assertEqual(s.traffic_bytes, 16 * 2 + 4 * 2)

    def test_no_write_allocate(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, write_policy="WT", write_allocate=False)
        cache = Cache(cfg)
        e = cache.access("W", 0)
        self.assertEqual(e.result, "MISS")
        self.assertIsNone(e.way)
        self.assertFalse(e.mem_read)
        self.assertTrue(e.mem_write)
        self.assertFalse(cache.sets[0][0].valid)       # nothing allocated
        e2 = cache.access("R", 0)                       # block was never fetched: still compulsory
        self.assertEqual(e2.result, "MISS")
        self.assertEqual(e2.miss_type, "compulsory")
        self.assertTrue(e2.mem_read)

    def test_read_write_hit_counts(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=2)
        cache = Cache(cfg)
        for op, a in [("R", 0), ("W", 0), ("R", 4), ("W", 128), ("R", 128)]:
            cache.access(op, a)
        s = cache.stats
        self.assertEqual((s.reads, s.writes), (3, 2))
        self.assertEqual((s.read_hits, s.read_misses, s.write_hits, s.write_misses), (2, 1, 1, 1))


    def test_dirty_lines_left_at_end_are_charged_by_the_flushed_totals(self):
        # W 0, W 16: two dirty lines, nothing evicted -> no memory write during the trace,
        # but the cache still owes memory two block writes.
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, write_policy="WB")
        cache = Cache(cfg)
        cache.run([("W", 0), ("W", 16), ("W", 4)])
        r = cache.results()
        self.assertEqual(r["mem_writes"], 0)
        self.assertEqual(r["traffic_bytes"], 16 * 2)                  # 2 fetches
        self.assertEqual(r["dirty_lines"], 2)
        self.assertEqual(r["mem_writes_flushed"], 2)
        self.assertEqual(r["traffic_flushed_bytes"], 16 * 2 + 16 * 2)  # + 2 block write-backs

    def test_write_through_has_nothing_to_flush(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, write_policy="WT")
        cache = Cache(cfg)
        cache.run([("W", 0), ("W", 16), ("W", 4)])
        r = cache.results()
        self.assertEqual(r["dirty_lines"], 0)
        self.assertEqual(r["mem_writes_flushed"], r["mem_writes"])
        self.assertEqual(r["traffic_flushed_bytes"], r["traffic_bytes"])

    def test_dirty_line_counter_matches_the_cache_contents(self):
        from cachesim import generate
        for victim in (0, 2):
            for allocate in (True, False):
                for repl in ("LRU", "FIFO", "RANDOM"):
                    cfg = CacheConfig(cache_size=128, block_size=16, associativity=2, replacement=repl,
                                      write_policy="WB", write_allocate=allocate, victim_entries=victim)
                    cache = Cache(cfg)
                    for op, addr in generate("random", count=400, range_bytes=1024, write_ratio=0.4, seed=7):
                        cache.access(op, addr, want_event=False)
                        self.assertEqual(cache.stats.dirty_lines, cache.count_dirty())


class TestVictimCache(unittest.TestCase):
    def test_victim_catches_conflict_thrash(self):
        base = dict(cache_size=64, block_size=16, associativity=1)
        _, without = run_blocks(CacheConfig(**base), [0, 4, 0, 4, 0, 4])
        cache, with_vc = run_blocks(CacheConfig(victim_entries=2, **base), [0, 4, 0, 4, 0, 4])
        self.assertEqual(pattern(without), "MMMMMM")
        self.assertEqual(pattern(with_vc), "MMVVVV")
        r = cache.results()
        self.assertEqual(r["victim_hits"], 4)
        self.assertEqual(r["mem_reads"], 2)            # only the two compulsory misses go to memory
        self.assertLess(r["amat"], Cache(CacheConfig(**base)).results()["amat"] + 100)

    def test_victim_keeps_dirty_data(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, victim_entries=1, write_policy="WB")
        cache = Cache(cfg)
        cache.access("W", 0)        # dirty block 0
        cache.access("R", 64)       # evict block 0 into victim cache (no write-back yet)
        self.assertEqual(cache.stats.writebacks, 0)
        e = cache.access("R", 0)    # victim hit, block comes back dirty
        self.assertEqual(e.result, "VICTIM")
        self.assertTrue(e.dirty_after)
        # set 0 now holds block 0 (dirty); the victim cache holds block 4 (clean)
        cache.access("R", 128)      # evicts dirty block 0 into VC, pushing clean block 4 out: no write-back
        self.assertEqual(cache.stats.writebacks, 0)
        cache.access("R", 192)      # evicts block 8 (clean) into VC, pushing dirty block 0 out -> write-back
        self.assertEqual(cache.stats.writebacks, 1)
        self.assertEqual(cache.stats.mem_writes, 1)


class TestEventsAndSimulate(unittest.TestCase):
    def test_event_snapshots_and_limit(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=2)
        res = simulate(cfg, [("R", 0), ("R", 64), ("R", 0)], keep_events=2)
        self.assertTrue(res["truncated"])
        self.assertEqual(len(res["events"]), 2)
        self.assertEqual(res["stats"]["accesses"], 3)
        e = res["events"][1]
        self.assertEqual(e["set_before"][1]["valid"], False)
        self.assertEqual(e["set_after"][1]["valid"], True)
        self.assertEqual(res["final_state"][0][0]["tag"], 0)
        self.assertEqual(res["stats"]["hit_ratio"], 1 / 3)

    def test_amat(self):
        cfg = CacheConfig(cache_size=64, block_size=16, associativity=1, hit_time=1, miss_penalty=100)
        cache, _ = run_blocks(cfg, [0, 0, 0, 1])     # 2 misses / 4
        self.assertAlmostEqual(cache.results()["amat"], 1 + 0.5 * 100)


if __name__ == "__main__":
    unittest.main()
