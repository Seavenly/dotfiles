#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$HOME/.local/state"
export DOTFILES_ROOT="$root"
export MISE_TRUSTED_CONFIG_PATHS="$root"
mkdir -p "$HOME"

mise -C "$root" -E linux bootstrap dotfiles apply --yes > /dev/null 2>&1
[[ ! -e "$HOME/.hermes" ]] || fail "convergence recreated the Hermes home"
[[ ! -e "$XDG_CONFIG_HOME/dotfiles/hermes-routing.yaml" ]] ||
  fail "convergence recreated Hermes routing"
[[ ! -e "$HOME/.agents/skills/agent-flow-feature" ]] ||
  fail "convergence exposed a retired Hermes flow skill"
echo "ok - convergence does not install Hermes configuration or flow skills"

mkdir -p "$HOME/.hermes/skills/local-only" "$HOME/.hermes/profiles/builder"
printf 'local state\n' > "$HOME/.hermes/state.db"
printf 'local config\n' > "$HOME/.hermes/profiles/builder/config.yaml"
printf 'local skill\n' > "$HOME/.hermes/skills/local-only/SKILL.md"
ln -s "$root/config/agents/skills/tdd" "$HOME/.hermes/skills/tdd"
ln -s /unmanaged/skill "$HOME/.hermes/skills/custom"
ln -s "$root/config/agents/profiles/builder/hermes/SOUL.md" \
  "$HOME/.hermes/profiles/builder/SOUL.md"
ln -s "$root/config/agents/skills/agent-flow-feature" \
  "$HOME/.agents/skills/agent-flow-feature"
mkdir -p "$HOME/.claude/skills/agent-flow-review"
printf 'custom review\n' > "$HOME/.claude/skills/agent-flow-review/SKILL.md"

migration="$root/internal/migrations/016-retired-hermes-links.sh"
dry_run="$(DOTFILES_MIGRATION_DRY_RUN=1 "$migration")"
assert_contains "$dry_run" 'Would remove retired Hermes link'
[[ -L "$HOME/.hermes/skills/tdd" ]] || fail "dry-run removed a link"
for _ in 1 2; do "$migration"; done
for link in \
  "$HOME/.hermes/skills/tdd" \
  "$HOME/.hermes/profiles/builder/SOUL.md" \
  "$HOME/.agents/skills/agent-flow-feature"; do
  [[ ! -L "$link" ]] || fail "retired managed link remains: $link"
done
[[ -L "$HOME/.hermes/skills/custom" ]] || fail "unmanaged symlink was removed"
assert_contains "$(cat "$HOME/.hermes/state.db")" 'local state'
assert_contains "$(cat "$HOME/.hermes/profiles/builder/config.yaml")" 'local config'
assert_contains "$(cat "$HOME/.hermes/skills/local-only/SKILL.md")" 'local skill'
assert_contains "$(cat "$HOME/.claude/skills/agent-flow-review/SKILL.md")" 'custom review'
echo "ok - Hermes retirement is repeatable, supports dry-run, and preserves local data"
