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

# Configure Oracle to initiate HTTPS requests to the Worker; no inbound public IP route is used.
sudo sed -i '/^ORACLE_WORKER_URL=/d' "$ENV_FILE"
printf 'ORACLE_WORKER_URL=%s\n' "$WORKER_URL" | sudo tee -a "$ENV_FILE" >/dev/null
sudo systemctl restart oracle-vm-executor
sleep 2

REGISTER_BODY="$(EXECUTOR_TOKEN="$EXECUTOR_TOKEN" node -e 'process.stdout.write(JSON.stringify({executor_token:process.env.EXECUTOR_TOKEN}))')"
echo "Registering Oracle reverse bridge with Cloudflare..."
if ! REGISTER_RESPONSE="$(curl -fsS --max-time 15 -X POST "$WORKER_URL/api/oracle/register" \
  -H "x-admin-code: $ADMIN_CODE" \
  -H "content-type: application/json" \
  --data "$REGISTER_BODY")"; then
  unset ADMIN_CODE EXECUTOR_TOKEN REGISTER_BODY
  echo "Oracle is running, but Cloudflare registration failed." >&2
  echo "Deploy the updated Cloudflare Worker source, then re-run: bash setup-oracle.sh" >&2
  exit 1
fi

echo "Waiting for Oracle's outbound HTTPS channel..."
HEALTH_RESPONSE=""
for attempt in $(seq 1 20); do
  HEALTH_RESPONSE="$(curl -sS --max-time 5 "$WORKER_URL/api/oracle/health" -H "x-admin-code: $ADMIN_CODE" || true)"
  if [[ "$HEALTH_RESPONSE" == *'"oracle_reachable":true'* ]]; then break; fi
  sleep 1
done
unset ADMIN_CODE EXECUTOR_TOKEN REGISTER_BODY

if [[ "$HEALTH_RESPONSE" != *'"oracle_reachable":true'* ]]; then
  echo "Registration succeeded, but Oracle has not checked in through outbound HTTPS." >&2
  echo "Health response: $HEALTH_RESPONSE" >&2
  echo "Check: sudo journalctl -u oracle-vm-executor -n 60 --no-pager" >&2
  exit 1
fi

echo
echo "Oracle executor installed and registered."
echo "Transport: Oracle-initiated outbound HTTPS polling; no domain or public Oracle endpoint required."
echo "Cloudflare registration: $REGISTER_RESPONSE"
echo "End-to-end bridge check: $HEALTH_RESPONSE"
echo "The machine-to-machine token stays on Oracle and in Cloudflare Durable Object storage; it is not printed."
echo "No user API key is needed when the Worker receives the user's valid login session token."
echo "No guest VM, snapshot download, ISO, BIOS, or v86 package is required."
echo "Logs: sudo journalctl -u oracle-vm-executor -n 60 --no-pager"
