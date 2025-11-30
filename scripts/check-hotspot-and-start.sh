#!/bin/bash
# Toggle swing server based on current Wi-Fi SSID
# Install to: /usr/local/bin/check-hotspot-and-start.sh (chmod +x)

TARGET_SSID="SwingPhone"
SERVER_SERVICE="swing-server.service"

CURRENT_SSID="$(iwgetid -r)"

if [[ "$CURRENT_SSID" == "$TARGET_SSID" ]]; then
  echo "Connected to iPhone hotspot ($TARGET_SSID). Starting server..."
  systemctl start "$SERVER_SERVICE"
else
  echo "Not on iPhone hotspot. Stopping server..."
  systemctl stop "$SERVER_SERVICE"
fi
