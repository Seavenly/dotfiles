#!/usr/bin/env bash
# Securely set the default-profile GitHub token without putting it in shell history.
# Run on the host Mac, not inside Docker:
#   bash ~/.dotfiles/container/hermes-docker/set-github-token.sh

set -euo pipefail

ENV_FILE="${HERMES_DEFAULT_ENV:-$HOME/.hermes/.env}"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

printf 'Paste GitHub PAT for Hermes default Docker backend (input hidden): ' >&2
IFS= read -r -s TOKEN
printf '\n' >&2

if [ -z "$TOKEN" ]; then
  echo "No token entered; leaving $ENV_FILE unchanged." >&2
  exit 1
fi

# Preserve other env lines; replace existing GH_TOKEN/GITHUB_TOKEN lines.
TMP="$(mktemp)"
awk '!/^GH_TOKEN=/ && !/^GITHUB_TOKEN=/' "$ENV_FILE" > "$TMP"
printf 'GH_TOKEN=%s\n' "$TOKEN" >> "$TMP"
mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Wrote GH_TOKEN to $ENV_FILE (value hidden)." >&2
echo "Next: restart the default-profile Hermes session/container, then run:" >&2
echo "  bash /workspace/.dotfiles/container/hermes-docker/setup.sh" >&2
