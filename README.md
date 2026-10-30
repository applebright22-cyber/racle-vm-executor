# Oracle Persistent Host Executor

This service runs on the Oracle Linux host and keeps an outbound WebSocket connection to the existing Cloudflare Worker. It provides the persistent **Oracle host** command session used by the project's Admin execution path.

**It is not TinyCore, does not mirror the browser VM's RAM, and does not forward the TinyCore guest's network packets.**

## Runtime boundary

- The browser VM runs in v86 in the browser and stores snapshots in Cloudflare R2.
- This service runs Bash commands on the Oracle Linux host as the service user (normally opc).
- The Cloudflare agent connection uses an outbound WebSocket; no public Oracle API port is needed for that connection.
- The Worker blocks account-level Oracle shell execution unless ORACLE_ACCOUNT_EXEC_ENABLED is exactly true.
- Regular-account shells run under a dedicated unprivileged Linux account (a unique 32-character username derived from the account UUID) with a private home/workspace, separate from `opc` and every other account. The root-owned launcher validates the account ID, provisions the account, and applies process, memory, file-size, open-file, CPU-time, and core-dump limits before starting Bash. Admin remains on the existing `opc` shell.
- This is Linux user/process isolation, not a container or separate kernel. It reduces cross-account file/process access but still shares the host kernel and network. Keep `ORACLE_ACCOUNT_EXEC_ENABLED` disabled until the launcher is installed and the two-account isolation test plus end-to-end account identity tests pass.

## Install or update

Run as the Oracle opc user with sudo access:

~~~sh
cd ~/racle-vm-executor
git pull --ff-only
bash setup-oracle.sh
~~~

The setup script installs Node.js if needed, installs dependencies, installs the root-owned per-account shell launcher and its narrowly scoped sudoers rule, configures the systemd service, and prompts for the Cloudflare Worker origin and the existing five-digit Admin access code. It preserves the local executor token when updating configuration.

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

Admin commands execute as the `opc` service user. Account commands execute as a dedicated unprivileged Linux user with a private home/workspace and limits on process count, virtual memory, file size, open files, CPU time, and core dumps. Account commands are not containerized and still share the host kernel/network. The local endpoint can run arbitrary shell commands, so keep the local executor token private. Commands are limited to 4,096 characters and a maximum timeout of 20 seconds; timed-out shells are killed and restarted.

## Checks

~~~sh
npm test
npm run check
~~~

These run the local Node.js tests and syntax check. They do not deploy the Cloudflare Worker or run GitHub Actions.


## Per-account isolation smoke test

After updating the Oracle host, run:

~~~sh
bash test-account-isolation.sh
~~~

The test provisions two temporary Linux users, writes a private file in the first workspace, verifies the second account cannot read it, and removes the temporary users. It does not enable regular-account execution in Cloudflare. Leave `ORACLE_ACCOUNT_EXEC_ENABLED` disabled until this test and authenticated end-to-end identity checks pass.
