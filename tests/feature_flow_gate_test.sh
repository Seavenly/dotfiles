#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --test "$root/tests/feature_flow_gate_test.js" >/dev/null
echo "ok - feature-flow gate folds agent commits, keeps failed work out of history, and guards the builder"
