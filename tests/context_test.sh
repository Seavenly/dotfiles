#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"
# shellcheck source=internal/shell/context.sh
source "$root/internal/shell/context.sh"

DOTFILES_CONTEXT_OS=Darwin DOTFILES_CONTEXT_ARCH=arm64 \
  dotfiles_context_init "$root"

[[ "$DOTFILES_OS" == Darwin ]] || fail "expected Darwin context"
[[ "$DOTFILES_ARCH" == arm64 ]] || fail "expected arm64 context"
[[ "$DOTFILES_ENV" == macos ]] || fail "expected macos mise environment"
[[ "$DOTFILES_LOCK_PLATFORM" == macos-arm64 ]] || fail "expected macos-arm64 lock platform"
echo "ok - context normalizes Apple Silicon macOS"

DOTFILES_CONTEXT_OS=Linux DOTFILES_CONTEXT_ARCH=aarch64 \
  dotfiles_context_init "$root"
[[ "$DOTFILES_ENV" == linux ]] || fail "expected linux mise environment"
[[ "$DOTFILES_LOCK_PLATFORM" == linux-arm64 ]] || fail "expected linux-arm64 lock platform"
echo "ok - context normalizes arm64 Linux"

set +e
DOTFILES_CONTEXT_OS=FreeBSD DOTFILES_CONTEXT_ARCH=amd64 \
  dotfiles_context_init "$root"
status=$?
set -e
assert_status "$status" 1
[[ "$DOTFILES_ENV" == unknown ]] || fail "expected unknown environment"
echo "ok - context rejects unsupported hosts"
