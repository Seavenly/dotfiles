import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  cleanupQualificationIsolation,
  isolatedQualificationEnvironment,
} from "./host-recovery-qualification.mjs";
import {
  runTuicrReviewAfterProducerExit,
} from "./host-recovery-tuicr-scenario.mjs";
import {
  initializePublicReviewRepository,
} from "../test-support/public-review-seed.mjs";
import {
  startFlowOwner,
} from "./owner-process.mjs";

export const TUICR_LIVE_INTEGRATION_SCHEMA =
  "flow.host-recovery-tuicr-live-integration/v1";
export const TUICR_PRODUCER_SEED_SCHEMA =
  "flow.host-recovery-tuicr-producer-seed/v1";
export const TUICR_PTY_COMMAND_SCHEMA = "flow.tuicr-pty-command/v1";
export const DEFAULT_SCRIPT_PATH = "/usr/bin/script";

const RUN_ID = /^run:[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/u;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PRODUCER_TIMEOUT_MS = 120_000;
const TUI_TIMEOUT_MS = 30_000;
const TUI_READY_PATTERN = /(?:tuicr-session:|NORMAL)/u;
const PINNED_TUICR_PATH = /github-agavra-tuicr[\\/]0\.19\.0[\\/]tuicr$/u;

export class TuicrLiveIntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TuicrLiveIntegrationError";
    this.code = code;
    this.details = details;
  }
}

export class TuicrLiveIntegrationBlocked extends TuicrLiveIntegrationError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "TuicrLiveIntegrationBlocked";
  }
}

/**
 * Run the issue-46 Tuicr path against a real isolated review session.
 *
 * The session is created by the pinned TUI in a real PTY. The producer is a
 * separate Node process running the production seed, and the existing
 * host-recovery scenario then starts the public owner, invokes the real Tuicr
 * review commands after producer exit, applies FlowRuntime review actions,
 * rejects a stale action, and rebuilds the owner projection.
 */
export async function runTuicrLiveIntegration(options = {}) {
  const startedAt = new Date().toISOString();
  let isolation = options.isolation;
  let rawRoot = options.rawRoot;
  let scenario = null;
  let tuiSeed = null;
  let producer = null;
  let cleanup = null;
  let prepared = false;
  try {
    const context = await prepareIntegrationContext(options);
    isolation = context.isolation;
    rawRoot = context.rawRoot;
    prepared = true;
    const env = {
      ...context.env,
      FLOW_PUBLIC_REPOSITORY: isolation.repository_root,
    };
    await preparePinnedDrovrConfig(isolation);
    await mkdir(isolation.repository_root, { recursive: true, mode: 0o700 });
    await writeFile(join(isolation.repository_root, "tuicr-seed.txt"), "before\n", {
      mode: 0o600,
    });
    await initializePublicReviewRepository(isolation.repository_root);
    await writeFile(join(isolation.repository_root, "tuicr-seed.txt"), "after\n", {
      mode: 0o600,
    });

    const tuicrPath = resolvePinnedTuicrPath(options.tuicrPath);
    const scriptPath = resolvePinnedExecutable(
      options.ptyScriptPath ?? DEFAULT_SCRIPT_PATH,
      "ptyScriptPath",
    );
    tuiSeed = await seedTuicrSession({
      isolation,
      rawRoot,
      env,
      tuicrPath,
      scriptPath,
      draftComment: options.draftComment ??
        "issue-46 qualification draft created by the real tuicr TUI",
      timeoutMs: options.tuiTimeoutMs ?? TUI_TIMEOUT_MS,
    });
    commitTuicrSeed(isolation.repository_root);
    const producerAdapter = createProductionProducerAdapter({
      isolation,
      rawRoot,
      env,
      worktreeRoot: isolation.worktree_root,
      producerScriptPath: options.producerScriptPath,
      timeoutMs: options.producerTimeoutMs ?? PRODUCER_TIMEOUT_MS,
    });
    const ownerRuntimeModule = options.ownerRuntimeModule ?? join(
      isolation.worktree_root,
      "config/flow/test-support/public-owner-runtime.mjs",
    );
    const scenarioProducer = prestartingProducerAdapter({
      producer: producerAdapter,
      isolation,
      env,
      ownerRuntimeModule,
    });
    scenario = await runTuicrReviewAfterProducerExit({
      ...options,
      isolation,
      rawRoot,
      env,
      baseEnvironment: options.baseEnvironment ?? process.env,
      tuicrPath,
      sessionPath: tuiSeed.session_path,
      ownerRuntimeModule,
      producer: scenarioProducer,
      cleanupIsolation: options.cleanupIsolation ?? true,
    });
    producer = producerAdapter.lastReceipt();
    cleanup = scenario.cleanup;
    const operatorInputs = projectOperatorInputs({ scenario, tuiSeed, producer });
    return Object.freeze({
      schema: TUICR_LIVE_INTEGRATION_SCHEMA,
      version: 1,
      issue: 46,
      scenario_id: scenario.scenario_id,
      status: scenario.status,
      reason: scenario.reason,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      scenario,
      tui_seed: tuiSeed,
      producer,
      operator_inputs: operatorInputs,
      cleanup,
    });
  } catch (error) {
    const normalized = normalizeError(error);
    if (prepared && (options.cleanupIsolation ?? true) && isolation !== undefined &&
        scenario === null) {
      cleanup = tryCleanup(isolation);
    }
    return Object.freeze({
      schema: TUICR_LIVE_INTEGRATION_SCHEMA,
      version: 1,
      issue: 46,
      scenario_id: "tuicr_review_after_producer_exit",
      status: error instanceof TuicrLiveIntegrationBlocked ? "blocked" : "fail",
      reason: normalized.code,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      scenario: null,
      tui_seed: tuiSeed,
      producer,
      cleanup: cleanup ?? notStartedCleanup(),
      error: normalized,
    });
  }
}

function prestartingProducerAdapter({
  producer,
  isolation,
  env,
  ownerRuntimeModule,
}) {
  return {
    async seed(input) {
      const seeded = await producer.seed(input);
      await startFlowOwner({
        env: { ...env, FLOW_OWNER_RUNTIME_MODULE: ownerRuntimeModule },
        authorityDirectory: isolation.authority_directory,
        endpointPath: isolation.endpoint_path,
        socketPath: isolation.socket_path,
        ownerScript: join(isolation.worktree_root, "config/flow/src/owner-process.mjs"),
      });
      return seeded;
    },
    close(input) {
      return producer.close(input);
    },
  };
}

function commitTuicrSeed(repository) {
  try {
    execFileSync("git", ["-C", repository, "add", "tuicr-seed.txt"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["-C", repository, "commit", "--quiet", "-m", "retain tuicr qualification seed"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new TuicrLiveIntegrationError(
      "tuicr_seed_commit_failed",
      `the isolated Tuicr seed could not be committed before production work: ${error.message}`,
    );
  }
}

async function preparePinnedDrovrConfig(isolation) {
  const source = join(isolation.worktree_root, "config", "drovr");
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new TuicrLiveIntegrationError(
      "drovr_config_invalid",
      "the pinned Drovr configuration must be a real directory",
    );
  }
  try {
    await cp(source, isolation.drovr_config_directory, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } catch (error) {
    throw new TuicrLiveIntegrationError(
      "drovr_config_copy_failed",
      `the pinned Drovr configuration could not be copied into isolation: ${error.message}`,
    );
  }
}

/**
 * Create a real Tuicr session and one local draft comment through the TUI.
 * This function never writes a Tuicr session file itself.
 */
export async function seedTuicrSession({
  isolation,
  rawRoot,
  env,
  tuicrPath = undefined,
  scriptPath = DEFAULT_SCRIPT_PATH,
  draftComment,
  timeoutMs = TUI_TIMEOUT_MS,
} = {}) {
  assertAbsoluteIsolation(isolation);
  const root = assertExternalQualificationRoot(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(root, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  const pinnedTuicrPath = resolvePinnedTuicrPath(tuicrPath);
  const pinnedScriptPath = resolvePinnedExecutable(scriptPath, "scriptPath");
  if (typeof draftComment !== "string" || draftComment.trim().length < 8 ||
      draftComment.includes("\n") || draftComment.includes("\r")) {
    throw new TuicrLiveIntegrationError(
      "draft_comment_invalid",
      "the PTY seed comment must be one non-empty line",
    );
  }
  if (!isAbsolute(isolation.repository_root)) {
    throw new TuicrLiveIntegrationError(
      "repository_path_invalid",
      "the Tuicr seed repository must be absolute",
    );
  }
  const dataHome = join(isolation.qualification_workspace, "tuicr-data");
  const logDirectory = join(root, "tuicr-seed");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const command = await runTuicrTuiInPty({
    scriptPath: pinnedScriptPath,
    tuicrPath: pinnedTuicrPath,
    repository: isolation.repository_root,
    env: {
      ...env,
      HOME: isolation.qualification_workspace,
      XDG_DATA_HOME: dataHome,
      TUICR_NO_UPDATE_CHECK: "1",
      TERM: env?.TERM ?? "xterm-256color",
    },
    draftComment,
    cwd: isolation.repository_root,
    logDirectory,
    timeoutMs,
  });
  if (command.exit_code !== 0 || command.signal !== null || command.timed_out) {
    throw new TuicrLiveIntegrationBlocked(
      "tuicr_pty_seed_failed",
      "the real tuicr TUI did not exit successfully after saving its draft",
      { command },
    );
  }
  const session = await discoverSeededSession({
    dataHome,
    repository: isolation.repository_root,
    workspace: isolation.qualification_workspace,
    draftComment,
  });
  return Object.freeze({
    schema: "tuicr.review-session-seed/v1",
    consumer: "tuicr",
    session_path: session.path,
    session_id: session.value.id,
    repository: isolation.repository_root,
    comment_count: session.commentCount,
    comment_digest: canonicalDigest(session.comments),
    command,
  });
}

/** Resolve the exact regular executable used for the Tuicr observation. */
export function resolvePinnedTuicrPath(path = undefined) {
  const candidate = path ?? executableOnPath("tuicr", (resolved) =>
    PINNED_TUICR_PATH.test(resolved));
  const resolved = resolvePinnedExecutable(candidate, "tuicrPath");
  if (!PINNED_TUICR_PATH.test(resolved)) {
    throw new TuicrLiveIntegrationError(
      "tuicr_version_not_pinned",
      "the issue-46 live path requires the pinned tuicr 0.19.0 executable",
      { path: resolved },
    );
  }
  let version;
  try {
    version = execFileSync(resolved, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new TuicrLiveIntegrationError(
      "tuicr_version_unavailable",
      `the pinned tuicr executable could not report its version: ${error.message}`,
      { path: resolved },
    );
  }
  if (version !== "tuicr 0.19.0") {
    throw new TuicrLiveIntegrationError(
      "tuicr_version_mismatch",
      `the pinned tuicr executable reported ${version || "no version"}`,
      { path: resolved, version },
    );
  }
  return resolved;
}

function executableOnPath(name, accept = () => true) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      const resolved = realpathSync(candidate);
      const info = lstatSync(resolved);
      if (info.isFile() && (info.mode & 0o111) !== 0 && accept(resolved)) return resolved;
    } catch {
      // Continue through PATH until an executable regular file is found.
    }
  }
  throw new TuicrLiveIntegrationError(
    "tuicr_executable_unavailable",
    "tuicr is not available on PATH and no explicit tuicrPath was provided",
  );
}

/**
 * Run the production review seed in a separate process and prove that its
 * process identity is absent before the consumer is allowed to start.
 */
export function createProductionProducerAdapter({
  isolation,
  rawRoot,
  env,
  worktreeRoot,
  producerScriptPath = undefined,
  timeoutMs = PRODUCER_TIMEOUT_MS,
} = {}) {
  assertAbsoluteIsolation(isolation);
  const root = assertExternalQualificationRoot(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(root, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  const scriptPath = resolvePinnedProducerScript(
    producerScriptPath ?? join(worktreeRoot ?? isolation.worktree_root,
      "config/flow/scripts/run-host-recovery-tuicr-live-probe.mjs"),
    isolation.worktree_root,
  );
  let receipt = null;
  return {
    async seed() {
      receipt = await runProductionSeedSubprocess({
        isolation,
        rawRoot: root,
        env,
        producerScriptPath: scriptPath,
        timeoutMs,
      });
      return {
        review_id: receipt.review_id,
        producer_exit: receipt,
      };
    },
    async close() {
      // The producer subprocess is already reaped and absent before seed()
      // resolves. The hook exists to satisfy the existing scenario seam.
    },
    lastReceipt() {
      return receipt;
    },
  };
}

/** Entry point used by the producer child script. */
export async function runProductionSeedChild({ inputPath, outputPath } = {}) {
  const input = await readJsonFile(inputPath, "producer input");
  if (!input?.isolation || typeof input.environment !== "object" ||
      typeof input.repository !== "string" ||
      input.repository !== input.isolation.repository_root) {
    throw new TuicrLiveIntegrationError(
      "producer_input_invalid",
      "producer input must bind one repository to the explicit isolation",
    );
  }
  const { seedPublicReview } = await import("../test-support/public-review-seed.mjs");
  const seeded = await seedPublicReview({
    authorityDirectory: input.isolation.authority_directory,
    env: {
      ...input.environment,
      FLOW_PUBLIC_REPOSITORY: input.repository,
    },
    repository: input.repository,
  });
  const reviewId = seeded.review?.review_id ?? seeded.review?.subject_id;
  if (typeof reviewId !== "string" || !SESSION_ID.test(reviewId)) {
    throw new TuicrLiveIntegrationError(
      "producer_seed_invalid",
      "production seed returned no valid review identity",
    );
  }
  const result = {
    schema: TUICR_PRODUCER_SEED_SCHEMA,
    version: 1,
    pid: process.pid,
    process_identity: `node-production-review-seed:${process.pid}`,
    review_id: reviewId,
    candidate_fingerprint: seeded.candidate?.candidate_fingerprint ?? null,
    seeded_at: new Date().toISOString(),
  };
  await writeFile(outputPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

function resolvePinnedProducerScript(path, worktreeRoot) {
  const resolved = resolvePinnedExecutable(path, "producerScriptPath");
  if (!isContained(worktreeRoot, resolved)) {
    throw new TuicrLiveIntegrationError(
      "producer_script_not_pinned",
      "producer script must be contained by the pinned worktree",
    );
  }
  return resolved;
}

async function prepareIntegrationContext(options) {
  if (!options.isolation) {
    throw new TuicrLiveIntegrationError(
      "isolation_required",
      "Tuicr live integration requires explicit qualification isolation",
    );
  }
  assertAbsoluteIsolation(options.isolation);
  const rawRoot = assertExternalQualificationRoot(options.rawRoot, {
    worktreeRoot: options.isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(rawRoot, {
    worktreeRoot: options.isolation.worktree_root,
    isolation: options.isolation,
    label: "rawRoot",
  });
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  await mkdir(options.isolation.qualification_workspace, { recursive: true, mode: 0o700 });
  const env = {
    ...isolatedQualificationEnvironment(
      options.isolation,
      options.baseEnvironment ?? process.env,
    ),
    FLOW_PUBLIC_REPOSITORY: options.isolation.repository_root,
  };
  return { isolation: options.isolation, rawRoot, env };
}

async function runProductionSeedSubprocess({
  isolation,
  rawRoot,
  env,
  producerScriptPath,
  timeoutMs,
}) {
  const id = randomUUID();
  const inputPath = join(rawRoot, `producer-${id}.input.json`);
  const outputPath = join(rawRoot, `producer-${id}.output.json`);
  const logDirectory = join(rawRoot, "producer");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await writeFile(inputPath, `${JSON.stringify({
    schema: "flow.host-recovery-tuicr-producer-input/v1",
    isolation,
    repository: isolation.repository_root,
    environment: env,
  })}\n`, { flag: "wx", mode: 0o600 });
  const command = [
    process.execPath,
    producerScriptPath,
    "--producer",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ];
  const child = spawn(command[0], command.slice(1), {
    cwd: isolation.worktree_root,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processId = child.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new TuicrLiveIntegrationError(
      "producer_pid_unavailable",
      "producer subprocess did not expose a valid PID",
    );
  }
  const close = await waitForProcess(child, timeoutMs, "producer");
  const processIdentity = `node-production-review-seed:${processId}`;
  const absence = proveProcessAbsent(processId);
  if (absence.status !== "absent") {
    throw new TuicrLiveIntegrationError(
      "producer_process_present",
      "producer process remained present after its subprocess exit",
      { process_identity: processIdentity, absence },
    );
  }
  const stdoutPath = join(logDirectory, `${id}.stdout.log`);
  const stderrPath = join(logDirectory, `${id}.stderr.log`);
  await writeFile(stdoutPath, close.stdout, { mode: 0o600 });
  await writeFile(stderrPath, close.stderr, { mode: 0o600 });
  if (close.exitCode !== 0 || close.signal !== null || close.timedOut) {
    throw new TuicrLiveIntegrationError(
      "producer_seed_failed",
      "production producer subprocess did not complete successfully",
      { command, close, process_identity: processIdentity },
    );
  }
  const seeded = await readJsonFile(outputPath, "producer output");
  if (seeded.schema !== TUICR_PRODUCER_SEED_SCHEMA ||
      typeof seeded.review_id !== "string" || !SESSION_ID.test(seeded.review_id) ||
      seeded.pid !== processId || seeded.process_identity !== processIdentity) {
    throw new TuicrLiveIntegrationError(
      "producer_output_invalid",
      "producer output did not bind a production review to the exited PID",
    );
  }
  const exitedAt = new Date().toISOString();
  return {
    schema: "flow.host-recovery-producer-exit/v1",
    review_id: seeded.review_id,
    candidate_fingerprint: seeded.candidate_fingerprint,
    producer_exited: true,
    producer_exited_at: exitedAt,
    process_absence: {
      status: "absent",
      method: absence.method,
      pid: processId,
      process_identity: processIdentity,
    },
    command: makeCommandObservation({
      commandKind: "production_review_seed",
      argv: command,
      cwd: isolation.worktree_root,
      startedAt: close.startedAt,
      finishedAt: close.finishedAt,
      exitCode: close.exitCode,
      signal: close.signal,
      timedOut: close.timedOut,
      stdoutPath,
      stderrPath,
      logDirectory,
      stdout: close.stdout,
      stderr: close.stderr,
    }),
  };
}

async function runTuicrTuiInPty({
  scriptPath,
  tuicrPath,
  repository,
  env,
  draftComment,
  cwd,
  logDirectory,
  timeoutMs,
}) {
  const id = `tuicr-tui-${randomUUID()}`;
  const stdoutPath = join(logDirectory, `${id}.stdout.log`);
  const stderrPath = join(logDirectory, `${id}.stderr.log`);
  const startedAt = new Date().toISOString();
  const shellCommand = [
    `cd ${shellQuote(repository)}`,
    `exec ${shellQuote(tuicrPath)} tui --working-tree --no-update-check`,
  ].join(" && ");
  const child = spawn(scriptPath, ["-qfec", shellCommand, stdoutPath], {
    cwd,
    env: { ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  try {
    await waitForOutput(child, TUI_READY_PATTERN, timeoutMs, stdout);
    await delay(500);
    child.stdin.write("jjjjc");
    await delay(250);
    child.stdin.write(draftComment);
    await delay(250);
    child.stdin.write("\x13");
    await delay(500);
    child.stdin.write("q");
    const close = await waitForProcess(child, timeoutMs, "tuicr TUI");
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const stderrText = Buffer.concat(stderr).toString("utf8");
    const transcript = await readFile(stdoutPath, "utf8").catch(() => stdoutText);
    await writeFile(stderrPath, stderrText, { mode: 0o600 });
    return makeCommandObservation({
      commandKind: "tuicr_tui_seed",
      argv: [scriptPath, "-qfec", shellCommand, stdoutPath],
      cwd,
      startedAt,
      finishedAt: close.finishedAt,
      exitCode: close.exitCode,
      signal: close.signal,
      timedOut: close.timedOut,
      stdoutPath,
      stderrPath,
      logDirectory,
      stdout: transcript,
      stderr: stderrText,
    });
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function discoverSeededSession({ dataHome, repository, workspace, draftComment }) {
  const indexPath = join(dataHome, "tuicr", "reviews", "index.json");
  const index = await readJsonFile(indexPath, "tuicr index");
  const candidates = [];
  for (const entries of Object.values(index.entries ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.kind?.type !== "local" || entry.canonical_repo_path !== repository ||
          typeof entry.path !== "string" || entry.comment_count < 1) continue;
      const path = resolve(dataHome, "tuicr", "reviews", entry.path);
      if (!isContained(workspace, path) || !path.endsWith(".json")) continue;
      candidates.push({ entry, path });
    }
  }
  if (candidates.length !== 1) {
    throw new TuicrLiveIntegrationBlocked(
      "tuicr_session_seed_unproven",
      "the real TUI did not create exactly one isolated local session with a draft",
      { candidate_count: candidates.length },
    );
  }
  const [candidate] = candidates;
  const sessionPath = await realpath(candidate.path).catch(() => null);
  if (sessionPath === null || !isContained(workspace, sessionPath)) {
    throw new TuicrLiveIntegrationBlocked(
      "tuicr_session_not_isolated",
      "the TUI session path was not contained by the isolated qualification workspace",
    );
  }
  const value = await readJsonFile(sessionPath, "tuicr session");
  const comments = collectSessionComments(value);
  if (!comments.some((comment) => comment?.lifecycle_state === "local_draft" &&
      comment.content === draftComment)) {
    throw new TuicrLiveIntegrationBlocked(
      "tuicr_draft_not_persisted",
      "the real TUI exited without persisting the expected local draft comment",
    );
  }
  return { path: sessionPath, value, comments, commentCount: comments.length };
}

function collectSessionComments(session) {
  const comments = [...(Array.isArray(session.review_comments) ? session.review_comments : [])];
  for (const file of Object.values(session.files ?? {})) {
    if (Array.isArray(file?.file_comments)) comments.push(...file.file_comments);
    for (const values of Object.values(file?.line_comments ?? {})) {
      if (Array.isArray(values)) comments.push(...values);
    }
  }
  return comments;
}

/** Project the real integration output into the existing operator-driver seam. */
function projectOperatorInputs({ scenario, tuiSeed, producer }) {
  const approved = scenario.captures?.find(({ kind }) => kind === "review-approved")?.value;
  const disposition = scenario.observations?.find(({ kind }) => kind === "disposition")?.content;
  const review = approved === undefined || approved === null
    ? null
    : {
        ...approved,
        ...(disposition === undefined ? {} : {
          disposition_receipt: disposition.disposition_receipt,
          approval_command_receipt: disposition.approval_command_receipt,
        }),
      };
  const consumer = scenario.consumer;
  return {
    producer_exit: scenario.producer_exit?.content ?? producer?.producer_exit ?? null,
    consumer: consumer === undefined ? null : {
      schema: "tuicr.review-consumer-observation/v1",
      consumer: "tuicr",
      started: consumer.started === true,
      session_id: tuiSeed.session_id,
      session_path: tuiSeed.session_path,
      list: {
        session_id: tuiSeed.session_id,
        review_id: producer?.review_id ?? null,
        found: consumer.list.found === true,
        raw_digest: consumer.list.raw_digest,
      },
      comments: {
        session_id: tuiSeed.session_id,
        review_id: producer?.review_id ?? null,
        count: Array.isArray(consumer.comments) ? consumer.comments.length : 0,
        raw_digest: canonicalDigest(consumer.comments),
      },
    },
    review,
    assertions: scenario.assertions ?? null,
    stale_action: scenario.stale_action?.content ?? null,
    rebuild: scenario.rebuild?.content ?? null,
  };
}

function waitForOutput(child, pattern, timeoutMs, chunks) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const onData = () => {
      if (pattern.test(Buffer.concat(chunks).toString("utf8"))) finish();
    };
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        finish(new TuicrLiveIntegrationBlocked(
          "tuicr_pty_seed_timeout",
          "timed out waiting for the tuicr TUI interactive screen",
        ));
      }
    }, 50);
    const finish = (error = undefined) => {
      clearInterval(timer);
      child.stdout.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) reject(error);
      else resolveResult();
    };
    const onClose = () => finish(new TuicrLiveIntegrationError(
      "tuicr_pty_closed_before_ready",
      "the tuicr TUI closed before exposing its interactive screen",
    ));
    const onError = (error) => finish(new TuicrLiveIntegrationError(
      "tuicr_pty_spawn_failed",
      `the tuicr PTY utility failed: ${error.message}`,
    ));
    child.stdout.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
    onData();
  });
}

function waitForProcess(child, timeoutMs, label) {
  const startedAt = new Date().toISOString();
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  child.stdout?.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolveResult, reject) => {
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new TuicrLiveIntegrationError(
        `${label.replaceAll(" ", "_")}_spawn_failed`,
        `${label} subprocess failed to start: ${error.message}`,
      ));
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function proveProcessAbsent(pid) {
  try {
    process.kill(pid, 0);
    return { status: "present", method: "kill_0" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { status: "absent", method: "waited_child_and_kill_0_esrch" };
    }
    return { status: "unknown", method: "kill_0_error", error: error?.code ?? "unknown" };
  }
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveTermination) => {
    let killed = false;
    const finish = () => {
      clearTimeout(timer);
      resolveTermination();
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 2_000);
    child.once("close", finish);
    child.kill("SIGTERM");
    // A process can close between the state check and listener registration.
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!killed) finish();
    }
  });
}

function makeCommandObservation({
  commandKind,
  argv,
  cwd,
  startedAt,
  finishedAt,
  exitCode,
  signal,
  timedOut,
  stdoutPath,
  stderrPath,
  logDirectory,
  stdout,
  stderr,
}) {
  return {
    schema: TUICR_PTY_COMMAND_SCHEMA,
    id: `${commandKind}:${randomUUID()}`,
    command_kind: commandKind,
    argv,
    cwd,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: exitCode,
    signal,
    expected_exit_code: 0,
    expected_signal: null,
    timed_out: Boolean(timedOut),
    logs: {
      stdout: logDescriptor(stdoutPath, stdout, logDirectory),
      stderr: logDescriptor(stderrPath, stderr, logDirectory),
    },
  };
}

function logDescriptor(path, value, directory) {
  return {
    path: relative(directory, path),
    sha256: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    bytes: Buffer.byteLength(value),
  };
}

function resolvePinnedExecutable(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TuicrLiveIntegrationError("executable_not_pinned", `${label} must be absolute`);
  }
  const resolved = realpathSync(path);
  const info = lstatSync(resolved);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new TuicrLiveIntegrationError(
      "executable_invalid",
      `${label} must resolve to an executable regular file`,
    );
  }
  return resolved;
}

function assertAbsoluteIsolation(isolation) {
  if (!isolation || typeof isolation !== "object" ||
      ["worktree_root", "repository_root", "qualification_workspace",
        "authority_directory", "socket_path", "endpoint_path", "xdg_state_home",
        "backup_directory", "drovr_config_directory"].some((field) =>
        typeof isolation[field] !== "string" || !isAbsolute(isolation[field])) ||
      typeof isolation.run_id !== "string" || !RUN_ID.test(isolation.run_id)) {
    throw new TuicrLiveIntegrationError(
      "isolation_invalid",
      "Tuicr live integration requires a complete explicit qualification isolation",
    );
  }
}

function isContained(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TuicrLiveIntegrationError("shell_argument_invalid", "PTY command arguments cannot contain newlines");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readJsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TuicrLiveIntegrationError("json_read_failed", `${label} could not be read: ${error.message}`);
  }
}

function normalizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "tuicr_live_integration_failed",
    message: String(error?.message ?? error),
    details: error?.details ?? {},
  };
}

function tryCleanup(isolation) {
  try {
    return cleanupQualificationIsolation(isolation);
  } catch (error) {
    return {
      ...notStartedCleanup(),
      disposition: "blocked",
      unresolved_obligations: [{ code: "cleanup_failed", detail: error.message }],
      completed_at: new Date().toISOString(),
    };
  }
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
