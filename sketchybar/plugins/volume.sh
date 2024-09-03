#!/bin/sh

# The volume_change event supplies a $INFO variable in which the current volume
# percentage is passed to the script.

if [ "$SENDER" = "volume_change" ]; then
  VOLUME="$INFO"

  case "$VOLUME" in
    [6-9][0-9]|100) 
        ICON="􀊩"
        ICON_PADDING_RIGHT=8
        ;;
    [3-5][0-9]) 
        ICON="􀊧"
        ICON_PADDING_RIGHT=11
        ;;
    [1-9]|[1-2][0-9])
        ICON="􀊥"
        ICON_PADDING_RIGHT=14
        ;;
    *) 
        ICON="􀊣"
        ICON_PADDING_RIGHT=8
  esac

  sketchybar --set "$NAME" icon="$ICON" label="$VOLUME%" icon.padding_right="$ICON_PADDING_RIGHT"
fi
