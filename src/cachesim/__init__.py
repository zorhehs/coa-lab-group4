"""Configurable Cache Memory Simulator - COA Lab Project P07 (Group 04)."""
from .core import (AccessEvent, AddressFields, Cache, CacheConfig, ConfigError,
                   Stats, decode, simulate)
from .traces import (TraceError, generate, GENERATORS, GENERATOR_PARAMS,
                     parse_trace, format_trace)
from .experiments import sweep, rows_to_csv, table, SWEEPABLE, METRICS

__version__ = "1.0.0"
__all__ = [
    "AccessEvent", "AddressFields", "Cache", "CacheConfig", "ConfigError", "Stats",
    "decode", "simulate", "TraceError", "generate", "GENERATORS", "GENERATOR_PARAMS",
    "parse_trace", "format_trace", "sweep", "rows_to_csv", "table", "SWEEPABLE", "METRICS",
]
