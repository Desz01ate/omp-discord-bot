#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BUN_BIN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
if [ ! -x "$BUN_BIN" ]; then
  echo "Error: bun binary not found." >&2
  exit 1
fi

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="omp-discord-bot.service"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME"

mkdir -p "$SYSTEMD_USER_DIR"

echo "Creating systemd user service at $SERVICE_FILE..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OMP Interactive Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=-$PROJECT_DIR/.env
Environment=PATH=$PATH:$HOME/.bun/bin:$HOME/.local/bin
Environment=HOME=$HOME
ExecStart=$BUN_BIN run src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

echo "Reloading systemd daemon and enabling service..."
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo ""
echo "=== Service initialized ==="
echo "Status:"
systemctl --user --no-pager status "$SERVICE_NAME" || true
echo ""
echo "To view live logs: journalctl --user -u $SERVICE_NAME -f"
echo "To stop/remove:    $PROJECT_DIR/scripts/deinit.sh"
