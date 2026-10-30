#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="$(id -un)"
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 "$APP_DIR/oracle-vm-account-shell" /usr/local/libexec/oracle-vm-account-shell
SUDOERS_FILE="/etc/sudoers.d/oracle-vm-executor"
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/oracle-vm-account-shell *\n' "$SERVICE_USER" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chown root:root "$SUDOERS_FILE"
sudo chmod 0440 "$SUDOERS_FILE"
sudo visudo -cf "$SUDOERS_FILE"
echo "Per-account Linux shell launcher installed for service user $SERVICE_USER."
