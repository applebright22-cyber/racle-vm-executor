import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const EXECUTOR_TOKEN = process.env.ORACLE_EXECUTOR_TOKEN || "";
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || "./sessions");
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
  const workDir = path.join(directory, "work");
  const statePath = path.join(directory, "session.json");
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
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

  const env = { ...process.env };
  delete env.ORACLE_EXECUTOR_TOKEN;
  env.HOME = session.workDir;
  env.ORACLE_ACCOUNT_ID = session.identity;
  env.ORACLE_SESSION_DIR = session.directory;
  env.PWD = session.state.cwd;

  const child = spawn("/bin/bash", ["--noprofile", "--norc"], {
    cwd: session.state.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
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

  session.state.cwd = cwd.startsWith("/") ? cwd : session.workDir;
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
      // The command is deliberately left running. Its shell remains busy until it
      // finishes, so a later request cannot accidentally interleave with it.
      resolve({
        status: 504,
        body: { error: "execution_timeout", execution_id: id, timed_out: true, command_still_running: true }
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
let pollerFailures = 0;

async function runOracleBridgePoller() {
  if (!WORKER_URL || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(WORKER_URL)) {
    console.error("Oracle outbound bridge is not configured: set ORACLE_WORKER_URL in the service environment.");
    return;
  }
  if (!EXECUTOR_TOKEN) {
    console.error("Oracle outbound bridge is not configured: ORACLE_EXECUTOR_TOKEN is missing.");
    return;
  }
  console.log("Oracle outbound HTTPS bridge polling " + WORKER_URL);
  while (true) {
    try {
      const response = await fetch(WORKER_URL + "/api/oracle/next-job", {
        headers: { "x-executor-token": EXECUTOR_TOKEN },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("poll_http_" + response.status);
      const data = await response.json();
      pollerFailures = 0;
      const job = data.job;
      if (!job) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      let status = 200;
      let result;
      try {
        if (typeof job.id !== "string" || !/^[a-f0-9-]{36}$/.test(job.id) ||
            !validIdentity(job.identity) || !["status", "exec"].includes(job.action)) {
          status = 400;
          result = { error: "invalid_oracle_job" };
        } else if (job.action === "status") {
          const session = await getSession(job.identity);
          result = sessionSummary(session);
        } else {
          const payload = job.payload;
          if (!payload || typeof payload.command !== "string" || !payload.command.trim() ||
              payload.command.length > MAX_COMMAND_LENGTH) {
            status = 400;
            result = { error: "command_must_be_1_to_4096_characters" };
          } else {
            const requested = Number(payload.timeout_ms) || DEFAULT_TIMEOUT_MS;
            const timeout = Math.max(1000, Math.min(requested, MAX_TIMEOUT_MS));
            const execution = await executeCommand(job.identity, payload.command, timeout);
            status = execution.status;
            result = execution.body;
          }
        }
      } catch (error) {
        status = 500;
        result = { error: "oracle_job_failed", detail: error instanceof Error ? error.message : String(error) };
      }

      const completed = await fetch(WORKER_URL + "/api/oracle/complete-job", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-executor-token": EXECUTOR_TOKEN,
        },
        body: JSON.stringify({ id: job.id, status, result }),
        signal: AbortSignal.timeout(10000),
      });
      if (!completed.ok) throw new Error("complete_http_" + completed.status);
    } catch (error) {
      pollerFailures += 1;
      if (pollerFailures === 1 || pollerFailures % 20 === 0) {
        console.error("Oracle outbound bridge connection error:", error instanceof Error ? error.message : String(error));
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 + pollerFailures * 250, 5000)));
    }
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
      persistent_sessions: true
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
  void runOracleBridgePoller();
});

function shutdown() {
  // systemd may restart this process; completed session metadata stays on disk.
  // The service intentionally does not attempt to serialize live shell processes.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
