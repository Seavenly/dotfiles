#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --test "$root/tests/codex_model_test.js" >/dev/null
echo "ok - Codex reviews resolve latest-<family> from the catalog and never fall back to the config default"
