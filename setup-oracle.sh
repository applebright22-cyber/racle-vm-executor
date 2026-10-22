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
HOST=127.0.0.1
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

if ! curl -fsS http://127.0.0.1:8787/health >/dev/null; then
  echo "Oracle executor did not become healthy. Check: sudo journalctl -u oracle-vm-executor -n 60 --no-pager" >&2
  exit 1
fi

DEFAULT_WORKER_URL="https://cloudflare-container-networking.brightlambre22-6dd.workers.dev"
read -r -p "Cloudflare Worker URL [$DEFAULT_WORKER_URL]: " WORKER_URL
WORKER_URL="${WORKER_URL:-$DEFAULT_WORKER_URL}"
WORKER_URL="${WORKER_URL%/}"
if [[ ! "$WORKER_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "Worker URL must be an https:// origin, with no path." >&2
  exit 1
fi

read -r -s -p "Enter the existing 5-digit Cloudflare Admin access code: " ADMIN_CODE
echo
if [[ ! "$ADMIN_CODE" =~ ^[0-9]{5}$ ]]; then
  unset ADMIN_CODE
  echo "The Admin access code must be exactly five digits." >&2
  exit 1
fi

# Store the Admin code in the root-owned 0600 environment file. Oracle uses it only
# to request short-lived WebSocket tickets; it is never sent to end users.
sudo sed -i '/^ORACLE_WORKER_URL=/d;/^ORACLE_ADMIN_CODE=/d' "$ENV_FILE"
printf 'ORACLE_WORKER_URL=%s\nORACLE_ADMIN_CODE=%s\n' "$WORKER_URL" "$ADMIN_CODE" | sudo tee -a "$ENV_FILE" >/dev/null
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"
unset ADMIN_CODE

sudo systemctl restart oracle-vm-executor
echo "Waiting for Oracle's outbound Cloudflare WebSocket connection..."
HEALTH_RESPONSE=""
for attempt in $(seq 1 30); do
  HEALTH_RESPONSE="$(curl -sS --max-time 5 http://127.0.0.1:8787/health || true)"
  if [[ "$HEALTH_RESPONSE" == *'"cloudflare_agent_connected":true'* ]]; then break; fi
  sleep 1
done

unset EXECUTOR_TOKEN

if [[ "$HEALTH_RESPONSE" != *'"cloudflare_agent_connected":true'* ]]; then
  echo "Oracle service is running, but its Cloudflare WebSocket agent did not connect." >&2
  echo "Health response: $HEALTH_RESPONSE" >&2
  echo "Check: sudo journalctl -u oracle-vm-executor -n 60 --no-pager" >&2
  echo "Verify that the Admin code matches Cloudflare's ADMIN_ACCESS_CODE secret." >&2
  exit 1
fi

echo
echo "Oracle executor installed and connected to Cloudflare."
echo "Transport: Oracle-initiated outbound HTTPS/WebSocket; no inbound Oracle port is required."
echo "The existing Cloudflare Worker and public API were not modified."
echo "No per-user API key is needed for the Admin connection."
echo "Logs: sudo journalctl -u oracle-vm-executor -n 60 --no-pager"
