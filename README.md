# Oracle Persistent Host Executor

This service runs on the Oracle Linux host and keeps an outbound WebSocket connection to the existing Cloudflare Worker. It provides the persistent **Oracle host** command session used by the project's Admin execution path.

**It is not TinyCore, does not mirror the browser VM's RAM, and does not forward the TinyCore guest's network packets.**

## Runtime boundary

- The browser VM runs in v86 in the browser and stores snapshots in Cloudflare R2.
- This service runs Bash commands on the Oracle Linux host as the service user (normally opc).
- The Cloudflare agent connection uses an outbound WebSocket; no public Oracle API port is needed for that connection.
- The Worker blocks account-level Oracle shell execution unless ORACLE_ACCOUNT_EXEC_ENABLED is exactly true.
- **Do not enable account-level execution yet.** Per-account session directories are not OS isolation. Do not route untrusted users' commands to the shared host until per-account OS/container isolation and end-to-end identity validation are implemented and tested.

## Install or update

Run as the Oracle opc user with sudo access:

~~~sh
cd ~/racle-vm-executor
git pull --ff-only
bash setup-oracle.sh
~~~

The setup script installs Node.js if needed, installs dependencies, configures the systemd service, and prompts for the Cloudflare Worker origin and the existing five-digit Admin access code. It preserves the local executor token when updating configuration.

The Admin access code is stored in /etc/oracle-vm-executor.env with restricted permissions and is used to request a short-lived agent ticket. The separate ORACLE_EXECUTOR_TOKEN protects the local /status and /exec endpoints. Keep it private.

## Health and logs

~~~sh
curl -fsS http://127.0.0.1:8787/health
sudo systemctl status oracle-vm-executor --no-pager
sudo journalctl -u oracle-vm-executor -n 60 --no-pager
~~~

A healthy service reports runtime: "oracle-host" and cloudflare_agent_connected: true when the WebSocket is connected. guest_network_relay: false is expected: guest networking is handled separately by the Cloudflare WISP relay. A healthy local process does not prove guest DNS works or that account-level Oracle execution is enabled.

## Local API

All responses are JSON.

- GET /health — service and Cloudflare-agent connection status.
- GET /status?identity=admin — requires the local x-executor-token.
- POST /exec — requires x-executor-token, an x-account-id identity, and a JSON body.

Example request body:

~~~json
{
  "command": "pwd; uname -a",
  "timeout_ms": 15000
}
~~~

Commands execute with the Linux permissions of the service user, not as root. The endpoint can run arbitrary shell commands, so keep the local token private. Commands are limited to 4,096 characters and a maximum timeout of 20 seconds. A timeout may leave the command running; check the session before submitting another command.

## Checks

~~~sh
npm test
npm run check
~~~

These run the local Node.js tests and syntax check. They do not deploy the Cloudflare Worker or run GitHub Actions.
