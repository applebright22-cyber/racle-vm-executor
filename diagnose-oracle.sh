#!/usr/bin/env bash
# Safe, read-only diagnostic bundle for the Oracle VM executor.
# Does not print executor tokens, admin codes, session tokens, or shell history.
set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="oracle-vm-executor"
ENV_FILE="/etc/oracle-vm-executor.env"
WORKER_URL=""
HAS_EXECUTOR_TOKEN="no"
HAS_WORKER_URL="no"

if command -v sudo >/dev/null 2>&1 && sudo test -r "$ENV_FILE"; then
  HAS_EXECUTOR_TOKEN="$(sudo grep -q '^ORACLE_EXECUTOR_TOKEN=.' "$ENV_FILE" && echo yes || echo no)"
  WORKER_URL="$(sudo sed -n 's/^ORACLE_WORKER_URL=//p' "$ENV_FILE" | head -n 1)"
  [ -n "$WORKER_URL" ] && HAS_WORKER_URL="yes"
fi

echo "=== Oracle executor diagnostic (safe to share) ==="
echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "hostname=$(hostname)"
echo "os=$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}" )"
echo "architecture=$(uname -m)"
echo "node=$(node --version 2>/dev/null || echo missing)"
echo "npm=$(npm --version 2>/dev/null || echo missing)"
echo "repo_dir=$APP_DIR"
echo "git_branch=$(git -C "$APP_DIR" branch --show-current 2>/dev/null || echo unknown)"
echo "git_commit=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "executor_token_configured=$HAS_EXECUTOR_TOKEN"
echo "worker_url_configured=$HAS_WORKER_URL"
echo "worker_url_host=$(printf '%s' "$WORKER_URL" | sed -E 's#^https?://([^/]+).*#\1#; s#.*#&#' | cut -c1-120)"
echo
echo "=== Local health endpoint ==="
if command -v curl >/dev/null 2>&1; then
  curl --silent --show-error --max-time 4 http://127.0.0.1:8787/health 2>&1 || true
  echo
else
  echo "curl_missing"
fi
echo
echo "=== systemd service ==="
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active "$SERVICE" 2>&1 || true
  systemctl show "$SERVICE" -p ActiveState -p SubState -p NRestarts --no-pager 2>&1 || true
else
  echo "systemctl_missing"
fi
echo
echo "=== Recent bridge/service errors (last 80 lines, filtered) ==="
if command -v journalctl >/dev/null 2>&1; then
  sudo journalctl -u "$SERVICE" -n 80 --no-pager 2>&1 |
    grep -Ei 'error|fail|warn|bridge|poll|listen|health|register|timeout|refused|unauthorized|ready|runtime' |
    sed -E 's/(x-executor-token|ORACLE_EXECUTOR_TOKEN|ADMIN_CODE|session_token|api[_-]?key)[=: ]+[^ ,"]+/\1=[REDACTED]/Ig' |
    tail -n 40 || true
else
  echo "journalctl_missing"
fi
echo
echo "=== Repo checks ==="
(cd "$APP_DIR" && npm run check 2>&1) || echo "npm_check_failed"
(cd "$APP_DIR" && npm test 2>&1) || echo "npm_test_failed"
echo
echo "Diagnostic complete. Review before sharing; command output can contain environment-specific hostnames or paths."
