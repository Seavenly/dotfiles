#!/bin/sh
# Read-only inventory. Never execute a discovered interpreter or native agent.
set -eu
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  echo 'unsupported_host: actual macOS required' >&2
  exit 3
fi
echo 'Flow Mac diagnostic inventory (provider calls: 0)'
/usr/bin/sw_vers
/usr/bin/uname -srm
echo 'Observed interpreter lookup (not executed):'
command -v python3 || true
echo 'Choose a known, already installed Python 3.11+ absolute path for probe.py.'
echo 'Host restrictions, physical chip and translated execution remain operator inputs.'
