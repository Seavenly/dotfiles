#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

if [[ "$(uname -s)" != Linux ]] || ! command -v mise >/dev/null 2>&1; then
  echo "skip - native fresh-install settings check requires Linux and mise"
  exit 0
fi
if [[ "$(mise --version | awk '{print $1}')" != 2026.7.5 ]]; then
  echo "skip - native settings regression targets pinned mise 2026.7.5"
  exit 0
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fixture="$scratch/checkout"
mkdir -p "$fixture/internal/commands" "$fixture/internal/shell"
cp "$root/dotfiles" "$fixture/dotfiles"
cp "$root/internal/commands/install" "$fixture/internal/commands/install"
cp "$root/internal/shell/context.sh" "$fixture/internal/shell/context.sh"
cp "$root/internal/migrate" "$fixture/internal/migrate"
cp "$root/mise.lock" "$fixture/mise.lock"
cat > "$fixture/mise.toml" <<'EOF'
[settings]
experimental = true
locked = true
[tools]
ruby = "3.4"
EOF
touch "$scratch/global.toml" "$scratch/system.toml"

# Use the real resolver with no installed Ruby or global settings. In pinned
# mise, -C alone leaves early settings dependent on the caller's directory.
set +e
output="$(cd "$scratch" && env -i HOME="$HOME" PATH="$PATH" \
  LANG=C.UTF-8 \
  MISE_GLOBAL_CONFIG_FILE="$scratch/global.toml" \
  MISE_SYSTEM_CONFIG_FILE="$scratch/system.toml" \
  MISE_CONFIG_DIR="$scratch/global" MISE_SYSTEM_CONFIG_DIR="$scratch/system" \
  MISE_DATA_DIR="$scratch/data" MISE_INSTALLS_DIR="$scratch/installs" \
  MISE_STATE_DIR="$scratch/state" MISE_CACHE_DIR="$scratch/cache" \
  DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=x86_64 \
  DOTFILES_CONTEXT_DISTRO_ID=ubuntu DOTFILES_CONTEXT_DISTRO_VERSION=24.04 \
  "$fixture/dotfiles" install --dry-run --yes 2>&1)"
status=$?
set -e
if ((status != 0)); then
  printf '%s\n' "$output" >&2
fi
assert_status "$status" 0
assert_contains "$output" 'ruby@'
assert_contains "$output" 'would install'
[[ ! -e "$scratch/installs/ruby" ]] || fail "dry-run installed Ruby"
echo "ok - fresh install resolves locked Ruby when launched outside the checkout"
