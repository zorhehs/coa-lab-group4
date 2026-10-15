import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from cachesim import (CacheConfig, TraceError, generate, parse_trace, format_trace,  # noqa: E402
                      sweep, rows_to_csv, table)
from cachesim.charts import bar_chart_svg, line_chart_svg  # noqa: E402
from cachesim.server import handle_api, ApiError  # noqa: E402


class TestParse(unittest.TestCase):
    def test_formats(self):
        text = """
        # comment
        R 0x10
        W 0x14   # trailing comment
        0 1A3C
        1 0x20
        L 04010000,4
        S 4010008,8
        M 0x30,4
        I 0x1000,4
        42
        """
        acc = parse_trace(text)
        self.assertEqual(acc, [("R", 0x10), ("W", 0x14), ("R", 0x1A3C), ("W", 0x20),
                               ("R", 0x04010000), ("W", 0x4010008), ("R", 0x30), ("W", 0x30),
                               ("R", 42)])
        self.assertEqual(len(parse_trace(text, include_instr=True)), 10)

    def test_errors(self):
        with self.assertRaises(TraceError):
            parse_trace("R zz")
        with self.assertRaises(TraceError):
            parse_trace("X 0x10")

    def test_roundtrip(self):
        acc = [("R", 16), ("W", 0x1A3C)]
        self.assertEqual(parse_trace(format_trace(acc, "hello")), acc)


class TestGenerators(unittest.TestCase):
    def test_each_generator_runs(self):
        for kind in ("sequential", "loop", "random", "strided", "matrix", "conflict"):
            acc = generate(kind)
            self.assertTrue(acc)
            self.assertTrue(all(op in "RW" and a >= 0 for op, a in acc))

    def test_loop_shape(self):
        acc = generate("loop", array_bytes=64, stride=4, iterations=3)
        self.assertEqual(len(acc), 16 * 3)
        self.assertEqual([a for _, a in acc[:4]], [0, 4, 8, 12])

    def test_matrix_orders(self):
        row = [a for _, a in generate("matrix", n=4, elem=4, order="row")]
        col = [a for _, a in generate("matrix", n=4, elem=4, order="col")]
        self.assertEqual(row[:4], [0, 4, 8, 12])
        self.assertEqual(col[:4], [0, 16, 32, 48])

    def test_write_ratio_and_seed(self):
        a = generate("random", count=200, write_ratio=0.5, seed=3)
        b = generate("random", count=200, write_ratio=0.5, seed=3)
        self.assertEqual(a, b)
        writes = sum(1 for op, _ in a if op == "W")
        self.assertTrue(60 < writes < 140)

    def test_bad_param(self):
        with self.assertRaises(TraceError):
            generate("loop", bogus=1)


class TestSweep(unittest.TestCase):
    def test_associativity_sweep_monotone_for_conflict_trace(self):
        trace = generate("conflict", block_size=16, cache_size=256, blocks=3, repeats=10)
        base = CacheConfig(cache_size=256, block_size=16)
        rows = sweep(base, trace, "associativity", [1, 2, 4, 0])
        hr = [r["stats"]["hit_ratio"] for r in rows]
        self.assertEqual(hr[0], 0.0)                  # DM thrashes completely
        self.assertEqual(hr[1], 0.0)                  # 2-way LRU with 3 blocks cycling also thrashes
        self.assertGreater(hr[2], 0.8)                # 4-way holds all three
        self.assertEqual(hr[2], hr[3])

    def test_invalid_rows_reported(self):
        trace = generate("loop")
        rows = sweep(CacheConfig(cache_size=64, block_size=16), trace, "associativity", [1, 2, 8])
        self.assertIn("error", rows[2])
        self.assertIn("stats", rows[0])

    def test_series_and_csv(self):
        trace = generate("loop", array_bytes=512, iterations=2, write_ratio=0.3)
        rows = sweep(CacheConfig(), trace, "block_size", [16, 32], "write_policy", ["WB", "WT"])
        self.assertEqual(len(rows), 4)
        csv = rows_to_csv(rows)
        self.assertEqual(len(csv.strip().splitlines()), 5)
        self.assertIn("hit_ratio", csv.splitlines()[0])
        self.assertIn("WB", table(rows))


class TestCharts(unittest.TestCase):
    def test_svgs_render(self):
        svg = bar_chart_svg("t", ["a", "b"], {"s1": [0.5, 0.75], "s2": [None, 0.2]}, ylabel="y")
        self.assertTrue(svg.startswith("<svg"))
        self.assertIn("n/a", svg)
        svg2 = line_chart_svg("t", ["1", "2", "3"], {"x": [1, 2, 3]})
        self.assertIn("polyline", svg2)


class TestApi(unittest.TestCase):
    def test_meta_and_simulate(self):
        meta = handle_api("GET", "/api/meta", {})
        self.assertIn("generators", meta)
        gen = handle_api("POST", "/api/generate", {"kind": "loop", "params": {"array_bytes": 64, "iterations": 2}})
        self.assertEqual(gen["count"], 32)
        res = handle_api("POST", "/api/simulate", {"config": {"cache_size": 64, "block_size": 16},
                                                   "trace": gen["text"], "event_limit": 10})
        self.assertEqual(res["stats"]["accesses"], 32)
        self.assertEqual(len(res["events"]), 10)
        self.assertTrue(res["truncated"])
        dec = handle_api("POST", "/api/decode", {"config": {"cache_size": 1024, "block_size": 16,
                                                            "associativity": 4}, "address": "0x1A3C"})
        self.assertEqual(dec["fields"]["index"], 3)
        sw = handle_api("POST", "/api/sweep", {"config": {}, "trace": gen["text"], "param": "associativity",
                                               "values": [1, 2]})
        self.assertEqual(len(sw["rows"]), 2)

    def test_errors(self):
        with self.assertRaises(ApiError):
            handle_api("POST", "/api/simulate", {"config": {"cache_size": 100}, "trace": "R 0"})
        with self.assertRaises(ApiError):
            handle_api("POST", "/api/simulate", {"config": {}, "trace": "Q 0"})
        with self.assertRaises(ApiError):
            handle_api("GET", "/api/traces/../secret.trace", {})


if __name__ == "__main__":
    unittest.main()
