#!/bin/sh
# Unadmitted diagnostic preflight. Never invoke Apple Python/compiler stubs.
set -eu
fail() { printf '%s\n' "Mac ownership canary: $*" >&2; exit 2; }
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'unsupported platform; Mac observation not run'
[ "$(/usr/bin/id -u)" != 0 ] || fail 'run as the ordinary logged-in user, without sudo'
developer=$(/usr/bin/xcode-select -p 2>/dev/null) || fail 'Command Line Tools are not selected; nothing installed'
case "$developer" in /*) ;; *) fail 'selected developer directory is not absolute' ;; esac
compiler="$developer/usr/bin/clang"
sdk="$developer/SDKs/MacOSX.sdk"
if [ ! -x "$compiler" ]; then
  compiler="$developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
  sdk="$developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
fi
[ -x "$compiler" ] && [ -f "$sdk/SDKSettings.json" ] && [ -d "$sdk/System/Library/Frameworks" ] ||
  fail 'selected compiler or macOS SDK is absent; nothing installed'
case "$(/usr/bin/file -L -b "$compiler")" in *Mach-O*) ;; *) fail 'selected compiler is not an installed native binary' ;; esac
python=${FLOW_MAC_PROBE_PYTHON:-}
case "$python" in /*) ;; *) fail 'set FLOW_MAC_PROBE_PYTHON to an existing non-Apple Python 3 absolute executable' ;; esac
# Resolve symlinks without Python, xcrun, a package manager, or install shims.
links=0
while :; do
  parent=${python%/*}
  leaf=${python##*/}
  parent=$(CDPATH='' cd -P "$parent" 2>/dev/null && pwd -P) || fail 'Python directory is absent'
  python="$parent/$leaf"
  [ -L "$python" ] || break
  links=$((links + 1))
  [ "$links" -le 16 ] || fail 'Python symlink chain is too long'
  target=$(/usr/bin/readlink "$python") || fail 'cannot resolve Python executable'
  case "$target" in /*) python=$target ;; *) python="$parent/$target" ;; esac
done
case "$python" in /usr/bin/*|/bin/*) fail 'Apple system Python/install stubs are not accepted' ;; esac
[ -f "$python" ] && [ -x "$python" ] || fail 'explicit Python executable is absent'
case "$(/usr/bin/file -b "$python")" in *Mach-O*) ;; *) fail 'explicit Python must resolve to an installed native binary' ;; esac
"$python" -I -S -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 2)' ||
  fail 'an already installed Python 3.9 or newer is required'
here=$(CDPATH='' cd -P "$(dirname "$0")" && pwd -P)
exec "$python" -I -S "$here/probe.py" "$@"
