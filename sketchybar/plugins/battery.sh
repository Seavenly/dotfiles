#!/bin/sh

source ./colors.sh

PERCENTAGE="$(pmset -g batt | grep -Eo "\d+%" | cut -d% -f1)"
CHARGING="$(pmset -g batt | grep 'AC Power')"

if [ "$PERCENTAGE" = "" ]; then
  exit 0
fi

case ${PERCENTAGE} in
9[0-9] | 100)
    ICON="􀛨"
    ICON_COLOR=$COLOR_SPRING_GREEN
    ;;
[7-8][0-9])
    ICON="􀺸"
    ICON_COLOR=$COLOR_WAVE_AQUA_2
    ;;
[4-6][0-9])
    ICON="􀺶"
    ICON_COLOR=$COLOR_SURUMI_ORANGE
    ;;
[1-3][0-9])
    ICON="􀛩"
    ICON_COLOR=$COLOR_WAVE_RED
    ;;
[0-9])
    ICON="􀛪"
    ICON_COLOR=$COLOR_SAMURAI_RED
    ;;
esac

if [[ $CHARGING != "" ]]; then
    ICON="􀢋"
    ICON_COLOR=$COLOR_CARP_YELLOW
fi

# The item invoking this script (name $NAME) will get its icon and label
# updated with the current battery status
sketchybar --set "$NAME" icon="$ICON" label="${PERCENTAGE}%" icon.color=${ICON_COLOR}
