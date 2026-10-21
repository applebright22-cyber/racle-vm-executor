import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { V86 } from "v86";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "./admin.snapshot";
const WASM_PATH = process.env.WASM_PATH || "./node_modules/v86/build/v86.wasm";
const BIOS_PATH = process.env.BIOS_PATH || "./node_modules/v86/bios/seabios.bin";
const VGA_BIOS_PATH = process.env.VGA_BIOS_PATH || "./node_modules/v86/bios/vgabios.bin";
const MAX_COMMAND_LENGTH = 4096;
const COMMAND_TIMEOUT_MS = 15000;

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
  const char = String.fromCharCode(byte & 255);
  serialBuffer = (serialBuffer + char).slice(-128 * 1024);
  for (const [id, job] of pending) {
    if (serialBuffer.includes(job.marker)) {
      const markerIndex = serialBuffer.lastIndexOf(job.marker);
      const startIndex = serialBuffer.lastIndexOf(job.startMarker, markerIndex);
      if (startIndex >= 0) {
        const output = serialBuffer.slice(startIndex + job.startMarker.length, markerIndex);
        clearTimeout(job.timer);
        pending.delete(id);
        job.resolve({ stdout: output.replace(/\r/g, "").trim(), stderr: "", exit_code: 0, execution_id: id });
        serialBuffer = serialBuffer.slice(markerIndex + job.marker.length);
      }
    }
  }
}

async function startVm() {
  try {
    const state = await fs.readFile(SNAPSHOT_PATH);
    emulator = new V86({
      wasm_path: WASM_PATH,
      bios: { buffer: await fs.readFile(BIOS_PATH) },
      vga_bios: { buffer: await fs.readFile(VGA_BIOS_PATH) },
      autostart: false,
      net_device: { type: "virtio", relay_url: "fetch" }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v86_init_timeout")), 30000);
      emulator.add_listener("emulator-ready", () => {
        clearTimeout(timer);
        resolve();
      });
      emulator.add_listener("emulator-started", () => {});
      emulator.add_listener("download-error", e => {
        clearTimeout(timer);
        reject(new Error("v86_asset_load_failed:" + String(e)));
      });
    });
    await emulator.restore_state(state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength));
    emulator.add_listener("serial0-output-byte", onSerialByte);
    emulator.run();
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
      status: bootState,
      runtime: "v86",
      architecture: process.arch,
      snapshot_path: SNAPSHOT_PATH,
      error: bootError
    });
  }

  if (req.method === "POST" && url.pathname === "/exec") {
    if (bootState !== "ready") return sendJson(res, 503, { error: "vm_not_ready", status: bootState, detail: bootError });
    let body;
    try { body = await readJson(req); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > MAX_COMMAND_LENGTH) {
      return sendJson(res, 400, { error: "command_must_be_1_to_4096_characters" });
    }

    const id = randomUUID();
    const startMarker = "__EXEC_START_" + id + "__";
    const marker = "__EXEC_END_" + id + "__";
    const timeout = Math.max(1000, Math.min(Number(body.timeout_ms) || COMMAND_TIMEOUT_MS, 20000));
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "execution_timeout", execution_id: id, timed_out: true });
      }, timeout);
      pending.set(id, { startMarker, marker, timer, resolve });
    });

    // Commands run inside the restored guest's serial shell. The shell must be
    // logged in and accepting commands on serial0 for this bridge to work.
    emulator.serial0_send("echo " + startMarker + "\n" + body.command + "\necho " + marker + "\n");
    const result = await promise;
    return sendJson(res, result.error ? 504 : 200, { vm_id: "admin", runtime: "v86", ...result });
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
