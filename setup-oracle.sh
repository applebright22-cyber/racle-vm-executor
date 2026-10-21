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

read -r -p "Cloudflare Worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
read -r -s -p "Admin access code (used only to download the existing baseline snapshot): " ADMIN_ACCESS_CODE
echo
if [ -z "$WORKER_URL" ] || [ -z "$ADMIN_ACCESS_CODE" ]; then
  echo "Worker URL and admin code are required." >&2
  exit 1
fi
WORKER_URL="${WORKER_URL%/}"
export WORKER_URL ADMIN_ACCESS_CODE

echo "Installing the pinned v86 dependency..."
npm install --no-audit --no-fund

echo "Downloading the exact BIOS and TinyCore CD-ROM assets used by the saved VM..."
mkdir -p bios boot
curl -fsSL --retry 3 "$WORKER_URL/bios/seabios.bin" -o bios/seabios.bin
curl -fsSL --retry 3 "$WORKER_URL/bios/vgabios.bin" -o bios/vgabios.bin
curl -fsSL --retry 3 "$WORKER_URL/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso" -o boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso
test -s bios/seabios.bin
test -s bios/vgabios.bin
test -s boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso

echo "Downloading and verifying the existing Admin snapshot (it will not be regenerated)..."
python3 ./download-snapshot.py

EXECUTOR_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
NODE_PATH="$(command -v node)"

sudo install -o root -g root -m 600 /dev/null "$ENV_FILE"
sudo tee "$ENV_FILE" >/dev/null <<EOF
PORT=8787
HOST=0.0.0.0
WORKER_URL=$WORKER_URL
SNAPSHOT_PATH=$APP_DIR/admin.snapshot
WASM_PATH=$APP_DIR/node_modules/v86/build/v86.wasm
BIOS_PATH=$APP_DIR/bios/seabios.bin
VGA_BIOS_PATH=$APP_DIR/bios/vgabios.bin
CDROM_PATH=$APP_DIR/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso
ORACLE_EXECUTOR_TOKEN=$EXECUTOR_TOKEN
EOF
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Oracle v86 VM Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_PATH $APP_DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable oracle-vm-executor
sudo systemctl restart oracle-vm-executor || true
sleep 2
sudo systemctl --no-pager --full status oracle-vm-executor || true

echo
echo "Executor endpoint: http://141.148.53.68:8787"
echo "Executor token: $EXECUTOR_TOKEN"
echo "Configure this token as Cloudflare Worker secret ORACLE_EXECUTOR_TOKEN."
echo "Set ORACLE_EXECUTOR_URL to http://141.148.53.68:8787 and deploy the Worker."
echo "The executor checks snapshot/device compatibility before restoring and only reports ready after a shell handshake."
echo "Check startup details with: sudo journalctl -u oracle-vm-executor -n 80 --no-pager"
echo "The 5-digit Admin code was used only for snapshot download and was not saved in the executor environment."
