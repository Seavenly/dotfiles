#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

set +e
output="$(HOME="$tmp/unsupported-home" \
  DOTFILES_CONTEXT_OS=FreeBSD DOTFILES_CONTEXT_ARCH=amd64 \
  "$root/dotfiles" install --dry-run 2>&1)"
status=$?
set -e
assert_status "$status" 1
assert_contains "$output" 'Unsupported platform: FreeBSD amd64'
echo "ok - install rejects unsupported hosts"

home="$tmp/linux-home"
config_home="$tmp/config"
state_home="$tmp/state"
mkdir -p "$home/.local/bin"
fake_mise="$home/.local/bin/mise"
mise_log="$tmp/mise.log"
cat > "$fake_mise" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then
  echo "2026.7.5 linux-x64"
  exit 0
fi
printf '%s\n' "$*" >> "$MISE_TEST_LOG"
EOF
chmod +x "$fake_mise"

HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=x86_64 \
  DOTFILES_CONTEXT_DISTRO_ID=ubuntu DOTFILES_CONTEXT_DISTRO_VERSION=24.04 \
  MISE_TEST_LOG="$mise_log" \
  "$root/dotfiles" install --dry-run --yes --force >/dev/null

assert_contains "$(cat "$mise_log")" '--dry-run --yes --force-dotfiles'
[[ ! -e "$config_home/dotfiles" ]] || fail "dry-run created machine-local configuration"
[[ ! -e "$state_home/dotfiles" ]] || fail "dry-run created migration state"
echo "ok - install dry-run forwards force without changing host state"

set +e
output="$(HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=x86_64 \
  DOTFILES_CONTEXT_DISTRO_ID=ubuntu DOTFILES_CONTEXT_DISTRO_VERSION=24.04 \
  MISE_TEST_LOG="$mise_log" \
  "$root/dotfiles" install --dry-run --yes --recorder 2>&1)"
status=$?
set -e
assert_status "$status" 1
assert_contains "$output" 'The recorder is supported only on macOS.'
echo "ok - install keeps recorder explicitly macOS-only"
