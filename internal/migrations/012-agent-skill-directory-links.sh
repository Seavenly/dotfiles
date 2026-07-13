#!/usr/bin/env bash
set -euo pipefail

dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"
managed_root="$DOTFILES_ROOT/config/agents/skills"
skill_roots=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
  "$HOME/.hermes/skills"
)
managed_skills=(
  code-review
  codebase-design
  diagnosing-bugs
  domain-modeling
  grill-with-docs
  grilling
  handoff
  implement
  improve-codebase-architecture
  prototype
  setup-matt-pocock-skills
  tdd
  to-spec
  to-tickets
  triage
  wayfinder
  write-a-skill
)

is_generated_file_link_tree() {
  local target="$1"
  local skill="$2"
  local path relative link_target

  [[ -d "$target" && ! -L "$target" ]] || return 1
  [[ -L "$target/SKILL.md" ]] || return 1
  [[ "$(readlink "$target/SKILL.md")" == "$managed_root/$skill/SKILL.md" ]] \
    || return 1

  if find "$target" -mindepth 1 ! -type d ! -type l -print -quit \
    | grep -q .; then
    return 1
  fi

  while IFS= read -r path; do
    relative="${path#"$target"/}"
    link_target="$(readlink "$path")"
    [[ "$link_target" == "$managed_root/$skill/$relative" ]] || return 1
  done < <(find "$target" -type l -print)
}

remove_generated_tree() {
  local target="$1"
  local path

  while IFS= read -r path; do
    unlink "$path"
  done < <(find "$target" -type l -print)
  while IFS= read -r path; do
    rmdir "$path"
  done < <(find "$target" -depth -type d -print)
}

for skill_root in "${skill_roots[@]}"; do
  for skill in "${managed_skills[@]}"; do
    target="$skill_root/$skill"
    is_generated_file_link_tree "$target" "$skill" || continue
    if ((dry_run)); then
      printf 'Would replace generated skill file links with a directory link at %s.\n' \
        "$target"
    else
      remove_generated_tree "$target"
    fi
  done
done
