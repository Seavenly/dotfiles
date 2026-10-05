import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

import { closeFlowRuntime, createFlowRuntime } from "../src/runtime.mjs";
import { bindQualifiedReleaseFixture, copyQualifiedRuntimeFixture, rebindReleaseContentFixture } from "../test-support/qualified-release-fixture.mjs";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  HOST_RECOVERY_SCENARIOS, createQualificationIsolation, derivePinnedReleaseIdentity,
  qualificationHostIdentity, resolvePinnedEntrypoints, resolvePinnedQualificationTools,
  writeRawQualificationReceipt,
} from "../src/host-recovery-qualification.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const config = join(root, "config/flow");
const execFileAsync = promisify(execFile);

test("generated dark test not-run evidence with accurate route assertions still withholds public admission", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-not-run-test-release-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copied = join(scratch, "test-config");
  await cp(join(config, "releases/1.1-dark-test"), copied, { recursive: true });
  await execFileAsync(process.execPath, [join(config, "scripts/generate-release-content.mjs"),
    "--config-directory", copied, "--repository-root", root], { cwd: root });
  const qualification = JSON.parse(await readFile(join(copied, "evidence/release-qualification.v1.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(JSON.parse(await readFile(join(config, "schemas/flow.transition-qualification-evidence.v1.schema.json"), "utf8")));
  assert.equal(validate(qualification), true, ajv.errorsText(validate.errors));
  assert.equal(qualification.status, "not_run");
  assert.equal(qualification.recipe, null);
  assert.equal(qualification.assertions[1], "dark opt-in resolves only exact feature verify, feature test, and local review routes");
  const runtime = createFlowRuntime({ env: { HOME: scratch, FLOW_CONFIG_DIRECTORY: copied, FLOW_QUALIFICATION_REPOSITORY_ROOT: root, FLOW_REPOSITORY_ROOT: root }, autonomous: false });
  t.after(() => closeFlowRuntime(runtime));
  const before = runtime.query({});
  const rejected = await runtime.prepare({ schema: "flow.feature-preparation-request/v1", brief: { schema: "flow.feature-brief/v1", id: "brief:accurate-not-run", summary: "Withhold unqualified test release", acceptance: ["no run is created"] }, repository: root, mode: "verify", dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: "flow-release-1.1-dark-test/v1", purpose: "sacrificial_qualification" } });
  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "qualification_withheld");
  assert.deepEqual(runtime.query({}).runs, before.runs);
});

test("fixture qualification cannot rewrite either source release", async () => {
  for (const directory of [config, join(config, "releases/1.1-dark-test")]) {
    await assert.rejects(bindQualifiedReleaseFixture({ configDirectory: directory, repositoryRoot: root }), /disposable copied config/u);
  }
});

test("honest not-run qualification template validates but cannot admit a public route", async (t) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schema = JSON.parse(await readFile(join(config, "schemas/flow.transition-qualification-evidence.v1.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  const historical = JSON.parse(await readFile(join(config, "evidence/release-qualification.v1.json"), "utf8"));
  assert.equal(validate(historical), true, ajv.errorsText(validate.errors));
  const pending = { ...historical, status: "not_run", recipe: null };
  assert.equal(validate(pending), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...pending, status: "passed" }), false);
  assert.equal(validate({ ...historical, status: "not_run" }), false);
  assert.equal(validate({ ...pending, status: "running" }), false);

  const scratch = await mkdtemp(join(tmpdir(), "flow-not-run-release-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copied = join(scratch, "config");
  await cp(config, copied, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  await writeFile(join(copied, "evidence/release-qualification.v1.json"), JSON.stringify(pending));
  const ledgerPath = join(copied, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  Object.assign(ledger.evidence.find(({ id }) => id === "deterministic_qualification"), { status: "not_run", path: null, sha256: null });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await rebindReleaseContentFixture({ configDirectory: copied, repositoryRoot: root });
  const runtime = createFlowRuntime({ env: { HOME: scratch, FLOW_CONFIG_DIRECTORY: copied, FLOW_QUALIFICATION_REPOSITORY_ROOT: root, FLOW_REPOSITORY_ROOT: root }, autonomous: false });
  t.after(() => closeFlowRuntime(runtime));
  const before = runtime.query({});
  const rejected = await runtime.prepare({ schema: "flow.feature-preparation-request/v1", brief: { schema: "flow.feature-brief/v1", id: "brief:not-run", summary: "Withhold unqualified release", acceptance: ["no run is created"] }, repository: root, mode: "verify", dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: "flow-release-1.0-dark/v1", purpose: "sacrificial_qualification" } });
  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "qualification_withheld");
  assert.deepEqual(runtime.query({}).runs, before.runs);
});

test("selected host binding survives governed content regeneration and CLI successor refresh", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-selected-content-lifecycle-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const candidate = join(scratch, "candidate");
  await copyQualifiedRuntimeFixture({ sourceRoot: root, destination: candidate });
  const selected = join(candidate, "config/flow/releases/1.1-dark-test");
  const contentScript = join(candidate, "config/flow/scripts/generate-release-content.mjs");
  const hostScript = join(candidate, "config/flow/scripts/generate-host-recovery-evidence.mjs");
  const contentArgs = [contentScript, "--config-directory", selected, "--repository-root", candidate];
  await execFileAsync(process.execPath, contentArgs, { cwd: candidate });
  const aggregatePath = join(selected, "evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(selected, "transition-ledger.v1.json");
  const historical = await readFile(aggregatePath);
  assert.ok(historical.equals(await readFile(join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json"))),
    "unbound selected release retains the historical bootstrap copy");
  const initialRaw = await controlledHostReceipts(scratch, candidate, selected, "initial");
  await execFileAsync(process.execPath, [hostScript, "--worktree", candidate,
    "--config-directory", selected, "--raw-root", initialRaw,
    "--initialize-selected-release", "--preserve-historical-directory", join(scratch, "historical")], { cwd: candidate });
  const boundBytes = await readFile(aggregatePath);
  const boundRecord = JSON.parse(await readFile(ledgerPath, "utf8")).evidence.find(({ id }) => id === "issue_46_host_recovery");
  assert.equal(JSON.parse(boundBytes).release.release_id, "flow-release-1.1-dark-test/v1");
  assert.equal(boundRecord.sha256, createHash("sha256").update(boundBytes).digest("hex"));
  await writeFile(join(candidate, "config/flow/src/lifecycle-fixture.mjs"), "// controlled governed drift\n");
  await execFileAsync(process.execPath, contentArgs, { cwd: candidate });
  const regeneratedBytes = await readFile(aggregatePath);
  const regeneratedRecord = JSON.parse(await readFile(ledgerPath, "utf8")).evidence.find(({ id }) => id === "issue_46_host_recovery");
  const successorRaw = await controlledHostReceipts(scratch, candidate, selected, "successor");
  let successorError;
  try {
    await execFileAsync(process.execPath, [hostScript, "--worktree", candidate,
      "--config-directory", selected, "--raw-root", successorRaw, "--replace-tracked-successor"], { cwd: candidate });
  } catch (error) { successorError = error; }
  // Emit before assertions so failed lifecycle evidence survives test rendering.
  process.stdout.write(`# selected lifecycle ${JSON.stringify({ fixture_only: true, initialized_release: JSON.parse(boundBytes).release.release_id,
    regenerated_release: JSON.parse(regeneratedBytes).release.release_id,
    historical_overwrite: regeneratedBytes.equals(historical), bound_bytes_preserved: regeneratedBytes.equals(boundBytes),
    ledger_record_preserved: JSON.stringify(regeneratedRecord) === JSON.stringify(boundRecord),
    successor_exit: successorError?.code ?? 0, successor_stderr: successorError?.stderr ?? "" })}\n`);
  assert.ok(regeneratedBytes.equals(boundBytes), "regeneration must preserve ledger-bound selected aggregate bytes");
  assert.deepEqual(regeneratedRecord, boundRecord);
  assert.equal(successorError, undefined);
  const successorBytes = await readFile(aggregatePath);
  const successorRecord = JSON.parse(await readFile(ledgerPath, "utf8")).evidence.find(({ id }) => id === "issue_46_host_recovery");
  assert.equal(successorRecord.sha256, createHash("sha256").update(successorBytes).digest("hex"));
  assert.ok(!successorBytes.equals(boundBytes), "successor refresh must replace the predecessor bytes");
  for (const failure of ["missing", "corrupt", "symlink"]) {
    await t.test(`bound ${failure} aggregate fails before generator writes`, async () => {
      await rm(aggregatePath);
      if (failure === "corrupt") await writeFile(aggregatePath, "{}\n");
      if (failure === "symlink") await symlink(join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json"), aggregatePath);
      const generatedPaths = [
        "contracts/catalog.v1.json", "contracts/drovr-required-features.v1.json",
        "legacy-baselines.v1.json", "launch-policy.v1.json", "transition-ledger.v1.json",
        "evidence/release-content.v1.json", "evidence/release-qualification.v1.json",
        "evidence/production-route-conformance.v1.json",
      ];
      const before = await Promise.all(generatedPaths.map(async path => ({
        path, bytes: await readFile(join(selected, path)),
        mtimeNs: (await lstat(join(selected, path), { bigint: true })).mtimeNs,
      })));
      await assert.rejects(execFileAsync(process.execPath, contentArgs, { cwd: candidate }),
        /tracked|aggregate|predecessor/u);
      for (const { path, bytes, mtimeNs } of before) {
        assert.ok((await readFile(join(selected, path))).equals(bytes), `${path} bytes changed before refusal`);
        assert.equal((await lstat(join(selected, path), { bigint: true })).mtimeNs, mtimeNs,
          `${path} was written before refusal`);
      }
      await rm(aggregatePath, { force: true });
      await writeFile(aggregatePath, successorBytes);
    });
  }
});

// Full eight-scenario shaped receipts are controlled fixture observations,
// never official native execution or host qualification. The predicates mirror
// the host collector tests and keep Drovr/six-domain compatibility mandatory.
async function controlledHostReceipts(scratch, candidate, configDirectory, label) {
  const rawRoot = join(scratch, label);
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: candidate, configDirectory,
    xdgStateHome: join(scratch, "state"), authorityDirectory: join(scratch, "authority"),
    socketPath: join(scratch, "authority/owner.sock"), endpointPath: join(scratch, "authority/owner.json"),
    backupDirectory: join(scratch, "backup"), repositoryRoot: join(scratch, "repository"),
    drovrConfigDirectory: join(scratch, "drovr"), herdrSession: "herdr:content-lifecycle",
    runId: "run:issue-46-test-run" });
  const release = derivePinnedReleaseIdentity({ worktreeRoot: candidate, configDirectory });
  for (const definition of HOST_RECOVERY_SCENARIOS) {
    const receipt = controlledHostReceipt({ scenarioId: definition.id, rawRoot,
      logPath: "logs/owner-status.json", isolation });
    receipt.release = release;
    for (const observation of receipt.observations) {
      if (["query", "watch"].includes(observation.kind)) observation.content.provenance = "public_process";
      if (["views", "latency"].includes(observation.kind)) observation.content.provenance = "native_provider";
      observation.content_digest = canonicalDigest(observation.content);
    }
    if (definition.required_capture_kinds.length > 0) {
      receipt.captures = await Promise.all(definition.required_capture_kinds.map(async (kind) => {
        const bytes = Buffer.from(`controlled fixture only: ${kind}\n`);
        const path = `logs/${kind}.txt`; await writeFile(join(rawRoot, path), bytes);
        return { id: `fixture-${kind}`, kind, format: "text", path,
          sha256: createHash("sha256").update(bytes).digest("hex"), legibility: "pass",
          provenance: "native_provider", watermark: canonicalDigest({ kind }), legal_actions: "pass" };
      }));
      for (const assertion of receipt.assertions) assertion.evidence_refs = [
        ...receipt.commands.map(({ id }) => `command:${id}`),
        ...receipt.observations.map(({ id }) => `observation:${id}`),
        ...receipt.captures.map(({ id }) => `capture:${id}`),
      ];
    }
    writeRawQualificationReceipt(`${definition.id}.json`, receipt, { rawRoot });
  }
  return rawRoot;
}

function controlledHostReceipt({ scenarioId, rawRoot, logPath, isolation }) {
  const logSha256 = createHash("sha256").update("live\n").digest("hex");
  const definition = HOST_RECOVERY_SCENARIOS.find(({ id }) => id === scenarioId);
  const commandKinds = definition.required_command_kinds;
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: isolation.worktree_root });
  const qualificationTools = resolvePinnedQualificationTools({ entrypoints });
  const observationContent = {
    capacity: { bounded_capacity: true },
    client_exit: { client_exited: true },
    owner_restart: { same_boot_restart: true },
    effect: { duplicate_effect: false },
    failure: {
      typed_failure: true, cancellation: true, deadline: true,
      capped_recovery: true, provider_outage: true, invalid_output: true,
      actionable_failures: Object.fromEntries(
        ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
          .map((name) => [name, {
            observed: true,
            operator_response: `respond_${name}`,
            legal_actions: [],
          }])),
    },
    uncertainty: { one_shot: true, duplicate_effect: false },
    backup: { production_backup: true },
    loss: { destructive_loss: true },
    restore: { restored: true },
    reconciliation: {
      domains_reconciled: 6,
      reconciled: true,
      all_domains_non_empty: true,
      non_empty_domains: {
        database_streams: true,
        artifact_state: true,
        git_state: true,
        filesystem_state: true,
        external_effects: true,
        drovr_obligations: true,
      },
    },
    drovr_status: {
      observed: true,
      command: "drovr status",
      turn_id: "turn:issue-46-backup-retained",
      status: "working",
      provenance: "public_process",
      output_digest: `sha256:${"1".repeat(64)}`,
    },
    admission: { retained_result_admitted: true, explicit: true },
    capture_inventory: {
      inventory_complete: true, legibility: "pass", provenance: "pass",
      watermark: "pass", legal_actions: "pass",
    },
    producer_exit: { producer_exited: true },
    disposition: {
      flowruntime_disposition: "accept",
      dispositions: [{ disposition: "accept" }],
      approval: "approved",
      approval_receipt: { schema: "flow.review-approval/v1", decision: "approve" },
      disposition_receipt: { accepted: true },
      approval_command_receipt: { accepted: true },
    },
    stale_action: { rejected: true },
    rebuild: {
      identity_stable: true,
      projection_identity_stable: true,
      without_mutation_lock: true,
      mutation_lock_acquired: false,
      mutation_lock_observed: true,
      provenance: "native_provider",
      owner_mutation_lock: {
        held: true,
        inspect_runtime_open: true,
        provenance: "native_provider",
      },
      inspect_runtime_lock_observations: [
        { available: true, held: true, provenance: "native_provider" },
        { available: true, held: true, provenance: "native_provider" },
      ],
      external_mutation_lock: {
        available: true,
        held: false,
        provenance: "native_provider",
      },
      owner_lock_release_observed: true,
      owner_authority_watermark: {
        before: `sha256:${"2".repeat(64)}`,
        after: `sha256:${"2".repeat(64)}`,
        stable: true,
        delta: null,
      },
    },
    lock_owner: { owner_killed: true },
    negative_age: { rejected: true },
    negative_force: { rejected: true },
    query: { observed: true },
    watch: { observed: true },
    views: { count: 2 },
    latency: { samples: [10, 20] },
    suspended: { observed: true },
    reboot: { actual_reboot: false, deferred: true },
  };
  const observations = definition.required_observation_kinds.map((kind) => ({
    id: `owner-${kind}-observation`,
    kind,
    content: observationContent[kind] ?? { observed: true },
    content_digest: canonicalDigest(observationContent[kind] ?? { observed: true }),
  }));
  return {
    schema: "flow.host-recovery-raw-receipt/v1",
    version: 1,
    issue: 46,
    run_id: "run:issue-46-test-run",
    scenario_id: scenarioId,
    execution_kind: definition.execution_kind,
    release: {
      release_id: "flow-release-1.0-dark/v1",
      implementation: "flow-runtime/v1",
      candidate_tree_sha: "a".repeat(40),
      release_content_digest: `sha256:${"b".repeat(64)}`,
      pinned_git_tree_sha: "c".repeat(40),
      release_content_bytes_sha256: "d".repeat(64),
    },
    host: qualificationHostIdentity(),
    tools: {
      ...qualificationTools,
      herdr: { path_ref: "provider/herdr", version: "v1.0.0", sha256: "0".repeat(64) },
    },
    isolation: {
      state_root_ref: "isolation/state",
      authority_root_ref: "isolation/authority",
      socket_ref: "isolation/authority/owner.sock",
      endpoint_ref: "isolation/authority/owner.json",
      backup_root_ref: "isolation/backup",
      repository_root_ref: "isolation/repository",
      drovr_config_root_ref: "isolation/drovr-config",
      herdr_session_ref: "herdr-session:sha256:1234",
      run_id: "run:issue-46-test-run",
      identity_digest: `sha256:${"e".repeat(64)}`,
    },
    commands: commandKinds.map((commandKind) => ({
      id: `owner_${commandKind}`,
      argv: ["node", "config/flow/src/cli.mjs", commandKind, "--json"],
      command_kind: commandKind,
      launcher_ref: "config/flow/src/cli.mjs",
      working_directory_ref: "worktree",
      started_at: "2026-09-17T10:00:00.000Z",
      finished_at: "2026-09-17T10:00:00.010Z",
      exit_code: 0,
      signal: null,
      expected_exit_code: 0,
      expected_signal: null,
      expected_timed_out: false,
      timed_out: false,
      logs: {
        stdout: { path: logPath, sha256: logSha256, bytes: 5 },
        stderr: { path: null, sha256: "2".repeat(64), bytes: 0 },
      },
      duration_ms: 10,
    })),
    observations,
    captures: [{
      id: "owner-status-json",
      kind: "owner_status",
      format: "json",
      path: logPath,
      sha256: logSha256,
      legibility: "pass",
      provenance: "public_process",
      watermark: "sha256:3456",
      legal_actions: "pass",
    }],
    assertions: HOST_RECOVERY_SCENARIOS.find(({ id }) => id === scenarioId)
      .required_assertion_ids.map((id) => ({
        id,
        disposition: "pass",
        evidence_refs: ["capture:owner-status-json", `command:owner_${commandKinds[0]}`, ...observations.map(({ id }) => `observation:${id}`)],
      })),
    retained_obligations: [],
    cleanup: {
      disposition: "complete",
      owned_resources: [
        "isolation/state",
        "isolation/authority",
        "isolation/backup",
        "isolation/repository",
        "isolation/drovr-config",
        "isolation/qualification-workspace",
      ].map((identity_ref) => ({ kind: "isolated_root", identity_ref })),
      resource_dispositions: [
        "isolation/state",
        "isolation/authority",
        "isolation/backup",
        "isolation/repository",
        "isolation/drovr-config",
        "isolation/qualification-workspace",
      ].map((identity_ref) => ({
        kind: "isolated_root",
        identity_ref,
        disposition: "removed",
        proof: "absent_after_cleanup",
      })),
      unresolved_obligations: [],
      completed_at: "2026-09-17T10:00:00.020Z",
    },
    result: { disposition: "pass", reason: null },
    started_at: "2026-09-17T10:00:00.000Z",
    finished_at: "2026-09-17T10:00:00.020Z",
  };
}
