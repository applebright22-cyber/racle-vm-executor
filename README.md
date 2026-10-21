# Oracle VM Executor

Oracle-side HTTP executor for the existing Cloudflare VM API. The Cloudflare Worker keeps account authentication and forwards authenticated `/v1/vm/exec` and `/v1/vm/status` requests here when the Oracle bridge is configured.

## Current milestone

- Cloudflare-to-Oracle request forwarding is committed in the Worker repository.
- The executor exposes `/health`, authenticated `/status`, and authenticated `/exec`.
- `setup-oracle.sh` installs a recent Node.js runtime, downloads the existing Admin snapshot from Cloudflare R2 through the Worker API, installs dependencies, generates the bridge token, and creates a systemd service.
- This is **not yet verified end-to-end**. The first Oracle restore must confirm the installed v86 package, WASM/BIOS paths, snapshot compatibility, and that the guest accepts commands over serial0. The current executor uses the Admin baseline as the initial guest image; per-account snapshot selection/state persistence is the next integration step.

## Setup on Oracle Linux

Clone this repository on the Oracle host, then run:

```bash
git clone https://github.com/applebright22-cyber/racle-vm-executor.git
cd racle-vm-executor
bash setup-oracle.sh
```

The script asks for your existing Cloudflare Worker URL and the 5-digit Admin access code. The code is used to download the Admin baseline snapshot and is not written into the executor environment. The script generates an `ORACLE_EXECUTOR_TOKEN` and prints it once at the end.

The executor listens on port 8787. Cloudflare must be able to reach that port on the Oracle instance, so allow TCP/8787 in the Oracle Cloud ingress rules and host firewall if those rules are not already configured. The bridge token must be kept the same on both sides.

## Configure the Cloudflare Worker

From the `cloudflare` directory of the existing `cloudflare-container-networking` repository, set the Worker URL and token using the values printed by the setup script:

```bash
npx wrangler secret put ORACLE_EXECUTOR_TOKEN
```

Paste the token when prompted. Set the non-secret Worker variable `ORACLE_EXECUTOR_URL` to `http://141.148.53.68:8787` in the Worker settings (or add it under `[vars]` in `wrangler.toml`), then deploy the Worker using the project's existing deploy command.

Until both Worker values are configured and deployed, the API continues to use the existing browser-agent path.

## API shape

The existing account API contract is preserved:

- `GET /v1/vm/status` with `x-account-id: acct-...` and `Authorization: Bearer <account-api-key>`
- `POST /v1/vm/exec` with the same headers and JSON body such as `{"command":"uname -a","timeout_ms":15000}`

The Worker validates the account API key before forwarding. The Oracle bridge token is only for Worker-to-executor traffic.

## Known first-milestone limitations

- No browser tab is required once the guest restore and serial shell are confirmed.
- One emulator process currently runs the configured Admin baseline snapshot. It does not yet load or persist a separate R2 snapshot for each account.
- The v86 guest must have an interactive serial0 shell for the current command bridge.
- Do not treat the service as ready until `/health` reports `ready` and a request through the public user API returns a real guest command result.
