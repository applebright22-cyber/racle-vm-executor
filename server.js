import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { V86 } from "v86";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "./admin.snapshot";
const WASM_PATH = process.env.WASM_PATH || "./node_modules/v86/build/v86.wasm";
const BIOS_PATH = process.env.BIOS_PATH || "./bios/seabios.bin";
const VGA_BIOS_PATH = process.env.VGA_BIOS_PATH || "./bios/vgabios.bin";
const CDROM_PATH = process.env.CDROM_PATH || "./boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso";
const EXECUTOR_TOKEN = process.env.ORACLE_EXECUTOR_TOKEN || "";
const WORKER_URL = process.env.WORKER_URL || "";
const MEMORY_SIZE = 128 * 1024 * 1024;
const VGA_MEMORY_SIZE = 8 * 1024 * 1024;
const MAX_COMMAND_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 15000;

let emulator;
let bootState = "starting";
let bootError = null;
let busy = false;

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
  return Boolean(EXECUTOR_TOKEN && typeof supplied === "string" &&
    supplied.length === EXECUTOR_TOKEN.length && supplied === EXECUTOR_TOKEN);
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

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parseSnapshotHeader(buffer, label) {
  if (buffer.byteLength < 16) throw new Error(label + "_too_small");
  const view = new DataView(buffer);
  const magic = view.getInt32(0, true);
  const version = view.getInt32(4, true);
  const metadataLength = view.getInt32(12, true);
  if (magic !== -2039052682) throw new Error(label + "_invalid_v86_magic");
  if (version !== 6) throw new Error(label + "_unsupported_v86_state_version_" + version);
  if (metadataLength < 2 || metadataLength > buffer.byteLength - 16) {
    throw new Error(label + "_invalid_metadata_length");
  }
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, metadataLength)));
  if (!Array.isArray(metadata.buffer_infos)) throw new Error(label + "_missing_buffer_infos");
  return { version, metadata };
}

function checkSnapshotCompatibility(snapshotBuffer, freshBuffer) {
  const saved = parseSnapshotHeader(snapshotBuffer, "snapshot");
  const fresh = parseSnapshotHeader(freshBuffer, "fresh_state");
  const expected = saved.metadata.buffer_infos;
  const actual = fresh.metadata.buffer_infos;
  const differences = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const a = expected[i];
    const b = actual[i];
    if (!a || !b || a.length !== b.length || a.offset !== b.offset) {
      differences.push({
        index: i,
        snapshot: a ? { offset: a.offset, length: a.length } : null,
        runtime: b ? { offset: b.offset, length: b.length } : null
      });
    }
  }
  if (Array.isArray(saved.metadata.state) && Array.isArray(fresh.metadata.state) &&
      saved.metadata.state.length !== fresh.metadata.state.length) {
    differences.push({
      index: "state",
      snapshot: { entries: saved.metadata.state.length },
      runtime: { entries: fresh.metadata.state.length }
    });
  }
  if (differences.length) {
    const first = differences.slice(0, 8).map(x =>
      x.index + ":" + JSON.stringify(x.snapshot) + "/" + JSON.stringify(x.runtime)
    ).join(", ");
    throw new Error("snapshot_machine_config_mismatch: snapshot_buffers=" + expected.length +
      ", runtime_buffers=" + actual.length + ", first_differences=" + first +
      ". Required configuration: 128MiB RAM, 8MiB VGA RAM, TinyCore CD-ROM, NE2K network device.");
  }
}

function screenText() {
  try {
    const rows = emulator?.screen_adapter?.get_text_screen?.();
    return Array.isArray(rows) ? rows.join("\n") : "";
  } catch {
    return "";
  }
}

async function sendGuestText(text) {
  if (!emulator || typeof emulator.keyboard_send_text !== "function") {
    throw new Error("v86_keyboard_input_unavailable");
  }
  await emulator.keyboard_send_text(text);
}

async function waitForScreen(predicate, timeoutMs, errorCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = screenText();
    if (predicate(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(errorCode + (screenText() ? ": " + screenText().slice(-500) : ""));
}

async function startVm() {
  try {
    const [snapshotFile, wasmFile, biosFile, vgaBiosFile, cdromFile] = await Promise.all([
      fs.readFile(SNAPSHOT_PATH),
      fs.readFile(WASM_PATH),
      fs.readFile(BIOS_PATH),
      fs.readFile(VGA_BIOS_PATH),
      fs.readFile(CDROM_PATH)
    ]);
    const snapshot = arrayBuffer(snapshotFile);
    const wasm = arrayBuffer(wasmFile);
    const bios = arrayBuffer(biosFile);
    const vgaBios = arrayBuffer(vgaBiosFile);
    const cdrom = arrayBuffer(cdromFile);
    parseSnapshotHeader(snapshot, "snapshot");

    if (!WORKER_URL) throw new Error("worker_url_not_configured");
    if (!EXECUTOR_TOKEN) throw new Error("executor_token_not_configured");
    const ticketResponse = await fetch(new URL("/api/oracle/network-ticket", WORKER_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "x-executor-token": EXECUTOR_TOKEN },
      body: JSON.stringify({ identity: "admin" }),
      signal: AbortSignal.timeout(10000)
    });
    if (!ticketResponse.ok) throw new Error("network_ticket_request_failed_http_" + ticketResponse.status);
    const network = await ticketResponse.json();
    if (typeof network.relay_url !== "string" ||
        typeof network.vm_ip !== "string" || typeof network.router_ip !== "string") {
      throw new Error("network_ticket_response_invalid");
    }
    const vmIp = network.vm_ip;
    const routerIp = network.router_ip;
    const relayUrl = network.relay_url;

    emulator = new V86({
      wasm_path: WASM_PATH,
      wasm: { buffer: wasm },
      bios: { buffer: bios },
      vga_bios: { buffer: vgaBios },
      cdrom: { buffer: cdrom },
      memory_size: MEMORY_SIZE,
      vga_memory_size: VGA_MEMORY_SIZE,
      net_device: {
        type: "ne2k",
        relay_url: relayUrl,
        router_ip: routerIp,
        vm_ip: vmIp,
        masquerade: true,
        dns_method: "doh",
        doh_server: "cloudflare-dns.com",
        preserve_mac_from_state_image: false
      },
      autostart: false,
      disable_keyboard: false,
      disable_mouse: true
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v86_init_timeout")), 30000);
      const done = () => { clearTimeout(timer); resolve(); };
      emulator.add_listener("emulator-loaded", done);
      emulator.add_listener("download-error", e => {
        clearTimeout(timer);
        reject(new Error("v86_asset_load_failed:" + String(e)));
      });
    });

    // Reject incompatible state before restore/run. This catches missing devices and
    // memory-size differences before they become a CPU page-walk stack overflow.
    const freshState = await emulator.save_state();
    checkSnapshotCompatibility(snapshot, freshState);

    console.log("Snapshot compatibility passed; restoring the existing Admin snapshot.");
    await emulator.restore_state(snapshot);
    await emulator.run();

    // This guest is a VGA/keyboard shell, not a serial-console shell. Verify actual
    // keyboard-to-shell execution before reporting ready to the Cloudflare Worker.
    await waitForScreen(text => /tc@box:~\$|tc@box:~#/.test(text), 30000, "guest_shell_prompt_not_found");
    const marker = "__ORACLE_EXECUTOR_READY_" + randomUUID().replaceAll("-", "") + "__";
    await sendGuestText("echo " + marker + "\n");
    await waitForScreen(text => text.includes(marker), 10000, "guest_shell_handshake_failed");
    bootState = "ready";
    console.log("VM ready: snapshot restored and interactive TinyCore shell verified.");
  } catch (error) {
    bootState = "error";
    bootError = error instanceof Error ? error.message : String(error);
    console.error("VM start failed:", bootError);
    try { emulator?.stop(); } catch {}
  }
}

async function executeCommand(command, timeoutMs) {
  if (busy) return { status: 429, body: { error: "executor_busy", retry_after_ms: 250 } };
  busy = true;
  const id = randomUUID().replaceAll("-", "");
  const startMarker = "__ORACLE_EXEC_START_" + id + "__";
  const endMarker = "__ORACLE_EXEC_END_" + id + "__:";
  const shell = "printf '\\n" + startMarker + "\\n'; ( " + command +
    " ); rc=$?; printf '\\n" + endMarker + "%s\\n' \"$rc\"";
  const deadline = Date.now() + timeoutMs;
  try {
    await sendGuestText(shell + "\n");
    while (Date.now() < deadline) {
      const text = screenText();
      const endAt = text.lastIndexOf(endMarker);
      if (endAt >= 0) {
        const after = text.slice(endAt + endMarker.length);
        const match = /^(-?\d+)/.exec(after.trimStart());
        if (match) {
          const startAt = text.lastIndexOf(startMarker, endAt);
          const stdout = startAt >= 0
            ? text.slice(startAt + startMarker.length, endAt).replace(/^\s*\n?/, "").replace(/\n?\s*$/, "")
            : "";
          return { status: 200, body: {
            runtime: "oracle-v86", browser_required: false, execution_id: id,
            stdout, stderr: "", exit_code: Number(match[1]),
            output_note: "Output is limited to text still visible in the guest terminal."
          } };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    return { status: 504, body: { error: "execution_timeout", execution_id: id, timed_out: true } };
  } finally {
    busy = false;
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
    const requested = Number(body.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const timeout = Math.max(1000, Math.min(requested, 20000));
    const result = await executeCommand(body.command, timeout);
    return sendJson(res, result.status, { vm_id: identity, ...result.body });
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
