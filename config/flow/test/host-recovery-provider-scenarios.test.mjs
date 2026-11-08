import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HOST_RECOVERY_PROVIDER_SCENARIO_SCHEMA,
  providerResultDriverInputs,
  runScenario1Provider,
  runScenario2Provider,
} from "../src/host-recovery-provider-scenarios.mjs";
import {
  createQualificationIsolation,
} from "../src/host-recovery-qualification.mjs";
import {
  runConcurrentRunsOwnerRestart,
  runActionableFailureRecovery,
} from "../src/host-recovery-runtime-scenarios.mjs";

const WORKTREE_ROOT = new URL("../../../", import.meta.url).pathname
  .replace(/\/$/u, "");

test("provider scenario 1 proves bounded concurrent delegates and owner restart", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "issue46-provider-test-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));

  const result = await runScenario1Provider({
    authorityDirectory,
    includeOwnerLifecycle: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.schema, HOST_RECOVERY_PROVIDER_SCENARIO_SCHEMA);
  assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
  assert.equal(result.provider.status, "observed");
  assert.equal(result.provider.invocation_count, 2);
  assert.deepEqual(
    result.assertions.map(({ id, disposition }) => [id, disposition]),
    [
      ["bounded_capacity", "pass"],
      ["client_exit", "pass"],
      ["same_boot_owner_restart", "pass"],
      ["no_duplicate_effect", "pass"],
    ],
  );

  const inputs = providerResultDriverInputs(result);
  assert.equal(inputs.nativeDelegate.invocation_count, 2);
  const query = await inputs.commandRunner({ command_kind: "query" });
  assert.equal(query.command.command_kind, "query");
  assert.equal(query.output.schema, "flow.run-projection/v1");
  await assert.rejects(
    inputs.commandRunner({ command_kind: "unknown" }),
    (error) => error.code === "provider_command_not_recorded",
  );
});

test("provider scenario 2 proves typed failures and one-shot uncertainty", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "issue46-provider-test-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));

  const result = await runScenario2Provider({
    authorityDirectory,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
  const failure = result.observations.find(({ kind }) => kind === "failure").content;
  const uncertainty = result.observations.find(({ kind }) => kind === "uncertainty").content;
  assert.deepEqual(
    ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
      .map((field) => failure[field]),
    [true, true, true, true, true],
  );
  assert.equal(uncertainty.one_shot, true);
  assert.equal(uncertainty.duplicate_effect, false);
  for (const kind of ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]) {
    assert.equal(failure.actionable_failures[kind].observed, true);
    assert.ok(failure.actionable_failures[kind].operator_response.length > 0);
    assert.ok(Array.isArray(failure.actionable_failures[kind].legal_actions));
  }
  assert.equal(result.provider.invocation_count >= 6, true);

  const inputs = providerResultDriverInputs(result);
  const command = await inputs.commandRunner({ command_kind: "command" });
  assert.equal(command.output.schema, "flow.command-receipt/v1");
  assert.equal(command.output.proof.failure.typed_failure, true);
});

test("provider outputs are accepted by the existing runtime scenario drivers", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "issue46-provider-driver-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const isolation = createQualificationIsolation({
    worktreeRoot: WORKTREE_ROOT,
    xdgStateHome: join(base, "state"),
    authorityDirectory: join(base, "authority"),
    socketPath: join(base, "authority", "owner.sock"),
    endpointPath: join(base, "authority", "owner.json"),
    backupDirectory: join(base, "backup"),
    repositoryRoot: join(base, "repository"),
    drovrConfigDirectory: join(base, "drovr"),
    herdrSession: "issue46-provider-driver",
    runId: "run:issue46-provider-driver",
  });
  const rawRoot = join(base, "raw");
  const entrypoints = {
    node: { path: process.execPath },
    launcher: { path: join(WORKTREE_ROOT, "config/flow/src/cli.mjs") },
    host: { path: "/bin/true" },
  };
  const cleanup = async () => ({
    disposition: "complete",
    owned_resources: [],
    resource_dispositions: [],
    unresolved_obligations: [],
    completed_at: new Date().toISOString(),
  });
  const providerResult = await runScenario1Provider({
    worktreeRoot: WORKTREE_ROOT,
    includeOwnerLifecycle: true,
    timeoutMs: 10_000,
  });
  const inputs = providerResultDriverInputs(providerResult);
  const scenario = await runConcurrentRunsOwnerRestart({
    ...inputs,
    entrypoints,
    isolation,
    rawRoot,
    cleanup,
    stopOwner: async () => {},
    timeoutMs: 2_000,
  });
  assert.equal(scenario.result.disposition, "pass", JSON.stringify(scenario, null, 2));

  const failureResult = await runScenario2Provider({ timeoutMs: 10_000 });
  const failureInputs = providerResultDriverInputs(failureResult);
  const failureScenario = await runActionableFailureRecovery({
    ...failureInputs,
    entrypoints,
    isolation,
    rawRoot: join(base, "failure-raw"),
    cleanup,
    timeoutMs: 2_000,
  });
  assert.equal(failureScenario.result.disposition, "pass", JSON.stringify(failureScenario, null, 2));
});

test("provider scenario 1 fails closed when owner lifecycle evidence is disabled", async () => {
  const result = await runScenario1Provider({
    includeOwnerLifecycle: false,
    timeoutMs: 5_000,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.result.reason, "owner_lifecycle_probe_required");
  assert.equal(result.observations.some(({ kind }) => kind === "capacity"), true);
  assert.equal(result.assertions.length, 0);
});

test("provider scenario rejects a non-absolute authority directory", async () => {
  await assert.rejects(
    runScenario2Provider({ authorityDirectory: "relative/provider" }),
    (error) => error.code === "authority_directory_invalid",
  );
});
