import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("timed-out shell commands terminate their process group and release the session", () => {
  const spawnAt = server.indexOf('spawn("/bin/bash"');
  const spawnEnd = server.indexOf("session.process = child;", spawnAt);
  const spawnBlock = server.slice(spawnAt, spawnEnd);
  assert.ok(spawnBlock.includes("detached: true"), "each shell must have a killable process group");
  const terminateAt = server.indexOf("function terminateTimedOutShell(session)");
  const executeAt = server.indexOf("async function executeCommand", terminateAt);
  const terminate = server.slice(terminateAt, executeAt);
  assert.ok(terminate.includes("process.kill(-child.pid, signal)"));
  assert.ok(terminate.includes('signalGroup("SIGTERM")'));
  assert.ok(terminate.includes('signalGroup("SIGKILL")'));
  const timeoutAt = server.indexOf("pending.timeout = setTimeout(() => {", executeAt);
  const timeoutEnd = server.indexOf("}, timeoutMs);", timeoutAt);
  const timeout = server.slice(timeoutAt, timeoutEnd);
  assert.ok(timeout.includes("pending.timingOut = true"));
  assert.ok(timeout.includes("terminateTimedOutShell(session)"));
  assert.ok(timeout.includes("command_still_running: false"));
  assert.ok(timeout.includes("finishPending(session"));
});
