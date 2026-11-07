#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -B -S -m unittest discover -s "$root/tests" -p project_selector_test.py -v
