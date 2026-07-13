#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export DOTFILES_CONTEXT_OS=Linux
export DOTFILES_CONTEXT_ARCH=x86_64
mkdir -p \
  "$HOME/.agents/skills/handoff" \
  "$HOME/.claude/skills" \
  "$HOME/.codex" \
  "$XDG_STATE_HOME/dotfiles/migrations"
printf '%s\n' 'legacy handoff content' \
  > "$HOME/.agents/skills/handoff/SKILL.md"
ln -s ../../.agents/skills/handoff "$HOME/.claude/skills/handoff"
: > "$HOME/.codex/AGENTS.md"

DOTFILES_ROOT="$root" "$root/internal/bootstrap/pre-links"

backup="$XDG_STATE_HOME/dotfiles/legacy-agent-skills/011-shared-agent-skills/handoff"
[[ -f "$backup/SKILL.md" ]] || fail "pre-links did not preserve legacy skill"
[[ ! -e "$HOME/.agents/skills/handoff" ]] \
  || fail "pre-links left the common skill conflict in place"
[[ ! -L "$HOME/.claude/skills/handoff" ]] \
  || fail "pre-links left the Claude skill conflict in place"
[[ ! -e "$HOME/.codex/AGENTS.md" ]] \
  || fail "pre-links left the empty Codex guidance conflict in place"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/010-empty-agent-guidance" ]] \
  || fail "pre-links did not run guidance migration"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/011-shared-agent-skills" ]] \
  || fail "pre-links did not run skill migration"
echo "ok - pre-links runs conflict-clearing migrations before convergence"

MISE_TRUSTED_CONFIG_PATHS="$root" DOTFILES_ROOT="$root" \
  mise -C "$root" -E linux bootstrap --only dotfiles --yes \
  >/dev/null 2>&1
[[ -L "$HOME/.agents/skills/handoff" ]] \
  || fail "mise did not converge the common skill after migration"
[[ -L "$HOME/.claude/skills/handoff" ]] \
  || fail "mise did not converge the Claude skill after migration"
[[ -L "$HOME/.codex/AGENTS.md" ]] \
  || fail "mise did not converge Codex guidance after migration"
echo "ok - normal dotfile convergence succeeds after pre-links migration"
