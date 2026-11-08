#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/root"
fake_bin="$tmp/bin"
mkdir -p \
  "$fixture/config/agent-flow" \
  "$fixture/config/flow" \
  "$fixture/tools/flow" \
  "$fixture/tools/review-inbox" \
  "$fixture/bin" \
  "$fake_bin" \
  "$tmp/home"
touch \
  "$fixture/config/agent-flow/package-lock.json" \
  "$fixture/config/flow/package-lock.json" \
  "$fixture/tools/flow/package-lock.json" \
  "$fixture/tools/review-inbox/go.mod"

cat > "$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_TEST_LOG"
EOF
cat > "$fake_bin/nvim" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$fixture/bin/review-inbox" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$REVIEW_BUILD_LOG"
EOF
chmod +x "$fake_bin/npm" "$fake_bin/nvim" "$fixture/bin/review-inbox"

HOME="$tmp/home" PATH="$fake_bin:$PATH" DOTFILES_ROOT="$fixture" \
  NPM_TEST_LOG="$tmp/npm.log" REVIEW_BUILD_LOG="$tmp/review-build.log" \
  "$root/internal/bootstrap/warm-caches"

npm_log="$(cat "$tmp/npm.log")"
assert_contains "$npm_log" "ci --prefix $fixture/config/agent-flow"
assert_contains "$npm_log" "ci --prefix $fixture/config/flow"
assert_contains "$npm_log" "ci --prefix $fixture/tools/flow"
echo "ok - cache convergence installs every locked Node runtime dependency"

assert_contains "$(cat "$tmp/review-build.log")" '--build'
echo "ok - cache convergence builds the attention hub executable"
