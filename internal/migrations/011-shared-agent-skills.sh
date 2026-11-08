#!/usr/bin/env bash
set -euo pipefail

dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"
legacy_root="$HOME/.agents/skills"
claude_root="$HOME/.claude/skills"
backup_root="$DOTFILES_STATE_DIR/legacy-agent-skills/011-shared-agent-skills"
managed_root="$DOTFILES_ROOT/config/agents/skills"

legacy_skills=(
  caveman
  diagnose
  grill-me
  grill-with-docs
  handoff
  improve-codebase-architecture
  prototype
  setup-matt-pocock-skills
  tdd
  to-issues
  to-prd
  triage
  write-a-skill
  zoom-out
)

next_backup_path() {
  local skill="$1"
  local candidate="$backup_root/$skill"
  local suffix=1

  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="$backup_root/$skill.$suffix"
    ((suffix += 1))
  done
  printf '%s\n' "$candidate"
}

for skill in "${legacy_skills[@]}"; do
  target="$legacy_root/$skill"

  if [[ -L "$target" ]]; then
    link_target="$(readlink "$target")"
    [[ "$link_target" == "$managed_root/$skill" ]] || continue
    if ((dry_run)); then
      printf 'Would remove stale managed skill link %s.\n' "$target"
    else
      unlink "$target"
    fi
    continue
  fi

  [[ -d "$target" ]] || continue
  destination="$(next_backup_path "$skill")"
  if ((dry_run)); then
    printf 'Would preserve legacy skill %s at %s.\n' "$target" "$destination"
  else
    mkdir -p "$backup_root"
    mv "$target" "$destination"
  fi
done

# The skills installer used Claude-directory symlinks back to the common
# package. Once the common package has been preserved, these links contain no
# independent content and would obstruct mise's per-file convergence.
for skill in "${legacy_skills[@]}"; do
  target="$claude_root/$skill"
  [[ -L "$target" ]] || continue
  link_target="$(readlink "$target")"
  case "$link_target" in
    "../../.agents/skills/$skill"|"$legacy_root/$skill") ;;
    *) continue ;;
  esac

  if ((dry_run)); then
    printf 'Would remove legacy Claude skill link %s.\n' "$target"
  else
    unlink "$target"
  fi
done
