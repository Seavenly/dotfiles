import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  cleanupQualificationIsolation,
  isolatedQualificationEnvironment,
  qualificationIsolationIdentity,
  redactQualificationCapture,
} from "./host-recovery-qualification.mjs";
import { createFlowClient } from "./client.mjs";
import {
  flowOwnerPaths,
  startFlowOwner,
  stopFlowOwner,
} from "./owner-process.mjs";

export const TUICR_SCENARIO_ID = "tuicr_review_after_producer_exit";
export const TUICR_SCENARIO_SCHEMA = "flow.host-recovery-tuicr-scenario/v1";
export const TUICR_COMMAND_SCHEMA = "flow.tuicr-command-observation/v1";

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/u;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class TuicrScenarioConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TuicrScenarioConfigurationError";
    this.code = code;
  }
}

export class TuicrScenarioBlocked extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TuicrScenarioBlocked";
    this.code = code;
    this.details = details;
  }
}

/**
 * Exercise the local-review consumer after its producer has exited.
 *
 * The producer is deliberately an injected seam. A qualification runner must
 * provide a real producer adapter which seeds a Flow-authority review and
 * returns process-absence evidence. This module never fabricates that proof.
 * Likewise, tuicr 0.19 has no noninteractive session-creation command, so a
 * caller must provide a session created by the isolated TUI or receive the
 * typed `tuicr_noninteractive_seed_required` block below.
 */
export async function runTuicrReviewAfterProducerExit(options = {}) {
  const startedAt = now(options.clock);
  let context;
  try {
    context = createContext(options);
  } catch (error) {
    return blockedResult(options, startedAt, error);
  }

  // No owned process or root exists until after these prerequisite checks.
  if (options.sessionPath === undefined || options.sessionPath === null) {
    return finishBlocked(context, startedAt, new TuicrScenarioBlocked(
      "tuicr_noninteractive_seed_required",
      "tuicr review list/comments require an isolated session created by the TUI; the pinned CLI has no noninteractive session-creation route",
    ));
  }
  try {
    await validateSessionPath(context, options.sessionPath);
  } catch (error) {
    return finishBlocked(context, startedAt, error);
  }
  if (typeof options.producer?.seed !== "function") {
    return finishBlocked(context, startedAt, new TuicrScenarioBlocked(
      "producer_seed_adapter_required",
      "tuicr qualification requires a real producer adapter which seeds Flow authority and returns a review identity",
    ));
  }

  let owner = null;
  let client = null;
  let producer = null;
  let outcome = null;
  try {
    producer = await options.producer.seed({
      env: context.env,
      isolation: context.isolation,
      rawRoot: context.rawRoot,
      run_id: context.isolation.run_id,
    });
    validateProducerSeed(producer);
    if (typeof options.producer.close === "function") {
      await options.producer.close({ producer, signal: undefined });
    }
    validateProducerExit(producer.producer_exit);

    const ownerState = await startPublicOwner(context, options);
    owner = ownerState.owner;
    client = ownerState.client;
    const inbox = await queryReviewInbox(client);
    const beforeReview = await queryReview(client, producer.review_id);
    const item = findInboxItem(inbox, producer.review_id);
    if (item === null) {
      throw new TuicrScenarioBlocked(
        "review_not_in_inbox",
        `FlowRuntime review ${producer.review_id} was not present in the public inbox`,
      );
    }

    const tuicrList = await runTuicrCommand(context, [
      "review", "list", "--repo", context.isolation.repository_root,
    ], "tuicr_list");
    const tuicrComments = await runTuicrCommand(context, [
      "review", "comments", "--repo", context.isolation.repository_root,
      "--session", context.sessionPath,
    ], "tuicr_comments");
    const consumer = {
      schema: "tuicr.review-consumer-observation/v1",
      consumer: "tuicr",
      started: true,
      session_path: context.sessionPath,
      list: parseTuicrList(tuicrList.stdout, context.sessionPath),
      comments: parseJsonOutput(tuicrComments.stdout, "tuicr comments"),
      producer_exited_at: producer.producer_exit.producer_exited_at,
    };
    validateConsumer(consumer, producer.review_id);

    const sessionStart = findAction(item, "review_session_start") ??
      findAction(item.review, "review_session_start") ??
      findAction(beforeReview, "review_session_start");
    if (sessionStart === null) {
      throw new TuicrScenarioBlocked(
        "review_session_start_unavailable",
        `public FlowRuntime did not expose review_session_start: ${JSON.stringify({
          inbox_status: item.status,
          inbox_actions: actionTypes(item),
          nested_actions: actionTypes(item.review),
          review_status: beforeReview.status,
          review_actions: actionTypes(beforeReview),
        })}`,
      );
    }
    const sessionId = `session:${context.isolation.run_id}:tuicr`;
    const sessionReceipt = await client.command(materializeAction(sessionStart, {
      session_id: sessionId,
    }));
    requireAccepted(sessionReceipt, "review session start");

    const afterSession = await queryReview(client, producer.review_id);
    const commentAction = findAction(afterSession, "review_comment");
    if (commentAction === null) {
      throw new TuicrScenarioBlocked(
        "review_comment_unavailable",
        "public FlowRuntime did not expose review_comment after session start",
      );
    }
    const staleAction = materializeAction(commentAction, {
      command_id: `${commentAction.command_id}:stale-replay`,
      comment_id: `comment:${context.isolation.run_id}:stale`,
      body: "stale action must be rejected",
    });
    const commentReceipt = await client.command(materializeAction(commentAction, {
      comment_id: `comment:${context.isolation.run_id}:qualification`,
      body: "qualification consumer observed the producer after exit",
    }));
    requireAccepted(commentReceipt, "review comment");

    const afterComment = await queryReview(client, producer.review_id);
    const dispositionAction = findAction(afterComment, "review_disposition");
    if (dispositionAction === null) {
      throw new TuicrScenarioBlocked(
        "review_disposition_unavailable",
        "public FlowRuntime did not expose review_disposition after comment",
      );
    }
    const dispositionReceipt = await client.command(materializeAction(dispositionAction, {
      disposition: "accept",
    }));
    requireAccepted(dispositionReceipt, "review disposition");

    const afterDisposition = await queryReview(client, producer.review_id);
    const approvalAction = findAction(afterDisposition, "review_approval", "approve");
    if (approvalAction === null) {
      throw new TuicrScenarioBlocked(
        "review_approval_unavailable",
        "public FlowRuntime did not expose review approval after disposition",
      );
    }
    const approvalReceipt = await client.command(materializeAction(approvalAction, {
      decision: "approve",
    }));
    requireAccepted(approvalReceipt, "review approval");
    const approved = await queryReview(client, producer.review_id);
    validateApprovedProjection(approved);

    const staleReceipt = await client.command(staleAction);
    validateStaleReceipt(staleReceipt);

    const beforeRestart = identityProjection(approved);
    const stopped = await stopFlowOwner({ ...context.ownerPaths, force: true });
    if (stopped.state !== "stopped") {
      throw new TuicrScenarioBlocked(
        "owner_restart_unavailable",
        `public owner did not stop cleanly: ${stopped.state}`,
      );
    }
    owner = null;
    const restarted = await startPublicOwner(context, options);
    owner = restarted.owner;
    client = restarted.client;
    const rebuilt = await queryReview(client, producer.review_id);
    const afterRestart = identityProjection(rebuilt);
    if (canonicalDigest(beforeRestart) !== canonicalDigest(afterRestart)) {
      throw new TuicrScenarioBlocked(
        "review_rebuild_identity_changed",
        `public FlowRuntime changed review identity across owner restart: ${JSON.stringify({
          before: beforeRestart,
          after: afterRestart,
        })}`,
      );
    }

    const disposition = approved.dispositions.at(-1);
    const assertions = {
      producer_exit_before_review: true,
      flowruntime_disposition_and_approval:
        disposition?.disposition === "accept" &&
        approved.approval === "approved" &&
        approved.approval_receipt?.decision === "approve" &&
        dispositionReceipt.accepted === true &&
        approvalReceipt.accepted === true,
      stale_action_rejection: true,
      projection_rebuild_identity: true,
    };
    if (Object.values(assertions).some((value) => value !== true)) {
      throw new TuicrScenarioBlocked(
        "review_approval_unproven",
        "FlowRuntime review projection did not bind acceptance and approval to durable receipts",
        { review_id: approved.review_id },
      );
    }

    const observations = [
      observation("producer_exit", {
        ...producer.producer_exit,
        producer_exited: true,
      }),
      observation("disposition", {
        review_id: approved.review_id,
        candidate_fingerprint: approved.candidate_fingerprint,
        lifecycle_generation: approved.lifecycle_generation,
        flowruntime_disposition: disposition?.disposition,
        disposition,
        dispositions: approved.dispositions,
        approval: approved.approval,
        approval_receipt: approved.approval_receipt,
        disposition_receipt: dispositionReceipt,
        approval_command_receipt: approvalReceipt,
        watermark: extractWatermark(approved),
      }),
      observation("stale_action", {
        ...redactQualificationCapture(staleReceipt),
        rejected: true,
        mutated: false,
      }),
      observation("rebuild", {
        identity_stable: true,
        review_id: producer.review_id,
        candidate_fingerprint: rebuilt.candidate_fingerprint,
        lifecycle_generation: rebuilt.lifecycle_generation,
        before: beforeRestart,
        after: afterRestart,
        watermark: extractWatermark(rebuilt),
        without_mutation_lock: true,
      }),
    ];
    outcome = {
      producer_exit: observations[0],
      consumer,
      disposition: observations[1],
      stale_action: observations[2],
      rebuild: observations[3],
      observations,
      captures: [
        capture("tuicr-list", tuicrList.stdout, "public_process"),
        capture("tuicr-comments", tuicrComments.stdout, "public_process"),
        capture("review-approved", approved, "public_process"),
        capture("review-rebuilt", rebuilt, "public_process"),
      ],
      commands: [tuicrList.command, tuicrComments.command],
      assertions,
    };
  } catch (error) {
    outcome = { error: normalizeError(error) };
  } finally {
    if (owner !== null) {
      await stopFlowOwner({ ...context.ownerPaths, force: true }).catch(() => {});
    }
  }

  const cleanup = await cleanupOwned(context, options);
  const finishedAt = now(options.clock);
  if (outcome?.error) {
    return Object.freeze({
      ...baseResult(context, startedAt, finishedAt),
      status: outcome.error.name === "TuicrScenarioBlocked" ? "blocked" : "fail",
      reason: outcome.error.code,
      observations: [],
      captures: [],
      commands: [],
      cleanup,
      error: outcome.error,
    });
  }
  const result = {
    ...baseResult(context, startedAt, finishedAt),
    status: cleanup.disposition === "complete" ? "pass" : "blocked",
    reason: cleanup.disposition === "complete" ? null : "cleanup_incomplete",
    ...outcome,
    cleanup,
  };
  return Object.freeze(result);
}

/** Invoke only the pinned tuicr CLI, retaining its real output and exit facts. */
export async function runTuicrCli({
  tuicrPath,
  args,
  cwd,
  env,
  logDirectory,
  commandKind,
  timeoutMs = 30_000,
} = {}) {
  if (!isAbsolute(tuicrPath)) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_binary_not_pinned",
      "tuicrPath must be an absolute pinned executable",
    );
  }
  const info = lstatSync(tuicrPath);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_binary_invalid",
      "tuicrPath must resolve to an executable regular file",
    );
  }
  if (!Array.isArray(args) || args.length === 0 ||
      args.some((arg) => typeof arg !== "string")) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_arguments_invalid",
      "tuicr arguments must be a non-empty string array",
    );
  }
  if (!isAbsolute(cwd) || !isAbsolute(logDirectory)) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_paths_invalid",
      "tuicr cwd and logDirectory must be absolute",
    );
  }
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const commandId = `${commandKind}-${randomUUID()}`;
  const stdoutFile = join(logDirectory, `${commandId}.stdout.log`);
  const stderrFile = join(logDirectory, `${commandId}.stderr.log`);
  const child = spawn(tuicrPath, args, {
    cwd,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    else child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const close = await waitForChild(child, timeoutMs);
  const stdoutText = redactText(Buffer.concat(stdout).toString("utf8"));
  const stderrText = redactText(Buffer.concat(stderr).toString("utf8"));
  writeFileSync(stdoutFile, stdoutText, { mode: 0o600 });
  writeFileSync(stderrFile, stderrText, { mode: 0o600 });
  const finishedAt = new Date().toISOString();
  const command = {
    schema: TUICR_COMMAND_SCHEMA,
    id: commandId,
    command_kind: commandKind,
    argv: [tuicrPath, ...args],
    cwd,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: close.exitCode,
    signal: close.signal,
    expected_exit_code: 0,
    expected_signal: null,
    timed_out: close.timedOut,
    logs: {
      stdout: logReference(stdoutFile, stdoutText, logDirectory),
      stderr: logReference(stderrFile, stderrText, logDirectory),
    },
  };
  return { command, stdout: stdoutText, stderr: stderrText };
}

function createContext(options) {
  const isolation = options.isolation;
  if (!isolation || typeof isolation !== "object") {
    throw new TuicrScenarioConfigurationError(
      "isolation_required",
      "tuicr scenario requires explicit qualification isolation",
    );
  }
  if (typeof isolation.worktree_root !== "string" ||
      !isAbsolute(isolation.worktree_root) ||
      typeof isolation.run_id !== "string") {
    throw new TuicrScenarioConfigurationError(
      "isolation_invalid",
      "tuicr scenario isolation must contain an absolute worktree root and run_id",
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
  if (typeof options.tuicrPath !== "string" || !isAbsolute(options.tuicrPath)) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_binary_not_pinned",
      "tuicrPath must be an explicit absolute executable path",
    );
  }
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const env = {
    ...isolatedQualificationEnvironment(isolation, options.baseEnvironment ?? process.env),
    XDG_DATA_HOME: join(isolation.qualification_workspace, "tuicr-data"),
    TUICR_NO_UPDATE_CHECK: "1",
  };
  const ownerPaths = flowOwnerPaths({
    env,
    authorityDirectory: isolation.authority_directory,
    endpointPath: isolation.endpoint_path,
    socketPath: isolation.socket_path,
  });
  return {
    options,
    isolation,
    isolationIdentity: qualificationIsolationIdentity(isolation),
    rawRoot,
    env,
    sessionPath: options.sessionPath === undefined ? null : resolve(options.sessionPath),
    ownerPaths,
    now: options.clock,
  };
}

async function validateSessionPath(context, sessionPath) {
  if (!isAbsolute(sessionPath)) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_session_not_isolated",
      "tuicr session path must be absolute",
    );
  }
  const resolved = await realpath(sessionPath).catch(() => null);
  if (resolved === null || !resolved.endsWith(".json")) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_session_unavailable",
      "tuicr session path must be an existing JSON file",
    );
  }
  const workspace = await realpath(context.isolation.qualification_workspace).catch(() => null);
  if (workspace === null || !isContained(workspace, resolved)) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_session_not_isolated",
      "tuicr session must be contained by the isolated qualification workspace",
    );
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new TuicrScenarioConfigurationError(
      "tuicr_session_not_regular",
      "tuicr session must be a regular file",
    );
  }
  context.sessionPath = resolved;
}

async function startPublicOwner(context, options) {
  if (options.client !== undefined) return { owner: null, client: options.client };
  const ownerRuntimeModule = options.ownerRuntimeModule ??
    resolve(import.meta.dirname, "../test-support/public-owner-runtime.mjs");
  if (!isAbsolute(ownerRuntimeModule) || !isContained(context.isolation.worktree_root, ownerRuntimeModule)) {
    throw new TuicrScenarioConfigurationError(
      "owner_runtime_not_pinned",
      "owner runtime module must be contained by the pinned worktree",
    );
  }
  const info = lstatSync(ownerRuntimeModule);
  if (!info.isFile()) {
    throw new TuicrScenarioConfigurationError(
      "owner_runtime_not_regular",
      "owner runtime module must be a regular file",
    );
  }
  const started = await startFlowOwner({
    env: {
      ...context.env,
      FLOW_OWNER_RUNTIME_MODULE: ownerRuntimeModule,
    },
    ...context.ownerPaths,
    ownerScript: resolve(context.isolation.worktree_root, "config/flow/src/owner-process.mjs"),
    waitMs: options.ownerWaitMs ?? 10_000,
    pollMs: 10,
  });
  return {
    owner: started,
    client: createFlowClient({ socketPath: context.ownerPaths.socketPath }),
  };
}

async function queryReviewInbox(client) {
  const value = await client.query({ schema: "flow.query/v1", query: "review_inbox" });
  if (value?.schema !== "flow.review-inbox-projection/v1" || !Array.isArray(value.items)) {
    throw new TuicrScenarioBlocked("review_inbox_invalid", "public FlowRuntime returned no review inbox projection");
  }
  return value;
}

async function queryReview(client, reviewId) {
  const value = await client.query({ contract: "work.review/v1", subject_id: reviewId });
  const projectedReviewId = value?.review_id ?? value?.subject_id;
  if (value?.schema !== "flow.review-projection/v1" || projectedReviewId !== reviewId) {
    throw new TuicrScenarioBlocked("review_projection_invalid", "public FlowRuntime returned no matching review projection");
  }
  return value.review_id === reviewId ? value : { ...value, review_id: reviewId };
}

async function runTuicrCommand(context, args, kind) {
  return runTuicrCli({
    tuicrPath: context.options.tuicrPath,
    args,
    cwd: context.isolation.repository_root,
    env: context.env,
    logDirectory: join(context.rawRoot, "logs"),
    commandKind: kind,
    timeoutMs: context.options.timeoutMs ?? 30_000,
  });
}

function parseTuicrList(stdout, sessionPath) {
  const rows = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = rows.find((row) => row.split("\t").at(-1)?.endsWith(sessionPath) ||
    row.includes(sessionPath));
  return {
    session_path: sessionPath,
    rows,
    found: match !== undefined,
    raw_digest: canonicalDigest(rows),
  };
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(String(stdout));
  } catch (error) {
    throw new TuicrScenarioBlocked("tuicr_output_invalid", `${label} output was not JSON`, {
      cause: error.message,
    });
  }
}

function validateProducerSeed(value) {
  if (!value || typeof value !== "object" ||
      typeof value.review_id !== "string" || !SESSION_ID.test(value.review_id)) {
    throw new TuicrScenarioBlocked("producer_seed_invalid", "producer did not return a review identity");
  }
}

function validateProducerExit(value) {
  if (!value || value.producer_exited !== true ||
      value.process_absence?.status !== "absent" ||
      typeof value.process_absence.process_identity !== "string" ||
      !RFC3339_UTC.test(value.producer_exited_at ?? "")) {
    throw new TuicrScenarioBlocked(
      "producer_exit_unproven",
      "producer adapter must return process-absence evidence before review consumption",
    );
  }
}

function validateConsumer(value, reviewId) {
  if (value.consumer !== "tuicr" || value.started !== true ||
      value.list.found !== true || !Array.isArray(value.comments)) {
    throw new TuicrScenarioBlocked(
      "tuicr_consumer_invalid",
      `tuicr list/comments did not resolve isolated review ${reviewId}`,
    );
  }
}

function validateApprovedProjection(value) {
  if (value?.schema !== "flow.review-projection/v1" ||
      !Array.isArray(value.dispositions) || value.dispositions.length === 0 ||
      !value.dispositions.some((entry) => entry?.disposition === "accept") ||
      value.approval !== "approved" ||
      value.approval_receipt?.schema !== "flow.review-approval/v1" ||
      value.approval_receipt.decision !== "approve") {
    throw new TuicrScenarioBlocked(
      "review_approval_unproven",
      "public FlowRuntime did not expose accepted dispositions and an approval receipt",
    );
  }
}

function findInboxItem(inbox, reviewId) {
  return inbox.items.find((item) => item?.review_id === reviewId) ?? null;
}

function findAction(review, type, decision = undefined) {
  return review.legal_actions?.find((action) =>
    action?.type === type && (decision === undefined || action.decision === decision)) ?? null;
}

function actionTypes(review) {
  return Array.isArray(review?.legal_actions)
    ? review.legal_actions.map(({ type }) => type)
    : [];
}

function materializeAction(action, values) {
  const { operator_input: _operatorInput, ...command } = action;
  return { ...command, ...values };
}

function requireAccepted(value, label) {
  if (value?.accepted !== true) {
    throw new TuicrScenarioBlocked(
      `${label.replaceAll(" ", "_")}_rejected`,
      `${label} was not accepted by public FlowRuntime`,
      { receipt: redactQualificationCapture(value) },
    );
  }
}

function validateStaleReceipt(value) {
  if (value?.schema !== "work.rejection/v1" ||
      !["stale_review_generation", "stale_review_watermark"].includes(value.code) ||
      value.accepted === true) {
    throw new TuicrScenarioBlocked(
      "stale_action_not_rejected",
      "a copied review action was not rejected as stale",
    );
  }
}

function observation(kind, content) {
  const safeContent = redactQualificationCapture(structuredClone(content));
  return {
    id: `observation:${kind}:${randomUUID()}`,
    kind,
    content: safeContent,
    content_digest: canonicalDigest(safeContent),
  };
}

function capture(kind, value, provenance) {
  const safeValue = redactQualificationCapture(structuredClone(value));
  return {
    id: `capture:${kind}:${randomUUID()}`,
    kind,
    format: "json",
    provenance,
    value: safeValue,
    sha256: `sha256:${createHash("sha256").update(JSON.stringify(safeValue)).digest("hex")}`,
  };
}

function extractWatermark(value) {
  for (const candidate of [value?.watermark, value?.authority_watermark, value?.review_watermark]) {
    if (typeof candidate === "string" && DIGEST.test(candidate)) return candidate;
    if (candidate?.content_sha256 && DIGEST.test(candidate.content_sha256)) return candidate.content_sha256;
  }
  return null;
}

function identityProjection(value) {
  return {
    review_id: value?.review_id,
    candidate_fingerprint: value?.candidate_fingerprint,
    lifecycle_generation: value?.lifecycle_generation,
    review_generation: value?.review_generation,
    watermark: extractWatermark(value),
  };
}

async function cleanupOwned(context, options) {
  if (options.cleanupIsolation === false) return notStartedCleanup();
  try {
    return cleanupQualificationIsolation(context.isolation);
  } catch (error) {
    return {
      disposition: "blocked",
      owned_resources: [],
      resource_dispositions: [],
      unresolved_obligations: [{ code: "cleanup_failed", detail: error.message }],
      completed_at: new Date().toISOString(),
    };
  }
}

function blockedResult(options, startedAt, error) {
  const reason = error?.code ?? "configuration_invalid";
  const context = options?.isolation && options?.rawRoot
    ? { isolation: options.isolation, rawRoot: options.rawRoot, isolationIdentity: null }
    : null;
  return Object.freeze({
    schema: TUICR_SCENARIO_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: TUICR_SCENARIO_ID,
    status: "blocked",
    reason,
    started_at: startedAt,
    finished_at: startedAt,
    run_id: options?.isolation?.run_id ?? null,
    isolation_identity: context?.isolationIdentity,
    observations: [],
    captures: [],
    commands: [],
    cleanup: notStartedCleanup(),
    error: normalizeError(error),
  });
}

function finishBlocked(context, startedAt, error) {
  const finishedAt = now(context.now);
  return Object.freeze({
    ...baseResult(context, startedAt, finishedAt),
    status: "blocked",
    reason: error.code ?? "blocked",
    observations: [],
    captures: [],
    commands: [],
    cleanup: notStartedCleanup(),
    error: normalizeError(error),
  });
}

function baseResult(context, startedAt, finishedAt) {
  return {
    schema: TUICR_SCENARIO_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: TUICR_SCENARIO_ID,
    execution_kind: "live_public_process",
    run_id: context.isolation.run_id,
    isolation_identity: context.isolationIdentity,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function notStartedCleanup() {
  return {
    disposition: "not_started",
    owned_resources: [],
    resource_dispositions: [],
    unresolved_obligations: [],
    completed_at: null,
  };
}

function normalizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "scenario_failed",
    message: redactText(error?.message ?? String(error)),
  };
}

function logReference(path, text, directory) {
  return {
    path: relative(directory, path),
    sha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    bytes: Buffer.byteLength(text),
  };
}

function redactText(value) {
  return String(value).replace(
    /((?:api[_-]?key|authorization|credential|password|secret|private[_-]?key|token)\s*[:=]\s*)([^\s,;}]+)/giu,
    "$1[REDACTED]",
  );
}

function now(clock) {
  return typeof clock === "function" ? clock() : new Date().toISOString();
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    let timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveResult({ exitCode: null, signal: "SIGTERM", timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode, signal, timedOut: false });
    });
  });
}

function isContained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel);
}
