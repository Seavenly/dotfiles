#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fixture="$scratch/checkout"
mkdir -p "$fixture/internal/commands" "$fixture/internal/shell" "$scratch/bin"
cp "$root/internal/commands/install" "$fixture/internal/commands/install"
cp "$root/internal/shell/context.sh" "$fixture/internal/shell/context.sh"
cp "$root/internal/upgrade-mise" "$fixture/internal/upgrade-mise"
cp "$root/mise.toml" "$fixture/mise.toml"
published="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "$scratch/releases.json" <<EOF
[
  {"tag_name":"v2099.12.3","draft":true,"prerelease":false,"published_at":"$published"},
  {"tag_name":"v2099.12.2","draft":false,"prerelease":true,"published_at":"$published"},
  {"tag_name":"v2099.12.1","draft":false,"prerelease":false,"published_at":"$published"},
  {"tag_name":"v2026.7.5","draft":false,"prerelease":false,"published_at":"2020-01-01T00:00:00Z"}
]
EOF
mac_sha="$(printf '%064d' 1)"
x64_sha="$(printf '%064d' 2)"
arm_sha="$(printf '%064d' 3)"
printf '%s  ./mise-v2099.12.1-%s\n' "$mac_sha" macos-arm64 \
  "$x64_sha" linux-x64 "$arm_sha" linux-arm64 > "$scratch/SHASUMS256.txt"
cat > "$scratch/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *releases\?per_page=100*) cat "$RELEASE_TEST_DIR/releases.json" ;;
  *SHASUMS256.txt*) cat "$RELEASE_TEST_DIR/SHASUMS256.txt" ;;
  *) exit 1 ;;
esac
EOF
cat > "$scratch/bin/mise" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then
  echo '2026.7.5 linux-x64'
else
  printf 'locked=%s %s\n' "${MISE_LOCKED:-unset}" "$*" >> "$RELEASE_TEST_DIR/mise.log"
fi
EOF
chmod +x "$scratch/bin/curl" "$scratch/bin/mise"
export RELEASE_TEST_DIR="$scratch"
export PATH="$scratch/bin:$PATH"
export DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=x86_64
export DOTFILES_CONTEXT_DISTRO_ID=ubuntu DOTFILES_CONTEXT_DISTRO_VERSION=24.04

DOTFILES_ROOT="$fixture" "$root/internal/commands/upgrade" tools >/dev/null
assert_not_contains "$(cat "$scratch/mise.log")" '--minimum-release-age'
assert_contains "$(cat "$scratch/mise.log")" 'locked=1 install'
echo "ok - tool upgrades retain locked installation without a release-age filter"

"$fixture/internal/upgrade-mise" >/dev/null
assert_contains "$(cat "$scratch/mise.log")" 'self-update --yes --no-plugins 2099.12.1'
assert_contains "$(cat "$fixture/mise.toml")" 'min_version = "2099.12.1"'
for sha in "$mac_sha" "$x64_sha" "$arm_sha"; do
  assert_contains "$(cat "$fixture/internal/commands/install")" "expected_sha=\"$sha\""
done
echo "ok - freshly published stable mise updates preserve all platform checksums"
