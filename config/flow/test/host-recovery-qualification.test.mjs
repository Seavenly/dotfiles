import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";

const execFile = promisify(execFileCallback);
const WORKTREE = resolve(import.meta.dirname, "../../..");

import {
  HOST_RECOVERY_QUALIFICATION_SCHEMA,
  HOST_RECOVERY_SCENARIOS,
  assertExternalQualificationRoot,
  createQualificationIsolation,
  derivePinnedReleaseIdentity,
  generateHostRecoveryEvidence,
  isolatedQualificationEnvironment,
  qualificationHostIdentity,
  readRawQualificationReceipt,
  resolvePinnedEntrypoints,
  resolvePinnedQualificationTools,
  runPinnedPublicCommand,
  validateTrackedHostRecoverySuccessor,
  validateTrackedHostRecoveryEvidence,
  writeRawQualificationReceipt,
} from "../src/host-recovery-qualification.mjs";
import {
  buildHostRecoveryRawReceipt,
  runBackupRestoreReconciliation,
} from "../src/host-recovery-runtime-scenarios.mjs";
import { publicQualificationIsAvailable } from "../../../tools/flow/src/transition-projection.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-harness-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const isolated = join(root, "isolated");
  const paths = {
    xdgStateHome: join(isolated, "state"),
    authorityDirectory: join(isolated, "authority"),
    socketPath: join(isolated, "authority", "owner.sock"),
    endpointPath: join(isolated, "authority", "owner.json"),
    backupDirectory: join(isolated, "backup"),
    repositoryRoot: join(isolated, "repository"),
    drovrConfigDirectory: join(isolated, "drovr-config"),
    herdrSession: "herdr:issue-46-test-session",
    runId: "run:issue-46-test-run",
  };
  await mkdir(join(worktree, "config/flow/src"), { recursive: true });
  await mkdir(join(worktree, "config/flow"), { recursive: true });
  await writeFile(join(worktree, "config/flow/src/owner-process.mjs"), "// pinned host\n");
  await mkdir(join(worktree, "tools/drovr/src"), { recursive: true });
  await writeFile(join(worktree, "tools/drovr/src/cli.mjs"), "// pinned drovr\n");
  await writeFile(join(worktree, "config/flow/src/cli.mjs"), [
    "process.stdout.write(JSON.stringify({ schema: 'flow.test-receipt/v1', ok: true }) + '\\n');",
    "",
  ].join("\n"));
  await chmod(join(worktree, "config/flow/src/cli.mjs"), 0o755);
  await mkdir(join(isolated, "logs"), { recursive: true });
  return { root, worktree, isolated, paths, logDirectory: join(isolated, "logs") };
}

function validReceipt({ scenarioId, rawRoot, logPath, isolation }) {
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

test("qualification isolation requires every explicit private root and unique Herdr session", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  assert.equal(isolation.worktree_root, worktree);
  assert.equal(isolation.socket_path, paths.socketPath);
  assert.equal(isolation.herdr_session, paths.herdrSession);
  const environment = isolatedQualificationEnvironment(isolation, { HOME: "/shared-home" });
  assert.equal(environment.HOME, isolation.qualification_workspace);
  assert.equal(environment.XDG_CONFIG_HOME.startsWith(isolation.qualification_workspace), true);
  assert.equal(environment.XDG_STATE_HOME, paths.xdgStateHome);
  assert.equal(assertExternalQualificationRoot(join(isolated, "raw"), { worktreeRoot: worktree }), join(isolated, "raw"));
  assert.throws(
    () => assertExternalQualificationRoot(join(worktree, "raw"), { worktreeRoot: worktree }),
    /disjoint from the pinned worktree/u,
  );

  assert.throws(
    () => createQualificationIsolation({ worktreeRoot: worktree, ...paths, socketPath: "relative.sock" }),
    /absolute/u,
  );
  assert.throws(
    () => createQualificationIsolation({ worktreeRoot: worktree, ...paths, herdrSession: "default" }),
    /unique Herdr/u,
  );
  assert.throws(
    () => createQualificationIsolation({
      worktreeRoot: worktree,
      ...paths,
      backupDirectory: isolated,
    }),
    /overlap/u,
  );
});

test("issue-46 evidence schema and runnable catalog are strict and version-bound", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(
    new URL("../schemas/flow.host-recovery-qualification-evidence.v1.schema.json", import.meta.url),
    "utf8",
  ));
  ajv.addSchema(schema);
  assert.equal(
    typeof ajv.getSchema("https://dotfiles.local/schemas/flow.host-recovery-qualification-evidence.v1.schema.json"),
    "function",
  );
  const catalog = JSON.parse(await readFile(
    new URL("../qualification/host-recovery.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(catalog.schema, "flow.host-recovery-qualification-catalog/v1");
  assert.deepEqual(
    catalog.scenarios.map(({ id }) => id),
    HOST_RECOVERY_SCENARIOS.map(({ id }) => id),
  );
  assert.equal(catalog.isolation.no_shared_defaults, true);
});

test("pinned entrypoints reject a worktree executable that resolves outside the worktree", async (t) => {
  const { worktree } = await fixture(t);
  const outside = join(worktree, "..", "outside-owner.mjs");
  await writeFile(outside, "// outside\n");
  await symlink(outside, join(worktree, "config/flow/src/outside-owner.mjs"));
  assert.throws(
    () => resolvePinnedEntrypoints({
      worktreeRoot: worktree,
      launcherPath: join(worktree, "config/flow/src/cli.mjs"),
      hostPath: join(worktree, "config/flow/src/outside-owner.mjs"),
    }),
    /outside pinned worktree/u,
  );
});

test("public invocation records exact exit and immutable log hashes", async (t) => {
  const fixtureData = await fixture(t);
  const isolation = createQualificationIsolation({
    worktreeRoot: fixtureData.worktree,
    ...fixtureData.paths,
  });
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: fixtureData.worktree });
  const invocation = await runPinnedPublicCommand({
    entrypoints,
    isolation,
    logDirectory: fixtureData.logDirectory,
    args: ["status", "--json"],
  });
  assert.equal(invocation.exit_code, 0);
  assert.equal(invocation.signal, null);
  assert.equal(invocation.logs.stdout.bytes > 0, true);
  assert.match(invocation.logs.stdout.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(invocation.launcher_ref, "config/flow/src/cli.mjs");
  assert.equal(await readFile(join(fixtureData.logDirectory, invocation.logs.stdout.path), "utf8"),
    '{"schema":"flow.test-receipt/v1","ok":true}\n');
});

test("pinned command abort escalates to SIGKILL and resolves only after close", async (t) => {
  const fixtureData = await fixture(t);
  const isolation = createQualificationIsolation({
    worktreeRoot: fixtureData.worktree,
    ...fixtureData.paths,
  });
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: fixtureData.worktree });
  const signals = [];
  const handlers = new Map();
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    once(event, handler) { handlers.set(event, handler); },
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => handlers.get("close")?.(null, "SIGKILL"), 0);
      }
      return true;
    },
  };
  const controller = new AbortController();
  const command = runPinnedPublicCommand({
    entrypoints,
    isolation,
    logDirectory: fixtureData.logDirectory,
    args: ["status", "--json"],
    timeoutMs: 5_000,
    signal: controller.signal,
    spawnFunction: () => child,
  });
  setTimeout(() => controller.abort(), 5);
  const invocation = await command;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(invocation.signal, "SIGKILL");
  assert.equal(invocation.timed_out, true);
});

test("evidence generator accepts external raw receipts but never upgrades deterministic support into a live pass", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(rawRoot, { recursive: true });
  const logPath = "logs/owner-status.json";
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, logPath), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot: "external/raw",
    logPath,
    isolation,
  });
  await writeRawQualificationReceipt("concurrent.json", receipt, { rawRoot });
  const loaded = await readRawQualificationReceipt(join(rawRoot, "concurrent.json"), { rawRoot });
  assert.equal(loaded.result.disposition, "pass");

  const outputPath = join(isolated, "host-recovery-evidence.json");
  const evidence = await generateHostRecoveryEvidence({
    worktreeRoot: worktree,
    rawRoot,
    receiptPaths: ["concurrent.json"],
    outputPath,
    allowExternalOutput: true,
    expectedRelease: receipt.release,
  });
  const schema = JSON.parse(await readFile(
    new URL("../schemas/flow.host-recovery-qualification-evidence.v1.schema.json", import.meta.url),
    "utf8",
  ));
  const validateEvidence = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateEvidence(evidence), true, JSON.stringify(validateEvidence.errors));
  assert.equal(evidence.schema, HOST_RECOVERY_QUALIFICATION_SCHEMA);
  assert.equal(evidence.status, "blocked");
  assert.equal(evidence.scenarios.find(({ id }) => id === "concurrent_runs_owner_restart").status,
    "passed");
  assert.equal(evidence.scenarios.some(({ status }) => status === "passed"), true);
  assert.equal(evidence.scenarios.some(({ status }) => status === "blocked"), true);

  const supportingReceipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot: "external/raw",
    logPath,
    isolation,
  });
  supportingReceipt.scenario_id = "supporting:schema-contract";
  supportingReceipt.execution_kind = "deterministic_supporting_check";
  await writeRawQualificationReceipt("supporting.json", supportingReceipt, { rawRoot });
  const supportingEvidence = await generateHostRecoveryEvidence({
    worktreeRoot: worktree,
    rawRoot,
    receiptPaths: ["concurrent.json", "supporting.json"],
    outputPath: join(isolated, "host-recovery-evidence-with-support.json"),
    allowExternalOutput: true,
    expectedRelease: receipt.release,
  });
  assert.deepEqual(
    supportingEvidence.supporting_checks.map(({ id }) => id),
    ["supporting:schema-contract"],
  );
  assert.equal(supportingEvidence.status, "blocked");
  assert.throws(
    () => generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths: ["concurrent.json"],
      outputPath,
      allowExternalOutput: true,
      expectedRelease: {
        release_id: "wrong-release",
        implementation: "flow-runtime/v1",
      },
    }),
    /release identity mismatch/u,
  );
});

test("pass receipts require catalog proof, resolved evidence, and proven cleanup", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  receipt.commands = [];
  receipt.assertions = [];
  assert.throws(
    () => writeRawQualificationReceipt("empty-pass.json", receipt, { rawRoot }),
    /pass proof|commands|assertion/u,
  );

  const unresolved = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  unresolved.cleanup.unresolved_obligations = [{ code: "still-present" }];
  assert.throws(
    () => writeRawQualificationReceipt("unresolved-pass.json", unresolved, { rawRoot }),
    /cleanup|obligation/u,
  );

  const danglingReference = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  danglingReference.assertions[0].evidence_refs = ["missing-proof"];
  assert.throws(
    () => writeRawQualificationReceipt("dangling-pass.json", danglingReference, { rawRoot }),
    /evidence|reference/u,
  );
});

test("backup reconciliation proof rejects an empty retained domain", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "backup_restore_reconciliation",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  const reconciliation = receipt.observations.find(({ kind }) => kind === "reconciliation");
  reconciliation.content.non_empty_domains.external_effects = false;
  reconciliation.content.all_domains_non_empty = false;
  reconciliation.content_digest = canonicalDigest(reconciliation.content);
  assert.throws(
    () => writeRawQualificationReceipt("empty-domain.json", receipt, { rawRoot }),
    /proof predicate|reconciliation|domain/u,
  );

  const missingStatus = validReceipt({
    scenarioId: "backup_restore_reconciliation",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  const drovrStatus = missingStatus.observations.find(({ kind }) => kind === "drovr_status");
  drovrStatus.content.observed = false;
  drovrStatus.content_digest = canonicalDigest(drovrStatus.content);
  assert.throws(
    () => writeRawQualificationReceipt("missing-drovr-status.json", missingStatus, { rawRoot }),
    /proof predicate|drovr|status/u,
  );
});

test("projection rebuild proof rejects missing owner-held lock evidence", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "projection_rebuild_readers",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  const rebuild = receipt.observations.find(({ kind }) => kind === "rebuild");
  rebuild.content = {
    ...rebuild.content,
    provenance: "native_provider",
    external_mutation_lock: {
      available: true,
      held: false,
      provenance: "native_provider",
    },
    owner_mutation_lock: {
      held: false,
      inspect_runtime_open: true,
      provenance: "native_provider",
    },
    inspect_runtime_lock_observations: [
      { available: true, held: true, provenance: "native_provider" },
      { available: true, held: true, provenance: "native_provider" },
    ],
    owner_lock_release_observed: true,
  };
  rebuild.content_digest = canonicalDigest(rebuild.content);
  assert.throws(
    () => writeRawQualificationReceipt("owner-lock-missing.json", receipt, { rawRoot }),
    /proof predicate|rebuild/u,
  );

  const drifted = validReceipt({
    scenarioId: "projection_rebuild_readers",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  const drift = drifted.observations.find(({ kind }) => kind === "rebuild");
  drift.content.owner_authority_watermark = {
    before: `sha256:${"2".repeat(64)}`,
    after: `sha256:${"3".repeat(64)}`,
    stable: false,
    delta: {
      before: `sha256:${"2".repeat(64)}`,
      after: `sha256:${"3".repeat(64)}`,
      authorized: false,
    },
  };
  drift.content_digest = canonicalDigest(drift.content);
  assert.throws(
    () => writeRawQualificationReceipt("watermark-drift.json", drifted, { rawRoot }),
    /proof predicate|watermark|rebuild/u,
  );
});

test("raw receipt, log, and capture paths reject symlink and non-regular escapes", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  const outside = join(isolated, "outside.log");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(outside, "live\n");
  await symlink(outside, join(rawRoot, "logs/owner-status.json"));
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation: createQualificationIsolation({ worktreeRoot: worktree, ...paths }),
  });
  await writeFile(join(rawRoot, "symlink.json"), `${JSON.stringify(receipt)}\n`);
  assert.throws(
    () => readRawQualificationReceipt("symlink.json", { rawRoot }),
    /symlink|regular|path/u,
  );

  await rm(join(rawRoot, "logs/owner-status.json"));
  await mkdir(join(rawRoot, "logs/owner-status.json"));
  await writeFile(join(rawRoot, "directory.json"), `${JSON.stringify(receipt)}\n`);
  assert.throws(
    () => readRawQualificationReceipt("directory.json", { rawRoot }),
    /regular|directory|path/u,
  );
});

test("receipts cannot mix run IDs or isolation identities", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const first = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  const second = validReceipt({
    scenarioId: "actionable_failure_recovery",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  await writeRawQualificationReceipt("first.json", first, { rawRoot });
  await writeRawQualificationReceipt("second.json", second, { rawRoot });
  second.run_id = "run:other-qualification";
  second.isolation.run_id = "run:other-qualification";
  second.isolation.identity_digest = `sha256:${"f".repeat(64)}`;
  await writeFile(join(rawRoot, "second.json"), `${JSON.stringify(second)}\n`);
  assert.throws(
    () => generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths: ["first.json", "second.json"],
      outputPath: join(isolated, "mixed.json"),
      expectedRelease: first.release,
      allowExternalOutput: true,
    }),
    /run|isolation|identity/u,
  );
});

test("child environment strips Flow, Drovr, Herdr, and Node injection variables", async (t) => {
  const { worktree, paths } = await fixture(t);
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const environment = isolatedQualificationEnvironment(isolation, {
    PATH: "/safe/bin",
    FLOW_OWNER_RUNTIME_MODULE: "/escape/runtime.mjs",
    FLOW_OWNER_SOCKET_FALLBACK_ROOT: "/escape/socket",
    DROVR_CONFIG_DIR: "/shared/drovr",
    DROVR_HOME: "/shared/drovr-home",
    HERDR_HOME: "/shared/herdr",
    NODE_OPTIONS: "--require=/escape.js",
    NODE_PATH: "/shared/node",
    XDG_STATE_HOME: "/shared/state",
    XDG_RUNTIME_DIR: "/shared/runtime",
  });
  assert.equal(environment.PATH, "/safe/bin");
  assert.equal(environment.FLOW_OWNER_RUNTIME_MODULE, undefined);
  assert.equal(environment.FLOW_OWNER_SOCKET_FALLBACK_ROOT, undefined);
  assert.equal(environment.DROVR_HOME, undefined);
  assert.equal(environment.HERDR_HOME, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(environment.XDG_STATE_HOME, paths.xdgStateHome);
  assert.notEqual(environment.XDG_RUNTIME_DIR, "/shared/runtime");
});

test("public logs and argv are redacted before persistence", async (t) => {
  const fixtureData = await fixture(t);
  await writeFile(
    join(fixtureData.worktree, "config/flow/src/cli.mjs"),
    "process.stdout.write('TOKEN=super-secret\n');\n",
  );
  const isolation = createQualificationIsolation({
    worktreeRoot: fixtureData.worktree,
    ...fixtureData.paths,
  });
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: fixtureData.worktree });
  const invocation = await runPinnedPublicCommand({
    entrypoints,
    isolation,
    logDirectory: fixtureData.logDirectory,
    args: ["status", "--token=super-secret"],
  });
  const stdout = await readFile(join(fixtureData.logDirectory, invocation.logs.stdout.path), "utf8");
  assert.doesNotMatch(stdout, /super-secret/u);
  assert.doesNotMatch(invocation.argv.join(" "), /super-secret/u);
});

test("pass validation rejects a forged failed/irrelevant command and a fake proof predicate", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation: createQualificationIsolation({ worktreeRoot: worktree, ...paths }),
  });
  receipt.commands.push({
    ...receipt.commands[0],
    id: "forged-unrelated-command",
    command_kind: "unrelated",
    argv: ["node", "config/flow/src/cli.mjs", "unrelated"],
    exit_code: 1,
    expected_exit_code: 0,
    signal: null,
    expected_signal: null,
    timed_out: false,
    expected_timed_out: false,
  });
  receipt.observations[0].kind = "capacity";
  receipt.observations[0].content = { bounded_capacity: false };
  receipt.observations[0].content_digest = canonicalDigest(receipt.observations[0].content);
  assert.throws(
    () => writeRawQualificationReceipt("forged-pass.json", receipt, { rawRoot }),
    /command|predicate|proof|observation/u,
  );
});

test("isolation rejects a destructive root that contains the pinned worktree", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  assert.throws(
    () => createQualificationIsolation({
      worktreeRoot: worktree,
      ...paths,
      backupDirectory: isolated,
    }),
    /overlap|outside|contains/u,
  );
});

test("aggregate generation rejects a catalog subset and binds the candidate release", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  await writeRawQualificationReceipt("subset.json", receipt, { rawRoot });
  assert.throws(
    () => generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths: ["subset.json"],
      outputPath: join(isolated, "subset-evidence.json"),
      allowExternalOutput: true,
      expectedRelease: receipt.release,
      catalog: HOST_RECOVERY_SCENARIOS.slice(0, 1),
    }),
    /catalog|eight|scenario/u,
  );
  try {
    const release = derivePinnedReleaseIdentity({ worktreeRoot: WORKTREE });
    assert.equal(release.release_id, "flow-release-1.0-dark/v1");
    assert.match(release.candidate_tree_sha, /^[0-9a-f]{40}$/u);
    assert.match(release.release_content_digest, /^sha256:[0-9a-f]{64}$/u);
  } catch (error) {
    // This test intentionally runs in the review worktree. Until generated
    // release content is refreshed, only the explicit dirty-tree state is
    // acceptable; stale or unbound release identities must still fail.
    assert.equal(error?.code, "release_candidate_dirty");
  }
});

test("tracked issue-46 aggregate consumer binds schema, current tools, digest, and ledger status", () => {
  try {
    const result = validateTrackedHostRecoveryEvidence({ worktreeRoot: WORKTREE });
    assert.equal(result.schema, "flow.tracked-host-recovery-consumer-result/v1");
    assert.equal(result.status, "passed");
    assert.match(result.evidence_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(result.evidence_sha256, /^[0-9a-f]{64}$/u);
  } catch (error) {
    // The tracked artifact is regenerated only after a clean candidate and a
    // fresh external qualification run.  A dirty review worktree must remain
    // fail-closed rather than silently accepting stale evidence.
    if (error?.code === "release_candidate_dirty") {
      assert.match(
        error.message,
        /candidate|aggregate|ledger/u,
        `unexpected fail-closed issue-46 consumer error: ${error.code}`,
      );
      return;
    }
    throw error;
  }
});

test("tracked issue-46 consumer remains valid after landing the aggregate commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-landing-stable-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeEphemeralPinnedWorktree(WORKTREE, join(root, "candidate"));
  const before = validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate });
  assert.equal(before.status, "passed");
  const tracked = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");
  const evidence = JSON.parse(await readFile(tracked, "utf8"));
  evidence.finished_at = "2099-01-01T00:00:00Z";
  evidence.evidence_digest = canonicalDigest({ ...evidence, evidence_digest: null });
  const aggregateBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(tracked, aggregateBytes);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const record = ledger.evidence.find(({ id }) => id === "issue_46_host_recovery");
  record.sha256 = createHash("sha256").update(aggregateBytes).digest("hex");
  record.evidence_digest = evidence.evidence_digest;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal(validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate }).status, "passed");
  await execFile("git", [
    "-C", candidate, "add",
    "config/flow/evidence/host-recovery-qualification.v1.json",
    "config/flow/transition-ledger.v1.json",
  ]);
  await execFile("git", [
    "-C", candidate, "commit", "--quiet", "-m", "bind issue-46 aggregate",
  ]);
  const after = validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate });
  assert.equal(after.status, "passed");
});

test("tracked issue-46 consumer rejects stale aggregate bytes and ledger binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-stale-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeEphemeralPinnedWorktree(WORKTREE, join(root, "candidate"));
  const baseline = validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate });
  assert.equal(baseline.status, "passed");
  const tracked = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");
  const bytes = await readFile(tracked);
  await writeFile(tracked, Buffer.concat([bytes, Buffer.from("\n") ]));
  assert.throws(
    () => validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate }),
    /digest|ledger|evidence/u,
  );
  await writeFile(tracked, bytes);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "issue_46_host_recovery").sha256 = "0".repeat(64);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.throws(
    () => validateTrackedHostRecoveryEvidence({ worktreeRoot: candidate }),
    /ledger|binding/u,
  );
});

test("qualification generator rejects stale issue-46 aggregate bytes and bindings before phases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-generator-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeEphemeralPinnedWorktree(WORKTREE, join(root, "candidate"));
  const aggregatePath = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");
  const generator = join(candidate, "config/flow/scripts/generate-qualification-evidence.mjs");
  const aggregateBytes = await readFile(aggregatePath);
  await writeFile(aggregatePath, Buffer.concat([aggregateBytes, Buffer.from("\n")]));
  await assert.rejects(
    () => execFile(process.execPath, [generator], { cwd: candidate, maxBuffer: 4 * 1024 * 1024 }),
    (error) => {
      assert.match(`${error.message}\n${error.stderr ?? ""}`, /tracked issue-46 evidence|digest/u);
      return true;
    },
  );
  await writeFile(aggregatePath, aggregateBytes);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "issue_46_host_recovery").sha256 = "0".repeat(64);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await assert.rejects(
    () => execFile(process.execPath, [generator], { cwd: candidate, maxBuffer: 4 * 1024 * 1024 }),
    (error) => {
      assert.match(`${error.message}\n${error.stderr ?? ""}`, /tracked issue-46 evidence|ledger|binding/u);
      return true;
    },
  );
});

test("qualification prerequisite bootstrap is explicit and cannot stand in for final qualification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-bootstrap-prerequisites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makePinnedDirtyWorktree(WORKTREE, join(root, "candidate"));
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");
  const generator = join(candidate, "config/flow/scripts/generate-qualification-evidence.mjs");
  const beforeLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const beforeIssue46 = structuredClone(
    beforeLedger.evidence.find(({ id }) => id === "issue_46_host_recovery"),
  );

  const { stdout } = await execFile(
    process.execPath,
    [generator, "--bootstrap-prerequisites"],
    { cwd: candidate, maxBuffer: 16 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "bootstrap_prerequisites");
  assert.equal(result.status, "prerequisites_ready");
  assert.equal(result.final_qualification, "not_run");
  assert.equal(result.issue_46_aggregate, "not_consumed");

  const afterLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.deepEqual(
    afterLedger.evidence.find(({ id }) => id === "issue_46_host_recovery"),
    beforeIssue46,
  );
  assert.equal(
    afterLedger.evidence.find(({ id }) => id === "deterministic_qualification").status,
    "passed",
  );
  assert.equal(
    afterLedger.evidence.find(({ id }) => id === "production_route_conformance").status,
    "passed",
  );

  const aggregatePath = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  const aggregateBytes = await readFile(aggregatePath);
  await writeFile(aggregatePath, Buffer.concat([aggregateBytes, Buffer.from("\n")]));
  await assert.rejects(
    () => execFile(process.execPath, [generator], {
      cwd: candidate,
      maxBuffer: 16 * 1024 * 1024,
    }),
    (error) => {
      assert.match(
        `${error.message}\n${error.stderr ?? ""}`,
        /tracked issue-46 evidence|release|digest|binding/u,
      );
      return true;
    },
  );
});

test("qualification generation withholds both public phases when interrupted during phase one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-qualification-phase-one-interrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ["final", "bootstrap"]) {
    const candidate = await makePinnedDirtyWorktree(
      WORKTREE,
      join(root, `${mode}-candidate`),
    );
    await bindEphemeralIssue46Aggregate(candidate);
    const configDirectory = join(candidate, "config/flow");
    const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
    const generator = join(configDirectory, "scripts/generate-qualification-evidence.mjs");
    const markerPath = join(root, `${mode}-phase-one-started`);
    const markerSeen = new Promise((resolveMarker, rejectMarker) => {
      const watcher = watch(root, (eventType, filename) => {
        if (filename?.toString() !== basename(markerPath)) return;
        watcher.close();
        resolveMarker();
      });
      watcher.on("error", (error) => {
        watcher.close();
        rejectMarker(error);
      });
    });
    const child = spawn(process.execPath, [
      generator,
      ...(mode === "bootstrap" ? ["--bootstrap-prerequisites"] : []),
    ], {
      cwd: candidate,
      env: {
        ...process.env,
        FLOW_QUALIFICATION_TEST_PHASE1_SYNC: markerPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const exit = new Promise((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    let exitResult = null;
    t.after(async () => {
      if (exitResult !== null) return;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      exitResult = await exit;
    });

    try {
      await markerSeen;
      const interruptedLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
      for (const id of ["deterministic_qualification", "production_route_conformance"]) {
        const record = interruptedLedger.evidence.find((evidence) => evidence.id === id);
        assert.equal(record.status, "not_run", `${mode}:${id}`);
        assert.equal(record.path, null, `${mode}:${id} path`);
        assert.equal(record.sha256, null, `${mode}:${id} digest`);
      }
      assert.equal(publicQualificationIsAvailable({
        configDirectory,
        repositoryRoot: candidate,
        selection: {},
        homeDirectory: join(root, `${mode}-home`),
        stateDirectory: join(root, `${mode}-state`),
      }), false, `${mode}: public admission`);

      assert.equal(child.kill("SIGKILL"), true, `${mode}: generator was stopped at the hook`);
      exitResult = await exit;
      assert.deepEqual(exitResult, { code: null, signal: "SIGKILL" }, `${mode}: generator exit`);
      const afterLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
      for (const id of ["deterministic_qualification", "production_route_conformance"]) {
        const record = afterLedger.evidence.find((evidence) => evidence.id === id);
        assert.equal(record.status, "not_run", `${mode}:${id} after SIGKILL`);
        assert.equal(record.path, null, `${mode}:${id} path after SIGKILL`);
        assert.equal(record.sha256, null, `${mode}:${id} digest after SIGKILL`);
      }
    } finally {
      if (exitResult === null) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        exitResult = await exit;
      }
    }
  }
});

test("tracked issue-46 successor generation requires an exact predecessor ledger binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-successor-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeWorkingTreeCopy(WORKTREE, join(root, "candidate"));
  const trackedPath = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");

  const predecessor = validateTrackedHostRecoverySuccessor({ worktreeRoot: candidate });
  assert.equal(predecessor.ledgerEvidence.path, "evidence/host-recovery-qualification.v1.json");
  assert.equal(predecessor.ledgerEvidence.sha256,
    createHash("sha256").update(predecessor.aggregateBytes).digest("hex"));

  for (const [label, mutate] of [
    ["stale bytes", (record) => { record.sha256 = "0".repeat(64); }],
    ["unbound digest", (record) => { record.evidence_digest = "sha256:" + "0".repeat(64); }],
  ]) {
    const ledger = structuredClone(predecessor.ledger);
    mutate(ledger.evidence.find(({ id }) => id === "issue_46_host_recovery"));
    const alternateLedgerPath = join(candidate, `config/flow/${label.replaceAll(" ", "-")}.json`);
    await writeFile(alternateLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    assert.throws(
      () => validateTrackedHostRecoverySuccessor({
        worktreeRoot: candidate,
        evidencePath: trackedPath,
        ledgerPath: alternateLedgerPath,
      }),
      /predecessor.*bound/u,
      label,
    );
  }
});

test("tracked issue-46 successor generator atomically replaces a bound predecessor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-successor-generator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await makeEphemeralPinnedWorktree(WORKTREE, join(root, "candidate"));
  const rawRoot = join(root, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({
    worktreeRoot: candidate,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    herdrSession: "herdr:issue-46-successor-generator",
    runId: "run:issue-46-successor-generator",
  });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  receipt.release = derivePinnedReleaseIdentity({ worktreeRoot: candidate });
  const herdr = receipt.tools.herdr;
  receipt.tools = resolvePinnedQualificationTools({
    entrypoints: resolvePinnedEntrypoints({ worktreeRoot: candidate }),
  });
  receipt.tools = { ...receipt.tools, herdr };
  await writeRawQualificationReceipt("predecessor.json", receipt, { rawRoot });
  const predecessorEvidence = await generateHostRecoveryEvidence({
    worktreeRoot: candidate,
    rawRoot,
    receiptPaths: ["predecessor.json"],
    outputPath: join(root, "predecessor-evidence.json"),
    expectedRelease: receipt.release,
    allowExternalOutput: true,
  });
  const trackedPath = join(candidate, "config/flow/evidence/host-recovery-qualification.v1.json");
  await writeFile(trackedPath, `${JSON.stringify(predecessorEvidence, null, 2)}\n`);
  const ledgerPath = join(candidate, "config/flow/transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const record = ledger.evidence.find(({ id }) => id === "issue_46_host_recovery");
  record.path = "evidence/host-recovery-qualification.v1.json";
  record.sha256 = createHash("sha256").update(await readFile(trackedPath)).digest("hex");
  record.evidence_digest = predecessorEvidence.evidence_digest;
  record.status = predecessorEvidence.status;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await writeRawQualificationReceipt("successor.json", receipt, { rawRoot });
  const before = await readFile(trackedPath);
  const script = join(candidate, "config/flow/scripts/generate-host-recovery-evidence.mjs");
  const { stdout } = await execFile(process.execPath, [
    script,
    "--worktree", candidate,
    "--raw-root", rawRoot,
    "--receipt", "successor.json",
    "--replace-tracked-successor",
  ], { cwd: candidate, maxBuffer: 4 * 1024 * 1024 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "blocked");
  const after = await readFile(trackedPath);
  assert.notDeepEqual(after, before);
  const successor = validateTrackedHostRecoverySuccessor({ worktreeRoot: candidate });
  assert.equal(successor.ledgerEvidence.sha256,
    createHash("sha256").update(after).digest("hex"));
  assert.equal(successor.ledgerEvidence.evidence_digest, successor.evidence.evidence_digest);
});

test("aggregate generation rejects receipt tool identity drift from the pinned worktree", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  receipt.tools = structuredClone(receipt.tools);
  receipt.tools.flow_host.sha256 = "0".repeat(64);
  await writeRawQualificationReceipt("tool-drift.json", receipt, { rawRoot });
  assert.throws(
    () => generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths: ["tool-drift.json"],
      outputPath: join(isolated, "tool-drift-evidence.json"),
      allowExternalOutput: true,
      expectedRelease: receipt.release,
      catalog: HOST_RECOVERY_SCENARIOS,
    }),
    /tool.*identity|pinned.*entrypoint/u,
  );
});

test("aggregate generation rejects receipt host identity drift from the current host", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const receipt = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  receipt.host = { ...receipt.host, architecture: "forged-architecture" };
  await writeRawQualificationReceipt("host-drift.json", receipt, { rawRoot });
  assert.throws(
    () => generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths: ["host-drift.json"],
      outputPath: join(isolated, "host-drift-evidence.json"),
      allowExternalOutput: true,
      expectedRelease: receipt.release,
      catalog: HOST_RECOVERY_SCENARIOS,
    }),
    /host.*identity|current qualification host/u,
  );
});

test("pass validation rejects duplicate evidence artifacts and aliased proof mappings", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const duplicateCapture = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  duplicateCapture.captures.push({ ...duplicateCapture.captures[0], id: "duplicate-capture" });
  assert.throws(
    () => writeRawQualificationReceipt("duplicate-capture.json", duplicateCapture, { rawRoot }),
    /duplicate|inventory|unique/u,
  );

  const aliasedProof = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  aliasedProof.assertions = aliasedProof.assertions.map((assertion) => ({
    ...assertion,
    evidence_refs: ["capture:owner-status-json"],
  }));
  assert.throws(
    () => writeRawQualificationReceipt("aliased-proof.json", aliasedProof, { rawRoot }),
    /proof|mapping|evidence/u,
  );
});

test("pass cleanup requires absence proof for removal and durable retention evidence", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const retained = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  retained.cleanup.resource_dispositions[0] = {
    ...retained.cleanup.resource_dispositions[0],
    disposition: "retained",
    proof: "retention_receipt_recorded",
  };
  assert.throws(
    () => writeRawQualificationReceipt("retained-without-proof.json", retained, { rawRoot }),
    /retention|cleanup|durable/u,
  );
});

test("pass validation rejects secret-shaped unknown receipt fields and unknown host identity", async (t) => {
  const { worktree, isolated, paths } = await fixture(t);
  const rawRoot = join(isolated, "raw");
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  await writeFile(join(rawRoot, "logs/owner-status.json"), "live\n");
  const isolation = createQualificationIsolation({ worktreeRoot: worktree, ...paths });
  const secret = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  secret.unknown_receipt_field = "token=should-not-persist";
  assert.throws(
    () => writeRawQualificationReceipt("secret-receipt.json", secret, { rawRoot }),
    /secret|strict/u,
  );

  const unknownHost = validReceipt({
    scenarioId: "concurrent_runs_owner_restart",
    rawRoot,
    logPath: "logs/owner-status.json",
    isolation,
  });
  unknownHost.host.npm = "not_observed";
  assert.throws(
    () => writeRawQualificationReceipt("unknown-host.json", unknownHost, { rawRoot }),
    /host|observed|unknown/u,
  );
});

test("native backup/restore probe produces a validator-accepted pass receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-native-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = await makeEphemeralPinnedWorktree(
    WORKTREE,
    join(root, "implementation-worktree"),
  );
  const rawRoot = join(root, "raw");
  const isolation = createQualificationIsolation({
    worktreeRoot: worktree,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    qualificationWorkspace: join(root, "workspace"),
    herdrSession: "herdr:issue-46-native-receipt",
    runId: "run:issue-46-native-receipt",
  });
  await mkdir(join(rawRoot, "logs"), { recursive: true });
  const scriptPath = join(worktree, "config/flow/scripts/run-host-recovery-native-probe.mjs");
  const args = [
    scriptPath,
    "--probe", "backup_restore",
    "--worktree", worktree,
    "--raw-root", rawRoot,
    "--temporary-root", tmpdir(),
    "--xdg-state-home", isolation.xdg_state_home,
    "--authority-directory", isolation.authority_directory,
    "--socket", isolation.socket_path,
    "--endpoint", isolation.endpoint_path,
    "--backup-directory", isolation.backup_directory,
    "--repository-root", isolation.repository_root,
    "--drovr-config-directory", isolation.drovr_config_directory,
    "--qualification-workspace", isolation.qualification_workspace,
    "--herdr-session", isolation.herdr_session,
    "--run-id", isolation.run_id,
    "--timeout", "120000",
  ];
  const startedAt = new Date().toISOString();
  const { stdout, stderr } = await execFile(process.execPath, args, {
    cwd: worktree,
    env: isolatedQualificationEnvironment(isolation),
    maxBuffer: 16 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const probeOutput = JSON.parse(stdout.trim());
  assert.equal(probeOutput.schema, "flow.production-backup-live-observation/v1");
  assert.equal(probeOutput.status, "pass");
  assert.equal(probeOutput.setup.schema, "flow.native-backup-restore-setup/v1");
  assert.equal(probeOutput.setup.repository.initialized, true);
  assert.equal(probeOutput.setup.drovr_config.copied, true);
  assert.equal(probeOutput.proof.reconciliation.domains_reconciled, 6);

  const commandId = "native-backup-restore-integration";
  const stdoutPath = join(rawRoot, "logs", `${commandId}.stdout.log`);
  const stderrPath = join(rawRoot, "logs", `${commandId}.stderr.log`);
  await writeFile(stdoutPath, stdout, { mode: 0o600 });
  await writeFile(stderrPath, stderr, { mode: 0o600 });
  const descriptor = (path, value) => ({
    path: relative(rawRoot, path),
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: Buffer.byteLength(value),
  });
  const command = {
    id: commandId,
    argv: [
      "node",
      relative(worktree, scriptPath),
      "--probe", "backup_restore",
      "--worktree", "worktree",
      "--raw-root", "external/raw-root",
      "--repository-root", "isolation/repository",
      "--drovr-config-directory", "isolation/drovr-config",
    ],
    command_kind: "native_backup_restore_probe",
    launcher_ref: relative(worktree, scriptPath),
    host_ref: "runtime/flow-runtime",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: 0,
    signal: null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: false,
    logs: {
      stdout: descriptor(stdoutPath, stdout),
      stderr: descriptor(stderrPath, stderr),
    },
  };
  const entrypoints = resolvePinnedEntrypoints({ worktreeRoot: worktree });
  const scenarioResult = await runBackupRestoreReconciliation({
    entrypoints,
    isolation,
    rawRoot,
    timeoutMs: 120_000,
    nativeBackupRestoreProbe: { command, output: probeOutput },
  });
  assert.equal(scenarioResult.result.disposition, "pass");
  assert.equal(scenarioResult.result.reason, null);

  const release = derivePinnedReleaseIdentity({ worktreeRoot: worktree });
  const qualificationTools = resolvePinnedQualificationTools({ entrypoints });
  const receipt = buildHostRecoveryRawReceipt({
    scenarioResult,
    release,
    host: qualificationHostIdentity(),
    tools: {
      ...qualificationTools,
      herdr: { path_ref: "external/herdr/not-required", version: "not_required", sha256: createHash("sha256").update("herdr-not-required").digest("hex") },
    },
    isolation,
    rawRoot,
  });
  const written = writeRawQualificationReceipt("backup-restore-native.json", receipt, { rawRoot });
  const verified = readRawQualificationReceipt(written.path, { rawRoot });
  assert.equal(verified.result.disposition, "pass");
  assert.equal(verified.execution_kind, "native_provider");
  assert.equal(verified.commands[0].command_kind, "native_backup_restore_probe");
  assert.deepEqual(verified.cleanup.unresolved_obligations, []);
});

test("native Drovr lock probe produces a validator-accepted pass receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-native-drovr-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = await makeEphemeralPinnedWorktree(
    WORKTREE,
    join(root, "implementation-worktree"),
  );
  const rawRoot = join(root, "raw");
  const isolationRoots = {
    state: join(root, "state"),
    authority: join(root, "authority"),
    backup: join(root, "backup"),
    repository: join(root, "repository"),
    drovr: join(root, "drovr"),
  };
  const runner = join(worktree, "config/flow/scripts/run-host-recovery-qualification.mjs");
  const runId = "run:issue-46-native-drovr-lock";
  const { stdout } = await execFile(process.execPath, [
    runner,
    "--worktree", worktree,
    "--raw-root", rawRoot,
    "--scenario", "drovr_registry_lock_reconciliation",
    "--run-id", runId,
    "--xdg-state-home", isolationRoots.state,
    "--authority-directory", isolationRoots.authority,
    "--socket", join(isolationRoots.authority, "owner.sock"),
    "--endpoint", join(isolationRoots.authority, "owner.json"),
    "--backup-directory", isolationRoots.backup,
    "--repository-root", isolationRoots.repository,
    "--drovr-config-directory", isolationRoots.drovr,
    "--herdr-session", "herdr:issue-46-native-drovr-lock",
    "--timeout", "120000",
  ], {
    cwd: worktree,
    env: isolatedQualificationEnvironment({
      worktree_root: worktree,
      xdg_state_home: isolationRoots.state,
      authority_directory: isolationRoots.authority,
      socket_path: join(isolationRoots.authority, "owner.sock"),
      endpoint_path: join(isolationRoots.authority, "owner.json"),
      backup_directory: isolationRoots.backup,
      repository_root: isolationRoots.repository,
      drovr_config_directory: isolationRoots.drovr,
      qualification_workspace: join(isolationRoots.state, "qualification-workspace"),
      runtime_directory: null,
      herdr_session: "herdr:issue-46-native-drovr-lock",
      run_id: runId,
    }),
    maxBuffer: 16 * 1024 * 1024,
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.schema, "flow.host-recovery-raw-receipt/v1");
  assert.equal(summary.scenario_id, "drovr_registry_lock_reconciliation");
  assert.equal(summary.commands, 1);

  const receipt = await readRawQualificationReceipt(summary.receipt_path, { rawRoot });
  assert.equal(summary.status, "pass", JSON.stringify({ summary, result: receipt.result }));
  assert.equal(receipt.result.disposition, "pass");
  assert.equal(receipt.execution_kind, "native_provider");
  assert.deepEqual(receipt.commands.map(({ command_kind }) => command_kind), [
    "native_drovr_lock_probe",
  ]);
  assert.deepEqual(receipt.observations.map(({ kind }) => kind), [
    "lock_owner", "reconciliation", "negative_age", "negative_force",
  ]);
  assert.equal(receipt.captures.length, 1);
  assert.equal(receipt.cleanup.disposition, "complete");
  assert.deepEqual(receipt.cleanup.unresolved_obligations, []);
  for (const path of Object.values(isolationRoots)) {
    assert.equal(await pathExists(path), false, `isolated root remains: ${path}`);
  }
});

test("provider recovery scenarios run through one native subprocess and bind observations to the receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-native-provider-") );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      scenarioId: "concurrent_runs_owner_restart",
      commandKind: "native_concurrency_recovery_probe",
      observationKinds: ["capacity", "client_exit", "owner_restart", "effect"],
    },
    {
      scenarioId: "actionable_failure_recovery",
      commandKind: "native_failure_recovery_probe",
      observationKinds: ["failure", "uncertainty"],
    },
  ];

  for (const [index, expected] of cases.entries()) {
    const caseRoot = join(root, `case-${index}`);
    const worktree = await makeEphemeralPinnedWorktree(
      WORKTREE,
      join(caseRoot, "implementation-worktree"),
    );
    const rawRoot = join(caseRoot, "raw");
    const paths = {
      state: join(caseRoot, "state"),
      authority: join(caseRoot, "authority"),
      backup: join(caseRoot, "backup"),
      repository: join(caseRoot, "repository"),
      drovr: join(caseRoot, "drovr"),
    };
    const runId = `run:issue-46-native-provider-${index}`;
    const environment = {
      worktree_root: worktree,
      xdg_state_home: paths.state,
      authority_directory: paths.authority,
      socket_path: join(paths.authority, "owner.sock"),
      endpoint_path: join(paths.authority, "owner.json"),
      backup_directory: paths.backup,
      repository_root: paths.repository,
      drovr_config_directory: paths.drovr,
      qualification_workspace: join(caseRoot, "workspace"),
      runtime_directory: null,
      herdr_session: `herdr:issue-46-native-provider-${index}`,
      run_id: runId,
    };
    const runner = join(worktree, "config/flow/scripts/run-host-recovery-qualification.mjs");
    const { stdout } = await execFile(process.execPath, [
      runner,
      "--worktree", worktree,
      "--raw-root", rawRoot,
      "--scenario", expected.scenarioId,
      "--run-id", runId,
      "--xdg-state-home", paths.state,
      "--authority-directory", paths.authority,
      "--socket", environment.socket_path,
      "--endpoint", environment.endpoint_path,
      "--backup-directory", paths.backup,
      "--repository-root", paths.repository,
      "--drovr-config-directory", paths.drovr,
      "--herdr-session", environment.herdr_session,
      "--timeout", "120000",
    ], {
      cwd: worktree,
      env: isolatedQualificationEnvironment(environment),
      maxBuffer: 16 * 1024 * 1024,
    });
    const summary = JSON.parse(stdout);
    const receipt = await readRawQualificationReceipt(summary.receipt_path, { rawRoot });
    assert.equal(summary.status, "pass", JSON.stringify({ summary, result: receipt.result }));
    assert.equal(receipt.execution_kind, "native_provider");
    assert.deepEqual(receipt.commands.map(({ command_kind }) => command_kind), [expected.commandKind]);
    assert.equal(receipt.commands[0].launcher_ref,
      "config/flow/scripts/run-host-recovery-provider-scenarios.mjs");
    assert.equal(receipt.captures.length, 1);
    assert.equal(receipt.captures[0].provenance, "native_provider");
    assert.deepEqual(receipt.observations.map(({ kind }) => kind), expected.observationKinds);
    const observationIds = new Set(receipt.observations.map(({ id }) => `observation:${id}`));
    for (const assertion of receipt.assertions) {
      assert.equal(assertion.disposition, "pass");
      assert.equal(assertion.evidence_refs.every((reference) => observationIds.has(reference)), true);
    }
    assert.equal(receipt.cleanup.disposition, "complete");
    assert.deepEqual(receipt.cleanup.unresolved_obligations, []);
    for (const path of Object.values(paths)) {
      assert.equal(await pathExists(path), false, `isolated root remains: ${path}`);
    }
    await rm(caseRoot, { recursive: true, force: true });
  }
});

test("qualification runner records the native headless probe after public captures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-headless-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = WORKTREE;
  const rawRoot = join(root, "raw");
  const paths = {
    state: join(root, "state"),
    authority: join(root, "authority"),
    backup: join(root, "backup"),
    repository: join(root, "repository"),
    drovr: join(root, "drovr"),
  };
  const runId = "run:issue-46-headless-runner";
  const environment = {
    worktree_root: worktree,
    xdg_state_home: paths.state,
    authority_directory: paths.authority,
    socket_path: join(paths.authority, "owner.sock"),
    endpoint_path: join(paths.authority, "owner.json"),
    backup_directory: paths.backup,
    repository_root: paths.repository,
    drovr_config_directory: paths.drovr,
    qualification_workspace: join(root, "workspace"),
    runtime_directory: null,
    herdr_session: "herdr:issue-46-headless-runner",
    run_id: runId,
  };
  const runner = join(worktree, "config/flow/scripts/run-host-recovery-qualification.mjs");
  const { stdout } = await execFile(process.execPath, [
    runner,
    "--worktree", worktree,
    "--raw-root", rawRoot,
    "--scenario", "ubuntu_headless_text_captures",
    "--run-id", runId,
    "--xdg-state-home", paths.state,
    "--authority-directory", paths.authority,
    "--socket", environment.socket_path,
    "--endpoint", environment.endpoint_path,
    "--backup-directory", paths.backup,
    "--repository-root", paths.repository,
    "--drovr-config-directory", paths.drovr,
    "--herdr-session", environment.herdr_session,
    "--timeout", "5000",
  ], {
    cwd: worktree,
    // PATH is an explicit tool-discovery input for the pinned Tuicr binary;
    // all other caller state remains stripped by the isolation environment.
    env: isolatedQualificationEnvironment(environment, { PATH: process.env.PATH }),
    maxBuffer: 16 * 1024 * 1024,
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.schema, "flow.host-recovery-raw-receipt/v1");
  assert.equal(summary.scenario_id, "ubuntu_headless_text_captures");
  const receipt = await readRawQualificationReceipt(summary.receipt_path, { rawRoot });
  assert.equal(summary.status, "pass", JSON.stringify({ summary, result: receipt.result }));
  assert.equal(receipt.result.disposition, "pass");
  assert.deepEqual(receipt.commands.map(({ command_kind }) => command_kind), [
    "status", "query", "watch", "native_headless_capture_probe",
  ]);
  const provider = receipt.commands.at(-1);
  assert.equal(provider.launcher_ref,
    "config/flow/scripts/run-host-recovery-headless-provider.mjs");
  assert.equal(provider.exit_code, 0);
  assert.equal(provider.signal, null);
  assert.equal(provider.timed_out, false);
  assert.equal(receipt.cleanup.disposition, "complete");
  assert.deepEqual(receipt.cleanup.unresolved_obligations, []);
  for (const path of Object.values(paths)) {
    assert.equal(await pathExists(path), false, `isolated root remains: ${path}`);
  }
  assert.equal(await pathExists(join(root, "workspace")), false);
});

test("qualification runner records the native projection reader probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-runner-subprocess-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pinnedWorktree = await makeEphemeralPinnedWorktree(
    WORKTREE,
    join(root, "pinned-worktree"),
  );
  const rawRoot = join(root, "raw");
  const isolationRoots = {
    state: join(root, "state"),
    authority: join(root, "authority"),
    backup: join(root, "backup"),
    repository: join(root, "repository"),
    drovr: join(root, "drovr"),
  };
  const runner = join(WORKTREE, "config/flow/scripts/run-host-recovery-qualification.mjs");
  const { stdout } = await execFile(process.execPath, [
    runner,
    "--worktree", pinnedWorktree,
    "--raw-root", rawRoot,
    "--scenario", "projection_rebuild_readers",
    "--run-id", "run:issue-46-runner-subprocess",
    "--xdg-state-home", isolationRoots.state,
    "--authority-directory", isolationRoots.authority,
    "--socket", join(isolationRoots.authority, "owner.sock"),
    "--endpoint", join(isolationRoots.authority, "owner.json"),
    "--backup-directory", isolationRoots.backup,
    "--repository-root", isolationRoots.repository,
    "--drovr-config-directory", isolationRoots.drovr,
    "--herdr-session", "herdr:issue-46-runner-subprocess",
    "--timeout", "30000",
  ], { cwd: WORKTREE, maxBuffer: 2 * 1024 * 1024 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.schema, "flow.host-recovery-raw-receipt/v1");
  assert.equal(summary.status, "pass", JSON.stringify(summary));
  assert.equal(summary.scenario_id, "projection_rebuild_readers");
  assert.equal(summary.commands, 1);

  const receipt = await readRawQualificationReceipt(summary.receipt_path, { rawRoot });
  assert.equal(receipt.result.disposition, "pass", JSON.stringify(receipt.result));
  assert.deepEqual(receipt.commands.map(({ command_kind }) => command_kind), [
    "native_projection_reader_probe",
  ]);
  assert.deepEqual(receipt.observations.map(({ kind }) => kind), [
    "query", "watch", "rebuild", "views", "latency",
  ]);
  assert.equal(receipt.cleanup.disposition, "complete");
  assert.deepEqual(receipt.cleanup.unresolved_obligations, []);
  assert.equal(receipt.receipt_sha256, summary.receipt_sha256);
  assert.equal(rawRoot.startsWith(tmpdir()), true);
  for (const path of Object.values(isolationRoots)) {
    assert.equal(await pathExists(path), false, `isolated root remains: ${path}`);
  }
});

async function makeEphemeralPinnedWorktree(source, destination) {
  await execFile("git", ["clone", "--quiet", source, destination], {
    cwd: source,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { stdout } = await execFile("git", [
    "-C", source, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], { maxBuffer: 64 * 1024 * 1024 });
  for (const path of stdout.split("\0").filter(Boolean)) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, path), target, { recursive: true, force: true });
  }
  await execFile("git", ["-C", destination, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", destination, "config", "user.name", "Flow Qualification"]);
  await execFile(process.execPath, [
    join(destination, "config/flow/scripts/generate-release-content.mjs"),
  ], {
    cwd: destination,
    maxBuffer: 4 * 1024 * 1024,
  });
  await bindEphemeralIssue46Aggregate(destination);
  await execFile("git", ["-C", destination, "add", "-A"], { maxBuffer: 4 * 1024 * 1024 });
  await execFile("git", ["-C", destination, "commit", "--quiet", "-m", "ephemeral issue-46 implementation"]);
  return destination;
}

async function bindEphemeralIssue46Aggregate(worktree) {
  const aggregatePath = join(worktree, "config/flow/evidence/host-recovery-qualification.v1.json");
  const ledgerPath = join(worktree, "config/flow/transition-ledger.v1.json");
  const aggregate = JSON.parse(await readFile(aggregatePath, "utf8"));
  const release = derivePinnedReleaseIdentity({ worktreeRoot: worktree });
  aggregate.release = release;
  const pinnedTools = resolvePinnedQualificationTools({ worktreeRoot: worktree });
  aggregate.tools = {
    ...pinnedTools,
    herdr: aggregate.tools?.herdr ?? {
      path_ref: "external/herdr/not-required",
      version: "not_required",
      sha256: createHash("sha256").update("herdr-not-required").digest("hex"),
    },
  };
  aggregate.evidence_digest = canonicalDigest({ ...aggregate, evidence_digest: null });
  const aggregateBytes = Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`);
  await writeFile(aggregatePath, aggregateBytes);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const record = ledger.evidence.find(({ id }) => id === "issue_46_host_recovery");
  record.path = "evidence/host-recovery-qualification.v1.json";
  record.sha256 = createHash("sha256").update(aggregateBytes).digest("hex");
  record.evidence_digest = aggregate.evidence_digest;
  record.status = aggregate.status;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function makeWorkingTreeCopy(source, destination) {
  await execFile("git", ["clone", "--quiet", source, destination], {
    cwd: source,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { stdout } = await execFile("git", [
    "-C", source, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], { maxBuffer: 64 * 1024 * 1024 });
  for (const path of stdout.split("\0").filter(Boolean)) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, path), target, { recursive: true, force: true });
  }
  return destination;
}

async function makePinnedDirtyWorktree(source, destination) {
  await makeWorkingTreeCopy(source, destination);
  await cp(
    join(source, "config/flow/node_modules"),
    join(destination, "config/flow/node_modules"),
    { recursive: true, force: true },
  );
  await cp(
    join(source, "tools/flow/node_modules"),
    join(destination, "tools/flow/node_modules"),
    { recursive: true, force: true },
  );
  await execFile(process.execPath, [
    join(destination, "config/flow/scripts/generate-release-content.mjs"),
  ], {
    cwd: destination,
    maxBuffer: 4 * 1024 * 1024,
  });
  return destination;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
