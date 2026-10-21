# Oracle Persistent Host Executor

Oracle is the persistent execution layer behind the existing Cloudflare VM API. It runs network commands directly on the Oracle Linux host and keeps an account-specific shell session available after the browser user logs out.

**This service does not boot a second VM.** It does not need v86, the TinyCore ISO, BIOS images, or an Admin VM snapshot. The existing Cloudflare project and its ISO/browser UI are not rebuilt by this repository.

## How it works

- Cloudflare continues to authenticate users and forward the existing `/v1/vm/status` and `/v1/vm/exec` API calls.
- Oracle accepts the same internal `/status` and `/exec` calls, using the existing `x-executor-token` and account ID headers.
- Each `acct-...` account gets its own long-lived Bash process on Oracle, a separate working directory under `sessions/<account-id>/work`, and a small on-disk session record.
- Shell state such as the current directory and exported variables remains in the live shell while the service runs. The working directory and basic session metadata are saved to disk.
- The systemd service starts at boot and restarts automatically. A browser logout does not stop Oracle or its shell sessions.

The account/session boundary is keyed by the same account ID Cloudflare already passes. This is a persistent Oracle shell session, **not** a byte-for-byte mirror of the browser VM's RAM or its interactive terminal. Automatically mirroring arbitrary browser shell state would require the existing Cloudflare browser client to send that state; this repo deliberately does not change that project.

## Install or update on Oracle Linux

Run as the Oracle `opc` user with sudo access:

```sh
cd ~/racle-vm-executor
git pull --ff-only
bash setup-oracle.sh
```

The setup script installs the dependency-free Node.js service, creates the persistent session directory, configures systemd, and then registers the Oracle endpoint and machine-to-machine token with the existing Worker. It reuses the existing `ORACLE_EXECUTOR_TOKEN` from `/etc/oracle-vm-executor.env` or creates one on first install. It never prints the token.

During setup, enter the Worker URL, the Oracle public IPv4 address if it is not auto-detected, and the existing five-digit Admin access code. The code is used only to authorize one-time bridge registration; it is not saved on Oracle. The token is stored in the Worker’s dedicated Durable Object record, so no Cloudflare API token or manual `wrangler secret put` step is needed for the bridge.

**Deploy the small Worker source update once before running this installer version.** The update adds `POST /api/oracle/register`, `GET /api/oracle/health`, and login-session authentication for the existing VM API. This is not a rebuild of the Cloudflare project. Once the updated Worker is deployed, future Oracle installations register themselves automatically.

The setup script finishes only after the Worker reports that it can reach Oracle. If the health check fails, check that inbound TCP/8787 is allowed in the Oracle Cloud network security list and host firewall.

It does not download or replace `admin.snapshot`, and it does not require the five-digit Admin code for normal executor operation.

## API

All responses are JSON.

- `GET /health` — host service health; no guest-VM startup is required.
- `GET /status?identity=acct-<uuid>` — requires `x-executor-token`; returns the account session status.
- `POST /exec` — requires `x-executor-token`, `x-account-id: acct-<uuid>`, and JSON such as:

```json
{
  "command": "pwd; uname -a",
  "timeout_ms": 15000
}
```

The response includes `stdout`, `stderr`, `exit_code`, `execution_id`, and `runtime: "oracle-host"`. One command runs at a time per account; separate accounts can execute concurrently. If a command exceeds the HTTP timeout, the API returns a timeout response but deliberately leaves the command running and keeps that account's shell occupied until the command finishes.

Commands execute as the Linux user running the service (normally `opc`), not as root. The endpoint can run arbitrary shell commands, so possession of the executor token grants that level of command execution; keep the token private.

## Verify

```sh
npm run check
bash -n setup-oracle.sh
sudo systemctl status oracle-vm-executor --no-pager
curl -fsS http://127.0.0.1:8787/health
sudo journalctl -u oracle-vm-executor -n 60 --no-pager
```

Session metadata is stored in `sessions/` and is excluded from Git. Live shell processes and in-memory shell variables do not survive a service/host restart; the service and session directory are restored automatically, and the saved working directory is reused.
