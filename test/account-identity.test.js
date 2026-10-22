import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Cloudflare execution requests must carry a validated account identity", () => {
  assert.ok(server.includes('const accountId = typeof request.account_id === "string" ? request.account_id : "";'));
  assert.ok(server.includes('if (!validIdentity(accountId))'));
  assert.ok(server.includes("await executeCommand(accountId, request.command, timeout)"));
  assert.ok(!server.includes('await executeCommand("oracle", request.command, timeout)'));
});
