#!/usr/bin/env bash
# Scripted demo for COA Lab project P07 (Group 04).
#
#   scripts/run_demo.sh            full demo: tests, traces, hand-worked example, sweeps, figures, then the GUI
#   scripts/run_demo.sh --no-gui   everything except launching the GUI
#
# Requirements: Python 3.8+ only (no third-party packages).
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
PY=${PYTHON:-python3}

hr() { printf '\n\033[1;33m== %s ==\033[0m\n' "$1"; }

hr "1. Unit tests against hand-worked examples"
$PY -m unittest discover -s tests

hr "2. Regenerating trace files in data/"
scripts/generate_traces.sh

hr "3. Textbook direct-mapped example, step by step (Hennessy & Patterson, 8 one-word blocks)"
$PY -m cachesim run --trace data/textbook_dm.trace --size 32 --block 4 --assoc 1 --steps

hr "4. Address breakdown: 0x1A3C in a 1 KiB, 16 B, 4-way cache"
$PY -m cachesim decode 0x1A3C --size 1024 --block 16 --assoc 4

hr "5. LRU vs FIFO vs RANDOM across associativity on the conflict trace"
$PY -m cachesim sweep --trace data/conflict.trace --param associativity --values 1,2,4,8,0 \
    --series replacement --series-values LRU,FIFO,RANDOM

hr "6. Write-back vs write-through memory traffic on the loop trace (25% writes)"
$PY -m cachesim sweep --trace data/loop.trace --assoc 4 --param write_policy --values WB,WT \
    --series write_allocate --series-values 1,0 --metric traffic_kib

hr "7. Victim cache extension on a direct-mapped cache"
$PY -m cachesim sweep --trace data/conflict.trace --assoc 1 --param victim_entries --values 0,2,4,8 --metric amat

hr "8. Regenerating all report figures and tables in results/"
$PY scripts/experiments.py

if [[ "${1:-}" != "--no-gui" ]]; then
  hr "9. Launching the GUI at http://127.0.0.1:8077  (Ctrl+C to stop)"
  $PY -m cachesim serve
fi
