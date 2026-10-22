import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const setup = fs.readFileSync(new URL("../setup-oracle.sh", import.meta.url), "utf8");

test("executor HTTP listener defaults to loopback rather than a public interface", () => {
  assert.ok(
    server.includes('const HOST = process.env.HOST || "127.0.0.1";'),
    "server must default to loopback"
  );
  assert.ok(
    setup.includes("HOST=127.0.0.1"),
    "installer must write a loopback-only listener configuration"
  );
  assert.ok(
    !setup.includes("HOST=0.0.0.0"),
    "installer must not expose the local API on every network interface"
  );
});
