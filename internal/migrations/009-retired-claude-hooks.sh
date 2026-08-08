#!/usr/bin/env bash
set -euo pipefail

settings="$HOME/.claude/settings.json"
notify_link="$HOME/.claude/hooks/notify.sh"
legacy_notify="$DOTFILES_ROOT/claude/hooks/notify.sh"
managed_notify="$DOTFILES_ROOT/config/claude/hooks/notify.sh"
home_notify="$HOME/.claude/hooks/notify.sh"
legacy_cockpit="$DOTFILES_ROOT/claude/hooks/cockpit-hook.sh"
dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"

remove_link=0
if [[ -L "$notify_link" ]]; then
  link_target="$(readlink "$notify_link")"
  if [[ "$link_target" == "$legacy_notify" || "$link_target" == "$managed_notify" ]]; then
    remove_link=1
  fi
fi

remove_settings=0
if [[ -r "$settings" ]]; then
  command -v jq >/dev/null 2>&1 || exit 75
  set +e
  jq -e \
    --arg legacy_notify "$legacy_notify" \
    --arg managed_notify "$managed_notify" \
    --arg home_notify "$home_notify" \
    --arg legacy_cockpit "$legacy_cockpit" \
    '[.hooks[]?[]?.hooks[]?.command?] | any(
      . == $legacy_notify or . == $managed_notify or
      . == $home_notify or . == $legacy_cockpit
    )' "$settings" >/dev/null
  jq_status=$?
  set -e
  case "$jq_status" in
    0) remove_settings=1 ;;
    1) ;;
    *) exit 75 ;;
  esac
fi

if ((dry_run)); then
  ((remove_link)) && printf 'Would remove retired Claude notification link %s.\n' "$notify_link"
  ((remove_settings)) && printf 'Would remove retired Claude hook registrations from %s.\n' "$settings"
  exit 0
fi

((remove_link == 0)) || unlink "$notify_link"

if ((remove_settings)); then
  tmp="$(mktemp "${settings}.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  jq \
    --arg legacy_notify "$legacy_notify" \
    --arg managed_notify "$managed_notify" \
    --arg home_notify "$home_notify" \
    --arg legacy_cockpit "$legacy_cockpit" \
    '.hooks |= with_entries(
      .value |= map(
        .hooks |= map(select(
          (.command // "") != $legacy_notify and
          (.command // "") != $managed_notify and
          (.command // "") != $home_notify and
          (.command // "") != $legacy_cockpit
        ))
      )
      | .value |= map(select((.hooks | length) > 0))
    )
    | .hooks |= with_entries(select((.value | length) > 0))' \
    "$settings" > "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$settings"
  trap - EXIT
fi
