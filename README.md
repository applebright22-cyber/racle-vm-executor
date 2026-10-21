# Oracle VM Executor

Small Node.js service intended to run the existing v86 guest on the Oracle Linux host and accept HTTP execution requests. Cloudflare remains the public API/account router.

## Current status

This is the first runtime scaffold, not a verified deployment. It expects a local v86 state file at `./admin.snapshot`; the existing R2 snapshot must be downloaded and assembled from its manifest/chunks first. The saved state must also support a serial console shell. The first real restore is the compatibility gate: v86's Node runtime, BIOS paths, snapshot format, and guest serial console still need validation on Oracle ARM64.

## Install

Use a current Node.js LTS release (Node 22 or newer is recommended), then:

```bash
npm install
```

Place the assembled Admin v86 saved-state file at `./admin.snapshot`. The default paths for the v86 WASM and BIOS files point into the installed `v86` package; override them with environment variables if the package layout differs.

Start:

```bash
npm start
```

Health:

```bash
curl http://127.0.0.1:8787/health
```

Execute a command after the guest is ready:

```bash
curl -X POST http://127.0.0.1:8787/exec \
  -H 'content-type: application/json' \
  -d '{"command":"ip addr"}'
```

The guest must already have an interactive shell on serial0. This bridge is intentionally small and currently maps requests to the Admin baseline only; account-specific snapshot selection and Cloudflare-to-Oracle forwarding are the next integration steps. Do not expose port 8787 publicly; bind to localhost and have the Cloudflare Worker call it through a private/tunnelled connection once configured.

## Existing snapshot format

The Cloudflare project stores snapshots under `vm-snapshots/<identity>/manifest.json`, with immutable chunks under `vm-snapshots/<identity>/<generation>/<part>.bin`. Chunks are 8 MiB and the manifest records the total byte length and SHA-256 digests. The Oracle service does not yet fetch R2 chunks automatically.
