import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  createIssue46LiveSupport,
} from "./host-recovery-live-support.mjs";
import {
  runProjectionRebuildReaderSupport,
  runSuspendedRunAdmissionSupport,
} from "./host-recovery-reader-support.mjs";
import {
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  redactQualificationCapture,
} from "./host-recovery-qualification.mjs";

export const HOST_RECOVERY_READER_INTEGRATION_SCHEMA =
  "flow.host-recovery-reader-integration/v1";
export const HOST_RECOVERY_RUNTIME_SCENARIO_SCHEMA =
  "flow.host-recovery-runtime-scenario/v1";

export const READER_PROBE_COMMAND_KINDS = Object.freeze({
  projection: "native_projection_reader_probe",
  suspended: "native_suspended_admission_check",
});

const SCENARIO_IDS = Object.freeze({
  projection: "projection_rebuild_readers",
  suspended: "suspended_run_admission",
});
const PROOF_PREDICATES = Object.freeze({
  projection: "projection_rebuild_readers",
  suspended: "suspended_run_admission",
});
const PROJECTION_ASSERTIONS = Object.freeze([
  ["query_projection", "query"],
  ["watch_projection", "watch"],
  ["rebuild_without_mutation_lock", "rebuild"],
  ["multiple_views", "views"],
  ["history_latency_samples", "latency"],
]);
const SUSPENDED_ASSERTIONS = Object.freeze([
  ["suspended_run_observation", "suspended"],
  ["explicit_admission", "admission"],
  ["actual_reboot_deferred", "reboot"],
]);
const EXECUTION_KINDS = new Set([
  "live_public_process",
  "native_provider",
  "deterministic_supporting_check",
]);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

export class HostRecoveryReaderIntegrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HostRecoveryReaderIntegrationError";
    this.code = code;
  }
}

/**
 * Execute the projection reader proof inside the bounded native probe.
 *
 * The probe owns the public start/query/watch/stop observations and the
 * production read-only reopen. It deliberately leaves isolation cleanup to
 * the qualification runner, which is the authority that can record cleanup
 * receipts for all owned roots.
 */
export async function runProjectionReaderProbe(options = {}) {
  const context = validateProbeOptions(options, "projection");
  const live = createIssue46LiveSupport({
    entrypoints: context.entrypoints,
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    timeoutMs: context.timeoutMs,
  });
  const support = await runProjectionRebuildReaderSupport({
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    publicCommandRunner: live.commandRunner,
    timeoutMs: context.timeoutMs,
    signal: options.signal,
  });
  return readerProbeEnvelope({
    kind: "projection",
    support,
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    timeoutMs: context.timeoutMs,
  });
}

/**
 * Execute production suspended-run observation and admission with a
 * deterministic host identity/reboot adapter. No host reboot is attempted.
 */
export async function runSuspendedAdmissionProbe(options = {}) {
  const context = validateProbeOptions(options, "suspended");
  const support = await runSuspendedRunAdmissionSupport({
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    timeoutMs: context.timeoutMs,
    oldBootId: options.oldBootId,
    newBootId: options.newBootId,
    actualReboot: options.actualReboot,
    signal: options.signal,
  });
  return readerProbeEnvelope({
    kind: "suspended",
    support,
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    timeoutMs: context.timeoutMs,
  });
}

/** Run the probe selected by its catalog scenario ID or short probe name. */
export async function runReaderProbe(options = {}) {
  const kind = normalizeProbeKind(options.probe ?? options.scenario);
  return kind === "projection"
    ? runProjectionReaderProbe(options)
    : runSuspendedAdmissionProbe(options);
}

/**
 * Adapt a completed projection probe into the runtime scenario shape expected
 * by the raw-receipt validator. The native wrapper command and cleanup proof
 * are intentionally supplied by the outer qualification runner.
 */
export function adaptProjectionReaderProbeResult(options = {}) {
  return adaptReaderProbeResult({ ...options, kind: "projection" });
}

/**
 * Adapt a completed suspended-admission probe into the runtime scenario shape
 * expected by the raw-receipt validator. The reboot observation remains
 * explicitly deterministic and deferred to issue 47.
 */
export function adaptSuspendedAdmissionProbeResult(options = {}) {
  return adaptReaderProbeResult({ ...options, kind: "suspended" });
}

/** Generic adapter for callers that dispatch probes by kind. */
export function adaptReaderProbeResult(options = {}) {
  const kind = normalizeProbeKind(options.kind ?? options.probe ?? options.scenario);
  const support = unwrapSupport(options.support ?? options.probeResult);
  const commandKind = options.commandKind ?? READER_PROBE_COMMAND_KINDS[kind];
  const executionKind = options.executionKind ?? "native_provider";
  const command = options.command;
  const cleanup = options.cleanup;
  const rawRoot = options.rawRoot;
  const isolation = options.isolation;
  const problems = [];

  if (!isRecord(support) || support.schema !== "flow.host-recovery-reader-support/v1") {
    problems.push("reader_support_result_invalid");
  }
  if (!isRecord(command) || command.command_kind !== commandKind) {
    problems.push("native_probe_command_invalid");
  }
  if (!EXECUTION_KINDS.has(executionKind)) problems.push("execution_kind_invalid");
  if (kind === "suspended" && support?.observations?.reboot?.actual_reboot === true) {
    problems.push("actual_reboot_not_allowed");
  }

  const observations = buildObservations(kind, support, problems);
  const capture = buildCapture({
    kind,
    support,
    rawRoot,
    isolation,
    command,
    executionKind,
    problems,
  });
  const commandPass = commandSucceeded(command);
  const cleanupValue = normalizeCleanup(cleanup, problems);
  const cleanupPass = cleanupValue.disposition === "complete" &&
    cleanupValue.unresolved_obligations.length === 0;
  const supportPass = support?.result?.disposition === "pass";
  const proofPass = problems.length === 0 && commandPass && cleanupPass &&
    supportPass && observations.every(({ content }) => content !== null);
  const reason = proofPass
    ? null
    : problems[0] ?? support?.result?.reason ??
      (commandPass ? "reader_probe_proof_incomplete" : "native_probe_command_failed");
  const assertions = buildAssertions(kind, observations, proofPass);
  const retainedObligations = proofPass ? [] : [{ code: reason }];
  const startedAt = validTimestamp(command?.started_at)
    ? command.started_at
    : validTimestamp(support?.started_at)
      ? support.started_at
      : now();
  const finishedAt = validTimestamp(command?.finished_at)
    ? command.finished_at
    : validTimestamp(support?.finished_at)
      ? support.finished_at
      : startedAt;

  return {
    schema: HOST_RECOVERY_RUNTIME_SCENARIO_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: SCENARIO_IDS[kind],
    execution_kind: executionKind,
    proof_predicate: PROOF_PREDICATES[kind],
    proof: {
      predicate: PROOF_PREDICATES[kind],
      satisfied: proofPass,
      observation_kinds: observations.map(({ kind: observationKind }) => observationKind),
      capture_kinds: capture === null ? [] : [capture.kind],
    },
    required_command_kinds: [commandKind],
    required_observation_kinds: observations.map(({ kind: observationKind }) => observationKind),
    required_capture_kinds: capture === null ? [] : [capture.kind],
    commands: isRecord(command) ? [structuredClone(command)] : [],
    observations,
    captures: capture === null ? [] : [capture],
    assertions,
    retained_obligations: retainedObligations,
    cleanup: cleanupValue,
    cleanup_inputs: {
      scenario_id: SCENARIO_IDS[kind],
      run_id: typeof isolation?.run_id === "string" ? isolation.run_id : null,
      retained_obligations: structuredClone(retainedObligations),
    },
    result: {
      schema: "flow.host-recovery-scenario-result/v1",
      disposition: proofPass ? "pass" : "blocked",
      reason,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function readerProbeEnvelope({ kind, support, isolation, rawRoot, timeoutMs }) {
  const scenarioId = SCENARIO_IDS[kind];
  return {
    schema: HOST_RECOVERY_READER_INTEGRATION_SCHEMA,
    version: 1,
    issue: 46,
    probe: kind,
    scenario_id: scenarioId,
    execution_kind: "native_provider",
    command_kind: READER_PROBE_COMMAND_KINDS[kind],
    timeout_ms: timeoutMs,
    provenance: kind === "projection"
      ? {
        start: "public_process",
        query: "public_process",
        watch: "public_process",
        stop: "public_process",
        rebuild: "deterministic_supporting_check",
        history_seed: support.seed?.provenance ?? "none",
      }
      : {
        suspended: "production_runtime",
        admission: "production_runtime",
        boot_identity: "deterministic_supporting_check",
        reboot: "deterministic_supporting_check",
        actual_reboot: false,
        deferred_issue: "47",
      },
    support,
    result: structuredClone(support.result),
    isolation_run_id: isolation.run_id,
    raw_root_ref: "external/raw-root",
  };
}

function buildObservations(kind, support, problems) {
  if (!isRecord(support)) return [];
  if (kind === "projection") {
    const proof = support.proof;
    if (!isRecord(proof)) {
      problems.push("projection_proof_missing");
      return [];
    }
    return PROJECTION_ASSERTIONS.map(([, observationKind]) =>
      observationFromProof(observationKind, proof[observationKind], support));
  }
  const source = support.observations;
  if (!isRecord(source)) {
    problems.push("suspended_observations_missing");
    return [];
  }
  return SUSPENDED_ASSERTIONS.map(([, observationKind]) =>
    observationFromProof(observationKind, source[observationKind], support));
}

function observationFromProof(kind, value, support) {
  const content = isRecord(value)
    ? {
      ...structuredClone(value),
      support_schema: support.schema,
    }
    : {
      observed: false,
      support_schema: support.schema,
    };
  return {
    id: `reader:${kind}`,
    kind,
    content,
    content_digest: canonicalDigest(content),
  };
}

function buildCapture({
  kind,
  support,
  rawRoot,
  isolation,
  command,
  executionKind,
  problems,
}) {
  if (!isRecord(support)) return null;
  if (typeof rawRoot !== "string" || !isAbsolute(rawRoot)) {
    problems.push("raw_root_required_for_capture");
    return null;
  }
  let root;
  try {
    root = assertExternalQualificationRoot(rawRoot, {
      worktreeRoot: isolation?.worktree_root,
      label: "rawRoot",
    });
    assertQualificationPathDisjoint(root, {
      worktreeRoot: isolation?.worktree_root,
      isolation,
      label: "rawRoot",
    });
  } catch (error) {
    problems.push(error?.code ?? "raw_root_invalid");
    return null;
  }
  const captureKind = kind === "projection"
    ? "projection_reader_probe"
    : "suspended_admission_check";
  const captureId = `${captureKind}-${safeIdentity(command?.id ?? kind)}`;
  const content = redactQualificationCapture({
    schema: "flow.host-recovery-reader-capture/v1",
    version: 1,
    scenario_id: SCENARIO_IDS[kind],
    execution_kind: executionKind,
    provenance: kind === "projection"
      ? {
        public_commands: ["start", "query", "watch", "stop"],
        query: "public_process",
        watch: "public_process",
        rebuild: "deterministic_supporting_check",
      }
      : {
        suspended: "production_runtime",
        admission: "production_runtime",
        boot_identity: "deterministic_supporting_check",
        actual_reboot: false,
        deferred_issue: "47",
      },
    support,
  }, {
    pathMappings: {
      worktree: isolation?.worktree_root,
      state: isolation?.xdg_state_home,
      authority: isolation?.authority_directory,
      backup: isolation?.backup_directory,
      repository: isolation?.repository_root,
      drovr: isolation?.drovr_config_directory,
      workspace: isolation?.qualification_workspace,
    },
  });
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  const captureDirectory = join(root, "captures");
  const capturePath = join(captureDirectory, `${captureId}.json`);
  try {
    if (existsSync(captureDirectory)) {
      const directoryStats = lstatSync(captureDirectory);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        problems.push("capture_directory_untrusted");
        return null;
      }
    }
    mkdirSync(captureDirectory, { recursive: true, mode: 0o700 });
    if (existsSync(capturePath)) {
      const stats = lstatSync(capturePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        problems.push("capture_path_untrusted");
        return null;
      }
      const existing = readFileSync(capturePath);
      if (!existing.equals(bytes)) {
        problems.push("capture_immutable_conflict");
        return null;
      }
    } else {
      writeFileSync(capturePath, bytes, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    problems.push(error?.code === "EEXIST"
      ? "capture_immutable_conflict"
      : "capture_write_failed");
    return null;
  }
  const watermark = canonicalDigest(content);
  return {
    id: captureId,
    kind: captureKind,
    format: "json",
    path: `captures/${captureId}.json`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    legibility: "pass",
    provenance: executionKind === "deterministic_supporting_check"
      ? "deterministic_supporting_check"
      : "native_provider",
    watermark,
    legal_actions: support.result?.disposition === "pass" ? "pass" : "not_observed",
  };
}

function buildAssertions(kind, observations, proofPass) {
  const byKind = new Map(observations.map((observation) => [observation.kind, observation]));
  const source = kind === "projection" ? PROJECTION_ASSERTIONS : SUSPENDED_ASSERTIONS;
  return source.map(([id, observationKind]) => {
    const observation = byKind.get(observationKind);
    return {
      id,
      disposition: proofPass ? "pass" : "not_observed",
      evidence_refs: observation === undefined
        ? []
        : [`observation:${observation.id}`],
    };
  });
}

function normalizeCleanup(value, problems) {
  if (!isRecord(value) || !["complete", "blocked", "not_started"].includes(value.disposition) ||
      !Array.isArray(value.owned_resources) || !Array.isArray(value.resource_dispositions) ||
      !Array.isArray(value.unresolved_obligations) ||
      (value.completed_at !== null && typeof value.completed_at !== "string")) {
    problems.push("cleanup_proof_invalid");
    return {
      disposition: "not_started",
      owned_resources: [],
      resource_dispositions: [],
      unresolved_obligations: [{ code: "cleanup_runner_required" }],
      completed_at: null,
    };
  }
  return structuredClone(value);
}

function commandSucceeded(command) {
  return isRecord(command) &&
    Number.isInteger(command.exit_code) && command.exit_code === 0 &&
    command.signal === null && command.timed_out === false &&
    command.expected_exit_code === command.exit_code &&
    command.expected_signal === command.signal &&
    command.expected_timed_out === command.timed_out;
}

function validateProbeOptions(options, kind) {
  const isolation = options.isolation;
  if (!isRecord(isolation) || !isAbsolute(isolation.worktree_root) ||
      !isAbsolute(isolation.authority_directory) || typeof isolation.run_id !== "string") {
    throw new HostRecoveryReaderIntegrationError(
      "isolation_required",
      `${kind} reader probe requires one explicit isolation contract`,
    );
  }
  if (!isRecord(options.entrypoints) || !isRecord(options.entrypoints.node) ||
      !isRecord(options.entrypoints.launcher) || !isRecord(options.entrypoints.host)) {
    throw new HostRecoveryReaderIntegrationError(
      "entrypoints_required",
      `${kind} reader probe requires pinned entrypoints`,
    );
  }
  const rawRoot = assertExternalQualificationRoot(options.rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HostRecoveryReaderIntegrationError(
      "timeout_invalid",
      "reader probe timeout must be between 100 and 300000 milliseconds",
    );
  }
  return Object.freeze({ isolation, rawRoot, timeoutMs, entrypoints: options.entrypoints });
}

function normalizeProbeKind(value) {
  if (value === "projection" || value === SCENARIO_IDS.projection ||
      value === READER_PROBE_COMMAND_KINDS.projection) return "projection";
  if (value === "suspended" || value === SCENARIO_IDS.suspended ||
      value === READER_PROBE_COMMAND_KINDS.suspended) return "suspended";
  throw new HostRecoveryReaderIntegrationError(
    "probe_kind_invalid",
    `unknown reader probe kind: ${value ?? ""}`,
  );
}

function unwrapSupport(value) {
  if (isRecord(value) && value.schema === HOST_RECOVERY_READER_INTEGRATION_SCHEMA) {
    return value.support;
  }
  return value;
}

function validTimestamp(value) {
  return typeof value === "string" && RFC3339_UTC.test(value);
}

function safeIdentity(value) {
  const source = typeof value === "string" ? value : "reader";
  return COMMAND_ID.test(source) ? source : `reader-${sha256(Buffer.from(source)).slice(0, 16)}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
