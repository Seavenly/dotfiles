import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  HOST_RECOVERY_SCENARIOS,
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  redactQualificationCapture,
} from "./host-recovery-qualification.mjs";

/**
 * The issue-46 harness intentionally leaves the live scenarios as an
 * external seam.  These drivers are the seam implementation: they invoke the
 * public process, native provider, and review-consumer adapters supplied by a
 * qualification run, then return only evidence which can be independently
 * checked by the raw-receipt validator.
 */

export const OPERATOR_SCENARIO_IDS = Object.freeze([
  "ubuntu_headless_text_captures",
  "tuicr_review_after_producer_exit",
  "drovr_registry_lock_reconciliation",
]);

export const OPERATOR_SCENARIO_CLEANUP_RESOURCES = Object.freeze([
  "isolation/state",
  "isolation/authority",
  "isolation/backup",
  "isolation/repository",
  "isolation/drovr-config",
  "isolation/qualification-workspace",
]);

const FORM_CAPTURE_KINDS = Object.freeze([
  "terminal",
  "status",
  "checkpoint",
  "candidate",
  "review",
  "graph",
  "timeline",
  "tuicr",
]);

const ASSERTION_OBSERVATION_KINDS = Object.freeze({
  tuicr_review_after_producer_exit: Object.freeze({
    producer_exit_before_review: "producer_exit",
    flowruntime_disposition_and_approval: "disposition",
    stale_action_rejection: "stale_action",
    projection_rebuild_identity: "rebuild",
  }),
  drovr_registry_lock_reconciliation: Object.freeze({
    killed_lock_owner: "lock_owner",
    lock_reconciliation_or_block: "reconciliation",
    negative_age_takeover: "negative_age",
    negative_force_takeover: "negative_force",
  }),
});

const OWNER_RESOURCES = Object.freeze(
  OPERATOR_SCENARIO_CLEANUP_RESOURCES.map((identityRef) => ({
    kind: "isolated_root",
    identity_ref: identityRef,
  })),
);

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_SCHEMA = /^(?:flow|work|drovr|tuicr)\.[A-Za-z0-9._-]+\/v\d+$/u;
const SAFE_CAPTURE_KIND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECRET_SHAPE = /\b(?:api[_-]?key|authorization|credential|password|secret|private[_-]?key|token)\s*[:=]\s*[^\s,;}]+/iu;
const ABORT_SETTLEMENT_TIMEOUT_MS = 2_000;
const FORMATS = new Set(["json", "text", "markdown", "html"]);
const PROVENANCES = new Set(["public_process", "native_provider", "deterministic_supporting_check"]);

export class OperatorScenarioConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorScenarioConfigurationError";
    this.code = code;
  }
}

class OperatorScenarioBlocked extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorScenarioBlocked";
    this.code = code;
  }
}

class OperatorScenarioFailed extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorScenarioFailed";
    this.code = code;
  }
}

/** Run scenario 4 through a headless/text native provider. */
export async function runUbuntuHeadlessTextCaptures(options = {}) {
  return runScenario(
    "ubuntu_headless_text_captures",
    options,
    runHeadlessScenario,
  );
}

/** Run scenario 5 with a producer exit before a replaceable review consumer. */
export async function runTuicrReviewAfterProducerExit(options = {}) {
  return runScenario(
    "tuicr_review_after_producer_exit",
    options,
    runTuicrScenario,
  );
}

/** Run scenario 6 against one isolated Drovr registry lock. */
export async function runDrovrRegistryLockReconciliation(options = {}) {
  return runScenario(
    "drovr_registry_lock_reconciliation",
    options,
    runDrovrScenario,
  );
}

// Verbose aliases make the seam discoverable to qualification runners without
// allowing an arbitrary catalog scenario to reach this module.
export const runUbuntuHeadlessTextCaptureScenario = runUbuntuHeadlessTextCaptures;
export const runTuicrReviewAfterProducerExitScenario = runTuicrReviewAfterProducerExit;
export const runDrovrRegistryLockReconciliationScenario = runDrovrRegistryLockReconciliation;
export const runScenario4 = runUbuntuHeadlessTextCaptures;
export const runScenario5 = runTuicrReviewAfterProducerExit;
export const runScenario6 = runDrovrRegistryLockReconciliation;

export const HOST_RECOVERY_OPERATOR_SCENARIO_DRIVERS = Object.freeze({
  ubuntu_headless_text_captures: runUbuntuHeadlessTextCaptures,
  tuicr_review_after_producer_exit: runTuicrReviewAfterProducerExit,
  drovr_registry_lock_reconciliation: runDrovrRegistryLockReconciliation,
});

/** Dispatch only one of the three implemented issue-46 scenarios. */
export async function runHostRecoveryOperatorScenario(scenarioId, options = {}) {
  const driver = HOST_RECOVERY_OPERATOR_SCENARIO_DRIVERS[scenarioId];
  if (typeof driver !== "function") {
    throw new OperatorScenarioConfigurationError(
      "scenario_not_implemented",
      `no operator scenario driver is registered for ${scenarioId ?? ""}`,
    );
  }
  return driver(options);
}

async function runScenario(scenarioId, options, body) {
  const definition = HOST_RECOVERY_SCENARIOS.find(({ id }) => id === scenarioId);
  if (!definition) {
    throw new OperatorScenarioConfigurationError(
      "scenario_not_cataloged",
      `operator scenario is not present in the issue-46 catalog: ${scenarioId}`,
    );
  }
  const context = createContext(definition, options);
  const startedAt = context.now();
  let proof = false;
  let reason = null;
  let outcomeError = null;

  try {
    proof = await body(context);
  } catch (error) {
    outcomeError = normalizeDriverError(error);
    if (error instanceof OperatorScenarioBlocked) {
      context.blockedReasons.push(outcomeError.code);
    } else {
      context.failedReasons.push(outcomeError.code);
    }
  }

  let cleanup;
  try {
    cleanup = await runCleanup(context);
  } catch (error) {
    const normalized = normalizeDriverError(error);
    context.blockedReasons.push(normalized.reason);
    cleanup = notStartedCleanup();
  }

  const finishedAt = context.now();
  const cleanupReady = cleanup.disposition === "complete" &&
    cleanup.unresolved_obligations.length === 0;
  if (!cleanupReady && !context.blockedReasons.includes("cleanup_runner_required")) {
    context.blockedReasons.push("cleanup_not_complete");
  }
  if (context.commandFailures.length > 0) {
    context.failedReasons.push("public_command_failed");
  }

  const status = context.failedReasons.length > 0
    ? "fail"
    : context.blockedReasons.length > 0
      ? "blocked"
      : proof && cleanupReady
        ? "pass"
        : "fail";
  reason = status === "pass"
    ? null
    : uniqueStrings([
      ...(outcomeError ? [outcomeError.code] : []),
      ...context.failedReasons,
      ...context.blockedReasons,
    ])[0] ?? "scenario_proof_not_satisfied";

  const assertions = buildAssertions(definition, context, status);
  const retainedObligations = [
    ...context.retainedObligations,
    ...context.blockedReasons.map((code) => ({ code })),
    ...(status === "pass" ? [] : cleanupReady ? [] : [{
      code: "cleanup_runner_required",
      detail: "the owning qualification runner must execute cleanup with cleanup_inputs",
    }]),
  ];

  return Object.freeze({
    scenario_id: definition.id,
    execution_kind: definition.execution_kind,
    proof_predicate: definition.proof_predicate,
    proof: Object.freeze({
      predicate: definition.proof_predicate,
      satisfied: status === "pass",
      observation_kinds: definition.required_observation_kinds,
      capture_kinds: definition.required_capture_kinds,
    }),
    required_command_kinds: [...definition.required_command_kinds],
    required_observation_kinds: [...definition.required_observation_kinds],
    required_capture_kinds: [...definition.required_capture_kinds],
    status,
    commands: context.commands,
    observations: context.observations,
    captures: context.captures,
    assertions,
    retained_obligations: retainedObligations,
    cleanup,
    cleanup_inputs: cleanupInputs(context, retainedObligations),
    result: { disposition: status, reason },
    started_at: startedAt,
    finished_at: finishedAt,
  });
}

function createContext(definition, options) {
  const {
    entrypoints,
    isolation,
    rawRoot,
    commandRunner = undefined,
    toolRunner = undefined,
    cleanupRunner = undefined,
    timeoutMs = 120_000,
    clock = () => new Date().toISOString(),
  } = options;
  validateContextInputs({ entrypoints, isolation, rawRoot, timeoutMs, clock });
  const root = assertExternalQualificationRoot(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(root, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new OperatorScenarioConfigurationError(
      "raw_root_unavailable",
      "operator scenario rawRoot must be a real directory",
    );
  }
  return {
    definition,
    options,
    entrypoints,
    isolation,
    rawRoot: root,
    commandRunner,
    toolRunner,
    cleanupRunner,
    timeoutMs,
    now: clock,
    commands: [],
    observations: [],
    captures: [],
    retainedObligations: [],
    blockedReasons: [],
    failedReasons: [],
    commandFailures: [],
    inFlight: 0,
  };
}

function validateContextInputs({ entrypoints, isolation, rawRoot, timeoutMs, clock }) {
  if (!entrypoints?.launcher?.path || !entrypoints?.node?.path) {
    throw new OperatorScenarioConfigurationError(
      "pinned_entrypoints_required",
      "operator scenario drivers require pinned launcher and Node entrypoints",
    );
  }
  if (!isolation || typeof isolation.worktree_root !== "string" ||
      !isAbsolute(isolation.worktree_root) || typeof isolation.run_id !== "string") {
    throw new OperatorScenarioConfigurationError(
      "isolation_required",
      "operator scenario drivers require explicit qualification isolation",
    );
  }
  if (typeof rawRoot !== "string" || !isAbsolute(rawRoot)) {
    throw new OperatorScenarioConfigurationError(
      "raw_root_required",
      "operator scenario drivers require an absolute external rawRoot",
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OperatorScenarioConfigurationError(
      "timeout_invalid",
      "operator scenario timeout must be positive",
    );
  }
  if (typeof clock !== "function") {
    throw new OperatorScenarioConfigurationError(
      "clock_invalid",
      "operator scenario clock must be a function",
    );
  }
}

async function runHeadlessScenario(context) {
  const outputs = {};
  const nativeProviderCommandKinds = new Set(["native_headless_capture_probe"]);
  for (const kind of context.definition.required_command_kinds.filter((candidate) =>
    !nativeProviderCommandKinds.has(candidate))) {
    outputs[kind] = await invokeCommand(context, kind, publicCommandArgs(kind, context.options));
    validateHeadlessCommandOutput(kind, outputs[kind].output);
  }

  const providerInvocation = await invokeTool(context, "headless_captures", {
    optional: context.options.captureSources !== undefined,
  });
  const provider = normalizeNativeHeadlessProvider(context, providerInvocation);
  const providerValue = provider.output ?? {};
  if (providerValue.status === "blocked") {
    throw new OperatorScenarioBlocked(
      providerValue.code ?? "headless_provider_blocked",
      providerValue.reason ?? "headless provider could not derive the required captures",
    );
  }
  const sources = context.options.captureSources ?? providerValue.captures ??
    providerValue.capture_sources ?? providerValue.forms;
  if (!sources) {
    throw new OperatorScenarioBlocked(
      "capture_provider_inventory_missing",
      "headless provider did not return a capture inventory",
    );
  }
  const outOfScopeForms = normalizeOutOfScopeForms(
    context.options.outOfScopeForms ?? providerValue.out_of_scope_forms ??
      providerValue.disabled_forms,
    providerValue.release_evidence ?? context.options.releaseEvidence,
  );
  const capturesByKind = new Map();
  for (const source of normalizeCaptureSources(sources)) {
    if (!FORM_CAPTURE_KINDS.includes(source.kind)) {
      throw new OperatorScenarioFailed(
        "capture_kind_invalid",
        `headless provider returned an unsupported capture kind: ${source.kind}`,
      );
    }
    if (capturesByKind.has(source.kind)) {
      throw new OperatorScenarioFailed(
        "capture_kind_duplicate",
        `headless provider returned duplicate capture kind: ${source.kind}`,
      );
    }
    capturesByKind.set(source.kind, source);
  }
  if (FORM_CAPTURE_KINDS.some((kind) => !capturesByKind.has(kind))) {
    throw new OperatorScenarioFailed(
      "capture_inventory_incomplete",
      "headless provider omitted one or more required text-form captures",
    );
  }
  for (const kind of FORM_CAPTURE_KINDS) {
    await addCapture(context, capturesByKind.get(kind), {
      provenance: "native_provider",
      required: true,
    });
  }

  const quality = context.captures.reduce((result, capture) => {
    result.legibility = result.legibility === "pass" && capture.legibility === "pass"
      ? "pass" : capture.legibility;
    result.watermark = result.watermark === "pass" && DIGEST.test(capture.watermark)
      ? "pass" : "fail";
    result.legal_actions = result.legal_actions === "pass" && capture.legal_actions === "pass"
      ? "pass" : capture.legal_actions;
    return result;
  }, { legibility: "pass", provenance: "pass", watermark: "pass", legal_actions: "pass" });
  const inventoryContent = {
    inventory_complete: context.captures.length === FORM_CAPTURE_KINDS.length,
    required_kinds: [...FORM_CAPTURE_KINDS],
    observed_kinds: context.captures.map(({ kind }) => kind),
    capture_ids: context.captures.map(({ id }) => id),
    capture_digests: context.captures.map(({ sha256 }) => sha256),
    watermarks: Object.fromEntries(context.captures.map(({ kind, watermark }) => [kind, watermark])),
    legibility: quality.legibility,
    provenance: context.captures.every(({ provenance }) => provenance === "native_provider")
      ? "pass" : "fail",
    watermark: quality.watermark,
    legal_actions: quality.legal_actions,
    out_of_scope_forms: outOfScopeForms,
    disabled_forms_recorded: outOfScopeForms.length > 0,
  };
  context.observations.push(makeObservation(
    context,
    "capture_inventory",
    inventoryContent,
  ));
  if (inventoryContent.legibility !== "pass" || inventoryContent.provenance !== "pass" ||
      inventoryContent.watermark !== "pass" || inventoryContent.legal_actions !== "pass" ||
      !inventoryContent.disabled_forms_recorded) {
    throw new OperatorScenarioFailed(
      "capture_quality_incomplete",
      "headless capture quality or disabled-form release evidence is incomplete",
    );
  }
  return true;
}

async function runTuicrScenario(context) {
  const producer = await invokeTool(context, "producer_exit");
  validateProducerExit(producer);
  const inboxQuery = await invokeCommand(context, "query", publicCommandArgs("query", context.options));
  const inboxWatch = await invokeCommand(context, "watch", publicCommandArgs("watch", context.options));
  validateReviewInbox(inboxQuery.output, "query");
  validateReviewInbox(inboxWatch.output, "watch");

  const consumer = await invokeTool(context, "tuicr_consumer", {
    optional: context.options.consumerObservation !== undefined,
  });
  const consumerValue = consumer ?? context.options.consumerObservation;
  validateReviewConsumer(consumerValue);

  const review = await invokeTool(context, "flowruntime_review", {
    optional: context.options.reviewObservation !== undefined,
  });
  const reviewValue = review ?? context.options.reviewObservation;
  validateApprovedReview(reviewValue, inboxQuery.output, producer);

  const staleAction = await invokeCommand(
    context,
    "command",
    publicCommandArgs("command", context.options, staleActionInput(context.options, reviewValue)),
  );
  validateStaleReviewRejection(staleAction.output, reviewValue);

  const rebuild = await invokeTool(context, "owner_restart_rebuild", {
    optional: context.options.rebuildObservation !== undefined,
  });
  const rebuildValue = rebuild ?? context.options.rebuildObservation;
  validateRebuildIdentity(rebuildValue, reviewValue);

  const producerObservation = makeObservation(context, "producer_exit", {
    ...structuredClone(producer),
    producer_exited: true,
  });
  const dispositionObservation = makeObservation(context, "disposition", {
    review_id: reviewValue.review_id,
    candidate_fingerprint: reviewValue.candidate_fingerprint,
    lifecycle_generation: reviewValue.lifecycle_generation,
    flowruntime_disposition: "approved",
    disposition: reviewValue.disposition,
    approval: reviewValue.approval,
    review_watermark: extractWatermark(reviewValue),
  });
  const staleObservation = makeObservation(context, "stale_action", {
    ...structuredClone(staleAction.output),
    rejected: true,
    mutated: false,
  });
  const rebuildObservation = makeObservation(context, "rebuild", {
    identity_stable: true,
    review_id: reviewValue.review_id,
    candidate_fingerprint: reviewValue.candidate_fingerprint,
    lifecycle_generation: reviewValue.lifecycle_generation,
    before: identityProjection(rebuildValue.before),
    after: identityProjection(rebuildValue.after),
    watermark: extractWatermark(rebuildValue) ?? extractWatermark(rebuildValue.after),
    without_mutation_lock: rebuildValue.without_mutation_lock !== false,
  });
  context.observations.push(
    producerObservation,
    dispositionObservation,
    staleObservation,
    rebuildObservation,
  );

  const captureSources = [
    captureFromOutput("inbox-query", "tuicr-inbox-query", inboxQuery.output, "public_process"),
    captureFromOutput("inbox-watch", "tuicr-inbox-watch", inboxWatch.output, "public_process"),
    captureFromOutput("consumer", "tuicr-consumer", consumerValue, "native_provider"),
    captureFromOutput("review", "review-projection", reviewValue, "native_provider"),
    captureFromOutput("stale-action", "stale-review-action", staleAction.output, "public_process"),
    captureFromOutput("rebuild", "review-rebuild", rebuildValue, "native_provider"),
  ];
  for (const source of captureSources) {
    if (source !== null) await addCapture(context, source, { required: false });
  }
  if (context.captures.length === 0) {
    throw new OperatorScenarioFailed(
      "review_capture_missing",
      "tuicr scenario produced no watermarked review capture",
    );
  }
  return true;
}

async function runDrovrScenario(context) {
  const invocation = normalizeNativeDrovrLockProbe(context.options.nativeDrovrLockProbe);
  context.commands.push(invocation.command);
  if (invocation.command.exit_code !== invocation.command.expected_exit_code ||
      invocation.command.signal !== invocation.command.expected_signal ||
      invocation.command.timed_out !== invocation.command.expected_timed_out ||
      invocation.command.exit_code !== 0 || invocation.command.signal !== null ||
      invocation.command.timed_out !== false) {
    context.commandFailures.push(invocation.command.command_kind);
  }
  const probe = invocation.output;
  const lockOwner = {
    ...probe,
    legal_actions: probe.reconciliation?.legal_next_actions ?? [],
  };
  const projection = probe.lock_projection;
  const reconciliation = probe.reconciliation;
  const negativeAge = probe.negative_age;
  const negativeForce = probe.negative_force;
  validateLockOwnerTermination(lockOwner);
  validateDrovrProjection(projection);
  validateLockReconciliation(reconciliation, lockOwner, projection);
  validateNegativeTakeover(negativeAge, "age");
  validateNegativeTakeover(negativeForce, "force");

  context.observations.push(
    makeObservation(context, "lock_owner", {
      ...structuredClone(lockOwner),
      owner_killed: true,
      owner_status: "absent",
    }),
    makeObservation(context, "reconciliation", {
      ...structuredClone(reconciliation),
      native_projection: structuredClone(projection),
    }),
    makeObservation(context, "negative_age", {
      ...structuredClone(negativeAge),
      rejected: true,
      mutated: false,
    }),
    makeObservation(context, "negative_force", {
      ...structuredClone(negativeForce),
      rejected: true,
      mutated: false,
    }),
  );
  await addCapture(context, {
    kind: "native_drovr_lock_probe",
    value: probe,
    format: "json",
    provenance: "native_provider",
    watermark: extractWatermark(probe),
    legal_actions: "pass",
    legibility: "pass",
  }, { required: true });
  return true;
}

async function invokeCommand(context, kind, args) {
  const runner = typeof context.commandRunner === "function"
    ? context.commandRunner
    : context.commandRunner?.run;
  if (typeof runner !== "function") {
    throw new OperatorScenarioBlocked(
      "live_prerequisite_missing",
      "a pinned public command runner is required for this scenario",
    );
  }
  let raw;
  try {
    raw = await runTracked(context, (signal) => runner({
        scenario_id: context.definition.id,
        kind,
        args,
        entrypoints: context.entrypoints,
        isolation: context.isolation,
        rawRoot: context.rawRoot,
        logDirectory: join(context.rawRoot, "logs"),
        timeoutMs: context.timeoutMs,
        signal,
      }),
      context.timeoutMs,
      `public command ${kind}`,
    );
  } catch (error) {
    if (error instanceof OperatorScenarioBlocked) throw error;
    throw new OperatorScenarioBlocked(
      "public_command_unavailable",
      `public command ${kind} could not be observed: ${error.message}`,
    );
  }
  const normalized = await normalizeCommandResult(context, kind, raw);
  context.commands.push(normalized.command);
  if (normalized.command.exit_code !== normalized.command.expected_exit_code ||
      normalized.command.signal !== normalized.command.expected_signal ||
      normalized.command.timed_out !== normalized.command.expected_timed_out ||
      normalized.command.exit_code !== 0 || normalized.command.signal !== null ||
      normalized.command.timed_out !== false) {
    context.commandFailures.push(kind);
  }
  return normalized;
}

async function normalizeCommandResult(context, kind, raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const command = value.command ?? value.invocation ??
    (isCommandRecord(value) ? value : null);
  if (!validateCommandRecord(command) || command.command_kind !== kind) {
    throw new OperatorScenarioFailed(
      "command_observation_invalid",
      `command runner did not return a schema-valid ${kind} invocation with an ID`,
    );
  }
  if (context.commands.some(({ id }) => id === command.id)) {
    throw new OperatorScenarioFailed(
      "command_id_duplicate",
      `command runner reused invocation ID ${command.id}`,
    );
  }
  const output = value.output ?? value.response ?? value.result ?? value.payload ??
    await outputFromLogs(context, command);
  if (output === undefined) {
    throw new OperatorScenarioBlocked(
      "command_output_unavailable",
      `public command ${kind} returned no inspectable payload`,
    );
  }
  return { command: structuredClone(command), output: parseJsonOutput(output) };
}

function normalizeNativeDrovrLockProbe(value) {
  if (value === undefined) {
    throw new OperatorScenarioBlocked(
      "native_drovr_lock_probe_required",
      "scenario 6 requires the pinned native Drovr lock probe subprocess",
    );
  }
  const command = value?.command ?? value?.invocation;
  const output = value?.output ?? value?.probe ?? value?.result;
  if (!validateCommandRecord(command) ||
      command.command_kind !== "native_drovr_lock_probe" ||
      !isObject(output) ||
      output.schema !== "flow.drovr-lock-live-observation/v1" ||
      !["pass", "blocked"].includes(output.status)) {
    throw new OperatorScenarioBlocked(
      "native_drovr_lock_probe_invalid",
      "scenario 6 requires one exact schema-bound native Drovr lock probe record",
    );
  }
  return { command: structuredClone(command), output: structuredClone(output) };
}

function normalizeNativeHeadlessProvider(context, value) {
  const command = value?.command ?? value?.invocation;
  const output = value?.output ?? value?.provider ?? value?.result;
  if (!validateCommandRecord(command) ||
      command.command_kind !== "native_headless_capture_probe" ||
      !isObject(output) ||
      output.schema !== "flow.host-recovery-headless-provider/v1" ||
      !["pass", "blocked"].includes(output.status)) {
    throw new OperatorScenarioBlocked(
      "native_headless_capture_probe_invalid",
      "scenario 4 requires one exact schema-bound native headless provider record",
    );
  }
  if (context.commands.some(({ id }) => id === command.id)) {
    throw new OperatorScenarioFailed(
      "command_id_duplicate",
      `command runner reused invocation ID ${command.id}`,
    );
  }
  context.commands.push(structuredClone(command));
  return { command: structuredClone(command), output: structuredClone(output) };
}

async function outputFromLogs(context, command) {
  const path = command.logs?.stdout?.path;
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) return undefined;
  const candidates = [join(context.rawRoot, "logs", path), join(context.rawRoot, path)];
  for (const candidate of candidates) {
    try {
      return (await readFile(candidate, "utf8")).trim();
    } catch {
      // Try the other documented relative log location.
    }
  }
  return undefined;
}

async function invokeTool(context, operation, { optional = false } = {}) {
  const runner = typeof context.toolRunner === "function"
    ? context.toolRunner
    : context.toolRunner?.run;
  if (typeof runner !== "function") {
    const fallback = context.options[toolFallbackName(operation)];
    if (fallback !== undefined) return structuredClone(fallback);
    if (optional) return undefined;
    throw new OperatorScenarioBlocked(
      "live_prerequisite_missing",
      `a native provider runner is required for ${operation}`,
    );
  }
  try {
    const result = await runTracked(context, (signal) => runner({
        scenario_id: context.definition.id,
        operation,
        entrypoints: context.entrypoints,
        isolation: context.isolation,
        rawRoot: context.rawRoot,
        timeoutMs: context.timeoutMs,
        signal,
      }),
      context.timeoutMs,
      `native provider ${operation}`,
    );
    if (result === undefined || result === null) {
      if (optional) return undefined;
      throw new OperatorScenarioBlocked(
        "provider_output_missing",
        `native provider returned no observation for ${operation}`,
      );
    }
    return structuredClone(result);
  } catch (error) {
    if (error instanceof OperatorScenarioBlocked || error instanceof OperatorScenarioFailed) {
      throw error;
    }
    throw new OperatorScenarioBlocked(
      "provider_unavailable",
      `native provider ${operation} could not be observed: ${error.message}`,
    );
  }
}

async function runCleanup(context) {
  if (context.inFlight > 0) {
    context.blockedReasons.push("work_in_flight");
    return notStartedCleanup("work_in_flight");
  }
  if (typeof context.cleanupRunner !== "function") {
    context.blockedReasons.push("cleanup_runner_required");
    return notStartedCleanup();
  }
  const result = await runTracked(context, (signal) => context.cleanupRunner({
    ...cleanupInputs(context, context.retainedObligations),
    signal,
  }),
    context.timeoutMs,
    "scenario cleanup",
  );
  const cleanup = result?.cleanup ?? result;
  if (!cleanup || typeof cleanup !== "object" ||
      !["complete", "blocked", "not_started"].includes(cleanup.disposition) ||
      !Array.isArray(cleanup.owned_resources) ||
      !Array.isArray(cleanup.resource_dispositions) ||
      !Array.isArray(cleanup.unresolved_obligations) ||
      (cleanup.completed_at !== null && typeof cleanup.completed_at !== "string")) {
    throw new OperatorScenarioBlocked(
      "cleanup_result_invalid",
      "cleanup runner returned an invalid cleanup input result",
    );
  }
  return structuredClone(cleanup);
}

function cleanupInputs(context, retainedObligations) {
  return {
    scenario_id: context.definition.id,
    run_id: context.isolation.run_id,
    isolation_identity: context.isolation.identity_digest ?? null,
    raw_root_ref: "external/raw-root",
    owned_resources: OWNER_RESOURCES.map((resource) => ({ ...resource })),
    retained_obligations: structuredClone(retainedObligations),
  };
}

function notStartedCleanup(code = "cleanup_runner_required") {
  return {
    disposition: "not_started",
    owned_resources: OWNER_RESOURCES.map((resource) => ({ ...resource })),
    resource_dispositions: [],
    unresolved_obligations: [{ code }],
    completed_at: null,
  };
}

function buildAssertions(definition, context, status) {
  const refsByKind = new Map([
    ...context.observations.map((observation) => [
      `observation:${observation.kind}`,
      `observation:${observation.id}`,
    ]),
    ...context.captures.map((capture) => [
      `capture:${capture.kind}`,
      `capture:${capture.id}`,
    ]),
  ]);
  return definition.required_assertion_ids.map((id) => {
    const expected = definition.id === "ubuntu_headless_text_captures"
      ? definition.required_capture_kinds.map((kind) => refsByKind.get(`capture:${kind}`)).filter(Boolean)
      : [refsByKind.get(`observation:${ASSERTION_OBSERVATION_KINDS[definition.id]?.[id]}`)].filter(Boolean);
    const disposition = status === "pass" ? "pass" : expected.length > 0 ? "not_observed" : "not_observed";
    return {
      id,
      disposition,
      evidence_refs: expected,
    };
  });
}

async function addCapture(context, source, { provenance = undefined, required = false } = {}) {
  const normalized = normalizeCaptureSource(source);
  const value = normalized.value;
  const format = normalized.format;
  const effectiveProvenance = provenance ?? normalized.provenance;
  const watermark = normalized.watermark ?? extractWatermark(value);
  const legalActions = legalActionStatus(normalized.legal_actions ?? extractLegalActions(value));
  const bytes = captureBytes(normalized.kind, format, value, context.isolation);
  const legibility = inspectLegibility(bytes, format, value);
  if (!FORMATS.has(format) || !PROVENANCES.has(effectiveProvenance) ||
      typeof watermark !== "string" || watermark.length === 0 ||
      !["pass", "fail", "not_observed"].includes(legibility) ||
      !["pass", "fail", "not_observed"].includes(legalActions)) {
    if (required) {
      throw new OperatorScenarioFailed(
        "capture_quality_incomplete",
        `capture ${normalized.kind} lacks format, provenance, watermark, legibility, or legal-action evidence`,
      );
    }
    return null;
  }
  if (effectiveProvenance === "native_provider" && !DIGEST.test(watermark)) {
    throw new OperatorScenarioFailed(
      "capture_watermark_invalid",
      `capture ${normalized.kind} does not carry an exact digest watermark`,
    );
  }
  if (SECRET_SHAPE.test(bytes.toString("utf8"))) {
    throw new OperatorScenarioFailed(
      "capture_secret_shaped",
      `capture ${normalized.kind} contains a secret-shaped value after redaction`,
    );
  }
  const path = `captures/${context.definition.id}/${normalized.kind}.${format}`;
  const destination = join(context.rawRoot, path);
  ensureCaptureDirectory(join(context.rawRoot, "captures", context.definition.id));
  writeImmutableCapture(destination, bytes);
  const capture = {
    id: `${context.definition.id}:capture:${normalized.kind}`,
    kind: normalized.kind,
    format,
    path,
    sha256: sha256(bytes),
    legibility,
    provenance: effectiveProvenance,
    watermark,
    legal_actions: legalActions,
  };
  context.captures.push(capture);
  return capture;
}

function ensureCaptureDirectory(directory) {
  let current = isAbsolute(directory) ? "/" : ".";
  for (const component of directory.split("/").filter(Boolean)) {
    current = join(current, component);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new OperatorScenarioFailed(
          "capture_path_invalid",
          "capture directory must contain only real directories",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function normalizeCaptureSources(sources) {
  if (Array.isArray(sources)) return sources;
  if (sources && typeof sources === "object") {
    return Object.entries(sources).map(([kind, value]) => ({ kind, value }));
  }
  throw new OperatorScenarioFailed("capture_inventory_invalid", "capture inventory must be an array or object");
}

function normalizeCaptureSource(source) {
  if (!source || typeof source !== "object" || typeof source.kind !== "string" ||
      source.kind.length === 0) {
    throw new OperatorScenarioFailed("capture_invalid", "capture source requires a non-empty kind");
  }
  if (!SAFE_CAPTURE_KIND.test(source.kind)) {
    throw new OperatorScenarioFailed(
      "capture_kind_invalid",
      `capture kind is not a safe evidence identifier: ${source.kind}`,
    );
  }
  const value = source.value ?? source.output ?? source.content ?? source.bytes;
  if (value === undefined || value === null) {
    throw new OperatorScenarioFailed("capture_bytes_missing", `capture ${source.kind} has no content`);
  }
  return {
    ...source,
    value,
    format: source.format ?? inferFormat(value),
  };
}

function captureFromOutput(kind, captureKind, value, provenance) {
  const watermark = extractWatermark(value);
  const legalActions = extractLegalActions(value);
  if (!watermark || legalActions === null) return null;
  return {
    kind: captureKind,
    value,
    format: inferFormat(value),
    provenance,
    watermark,
    legal_actions: legalActions,
    legibility: "pass",
  };
}

function captureBytes(kind, format, value, isolation) {
  const redacted = redactQualificationCapture(value, {
    pathMappings: {
      worktree: isolation.worktree_root,
      state: isolation.xdg_state_home,
      authority: isolation.authority_directory,
      backup: isolation.backup_directory,
      repository: isolation.repository_root,
      drovr: isolation.drovr_config_directory,
    },
  });
  if (format === "json") {
    const rendered = JSON.stringify(redacted, null, 2);
    return Buffer.from(`${JSON.stringify({
      schema: "flow.host-recovery-capture/v1",
      kind,
      rendering: {
        encoding: "json-text-segments/v1",
        width: 88,
        segments: splitByEncodedWidth(rendered, 88),
      },
    }, null, 2)}\n`);
  }
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted, null, 2);
  const rendered = splitByEncodedWidth(text, 88).map((segment) => JSON.stringify(segment)).join("\n");
  if (format === "html") {
    return Buffer.from(`<!-- flow.host-recovery-capture/v1 kind=${kind} encoding=text-segments/v1 width=88 -->\n${rendered}\n`);
  }
  if (format === "markdown") {
    return Buffer.from(`<!-- flow.host-recovery-capture/v1 kind=${kind} encoding=text-segments/v1 width=88 -->\n\n${rendered}\n`);
  }
  return Buffer.from(`flow.host-recovery-capture/v1 kind=${kind} encoding=text-segments/v1 width=88\n${rendered}\n`);
}

function splitByEncodedWidth(text, width) {
  const segments = [];
  let segment = "";
  for (const character of text) {
    const candidate = `${segment}${character}`;
    if (segment.length > 0 && JSON.stringify(candidate).length > width) {
      segments.push(segment);
      segment = character;
    } else {
      segment = candidate;
    }
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function writeImmutableCapture(path, bytes) {
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new OperatorScenarioFailed(
        "capture_path_invalid",
        "capture target must be a regular non-symlink file",
      );
    }
    const existing = readFileSync(path);
    if (!existing.equals(bytes)) {
      throw new OperatorScenarioFailed(
        "capture_immutable_conflict",
        `capture path already exists with different bytes: ${path}`,
      );
    }
  }
}

function makeObservation(context, kind, content) {
  const safeContent = redactQualificationCapture(content, {
    pathMappings: {
      worktree: context.isolation.worktree_root,
      state: context.isolation.xdg_state_home,
      authority: context.isolation.authority_directory,
      backup: context.isolation.backup_directory,
      repository: context.isolation.repository_root,
      drovr: context.isolation.drovr_config_directory,
    },
  });
  return {
    id: `${context.definition.id}:${kind}`,
    kind,
    content: safeContent,
    content_digest: canonicalDigest(safeContent),
  };
}

function validateHeadlessCommandOutput(kind, output) {
  if (!isObject(output)) {
    throw new OperatorScenarioFailed("public_schema_invalid", `headless ${kind} output is not an object`);
  }
  if (typeof output.schema !== "string" || !SAFE_SCHEMA.test(output.schema)) {
    throw new OperatorScenarioFailed("public_schema_invalid", `headless ${kind} output has no versioned public schema`);
  }
  if (kind === "status" && !["flow.owner-status/v1", "flow.runtime-runner-status/v1"].includes(output.schema)) {
    throw new OperatorScenarioFailed("public_schema_invalid", "headless status output is not owner/runner status");
  }
}

function validateProducerExit(value) {
  if (!isObject(value) || value.producer_exited !== true ||
      value.process_absence?.status !== "absent" ||
      typeof value.process_absence.process_identity !== "string" ||
      !RFC3339_UTC.test(value.producer_exited_at ?? "")) {
    throw new OperatorScenarioFailed(
      "producer_exit_unproven",
      "producer exit requires explicit process-absence evidence and an exit timestamp",
    );
  }
}

function validateReviewInbox(value, source) {
  if (!isObject(value) || value.schema !== "flow.review-inbox-projection/v1" ||
      typeof extractWatermark(value) !== "string" || !Array.isArray(value.items)) {
    throw new OperatorScenarioFailed(
      "review_inbox_invalid",
      `${source} did not return a watermarked flow.review-inbox projection`,
    );
  }
  for (const item of value.items) {
    if (!isObject(item) || typeof item.review_id !== "string" ||
        typeof item.candidate_fingerprint !== "string" ||
        !Number.isSafeInteger(item.lifecycle_generation) ||
        !Array.isArray(item.legal_actions)) {
      throw new OperatorScenarioFailed("review_inbox_invalid", `${source} contains an invalid review item`);
    }
  }
}

function validateReviewConsumer(value) {
  if (!isObject(value) || value.started !== true ||
      (value.consumer !== "tuicr" && value.supported_consumer !== true) ||
      !isObject(value.list) || !isObject(value.comments) ||
      typeof value.list.session_id !== "string" ||
      typeof value.comments.session_id !== "string" ||
      value.list.session_id !== value.comments.session_id) {
    throw new OperatorScenarioFailed(
      "review_consumer_invalid",
      "tuicr or a supported review consumer did not return exact list/comments evidence",
    );
  }
  if (value.list.review_id !== undefined && value.comments.review_id !== undefined &&
      value.list.review_id !== value.comments.review_id) {
    throw new OperatorScenarioFailed("review_consumer_identity_invalid", "tuicr list/comments identify different reviews");
  }
}

function validateApprovedReview(value, inbox, producer) {
  if (!isObject(value) || value.schema !== "work.review-projection/v1" ||
      value.flowruntime_disposition !== "approved" || value.approval !== "approved" ||
      value.disposition_event?.accepted !== true || value.approval_event?.accepted !== true ||
      typeof value.review_id !== "string" || typeof value.candidate_fingerprint !== "string" ||
      !Number.isSafeInteger(value.lifecycle_generation) || !extractWatermark(value) ||
      !Array.isArray(value.legal_actions)) {
    throw new OperatorScenarioFailed(
      "review_approval_unproven",
      "FlowRuntime review evidence lacks a durable disposition and approval receipt",
    );
  }
  const item = inbox.items.find(({ review_id }) => review_id === value.review_id);
  if (!item || item.candidate_fingerprint !== value.candidate_fingerprint ||
      item.lifecycle_generation !== value.lifecycle_generation) {
    throw new OperatorScenarioFailed("review_identity_mismatch", "approved review is not the inbox candidate");
  }
  if (RFC3339_UTC.test(producer.producer_exited_at ?? "") &&
      RFC3339_UTC.test(value.review_started_at ?? "") &&
      Date.parse(value.review_started_at) < Date.parse(producer.producer_exited_at)) {
    throw new OperatorScenarioFailed("review_order_invalid", "review began before producer exit evidence");
  }
}

function validateStaleReviewRejection(value, review) {
  if (!isObject(value) || value.schema !== "work.rejection/v1" ||
      !["stale_review_generation", "stale_review_watermark"].includes(value.code) ||
      value.rejected !== true || value.accepted === true ||
      value.review_id !== review.review_id ||
      typeof value.expected_watermark !== "string" ||
      typeof value.observed_watermark !== "string") {
    throw new OperatorScenarioFailed(
      "stale_action_not_rejected",
      "the copied stale review action did not produce a typed negative outcome",
    );
  }
}

function validateRebuildIdentity(value, review) {
  if (!isObject(value) || value.identity_stable !== true ||
      !isObject(value.before) || !isObject(value.after) ||
      typeof value.before.review_id !== "string" ||
      value.before.review_id !== review.review_id ||
      value.after.review_id !== review.review_id ||
      canonicalDigest(identityProjection(value.before)) !== canonicalDigest(identityProjection(value.after)) ||
      !extractWatermark(value) && !extractWatermark(value.after)) {
    throw new OperatorScenarioFailed(
      "projection_rebuild_identity_invalid",
      "owner restart/rebuild did not prove byte-identical review identity",
    );
  }
}

function validateLockOwnerTermination(value) {
  if (!isObject(value) || value.owner_killed !== true || value.owner_status !== "absent" ||
      value.process_absence?.status !== "absent" || typeof value.process_absence.process_identity !== "string" ||
      typeof value.lock_id !== "string" || typeof value.resource_key !== "string" ||
      !extractWatermark(value) || extractLegalActions(value) !== "pass") {
    throw new OperatorScenarioFailed(
      "lock_owner_absence_unproven",
      "Drovr lock owner termination lacks exact process-absence, lock, and watermark evidence",
    );
  }
}

function validateDrovrProjection(value) {
  if (!isObject(value) || value.schema !== "drovr.registry-lock-reconciliation/v1" ||
      !Array.isArray(value.locks) || !Array.isArray(value.legal_next_actions) ||
      !extractWatermark(value)) {
    throw new OperatorScenarioFailed("drovr_projection_invalid", "Drovr query did not return a lock reconciliation projection");
  }
}

function validateLockReconciliation(value, owner, projection) {
  if (!isObject(value) || (value.reconciled !== true && value.actionable_block !== true) ||
      typeof value.recovery_action !== "string" || !Array.isArray(value.legal_next_actions) ||
      value.lock_id !== owner.lock_id || value.resource_key !== owner.resource_key ||
      !extractWatermark(value)) {
    throw new OperatorScenarioFailed(
      "lock_reconciliation_invalid",
      "Drovr lock reconciliation lacks an exact recovery action or block",
    );
  }
  const legalActions = new Set([
    ...(projection.legal_next_actions ?? []),
    ...projection.locks.flatMap(({ legal_next_actions: actions }) => actions ?? []),
  ]);
  if (!legalActions.has(value.recovery_action)) {
    throw new OperatorScenarioFailed(
      "lock_recovery_action_unprojected",
      "Drovr recovery action was not present in the public projection",
    );
  }
}

function validateNegativeTakeover(value, expectedKind) {
  const action = String(value?.action ?? value?.requested_action ?? "").toLowerCase();
  const isAge = expectedKind === "age" && /(age|timer|stale)/u.test(action);
  const isForce = expectedKind === "force" && /(force|generic|unlock|takeover)/u.test(action);
  if (!isObject(value) || (!isAge && !isForce && expectedKind !== "command") ||
      value.rejected !== true || value.accepted === true || value.mutated !== false ||
      !(typeof value.code === "string" || typeof value.outcome === "string") ||
      !extractWatermark(value)) {
    throw new OperatorScenarioFailed(
      "negative_takeover_not_proven",
      `Drovr ${expectedKind} takeover did not produce an explicit non-mutating rejection`,
    );
  }
}

function normalizeOutOfScopeForms(forms, fallbackEvidence) {
  if (!Array.isArray(forms)) {
    throw new OperatorScenarioBlocked(
      "out_of_scope_release_evidence_missing",
      "headless qualification must record disabled forms and release evidence explicitly",
    );
  }
  return forms.map((form) => {
    const value = typeof form === "string"
      ? { form, status: "out_of_scope", reason: "form is disabled by the qualified release", release_evidence: fallbackEvidence }
      : form;
    if (!isObject(value) || typeof value.form !== "string" || value.status !== "out_of_scope" ||
        typeof value.reason !== "string" || !isObject(value.release_evidence) ||
        (!value.release_evidence.release_id && !value.release_evidence.manifest_digest &&
          !value.release_evidence.route)) {
      throw new OperatorScenarioFailed(
        "out_of_scope_release_evidence_invalid",
        "disabled headless form lacks a reason and release-bound evidence",
      );
    }
    return redactQualificationCapture(structuredClone(value));
  });
}

function staleActionInput(options, review) {
  return options.staleAction ?? {
    schema: "work.review-human-command/v1",
    type: "review_comment",
    contract: "work/review/v1",
    review_id: review.review_id,
    subject_id: review.review_id,
    expected_generation: Math.max(0, review.review_generation - 1),
    expected_watermark: review.watermark,
  };
}

function publicCommandArgs(kind, options, input = undefined) {
  if (kind === "status") return ["status", "--json"];
  if (kind === "query") return [
    "query",
    "--input",
    JSON.stringify(options.queryInput ?? { schema: "flow.query/v1", query: "review_inbox" }),
    "--json",
  ];
  if (kind === "watch") return [
    "watch",
    "--input",
    JSON.stringify(options.watchInput ?? { schema: "flow.watch/v1", query: "review_inbox" }),
    "--json",
  ];
  if (kind === "command") return [
    "command",
    "--input",
    JSON.stringify(input ?? options.commandInput ?? {
      schema: "flow.command/v1",
      type: "status",
    }),
    "--json",
  ];
  throw new OperatorScenarioConfigurationError("command_kind_invalid", `unsupported public command kind: ${kind}`);
}

function validateCommandRecord(command) {
  return isCommandRecord(command) &&
    command.argv.every((arg) => typeof arg === "string") &&
    typeof command.launcher_ref === "string" && !isAbsolute(command.launcher_ref) &&
    typeof command.working_directory_ref === "string" &&
    RFC3339_UTC.test(command.started_at) && RFC3339_UTC.test(command.finished_at) &&
    Number.isSafeInteger(command.duration_ms) && command.duration_ms >= 0 &&
    (Number.isInteger(command.exit_code) || command.exit_code === null) &&
    (Number.isInteger(command.expected_exit_code) || command.expected_exit_code === null) &&
    [null, "SIGTERM", "SIGKILL", "SIGINT"].includes(command.signal) &&
    [null, "SIGTERM", "SIGKILL", "SIGINT"].includes(command.expected_signal) &&
    typeof command.timed_out === "boolean" && typeof command.expected_timed_out === "boolean" &&
    isCommandLogDescriptor(command.logs?.stdout) && isCommandLogDescriptor(command.logs?.stderr);
}

function isCommandRecord(value) {
  return isObject(value) && typeof value.id === "string" &&
    typeof value.command_kind === "string" && Array.isArray(value.argv);
}

function isCommandLogDescriptor(value) {
  return isObject(value) &&
    (value.path === null || typeof value.path === "string" && !isAbsolute(value.path)) &&
    /^[0-9a-f]{64}$/u.test(value.sha256 ?? "") &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function extractWatermark(value) {
  if (!isObject(value)) return null;
  const candidates = [
    value.watermark,
    value.authority_watermark,
    value.review_authority_watermark,
    value.candidate_authority_watermark,
    value.projection?.watermark,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (isObject(candidate)) {
      if (typeof candidate.content_sha256 === "string") return candidate.content_sha256;
      if (typeof candidate.registry_sha256 === "string") return candidate.registry_sha256;
      if (typeof candidate.generation === "string" && DIGEST.test(candidate.generation)) return candidate.generation;
      try {
        return canonicalDigest(candidate);
      } catch {
        // Continue to the next exact watermark field.
      }
    }
  }
  return null;
}

function extractLegalActions(value) {
  if (!isObject(value)) return null;
  if (Array.isArray(value.legal_actions)) return "pass";
  if (Array.isArray(value.legal_next_actions)) return "pass";
  if (Array.isArray(value.items) && value.items.every((item) => Array.isArray(item?.legal_actions))) return "pass";
  if (Array.isArray(value.list?.legal_actions) || Array.isArray(value.comments?.legal_actions)) return "pass";
  if (value.views?.operator && Array.isArray(value.views.operator.legal_actions)) return "pass";
  return null;
}

function legalActionStatus(value) {
  if (Array.isArray(value)) return "pass";
  return value;
}

function inferFormat(value) {
  if (typeof value === "string") return "text";
  return "json";
}

function inspectLegibility(bytes, format, value) {
  if (format === "json" && !isObject(value) && !Array.isArray(value)) return "fail";
  const text = bytes.toString("utf8");
  if (typeof text !== "string" || text.trim().length === 0 || text.includes("\uFFFD") ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) return "fail";
  if (text.split("\n").some((line) => line.length > 120)) return "fail";
  if (format === "json") {
    try {
      const capture = JSON.parse(text);
      const rendering = capture?.rendering;
      if (rendering?.encoding !== "json-text-segments/v1" || rendering.width !== 88 ||
          !Array.isArray(rendering.segments) || rendering.segments.length === 0 ||
          rendering.segments.some((segment) => typeof segment !== "string" ||
            JSON.stringify(segment).length > rendering.width)) return "fail";
      JSON.parse(rendering.segments.join(""));
    } catch {
      return "fail";
    }
  }
  return "pass";
}

function identityProjection(value) {
  if (!isObject(value)) return null;
  return {
    review_id: value.review_id,
    candidate_fingerprint: value.candidate_fingerprint,
    lifecycle_generation: value.lifecycle_generation,
    review_generation: value.review_generation,
    watermark: extractWatermark(value),
  };
}

function recoveryAction(reconciliation, projection) {
  if (typeof reconciliation.recovery_action === "string") return reconciliation.recovery_action;
  return projection.legal_next_actions?.find((action) =>
    ["release_absent_registry_lock", "adopt_registry_operation", "prove_registry_operation_absent"].includes(action),
  ) ?? null;
}

function toolFallbackName(operation) {
  return {
    headless_captures: "captureSources",
    producer_exit: "producerExit",
    tuicr_consumer: "consumerObservation",
    flowruntime_review: "reviewObservation",
    owner_restart_rebuild: "rebuildObservation",
  }[operation] ?? operation;
}

function parseJsonOutput(value) {
  if (typeof value !== "string") return structuredClone(value);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDriverError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "scenario_driver_error",
    reason: typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : String(error),
  };
}

async function runTracked(context, operation, timeoutMs, label) {
  context.inFlight += 1;
  try {
    const result = await withTimeout(operation, timeoutMs, label);
    context.inFlight -= 1;
    return result;
  } catch (error) {
    if (error?.settled !== false) context.inFlight -= 1;
    throw error;
  }
}

async function withTimeout(operation, timeoutMs, label) {
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
    timer = setTimeout(() => reject(new OperatorScenarioBlocked(
      "timeout",
      `${label} exceeded the bounded timeout`,
    )), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([observed, timeout]);
  } catch (error) {
    if (error?.code !== "timeout") throw error;
    controller.abort(error);
    const acknowledged = await Promise.race([
      observed.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ABORT_SETTLEMENT_TIMEOUT_MS)),
    ]);
    if (!acknowledged || !settled) {
      const unacknowledged = new OperatorScenarioBlocked(
        "abort_unacknowledged",
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
