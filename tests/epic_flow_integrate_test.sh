#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --test "$root/tests/epic_flow_integrate_test.js" >/dev/null
echo "ok - epic-flow integration verifies merges on a candidate branch and pushes only approved, gate-made heads"
