#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if ! command -v sudo >/dev/null 2>&1; then
  echo "Run this as the Oracle Linux opc user with sudo access." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Installing current Node.js LTS..."
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo dnf install -y nodejs
fi

read -r -p "Cloudflare Worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
read -r -s -p "Admin access code (used only to download the existing baseline snapshot): " ADMIN_ACCESS_CODE
echo
if [ -z "$WORKER_URL" ] || [ -z "$ADMIN_ACCESS_CODE" ]; then
  echo "Worker URL and admin code are required." >&2
  exit 1
fi

echo "Installing v86..."
npm install --no-audit --no-fund

echo "Downloading and verifying the existing Admin snapshot..."
WORKER_URL="$WORKER_URL" ADMIN_ACCESS_CODE="$ADMIN_ACCESS_CODE" python3 ./download-snapshot.py

EXECUTOR_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
cat > .env <<EOF
PORT=8787
HOST=0.0.0.0
SNAPSHOT_PATH=$APP_DIR/admin.snapshot
WASM_PATH=$APP_DIR/node_modules/v86/build/v86.wasm
BIOS_PATH=$APP_DIR/node_modules/v86/bios/seabios.bin
VGA_BIOS_PATH=$APP_DIR/node_modules/v86/bios/vgabios.bin
ORACLE_EXECUTOR_TOKEN=$EXECUTOR_TOKEN
EOF
chmod 600 .env

NODE_PATH="$(command -v node)"
sudo tee /etc/systemd/system/oracle-vm-executor.service >/dev/null <<EOF
[Unit]
Description=Oracle v86 VM Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_PATH $APP_DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now oracle-vm-executor
sleep 2
sudo systemctl --no-pager --full status oracle-vm-executor || true

echo
echo "ORACLE_EXECUTOR_URL=http://141.148.53.68:8787"
echo "ORACLE_EXECUTOR_TOKEN=$EXECUTOR_TOKEN"
echo "Save the token; configure it as a Cloudflare Worker secret named ORACLE_EXECUTOR_TOKEN."
echo "Set ORACLE_EXECUTOR_URL as a Worker variable, then deploy the Cloudflare Worker."
echo "If OCI ingress is not already open, allow TCP port 8787 from Cloudflare egress addresses."
echo "Check the guest restore with: curl http://127.0.0.1:8787/health"
