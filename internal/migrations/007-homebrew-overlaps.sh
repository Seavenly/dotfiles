#!/usr/bin/env bash
# macOS still ships Bash 3.2, whose nounset handling treats a declared empty
# array as unbound. This migration intentionally reaches empty arrays once all
# overlaps are removed, so use errexit and pipefail without nounset.
set -eo pipefail

root="$DOTFILES_ROOT"
dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"
assume_yes="${DOTFILES_YES:-0}"

[[ "$DOTFILES_OS" == Darwin ]] || exit 75

if command -v brew >/dev/null 2>&1; then
  brew_bin="$(command -v brew)"
elif [[ -x /opt/homebrew/bin/brew ]]; then
  brew_bin=/opt/homebrew/bin/brew
else
  exit 0
fi

# This is deliberately an allowlist. It is not derived from the Brewfiles:
# unrelated packages installed by the user remain outside dotfile ownership.
formulae=(bat fd neovim neovim-remote oh-my-posh tree-sitter zk)
casks=(aerospace sbx)
installed_formulae=()
installed_casks=()
retained_formulae=()

for formula in "${formulae[@]}"; do
  "$brew_bin" list --formula "$formula" >/dev/null 2>&1 && installed_formulae+=("$formula")
done
for cask in "${casks[@]}"; do
  "$brew_bin" list --cask "$cask" >/dev/null 2>&1 && installed_casks+=("$cask")
done

# tree-sitter is the only overlap that commonly remains a dependency of other
# Homebrew software. Ignore dependents that are themselves in this migration;
# retain it when an unrelated installed formula (for example posting) needs it.
if "$brew_bin" list --formula tree-sitter >/dev/null 2>&1; then
  external_dependents=()
  while IFS= read -r dependent; do
    [[ -z "$dependent" ]] && continue
    managed=0
    for formula in "${formulae[@]}"; do
      [[ "$dependent" != "$formula" ]] || managed=1
    done
    ((managed)) || external_dependents+=("$dependent")
  done < <(HOMEBREW_NO_AUTO_UPDATE=1 "$brew_bin" uses --installed tree-sitter 2>/dev/null || true)

  if ((${#external_dependents[@]})); then
    removable_formulae=()
    for formula in "${installed_formulae[@]}"; do
      [[ "$formula" == tree-sitter ]] || removable_formulae+=("$formula")
    done
    installed_formulae=("${removable_formulae[@]}")
    dependents="$(IFS=', '; echo "${external_dependents[*]}")"
    retained_formulae+=("tree-sitter (required by $dependents)")
  fi
fi

if ((${#installed_formulae[@]} == 0 && ${#installed_casks[@]} == 0)); then
  for retained in "${retained_formulae[@]}"; do
    printf 'Homebrew transition: retaining formula %s.\n' "$retained"
  done
  ((dry_run)) && echo "Homebrew transition: no known overlaps remain."
  exit 0
fi

echo "Homebrew transition will remove previously managed duplicates:"
for formula in "${installed_formulae[@]}"; do
  printf '  formula %s\n' "$formula"
done
for cask in "${installed_casks[@]}"; do
  printf '  cask    %s\n' "$cask"
done
for retained in "${retained_formulae[@]}"; do
  printf '  retain  %s\n' "$retained"
done
echo "Homebrew autoremove is enabled; dependencies made orphaned may also be removed."

if ((dry_run)); then
  exit 0
fi

mise_bin="$HOME/.local/bin/mise"
[[ -x "$mise_bin" ]] || mise_bin="$(command -v mise)"
export MISE_TRUSTED_CONFIG_PATHS="$root"

for formula in "${installed_formulae[@]}"; do
  case "$formula" in
    bat) replacement=bat ;;
    fd) replacement=fd ;;
    neovim) replacement=nvim ;;
    neovim-remote) replacement=nvr ;;
    oh-my-posh) replacement=oh-my-posh ;;
    tree-sitter) replacement=tree-sitter ;;
    zk) continue ;; # Explicitly retired; no replacement is expected.
  esac
  "$mise_bin" -C "$root" which "$replacement" >/dev/null 2>&1 || {
    printf 'Deferring brew:%s removal; mise replacement %s not installed yet.\n' \
      "$formula" "$replacement" >&2
    exit 75
  }
done

for cask in "${installed_casks[@]}"; do
  case "$cask" in
    aerospace)
      [[ -x "$HOME/Applications/AeroSpace.app/Contents/MacOS/AeroSpace" ]] || {
        echo "Deferring brew-cask:aerospace removal; the mise-managed app is not installed yet." >&2
        exit 75
      }
      ;;
    sbx) : ;; # Explicitly retired; no replacement is expected.
  esac
done

if [[ "$assume_yes" != 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "Deferring Homebrew transition without a terminal; rerun interactively or with --yes."
    exit 75
  fi
  read -r -p "Remove these Homebrew installations? [Y/n] " answer
  [[ ! "$answer" =~ ^[Nn]$ ]] || exit 0
fi

restart_aerospace=0
for cask in "${installed_casks[@]}"; do
  [[ "$cask" != aerospace ]] || restart_aerospace=1
done
if ((restart_aerospace)); then
  osascript -e 'tell application "AeroSpace" to quit' >/dev/null 2>&1 || true
fi

((${#installed_formulae[@]} == 0)) || \
  "$brew_bin" uninstall --formula "${installed_formulae[@]}"
((${#installed_casks[@]} == 0)) || \
  "$brew_bin" uninstall --cask "${installed_casks[@]}"

# Make the accepted policy explicit even if the current Homebrew release did
# not invoke autoremove as part of uninstall.
"$brew_bin" autoremove

if ((restart_aerospace)); then
  open "$HOME/Applications/AeroSpace.app"
  sketchybar --reload >/dev/null 2>&1 || true
fi

echo "Homebrew transition complete."
