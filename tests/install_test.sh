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
printf 'force=%s args=%s\n' "${DOTFILES_FORCE:-unset}" "$*" >> "$MISE_TEST_LOG"
EOF
chmod +x "$fake_mise"

HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=x86_64 \
  DOTFILES_CONTEXT_DISTRO_ID=ubuntu DOTFILES_CONTEXT_DISTRO_VERSION=24.04 \
  MISE_TEST_LOG="$mise_log" \
  "$root/dotfiles" install --dry-run --yes --force >/dev/null

assert_contains "$(cat "$mise_log")" '--dry-run --yes --force-dotfiles'
assert_contains "$(cat "$mise_log")" 'force=1'
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

mac_home="$tmp/macos-home"
mac_bin="$tmp/macos-bin"
mac_log="$tmp/macos.log"
mkdir -p "$mac_home/.local/bin" "$mac_bin"
cat > "$mac_home/.local/bin/mise" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then
  echo "2026.7.5 macos-arm64"
  exit 0
fi
printf 'mise %s\n' "$*" >> "$MACOS_TEST_LOG"
EOF
cat > "$mac_bin/brew" <<'EOF'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$MACOS_TEST_LOG"
EOF
cat > "$mac_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) echo Darwin ;;
esac
EOF
chmod +x "$mac_home/.local/bin/mise" "$mac_bin/brew" "$mac_bin/uname"

HOME="$mac_home" PATH="$mac_bin:$PATH" MACOS_TEST_LOG="$mac_log" \
  DOTFILES_CONTEXT_OS=Darwin DOTFILES_CONTEXT_ARCH=arm64 \
  DOTFILES_CONTEXT_OS_VERSION=26.0 \
  "$root/dotfiles" install --yes >/dev/null

assert_contains "$(cat "$mac_log")" "brew bundle install --force --file $root/Brewfile.macos"
assert_contains "$(cat "$mac_log")" 'mise bootstrap -C'
echo "ok - install runs on macOS without dry-run cask arguments"
