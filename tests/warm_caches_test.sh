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
  "$fixture/config/claude/scripts" \
  "$fixture/config/agent-flow" \
  "$fixture/config/flow" \
  "$fixture/tools/flow" \
  "$fake_bin" \
  "$tmp/home"
touch \
  "$fixture/config/claude/scripts/package-lock.json" \
  "$fixture/config/agent-flow/package-lock.json" \
  "$fixture/config/flow/package-lock.json" \
  "$fixture/tools/flow/package-lock.json"

cat > "$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_TEST_LOG"
EOF
cat > "$fake_bin/nvim" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/npm" "$fake_bin/nvim"

HOME="$tmp/home" PATH="$fake_bin:$PATH" DOTFILES_ROOT="$fixture" \
  NPM_TEST_LOG="$tmp/npm.log" "$root/internal/bootstrap/warm-caches"

npm_log="$(cat "$tmp/npm.log")"
assert_contains "$npm_log" "ci --prefix $fixture/config/claude/scripts"
assert_contains "$npm_log" "ci --prefix $fixture/config/agent-flow"
assert_contains "$npm_log" "ci --prefix $fixture/config/flow"
assert_contains "$npm_log" "ci --prefix $fixture/tools/flow"
echo "ok - cache convergence installs every locked Node runtime dependency"
