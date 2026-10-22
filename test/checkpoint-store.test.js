import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCheckpointStore } from "../checkpoint-store.js";

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-checkpoints-"));
  try {
    const store = createCheckpointStore(root);
    await store.initialize();
    await run(store, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("commits a checkpoint only after byte length and SHA-256 verify", async () => {
  await withStore(async (store) => {
    const identity = "acct-12345678-1234-1234-1234-123456789abc";
    const generation = "test-generation-1";
    const a = Buffer.from("snapshot-part-a");
    const b = Buffer.from("snapshot-part-b");
    await store.putChunk(identity, generation, 0, a);
    await store.putChunk(identity, generation, 1, b);
    const all = Buffer.concat([a, b]);
    const manifest = await store.commit(identity, generation, {
      chunks: 2,
      byte_length: all.length,
      sha256: createHash("sha256").update(all).digest("hex")
    });
    assert.equal(manifest.committed, true);
    assert.equal(manifest.byte_length, all.length);
    assert.equal((await store.getManifest(identity, "latest")).generation, generation);
    assert.deepEqual(Buffer.from(await store.getChunk(identity, generation, 1)), b);
  });
});

test("rejects a checkpoint with a wrong digest and does not publish latest", async () => {
  await withStore(async (store) => {
    const identity = "acct-12345678-1234-1234-1234-123456789abc";
    const generation = "bad-generation";
    const bytes = Buffer.from("not the expected bytes");
    await store.putChunk(identity, generation, 0, bytes);
    await assert.rejects(
      store.commit(identity, generation, { chunks: 1, byte_length: bytes.length, sha256: "0".repeat(64) }),
      /checkpoint_digest_mismatch/
    );
    await assert.rejects(store.getManifest(identity, "latest"));
  });
});

test("rejects missing chunks and identities outside the account namespace", async () => {
  await withStore(async (store) => {
    const identity = "acct-12345678-1234-1234-1234-123456789abc";
    await assert.rejects(
      store.commit(identity, "missing", { chunks: 1, byte_length: 1, sha256: "0".repeat(64) })
    );
    await assert.rejects(store.putChunk("../other", "g1", 0, Buffer.from("x")), /invalid_checkpoint_identity/);
  });
});
