import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { V86 } from "v86";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "./admin.snapshot";
const WASM_PATH = process.env.WASM_PATH || "./node_modules/v86/build/v86.wasm";
const BIOS_PATH = process.env.BIOS_PATH || "./node_modules/v86/bios/seabios.bin";
const VGA_BIOS_PATH = process.env.VGA_BIOS_PATH || "./node_modules/v86/bios/vgabios.bin";
const EXECUTOR_TOKEN = process.env.ORACLE_EXECUTOR_TOKEN || "";
const MAX_COMMAND_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 15000;

let emulator;
let bootState = "starting";
let bootError = null;
let serialBuffer = "";
const pending = new Map();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function authorized(req) {
  const supplied = req.headers["x-executor-token"];
  if (!EXECUTOR_TOKEN || typeof supplied !== "string") return false;
  return supplied.length === EXECUTOR_TOKEN.length && supplied === EXECUTOR_TOKEN;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 16 * 1024) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function onSerialByte(byte) {
  serialBuffer = (serialBuffer + String.fromCharCode(byte & 255)).slice(-128 * 1024);
  for (const [id, job] of pending) {
    if (!serialBuffer.includes(job.marker)) continue;
    const markerIndex = serialBuffer.lastIndexOf(job.marker);
    const startIndex = serialBuffer.lastIndexOf(job.startMarker, markerIndex);
    if (startIndex < 0) continue;
    const output = serialBuffer.slice(startIndex + job.startMarker.length, markerIndex);
    clearTimeout(job.timer);
    pending.delete(id);
    job.resolve({ stdout: output.replace(/\r/g, "").trim(), stderr: "", exit_code: 0, execution_id: id });
    serialBuffer = serialBuffer.slice(markerIndex + job.marker.length);
  }
}

async function startVm() {
  try {
    const state = await fs.readFile(SNAPSHOT_PATH);
    const wasm = await fs.readFile(WASM_PATH);
    const bios = await fs.readFile(BIOS_PATH);
    const vgaBios = await fs.readFile(VGA_BIOS_PATH);
    emulator = new V86({
      wasm_path: WASM_PATH,
      wasm: { buffer: wasm },
      bios: { buffer: bios },
      vga_bios: { buffer: vgaBios },
      autostart: false
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v86_init_timeout")), 30000);
      emulator.add_listener("emulator-ready", () => {
        clearTimeout(timer);
        resolve();
      });
      emulator.add_listener("download-error", e => {
        clearTimeout(timer);
        reject(new Error("v86_asset_load_failed:" + String(e)));
      });
    });
    const stateBuffer = state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength);
    await emulator.restore_state(stateBuffer);
    emulator.add_listener("serial0-output-byte", onSerialByte);
    await emulator.run();
    bootState = "ready";
  } catch (error) {
    bootState = "error";
    bootError = error instanceof Error ? error.message : String(error);
    console.error("VM start failed:", bootError);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, bootState === "ready" ? 200 : 503, {
      status: bootState, runtime: "oracle-v86", architecture: process.arch,
      snapshot_path: SNAPSHOT_PATH, error: bootError
    });
  }

  if (url.pathname === "/status" && req.method === "GET") {
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    const identity = url.searchParams.get("identity") || req.headers["x-account-id"] || "";
    if (!/^(admin|acct-[a-f0-9-]{36})$/.test(identity)) {
      return sendJson(res, 400, { error: "invalid_account_id" });
    }
    return sendJson(res, bootState === "ready" ? 200 : 503, {
      vm_id: identity, status: bootState === "ready" ? "online" : bootState,
      execution_available: bootState === "ready", runtime: "oracle-v86",
      browser_required: false, error: bootError
    });
  }

  if (url.pathname === "/exec" && req.method === "POST") {
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    if (bootState !== "ready") {
      return sendJson(res, 503, { error: "vm_not_ready", status: bootState, detail: bootError });
    }
    const identity = String(req.headers["x-account-id"] || "");
    if (!/^acct-[a-f0-9-]{36}$/.test(identity)) {
      return sendJson(res, 400, { error: "invalid_account_id" });
    }
    let body;
    try { body = await readJson(req); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > MAX_COMMAND_LENGTH) {
      return sendJson(res, 400, { error: "command_must_be_1_to_4096_characters" });
    }
    if (pending.size > 0) return sendJson(res, 429, { error: "executor_busy", retry_after_ms: 250 });

    const id = randomUUID();
    const startMarker = "__EXEC_START_" + id + "__";
    const marker = "__EXEC_END_" + id + "__";
    const requestedTimeout = Number(body.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const timeout = Math.max(1000, Math.min(requestedTimeout, 20000));
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "execution_timeout", execution_id: id, timed_out: true });
      }, timeout);
      pending.set(id, { startMarker, marker, timer, resolve });
    });

    // Initial milestone uses the existing Admin baseline snapshot. Per-account
    // snapshot selection is intentionally not claimed until that mapping is wired.
    emulator.serial0_send("echo " + startMarker + "\n" + body.command + "\necho " + marker + "\n");
    const result = await promise;
    return sendJson(res, result.error ? 504 : 200, {
      vm_id: identity, runtime: "oracle-v86", browser_required: false, ...result
    });
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log("Oracle VM executor listening on http://" + HOST + ":" + PORT);
  void startVm();
});

function shutdown() {
  try { emulator?.stop(); } catch {}
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
