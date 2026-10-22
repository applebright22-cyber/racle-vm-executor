import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAX_CHUNKS = 4096;
const MAX_CHECKPOINT_BYTES = 1024 * 1024 * 1024;

function validIdentity(identity) {
  return identity === "admin" || /^acct-[a-f0-9-]{36}$/.test(identity);
}

function validGeneration(generation) {
  return typeof generation === "string" && /^[a-zA-Z0-9-]{1,40}$/.test(generation);
}

function checkpointDirectory(root, identity, generation) {
  if (!validIdentity(identity)) throw new Error("invalid_checkpoint_identity");
  if (!validGeneration(generation)) throw new Error("invalid_checkpoint_generation");
  return path.join(root, identity, generation);
}

async function atomicJson(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

/**
 * Filesystem-backed, per-account checkpoint storage.
 * A generation is only considered current after commit() verifies every chunk,
 * the total byte length, and the whole-snapshot SHA-256 digest.
 */
export function createCheckpointStore(rootPath = "./checkpoints") {
  const root = path.resolve(rootPath);

  async function initialize() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
  }

  async function putChunk(identity, generation, index, bytes) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
      throw new Error("invalid_checkpoint_chunk_index");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > DEFAULT_CHUNK_BYTES) {
      throw new Error("checkpoint_chunk_size_out_of_range");
    }
    const directory = checkpointDirectory(root, identity, generation);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, String(index).padStart(4, "0") + ".bin");
    const temporary = file + "." + process.pid + ".tmp";
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, file);
    return { ok: true, index, byte_length: bytes.byteLength };
  }

  async function getChunk(identity, generation, index) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
      throw new Error("invalid_checkpoint_chunk_index");
    }
    const directory = checkpointDirectory(root, identity, generation);
    return new Uint8Array(await fs.readFile(path.join(directory, String(index).padStart(4, "0") + ".bin")));
  }

  async function commit(identity, generation, input) {
    const directory = checkpointDirectory(root, identity, generation);
    const chunks = input?.chunks;
    const byteLength = input?.byte_length;
    const expectedSha256 = input?.sha256;
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS ||
        !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_CHECKPOINT_BYTES ||
        typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error("invalid_checkpoint_manifest");
    }

    const hash = createHash("sha256");
    let actualBytes = 0;
    const chunkSizes = [];
    for (let index = 0; index < chunks; index += 1) {
      const bytes = await fs.readFile(path.join(directory, String(index).padStart(4, "0") + ".bin"));
      if (bytes.byteLength < 1 || bytes.byteLength > DEFAULT_CHUNK_BYTES) {
        throw new Error("checkpoint_chunk_size_out_of_range");
      }
      actualBytes += bytes.byteLength;
      if (actualBytes > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint_too_large");
      hash.update(bytes);
      chunkSizes.push(bytes.byteLength);
    }
    const actualSha256 = hash.digest("hex");
    if (actualBytes !== byteLength) throw new Error("checkpoint_byte_length_mismatch");
    if (actualSha256 !== expectedSha256) throw new Error("checkpoint_digest_mismatch");

    const savedAt = new Date().toISOString();
    const manifest = {
      version: 1,
      identity,
      generation,
      chunks,
      byte_length: actualBytes,
      sha256: actualSha256,
      chunk_sizes: chunkSizes,
      saved_at: savedAt,
      committed: true
    };
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    await atomicJson(path.join(root, identity, "latest.json"), {
      version: 1, generation, saved_at: savedAt, byte_length: actualBytes, sha256: actualSha256
    });
    return manifest;
  }

  async function getManifest(identity, generation) {
    if (!validIdentity(identity)) throw new Error("invalid_checkpoint_identity");
    if (generation === "latest") {
      const latest = JSON.parse(await fs.readFile(path.join(root, identity, "latest.json"), "utf8"));
      generation = latest.generation;
    }
    const directory = checkpointDirectory(root, identity, generation);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
    if (manifest.committed !== true || manifest.identity !== identity || manifest.generation !== generation) {
      throw new Error("checkpoint_manifest_invalid");
    }
    return manifest;
  }

  return { initialize, putChunk, getChunk, commit, getManifest };
}

export const checkpointLimits = Object.freeze({
  chunkBytes: DEFAULT_CHUNK_BYTES,
  maxChunks: MAX_CHUNKS,
  maxCheckpointBytes: MAX_CHECKPOINT_BYTES
});
