# Oracle Persistent Host Executor

Oracle is the persistent execution layer behind the existing Cloudflare VM API. It runs account-scoped Bash sessions on the Oracle Linux host and maintains an outbound WebSocket connection to Cloudflare. The existing Cloudflare Worker and public API are not rebuilt or modified by this repository.

**This is a persistent Oracle host shell, not a byte-for-byte mirror of browser VM RAM or a shell inside the Tiny Core guest.**

> **Multi-user safety gate:** account-named session directories do not isolate arbitrary shell commands. Commands run with the Linux permissions of the service user (normally `opc`). Do not expose the host shell as a normal-user terminal or route untrusted account commands to the shared `oracle` agent until per-account OS/container isolation and end-to-end identity validation are implemented and tested. The installer binds the local HTTP API to `127.0.0.1`; the Cloudflare agent uses an outbound WebSocket.
 The existing Worker currently routes its VM execution API to the Admin identity; this bridge connects as `admin`.

## How it works

- Oracle requests a short-lived agent ticket from `POST /api/vm/agent-ticket` using the existing five-digit Cloudflare Admin access code.
- Oracle opens `/api/vm/agent?ticket=...` over WebSocket. The ticket is single-use and expires after 60 seconds.
- Cloudflare sends execution requests over the existing WebSocket protocol; Oracle runs each command in its persistent Admin Bash session and returns stdout, stderr, exit code, and timeout state.
- Oracle sends heartbeats and reconnects automatically if the connection drops.
- The connection is outbound from Oracle. No public Oracle IP endpoint, inbound firewall rule, Cloudflare API token, or per-user API key is required for the Admin agent connection.

The Admin access code is stored in `/etc/oracle-vm-executor.env`, which the setup script restricts to root read/write. It is used only to request agent tickets. The separate `ORACLE_EXECUTOR_TOKEN` protects the Oracle host's local `/status` and `/exec` endpoints.

Each supported identity has a separate long-lived Bash process and working directory under `sessions/<identity>/work`. Session metadata, working directory, command count, and last exit code are saved on disk. Live shell processes and exported shell variables do not survive a service restart.

## Install or update on Oracle Linux

Run as the Oracle `opc` user with sudo access:

```sh
cd ~/racle-vm-executor
git pull --ff-only
bash setup-oracle.sh
```

The setup script installs Node.js 22 or newer if needed, installs the project dependencies, configures the systemd service, and asks for:

1. The Cloudflare Worker HTTPS origin (defaults to the current project Worker).
2. The existing five-digit Cloudflare Admin access code.

It preserves the existing local executor token when re-running setup, writes the Worker URL and Admin code into the protected environment file, restarts the service, and waits for `cloudflare_agent_connected: true` from the local health endpoint. It does not call missing `/api/oracle/*` routes or require changes to Cloudflare.

## Health and logs

```sh
curl -fsS http://127.0.0.1:8787/health
sudo systemctl status oracle-vm-executor --no-pager
sudo journalctl -u oracle-vm-executor -n 60 --no-pager
```

A healthy service reports `runtime: "oracle-host"` and `cloudflare_agent_connected: true` when its WebSocket is connected. A healthy local process alone does not prove the Worker connection is online.

## Local API

All responses are JSON.

- `GET /health` — local service and Cloudflare-agent connection status.
- `GET /status?identity=admin` — requires the local `x-executor-token`; returns persistent shell status.
- `POST /exec` — requires `x-executor-token`, `x-account-id: acct-<uuid>`, and a JSON body such as:

```json
{
  "command": "pwd; uname -a",
  "timeout_ms": 15000
}
```

Commands execute as the Linux user running the service (normally `opc`), not as root. The endpoint can run arbitrary shell commands, so keep the local executor token private. A command timeout leaves the command running and keeps that session busy until it finishes.
