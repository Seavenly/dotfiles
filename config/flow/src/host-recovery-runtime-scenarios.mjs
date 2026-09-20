import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  HOST_RECOVERY_SCENARIOS,
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  cleanupQualificationIsolation,
  isolatedQualificationEnvironment,
  qualificationIsolationIdentity,
  validateRawQualificationReceipt,
  runPinnedPublicCommand,
} from "./host-recovery-qualification.mjs";

export const HOST_RECOVERY_RUNTIME_SCENARIO_SCHEMA =
  "flow.host-recovery-runtime-scenario/v1";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const ABORT_SETTLEMENT_TIMEOUT_MS = 2_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SCENARIO_DEFINITIONS = new Map(
  HOST_RECOVERY_SCENARIOS.map((definition) => [definition.id, definition]),
);
const OWNED_RESOURCE_REFS = Object.freeze([
  "isolation/qualification-workspace",
  "isolation/state",
  "isolation/authority",
  "isolation/backup",
  "isolation/repository",
  "isolation/drovr-config",
]);
const RESTORE_EVIDENCE_DOMAINS = Object.freeze([
  "database_streams",
  "artifact_state",
  "git_state",
  "filesystem_state",
  "external_effects",
  "drovr_obligations",
]);
const PROJECTION_SCHEMAS = new Set([
  "flow.owner-status/v1",
  "flow.runtime-runner-status/v1",
  "flow.run-index-projection/v1",
  "flow.run-projection/v1",
  "flow.review-inbox-projection/v1",
  "flow.backup-projection/v1",
  "flow.restore-barrier-projection/v1",
  "flow.rejection/v1",
  "flow.watch-observation/v1",
  "flow.prepared-run/v1",
  "flow.launch-receipt/v1",
  "flow.command-receipt/v1",
]);

export class HostRecoveryScenarioError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HostRecoveryScenarioError";
    this.code = code;
  }
}

/**
 * Bind one driver's immutable scenario result to the raw-receipt envelope.
 * The caller must supply observed release, host, and tool identities; the
 * driver never invents those identities.  The returned value is immediately
 * accepted by validateRawQualificationReceipt (and by writeRaw... after the
 * referenced raw files are present).
 */
export function buildHostRecoveryRawReceipt({
  scenarioResult,
  release,
  host,
  tools,
  isolation,
  rawRoot = undefined,
  runId = isolation?.run_id,
  validate = true,
} = {}) {
  if (!isRecord(scenarioResult) ||
      scenarioResult.schema !== HOST_RECOVERY_RUNTIME_SCENARIO_SCHEMA ||
      !isRecord(isolation) || typeof runId !== "string") {
    throw new HostRecoveryScenarioError(
      "scenario_result_invalid",
      "a driver result, isolation, and explicit run ID are required",
    );
  }
  const receipt = {
    schema: "flow.host-recovery-raw-receipt/v1",
    version: 1,
    issue: 46,
    run_id: runId,
    scenario_id: scenarioResult.scenario_id,
    execution_kind: scenarioResult.execution_kind,
    release,
    host,
    tools,
    isolation: isolationReferences(isolation),
    commands: scenarioResult.commands,
    observations: scenarioResult.observations,
    captures: scenarioResult.captures,
    assertions: scenarioResult.assertions,
    retained_obligations: scenarioResult.retained_obligations,
    cleanup: scenarioResult.cleanup,
    result: {
      disposition: scenarioResult.result.disposition,
      reason: scenarioResult.result.reason ?? null,
    },
    started_at: scenarioResult.started_at,
    finished_at: scenarioResult.finished_at,
  };
  if (validate) {
    if (typeof rawRoot !== "string" || !isAbsolute(rawRoot)) {
      throw new HostRecoveryScenarioError(
        "raw_root_required",
        "raw receipt validation requires the external raw root containing logs and captures",
      );
    }
    validateRawQualificationReceipt(receipt, { rawRoot });
  }
  return receipt;
}

export const createHostRecoveryRawReceipt = buildHostRecoveryRawReceipt;

/**
 * Run the public-process portion of the concurrent owner/restart proof.
 *
 * The command runner is deliberately injected at the public launcher seam.
 * Production callers use runPinnedPublicCommand; tests may replay captured
 * public responses.  A response only becomes proof after its schema,
 * watermark, action identities, and scenario-specific facts are checked.
 */
export async function runConcurrentRunsOwnerRestart(options = {}) {
  const context = createScenarioContext(
    options,
    "concurrent_runs_owner_restart",
  );
  const startedAt = now();
  const commands = [];
  const captures = [];
  const outputs = [];
  let disposition = "blocked";
  let reason = null;
  try {
    const dependency = validateNativeDelegateObservation(options.nativeDelegate);
    if (!dependency.ok) {
      reason = dependency.reason;
      return finishScenario(context, {
        commands,
        captures,
        observations: [],
        assertions: [],
        retainedObligations: [{
          code: reason,
          detail: dependency.detail,
        }],
        disposition,
        reason,
        startedAt,
      });
    }

    for (const spec of concurrentCommandPlan(options)) {
      const invocation = await invokePublicCommand(context, spec);
      commands.push(invocation.command);
      outputs.push(invocation.output);
      captures.push(await retainCapture(context, invocation, {
        kind: `public_${spec.kind}`,
        provenance: "public_process",
      }));
    }
    const observations = [
      makeObservation("capacity", findProof(outputs, "capacity"), outputs, "query"),
      makeObservation("client_exit", findProof(outputs, "client_exit"), outputs, "status"),
      makeObservation("owner_restart", findProof(outputs, "owner_restart"), outputs, "watch"),
      makeObservation("effect", findProof(outputs, "effect"), outputs, "query"),
    ];
    for (const output of outputs) validatePublicOutput(output);
    validateConcurrentFacts(observations, options);
    const assertions = assertionsFor(
      "concurrent_runs_owner_restart",
      observations,
    );
    const commandIssue = commandSemanticsIssue(commands);
    if (commandIssue !== null) {
      reason = commandIssue;
    } else if (assertions.some(({ disposition: value }) => value !== "pass")) {
      reason = "concurrent_owner_restart_proof_incomplete";
    } else {
      disposition = "pass";
    }
    return finishScenario(context, {
      commands,
      captures,
      observations,
      assertions,
      retainedObligations: disposition === "pass"
        ? []
        : [{ code: reason ?? "concurrent_owner_restart_failed" }],
      disposition,
      reason,
      startedAt,
    });
  } catch (error) {
    reason = error?.code === "scenario_timeout"
      ? "bounded_timeout"
      : error?.code ?? "public_process_unavailable";
    return finishScenario(context, {
      commands,
      captures,
      observations: [],
      assertions: [],
      retainedObligations: [{ code: reason, detail: safeMessage(error) }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
}

/** Scenario 1 alias retained for callers that address catalog entries by number. */
export const runScenario1ConcurrentRunsOwnerRestart = runConcurrentRunsOwnerRestart;
export const runScenario1 = runConcurrentRunsOwnerRestart;

function concurrentCommandPlan(options) {
  return [
    {
      kind: "start",
      args: ["start", "--json"],
      expectation: options.commandExpectations?.start,
    },
    {
      kind: "status",
      args: ["status", "--json"],
      expectation: options.commandExpectations?.status,
    },
    {
      kind: "query",
      args: [
        "query",
        "--input",
        JSON.stringify({
          schema: "flow.query/v1",
          query: "autonomous_runner_status",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.query,
    },
    {
      kind: "watch",
      args: [
        "watch",
        "--input",
        JSON.stringify({
          schema: "flow.watch/v1",
          query: "review_inbox",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.watch,
    },
  ];
}

function validateConcurrentFacts(observations, options) {
  const byKind = new Map(observations.map((observation) => [observation.kind, observation.content]));
  const capacity = byKind.get("capacity");
  if (capacity?.bounded_capacity === true) {
    if (!Number.isSafeInteger(capacity.capacity) || capacity.capacity < 1 ||
        !Array.isArray(capacity.run_ids) || capacity.run_ids.length < 2 ||
        new Set(capacity.run_ids).size !== capacity.run_ids.length ||
        capacity.run_ids.some((runId) => typeof runId !== "string")) {
      capacity.bounded_capacity = false;
    }
    if (Number.isSafeInteger(capacity.active_runs) &&
        Number.isSafeInteger(capacity.capacity) &&
        capacity.active_runs > capacity.capacity) {
      capacity.bounded_capacity = false;
    }
  }
  if (capacity?.slow_delegate !== true) {
    capacity.bounded_capacity = false;
  }
  const restart = byKind.get("owner_restart");
  if (restart?.same_boot_restart === true &&
      (restart.owner_killed !== true ||
       ![restart.termination_signal, restart.signal, restart.owner_signal,
         restart.kill_signal].includes("SIGKILL") ||
       typeof restart.before_boot_id !== "string" ||
       restart.before_boot_id.length === 0 ||
       restart.before_boot_id !== restart.after_boot_id ||
       typeof restart.before_process_identity !== "string" ||
       typeof restart.after_process_identity !== "string" ||
       restart.before_process_identity === restart.after_process_identity)) {
    restart.same_boot_restart = false;
  }
  const effect = byKind.get("effect");
  if (effect?.duplicate_effect === false &&
      (effect.manual_driver === true || effect.invocation_count !== 1 ||
       typeof effect.effect_id !== "string" || effect.effect_id.length === 0)) {
    effect.duplicate_effect = true;
  }
}

/**
 * Exercise the public prepare/launch/command/query route and retain typed
 * failure and one-shot uncertainty evidence.  Negative actions are carried
 * inside the structured proof envelope with their expected process semantics;
 * they are never downgraded to a pass from an exit code alone.
 */
export async function runActionableFailureRecovery(options = {}) {
  const context = createScenarioContext(options, "actionable_failure_recovery");
  const startedAt = now();
  const commands = [];
  const captures = [];
  const outputs = [];
  let reason = null;
  try {
    const dependency = validateNativeDelegateObservation(options.nativeDelegate);
    if (!dependency.ok) {
      reason = dependency.reason;
      return finishScenario(context, {
        commands,
        captures,
        observations: [],
        assertions: [],
        retainedObligations: [{ code: reason, detail: dependency.detail }],
        disposition: "blocked",
        reason,
        startedAt,
      });
    }
    for (const spec of failureCommandPlan(options)) {
      const invocation = await invokePublicCommand(context, spec);
      commands.push(invocation.command);
      outputs.push(invocation.output);
      captures.push(await retainCapture(context, invocation, {
        kind: `public_${spec.kind}`,
        provenance: "public_process",
      }));
    }
    for (const output of outputs) validatePublicOutput(output, {
      allowRejection: true,
    });
    const observations = [
      makeObservation("failure", findProof(outputs, "failure"), outputs, "command"),
      makeObservation("uncertainty", findProof(outputs, "uncertainty"), outputs, "query"),
    ];
    validateFailureFacts(observations);
    const assertions = assertionsFor("actionable_failure_recovery", observations);
    const commandIssue = commandSemanticsIssue(commands);
    if (commandIssue !== null) {
      reason = commandIssue;
    } else if (assertions.some(({ disposition }) => disposition !== "pass")) {
      reason = "failure_recovery_proof_incomplete";
    } else {
      return finishScenario(context, {
        commands,
        captures,
        observations,
        assertions,
        retainedObligations: [],
        disposition: "pass",
        reason: null,
        startedAt,
      });
    }
    return finishScenario(context, {
      commands,
      captures,
      observations,
      assertions,
      retainedObligations: [{ code: reason }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  } catch (error) {
    reason = error?.code === "scenario_timeout"
      ? "bounded_timeout"
      : error?.code ?? "public_process_unavailable";
    return finishScenario(context, {
      commands,
      captures,
      observations: [],
      assertions: [],
      retainedObligations: [{ code: reason, detail: safeMessage(error) }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
}

export const runScenario2ActionableFailureRecovery = runActionableFailureRecovery;
export const runScenario2 = runActionableFailureRecovery;

function failureCommandPlan(options) {
  const requests = options.requests ?? {};
  return [
    {
      kind: "prepare",
      args: [
        "prepare", "--input",
        JSON.stringify(requests.prepare ?? defaultPrepareRequest(options)),
        "--json",
      ],
      expectation: options.commandExpectations?.prepare,
    },
    {
      kind: "launch",
      args: [
        "launch", "--input",
        JSON.stringify(requests.launch ?? defaultLaunchRequest(options)),
        "--json",
      ],
      expectation: options.commandExpectations?.launch,
    },
    {
      kind: "command",
      args: [
        "command", "--input",
        JSON.stringify(requests.command ?? defaultCommandRequest(options)),
        "--json",
      ],
      expectation: options.commandExpectations?.command,
    },
    {
      kind: "query",
      args: [
        "query", "--input",
        JSON.stringify(requests.query ?? {
          schema: "flow.query/v1",
          query: "autonomous_runner_status",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.query,
    },
  ];
}

function defaultPrepareRequest(options) {
  return {
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:issue-46-failure-recovery",
      summary: "Issue 46 failure recovery qualification",
      acceptance: ["typed failures remain actionable"],
    },
    repository: { path: options.isolation.repository_root },
  };
}

function defaultLaunchRequest() {
  return {
    schema: "flow.launch-request/v1",
    prepared: { bundle_digest: `sha256:${"0".repeat(64)}` },
    confirmation: { decision: "accept" },
  };
}

function defaultCommandRequest() {
  return {
    schema: "flow.command/v1",
    type: "cancel",
    run_id: "run:issue-46-failure",
    expected_watermark: `sha256:${"0".repeat(64)}`,
  };
}

function validateFailureFacts(observations) {
  const failure = observations.find(({ kind }) => kind === "failure")?.content;
  const uncertainty = observations.find(({ kind }) => kind === "uncertainty")?.content;
  if (isRecord(failure)) {
    const required = [
      "typed_failure", "cancellation", "deadline", "capped_recovery",
      "provider_outage", "invalid_output",
    ];
    if (required.some((field) => failure[field] !== true)) failure.typed_failure = false;
    if (!Array.isArray(failure.failure_codes) ||
        failure.failure_codes.some((code) => typeof code !== "string" || code.length === 0)) {
      failure.typed_failure = false;
    }
    const invocationCounts = failure.invocation_counts;
    if (!isRecord(invocationCounts) ||
        ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
          .some((name) => !Number.isSafeInteger(invocationCounts[name]) ||
            invocationCounts[name] < 1)) {
      failure.typed_failure = false;
    }
    if (!Array.isArray(failure.legal_actions) || failure.legal_actions.length === 0) {
      failure.typed_failure = false;
    }
    const actionableFailures = failure.actionable_failures;
    if (!isRecord(actionableFailures) ||
        ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
          .some((name) => !isRecord(actionableFailures[name]) ||
            actionableFailures[name].observed !== true ||
            typeof actionableFailures[name].operator_response !== "string" ||
            actionableFailures[name].operator_response.length === 0 ||
            !Array.isArray(actionableFailures[name].legal_actions))) {
      failure.typed_failure = false;
    }
    validateProofActions(failure);
    if (failure.action_identity_valid === false) failure.typed_failure = false;
    validateExpectedNegativeCommands(failure);
  }
  if (isRecord(uncertainty)) {
    if (uncertainty.one_shot !== true || uncertainty.duplicate_effect !== false ||
        uncertainty.manual_driver === true || uncertainty.invocation_count !== 1 ||
        typeof uncertainty.effect_id !== "string" || uncertainty.effect_id.length === 0) {
      uncertainty.one_shot = false;
    }
    if (!Array.isArray(uncertainty.legal_actions) || uncertainty.legal_actions.length === 0) {
      uncertainty.one_shot = false;
    }
    validateProofActions(uncertainty);
    if (uncertainty.action_identity_valid === false) uncertainty.one_shot = false;
  }
}

function validateProofActions(proof) {
  if (!Array.isArray(proof.legal_actions)) return;
  if (proof.legal_actions.length === 0) return;
  const watermark = proof.watermark ?? proof.authority_watermark;
  if (typeof watermark !== "string" || watermark.length === 0) {
    proof.legal_actions = [];
    proof.action_identity_valid = false;
    return;
  }
  try {
    validateActionIdentities({
      watermark,
      legal_actions: proof.legal_actions,
    });
  } catch {
    proof.legal_actions = [];
    proof.action_identity_valid = false;
  }
}

function validateExpectedNegativeCommands(proof) {
  if (!Array.isArray(proof.expected_negative_commands) ||
      proof.expected_negative_commands.some((command) =>
        !isRecord(command) || typeof command.action !== "string" ||
        !Number.isInteger(command.expected_exit_code) ||
        ![null, "SIGTERM", "SIGKILL", "SIGINT"].includes(command.expected_signal ?? null) ||
        typeof command.expected_timed_out !== "boolean")) {
    proof.typed_failure = false;
  }
}

/**
 * Drive the production backup/restore route.  The provider attestation is a
 * separate input because a public command receipt alone cannot prove that a
 * snapshot was written by the production provider.
 */
export async function runBackupRestoreReconciliation(options = {}) {
  const context = createScenarioContext(options, "backup_restore_reconciliation");
  const startedAt = now();
  if (options.nativeBackupRestoreProbe === undefined) {
    const reason = "native_backup_restore_probe_required";
    return finishScenario(context, {
      commands: [],
      captures: [],
      observations: [],
      assertions: [],
      retainedObligations: [{
        code: reason,
        detail: "scenario 3 requires the pinned native backup/restore subprocess probe",
      }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
  return runNativeBackupRestoreProbe(context, {
    probe: options.nativeBackupRestoreProbe,
    startedAt,
  });
}

async function runNativeBackupRestoreProbe(context, { probe, startedAt }) {
  const commands = [];
  const captures = [];
  let reason = null;
  try {
    const invocation = normalizeNativeBackupRestoreProbe(probe);
    commands.push(invocation.command);
    captures.push(await retainCapture(context, invocation, {
      kind: "native_backup_restore_probe",
      provenance: "native_provider",
    }));
    const output = invocation.output;
    const providerResult = validateBackupProviderObservation(output.provider);
    const proof = isRecord(output.proof) ? output.proof : {};
    const observations = [
      makeObservation("backup", proof.backup, [output], "native_backup_restore_probe"),
      makeObservation("loss", proof.loss, [output], "native_backup_restore_probe"),
      makeObservation("restore", proof.restore, [output], "native_backup_restore_probe"),
      makeObservation("reconciliation", proof.reconciliation, [output], "native_backup_restore_probe"),
      makeObservation("drovr_status", proof.drovr_status, [output], "native_backup_restore_probe"),
      makeObservation("admission", proof.admission, [output], "native_backup_restore_probe"),
    ];
    if (providerResult.ok) validateBackupFacts(observations, providerResult.value);
    const assertions = assertionsFor("backup_restore_reconciliation", observations);
    const commandIssue = commandSemanticsIssue(commands);
    if (!providerResult.ok) {
      reason = providerResult.reason;
    } else if (output.status !== "pass") {
      reason = output.reason ?? "native_backup_restore_probe_blocked";
    } else if (commandIssue !== null) {
      reason = commandIssue;
    } else if (assertions.some(({ disposition }) => disposition !== "pass")) {
      reason = "backup_restore_reconciliation_proof_incomplete";
    }
    const disposition = reason === null ? "pass" : "blocked";
    return finishScenario(context, {
      commands,
      captures,
      observations,
      assertions,
      retainedObligations: disposition === "pass" ? [] : [{ code: reason }],
      disposition,
      reason,
      startedAt,
    });
  } catch (error) {
    reason = error?.code === "scenario_timeout"
      ? "bounded_timeout"
      : error?.code ?? "native_backup_restore_probe_unavailable";
    return finishScenario(context, {
      commands,
      captures,
      observations: [],
      assertions: [],
      retainedObligations: [{ code: reason, detail: safeMessage(error) }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
}

function normalizeNativeBackupRestoreProbe(value) {
  const command = value?.command ?? value?.invocation;
  const output = value?.output ?? value?.probe ?? value?.result;
  if (!isRecord(command) || command.command_kind !== "native_backup_restore_probe" ||
      typeof command.id !== "string" || command.id.length === 0 ||
      !isRecord(output) || output.schema !== "flow.production-backup-live-observation/v1" ||
      !["pass", "blocked"].includes(output.status)) {
    throw new HostRecoveryScenarioError(
      "native_backup_restore_probe_invalid",
      "scenario 3 requires the exact schema-bound native backup/restore probe record",
    );
  }
  return { command: structuredClone(command), output: structuredClone(output) };
}

export const runScenario3BackupRestoreReconciliation = runBackupRestoreReconciliation;
export const runScenario3 = runBackupRestoreReconciliation;

function backupCommandPlan(options) {
  const requests = options.requests ?? {};
  return [
    {
      kind: "command",
      args: [
        "command", "--input",
        JSON.stringify(requests.command ?? {
          schema: "flow.command/v1",
          type: "backup_create",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.command,
    },
    {
      kind: "query",
      args: [
        "query", "--input",
        JSON.stringify(requests.query ?? {}),
        "--json",
      ],
      expectation: options.commandExpectations?.query,
    },
    {
      kind: "watch",
      args: [
        "watch", "--input",
        JSON.stringify(requests.watch ?? {
          schema: "flow.watch/v1",
          host: true,
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.watch,
    },
  ];
}

function validateBackupProviderObservation(observation) {
  if (!isRecord(observation) ||
      observation.schema !== "flow.filesystem-backup/v1" ||
      observation.status !== "available" ||
      typeof observation.provider_identity !== "string" ||
      observation.provider_identity.length === 0 ||
      !isDigest(observation.watermark) ||
      !isDigest(observation.manifest_digest) ||
      !isDigest(observation.snapshot_digest) ||
      typeof observation.backup_id !== "string") {
    return {
      ok: false,
      reason: "backup_provider_unavailable",
      detail: "production backup requires an available provider identity, watermark, manifest, and snapshot",
    };
  }
  return { ok: true, value: observation };
}

function validateBackupFacts(observations, provider) {
  const byKind = new Map(observations.map(({ kind, content }) => [kind, content]));
  const backup = byKind.get("backup");
  if (isRecord(backup)) {
    if (backup.production_backup !== true || backup.provider !== "flow.filesystem-backup/v1" ||
        backup.manifest_digest !== provider.manifest_digest ||
        backup.snapshot_digest !== provider.snapshot_digest ||
        backup.backup_id !== provider.backup_id) {
      backup.production_backup = false;
    }
    validateProofActions(backup);
    if (backup.action_identity_valid === false) backup.production_backup = false;
  }
  const loss = byKind.get("loss");
  if (isRecord(loss) &&
      (loss.destructive_loss !== true || loss.disposable_only !== true ||
       loss.protected_state_intact !== true || !Array.isArray(loss.lost_paths) ||
       loss.lost_paths.length === 0)) {
    loss.destructive_loss = false;
  }
  const restore = byKind.get("restore");
  if (isRecord(restore) &&
      (restore.restored !== true || restore.manifest_digest !== provider.manifest_digest ||
       typeof restore.restore_id !== "string")) {
    restore.restored = false;
  }
  const reconciliation = byKind.get("reconciliation");
  if (isRecord(reconciliation)) {
    const domains = Array.isArray(reconciliation.domains) ? reconciliation.domains : [];
    const names = domains.map(({ domain }) => domain);
    if (reconciliation.domains_reconciled !== 6 || reconciliation.complete !== true ||
        reconciliation.manifest_digest !== provider.manifest_digest ||
        names.length !== RESTORE_EVIDENCE_DOMAINS.length ||
        new Set(names).size !== RESTORE_EVIDENCE_DOMAINS.length ||
        RESTORE_EVIDENCE_DOMAINS.some((domain) =>
          !domains.some((entry) => entry.domain === domain && entry.status === "reconciled"))) {
      reconciliation.domains_reconciled = 0;
    }
  }
  const admission = byKind.get("admission");
  if (isRecord(admission) &&
      (admission.retained_result_admitted !== true ||
       admission.manifest_digest !== provider.manifest_digest ||
       typeof admission.result_digest !== "string" || admission.explicit !== true)) {
    admission.retained_result_admitted = false;
  }
  const drovrStatus = byKind.get("drovr_status");
  if (isRecord(drovrStatus) &&
      (drovrStatus.observed !== true || drovrStatus.command !== "drovr status" ||
       typeof drovrStatus.turn_id !== "string" || drovrStatus.turn_id.length === 0 ||
       drovrStatus.status !== "working" || drovrStatus.provenance !== "public_process" ||
       !isDigest(drovrStatus.output_digest))) {
    drovrStatus.observed = false;
  }
}

/** Read query/watch projections while rebuilding disposable views. */
export async function runProjectionRebuildReaders(options = {}) {
  const context = createScenarioContext(options, "projection_rebuild_readers");
  const startedAt = now();
  const commands = [];
  const captures = [];
  const outputs = [];
  let reason = null;
  try {
    for (const spec of projectionCommandPlan(options)) {
      const invocation = await invokePublicCommand(context, spec);
      commands.push(invocation.command);
      outputs.push(invocation.output);
      captures.push(await retainCapture(context, invocation, {
        kind: `public_${spec.kind}`,
        provenance: "public_process",
      }));
    }
    for (const output of outputs) validatePublicOutput(output);
    const observations = [
      makeObservation("query", findProof(outputs, "query"), outputs, "query"),
      makeObservation("watch", findProof(outputs, "watch"), outputs, "watch"),
      makeObservation("rebuild", findProof(outputs, "rebuild"), outputs, "query"),
      makeObservation("views", findProof(outputs, "views"), outputs, "query"),
      makeObservation("latency", findProof(outputs, "latency"), outputs, "query"),
    ];
    validateProjectionFacts(observations, context.maxLatencyMs ?? 10_000);
    const assertions = assertionsFor("projection_rebuild_readers", observations);
    const commandIssue = commandSemanticsIssue(commands);
    if (commandIssue !== null) {
      reason = commandIssue;
    } else if (assertions.some(({ disposition }) => disposition !== "pass")) {
      reason = "projection_reader_proof_incomplete";
    } else {
      return finishScenario(context, {
        commands,
        captures,
        observations,
        assertions,
        retainedObligations: [],
        disposition: "pass",
        reason: null,
        startedAt,
      });
    }
    return finishScenario(context, {
      commands,
      captures,
      observations,
      assertions,
      retainedObligations: [{ code: reason }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  } catch (error) {
    reason = error?.code === "scenario_timeout"
      ? "bounded_timeout"
      : error?.code ?? "public_process_unavailable";
    return finishScenario(context, {
      commands,
      captures,
      observations: [],
      assertions: [],
      retainedObligations: [{ code: reason, detail: safeMessage(error) }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
}

export const runScenario7ProjectionRebuildReaders = runProjectionRebuildReaders;
export const runScenario7 = runProjectionRebuildReaders;

function projectionCommandPlan(options) {
  const requests = options.requests ?? {};
  return [
    {
      kind: "query",
      args: [
        "query", "--input",
        JSON.stringify(requests.query ?? {
          schema: "flow.query/v1",
          query: "review_inbox",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.query,
    },
    {
      kind: "watch",
      args: [
        "watch", "--input",
        JSON.stringify(requests.watch ?? {
          schema: "flow.watch/v1",
          query: "review_inbox",
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.watch,
    },
  ];
}

function validateProjectionFacts(observations, maxLatencyMs) {
  const byKind = new Map(observations.map(({ kind, content }) => [kind, content]));
  const query = byKind.get("query");
  if (!isRecord(query) || query.observed !== true || typeof query.watermark !== "string") {
    if (isRecord(query)) query.observed = false;
  }
  const watch = byKind.get("watch");
  if (!isRecord(watch) || watch.observed !== true || typeof watch.watermark !== "string") {
    if (isRecord(watch)) watch.observed = false;
  }
  const rebuild = byKind.get("rebuild");
  if (isRecord(rebuild) &&
      (rebuild.without_mutation_lock !== true ||
       rebuild.mutation_lock_acquired !== false ||
       rebuild.projection_identity_stable !== true ||
       !["native_provider", "production_runtime"].includes(rebuild.provenance) ||
       rebuild.owner_mutation_lock?.held !== true ||
       rebuild.owner_mutation_lock?.inspect_runtime_open !== true ||
       !["native_provider", "production_runtime"].includes(
         rebuild.owner_mutation_lock?.provenance,
       ) ||
       !Array.isArray(rebuild.inspect_runtime_lock_observations) ||
       rebuild.inspect_runtime_lock_observations.length < 2 ||
       rebuild.inspect_runtime_lock_observations.some((observation) =>
         observation?.available !== true || observation?.held !== true ||
         !["native_provider", "production_runtime"].includes(observation.provenance)) ||
       rebuild.external_mutation_lock?.available !== true ||
       rebuild.external_mutation_lock?.held !== false ||
       !["native_provider", "production_runtime"].includes(
         rebuild.external_mutation_lock?.provenance,
       ) ||
       rebuild.owner_lock_release_observed !== true ||
       rebuild.owner_authority_watermark?.stable !== true ||
       rebuild.owner_authority_watermark?.delta !== null ||
       !Number.isSafeInteger(rebuild.rebuild_count) || rebuild.rebuild_count < 1)) {
    rebuild.without_mutation_lock = false;
  }
  const views = byKind.get("views");
  if (isRecord(views)) {
    if (!Number.isSafeInteger(views.count) || views.count < 2 ||
        !Array.isArray(views.view_ids) || views.view_ids.length !== views.count ||
        new Set(views.view_ids).size !== views.count ||
        views.view_ids.some((id) => typeof id !== "string" || id.length === 0)) {
      views.count = 0;
    }
  }
  const latency = byKind.get("latency");
  if (isRecord(latency)) {
    if (!Array.isArray(latency.samples) || latency.samples.length < 2 ||
        latency.samples.some((sample) => !Number.isFinite(sample) || sample < 0 || sample > maxLatencyMs) ||
        !Number.isSafeInteger(latency.history_entries) || latency.history_entries < 1) {
      latency.samples = [];
    }
  }
}

/**
 * Observe a suspended run and issue only the projected reboot_admission
 * command.  The boot boundary is simulated by the injected observation; this
 * driver never invokes reboot, shutdown, or a host lifecycle primitive.
 */
export async function runSuspendedRunAdmission(options = {}) {
  const context = createScenarioContext(options, "suspended_run_admission");
  const startedAt = now();
  const commands = [];
  const captures = [];
  const outputs = [];
  let reason = null;
  try {
    for (const spec of suspendedCommandPlan(options)) {
      const invocation = await invokePublicCommand(context, spec);
      commands.push(invocation.command);
      outputs.push(invocation.output);
      captures.push(await retainCapture(context, invocation, {
        kind: `public_${spec.kind}`,
        provenance: "public_process",
      }));
    }
    for (const output of outputs) validatePublicOutput(output);
    const observations = [
      makeObservation("suspended", findProof(outputs, "suspended"), outputs, "query"),
      makeObservation("admission", findProof(outputs, "admission"), outputs, "command"),
      makeObservation("reboot", findProof(outputs, "reboot"), outputs, "watch"),
    ];
    validateSuspendedFacts(observations, options);
    const assertions = assertionsFor("suspended_run_admission", observations);
    const commandIssue = commandSemanticsIssue(commands);
    if (commandIssue !== null) {
      reason = commandIssue;
    } else if (assertions.some(({ disposition }) => disposition !== "pass")) {
      reason = "suspended_admission_proof_incomplete";
    } else {
      return finishScenario(context, {
        commands,
        captures,
        observations,
        assertions,
        retainedObligations: [],
        disposition: "pass",
        reason: null,
        startedAt,
      });
    }
    return finishScenario(context, {
      commands,
      captures,
      observations,
      assertions,
      retainedObligations: [{ code: reason }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  } catch (error) {
    reason = error?.code === "scenario_timeout"
      ? "bounded_timeout"
      : error?.code ?? "public_process_unavailable";
    return finishScenario(context, {
      commands,
      captures,
      observations: [],
      assertions: [],
      retainedObligations: [{ code: reason, detail: safeMessage(error) }],
      disposition: "blocked",
      reason,
      startedAt,
    });
  }
}

export const runScenario8SuspendedRunAdmission = runSuspendedRunAdmission;
export const runScenario8 = runSuspendedRunAdmission;

export const HOST_RECOVERY_RUNTIME_SCENARIO_DRIVERS = Object.freeze({
  concurrent_runs_owner_restart: runConcurrentRunsOwnerRestart,
  actionable_failure_recovery: runActionableFailureRecovery,
  backup_restore_reconciliation: runBackupRestoreReconciliation,
  projection_rebuild_readers: runProjectionRebuildReaders,
  suspended_run_admission: runSuspendedRunAdmission,
});

export async function runHostRecoveryRuntimeScenario(scenarioId, options = {}) {
  const driver = HOST_RECOVERY_RUNTIME_SCENARIO_DRIVERS[scenarioId];
  if (typeof driver !== "function") {
    throw new HostRecoveryScenarioError(
      "scenario_not_implemented",
      `no runtime scenario driver is registered for ${scenarioId ?? ""}`,
    );
  }
  return driver(options);
}

function suspendedCommandPlan(options) {
  const requests = options.requests ?? {};
  const runId = options.runId ?? "run:issue-46-suspended";
  return [
    {
      kind: "query",
      args: [
        "query", "--input",
        JSON.stringify(requests.query ?? { run_id: runId }),
        "--json",
      ],
      expectation: options.commandExpectations?.query,
    },
    {
      kind: "command",
      args: [
        "command", "--input",
        JSON.stringify(requests.command ?? {
          schema: "flow.command/v1",
          type: "reboot_admission",
          run_id: runId,
        }),
        "--json",
      ],
      expectation: options.commandExpectations?.command,
    },
    {
      kind: "watch",
      args: [
        "watch", "--input",
        JSON.stringify(requests.watch ?? { run_id: runId }),
        "--json",
      ],
      expectation: options.commandExpectations?.watch,
    },
  ];
}

function validateSuspendedFacts(observations, options) {
  const byKind = new Map(observations.map(({ kind, content }) => [kind, content]));
  const suspended = byKind.get("suspended");
  if (isRecord(suspended) &&
      (suspended.observed !== true || suspended.admission !== "suspended_after_reboot" ||
       suspended.simulated_boot !== true ||
       typeof suspended.prior_boot_id !== "string" ||
       typeof suspended.current_boot_id !== "string" ||
       suspended.prior_boot_id === suspended.current_boot_id)) {
    suspended.observed = false;
  }
  const admission = byKind.get("admission");
  if (isRecord(admission) &&
      (admission.explicit !== true || admission.command_type !== "reboot_admission" ||
       admission.simulated_boot !== true || typeof admission.action_identity !== "string" ||
       admission.action_identity.length === 0)) {
    admission.explicit = false;
  }
  const reboot = byKind.get("reboot");
  if (isRecord(reboot) &&
      (reboot.actual_reboot !== false || reboot.deferred !== true ||
       reboot.simulated !== true || reboot.boot_identity_observed !== true)) {
    reboot.actual_reboot = true;
  }
  if (options.actualReboot === true) {
    if (isRecord(reboot)) reboot.actual_reboot = true;
  }
}

function createScenarioContext(options, scenarioId) {
  const definition = SCENARIO_DEFINITIONS.get(scenarioId);
  if (!definition) {
    throw new HostRecoveryScenarioError(
      "unknown_scenario",
      `unknown host-recovery scenario: ${scenarioId}`,
    );
  }
  const isolation = options.isolation;
  if (!isRecord(isolation) || typeof isolation.worktree_root !== "string" ||
      !isAbsolute(isolation.worktree_root)) {
    throw new HostRecoveryScenarioError(
      "isolation_required",
      "scenario drivers require the pinned isolation contract",
    );
  }
  if (!isRecord(options.entrypoints) ||
      ["node", "launcher", "host"].some((name) =>
        !isRecord(options.entrypoints[name]) ||
        typeof options.entrypoints[name].path !== "string" ||
        !isAbsolute(options.entrypoints[name].path))) {
    throw new HostRecoveryScenarioError(
      "entrypoints_required",
      "scenario drivers require pinned launcher and host entrypoints",
    );
  }
  if (typeof options.rawRoot !== "string" || !isAbsolute(options.rawRoot)) {
    throw new HostRecoveryScenarioError(
      "raw_root_required",
      "scenario drivers require an absolute external raw root",
    );
  }
  qualificationIsolationIdentity(isolation);
  const rawRoot = assertExternalQualificationRoot(resolve(options.rawRoot), {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  return Object.freeze({
    ...options,
    scenarioId,
    definition,
    rawRoot,
    timeoutMs: boundedTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    cleanupTimeoutMs: boundedTimeout(
      options.cleanupTimeoutMs,
      DEFAULT_CLEANUP_TIMEOUT_MS,
    ),
    commandRunner: options.commandRunner ?? runPinnedPublicCommand,
    runState: { ownerStarted: false, inFlight: 0 },
    commandIds: new Set(),
  });
}

async function finishScenario(context, {
  commands,
  captures,
  observations,
  assertions,
  retainedObligations,
  disposition,
  reason,
  startedAt,
}) {
  const cleanup = await performCleanup(context, retainedObligations);
  const cleanupComplete = cleanup.disposition === "complete" &&
    cleanup.unresolved_obligations.length === 0;
  const effectiveDisposition = disposition === "pass" && !cleanupComplete
    ? "blocked"
    : disposition;
  const effectiveReason = effectiveDisposition === "blocked" &&
      disposition === "pass"
    ? "cleanup_unverified"
    : reason;
  const effectiveObligations = cleanupComplete
    ? retainedObligations
    : [...retainedObligations, ...cleanup.unresolved_obligations];
  for (const observation of observations) {
    observation.content_digest = canonicalDigest(observation.content);
  }
  const definition = context.definition;
  const finishedAt = now();
  const result = {
    schema: "flow.host-recovery-scenario-result/v1",
    disposition: effectiveDisposition,
    reason: effectiveReason ?? null,
  };
  return {
    schema: HOST_RECOVERY_RUNTIME_SCENARIO_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: context.scenarioId,
    execution_kind: definition.execution_kind,
    proof_predicate: definition.proof_predicate,
    proof: {
      predicate: definition.proof_predicate,
      satisfied: effectiveDisposition === "pass",
      observation_kinds: [...definition.required_observation_kinds],
      capture_kinds: [...definition.required_capture_kinds],
    },
    required_command_kinds: [...definition.required_command_kinds],
    required_observation_kinds: [...definition.required_observation_kinds],
    required_capture_kinds: [...definition.required_capture_kinds],
    commands: commands.map((command) => structuredClone(command)),
    observations: observations.map((observation) => structuredClone(observation)),
    captures: captures.map((capture) => structuredClone(capture)),
    assertions: assertions.map((assertion) => structuredClone(assertion)),
    retained_obligations: effectiveObligations.map((obligation) =>
      structuredClone(obligation)),
    cleanup,
    cleanup_inputs: cleanupInputs(context, effectiveObligations),
    result,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function cleanupInputs(context, retainedObligations) {
  return {
    scenario_id: context.scenarioId,
    run_id: context.isolation.run_id,
    isolation_identity: qualificationIsolationIdentity(context.isolation),
    raw_root_ref: "external/raw-root",
    owned_resources: OWNED_RESOURCE_REFS.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
    })),
    retained_obligations: structuredClone(retainedObligations),
  };
}

async function performCleanup(context, retainedObligations) {
  if (context.runState?.inFlight > 0) {
    return blockedCleanup(
      "work_in_flight",
      "cleanup was withheld because an aborted public operation did not acknowledge settlement",
    );
  }
  try {
    await stopOwnedOwner(context, retainedObligations);
    if (typeof context.cleanup === "function") {
      const cleanup = await runTracked(context, (signal) => context.cleanup({
        ...cleanupInputs(context, retainedObligations),
        isolation: context.isolation,
        rawRoot: context.rawRoot,
        scenarioId: context.scenarioId,
        signal,
      }), context.cleanupTimeoutMs, "scenario cleanup");
      return normalizeCleanup(cleanup);
    }
    return normalizeCleanup(cleanupQualificationIsolation(context.isolation));
  } catch (error) {
    return blockedCleanup(error?.code ?? "cleanup_unverified", safeMessage(error));
  }
}

async function runTracked(context, operation, timeoutMs, label) {
  context.runState.inFlight += 1;
  try {
    const value = await withTimeout(operation, timeoutMs, label);
    context.runState.inFlight -= 1;
    return value;
  } catch (error) {
    if (error?.settled !== false) context.runState.inFlight -= 1;
    throw error;
  }
}

async function stopOwnedOwner(context, retainedObligations) {
  if (context.runState?.ownerStarted !== true) return;
  try {
    if (typeof context.stopOwner === "function") {
      await runTracked(context, (signal) => context.stopOwner({
        ...cleanupInputs(context, retainedObligations),
        isolation: context.isolation,
        rawRoot: context.rawRoot,
        scenarioId: context.scenarioId,
        signal,
      }), context.cleanupTimeoutMs, "owner stop");
      return;
    }
    const invocation = await invokePublicCommand(context, {
      kind: "stop",
      args: ["stop", "--json"],
      expectation: context.commandExpectations?.stop,
    });
    const issue = commandSemanticsIssue([invocation.command]);
    if (issue !== null) {
      throw new HostRecoveryScenarioError(issue, "owner stop command exit semantics mismatched");
    }
  } finally {
    context.runState.ownerStarted = false;
  }
}

function normalizeCleanup(cleanup) {
  if (!isRecord(cleanup)) return blockedCleanup("cleanup_unverified");
  const allowed = new Set(OWNED_RESOURCE_REFS);
  const owned = Array.isArray(cleanup.owned_resources)
    ? cleanup.owned_resources.filter(({ identity_ref }) => allowed.has(identity_ref))
    : [];
  const dispositions = Array.isArray(cleanup.resource_dispositions)
    ? cleanup.resource_dispositions.filter(({ identity_ref }) => allowed.has(identity_ref))
    : [];
  const unresolved = Array.isArray(cleanup.unresolved_obligations)
    ? cleanup.unresolved_obligations
    : [{ code: "cleanup_unverified" }];
  return {
    disposition: cleanup.disposition === "complete" && unresolved.length === 0
      ? "complete"
      : cleanup.disposition === "blocked" ? "blocked" : "not_started",
    owned_resources: owned,
    resource_dispositions: dispositions,
    unresolved_obligations: unresolved,
    completed_at: typeof cleanup.completed_at === "string"
      ? cleanup.completed_at
      : null,
  };
}

function blockedCleanup(code, detail = null) {
  return {
    disposition: "blocked",
    owned_resources: OWNED_RESOURCE_REFS.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
    })),
    resource_dispositions: OWNED_RESOURCE_REFS.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
      disposition: "cleanup_blocked",
      proof: "presence_or_removal_unverified",
    })),
    unresolved_obligations: [{ code, ...(detail === null ? {} : { detail }) }],
    completed_at: null,
  };
}

async function invokePublicCommand(context, spec) {
  const commandRunner = context.commandRunner;
  if (typeof commandRunner !== "function") {
    throw new HostRecoveryScenarioError(
      "command_runner_required",
      "scenario drivers require a public command runner",
    );
  }
  const expectation = normalizeExpectation(spec.expectation);
  const request = {
    entrypoints: context.entrypoints,
    isolation: context.isolation,
    args: spec.args,
    logDirectory: join(context.rawRoot, "logs"),
    env: context.env ?? isolatedQualificationEnvironment(
      context.isolation,
      process.env,
    ),
    timeoutMs: context.timeoutMs,
    cwd: context.cwd,
    command_kind: spec.kind,
  };
  let returned;
  try {
    returned = await runTracked(
      context,
      (signal) => commandRunner({ ...request, signal }),
      context.timeoutMs,
      `public command ${spec.kind}`,
    );
  } catch (error) {
    if (error?.code === "scenario_timeout" ||
        error?.code === "scenario_abort_unacknowledged") throw error;
    throw new HostRecoveryScenarioError(
      "public_process_unavailable",
      `${spec.kind} command failed: ${safeMessage(error)}`,
      { cause: error },
    );
  }
  const commandSource = returned?.command ?? returned?.invocation ?? returned;
  if (!isRecord(commandSource) ||
      typeof commandSource.id !== "string" || commandSource.id.length === 0 ||
      commandSource.command_kind !== spec.kind) {
    throw new HostRecoveryScenarioError(
      "command_observation_invalid",
      `${spec.kind} command did not return a pinned invocation record`,
    );
  }
  const command = normalizeCommandRecord(
    commandSource,
    spec,
    context,
    expectation,
    returned,
  );
  if (context.commandIds.has(command.id)) {
    throw new HostRecoveryScenarioError(
      "command_id_duplicate",
      `public command runner reused invocation ID ${command.id}`,
    );
  }
  context.commandIds.add(command.id);
  if (spec.kind === "start" && command.exit_code === 0 &&
      command.signal === null && command.timed_out === false) {
    context.runState.ownerStarted = true;
  }
  const output = parseCommandOutput(returned, command, context.rawRoot);
  // A command can report a typed rejection and still be an expected negative
  // probe. That fact is retained in the command record; it never becomes a
  // pass merely because the process returned a number.
  if (output !== null) validatePublicOutput(output, {
    allowRejection: expectation.exitCode !== 0 || expectation.signal !== null,
  });
  return { command, output };
}

function normalizeCommandRecord(raw, spec, context, expectation, returned) {
  const source = isRecord(raw) && isRecord(raw.command) ? raw.command : raw;
  const startedAt = source?.started_at ?? now();
  const finishedAt = source?.finished_at ?? startedAt;
  const id = typeof source?.id === "string" && source.id.length > 0
    ? source.id
    : `${spec.kind}-${randomUUID()}`;
  const command = {
    ...(isRecord(source) ? source : {}),
    id,
    argv: Array.isArray(source?.argv) && source.argv.every((arg) => typeof arg === "string")
      ? source.argv
      : ["node", "config/flow/src/cli.mjs", ...spec.args],
    command_kind: spec.kind,
    launcher_ref: typeof source?.launcher_ref === "string"
      ? source.launcher_ref
      : "config/flow/src/cli.mjs",
    working_directory_ref: typeof source?.working_directory_ref === "string"
      ? source.working_directory_ref
      : "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Number.isSafeInteger(source?.duration_ms)
      ? source.duration_ms
      : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(source?.exit_code) ? source.exit_code : 0,
    signal: source?.signal ?? null,
    expected_exit_code: expectation.exitCode,
    expected_signal: expectation.signal,
    expected_timed_out: expectation.timedOut,
    timed_out: source?.timed_out === true,
  };
  command.logs = normalizeCommandLogs(
    source?.logs,
    returned,
    command,
    context,
  );
  return command;
}

function normalizeCommandLogs(logs, returned, command, context) {
  const output = typeof returned?.stdout === "string" ? returned.stdout : "";
  const error = typeof returned?.stderr === "string" ? returned.stderr : "";
  return {
    stdout: normalizeLog(logs?.stdout, output, command, context, "stdout"),
    stderr: normalizeLog(logs?.stderr, error, command, context, "stderr"),
  };
}

function normalizeLog(log, fallback, command, context, stream) {
  let text = fallback;
  let path = typeof log?.path === "string" ? log.path : null;
  if (path !== null) {
    const candidates = [
      isAbsolute(path) ? path : join(context.rawRoot, path),
      join(context.rawRoot, "logs", path),
    ];
    const existing = candidates.find((candidate) => existsSync(candidate));
    if (existing !== undefined) {
      text = readFileSync(existing, "utf8");
      path = relative(context.rawRoot, existing);
    } else {
      path = null;
    }
  }
  if (path === null && text.length > 0) {
    const relativePath = join(
      "logs",
      `${command.id}.${stream}.log`,
    );
    const destination = join(context.rawRoot, relativePath);
    mkdirSync(join(context.rawRoot, "logs"), { recursive: true, mode: 0o700 });
    if (!existsSync(destination)) {
      writeFileSync(destination, text, { flag: "wx", mode: 0o600 });
      chmodSync(destination, 0o600);
    }
    path = relativePath;
  }
  const bytes = Buffer.byteLength(text);
  return {
    path,
    sha256: sha256(Buffer.from(text)),
    bytes,
  };
}

function parseCommandOutput(returned, command, rawRoot) {
  if (typeof returned?.stdout === "string") return parseJsonLines(returned.stdout);
  if (isRecord(returned) && Object.hasOwn(returned, "output")) {
    return typeof returned.output === "string"
      ? parseJsonLines(returned.output)
      : returned.output;
  }
  const path = command.logs.stdout.path;
  if (path === null) return isRecord(returned) && !Object.hasOwn(returned, "command")
    ? returned
    : null;
  try {
    return parseJsonLines(readFileSync(join(rawRoot, path), "utf8"));
  } catch {
    return null;
  }
}

function parseJsonLines(text) {
  const values = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (values.length === 0) return null;
  const parsed = values.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { schema: "flow.unparsed-public-output/v1", text: line };
    }
  });
  return parsed.length === 1 ? parsed[0] : parsed;
}

function validatePublicOutput(output, { allowRejection = false } = {}) {
  const values = Array.isArray(output) ? output : [output];
  if (values.length === 0 || values.some((value) => !isRecord(value))) {
    throw new HostRecoveryScenarioError(
      "public_output_invalid",
      "public command output must contain structured JSON objects",
    );
  }
  for (const value of values) {
    if (typeof value.schema !== "string" || !PROJECTION_SCHEMAS.has(value.schema)) {
      throw new HostRecoveryScenarioError(
        "public_output_schema_invalid",
        `unsupported public output schema: ${value.schema ?? "missing"}`,
      );
    }
    if (value.schema === "flow.rejection/v1") {
      if (!allowRejection) {
        throw new HostRecoveryScenarioError(
          "unexpected_public_rejection",
          "public command returned a rejection where a successful observation was required",
        );
      }
      continue;
    }
    if (value.schema === "flow.prepared-run/v1") {
      if (typeof value.bundle_digest !== "string" ||
          typeof value.plan_fingerprint !== "string") {
        throw new HostRecoveryScenarioError(
          "prepared_identity_invalid",
          "prepared public output lacks bundle and plan identities",
        );
      }
      continue;
    }
    if (value.schema === "flow.launch-receipt/v1") {
      if (typeof value.run_id !== "string" ||
          typeof value.bundle_digest !== "string" ||
          !isDigest(value.authority_watermark)) {
        throw new HostRecoveryScenarioError(
          "launch_identity_invalid",
          "launch public output lacks run and authority identities",
        );
      }
      continue;
    }
    if (value.schema === "flow.command-receipt/v1") {
      if (!isDigest(value.authority_watermark)) {
        throw new HostRecoveryScenarioError(
          "command_watermark_missing",
          "command public output lacks its authority watermark",
        );
      }
      validateActionIdentities(value);
      continue;
    }
    if (value.schema === "flow.owner-status/v1") {
      if (!["running", "starting", "stopped", "stale", "unknown", "invalid"].includes(value.state) ||
          (value.state === "running" && typeof value.process_identity !== "string")) {
        throw new HostRecoveryScenarioError(
          "owner_status_invalid",
          "owner status lacks a bounded state or process identity",
        );
      }
    }
    if (value.schema !== "flow.owner-status/v1") validateWatermark(value);
    validateActionIdentities(value);
  }
  return true;
}

function validateWatermark(value) {
  const watermark = value.watermark ?? value.authority_watermark;
  if (!isDigest(watermark)) {
    throw new HostRecoveryScenarioError(
      "watermark_missing",
      "public observation must carry an authority watermark",
    );
  }
  return watermark;
}

function validateActionIdentities(value) {
  const actions = Array.isArray(value.legal_actions)
    ? value.legal_actions
    : Array.isArray(value.legal_next_actions) ? value.legal_next_actions : [];
  const identities = new Set();
  const watermark = value.watermark ?? value.authority_watermark ?? null;
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== "string" ||
        action.type.length === 0 || typeof action.expected_watermark !== "string" ||
        (watermark !== null && action.expected_watermark !== watermark)) {
      throw new HostRecoveryScenarioError(
        "action_identity_invalid",
        "public legal actions must be typed and bound to the observed watermark",
      );
    }
    const identity = typeof action.action_id === "string"
      ? action.action_id
      : canonicalDigest(action);
    if (identities.has(identity)) {
      throw new HostRecoveryScenarioError(
        "action_identity_duplicate",
        "public legal actions contain duplicate identities",
      );
    }
    identities.add(identity);
  }
  return [...identities];
}

function retainCapture(context, invocation, {
  kind,
  provenance = "public_process",
}) {
  if (!SAFE_COMMAND_ID.test(invocation.command.id)) {
    throw new HostRecoveryScenarioError(
      "command_id_invalid",
      "public command IDs must be safe single-component evidence identifiers",
    );
  }
  const content = redact(invocation.output ?? { observed: false });
  const captureContent = {
    schema: "flow.host-recovery-capture/v1",
    version: 1,
    scenario_id: context.scenarioId,
    command_id: invocation.command.id,
    sequence: `${invocation.command.id}:${kind}`,
    output: content,
  };
  const bytes = Buffer.from(`${JSON.stringify(captureContent, null, 2)}\n`);
  const captureId = `${context.scenarioId}-${kind}-${invocation.command.id}`;
  const path = join("captures", `${captureId}.json`);
  const destination = join(context.rawRoot, path);
  const relativeDestination = relative(context.rawRoot, destination);
  if (relativeDestination === "" || isAbsolute(relativeDestination) ||
      relativeDestination === ".." || relativeDestination.startsWith("../") ||
      relativeDestination.startsWith("..\\")) {
    throw new HostRecoveryScenarioError(
      "capture_path_invalid",
      "capture destination must remain beneath the external raw root",
    );
  }
  ensureCaptureDirectory(join(context.rawRoot, "captures"));
  writeImmutableCapture(destination, bytes);
  return {
    id: captureId,
    kind,
    format: "json",
    path,
    sha256: sha256(bytes),
    legibility: "pass",
    provenance,
    watermark: extractWatermark(invocation.output) ?? "not_observed",
    legal_actions: actionQuality(invocation.output),
  };
}

function ensureCaptureDirectory(directory) {
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HostRecoveryScenarioError(
        "capture_path_invalid",
        "capture directory must be a real directory",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HostRecoveryScenarioError(
        "capture_path_invalid",
        "capture directory was replaced by a non-directory",
      );
    }
  }
}

function writeImmutableCapture(path, bytes) {
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stats;
    try {
      stats = lstatSync(path);
    } catch (statError) {
      throw new HostRecoveryScenarioError(
        "capture_path_invalid",
        `capture target could not be inspected: ${safeMessage(statError)}`,
      );
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new HostRecoveryScenarioError(
        "capture_path_invalid",
        "capture target must be a regular non-symlink file",
      );
    }
    const existing = readFileSync(path);
    if (!existing.equals(bytes)) {
      throw new HostRecoveryScenarioError(
        "capture_immutable_conflict",
        "capture target already contains different evidence bytes",
      );
    }
  }
}

function actionQuality(output) {
  try {
    validateActionIdentities(output);
    return "pass";
  } catch {
    return "not_observed";
  }
}

function makeObservation(kind, proof, outputs, commandKind) {
  const values = flattenOutputs(outputs);
  const source = values.find((output) => output?.proof?.[kind] !== undefined) ??
    values.find((output) => output?.observations?.[kind] !== undefined) ??
    values.find((output) => output?.evidence?.[kind] !== undefined);
  const sourceProof = proof ?? { observed: false, reason: "proof_not_observed" };
  const content = {
    ...(isRecord(sourceProof) ? sourceProof : { observed: false }),
    ...(source?.schema === undefined ? {} : { source_schema: source.schema }),
    ...(extractWatermark(source) === null ? {} : {
      source_watermark: extractWatermark(source),
    }),
    ...(source === undefined ? {} : {
      action_identities: safeActionIdentities(source),
    }),
    source_command_kind: commandKind,
  };
  return {
    id: `${kind}-observation`,
    kind,
    content,
    content_digest: canonicalDigest(content),
  };
}

function assertionsFor(scenarioId, observations) {
  const definition = SCENARIO_DEFINITIONS.get(scenarioId);
  const observationIds = new Map(observations.map(({ kind, id }) => [kind, id]));
  return definition.required_assertion_ids.map((id) => {
    const kind = assertionObservationKind(scenarioId, id);
    const observationId = observationIds.get(kind);
    const observation = observations.find(({ kind: value }) => value === kind);
    return {
      id,
      disposition: proofPasses(scenarioId, id, observation?.content) ? "pass" : "not_observed",
      evidence_refs: observationId === undefined ? [] : [`observation:${observationId}`],
    };
  });
}

function assertionObservationKind(scenarioId, assertionId) {
  const map = {
    concurrent_runs_owner_restart: {
      bounded_capacity: "capacity",
      client_exit: "client_exit",
      same_boot_owner_restart: "owner_restart",
      no_duplicate_effect: "effect",
    },
    actionable_failure_recovery: {
      typed_failure_observations: "failure",
      one_shot_uncertainty_no_duplicate_effect: "uncertainty",
    },
    backup_restore_reconciliation: {
      production_backup: "backup",
      destructive_loss: "loss",
      restore: "restore",
      six_domain_reconciliation: "reconciliation",
      public_drovr_status_observation: "drovr_status",
      retained_result_admission: "admission",
    },
    projection_rebuild_readers: {
      query_projection: "query",
      watch_projection: "watch",
      rebuild_without_mutation_lock: "rebuild",
      multiple_views: "views",
      history_latency_samples: "latency",
    },
    suspended_run_admission: {
      suspended_run_observation: "suspended",
      explicit_admission: "admission",
      actual_reboot_deferred: "reboot",
    },
  };
  return map[scenarioId]?.[assertionId] ?? assertionId;
}

function proofPasses(scenarioId, assertionId, value) {
  if (!isRecord(value)) return false;
  if (scenarioId === "concurrent_runs_owner_restart") {
    if (assertionId === "bounded_capacity") return value.bounded_capacity === true;
    if (assertionId === "client_exit") return value.client_exited === true;
    if (assertionId === "same_boot_owner_restart") return value.same_boot_restart === true;
    if (assertionId === "no_duplicate_effect") return value.duplicate_effect === false;
  }
  if (scenarioId === "actionable_failure_recovery") {
    if (assertionId === "typed_failure_observations") return value.typed_failure === true;
    if (assertionId === "one_shot_uncertainty_no_duplicate_effect") {
      return value.one_shot === true && value.duplicate_effect === false;
    }
  }
  if (scenarioId === "backup_restore_reconciliation") {
    if (assertionId === "production_backup") return value.production_backup === true;
    if (assertionId === "destructive_loss") return value.destructive_loss === true;
    if (assertionId === "restore") return value.restored === true;
    if (assertionId === "six_domain_reconciliation") return value.domains_reconciled === 6;
    if (assertionId === "public_drovr_status_observation") {
      return value.observed === true && value.command === "drovr status" &&
        typeof value.turn_id === "string" && value.turn_id.length > 0 &&
        value.status === "working" && value.provenance === "public_process" &&
        isDigest(value.output_digest);
    }
    if (assertionId === "retained_result_admission") return value.retained_result_admitted === true;
  }
  if (scenarioId === "projection_rebuild_readers") {
    if (assertionId === "query_projection") return value.observed === true;
    if (assertionId === "watch_projection") return value.observed === true;
    if (assertionId === "rebuild_without_mutation_lock") return value.without_mutation_lock === true;
    if (assertionId === "multiple_views") return value.count >= 2;
    if (assertionId === "history_latency_samples") return Array.isArray(value.samples) && value.samples.length >= 2;
  }
  if (scenarioId === "suspended_run_admission") {
    if (assertionId === "suspended_run_observation") return value.observed === true;
    if (assertionId === "explicit_admission") return value.explicit === true;
    if (assertionId === "actual_reboot_deferred") return value.actual_reboot === false && value.deferred === true;
  }
  return false;
}

function findProof(outputs, kind) {
  for (const output of flattenOutputs(outputs)) {
    if (isRecord(output?.proof) && isRecord(output.proof[kind])) return output.proof[kind];
    if (isRecord(output?.observations) && isRecord(output.observations[kind])) return output.observations[kind];
    if (isRecord(output?.evidence) && isRecord(output.evidence[kind])) return output.evidence[kind];
  }
  return null;
}

function flattenOutputs(outputs) {
  return outputs.flatMap((output) => Array.isArray(output) ? output : [output]);
}

function safeActionIdentities(value) {
  try {
    return validateActionIdentities(value);
  } catch {
    return [];
  }
}

function extractWatermark(value) {
  if (!isRecord(value)) return null;
  if (typeof value.watermark === "string") return value.watermark;
  if (typeof value.authority_watermark === "string") return value.authority_watermark;
  return null;
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function validateNativeDelegateObservation(observation) {
  if (!isRecord(observation) ||
      observation.schema !== "flow.native-delegate-observation/v1" ||
      !["available", "ready", "observed"].includes(observation.status) &&
        observation.available !== true ||
      typeof observation.provider_identity !== "string" ||
      observation.provider_identity.length === 0 ||
      !isDigest(observation.watermark) ||
      !Number.isSafeInteger(observation.invocation_count) ||
      observation.invocation_count < 1) {
    return {
      ok: false,
      reason: "native_delegate_unavailable",
      detail: "native delegate execution requires a live provider identity, watermark, and invocation count",
    };
  }
  return { ok: true };
}

function commandSemanticsIssue(commands) {
  for (const command of commands) {
    if (command.expected_exit_code !== command.exit_code ||
        command.expected_signal !== command.signal ||
        command.expected_timed_out !== command.timed_out) {
      return "command_exit_semantics_mismatch";
    }
  }
  return null;
}

function normalizeExpectation(expectation = undefined) {
  const source = expectation ?? {};
  return {
    exitCode: Number.isInteger(source.exitCode) ? source.exitCode : 0,
    signal: source.signal ?? null,
    timedOut: source.timedOut === true,
  };
}

function boundedTimeout(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value <= 300_000
    ? value
    : fallback;
}

async function withTimeout(operation, timeoutMs, label = "operation") {
  const controller = new AbortController();
  const task = typeof operation === "function"
    ? Promise.resolve().then(() => operation(controller.signal))
    : Promise.resolve(operation);
  let settled = false;
  const observed = task.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HostRecoveryScenarioError(
      "scenario_timeout",
      `${label} exceeded ${timeoutMs}ms`,
    )), timeoutMs);
  });
  try {
    return await Promise.race([observed, timeout]);
  } catch (error) {
    if (error?.code !== "scenario_timeout") throw error;
    controller.abort(error);
    const acknowledged = await Promise.race([
      observed.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ABORT_SETTLEMENT_TIMEOUT_MS)),
    ]);
    if (!acknowledged || !settled) {
      const unacknowledged = new HostRecoveryScenarioError(
        "scenario_abort_unacknowledged",
        `${label} did not acknowledge abort and settle within ${ABORT_SETTLEMENT_TIMEOUT_MS}ms`,
      );
      unacknowledged.settled = false;
      throw unacknowledged;
    }
    error.settled = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function redact(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    /(?:token|secret|password|credential|api[_-]?key|authorization)/iu.test(key)
      ? [key, "<redacted>"]
      : [key, redact(child)],
  ]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function safeMessage(error) {
  return typeof error?.message === "string" ? error.message : String(error);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isolationReferences(isolation) {
  if (!isRecord(isolation) || typeof isolation.run_id !== "string") {
    throw new HostRecoveryScenarioError(
      "isolation_invalid",
      "raw receipt construction requires the pinned isolation identity",
    );
  }
  return {
    state_root_ref: "isolation/state",
    authority_root_ref: "isolation/authority",
    socket_ref: "isolation/authority/owner.sock",
    endpoint_ref: "isolation/authority/owner.json",
    backup_root_ref: "isolation/backup",
    repository_root_ref: "isolation/repository",
    drovr_config_root_ref: "isolation/drovr-config",
    herdr_session_ref: `herdr-session/${canonicalDigest(isolation.herdr_session ?? "")}`,
    run_id: isolation.run_id,
    identity_digest: qualificationIsolationIdentity(isolation),
  };
}
