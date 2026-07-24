#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

[[ -L "$root/CLAUDE.md" ]] || fail "CLAUDE.md is not a symlink"
[[ "$(readlink "$root/CLAUDE.md")" == AGENTS.md ]] \
  || fail "CLAUDE.md does not target AGENTS.md"
echo "ok - repository guidance is shared with Claude"

[[ -s "$root/config/agents/AGENTS.global.md" ]] \
  || fail "global agent guidance is missing"
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.codex/AGENTS.md" = "config/agents/AGENTS.global.md"'
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.claude/CLAUDE.md" = "config/agents/AGENTS.global.md"'
echo "ok - global guidance is linked to supported harnesses"

assert_contains "$(cat "$root/mise.toml")" \
  '"~/.agents/skills/tdd" = "config/agents/skills/tdd"'
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.claude/skills/tdd" = "config/agents/skills/tdd"'
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.hermes/skills/tdd" = "config/agents/skills/tdd"'
echo "ok - managed skills are linked to supported harnesses"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
mkdir -p \
  "$home/.config" \
  "$home/.local/state" \
  "$home/.agents/skills/local-only" \
  "$home/.claude/skills/local-only" \
  "$home/.hermes/skills/local-only"
for harness_root in .agents .claude .hermes; do
  printf '%s\n' 'unmanaged skill' \
    > "$home/$harness_root/skills/local-only/SKILL.md"
done

for _ in 1 2; do
  HOME="$home" XDG_CONFIG_HOME="$home/.config" \
    XDG_STATE_HOME="$home/.local/state" MISE_TRUSTED_CONFIG_PATHS="$root" \
    mise -C "$root" -E linux bootstrap dotfiles apply --yes \
    >/dev/null 2>&1
done

for harness_root in .agents .claude .hermes; do
  linked_skill="$home/$harness_root/skills/tdd"
  [[ -L "$linked_skill" ]] || fail "$harness_root did not receive managed skills"
  [[ "$(readlink "$linked_skill")" == "$root/config/agents/skills/tdd" ]] \
    || fail "$harness_root skill link targets the wrong source"
  [[ -f "$home/$harness_root/skills/local-only/SKILL.md" ]] \
    || fail "$harness_root lost an unmanaged skill"
done
echo "ok - skill convergence is idempotent and preserves unmanaged entries"

skills_root="$root/config/agents/skills"
expected_skills=(
  agent-flow-epic
  agent-flow-feature
  agent-flow-review
  agent-flow-spike
  agent-flow-stacks
  code-review
  codebase-design
  diagnosing-bugs
  domain-modeling
  grill-with-docs
  grilling
  handoff
  i-have-adhd
  implement
  improve-codebase-architecture
  prototype
  setup-matt-pocock-skills
  split
  tdd
  to-spec
  to-tickets
  triage
  tuicr
  tuicr-reviews
  wayfinder
  write-a-skill
)

actual_skills="$(
  find "$skills_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; \
    | sort | tr '\n' ' '
)"
[[ "$actual_skills" == "${expected_skills[*]} " ]] \
  || fail "managed skill set differs from the approved portfolio"

for harness_root in .agents .claude .hermes; do
  for skill in "${expected_skills[@]}"; do
    linked_skill="$home/$harness_root/skills/$skill"
    [[ -L "$linked_skill" ]] \
      || fail "$harness_root is missing the $skill directory link"
    [[ "$(readlink "$linked_skill")" == "$root/config/agents/skills/$skill" ]] \
      || fail "$harness_root/$skill targets the wrong package"
  done
done
echo "ok - every approved package is linked as a discoverable directory"

expected_repository() {
  case "$1" in
    split) printf '%s\n' 'https://github.com/Iron-Ham/split.git' ;;
    agent-flow-stacks) printf '%s\n' 'https://github.com/Iron-Ham/split.git' ;;
    i-have-adhd) printf '%s\n' 'https://github.com/ayghri/i-have-adhd.git' ;;
    tuicr) printf '%s\n' 'https://github.com/agavra/tuicr.git' ;;
    *) printf '%s\n' 'https://github.com/mattpocock/skills.git' ;;
  esac
}

local_skills=(
  agent-flow-epic
  agent-flow-feature
  agent-flow-review
  agent-flow-spike
  tuicr-reviews
)

for skill in "${expected_skills[@]}"; do
  package="$skills_root/$skill"
  lineage="$package/LINEAGE.md"
  [[ -s "$package/SKILL.md" ]] || fail "$skill is missing SKILL.md"
  if [[ " ${local_skills[*]} " == *" $skill "* ]]; then
    [[ ! -e "$lineage" ]] || fail "$skill is local but unexpectedly has LINEAGE.md"
    continue
  fi
  [[ -s "$lineage" ]] || fail "$skill is missing LINEAGE.md"
  assert_contains "$(cat "$lineage")" 'schema_version: 1'
  kind="$(awk '/^kind: / { print $2; exit }' "$lineage")"
  [[ "$kind" =~ ^(mirror|derivative|composite)$ ]] \
    || fail "$skill has invalid lineage kind: $kind"
  assert_contains "$(cat "$lineage")" \
    "repository: $(expected_repository "$skill")"
  grep -Eq '^    path: skills/' "$lineage" \
    || fail "$skill lineage has no upstream path"
  revisions="$(awk '/^    revision: / { print $2 }' "$lineage")"
  [[ -n "$revisions" ]] || fail "$skill lineage has no revision"
  while IFS= read -r revision; do
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] \
      || fail "$skill has invalid upstream revision: $revision"
  done <<< "$revisions"
done
echo "ok - externally sourced skills have valid lineage and local skills are explicit"

[[ ! -d "$skills_root/caveman" ]] || fail "retired caveman skill is managed"
[[ ! -d "$skills_root/grill-me" ]] || fail "retired grill-me skill is managed"
[[ ! -d "$skills_root/zoom-out" ]] || fail "retired zoom-out skill is managed"
if grep -Eq '(^|[[:space:]])/(grilling|domain-modeling)([[:space:]]|$)' \
  "$skills_root/grill-with-docs/SKILL.md"; then
  fail "grill-with-docs still invokes component skills"
fi
if grep -REq '(^|[[:space:]])/(tdd|code-review|setup-matt-pocock-skills)([[:space:]]|$)' \
  "$skills_root/implement"; then
  fail "implement still invokes component skills"
fi
if grep -RniE --exclude=LINEAGE.md 'Agent tool|subagent_type' \
  "$skills_root" >/dev/null; then
  fail "managed skills contain Claude-specific Agent tool instructions"
fi
echo "ok - retired skills are absent and composites are self-contained"

assert_contains "$(cat "$root/config/agents/skills/README.md")" 'LINEAGE.md'
assert_contains "$(cat "$root/config/agents/profiles/README.md")" 'CONTRACT.md'
echo "ok - agent skill and profile conventions are documented"
