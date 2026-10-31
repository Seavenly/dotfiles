#!/usr/bin/env bash
set -euo pipefail

# Retire only exact repository-owned links. Local sessions, credentials,
# installations, and unmanaged profiles remain the host owner's data.
retire_link() {
  local link="$1" expected="$2"
  if [[ -L "$link" && "$(readlink "$link")" == "$expected" ]]; then
    if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
      printf 'Would remove retired Hermes link %s.\n' "$link"
    else
      unlink "$link"
    fi
  fi
}

for harness in .agents .claude; do
  for skill in agent-flow-epic agent-flow-feature agent-flow-review agent-flow-spike agent-flow-stacks; do
    retire_link "$HOME/$harness/skills/$skill" "$DOTFILES_ROOT/config/agents/skills/$skill"
  done
done

for link in "$HOME/.hermes/skills/"*; do
  retire_link "$link" "$DOTFILES_ROOT/config/agents/skills/$(basename "$link")"
done

for profile in flow-controller analyst critic builder artifact gate; do
  for file in SOUL.md distribution.yaml; do
    retire_link "$HOME/.hermes/profiles/$profile/$file" \
      "$DOTFILES_ROOT/config/agents/profiles/$profile/hermes/$file"
  done
done
