#!/bin/zsh

source ./colors.sh

IP=$(curl -s https://ipinfo.io/ip)
LOCATION_JSON=$(curl -s https://ipinfo.io/$IP/json)

LOCATION="$(echo $LOCATION_JSON | jq '.city' | tr -d '"')"
REGION="$(echo $LOCATION_JSON | jq '.region' | tr -d '"')"
COUNTRY="$(echo $LOCATION_JSON | jq '.country' | tr -d '"')"

# Line below replaces spaces with +
LOCATION_ESCAPED="${LOCATION// /+}+${REGION// /+}"
WEATHER_JSON=$(curl -s "https://wttr.in/$LOCATION_ESCAPED?format=j1")

# Fallback if empty
if [ -z $WEATHER_JSON ]; then

    sketchybar --set $NAME label=$LOCATION

    return
fi

TEMPERATURE=$(echo $WEATHER_JSON | jq -r '.current_condition[0].temp_F')
WEATHER_CODE=$(echo $WEATHER_JSON | jq -r '.current_condition[0].weatherCode')
WEATHER_DESCRIPTION=$(echo $WEATHER_JSON | jq -r '.current_condition[0].weatherDesc[0].value' | sed 's/\(.\{25\}\).*/\1.../')

ICON_SUN_MAX_FILL=􀆮
ICON_SUN_SNOW_FILL=􁷑
ICON_CLOUD_SUN_FILL=􀇕
ICON_CLOUD_SUN_RAIN_FILL=􀇗
ICON_CLOUD_SUN_BOLT_FILL=􀇙

ICON_MOON_FILL=􀆺
ICON_CLOUD_MOON_FILL=􀇛
ICON_CLOUD_MOON_RAIN_FILL=􀇝
ICON_CLOUD_MOON_BOLT_FILL=􀇡

ICON_CLOUD_FILL=􀇃
ICON_CLOUD_DRIZZLE_FILL=􀇅
ICON_CLOUD_RAIN_FILL=􀇇
ICON_CLOUD_HEAVYRAIN_FILL=􀇉
ICON_CLOUD_FOG_FILL=􀇋
ICON_CLOUD_HAIL_FILL=􀇍
ICON_CLOUD_SNOW_FILL=􀇏
ICON_CLOUD_SLEET_FILL=􀇑
ICON_CLOUD_BOLT_FILL=􀇓
ICON_CLOUD_BOLT_RAIN_FILL=􀇟
ICON_SMOKE_FILL=􀇣
ICON_WIND=􀇤
ICON_WIND_SNOW=􀇦

# Codes: https://www.worldweatheronline.com/weather-api/api/docs/weather-icons.aspx
case ${WEATHER_CODE} in
    "113") # Clear/Sunny
        if [ $WEATHER_DESCRIPTION = "Sunny" ]; then
            WEATHER_ICON=$ICON_SUN_MAX_FILL
            WEATHER_ICON_COLOR=$COLOR_CARP_YELLOW
        else
            WEATHER_ICON=$ICON_MOON_FILL
            WEATHER_ICON_COLOR=$COLOR_CARP_YELLOW
        fi
        ;;
    "116") # Partly Cloudy
        WEATHER_ICON=$ICON_CLOUD_SUN_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "119") # Cloudy
        WEATHER_ICON=$ICON_CLOUD_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "122") # Overcast
        WEATHER_ICON=$ICON_SMOKE_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "143") # Mist
        WEATHER_ICON=$ICON_CLOUD_DRIZZLE_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "176") # Patchy rain nearby
        WEATHER_ICON=$ICON_CLOUD_SUN_RAIN_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "179") # Patchy snow nearby
        WEATHER_ICON=$ICON_SUN_SNOW_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "182") # Patchy sleet nearby
        WEATHER_ICON=$ICON_CLOUD_SLEET_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "185") # Patchy freezing drizzle nearby
        WEATHER_ICON=$ICON_CLOUD_SLEET_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "200") # Thundery outbreaks in nearby
        WEATHER_ICON=$ICON_CLOUD_SUN_BOLT_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "227") # Blowing snow
        WEATHER_ICON=$ICON_WIND_SNOW
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "230") # Blizzard
        WEATHER_ICON=$ICON_CLOUD_SNOW_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "248") # Fog
        WEATHER_ICON=$ICON_CLOUD_FOG_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "260") # Freezing Fog
        WEATHER_ICON=$ICON_CLOUD_FOG_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "263") # Patchy light drizzle
        WEATHER_ICON=$ICON_CLOUD_SUN_RAIN_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "266") # Light drizzle
        WEATHER_ICON=$ICON_CLOUD_SUN_RAIN_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_WHITE
        ;;
    "281") # Freezing drizzle
        WEATHER_ICON=$ICON_CLOUD_SUN_RAIN_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    "284") # Heavy freezing drizzle
        WEATHER_ICON=$ICON_CLOUD_SLEET_FILL
        WEATHER_ICON_COLOR=$COLOR_FUJI_GRAY
        ;;
    *)
        WEATHER_ICON=􀿩
        WEATHER_ICON_COLOR=$COLOR_FUJI_YELLOW
        ;;
esac

sketchybar --set $NAME \
    label="$TEMPERATURE°F • $WEATHER_DESCRIPTION" \
    icon=$WEATHER_ICON \
    icon.color=$WEATHER_ICON_COLOR
