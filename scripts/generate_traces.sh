#!/usr/bin/env bash
# Regenerates every synthetic trace in data/ (deterministic: fixed seeds).
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
PY=${PYTHON:-python3}

$PY -m cachesim gen sequential count=512 stride=4                                      -o data/sequential.trace
$PY -m cachesim gen loop       array_bytes=512 stride=4 iterations=6 write_ratio=0.25  -o data/loop.trace
$PY -m cachesim gen loop       array_bytes=2048 stride=4 iterations=3 write_ratio=0.2 seed=5 -o data/loop_large.trace
$PY -m cachesim gen random     range_bytes=16384 count=512 write_ratio=0.3 seed=42     -o data/random.trace
$PY -m cachesim gen strided    stride=1024 count=64                                    -o data/strided.trace
$PY -m cachesim gen matrix     n=32 elem=4 order=row                                   -o data/matrix_row.trace
$PY -m cachesim gen matrix     n=32 elem=4 order=col                                   -o data/matrix_col.trace
$PY -m cachesim gen conflict   cache_size=1024 block_size=16 blocks=3 repeats=16       -o data/conflict.trace

cat > data/textbook_dm.trace <<'EOF'
# Textbook (Hennessy & Patterson) direct-mapped example: 8 one-word blocks, word addresses 22 26 22 26 16 3 16 18
# run with: --size 32 --block 4 --assoc 1   -> expected miss miss hit hit miss miss hit miss
R 88
R 104
R 88
R 104
R 64
R 12
R 64
R 72
EOF
echo "wrote data/textbook_dm.trace"
