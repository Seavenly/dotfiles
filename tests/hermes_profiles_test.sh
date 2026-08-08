#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

# Resolve Node before isolating the fixture home so pre-links exercises the real
# profile preflight without asking the host mise shim to trust fixture state.
node_bin="$(mise which node)"
node_dir="$(dirname "$node_bin")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
config_home="$home/.config"
state_home="$home/.local/state"
mkdir -p "$home" "$config_home" "$state_home"
export PATH="$node_dir:$PATH"

HOME="$home" XDG_CONFIG_HOME="$config_home" DOTFILES_ROOT="$root" \
  "$root/internal/bootstrap/hermes-profiles"

routing="$config_home/dotfiles/hermes-routing.yaml"
[[ -f "$routing" ]] || fail "Hermes routing skeleton was not created"
[[ "$(file_mode "$routing")" == 600 ]] \
  || fail "Hermes routing skeleton is not mode 0600"
assert_contains "$(cat "$routing")" 'schema: dotfiles.hermes-routing/v1'
assert_contains "$(cat "$routing")" 'profiles: {}'
echo "ok - Hermes routing starts as secure machine-local configuration"

for profile in flow-controller analyst critic builder artifact gate; do
  config="$home/.hermes/profiles/$profile/config.yaml"
  [[ -f "$config" ]] || fail "$profile config was not rendered"
  [[ "$(file_mode "$config")" == 600 ]] \
    || fail "$profile config is not mode 0600"
done
echo "ok - empty routing still converges safe model-neutral profile configs"

collision_home="$tmp/collision-home"
collision_config="$collision_home/.config"
collision_state="$collision_home/.local/state"
mkdir -p "$collision_config/dotfiles" "$collision_state" \
  "$collision_home/.hermes/profiles/builder"
cp "$root/config/agent-flow/hermes-routing.example.yaml" \
  "$collision_config/dotfiles/hermes-routing.yaml"
printf '%s\n' 'user_owned: true' \
  > "$collision_home/.hermes/profiles/builder/config.yaml"
if HOME="$collision_home" XDG_CONFIG_HOME="$collision_config" \
  XDG_STATE_HOME="$collision_state" \
  DOTFILES_ROOT="$root" "$root/internal/bootstrap/pre-links" \
  >"$tmp/preflight.out" 2>&1; then
  fail "pre-dotfiles hook accepted an unmanaged Hermes profile"
fi
assert_contains "$(cat "$tmp/preflight.out")" 'unmanaged Hermes profile'
[[ ! -e "$collision_home/.hermes/profiles/builder/SOUL.md" ]] \
  || fail "preflight modified the unmanaged profile"
if HOME="$collision_home" XDG_CONFIG_HOME="$collision_config" \
  XDG_STATE_HOME="$collision_state" \
  DOTFILES_ROOT="$root" "$root/internal/bootstrap/hermes-profiles" \
  >"$tmp/collision.out" 2>&1; then
  fail "Hermes convergence claimed an unmanaged profile"
fi
assert_contains "$(cat "$tmp/collision.out")" 'unmanaged Hermes profile'
[[ ! -e "$collision_home/.hermes/profiles/analyst/config.yaml" ]] \
  || fail "collision preflight partially rendered another profile"
assert_contains \
  "$(cat "$collision_home/.hermes/profiles/builder/config.yaml")" \
  'user_owned: true'
HOME="$collision_home" XDG_CONFIG_HOME="$collision_config" \
  XDG_STATE_HOME="$collision_state" \
  DOTFILES_ROOT="$root" DOTFILES_FORCE=1 "$root/internal/bootstrap/pre-links"
HOME="$collision_home" XDG_CONFIG_HOME="$collision_config" \
  XDG_STATE_HOME="$collision_state" \
  DOTFILES_ROOT="$root" DOTFILES_FORCE=1 \
  "$root/internal/bootstrap/hermes-profiles" >/dev/null
assert_contains \
  "$(cat "$collision_home/.hermes/profiles/builder/.dotfiles-managed-profile")" \
  'dotfiles.hermes-profile/v1'
assert_not_contains \
  "$(cat "$collision_home/.hermes/profiles/builder/config.yaml")" \
  'user_owned: true'
echo "ok - Hermes profile collisions require explicit force takeover"

cat > "$routing" <<'EOF'
schema: dotfiles.hermes-routing/v1
profiles:
  flow-controller: &builder_route
    model:
      provider: openai-codex
      default: controller-model
  analyst:
    model:
      provider: openai-codex
      default: analyst-model
  critic:
    model:
      provider: anthropic
      default: critic-model
  builder:
    model:
      provider: openai-codex
      default: builder-model
  artifact:
    model:
      provider: openai-codex
      default: artifact-model
  gate:
    model:
      provider: openai-codex
      default: gate-model
EOF
chmod 0600 "$routing"

builder_home="$home/.hermes/profiles/builder"
unmanaged="$home/.hermes/profiles/local-only"
mkdir -p "$builder_home/memories" "$builder_home/sessions" "$unmanaged"
printf '%s\n' 'SECRET=preserved' > "$builder_home/.env"
printf '%s\n' '{"preserved":true}' > "$builder_home/auth.json"
printf '%s\n' 'memory' > "$builder_home/memories/notes.md"
printf '%s\n' 'session' > "$builder_home/sessions/session.json"
printf '%s\n' 'unmanaged: true' > "$unmanaged/config.yaml"

for _ in 1 2; do
  HOME="$home" XDG_CONFIG_HOME="$config_home" DOTFILES_ROOT="$root" \
    "$root/internal/bootstrap/hermes-profiles"
done

assert_contains "$(cat "$builder_home/config.yaml")" 'provider: openai-codex'
assert_contains "$(cat "$home/.hermes/profiles/critic/config.yaml")" 'provider: anthropic'
assert_contains "$(cat "$builder_home/.env")" 'SECRET=preserved'
assert_contains "$(cat "$builder_home/auth.json")" '"preserved":true'
assert_contains "$(cat "$builder_home/memories/notes.md")" 'memory'
assert_contains "$(cat "$builder_home/sessions/session.json")" 'session'
assert_contains "$(cat "$unmanaged/config.yaml")" 'unmanaged: true'
echo "ok - repeated Hermes convergence renders routing and preserves runtime state"

HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  MISE_TRUSTED_CONFIG_PATHS="$root" \
  mise -C "$root" -E linux bootstrap dotfiles apply --yes >/dev/null 2>&1
for profile in flow-controller analyst critic builder artifact gate; do
  profile_home="$home/.hermes/profiles/$profile"
  for managed in SOUL.md distribution.yaml; do
    [[ -L "$profile_home/$managed" ]] \
      || fail "$profile $managed was not linked"
    [[ "$(readlink "$profile_home/$managed")" \
      == "$root/config/agents/profiles/$profile/hermes/$managed" ]] \
      || fail "$profile $managed targets the wrong source"
  done
done
[[ -f "$unmanaged/config.yaml" ]] || fail "static profile links removed an unmanaged profile"
echo "ok - managed profile documents converge as individual links"

rm "$builder_home/.dotfiles-managed-profile"
HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  DOTFILES_ROOT="$root" \
  "$root/internal/bootstrap/pre-links"
assert_contains "$(cat "$builder_home/.dotfiles-managed-profile")" \
  'dotfiles.hermes-profile/v1'
HOME="$home" XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
  DOTFILES_ROOT="$root" \
  "$root/internal/bootstrap/hermes-profiles" >/dev/null
echo "ok - pre-marker managed profiles migrate without force"

linked_help="$(HOME="$home" env -u DOTFILES_ROOT "$home/.local/bin/agent-flow" --help)"
assert_contains "$linked_help" 'agent-flow doctor profiles'
echo "ok - linked agent-flow resolves its repository launcher"

npm test --prefix "$root/config/agent-flow" >/dev/null
echo "ok - Hermes profile renderer and doctor unit tests pass"
