#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

PYTHONDONTWRITEBYTECODE=1 python3 "$root/tests/review_feed_test.py"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
stubs="$tmp/stubs"
mkdir -p "$stubs"
export HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/config" XDG_STATE_HOME="$tmp/state"
export REVIEW_FEED_LAUNCH_AGENTS_DIR="$tmp/agents" STUB_LOG="$tmp/log"
mkdir -p "$HOME"
cat > "$stubs/python3" <<'STUB'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "$STUB_LOG"
STUB
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\ncase "$1" in +%%u) echo "$STUB_DAY" ;; +%%H) echo "$STUB_HOUR" ;; esac\n' > "$stubs/date"
printf '#!/usr/bin/env bash\necho Darwin\n' > "$stubs/uname"
# launchctl print fails until bootstrap, like an unloaded job.
cat > "$stubs/launchctl" <<'STUB'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$STUB_LOG"
[[ $1 != print ]] || grep -q '^launchctl bootstrap' "$STUB_LOG"
STUB
chmod +x "$stubs"/*
feed=(env PATH="$stubs:$PATH" "$root/bin/review-feed")

: > "$STUB_LOG"
STUB_DAY=6 STUB_HOUR=10 "${feed[@]}" tick
STUB_DAY=3 STUB_HOUR=07 "${feed[@]}" tick
STUB_DAY=3 STUB_HOUR=18 "${feed[@]}" tick
assert_not_contains "$(cat "$STUB_LOG")" "python3"
STUB_DAY=1 STUB_HOUR=08 "${feed[@]}" tick
STUB_DAY=5 STUB_HOUR=17 "${feed[@]}" tick
assert_status "$(grep -c '^python3 .*review_feed.py$' "$STUB_LOG")" 2
echo "ok - scheduled ticks run only on weekdays 08:00-17:59"

status=0
"${feed[@]}" enable >/dev/null 2>&1 || status=$?
assert_status "$status" 1
assert_status "$(file_mode "$XDG_CONFIG_HOME/dotfiles/review-feed.env")" 600
[[ ! -e "$tmp/agents/dotfiles.review-feed.plist" ]] || fail "enable without an org installed the agent"
echo "ok - enable refuses to start without machine-local configuration"

printf 'REVIEW_FEED_ORG=example-org\nREVIEW_FEED_INTERVAL=120\n' > "$XDG_CONFIG_HOME/dotfiles/review-feed.env"
: > "$STUB_LOG"
"${feed[@]}" enable >/dev/null
plist="$tmp/agents/dotfiles.review-feed.plist"
assert_contains "$(cat "$plist")" "<string>$root/bin/review-feed</string>"
assert_contains "$(cat "$plist")" "<integer>120</integer>"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$plist" >/dev/null; fi
assert_contains "$(cat "$STUB_LOG")" "launchctl bootstrap gui/$(id -u) $plist"
"${feed[@]}" enable >/dev/null
assert_contains "$(cat "$STUB_LOG")" "launchctl bootout gui/$(id -u)/dotfiles.review-feed"
echo "ok - enable renders the agent and restarts it cleanly"

"${feed[@]}" disable >/dev/null
[[ ! -e "$plist" ]] || fail "disable left the agent plist"
echo "ok - disable removes the agent"
