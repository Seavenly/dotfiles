import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
function run(executable, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(executable, args, { env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
}
function success(executable, args) {
  const result = run(executable, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("public CLI file input preserves a request larger than Linux's single argument limit", { skip: process.platform !== "linux" }, t => {
  const parent = mkdtempSync(join(tmpdir(), "flow-input-file-"));
  const executable = join(parent, "codex-fixture");
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi\nexit 99\n', { mode: 0o700 });
  let client;
  t.after(() => {
    if (client) success(client, ["stop", "--json"]);
    rmSync(parent, { recursive: true, force: true });
  });
  const pilot = success(process.execPath, [cli, "pilot", "setup", "--mode", "verify", "--parent", parent,
    "--execution-trust", "supervised-native-cli", "--codex-executable", executable]);
  client = join(pilot.directory, "flow");
  success(client, ["start", "--json"]);
  const request = { schema: "flow.query/v1", query: "delegated_agent_description",
    launch: { harness: "codex", capability: "read-only" },
    caller_metadata: { exact_payload: `exact-prefix:${"x".repeat(160000)}:exact-suffix` } };
  const bytes = JSON.stringify(request);
  assert.ok(Buffer.byteLength(bytes) > 131072);
  const literal = run(client, ["query", "--input", bytes, "--json"]);
  assert.equal(literal.error?.code, "E2BIG", "the original literal boundary must be genuinely reproduced");
  const input = join(pilot.directory, "large-request.json");
  writeFileSync(input, bytes);
  const described = success(client, ["query", "--input-file", input, "--json"]);
  assert.equal(described.status, "compatible", JSON.stringify(described));
  assert.deepEqual(described.description.caller_metadata, request.caller_metadata);
  assert.equal(success(client, ["status", "--json"]).state, "running");
});

test("public CLI rejects unavailable, malformed, nonregular and oversized JSON files before transport", t => {
  const parent = mkdtempSync(join(tmpdir(), "flow-input-errors-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const malformed = join(parent, "malformed.json"), oversized = join(parent, "oversized.json");
  writeFileSync(malformed, "{");
  writeFileSync(oversized, " ".repeat(4 * 1024 * 1024 + 1));
  const directory = join(parent, "directory"); mkdirSync(directory);
  for (const [path, code] of [[join(parent, "missing.json"), "input_file_unavailable"],
    [malformed, "input_file_invalid_json"], [directory, "input_file_not_regular"], [oversized, "input_file_too_large"]]) {
    const result = run(process.execPath, [cli, "launch", "--input-file", path, "--json"]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, code);
  }
});

test("file input is exclusive with literal, alias and positional input", t => {
  const parent = mkdtempSync(join(tmpdir(), "flow-input-exclusive-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const input = join(parent, "input.json"); writeFileSync(input, "{}");
  for (const extra of [["--input", "{}"], ["--request", "{}"], ["{}"], ["--input-file", input]]) {
    const result = run(process.execPath, [cli, "launch", "--input-file", input, ...extra, "--json"]);
    assert.equal(result.status, 2);
  }
});
