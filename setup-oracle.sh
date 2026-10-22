#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
SERVICE_FILE="/etc/systemd/system/oracle-vm-executor.service"

if [ ! -f "$APP_DIR/admin.snapshot" ]; then
  echo "Existing admin.snapshot is missing. Snapshot was not created or changed." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "Run this as the Oracle opc user with sudo access." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Installing Node.js 24 on the Oracle host..."
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo dnf install -y nodejs
fi

npm install --no-audit --no-fund
node --check server.js

NODE_PATH="$(command -v node)"
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Oracle VM Snapshot Restorer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
Environment=PORT=8787
Environment=HOST=0.0.0.0
Environment=SNAPSHOT_PATH=$APP_DIR/admin.snapshot
ExecStart=$NODE_PATH $APP_DIR/server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable oracle-vm-executor
sudo systemctl restart oracle-vm-executor

echo "Oracle snapshot restorer installed."
echo "It restores the existing admin.snapshot and does not start the guest CPU or send guest commands."
echo "Snapshot file was not modified."
