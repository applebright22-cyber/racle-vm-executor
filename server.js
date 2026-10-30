import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const EXECUTOR_TOKEN = process.env.ORACLE_EXECUTOR_TOKEN || "";
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || "./sessions");
const ACCOUNT_HOME_DIR = path.resolve(process.env.ACCOUNT_HOME_DIR || "/var/lib/oracle-vm-executor/accounts");
const ACCOUNT_SHELL_HELPER = process.env.ACCOUNT_SHELL_HELPER || "/usr/local/libexec/oracle-vm-account-shell";
const MAX_COMMAND_LENGTH = 4096;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 20000;
const sessions = new Map();

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
      if (data.length > MAX_REQUEST_BYTES) {
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

function validIdentity(identity) {
  return identity === "admin" || /^acct-[a-f0-9-]{36}$/.test(identity);
}

function sessionSummary(session) {
  return {
    vm_id: session.identity,
    status: "online",
    execution_available: !session.pending,
    runtime: "oracle-host",
    browser_required: false,
    persistent: true,
    cwd: session.state.cwd,
    command_count: session.state.commandCount,
    last_seen_at: session.state.lastSeenAt,
    last_exit_code: session.state.lastExitCode
  };
}

async function saveSessionState(session) {
  session.state.lastSeenAt = new Date().toISOString();
  const tmp = session.statePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(session.state, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, session.statePath);
  await fs.chmod(session.statePath, 0o600);
}

async function getSession(identity) {
  let session = sessions.get(identity);
  if (session) return session;

  const directory = path.join(SESSIONS_DIR, identity);
  const accountIdentity = identity !== "admin";
  const accountHome = accountIdentity ? path.join(ACCOUNT_HOME_DIR, identity) : null;
  const workDir = accountIdentity ? path.join(accountHome, "work") : path.join(directory, "work");
  const statePath = path.join(directory, "session.json");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!accountIdentity) await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  let state;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    state = {
      identity,
      cwd: workDir,
      created_at: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      commandCount: 0,
      lastExitCode: null
    };
  }
  state.identity = identity;
  if (typeof state.cwd !== "string") state.cwd = workDir;
  try {
    const stat = await fs.stat(state.cwd);
    if (!stat.isDirectory()) state.cwd = workDir;
  } catch {
    state.cwd = workDir;
  }

  session = {
    identity,
    directory,
    workDir,
    statePath,
    state,
    process: null,
    pending: null
  };
  sessions.set(identity, session);
  await saveSessionState(session);
  return session;
}

function startShell(session) {
  if (session.process && session.process.exitCode === null && !session.process.killed) return;

  const accountIdentity = session.identity !== "admin";
  const env = { ...process.env };
  delete env.ORACLE_EXECUTOR_TOKEN;
  env.HOME = accountIdentity ? path.join(ACCOUNT_HOME_DIR, session.identity) : session.workDir;
  env.ORACLE_ACCOUNT_ID = session.identity;
  env.ORACLE_SESSION_DIR = accountIdentity ? env.HOME : session.directory;
  env.PWD = session.state.cwd;

  const command = accountIdentity ? "/usr/bin/sudo" : "/bin/bash";
  const args = accountIdentity
    ? ["-n", ACCOUNT_SHELL_HELPER, session.identity, session.state.cwd]
    : ["--noprofile", "--norc"];
  const child = spawn(command, args, {
    cwd: accountIdentity ? SESSIONS_DIR : session.state.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Give each persistent shell its own process group so a timed-out command
    // and any foreground child processes can be stopped together.
    detached: true
  });
  session.process = child;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    const pending = session.pending;
    if (!pending) return;
    pending.stdout += chunk;
    if (pending.stdout.length > MAX_CAPTURE_BYTES * 2) {
      pending.stdout = pending.stdout.slice(-MAX_CAPTURE_BYTES);
      pending.truncated = true;
    }
    settleIfComplete(session);
  });
  child.stderr.on("data", chunk => {
    const pending = session.pending;
    if (!pending) return;
    pending.stderr += chunk;
    if (pending.stderr.length > MAX_CAPTURE_BYTES) {
      pending.stderr = pending.stderr.slice(-MAX_CAPTURE_BYTES);
      pending.truncated = true;
    }
  });
  child.on("error", error => {
    const pending = session.pending;
    session.process = null;
    if (pending) finishPending(session, {
      status: 500,
      body: { error: "shell_start_failed", detail: error.message }
    });
  });
  child.on("exit", (code, signal) => {
    if (session.process === child) session.process = null;
    const pending = session.pending;
    if (pending) finishPending(session, {
      status: 500,
      body: { error: "shell_session_ended", exit_code: code, signal }
    });
  });
}

function finishPending(session, result) {
  const pending = session.pending;
  if (!pending) return;
  clearTimeout(pending.timeout);
  session.pending = null;
  pending.resolve(result);
}

function settleIfComplete(session) {
  const pending = session.pending;
  if (!pending) return;
  const endPattern = new RegExp(pending.endMarker + ":(-?\\d+)\\r?\\n");
  const endMatch = endPattern.exec(pending.stdout);
  if (!endMatch) return;

  const startAt = pending.stdout.indexOf(pending.startMarker);
  const endAt = endMatch.index;
  let stdout = startAt >= 0
    ? pending.stdout.slice(startAt + pending.startMarker.length, endAt)
    : pending.stdout;
  stdout = stdout.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const cwdPattern = new RegExp(pending.cwdMarker + "([^\\r\\n]*)");
  const cwdMatch = cwdPattern.exec(pending.stdout.slice(endAt + endMatch[0].length));
  // stdout chunks can split between the exit marker and cwd marker; wait for both.
  if (!cwdMatch) return;
  const cwd = cwdMatch[1].trim();

  const accountHome = session.identity === "admin" ? null : path.join(ACCOUNT_HOME_DIR, session.identity);
  const accountCwdAllowed = !accountHome || cwd === accountHome || cwd.startsWith(accountHome + path.sep);
  session.state.cwd = cwd.startsWith("/") && accountCwdAllowed ? cwd : session.workDir;
  session.state.commandCount += 1;
  session.state.lastExitCode = Number(endMatch[1]);
  void saveSessionState(session).catch(error => {
    console.error("Session state save failed for " + session.identity + ":", error.message);
  });

  finishPending(session, {
    status: 200,
    body: {
      runtime: "oracle-host",
      browser_required: false,
      persistent_session: true,
      execution_id: pending.id,
      stdout: stdout.slice(0, MAX_CAPTURE_BYTES),
      stderr: pending.stderr.slice(0, MAX_CAPTURE_BYTES),
      exit_code: Number(endMatch[1]),
      output_truncated: pending.truncated || stdout.length > MAX_CAPTURE_BYTES,
      cwd: session.state.cwd
    }
  });
}

async function executeCommand(identity, command, timeoutMs) {
  const session = await getSession(identity);
  if (session.pending) {
    return { status: 429, body: { error: "session_busy", retry_after_ms: 500 } };
  }
  startShell(session);
  if (!session.process || !session.process.stdin.writable) {
    return { status: 503, body: { error: "shell_unavailable" } };
  }

  const id = randomUUID().replaceAll("-", "");
  const startMarker = "__ORACLE_START_" + id + "__";
  const endMarker = "__ORACLE_END_" + id + "__";
  const cwdMarker = "__ORACLE_CWD_" + id + "__";
  const result = await new Promise(resolve => {
    const pending = {
      id, startMarker, endMarker, cwdMarker,
      stdout: "", stderr: "", truncated: false, resolve, timeout: null
    };
    session.pending = pending;
    pending.timeout = setTimeout(() => {
      // A timed-out command must not leave the persistent session permanently busy.
      // Kill the whole shell process group, then allow the next request to start a
      // clean shell for this same account. This prevents command interleaving.
      const child = session.process;
      if (child) {
        session.process = null;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
      finishPending(session, {
        status: 504,
        body: {
          error: "execution_timeout",
          execution_id: id,
          timed_out: true,
          command_still_running: false,
          shell_restarted: true
        }
      });
    }, timeoutMs);

    const script = "\nprintf '\\n" + startMarker + "\\n';\n" +
      "{\n" + command + "\n}\n" +
      "__oracle_rc=$?;\n" +
      "printf '\\n" + endMarker + ":%s\\n' \"$__oracle_rc\";\n" +
      "printf '" + cwdMarker + "%s\\n' \"$PWD\"\n";
    session.process.stdin.write(script, error => {
      if (error && session.pending === pending) {
        finishPending(session, { status: 500, body: { error: "shell_write_failed", detail: error.message } });
      }
    });
  });
  return result;
}


const WORKER_URL = (process.env.ORACLE_WORKER_URL || "").replace(/\/$/, "");
const ORACLE_ADMIN_CODE = process.env.ORACLE_ADMIN_CODE || process.env.ADMIN_ACCESS_CODE || "";
let agentSocket = null;
let reconnectFailures = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleAgentMessage(socket, data) {
  let request;
  try {
    request = JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    console.warn("Ignoring invalid JSON from Cloudflare VM coordinator.");
    return;
  }

  if (!request || request.type !== "exec" || typeof request.id !== "string" ||
      typeof request.command !== "string" || !request.command.trim() ||
      request.command.length > MAX_COMMAND_LENGTH) {
    console.warn("Ignoring invalid Cloudflare execution request.");
    return;
  }

  const accountId = request.account_id;
  if (!validIdentity(accountId)) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "result",
        id: request.id,
        stdout: "",
        stderr: "invalid_or_missing_account_id",
        exit_code: 125,
        timed_out: false
      }));
    }
    console.warn("Rejected Cloudflare execution request without a valid account identity.");
    return;
  }

  const timeout = Math.max(1000, Math.min(Number(request.timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  let result;
  try {
    const execution = await executeCommand(accountId, request.command, timeout);
    const body = execution.body || {};
    result = {
      type: "result",
      id: request.id,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : (body.error ? String(body.error) : ""),
      exit_code: Number.isInteger(body.exit_code)
        ? body.exit_code
        : execution.status === 200 ? 0 : execution.status === 504 ? 124 : 125,
      timed_out: execution.status === 504 || body.timed_out === true
    };
  } catch (error) {
    result = {
      type: "result",
      id: request.id,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exit_code: 125,
      timed_out: false
    };
  }

  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(result));
    } catch (error) {
      console.error("Could not return command result to Cloudflare:", error instanceof Error ? error.message : String(error));
    }
  }
}

async function runOracleAgent() {
  if (!WORKER_URL || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(WORKER_URL)) {
    console.error("Oracle Cloudflare agent is not configured: set ORACLE_WORKER_URL to the Worker HTTPS origin.");
    return;
  }
  if (!ORACLE_ADMIN_CODE) {
    console.error("Oracle Cloudflare agent is not configured: set ORACLE_ADMIN_CODE to the same Admin access code configured in Cloudflare.");
    return;
  }
  if (typeof WebSocket !== "function") {
    console.error("Oracle Cloudflare agent requires Node.js with the built-in WebSocket client (Node.js 22 or newer).");
    return;
  }

  console.log("Oracle outbound WebSocket agent connecting to " + WORKER_URL + " as oracle.");
  while (true) {
    try {
      const ticketResponse = await fetch(WORKER_URL + "/api/vm/agent-ticket", {
        method: "POST",
        headers: {
          "x-admin-code": ORACLE_ADMIN_CODE,
          "x-agent-identity": "oracle"
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!ticketResponse.ok) {
        const detail = (await ticketResponse.text().catch(() => "")).slice(0, 200);
        throw new Error("agent_ticket_http_" + ticketResponse.status + (detail ? ":" + detail : ""));
      }
      const ticketData = await ticketResponse.json();
      if (typeof ticketData.ticket !== "string" || !ticketData.ticket) {
        throw new Error("agent_ticket_response_missing_ticket");
      }

      const wsUrl = WORKER_URL.replace(/^https:/, "wss:") +
        "/api/vm/agent?identity=oracle&ticket=" + encodeURIComponent(ticketData.ticket);

      await new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        agentSocket = socket;
        let opened = false;
        let heartbeat = null;
        const connectTimer = setTimeout(() => {
          if (!opened) {
            try { socket.close(); } catch {}
            reject(new Error("agent_websocket_connect_timeout"));
          }
        }, 15000);

        socket.addEventListener("open", () => {
          opened = true;
          clearTimeout(connectTimer);
          reconnectFailures = 0;
          console.log("Oracle agent connected to Cloudflare VM coordinator (oracle).");
          heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              try { socket.send(JSON.stringify({ type: "heartbeat" })); } catch {}
            }
          }, 15000);
          heartbeat.unref?.();
        });

        socket.addEventListener("message", event => {
          void handleAgentMessage(socket, event.data);
        });

        socket.addEventListener("error", () => {
          if (!opened) {
            clearTimeout(connectTimer);
            reject(new Error("agent_websocket_connect_failed"));
          }
        });

        socket.addEventListener("close", event => {
          clearTimeout(connectTimer);
          if (heartbeat) clearInterval(heartbeat);
          if (agentSocket === socket) agentSocket = null;
          console.warn("Oracle agent WebSocket closed (code " + event.code + ").");
          if (!opened) reject(new Error("agent_websocket_closed_before_connect"));
          else resolve();
        });
      });
    } catch (error) {
      reconnectFailures += 1;
      if (reconnectFailures === 1 || reconnectFailures % 10 === 0) {
        console.error("Oracle Cloudflare agent connection failed:", error instanceof Error ? error.message : String(error));
      }
    }
    await sleep(Math.min(1000 * (2 ** Math.min(reconnectFailures, 5)), 30000));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ready",
      runtime: "oracle-host",
      architecture: process.arch,
      execution_available: true,
      persistent_sessions: true,
      cloudflare_agent_connected: typeof WebSocket === "function" && agentSocket?.readyState === WebSocket.OPEN,
      guest_network_relay: false,
      network_relay_runtime: "cloudflare-wisp-relay",
      note: "This service executes Oracle host commands; guest packet forwarding is handled by the Cloudflare WISP relay."
    });
  }

  if (url.pathname === "/status" && req.method === "GET") {
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    const identity = url.searchParams.get("identity") || req.headers["x-account-id"] || "";
    if (!validIdentity(identity)) return sendJson(res, 400, { error: "invalid_account_id" });
    try {
      const session = await getSession(identity);
      return sendJson(res, 200, sessionSummary(session));
    } catch (error) {
      return sendJson(res, 500, { error: "session_load_failed", detail: error.message });
    }
  }

  if (url.pathname === "/exec" && req.method === "POST") {
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    const identity = String(req.headers["x-account-id"] || "");
    if (!/^acct-[a-f0-9-]{36}$/.test(identity)) {
      return sendJson(res, 400, { error: "invalid_account_id" });
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
    if (typeof body.command !== "string" || !body.command.trim() ||
        body.command.length > MAX_COMMAND_LENGTH) {
      return sendJson(res, 400, { error: "command_must_be_1_to_4096_characters" });
    }
    const requested = Number(body.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const timeout = Math.max(1000, Math.min(requested, MAX_TIMEOUT_MS));
    try {
      const result = await executeCommand(identity, body.command, timeout);
      return sendJson(res, result.status, { vm_id: identity, ...result.body });
    } catch (error) {
      return sendJson(res, 500, { error: "execution_failed", detail: error.message });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
});

await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
server.listen(PORT, HOST, () => {
  console.log("Oracle persistent host executor listening on http://" + HOST + ":" + PORT);
  console.log("Runtime: native " + process.arch + "; no guest VM or ISO required.");
  void runOracleAgent();
});

function shutdown() {
  // systemd may restart this process; completed session metadata stays on disk.
  // The service intentionally does not attempt to serialize live shell processes.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
