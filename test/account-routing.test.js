import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Cloudflare agent executes the account-specific persistent session", () => {
  assert.ok(server.includes("const accountId = request.account_id;"),
    "the Cloudflare coordinator supplies the target account identity");
  assert.ok(server.includes("if (!validIdentity(accountId))"),
    "agent messages without a valid account identity must not execute");
  assert.ok(server.includes("executeCommand(accountId, request.command, timeout)"),
    "commands must use the requested account's session rather than a shared oracle session");
  assert.ok(!server.includes('executeCommand("oracle", request.command, timeout)'),
    "account traffic must not collapse into a shared shell");
});

test("invalid account identity returns a correlated execution error", () => {
  const guardAt = server.indexOf("if (!validIdentity(accountId))");
  assert.notEqual(guardAt, -1);
  const guard = server.slice(guardAt, guardAt + 700);
  assert.ok(guard.includes('type: "result"'));
  assert.ok(guard.includes("id: request.id"));
  assert.ok(guard.includes("invalid_or_missing_account_id"));
  assert.ok(guard.includes("exit_code: 125"));
});
