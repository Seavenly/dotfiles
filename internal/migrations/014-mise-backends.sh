#!/usr/bin/env bash
# macOS Bash 3.2 treats declared empty arrays as unbound under nounset.
set -eo pipefail

root="$DOTFILES_ROOT"
data_dir="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"
mise_bin="$HOME/.local/bin/mise"
[[ -x "$mise_bin" ]] || mise_bin="$(command -v mise || true)"
[[ -n "$mise_bin" ]] || exit 75

legacy_install() {
  local tool="$1"
  shift
  local metadata="$data_dir/installs/$tool/.mise.backend.toml"
  local legacy_metadata="$data_dir/installs/$tool/.mise.backend"
  local backend

  for backend in "$@"; do
    if [[ -f "$metadata" ]] \
      && grep -Fqx "full = \"$backend\"" "$metadata"; then
      return 0
    fi
    if [[ ! -f "$metadata" && -f "$legacy_metadata" ]] \
      && grep -Fqx "$backend" "$legacy_metadata"; then
      return 0
    fi
  done
  return 1
}

legacy_plugin() {
  local plugin="$1"
  local remote="$2"
  local plugin_dir="$data_dir/plugins/$plugin"
  local actual
  [[ -d "$plugin_dir/.git" ]] || return 1
  actual="$(git -C "$plugin_dir" config --get remote.origin.url 2>/dev/null || true)"
  actual="${actual%/}"
  remote="${remote%/}"
  [[ "${actual%.git}" == "${remote%.git}" ]]
}

legacy_installs=()
legacy_plugins=()
legacy_install lua asdf:lua asdf:mise-plugins/mise-lua \
  && legacy_installs+=(lua)
legacy_install tmux asdf:tmux asdf:mise-plugins/mise-tmux \
  && legacy_installs+=(tmux)
legacy_plugin lua https://github.com/mise-plugins/mise-lua.git \
  && legacy_plugins+=(lua)
legacy_plugin tmux https://github.com/mise-plugins/mise-tmux.git \
  && legacy_plugins+=(tmux)

if ((dry_run)); then
  for tool in "${legacy_installs[@]}"; do
    printf 'Would reinstall %s with its locked mise backend.\n' "$tool"
  done
  for plugin in "${legacy_plugins[@]}"; do
    printf 'Would remove the legacy asdf %s plugin.\n' "$plugin"
  done
  exit 0
fi

export MISE_TRUSTED_CONFIG_PATHS="$root"
for tool in "${legacy_installs[@]}"; do
  "$mise_bin" -C "$root" uninstall --all "$tool"
done
for plugin in "${legacy_plugins[@]}"; do
  "$mise_bin" -C "$root" plugins uninstall "$plugin"
done
