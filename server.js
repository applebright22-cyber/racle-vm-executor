import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { V86 } from "v86";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SNAPSHOT_PATH = path.resolve(process.env.SNAPSHOT_PATH || path.join(ROOT, "admin.snapshot"));
const V86_DIR = path.join(ROOT, "node_modules", "v86");
const WASM_PATH = path.resolve(process.env.WASM_PATH || path.join(V86_DIR, "build", "v86.wasm"));
const BIOS_PATH = path.resolve(process.env.BIOS_PATH || path.join(V86_DIR, "bios", "seabios.bin"));
const VGA_BIOS_PATH = path.resolve(process.env.VGA_BIOS_PATH || path.join(V86_DIR, "bios", "vgabios.bin"));

let emulator;
let restoreStatus = "starting";
let restoreError = null;

async function restoreSnapshot() {
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
      memory_size: 134217728,
      autostart: false
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v86_init_timeout")), 30000);
      emulator.add_listener("emulator-ready", () => {
        clearTimeout(timer);
        resolve();
      });
      emulator.add_listener("download-error", error => {
        clearTimeout(timer);
        reject(new Error("v86_asset_load_failed:" + String(error)));
      });
    });

    const stateBuffer = state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength);
    await emulator.restore_state(stateBuffer);
    restoreStatus = "restored";
    console.log("Existing VM snapshot restored; guest CPU remains stopped.");
  } catch (error) {
    restoreStatus = "error";
    restoreError = error instanceof Error ? error.message : String(error);
    console.error("Snapshot restore failed:", restoreError);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const body = JSON.stringify({
      status: restoreStatus,
      runtime: "oracle-v86",
      snapshot_path: SNAPSHOT_PATH,
      guest_cpu_started: false,
      error: restoreError
    });
    res.writeHead(restoreStatus === "restored" ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    return res.end(body);
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log("Oracle snapshot restorer listening on http://" + HOST + ":" + PORT);
  void restoreSnapshot();
});

function shutdown() {
  try { emulator?.stop(); } catch {}
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
