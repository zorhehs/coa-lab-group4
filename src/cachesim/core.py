"""
Core cache model for the Configurable Cache Memory Simulator (COA Lab, P07).

The model is deliberately explicit rather than clever so that every step can be
checked against a hand-worked example:

* ``CacheConfig``   - geometry and policy knobs, plus the derived bit widths.
* ``decode``        - splits an address into tag / index / offset.
* ``Cache``         - the simulated cache: sets of lines, replacement policy,
                      write policy, optional victim cache and the shadow
                      fully-associative cache used to classify misses into
                      compulsory / capacity / conflict (the "3C" model).
* ``AccessEvent``   - everything that happened during one access, including the
                      state of the touched set before and after, so a front end
                      can replay the trace step by step without re-running it.

Only the Python standard library is used.
"""
from __future__ import annotations

import random
from collections import OrderedDict
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

REPLACEMENT_POLICIES = ("LRU", "FIFO", "RANDOM")
WRITE_POLICIES = ("WB", "WT")  # write-back / write-through


def _is_pow2(n: int) -> bool:
    return isinstance(n, int) and n > 0 and (n & (n - 1)) == 0


class ConfigError(ValueError):
    """Raised when a cache configuration is not physically realisable."""


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
@dataclass
class CacheConfig:
    """All user-controllable parameters of the simulated cache.

    ``associativity`` is the number of ways per set.  ``1`` is direct mapped and
    ``0`` means fully associative (one set holding every block).
    """

    cache_size: int = 1024          # bytes
    block_size: int = 16            # bytes per line
    associativity: int = 1          # ways; 0 = fully associative
    replacement: str = "LRU"        # LRU | FIFO | RANDOM
    write_policy: str = "WB"        # WB = write-back, WT = write-through
    write_allocate: bool = True     # allocate a line on a write miss?
    address_bits: int = 32
    victim_entries: int = 0         # extension: fully-associative victim cache
    word_size: int = 4              # bytes written to memory by a WT write
    hit_time: float = 1.0           # cycles, for AMAT
    miss_penalty: float = 100.0     # cycles, for AMAT
    victim_penalty: float = 2.0     # extra cycles for a hit in the victim cache
    seed: int = 1                   # RANDOM replacement is reproducible

    def __post_init__(self) -> None:
        self.replacement = str(self.replacement).upper()
        self.write_policy = str(self.write_policy).upper()
        if self.write_policy in ("WRITE-BACK", "WRITEBACK", "WRITE_BACK"):
            self.write_policy = "WB"
        if self.write_policy in ("WRITE-THROUGH", "WRITETHROUGH", "WRITE_THROUGH"):
            self.write_policy = "WT"
        if isinstance(self.associativity, str):
            a = self.associativity.strip().lower()
            self.associativity = 0 if a in ("full", "fa", "fully", "0") else int(a)
        for name in ("cache_size", "block_size", "associativity", "address_bits",
                     "victim_entries", "word_size", "seed"):
            setattr(self, name, int(getattr(self, name)))
        self.write_allocate = bool(self.write_allocate)
        self.hit_time = float(self.hit_time)
        self.miss_penalty = float(self.miss_penalty)
        self.victim_penalty = float(self.victim_penalty)
        self.validate()

    # ---- validation -------------------------------------------------------
    def validate(self) -> None:
        if not _is_pow2(self.cache_size):
            raise ConfigError("cache_size must be a power of two (got %d)" % self.cache_size)
        if not _is_pow2(self.block_size):
            raise ConfigError("block_size must be a power of two (got %d)" % self.block_size)
        if self.block_size > self.cache_size:
            raise ConfigError("block_size (%d) cannot exceed cache_size (%d)"
                              % (self.block_size, self.cache_size))
        if self.associativity < 0:
            raise ConfigError("associativity must be >= 0")
        if self.associativity and not _is_pow2(self.associativity):
            raise ConfigError("associativity must be a power of two or 0 (fully associative)")
        if self.associativity > self.num_blocks:
            raise ConfigError("associativity (%d) exceeds number of blocks (%d)"
                              % (self.associativity, self.num_blocks))
        if self.replacement not in REPLACEMENT_POLICIES:
            raise ConfigError("replacement must be one of %s" % (REPLACEMENT_POLICIES,))
        if self.write_policy not in WRITE_POLICIES:
            raise ConfigError("write_policy must be one of %s" % (WRITE_POLICIES,))
        if not (8 <= self.address_bits <= 64):
            raise ConfigError("address_bits must be between 8 and 64")
        if self.tag_bits < 0:
            raise ConfigError("cache is larger than the address space")
        if self.victim_entries < 0:
            raise ConfigError("victim_entries must be >= 0")
        if not _is_pow2(self.word_size) or self.word_size > self.block_size:
            raise ConfigError("word_size must be a power of two no larger than block_size")

    # ---- derived geometry -------------------------------------------------
    @property
    def num_blocks(self) -> int:
        return self.cache_size // self.block_size

    @property
    def is_fully_associative(self) -> bool:
        return self.associativity == 0 or self.associativity == self.num_blocks

    @property
    def ways(self) -> int:
        return self.num_blocks if self.is_fully_associative else self.associativity

    @property
    def num_sets(self) -> int:
        return self.num_blocks // self.ways

    @property
    def offset_bits(self) -> int:
        return self.block_size.bit_length() - 1

    @property
    def index_bits(self) -> int:
        return self.num_sets.bit_length() - 1

    @property
    def tag_bits(self) -> int:
        return self.address_bits - self.index_bits - self.offset_bits

    @property
    def mapping_name(self) -> str:
        if self.is_fully_associative:
            return "Fully associative"
        if self.ways == 1:
            return "Direct mapped"
        return "%d-way set associative" % self.ways

    @property
    def write_name(self) -> str:
        base = "Write-back" if self.write_policy == "WB" else "Write-through"
        return base + (" / write-allocate" if self.write_allocate else " / no-write-allocate")

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d.update({
            "num_blocks": self.num_blocks,
            "ways": self.ways,
            "num_sets": self.num_sets,
            "offset_bits": self.offset_bits,
            "index_bits": self.index_bits,
            "tag_bits": self.tag_bits,
            "mapping_name": self.mapping_name,
            "write_name": self.write_name,
            "is_fully_associative": self.is_fully_associative,
        })
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CacheConfig":
        allowed = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in allowed})


# --------------------------------------------------------------------------- #
# Address decoding
# --------------------------------------------------------------------------- #
@dataclass
class AddressFields:
    address: int
    tag: int
    index: int
    offset: int
    block_address: int
    tag_bits: int
    index_bits: int
    offset_bits: int
    address_bits: int

    @property
    def binary(self) -> str:
        return format(self.address, "0%db" % self.address_bits)

    @property
    def tag_binary(self) -> str:
        return self.binary[: self.tag_bits]

    @property
    def index_binary(self) -> str:
        return self.binary[self.tag_bits: self.tag_bits + self.index_bits]

    @property
    def offset_binary(self) -> str:
        return self.binary[self.tag_bits + self.index_bits:]

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d.update({
            "hex": "0x%0*X" % ((self.address_bits + 3) // 4, self.address),
            "binary": self.binary,
            "tag_binary": self.tag_binary,
            "index_binary": self.index_binary,
            "offset_binary": self.offset_binary,
            "tag_hex": "0x%X" % self.tag,
        })
        return d


def decode(config: CacheConfig, address: int) -> AddressFields:
    """Split ``address`` into tag / index / offset for ``config``."""
    if address < 0:
        raise ValueError("address must be non-negative")
    address &= (1 << config.address_bits) - 1
    offset = address & (config.block_size - 1)
    block_address = address >> config.offset_bits
    index = block_address & (config.num_sets - 1)
    tag = block_address >> config.index_bits
    return AddressFields(address, tag, index, offset, block_address,
                         config.tag_bits, config.index_bits, config.offset_bits,
                         config.address_bits)


# --------------------------------------------------------------------------- #
# Lines, sets, statistics
# --------------------------------------------------------------------------- #
@dataclass
class CacheLine:
    valid: bool = False
    tag: int = 0
    dirty: bool = False
    last_used: int = -1     # LRU timestamp (updated on every hit/fill)
    inserted: int = -1      # FIFO timestamp (updated on fill only)

    def snapshot(self, rank: Optional[int]) -> Dict[str, Any]:
        return {"valid": self.valid, "tag": self.tag if self.valid else None,
                "dirty": self.dirty, "age": rank}


@dataclass
class Stats:
    accesses: int = 0
    reads: int = 0
    writes: int = 0
    hits: int = 0
    misses: int = 0
    read_hits: int = 0
    read_misses: int = 0
    write_hits: int = 0
    write_misses: int = 0
    compulsory: int = 0
    capacity: int = 0
    conflict: int = 0
    victim_hits: int = 0
    writebacks: int = 0
    mem_reads: int = 0
    mem_writes: int = 0
    traffic_bytes: int = 0

    def finalize(self, cfg: CacheConfig) -> Dict[str, Any]:
        d = asdict(self)
        n = self.accesses or 1
        d["hit_ratio"] = self.hits / n
        d["miss_ratio"] = self.misses / n
        d["read_miss_ratio"] = (self.read_misses / self.reads) if self.reads else 0.0
        d["write_miss_ratio"] = (self.write_misses / self.writes) if self.writes else 0.0
        memory_misses = self.misses - self.victim_hits
        d["memory_miss_ratio"] = memory_misses / n
        d["amat"] = (cfg.hit_time + (memory_misses / n) * cfg.miss_penalty
                     + (self.victim_hits / n) * cfg.victim_penalty)
        d["traffic_kib"] = self.traffic_bytes / 1024.0
        return d


# --------------------------------------------------------------------------- #
# Victim cache (extension) and shadow cache (3C classification)
# --------------------------------------------------------------------------- #
class VictimCache:
    """Small fully-associative buffer of recently evicted lines (Jouppi, 1990).

    Keyed by block address.  FIFO replacement, which is what the original
    proposal used and keeps the hand analysis simple.
    """

    def __init__(self, entries: int):
        self.entries = entries
        self.lines: "OrderedDict[int, bool]" = OrderedDict()  # block -> dirty

    def lookup(self, block: int) -> Optional[bool]:
        """Remove and return the dirty flag if ``block`` is present."""
        if block in self.lines:
            return self.lines.pop(block)
        return None

    def insert(self, block: int, dirty: bool) -> Optional[Tuple[int, bool]]:
        """Insert an evicted line; return the (block, dirty) it pushed out, if any."""
        if self.entries == 0:
            return (block, dirty)
        pushed = None
        if len(self.lines) >= self.entries:
            pushed = self.lines.popitem(last=False)
        self.lines[block] = dirty
        return pushed

    def snapshot(self) -> List[Dict[str, Any]]:
        return [{"block": b, "dirty": d} for b, d in self.lines.items()]


class ShadowFullyAssociative:
    """Fully-associative LRU cache with the same number of blocks as the real cache.

    Used only to classify misses: a miss in the real cache that would also miss
    in this cache is a *capacity* miss, otherwise it is a *conflict* miss.
    """

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.blocks: "OrderedDict[int, None]" = OrderedDict()

    def access(self, block: int, allocate: bool) -> bool:
        if block in self.blocks:
            self.blocks.move_to_end(block)
            return True
        if allocate:
            if len(self.blocks) >= self.capacity:
                self.blocks.popitem(last=False)
            self.blocks[block] = None
        return False


# --------------------------------------------------------------------------- #
# Access event
# --------------------------------------------------------------------------- #
@dataclass
class AccessEvent:
    step: int
    op: str                              # "R" or "W"
    address: int
    fields: Dict[str, Any]
    set_index: int
    way: Optional[int]                   # way touched (None for no-allocate write miss)
    result: str                          # "HIT" | "VICTIM" | "MISS"
    miss_type: Optional[str]             # compulsory | capacity | conflict | None
    allocated: bool
    evicted: Optional[Dict[str, Any]]    # {"tag","block","dirty","writeback"} or None
    writeback: bool
    mem_read: bool
    mem_write: bool
    dirty_after: Optional[bool]
    set_before: List[Dict[str, Any]]
    set_after: List[Dict[str, Any]]
    victim_after: List[Dict[str, Any]]
    note: str
    stats_after: Dict[str, Any] = field(default_factory=dict)

    @property
    def hit(self) -> bool:
        return self.result == "HIT"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# The cache
# --------------------------------------------------------------------------- #
class Cache:
    def __init__(self, config: CacheConfig):
        self.cfg = config
        self.sets: List[List[CacheLine]] = [
            [CacheLine() for _ in range(config.ways)] for _ in range(config.num_sets)
        ]
        self.rng = random.Random(config.seed)
        self.clock = 0
        self.stats = Stats()
        self.seen_blocks: set = set()
        self.shadow = ShadowFullyAssociative(config.num_blocks)
        self.victim = VictimCache(config.victim_entries)
        self.events: List[AccessEvent] = []
        self.last_event: Optional[AccessEvent] = None

    # ---- helpers ----------------------------------------------------------
    def decode(self, address: int) -> AddressFields:
        return decode(self.cfg, address)

    def _ranks(self, lines: List[CacheLine]) -> List[Optional[int]]:
        """Rank of each way for display: 0 = most recently used / newest."""
        key = (lambda l: l.inserted) if self.cfg.replacement == "FIFO" else (lambda l: l.last_used)
        valid = [(key(l), i) for i, l in enumerate(lines) if l.valid]
        order = [i for _, i in sorted(valid, key=lambda t: -t[0])]
        ranks: List[Optional[int]] = [None] * len(lines)
        for r, i in enumerate(order):
            ranks[i] = r
        return ranks

    def set_snapshot(self, index: int) -> List[Dict[str, Any]]:
        lines = self.sets[index]
        return [l.snapshot(r) for l, r in zip(lines, self._ranks(lines))]

    def state(self) -> List[List[Dict[str, Any]]]:
        return [self.set_snapshot(i) for i in range(self.cfg.num_sets)]

    def _find(self, index: int, tag: int) -> int:
        for w, line in enumerate(self.sets[index]):
            if line.valid and line.tag == tag:
                return w
        return -1

    def _choose_victim(self, index: int) -> int:
        lines = self.sets[index]
        for w, line in enumerate(lines):
            if not line.valid:
                return w
        policy = self.cfg.replacement
        if policy == "LRU":
            return min(range(len(lines)), key=lambda w: lines[w].last_used)
        if policy == "FIFO":
            return min(range(len(lines)), key=lambda w: lines[w].inserted)
        return self.rng.randrange(len(lines))

    def _mem_read(self) -> None:
        self.stats.mem_reads += 1
        self.stats.traffic_bytes += self.cfg.block_size

    def _mem_write(self, nbytes: int) -> None:
        self.stats.mem_writes += 1
        self.stats.traffic_bytes += nbytes

    # ---- the access -------------------------------------------------------
    def access(self, op: str, address: int) -> AccessEvent:
        op = op.upper()
        if op not in ("R", "W"):
            raise ValueError("op must be 'R' or 'W'")
        cfg = self.cfg
        self.clock += 1
        st = self.stats
        st.accesses += 1
        if op == "R":
            st.reads += 1
        else:
            st.writes += 1

        f = self.decode(address)
        index, tag, block = f.index, f.tag, f.block_address
        lines = self.sets[index]
        before = self.set_snapshot(index)

        way = self._find(index, tag)
        allocate = (op == "R") or cfg.write_allocate
        # "Compulsory" follows the infinite-cache definition: the block has never
        # been brought into the cache.  With no-write-allocate a write miss does
        # not bring the block in, so the block stays "never fetched".
        first_touch = block not in self.seen_blocks
        if allocate:
            self.seen_blocks.add(block)
        shadow_hit = self.shadow.access(block, allocate)

        evicted: Optional[Dict[str, Any]] = None
        writeback = False
        mem_read = False
        mem_write = False
        result = "HIT"
        miss_type: Optional[str] = None
        notes: List[str] = []

        if way >= 0:
            # ---------------- hit ----------------
            st.hits += 1
            line = lines[way]
            line.last_used = self.clock
            if op == "R":
                st.read_hits += 1
                notes.append("read hit in way %d" % way)
            else:
                st.write_hits += 1
                if cfg.write_policy == "WB":
                    line.dirty = True
                    notes.append("write hit: line marked dirty (write-back)")
                else:
                    self._mem_write(cfg.word_size)
                    mem_write = True
                    notes.append("write hit: word written through to memory")
        else:
            # ---------------- miss ----------------
            st.misses += 1
            if op == "R":
                st.read_misses += 1
            else:
                st.write_misses += 1
            if first_touch:
                miss_type = "compulsory"
            elif not shadow_hit:
                miss_type = "capacity"
            else:
                miss_type = "conflict"
            setattr(st, miss_type, getattr(st, miss_type) + 1)
            result = "MISS"

            victim_dirty = self.victim.lookup(block) if cfg.victim_entries else None
            if victim_dirty is not None:
                result = "VICTIM"
                st.victim_hits += 1
                notes.append("found in victim cache (swap, no memory read)")
                # A victim hit still counts as a miss of the main cache for the
                # miss breakdown, but it costs no memory read.

            if allocate:
                way = self._choose_victim(index)
                line = lines[way]
                if line.valid:
                    ev_block = (line.tag << cfg.index_bits) | index
                    evicted = {"tag": line.tag, "block": ev_block, "dirty": line.dirty,
                               "writeback": False, "to_victim": False}
                    if cfg.victim_entries:
                        pushed = self.victim.insert(ev_block, line.dirty)
                        evicted["to_victim"] = True
                        if pushed is not None and pushed[1]:
                            self._mem_write(cfg.block_size)
                            st.writebacks += 1
                            writeback = True
                            mem_write = True
                            notes.append("victim cache overflow: dirty block 0x%X written back" % pushed[0])
                    elif line.dirty:
                        self._mem_write(cfg.block_size)
                        st.writebacks += 1
                        writeback = True
                        mem_write = True
                        evicted["writeback"] = True
                        notes.append("evicted dirty tag 0x%X from way %d -> write-back" % (line.tag, way))
                    else:
                        notes.append("evicted clean tag 0x%X from way %d" % (line.tag, way))
                if result == "MISS":
                    self._mem_read()
                    mem_read = True
                    notes.append("block fetched from memory into way %d" % way)
                else:
                    notes.append("block moved from victim cache into way %d" % way)
                line.valid = True
                line.tag = tag
                line.last_used = self.clock
                line.inserted = self.clock
                line.dirty = bool(victim_dirty) if victim_dirty is not None else False
                if op == "W":
                    if cfg.write_policy == "WB":
                        line.dirty = True
                        notes.append("write completes in cache (dirty)")
                    else:
                        self._mem_write(cfg.word_size)
                        mem_write = True
                        notes.append("word written through to memory")
            else:
                # write miss, no-write-allocate: write around the cache
                way = None
                if result == "VICTIM":
                    # the line left the victim cache; write it back with the new data
                    self._mem_write(cfg.block_size)
                    st.writebacks += 1
                    writeback = True
                    mem_write = True
                    notes.append("no-write-allocate: victim line written back with new data")
                else:
                    self._mem_write(cfg.word_size)
                    mem_write = True
                    notes.append("write miss, no-write-allocate: word written to memory only")

        after = self.set_snapshot(index)
        dirty_after = lines[way].dirty if way is not None else None
        ev = AccessEvent(
            step=st.accesses, op=op, address=f.address, fields=f.to_dict(),
            set_index=index, way=way, result=result, miss_type=miss_type,
            allocated=(way is not None and result != "HIT"), evicted=evicted,
            writeback=writeback, mem_read=mem_read, mem_write=mem_write,
            dirty_after=dirty_after, set_before=before, set_after=after,
            victim_after=self.victim.snapshot() if cfg.victim_entries else [],
            note="; ".join(notes),
        )
        ev.stats_after = self.stats.finalize(cfg)
        return ev

    def run(self, trace: List[Tuple[str, int]], keep_events: Optional[int] = None) -> List[AccessEvent]:
        """Run a whole trace.  Keep at most ``keep_events`` detailed events (None = all)."""
        kept: List[AccessEvent] = []
        self.last_event = None
        for i, (op, addr) in enumerate(trace):
            ev = self.access(op, addr)
            self.last_event = ev
            if keep_events is None or i < keep_events:
                kept.append(ev)
        self.events = kept
        return kept

    def results(self) -> Dict[str, Any]:
        return self.stats.finalize(self.cfg)


def simulate(config: CacheConfig, trace: List[Tuple[str, int]],
             keep_events: Optional[int] = None) -> Dict[str, Any]:
    """Convenience wrapper: run ``trace`` on a fresh cache, return a JSON-able report."""
    cache = Cache(config)
    events = cache.run(trace, keep_events)
    return {
        "config": config.to_dict(),
        "stats": cache.results(),
        "events": [e.to_dict() for e in events],
        "total_accesses": len(trace),
        "truncated": keep_events is not None and len(trace) > keep_events,
        "final_state": cache.state(),
        "victim_state": cache.victim.snapshot() if config.victim_entries else [],
        "last_event": cache.last_event.to_dict() if cache.last_event else None,
    }
