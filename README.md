# Oracle VM Executor

A browserless v86 executor for the existing Cloudflare VM API. Cloudflare keeps account API-key validation and forwards authenticated `/v1/vm/status` and `/v1/vm/exec` requests to this service.

## Snapshot compatibility

The Admin snapshot was created by `public/vm.html` in the Cloudflare repository. The saved machine configuration is v86 `0.5.472`, 128 MiB guest RAM, 8 MiB VGA RAM, the exact TinyCore ISO at `/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso`, and an NE2K network device with keyboard enabled and mouse disabled.

The executor recreates those devices, waits for `emulator-loaded`, and compares the saved v86 buffer layout against a fresh state before restoring. It fails with `snapshot_machine_config_mismatch` instead of running a mismatched guest and crashing in the CPU page walker. The existing Admin snapshot is downloaded and verified; setup does not generate a replacement.

## Install on Oracle Linux 8

Run as the Oracle `opc` user with `sudo` access:

```bash
git clone https://github.com/applebright22-cyber/racle-vm-executor.git
cd racle-vm-executor
bash setup-oracle.sh
```

Setup installs Node.js 22+ if needed, installs the pinned v86 package, downloads the matching BIOS/VGA BIOS/TinyCore ISO, downloads and verifies the existing Admin snapshot, and writes the service environment to root-owned `/etc/oracle-vm-executor.env`. The five-digit Admin code is used only to download the snapshot; it is not stored on Oracle.

## Connect and start

1. Setup prints `ORACLE_EXECUTOR_TOKEN` after installing the service.
2. In the Cloudflare Worker project, set the secret with `npx wrangler secret put ORACLE_EXECUTOR_TOKEN` and paste that exact token.
3. Deploy the Worker. The current Worker code includes `/api/oracle/network-ticket`, which uses the same executor token to obtain a fresh short-lived WISP ticket. This avoids storing the Admin code on Oracle.
4. Restart Oracle so it can obtain a fresh network ticket: `sudo systemctl restart oracle-vm-executor`.
5. Check startup with `sudo journalctl -u oracle-vm-executor -n 100 --no-pager` and `curl -sS http://127.0.0.1:8787/health`.

The Worker must be deployed with the new route before the Oracle service can become ready. Allow TCP/8787 through the applicable Oracle Cloud and host firewall rules so the Worker can reach the executor.

## Runtime behavior

- `GET /health`: startup status and the exact startup error.
- `GET /status?identity=admin`: authenticated status endpoint used by the Worker.
- `POST /exec`: sends a command through v86 keyboard input to the restored VGA shell and checks for unique completion markers. It does not assume the guest has a serial shell.
- The service reports `ready` only after snapshot-layout compatibility, restore, and an interactive TinyCore shell handshake succeed.
- Only one command is dispatched at a time. Output is limited to text still visible in the guest terminal; this version does not implement full scrollback capture or per-account snapshot persistence.

The current Oracle process runs the Admin baseline only. The account ID is preserved at the API boundary, but per-account guest selection and snapshot persistence are not yet implemented.
