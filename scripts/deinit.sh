#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="omp-discord-bot.service"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME"

echo "Stopping and disabling $SERVICE_NAME..."
systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true

if [ -f "$SERVICE_FILE" ]; then
  echo "Removing service file $SERVICE_FILE..."
  rm -f "$SERVICE_FILE"
fi

echo "Reloading systemd daemon..."
systemctl --user daemon-reload
systemctl --user reset-failed 2>/dev/null || true

echo "=== Service successfully stopped and deinitialized ==="
