#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/checkout with spaces"
fake_bin="$tmp/bin"
mkdir -p "$fixture/bin" "$fixture/tools/review-inbox" "$fake_bin" "$tmp/public"
cp "$root/bin/review-inbox" "$fixture/bin/review-inbox"
printf 'module example.test/inbox\n' > "$fixture/tools/review-inbox/go.mod"
printf 'package main\n' > "$fixture/tools/review-inbox/main.go"
touch "$fixture/tools/review-inbox/go.sum"
ln -s "$fixture/bin/review-inbox" "$tmp/public/review-inbox"

cat > "$fake_bin/go" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GO_BUILD_LOG"
[[ "${GO_BUILD_FAIL:-0}" == 0 ]] || exit 1
while (($#)); do
  if [[ "$1" == -o ]]; then output="$2"; break; fi
  shift
done
cat > "$output" <<'APP'
#!/usr/bin/env bash
printf '%s\n' "$@"
APP
SH
chmod +x "$fake_bin/go"
export GO_BUILD_LOG="$tmp/builds.log"
export XDG_CACHE_HOME="$tmp/cache"
export PATH="$fake_bin:$PATH"

run_inbox() { "$tmp/public/review-inbox" "$@"; }
build_count() { awk 'END { print NR }' "$GO_BUILD_LOG"; }

actual="$(run_inbox --layout dispatch list --source 'a source' --json)"
[[ "$actual" == $'--layout\ndispatch\nlist\n--source\na source\n--json' ]] \
  || fail "launcher changed structured CLI arguments"
[[ "$(build_count)" == 1 ]] || fail "initial launch did not build exactly once"
GO_BUILD_FAIL=1 run_inbox --help >/dev/null
[[ "$(build_count)" == 1 ]] || fail "unchanged source rebuilt the app"
echo "ok - review inbox resolves symlinked checkouts and reuses a valid build"

printf 'package main\n// edited\n' > "$fixture/tools/review-inbox/main.go"
touch -t 202001010000 "$fixture/tools/review-inbox/main.go"
run_inbox --build
[[ "$(build_count)" == 2 ]] || fail "content with an older mtime did not rebuild"
printf 'package main\n' > "$fixture/tools/review-inbox/extra.go"
run_inbox --build
[[ "$(build_count)" == 3 ]] || fail "added source did not rebuild"
rm "$fixture/tools/review-inbox/extra.go"
run_inbox --build
[[ "$(build_count)" == 4 ]] || fail "deleted source did not rebuild"
echo "ok - review inbox rebuilds after source edits, additions, and deletions"

printf 'package main\n// next edit\n' > "$fixture/tools/review-inbox/main.go"
if GO_BUILD_FAIL=1 run_inbox --build >/dev/null 2>&1; then
  fail "failed Go build unexpectedly succeeded"
fi
run_inbox --build
[[ "$(build_count)" == 6 ]] || fail "failed build was incorrectly cached"
echo "ok - review inbox retries failed builds without marking them current"
