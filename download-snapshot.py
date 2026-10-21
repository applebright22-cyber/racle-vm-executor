#!/usr/bin/env python3
"""Download and verify a v86 snapshot from the existing Cloudflare snapshot API."""
import hashlib
import json
import os
import sys
import urllib.request

base = os.environ.get("WORKER_URL", "").rstrip("/")
admin_code = os.environ.get("ADMIN_ACCESS_CODE", "")
target = os.environ.get("SNAPSHOT_PATH", "./admin.snapshot")
if not base or not admin_code:
    print("Set WORKER_URL and ADMIN_ACCESS_CODE first.", file=sys.stderr)
    sys.exit(2)

# Cloudflare accepts this endpoint with a curl-style User-Agent; urllib's
# default Python User-Agent was receiving HTTP 403 for the same valid code.
headers = {
    "x-admin-code": admin_code,
    "User-Agent": "curl/8.5.0",
}

def get(path):
    request = urllib.request.Request(base + path, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()

manifest = json.loads(get("/api/vm-snapshots/admin"))
generation = manifest.get("generation")
chunks = manifest.get("chunks")
length = manifest.get("byteLength")
if not isinstance(generation, str) or not isinstance(chunks, int) or not isinstance(length, int):
    raise SystemExit("Cloudflare returned an invalid snapshot manifest.")
chunk_hashes = manifest.get("chunkSha256", [])
overall_hash = manifest.get("sha256")
digest = hashlib.sha256()
written = 0
tmp = target + ".download"
with open(tmp, "wb") as output:
    for part in range(chunks):
        data = get(f"/api/vm-snapshots/admin/chunks/{generation}/{part}")
        if len(data) > 8 * 1024 * 1024:
            raise SystemExit(f"Snapshot chunk {part} is larger than expected.")
        if part < len(chunk_hashes) and hashlib.sha256(data).hexdigest() != chunk_hashes[part]:
            raise SystemExit(f"Snapshot chunk {part} checksum mismatch.")
        output.write(data)
        digest.update(data)
        written += len(data)
if written != length:
    os.remove(tmp)
    raise SystemExit(f"Snapshot length mismatch: expected {length}, got {written}.")
if isinstance(overall_hash, str) and digest.hexdigest() != overall_hash:
    os.remove(tmp)
    raise SystemExit("Snapshot SHA-256 mismatch.")
os.replace(tmp, target)
print(json.dumps({"snapshot": target, "bytes": written, "generation": generation, "sha256": digest.hexdigest()}))
