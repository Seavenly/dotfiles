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
export MISE_TRUSTED_CONFIG_PATHS="$root"
mkdir -p "$HOME" "$XDG_STATE_HOME/dotfiles/migrations"
printf 'font-revision\n' > "$XDG_STATE_HOME/dotfiles/migrations/004-sketchybar-app-font"
printf 'defaults-revision\n' > "$XDG_STATE_HOME/dotfiles/migrations/005-macos-defaults-restart"
mkdir -p "$HOME/.claude/hooks"
mkdir -p "$HOME/.claude/skills"
mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.agents/skills/caveman"
mkdir -p "$HOME/.agents/skills/handoff"
mkdir -p "$HOME/.agents/skills/code-review"
mkdir -p "$HOME/.agents/skills/codebase-design"
mkdir -p "$HOME/.claude/skills/code-review"
mkdir -p "$HOME/.hermes/skills/code-review"
: > "$HOME/.claude/CLAUDE.md"
: > "$HOME/.codex/AGENTS.md"
printf '%s\n' 'legacy skill content' > "$HOME/.agents/skills/caveman/SKILL.md"
printf '%s\n' 'legacy handoff content' > "$HOME/.agents/skills/handoff/SKILL.md"
ln -s "$root/config/agents/skills/diagnose" "$HOME/.agents/skills/diagnose"
ln -s ../../.agents/skills/handoff "$HOME/.claude/skills/handoff"
for generated_root in \
  "$HOME/.agents/skills/code-review" \
  "$HOME/.claude/skills/code-review" \
  "$HOME/.hermes/skills/code-review"
do
  ln -s "$root/config/agents/skills/code-review/SKILL.md" \
    "$generated_root/SKILL.md"
  ln -s "$root/config/agents/skills/code-review/LINEAGE.md" \
    "$generated_root/LINEAGE.md"
done
printf '%s\n' 'unmanaged conflicting skill' \
  > "$HOME/.agents/skills/codebase-design/SKILL.md"
printf '%s\n' '{"version":3}' > "$HOME/.agents/.skill-lock.json"
ln -s "$root/config/claude/hooks/notify.sh" "$HOME/.claude/hooks/notify.sh"
cat > "$HOME/.claude/settings.json" <<EOF
{
  "hooks": {
    "Notification": [{"hooks": [
      {"type": "command", "command": "$root/claude/hooks/notify.sh"},
      {"type": "command", "command": "$root/claude/hooks/cockpit-hook.sh"}
    ]}],
    "SessionStart": [{"matcher": "*", "hooks": [
      {"type": "command", "command": "bash '$HOME/.claude/hooks/herdr-agent-state.sh' session"}
    ]}]
  },
  "permissions": {"allow": ["Bash(git status:*)"]}
}
EOF

"$root/internal/migrate"

aliases="$XDG_CONFIG_HOME/dotfiles/aliases.local.zsh"
marker="$XDG_STATE_HOME/dotfiles/migrations/001-local-aliases"
[[ -f "$aliases" ]] || fail "local aliases seed was not installed"
[[ -f "$marker" ]] || fail "local aliases migration was not recorded"
assert_contains "$(cat "$aliases")" 'alias hurlenv='
echo "ok - migrations seed machine-local aliases"

private_file="$XDG_CONFIG_HOME/dotfiles/private.zsh"
private_marker="$XDG_STATE_HOME/dotfiles/migrations/002-private-environment"
[[ -f "$private_file" ]] || fail "private environment file was not created"
[[ -f "$private_marker" ]] || fail "private environment migration was not recorded"
[[ ! -s "$private_file" ]] || fail "fresh private environment should be empty"
permissions="$(stat -f '%Lp' "$private_file" 2>/dev/null || stat -c '%a' "$private_file")"
[[ "$permissions" == 600 ]] || fail "private environment permissions were $permissions"
echo "ok - migrations create secure private environment"

printf '\n# user edit\n' >> "$aliases"
"$root/internal/migrate"
assert_contains "$(cat "$aliases")" '# user edit'
echo "ok - completed migrations preserve machine-local edits"

legacy_link="$HOME/.config/zshrc"
mkdir -p "$(dirname "$legacy_link")"
ln -s "$root/zshrc" "$legacy_link"
rm -f "$XDG_STATE_HOME/dotfiles/migrations/006-legacy-broken-links"
"$root/internal/migrate"
[[ ! -L "$legacy_link" ]] || fail "known legacy link was not removed"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/006-legacy-broken-links" ]] \
  || fail "legacy link migration was not recorded"
echo "ok - migrations remove only known legacy links"

[[ "$(cat "$XDG_STATE_HOME/dotfiles/revisions/sketchybar-app-font")" == font-revision ]] \
  || fail "font revision was not preserved"
[[ "$(cat "$XDG_STATE_HOME/dotfiles/revisions/macos-defaults-restart")" == defaults-revision ]] \
  || fail "defaults revision was not preserved"
[[ ! -e "$XDG_STATE_HOME/dotfiles/migrations/004-sketchybar-app-font" ]] \
  || fail "legacy font revision was not removed"
[[ ! -e "$XDG_STATE_HOME/dotfiles/migrations/005-macos-defaults-restart" ]] \
  || fail "legacy defaults revision was not removed"
echo "ok - migrations preserve recurring convergence revisions"

[[ ! -L "$HOME/.claude/hooks/notify.sh" ]] \
  || fail "retired Claude notification link was not removed"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/009-retired-claude-hooks" ]] \
  || fail "retired Claude hooks migration was not recorded"
settings="$(cat "$HOME/.claude/settings.json")"
assert_not_contains "$settings" 'notify.sh'
assert_not_contains "$settings" 'cockpit-hook.sh'
assert_contains "$settings" 'herdr-agent-state.sh'
assert_contains "$settings" 'Bash(git status:*)'
echo "ok - migrations remove retired Claude hooks only"

[[ ! -e "$HOME/.claude/CLAUDE.md" ]] \
  || fail "empty Claude guidance file was not removed"
[[ ! -e "$HOME/.codex/AGENTS.md" ]] \
  || fail "empty Codex guidance file was not removed"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/010-empty-agent-guidance" ]] \
  || fail "empty agent guidance migration was not recorded"
echo "ok - migrations prepare empty agent guidance files for managed links"

legacy_backup="$XDG_STATE_HOME/dotfiles/legacy-agent-skills/011-shared-agent-skills"
[[ -f "$legacy_backup/caveman/SKILL.md" ]] \
  || fail "legacy skill package was not preserved"
[[ ! -e "$HOME/.agents/skills/caveman" ]] \
  || fail "legacy skill package still blocks convergence"
[[ ! -L "$HOME/.agents/skills/diagnose" ]] \
  || fail "stale managed skill link was not removed"
[[ ! -L "$HOME/.claude/skills/handoff" ]] \
  || fail "legacy Claude skill link was not removed"
[[ -f "$HOME/.agents/.skill-lock.json" ]] \
  || fail "skill lock evidence was removed"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/011-shared-agent-skills" ]] \
  || fail "shared agent skill migration was not recorded"
echo "ok - migrations preserve legacy skills and remove only managed stale links"

for generated_root in \
  "$HOME/.agents/skills/code-review" \
  "$HOME/.claude/skills/code-review" \
  "$HOME/.hermes/skills/code-review"
do
  [[ ! -e "$generated_root" ]] \
    || fail "generated skill file-link tree still blocks directory convergence"
done
[[ -f "$HOME/.agents/skills/codebase-design/SKILL.md" ]] \
  || fail "unmanaged conflicting skill was removed"
[[ -f "$XDG_STATE_HOME/dotfiles/migrations/012-agent-skill-directory-links" ]] \
  || fail "agent skill directory-link migration was not recorded"
echo "ok - migrations replace only generated file-link skill trees"

backup_count="$(find "$legacy_backup" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
"$root/internal/migrate"
[[ "$(find "$legacy_backup" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == "$backup_count" ]] \
  || fail "re-running migrations duplicated legacy skill backups"
echo "ok - shared agent skill migration is idempotent"
