#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=internal/commands/check-run
source "$root/internal/commands/check-run"

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT
failures=0
run "synthetic failure" bash -c 'printf "synthetic stdout\\n"; printf "synthetic stderr\\n" >&2; exit 7' >"$output_file" 2>&1
[[ "$failures" == 1 ]]

output="$(<"$output_file")"
[[ "$output" == *"check: synthetic failure"* && "$output" == *"FAILED"* ]]
[[ "$output" == *"synthetic stdout"* ]]
[[ "$output" == *"synthetic stderr"* ]]
echo "ok - failed checks retain command output"
