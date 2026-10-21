# Oracle VM Executor

A browserless v86 executor for the existing Cloudflare VM API. Cloudflare keeps account API-key validation and forwards authenticated `/v1/vm/status` and `/v1/vm/exec` requests to this service.

## Snapshot compatibility is mandatory

The Admin snapshot was created by `public/vm.html` in the Cloudflare repository. The emulator configuration used there is:

- v86 `0.5.472`
- 128 MiB guest RAM
- 8 MiB VGA RAM
- the exact TinyCore ISO at `/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso`
- an NE2K network device
- keyboard enabled and mouse disabled

The Oracle executor now initializes those same devices and waits until all VM assets have loaded. Before restoring, it compares the snapshot serialized v86 buffer layout against a fresh state from that configured machine. It fails with a specific `snapshot_machine_config_mismatch` error instead of running a mismatched guest and crashing in the CPU page walker.

The snapshot is downloaded and SHA-256 verified. Setup does not create, regenerate, or overwrite the existing Admin baseline.

## Install on Oracle Linux 8

Run as the Oracle `opc` user with `sudo` access:

```bash
git clone https://github.com/applebright22-cyber/racle-vm-executor.git
cd racle-vm-executor
bash setup-oracle.sh
```

The setup script:
1. Ensures Node.js 22+ is installed.
2. Installs the pinned v86 package.
3. Downloads the exact BIOS, VGA BIOS, and TinyCore ISO assets from the configured Worker.
4. Downloads and verifies the existing Admin snapshot.
5. Writes the executor token to root-owned `/etc/oracle-vm-executor.env` and installs the systemd unit using that same path.

The five-digit Admin code is used only by the snapshot downloader and is not stored in the executor environment.

## Runtime behavior

- `GET /health`: startup status and the precise startup error, if any.
- `GET /status?identity=admin`: authenticated status endpoint used by the Worker.
- `POST /exec`: authenticated shell execution through the restored guest VGA shell and keyboard. This is not a serial-console shell; commands are sent through v86 keyboard input and checked against unique completion markers.
- The service reports `ready` only after the snapshot passes its machine-layout compatibility check, restore completes, and an interactive TinyCore shell responds to a marker command.
- Only one shell command is dispatched at a time.
- Output is limited to text retained by the guest visible terminal screen; this first executor does not claim full scrollback capture or per-account snapshot persistence.

## Connect the Cloudflare Worker

Configure the Worker secret `ORACLE_EXECUTOR_TOKEN` with the token printed by setup and set `ORACLE_EXECUTOR_URL` to the Oracle executor URL, then deploy the Worker. Allow TCP/8787 through the applicable Oracle Cloud and host firewall rules so the Worker can reach the service.

## Diagnose startup

```bash
sudo journalctl -u oracle-vm-executor -n 100 --no-pager
curl -sS http://127.0.0.1:8787/health
```

A successful `restore_state()` call alone is not acceptance. Startup must also pass the compatibility check and interactive shell handshake before the API reports the VM online.
