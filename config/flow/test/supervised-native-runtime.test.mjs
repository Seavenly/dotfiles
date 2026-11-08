import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime, closeFlowRuntime } from "../src/runtime.mjs";
import { runCli } from "../src/cli-command.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT } from "../src/supervised-native-trust.mjs";

async function publicPreparation(t, { trust, acknowledgment = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flow-supervised-public-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { ...process.env, FLOW_EXECUTION_TRUST: trust ?? "strict" },
    authorityDirectory: join(directory, "authority"),
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const request = {
    schema: "flow.feature-preparation-request/v1",
    brief: { schema: "flow.feature-brief/v1", id: "brief:supervised", summary: "A disposable feature", acceptance: ["the feature works"] },
    repository: join(directory, "missing-repository"),
    mode: "verify",
    routes: { apply: { harness: "codex" }, critique: { harness: "codex" } },
    ...(acknowledgment ? { execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT } : {}),
  };
  let output = "";
  const sink = { write(value) { output += value; } };
  const exit = await runCli(["prepare", "--input", JSON.stringify(request), "--json"], {
    runtime, stdout: sink, stderr: sink,
  });
  return { exit, result: JSON.parse(output) };
}

test("public CLI supervised request requires the host opt-in", async (t) => {
  const { exit, result } = await publicPreparation(t);
  assert.equal(exit, 1);
  assert.equal(result.code, "supervised_execution_not_enabled");
});

test("public CLI supervised owner requires the explicit request acknowledgment", async (t) => {
  const { exit, result } = await publicPreparation(t, { trust: "supervised-native-cli", acknowledgment: false });
  assert.equal(exit, 1);
  assert.equal(result.code, "supervised_acknowledgment_required");
});

test("public CLI supervised preparation reaches real repository validation without claiming qualification", async (t) => {
  const { exit, result } = await publicPreparation(t, { trust: "supervised-native-cli" });
  assert.equal(exit, 1);
  assert.equal(result.code, "repository_missing");
  assert.match(result.reason, /repository path does not exist/u);
});

test("unknown host execution trust fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flow-supervised-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let runtime;
  t.after(() => { if (runtime) closeFlowRuntime(runtime); });
  assert.throws(() => {
    runtime = createFlowRuntime({ env: { FLOW_EXECUTION_TRUST: "unrestricted" }, authorityDirectory: directory, autonomous: false });
  }, /unsupported Flow execution trust posture/u);
});
