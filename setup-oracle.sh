#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
ENV_FILE="/etc/oracle-vm-executor.env"
SERVICE_FILE="/etc/systemd/system/oracle-vm-executor.service"

if ! command -v sudo >/dev/null 2>&1; then
  echo "Run this as the Oracle Linux opc user with sudo access." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Installing Node.js 24..."
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo dnf install -y nodejs
fi

# Reuse the existing service token so the current Cloudflare Worker configuration
# remains valid. Only create a new token on a first install.
EXECUTOR_TOKEN=""
if sudo test -f "$ENV_FILE"; then
  EXECUTOR_TOKEN="$(sudo sed -n 's/^ORACLE_EXECUTOR_TOKEN=//p' "$ENV_FILE" | head -n 1 || true)"
fi
TOKEN_CREATED="false"
if [ -z "$EXECUTOR_TOKEN" ]; then
  EXECUTOR_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  TOKEN_CREATED="true"
fi

echo "Installing the dependency-free native host executor..."
npm install --no-audit --no-fund
mkdir -p sessions
chmod 700 sessions
node --check server.js
bash -n setup-oracle.sh

NODE_PATH="$(command -v node)"
sudo tee "$ENV_FILE" >/dev/null <<EOF
PORT=8787
HOST=0.0.0.0
SESSIONS_DIR=$APP_DIR/sessions
ORACLE_EXECUTOR_TOKEN=$EXECUTOR_TOKEN
EOF
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Oracle Persistent Host Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
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
sleep 2

echo
echo "Oracle persistent executor: http://$(hostname -I | awk '{print $1}'):8787"
curl -fsS http://127.0.0.1:8787/health || true
echo
if [ "$TOKEN_CREATED" = "true" ]; then
  echo "A new ORACLE_EXECUTOR_TOKEN was created. Set this same value as the Cloudflare Worker's ORACLE_EXECUTOR_TOKEN secret:"
  echo "$EXECUTOR_TOKEN"
else
  echo "Existing ORACLE_EXECUTOR_TOKEN preserved; the Worker secret does not need to change."
fi
echo
echo "Set the existing Worker's ORACLE_EXECUTOR_URL to the endpoint URL above if it is not already configured."
echo "No guest VM, snapshot download, ISO, BIOS, or v86 package is required."
echo "Logs: sudo journalctl -u oracle-vm-executor -n 60 --no-pager"
