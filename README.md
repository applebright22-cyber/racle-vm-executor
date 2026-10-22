# Oracle VM Snapshot Restorer

This repository restores the existing Tiny Core VM snapshot on Oracle. It does not rebuild the snapshot, start the guest CPU, run guest commands, install packages inside the guest, or configure the Cloudflare Worker.

## Snapshot

- Required file: `admin.snapshot`
- The installer checks that the existing file is present.
- The snapshot is ignored by Git and is never downloaded, generated, overwritten, or modified by this setup.
- The v86 emulator is initialized with the saved snapshot and `restore_state()` is called. The guest CPU is intentionally not started.

## Install

Run the repository's setup script on the Oracle Linux host as the `opc` user with sudo access. The setup installs the v86 npm dependency and creates the `oracle-vm-executor` systemd service. These operations affect the Oracle host only; no commands are sent into the guest.

The service exposes only `GET /health` on port 8787. A successful response reports `status: "restored"` and `guest_cpu_started: false`.

This is deliberately a snapshot-restore-only baseline. It does not provide command execution or a Cloudflare bridge.
