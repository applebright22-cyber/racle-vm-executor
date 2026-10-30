import test from "node:test";
import assert from "node:assert/strict";
import { parseShellOutput } from "../shell-output.js";

test("parses a completed command and preserves stdout, exit code, and cwd", () => {
  const output = [
    "__START__",
    "pong from google",
    "__END__:0",
    "__CWD__:/var/lib/oracle-vm-executor/accounts/acct-123/work",
    ""
  ].join("\n");
  assert.deepEqual(
    parseShellOutput(output, "__START__", "__END__", "__CWD__"),
    {
      stdout: "pong from google",
      exitCode: 0,
      cwd: "/var/lib/oracle-vm-executor/accounts/acct-123/work"
    }
  );
});

test("waits for the full completion and cwd markers across streamed chunks", () => {
  const partial = "__START__\nhello\n__END__:0\n__CWD__:/tmp";
  assert.equal(parseShellOutput(partial, "__START__", "__END__", "__CWD__"), null);
  const complete = partial + "\n";
  assert.deepEqual(parseShellOutput(complete, "__START__", "__END__", "__CWD__"), {
    stdout: "hello",
    exitCode: 0,
    cwd: "/tmp"
  });
});

test("parses nonzero exit codes and CRLF output", () => {
  const output = "__START__\r\nnot found\r\n__END__:127\r\n__CWD__:/tmp\r\n";
  assert.deepEqual(parseShellOutput(output, "__START__", "__END__", "__CWD__"), {
    stdout: "not found",
    exitCode: 127,
    cwd: "/tmp"
  });
});

test("does not report completion when the exit marker is malformed", () => {
  const output = "__START__\nhello\n__END__:oops\n__CWD__:/tmp\n";
  assert.equal(parseShellOutput(output, "__START__", "__END__", "__CWD__"), null);
});
