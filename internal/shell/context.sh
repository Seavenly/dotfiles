#!/usr/bin/env bash

# Normalize repository, host, and XDG state for command and bootstrap modules.
dotfiles_context_init() {
  local requested_root="$1"
  DOTFILES_ROOT="$(cd "$requested_root" && pwd -P)"
  DOTFILES_OS="${DOTFILES_CONTEXT_OS:-$(uname -s)}"
  DOTFILES_ARCH="${DOTFILES_CONTEXT_ARCH:-$(uname -m)}"

  case "$DOTFILES_OS:$DOTFILES_ARCH" in
    Darwin:arm64)
      DOTFILES_ENV=macos
      DOTFILES_LOCK_PLATFORM=macos-arm64
      DOTFILES_MISE_ASSET_PLATFORM=macos-arm64
      ;;
    Linux:x86_64)
      DOTFILES_ENV=linux
      DOTFILES_LOCK_PLATFORM=linux-x64
      DOTFILES_MISE_ASSET_PLATFORM=linux-x64
      ;;
    Linux:aarch64|Linux:arm64)
      DOTFILES_ENV=linux
      DOTFILES_LOCK_PLATFORM=linux-arm64
      DOTFILES_MISE_ASSET_PLATFORM=linux-arm64
      ;;
    *)
      DOTFILES_ENV=unknown
      DOTFILES_LOCK_PLATFORM=unknown
      DOTFILES_MISE_ASSET_PLATFORM=unknown
      ;;
  esac

  DOTFILES_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles"
  DOTFILES_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles"
  DOTFILES_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
  DOTFILES_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dotfiles"
  export DOTFILES_ROOT DOTFILES_OS DOTFILES_ARCH DOTFILES_ENV
  export DOTFILES_LOCK_PLATFORM DOTFILES_MISE_ASSET_PLATFORM
  export DOTFILES_CONFIG_DIR DOTFILES_CACHE_DIR DOTFILES_STATE_DIR DOTFILES_DATA_DIR

  [[ "$DOTFILES_ENV" != unknown ]]
}

dotfiles_require_supported_host() {
  [[ "$DOTFILES_ENV" != unknown ]] || {
    printf 'Unsupported platform: %s %s\n' "$DOTFILES_OS" "$DOTFILES_ARCH" >&2
    return 1
  }

  if [[ "$DOTFILES_OS" == Darwin ]]; then
    local macos_version macos_major
    macos_version="${DOTFILES_CONTEXT_OS_VERSION:-$(sw_vers -productVersion)}"
    macos_major="${macos_version%%.*}"
    if ((macos_major < 26)); then
      printf 'Unsupported macOS version: %s (expected macOS 26 or newer).\n' "$macos_version" >&2
      return 1
    fi
    return 0
  fi

  local distribution_id distribution_version ID VERSION_ID
  if [[ -n ${DOTFILES_CONTEXT_DISTRO_ID:-} ]]; then
    distribution_id="$DOTFILES_CONTEXT_DISTRO_ID"
    distribution_version="${DOTFILES_CONTEXT_DISTRO_VERSION:-}"
  else
    [[ -r /etc/os-release ]] || {
      echo "Unsupported Linux distribution: /etc/os-release is missing." >&2
      return 1
    }
    # shellcheck disable=SC1091
    source /etc/os-release
    distribution_id="${ID:-}"
    distribution_version="${VERSION_ID:-}"
  fi
  if [[ "$distribution_id" != ubuntu || ! "$distribution_version" =~ ^(24\.04|26\.04)$ ]]; then
    printf 'Unsupported Linux distribution: %s %s (expected Ubuntu 24.04 or 26.04).\n' \
      "${distribution_id:-unknown}" "${distribution_version:-unknown}" >&2
    return 1
  fi
}
