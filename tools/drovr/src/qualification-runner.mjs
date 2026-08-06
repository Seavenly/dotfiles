import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, hostname, platform, tmpdir, uptime } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { digestCanonical } from "./canonical-json.mjs";
import { PUBLIC_QUALIFICATION_POLICY } from "./qualification-policy.mjs";
import {
  COMPATIBILITY_FEATURES,
  COMPATIBILITY_SCHEMA,
  PRODUCTION_ADAPTER_ID,
  qualifyCompatibility,
} from "./compatibility.mjs";
import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "./qualification-catalog.mjs";
import {
  QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
} from "./qualification-contracts.mjs";
import { CLEANUP_LIMIT_MS } from "./qualification-process.mjs";
import {
  QUALIFICATION_TRUST_SCHEMA,
  preflightQualificationTrust,
  readNativeTrustSource,
  trustPreflightBinding,
  trustPreflightBlocked,
  trustPreflightNotApplicable,
  trustPreflightNotRun,
  trustPreflightReady,
} from "./qualification-trust.mjs";
import { runTraceFixture } from "./qualification-replay.mjs";
import { loadTraceFixture } from "./qualification-traces.mjs";
import {
  stateSequenceAntiReplayGap,
} from "./qualification-state-sequence.mjs";
import {
  traceFromJournal,
  traceJournalFailurePath,
  validateTrace,
} from "./trace.mjs";

const execFileAsync = promisify(execFileCallback);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMMAND_EXIT_GRACE_MS = 5_000;
const OBSERVATION_COMMAND_LIMIT_MS = 5_000;
const SETUP_COMMAND_LIMIT_MS = 10_000;
const QUALIFICATION_BOOT_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const activeChildren = new Set();
const terminatingChildren = new Map();
const interruptionWaiters = new Set();
let interruptionRequested = false;
const correctionReviewPrompt = (expected) =>
  `This is the ordered correction and re-review qualification sentinel.\nReview the correction on the same request, then reply exactly:\n${expected}\n`;
const scenarioExecutors = new Map([
  ["codex_live_prompt_sources_and_reuse", runCodexPromptScenario],
  ["codex_live_lifecycle_recovery", runCodexLifecycleScenario],
  ["codex_soak_reusable_review_cycle", runPromptFileScenario],
  ["claude_multiline_paste_conversion", runPromptFileScenario],
  ["claude_long_single_line_paste_conversion", runPromptFileScenario],
  ["claude_soak_multiline_reuse", runPromptFileScenario],
  ["claude_soak_long_reuse", runPromptFileScenario],
  ["claude_owned_staged_input_submit", runPromptFileScenario],
  ["claude_unknown_staged_input_clear_and_reuse", runUnknownStagedInputScenario],
  ["claude_staged_input_transient_clear_reappears", runUnknownStagedInputScenario],
]);
const promptFileSpecifications = new Map([
  [
    "codex_soak_reusable_review_cycle",
    {
      harness: "codex",
      expectedResponse: "QUALIFY-CODEX-SOAK-INITIAL-OK",
      reuseResponse: "QUALIFY-CODEX-SOAK-REVIEW-OK",
      reuseAfterCompletion: true,
      reusePrompt: correctionReviewPrompt,
      prompt: (expected) =>
        `This is a qualification review sentinel.\nReply exactly:\n${expected}\n`,
    },
  ],
  [
    "claude_multiline_paste_conversion",
    {
      harness: "claude",
      expectedResponse: "QUALIFY-CLAUDE-MULTILINE-OK",
      prompt: (expected) =>
        `This is a qualification sentinel.\nReply exactly:\n${expected}\n`,
    },
  ],
  [
    "claude_long_single_line_paste_conversion",
    {
      harness: "claude",
      expectedResponse: "QUALIFY-CLAUDE-LONG-OK",
      prompt: (expected) =>
        `Context marker: ${"x".repeat(2_400)}. Reply exactly: ${expected}\n`,
    },
  ],
  [
    "claude_owned_staged_input_submit",
    {
      harness: "claude",
      expectedResponse: "QUALIFY-CLAUDE-OWNED-STAGED-OK",
      ownedRecovery: true,
      prompt: (expected) =>
        `This is a qualification sentinel.\nReply exactly:\n${expected}\n`,
    },
  ],
  [
    "claude_soak_multiline_reuse",
    {
      harness: "claude",
      expectedResponse: "QUALIFY-CLAUDE-SOAK-MULTILINE-OK",
      reuseResponse: "QUALIFY-CLAUDE-SOAK-REVIEW-OK",
      reuseAfterCompletion: true,
      reusePrompt: correctionReviewPrompt,
      prompt: (expected) =>
        `This is a qualification review sentinel.\nReply exactly:\n${expected}\n`,
    },
  ],
  [
    "claude_soak_long_reuse",
    {
      harness: "claude",
      expectedResponse: "QUALIFY-CLAUDE-SOAK-LONG-OK",
      reuseResponse: "QUALIFY-CLAUDE-SOAK-REVIEW-OK",
      reuseAfterCompletion: true,
      reusePrompt: correctionReviewPrompt,
      prompt: (expected) =>
        `Context marker: ${"x".repeat(2_400)}. Reply exactly: ${expected}\n`,
    },
  ],
]);

export function interruptQualification() {
  interruptionRequested = true;
  for (const resolveInterruption of interruptionWaiters) resolveInterruption();
  interruptionWaiters.clear();
  for (const child of activeChildren) terminateChild(child);
}

export async function runQualification({
  scenarioIds,
  fullLive = false,
  evidenceDirectory,
  drovrCommand = "drovr",
  cwd = process.cwd(),
  env = process.env,
  now = () => new Date(),
  trustPreflight: trustPreflightRunner = preflightQualificationTrust,
} = {}) {
  interruptionRequested = false;
  const catalog = await loadQualificationCatalog();
  validateQualificationCatalog(catalog);
  const selected = selectScenarios(catalog, scenarioIds, { fullLive });
  await mkdir(evidenceDirectory, { recursive: true });

  const results = [];
  for (const scenario of selected) {
    results.push(
      await runScenarioPrerequisites({
        catalog,
        scenario,
        evidenceDirectory,
        drovrCommand,
        cwd,
        env,
        now,
        trustPreflightRunner,
      }),
    );
  }
  const status = aggregateStatus(results.map(({ result }) => result));
  return {
    schema: "drovr.qualification-run/v1",
    status,
    scenarios: results,
  };
}

export function selectScenarios(catalog, scenarioIds, { fullLive = false } = {}) {
  if (fullLive) {
    const selected = catalog.scenarios.filter(
      ({ execution }) =>
        execution.kind === "real_herdr_harness" &&
        execution.unattended === true,
    );
    const missingExecutor = selected.find(
      ({ id }) => !scenarioExecutors.has(id),
    );
    if (missingExecutor) {
      throw new QualificationUsageError(
        `unattended scenario has no executor: ${missingExecutor.id}`,
      );
    }
    return selected;
  }
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    throw new QualificationUsageError("at least one --scenario is required");
  }
  const byId = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  return scenarioIds.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw new QualificationUsageError(`unknown scenario: ${id}`);
    return scenario;
  });
}

async function runScenarioPrerequisites({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  env,
  now,
  trustPreflightRunner,
}) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-run-"));
  const stateHome = join(scratch, "state");
  const runtimeDirectory = join(scratch, "runtime");
  const startedAt = now().toISOString();
  const traceJournalPath = join(
    evidenceDirectory,
    `.${scenario.id}-${startedAt.replaceAll(":", "-")}.journal.jsonl`,
  );
  const traceStartedAt = Date.now();
  const deadline = createDeadline(
    scenario.execution.limits?.max_elapsed ?? "30s",
  );
  const liveScenario = scenario.execution.kind === "real_herdr_harness";
  const liveHarnesses = liveScenario
    ? scenario.execution.harnesses ?? [scenarioHarness(scenario)]
    : [];
  const configuredQualificationWorkspace =
    liveScenario && typeof env.DROVR_QUALIFICATION_WORKSPACE === "string"
      ? env.DROVR_QUALIFICATION_WORKSPACE.trim()
      : "";
  const stableQualificationWorkspace =
    configuredQualificationWorkspace.length > 0;
  let qualificationWorkspace = liveScenario
    ? stableQualificationWorkspace
      ? resolve(cwd, configuredQualificationWorkspace)
      : join(scratch, "workspace")
    : null;
  let qualificationWorkspaceSetupFailure =
    stableQualificationWorkspace &&
    !isAbsolute(configuredQualificationWorkspace)
      ? trustPreflightBlocked({
          harnesses: liveHarnesses,
          workspace: qualificationWorkspace,
          reason: "qualification_workspace_not_absolute",
          message:
            "DROVR_QUALIFICATION_WORKSPACE must be an absolute path; no native work was started.",
        })
      : null;
  const qualificationRunId = randomUUID();
  let qualificationWorkspaceLock = null;
  let qualificationWorkspaceFingerprintBefore = null;
  let qualificationWorkspaceAvailable = false;
  let trustPreflight = liveScenario
    ? trustPreflightNotRun({
        harnesses: liveHarnesses,
        workspace: qualificationWorkspace,
        reason: "qualification_preflight_not_started",
      })
    : trustPreflightNotApplicable();
  let trustBlocked = false;
  try {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    if (qualificationWorkspace && !qualificationWorkspaceSetupFailure) {
      try {
        await mkdir(qualificationWorkspace, { recursive: true, mode: 0o700 });
        qualificationWorkspaceAvailable = true;
        qualificationWorkspace = await realpath(qualificationWorkspace);
        qualificationWorkspaceFingerprintBefore =
          await safeWorkspaceFingerprint(qualificationWorkspace);
      } catch {
        qualificationWorkspaceSetupFailure = trustPreflightBlocked({
          harnesses: liveHarnesses,
          workspace: qualificationWorkspace,
          reason: "qualification_workspace_unavailable",
          message:
            "The qualification workspace could not be created or canonicalized safely; no native work was started.",
        });
      }
    }
    if (qualificationWorkspaceSetupFailure) {
      trustPreflight = qualificationWorkspaceSetupFailure;
    }
    const scenarioEnvironment = {
      ...env,
      DOTFILES_ROOT: REPOSITORY_ROOT,
      XDG_STATE_HOME: stateHome,
      XDG_RUNTIME_DIR: runtimeDirectory,
      DROVR_TRACE_JOURNAL: traceJournalPath,
      DROVR_TRACE_STARTED_AT: String(traceStartedAt),
      ...(qualificationWorkspace
        ? { DROVR_QUALIFICATION_WORKSPACE: qualificationWorkspace }
        : {}),
    };
    const invocationStartedAt = now().toISOString();
    const execution = await executeDrovr(drovrCommand, ["doctor"], {
      cwd,
      env: scenarioEnvironment,
      timeout: deadline.commandTimeout(30_000),
    });
    const doctorEnvelopeError = validateDrovrEnvelope("doctor", execution.envelope);
    if (doctorEnvelopeError) {
      execution.envelope = invalidEnvelope("doctor", doctorEnvelopeError);
      execution.exitCode ||= 5;
    }
    const invocationFinishedAt = now().toISOString();
    const versions = versionsFromDoctor(execution.envelope);
    const doctorBlocked =
      liveScenario &&
      !scenarioPrerequisitesReady(scenario, execution.envelope);
    if (liveScenario) {
      if (doctorBlocked) {
        trustPreflight = trustPreflightNotRun({
          harnesses: liveHarnesses,
          workspace: qualificationWorkspace,
        });
      } else if (qualificationWorkspaceSetupFailure) {
        trustPreflight = qualificationWorkspaceSetupFailure;
        trustBlocked = true;
      } else {
        qualificationWorkspaceLock = stableQualificationWorkspace
          ? await acquireQualificationWorkspaceLock(
              qualificationWorkspace,
              qualificationRunId,
            )
          : null;
        if (qualificationWorkspaceLock && !qualificationWorkspaceLock.acquired) {
          trustPreflight = trustPreflightBlocked({
            harnesses: liveHarnesses,
            workspace: qualificationWorkspace,
            reason: qualificationWorkspaceLock.reason,
            message: qualificationWorkspaceLock.message,
          });
        } else {
          try {
            trustPreflight = await trustPreflightRunner({
              harnesses: liveHarnesses,
              workspace: qualificationWorkspace,
              env: scenarioEnvironment,
              versions,
              scenario,
            });
          } catch (error) {
            trustPreflight = trustPreflightBlocked({
              harnesses: liveHarnesses,
              workspace: qualificationWorkspace,
              reason: "trust_preflight_error",
              message: "Trust preflight failed before native work could begin.",
            });
          }
        }
        trustBlocked = !trustPreflightReady(trustPreflight, liveHarnesses);
      }
      const blocked = doctorBlocked || trustBlocked;
      const executor = scenarioExecutors.get(scenario.id);
      const effectiveExecutor =
        executor ??
        (scenario.execution.kind === "deterministic_trace_replay"
          ? runDeterministicReplayScenario
          : null);
      const executorResult = await executeScenarioIfReady({
        blocked,
        effectiveExecutor,
        catalog,
        scenario,
        evidenceDirectory,
        drovrCommand,
        cwd,
        scenarioEnvironment,
        scratch,
        stateHome,
        runtimeDirectory,
        now,
        startedAt,
        doctorExecution: execution,
        doctorStartedAt: invocationStartedAt,
        doctorFinishedAt: invocationFinishedAt,
        versions,
        deadline,
        traceJournalPath,
        workspace: qualificationWorkspace,
        qualificationWorkspaceFingerprintBefore,
        stableQualificationWorkspace,
        qualificationWorkspaceLock,
        trustPreflight,
      });
      if (executorResult) {
        await releaseQualificationWorkspaceLock(qualificationWorkspaceLock);
        return executorResult;
      }
      const runnerFailure = executionFailure([
        invocationRecord(
          ["drovr", "doctor"],
          execution,
          invocationStartedAt,
          invocationFinishedAt,
        ),
      ]);
      const disposition = runnerFailure ? "fail" : blocked ? "blocked" : "skipped";
      const reason = runnerFailure
        ? runnerFailure
        : trustBlocked
        ? {
            code: "qualification_trust_unavailable",
            message:
              trustPreflight.reason?.message ??
              "The exact native trust posture for the qualification workspace was not proven.",
          }
        : blocked
        ? {
            code: "prerequisite_unavailable",
            message: "Drovr doctor reported an incompatible or missing prerequisite.",
          }
        : {
            code: "deterministic_replay_deferred",
            message: "The selected scenario has no executor yet.",
          };
      deadline.completeScenario();
      const completedAt = now().toISOString();
      await releaseQualificationWorkspaceLock(qualificationWorkspaceLock);
      const qualificationWorkspaceFingerprintAfter = qualificationWorkspace
        ? await safeWorkspaceFingerprint(qualificationWorkspace)
        : null;
      const ownedResources = [
        { kind: "state_root", identity: stateHome },
        { kind: "runtime_root", identity: runtimeDirectory },
        ...(qualificationWorkspace && qualificationWorkspaceAvailable
          ? [qualificationWorkspaceResource(qualificationWorkspace, stableQualificationWorkspace)]
          : []),
        ...(qualificationWorkspaceLock?.acquired
          ? [qualificationWorkspaceLockResource(qualificationWorkspaceLock)]
          : []),
      ];
      const evidence = {
        schema: "drovr.qualification-evidence/v1",
        catalog_version: catalog.version,
        catalog_digest: digestCanonical(catalog),
        scenario_id: scenario.id,
        execution_kind: scenario.execution.kind,
        versions,
        environment: {
          os: platform(),
          architecture: arch(),
          isolated_state_root: stateHome,
          isolated_runtime_root: runtimeDirectory,
          cwd: resolve(cwd),
          qualification_workspace: qualificationWorkspace,
          qualification_workspace_lock: qualificationWorkspaceLock?.path ?? null,
          managed_session_identity: null,
        },
        limits: {
          declared: scenario.execution.limits ?? {
            max_turns: 0,
            max_retries: 0,
            max_elapsed: "0s",
          },
          measured: { turns: 0, retries: 0, elapsed_ms: deadline.scenarioElapsedMs() },
          cleanup: deadline.cleanupMeasurement(),
        },
        live_run_justification:
          scenario.execution.kind === "real_herdr_harness"
            ? scenario.execution.rationale
            : null,
        configuration_deviation_justification: null,
        trust_preflight: trustPreflight,
        invocations: [
          invocationRecord(
            ["drovr", "doctor"],
            execution,
            invocationStartedAt,
            invocationFinishedAt,
          ),
        ],
        observations: [
          {
            type: "drovr_doctor",
            envelope: execution.envelope,
          },
          ...(liveScenario
            ? [{ type: "trust_preflight", result: trustPreflight }]
            : []),
        ],
        assertions: [
          ...prerequisiteAssertions(execution.envelope),
          ...(liveScenario
            ? [{
                kind: "prerequisite",
                id: "qualification_trust_preflight",
                disposition: trustPreflightAssertionDisposition(trustPreflight),
                detail:
                  trustPreflightAssertionDetail(trustPreflight),
              }]
            : []),
        ],
        result: { disposition, reason },
        execution_policy: PUBLIC_QUALIFICATION_POLICY,
        cleanup_receipt: {
          schema: "drovr.qualification-cleanup-receipt/v1",
          scenario_id: scenario.id,
          owned_resources: ownedResources,
          resource_dispositions: ownedResources.map((resource) => ({
            ...resource,
            disposition:
              resource.kind === "qualification_workspace_lock"
                ? qualificationWorkspaceLockDisposition(qualificationWorkspaceLock)
                : resourceDisposition(resource.kind, true),
          })),
          prohibited_mutations_observed: prohibitedMutationObservations(
            scenario.prohibited_mutations,
            { basis: ["no live mutation was attempted by this deferred replay scenario"] },
          ),
          caller_owned_workspace: {
            path: resolve(cwd),
            before: "not_observed_before_prerequisite_block",
            after: "not_mutated",
          },
          qualification_workspace:
            qualificationWorkspaceFingerprintBefore ||
            qualificationWorkspaceFingerprintAfter
              ? {
                  before: qualificationWorkspaceFingerprintBefore,
                  after: qualificationWorkspaceFingerprintAfter,
                }
              : null,
          native_trust_configuration_preservation:
            await observeNativeTrustConfiguration(trustPreflight),
          unresolved_obligations:
            qualificationWorkspaceLockObligations(qualificationWorkspaceLock),
          completed_at: completedAt,
        },
        started_at: startedAt,
        finished_at: completedAt,
      };
      await rm(scratch, { recursive: true, force: true });
      const evidencePath = join(
        evidenceDirectory,
        `${scenario.id}-${startedAt.replaceAll(":", "-")}.json`,
      );
      validateQualificationEvidence(
        evidence,
        catalog.contracts.qualification_evidence.required_fields,
      );
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
      });
      await removeTraceArtifacts(traceJournalPath);
      return { id: scenario.id, result: disposition, evidence: evidencePath };
    }
    const executor = scenarioExecutors.get(scenario.id);
    const effectiveExecutor =
      executor ??
      (scenario.execution.kind === "deterministic_trace_replay"
        ? runDeterministicReplayScenario
        : null);
    const executorResult = await executeScenarioIfReady({
      blocked: false,
      effectiveExecutor,
      catalog,
      scenario,
      evidenceDirectory,
      drovrCommand,
      cwd,
      scenarioEnvironment,
      scratch,
      stateHome,
      runtimeDirectory,
      now,
      startedAt,
      doctorExecution: execution,
      doctorStartedAt: invocationStartedAt,
      doctorFinishedAt: invocationFinishedAt,
      versions,
      deadline,
      traceJournalPath,
      workspace: qualificationWorkspace,
      stableQualificationWorkspace,
      qualificationWorkspaceLock,
      trustPreflight,
    });
    if (executorResult) return executorResult;
    throw new Error(`selected scenario has no executor: ${scenario.id}`);
  } catch (error) {
    await releaseQualificationWorkspaceLock(qualificationWorkspaceLock);
    const failureResult = await recordScenarioFailure({
      catalog,
      scenario,
      evidenceDirectory,
      drovrCommand,
      cwd,
      env: {
        ...env,
        DOTFILES_ROOT: REPOSITORY_ROOT,
        XDG_STATE_HOME: stateHome,
        XDG_RUNTIME_DIR: runtimeDirectory,
        DROVR_TRACE_JOURNAL: traceJournalPath,
        DROVR_TRACE_STARTED_AT: String(traceStartedAt),
      },
      scratch,
      stateHome,
      runtimeDirectory,
      now,
      startedAt,
      deadline,
      qualificationWorkspace,
      qualificationWorkspaceFingerprintBefore,
      qualificationWorkspaceAvailable,
      stableQualificationWorkspace,
      qualificationWorkspaceLock,
      trustPreflight,
      error,
    });
    return await attachCapturedTrace({
      result: failureResult,
      traceJournalPath,
      scenario,
      catalog,
    });
  } finally {
    await releaseQualificationWorkspaceLock(qualificationWorkspaceLock);
  }
}

async function acquireQualificationWorkspaceLock(workspace, runId) {
  const path = join(workspace, ".drovr-qualification-lock");
  try {
    await mkdir(path, { mode: 0o700 });
    try {
      await writeFile(
        join(path, "owner.json"),
        `${JSON.stringify({
          schema: "drovr.qualification-lock-owner/v1",
          pid: process.pid,
          hostname: hostname(),
          run_id: runId,
          started_at: new Date().toISOString(),
          boot_uptime_ms: Math.round(uptime() * 1_000),
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      await rm(path, { recursive: true, force: true });
      return {
        path,
        acquired: false,
        reason: "qualification_workspace_lock_unavailable",
        message:
          `The dedicated qualification workspace lock ${path} could not be initialized safely; no native work was started. Verify permissions and retry.`,
      };
    }
    return { path, acquired: true, run_id: runId };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return {
        path,
        acquired: false,
        reason: "qualification_workspace_lock_unavailable",
        message:
          `The dedicated qualification workspace lock ${path} could not be claimed safely; no native work was started. Verify permissions and retry.`,
      };
    }
    return {
      path,
      acquired: false,
      ...await classifyExistingQualificationWorkspaceLock(path),
    };
  }
}

async function classifyExistingQualificationWorkspaceLock(path) {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  } catch {
    owner = null;
  }
  if (
    !owner ||
    owner.schema !== "drovr.qualification-lock-owner/v1" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0
  ) {
    return {
      reason: "qualification_workspace_lock_unverifiable",
      message:
        `The dedicated qualification workspace lock ${path} could not be classified safely. Verify that no qualification run owns it, remove exactly that lock directory, and retry.`,
    };
  }
  if (owner.hostname !== hostname()) {
    return {
      reason: "qualification_workspace_lock_unverifiable",
      message:
        `The dedicated qualification workspace lock ${path} belongs to host ${owner.hostname}; its owner cannot be classified from this host. Verify that no qualification run owns it, remove exactly that lock directory, and retry.`,
    };
  }
  const currentUptimeMs = Math.round(uptime() * 1_000);
  const recordedBootUptimeMs = owner.boot_uptime_ms;
  const recordedStartedAtMs = Date.parse(owner.started_at);
  const recordedBootWallClockMs = recordedStartedAtMs - recordedBootUptimeMs;
  const currentBootWallClockMs = Date.now() - currentUptimeMs;
  const bootClockDriftMs = Math.abs(
    recordedBootWallClockMs - currentBootWallClockMs,
  );
  if (
    Number.isFinite(recordedBootUptimeMs) &&
    (recordedBootUptimeMs > currentUptimeMs ||
      (Number.isFinite(recordedStartedAtMs) &&
        Number.isFinite(currentBootWallClockMs) &&
        bootClockDriftMs > QUALIFICATION_BOOT_CLOCK_TOLERANCE_MS))
  ) {
    return {
      reason: "qualification_workspace_lock_stale",
      message:
        `The dedicated qualification workspace lock ${path} is stale; its recorded boot uptime is newer than this host's current boot. Verify no qualification run is active, remove exactly that lock directory, and retry.`,
    };
  }
  try {
    process.kill(owner.pid, 0);
    return {
      reason: "qualification_workspace_busy",
      message:
        `The dedicated qualification workspace lock ${path} is held by live process ${owner.pid}; no native work was started. Wait for that run to finish and retry. If no run is active, verify that and remove exactly that lock directory before retrying.`,
    };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return {
        reason: "qualification_workspace_lock_stale",
        message:
          `The dedicated qualification workspace lock ${path} is stale; owner process ${owner.pid} is no longer running. Verify no qualification run is active, remove exactly that lock directory, and retry.`,
      };
    }
    if (error?.code === "EPERM") {
      return {
        reason: "qualification_workspace_busy",
        message:
          `The dedicated qualification workspace lock ${path} is held by process ${owner.pid}; no native work was started. Wait for that run to finish and retry. If no run is active, verify that and remove exactly that lock directory before retrying.`,
      };
    }
    return {
      reason: "qualification_workspace_lock_unverifiable",
      message:
        `The dedicated qualification workspace lock ${path} could not be classified safely. Verify that no qualification run owns it, remove exactly that lock directory, and retry.`,
    };
  }
}

async function releaseQualificationWorkspaceLock(lock) {
  if (!lock?.acquired || lock.released === true) return;
  try {
    await rm(lock.path, { recursive: true, force: true });
    lock.released = true;
  } catch {
    lock.released = false;
  }
}

function qualificationWorkspaceLockDisposition(lock) {
  return lock?.released === true ? "absent" : "retained";
}

function qualificationWorkspaceLockObligations(lock) {
  if (!lock?.acquired || lock.released === true) return [];
  return [
    {
      code: "qualification_workspace_lock_retained",
      lock_path: lock.path,
      action:
        `Verify that no qualification run is active, remove exactly ${lock.path}, and retry.`,
    },
  ];
}

function qualificationWorkspaceResource(workspace, stable) {
  return {
    kind: stable ? "dedicated_qualification_workspace" : "temporary_workspace",
    identity: workspace,
  };
}

function qualificationWorkspaceLockResource(lock) {
  return { kind: "qualification_workspace_lock", identity: lock.path };
}

function trustPreflightAssertionDisposition(trustPreflight) {
  if (trustPreflight?.status === "trusted") return "pass";
  if (trustPreflight?.status === "not_run") return "not_applicable";
  return "fail";
}

function trustPreflightAssertionDetail(trustPreflight) {
  if (trustPreflight?.status === "trusted") {
    return "The exact native trust posture was observed before managed work began.";
  }
  return trustPreflight?.reason?.message ??
    "The exact native trust posture was not proven before managed work began.";
}

async function observeNativeTrustConfiguration(trustPreflight) {
  if (trustPreflight?.status !== "trusted") {
    return {
      status: "not_applicable",
      reason: "native_work_did_not_start_with_trusted_preflight",
      harnesses: {},
    };
  }
  const harnesses = {};
  for (const [harness, observation] of Object.entries(
    trustPreflight.harnesses ?? {},
  )) {
    let after;
    try {
      after = await readNativeTrustSource({
        harness,
        path: observation.source.path,
        workspacePath: trustPreflight.workspace.path,
      });
    } catch {
      after = {
        status: "ambiguous",
        path: observation.source.path,
        digest: null,
        workspace_path: trustPreflight.workspace.path,
        entry: "unreadable",
        trust_level: null,
        error: "The native trust configuration could not be re-read safely.",
      };
    }
    const before = observation.source;
    const unchanged =
      after.status === "present" &&
      after.path === before.path &&
      after.workspace_path === before.workspace_path &&
      after.entry === before.entry &&
      after.trust_level === before.trust_level;
    harnesses[harness] = {
      unchanged,
      file_digest_changed: after.digest !== before.digest,
      before: trustSourceEvidence(before),
      after: trustSourceEvidence(after),
    };
  }
  const unchanged = Object.values(harnesses).every(({ unchanged: value }) => value);
  return {
    status: unchanged ? "unchanged" : "changed",
    reason: unchanged
      ? "native_trust_entry_preserved"
      : "native_trust_configuration_changed_after_preflight",
    harnesses,
  };
}

function trustSourceEvidence(source) {
  return {
    status: source?.status ?? "ambiguous",
    path: source?.path ?? null,
    digest: source?.digest ?? null,
    workspace_path: source?.workspace_path ?? null,
    entry: source?.entry ?? null,
    trust_level: Object.hasOwn(source ?? {}, "trust_level")
      ? source.trust_level
      : null,
    ...(source?.error ? { error: source.error } : {}),
  };
}

async function verifyNativeTrustConfigurationAfterRun({
  result,
  trustPreflight,
  scenario,
  catalog,
  workspace,
  qualificationWorkspaceFingerprintBefore,
  qualificationWorkspaceLock,
  releaseLock,
}) {
  if (
    !result?.evidence ||
    scenario.execution.kind !== "real_herdr_harness" ||
    trustPreflight?.status !== "trusted"
  ) {
    return result;
  }
  const evidence = JSON.parse(await readFile(result.evidence, "utf8"));
  const preservation = await observeNativeTrustConfiguration(trustPreflight);
  await releaseLock?.();
  evidence.environment.qualification_workspace_lock =
    qualificationWorkspaceLock?.path ?? null;
  if (qualificationWorkspaceLock?.acquired) {
    evidence.cleanup_receipt.owned_resources.push(
      qualificationWorkspaceLockResource(qualificationWorkspaceLock),
    );
    evidence.cleanup_receipt.resource_dispositions.push({
      ...qualificationWorkspaceLockResource(qualificationWorkspaceLock),
      disposition: qualificationWorkspaceLockDisposition(qualificationWorkspaceLock),
    });
  }
  const qualificationWorkspaceFingerprintAfter = workspace
    ? await safeWorkspaceFingerprint(workspace)
    : null;
  evidence.assertions = [
    ...(evidence.assertions ?? []),
    {
      kind: "invariant",
      id: "native_trust_configuration_preservation",
      disposition: preservation.status === "unchanged" ? "pass" : "fail",
      detail:
        preservation.status === "unchanged"
          ? "The exact native trust entries were unchanged after the live scenario."
          : "The exact native trust entries changed or could not be re-read after the live scenario.",
    },
  ];
  evidence.cleanup_receipt.native_trust_configuration_preservation = preservation;
  evidence.cleanup_receipt.unresolved_obligations = [
    ...(evidence.cleanup_receipt.unresolved_obligations ?? []),
    ...qualificationWorkspaceLockObligations(qualificationWorkspaceLock),
  ];
  if (preservation.status !== "unchanged") {
    evidence.result = {
      disposition: "fail",
      reason: {
        code: "native_trust_configuration_changed_after_preflight",
        message: "Native trust configuration was not preserved after the live scenario.",
      },
    };
  }
  evidence.cleanup_receipt.qualification_workspace =
    qualificationWorkspaceFingerprintBefore ||
    qualificationWorkspaceFingerprintAfter
      ? {
          before: qualificationWorkspaceFingerprintBefore,
          after: qualificationWorkspaceFingerprintAfter,
        }
      : null;
  validateQualificationEvidence(
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  await writeFile(result.evidence, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...result, result: evidence.result.disposition };
}

async function executeScenarioIfReady({
  blocked,
  effectiveExecutor,
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  scenarioEnvironment,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  deadline,
  traceJournalPath,
  workspace,
  qualificationWorkspaceFingerprintBefore,
  stableQualificationWorkspace,
  qualificationWorkspaceLock,
  trustPreflight,
}) {
  if (blocked || !effectiveExecutor) return null;
  const result = await effectiveExecutor({
    catalog,
    scenario,
    evidenceDirectory,
    drovrCommand,
    cwd,
    scenarioEnvironment,
    scratch,
    stateHome,
    runtimeDirectory,
    now,
    startedAt,
    doctorExecution,
    doctorStartedAt,
    doctorFinishedAt,
    versions,
    deadline,
    traceJournalPath,
    workspace,
    stableQualificationWorkspace,
    trustPreflight,
  });
  const traced = await attachCapturedTrace({
    result,
    traceJournalPath,
    scenario,
    catalog,
  });
  return verifyNativeTrustConfigurationAfterRun({
    result: traced,
    trustPreflight,
    scenario,
    catalog,
    workspace,
    qualificationWorkspaceFingerprintBefore,
    qualificationWorkspaceLock,
    releaseLock: () => releaseQualificationWorkspaceLock(qualificationWorkspaceLock),
  });
}

async function runDeterministicReplayScenario({
  catalog,
  scenario,
  evidenceDirectory,
  cwd,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  stateHome,
  runtimeDirectory,
  scratch,
  deadline,
}) {
  const fixture = await loadTraceFixture(scenario.id);
  const beforeWorkspace = await workspaceFingerprint(cwd);
  let replayResult;
  let replayError;
  let traceValidationError;
  try {
    validateTrace(fixture.trace);
  } catch (error) {
    traceValidationError = error;
  }
  try {
    replayResult = await runTraceFixture(fixture);
  } catch (error) {
    replayError = error;
  }
  deadline.completeScenario();
  const afterWorkspace = await workspaceFingerprint(cwd);
  const finishedAt = now().toISOString();
  const callerWorkspaceUnchanged =
    JSON.stringify(beforeWorkspace) === JSON.stringify(afterWorkspace);
  const passed = !replayError && !traceValidationError && callerWorkspaceUnchanged;
  const invocationRecords = [
    invocationRecord(
      ["drovr", "doctor"],
      doctorExecution,
      doctorStartedAt,
      doctorFinishedAt,
    ),
  ];
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: scenario.execution.kind,
    versions,
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: resolve(cwd),
      managed_session_identity: replayNativeSession(fixture.trace),
    },
    limits: {
      declared: scenario.execution.limits ?? {
        max_turns: 0,
        max_retries: 0,
        max_elapsed: "0s",
      },
      measured: {
        turns: fixture.steps.filter(({ action }) => action === "prompt").length,
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification: null,
    configuration_deviation_justification: null,
    trust_preflight: trustPreflightNotApplicable(),
    invocations: invocationRecords,
    observations: [
      {
        type: "trace_provenance",
        provenance: fixture.trace.provenance,
      },
      {
        type: "deterministic_replay",
        fixture_id: fixture.id,
        declared_safety_invariants: scenario.safety_invariants,
        step_assertions: replayResult?.assertions ?? [],
        result: replayResult ?? {
          status: "fail",
          error: replayError?.message ?? "replay did not produce a result",
        },
      },
    ],
    assertions: [
      {
        kind: "replay",
        id: "versioned_trace_schema",
        disposition: traceValidationError ? "fail" : "pass",
        detail: traceValidationError
          ? `The fixture trace failed validation: ${traceValidationError.message}`
          : "The versioned fixture trace passed redaction and ordering validation.",
      },
      {
        kind: "replay",
        id: "semantic_harness_replay",
        disposition: passed ? "pass" : "fail",
        detail: replayError?.message ?? "All fixture steps passed through semantic Drovr seams.",
      },
      {
        kind: "replay",
        id: "replayed_fixture_steps",
        disposition: passed ? "pass" : "fail",
        detail: replayError?.message ??
          `Passed ${replayResult?.assertions?.length ?? 0} ordered fixture steps.`,
      },
      {
        kind: "invariant",
        id: "caller_owned_workspace_preservation",
        disposition: callerWorkspaceUnchanged ? "pass" : "fail",
        detail: "The caller workspace fingerprint was unchanged before and after replay.",
      },
    ],
    result: {
      disposition: passed ? "pass" : "fail",
      reason: {
        code: passed ? "scenario_completed" : "replay_assertion_failed",
        message: replayError?.message ??
          (callerWorkspaceUnchanged
            ? "The deterministic trace replay completed and preserved the caller workspace."
            : "The deterministic replay changed the caller workspace fingerprint."),
      },
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    trace: fixture.trace,
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition: resourceDisposition(resource.kind, true),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        {
          basis: [
            "immutable versioned trace",
            "semantic replay operation ordering",
            "caller workspace fingerprint",
          ],
          proofs: replayResult?.mutation_proofs ?? [],
        },
      ),
      caller_owned_workspace: {
        path: resolve(cwd),
        before: beforeWorkspace,
        after: afterWorkspace,
      },
      unresolved_obligations: [],
      completed_at: finishedAt,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
  await rm(scratch, { recursive: true, force: true });
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return {
    id: scenario.id,
    result: passed ? "pass" : "fail",
    evidence: evidencePath,
  };
}

async function attachCapturedTrace({
  result,
  traceJournalPath,
  scenario,
  catalog,
}) {
  if (scenario.execution.kind !== "real_herdr_harness") {
    await removeTraceArtifacts(traceJournalPath);
    return result;
  }
  const captureRequired = result.result === "pass";
  const requiredFields =
    catalog?.contracts?.qualification_evidence?.required_fields ??
    QUALIFICATION_EVIDENCE_REQUIRED_FIELDS;
  const captureFailurePath = traceJournalFailurePath(traceJournalPath);
  const captureFailureRecorded = await fileExists(captureFailurePath);
  try {
    const evidence = JSON.parse(await readFile(result.evidence, "utf8"));
    const versions = evidence.versions ?? {};
    let trace;
    try {
      trace = await traceFromJournal(traceJournalPath, {
        scenarioId: scenario.id,
        provenance: {
          drovr: versions.drovr ?? "unavailable",
          herdr: versions.herdr ?? "unavailable",
          claude: versions.claude ?? "unavailable",
          codex: versions.codex ?? "unavailable",
          compatibility: liveCompatibility(versions, scenarioHarness(scenario)),
        },
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const failedEvidence = traceCaptureFailure(
          evidence,
          "trace_capture_invalid",
          "A live qualification produced a trace journal that failed validation.",
        );
        validateQualificationEvidence(failedEvidence, requiredFields);
        await writeFile(result.evidence, `${JSON.stringify(failedEvidence, null, 2)}\n`, {
          mode: 0o600,
        });
        return { ...result, result: "fail" };
      }
      if (captureFailureRecorded) {
        const failedEvidence = traceCaptureFailure(
          evidence,
          "trace_capture_incomplete",
          "Trace capture failed before a complete journal could be persisted.",
        );
        validateQualificationEvidence(failedEvidence, requiredFields);
        await writeFile(result.evidence, `${JSON.stringify(failedEvidence, null, 2)}\n`, {
          mode: 0o600,
        });
        return { ...result, result: "fail" };
      }
      if (!captureRequired) return result;
      const failedEvidence = traceCaptureFailure(
        evidence,
        "trace_capture_missing",
        "A successful live qualification produced no sanitized trace journal.",
      );
      validateQualificationEvidence(failedEvidence, requiredFields);
      await writeFile(result.evidence, `${JSON.stringify(failedEvidence, null, 2)}\n`, {
        mode: 0o600,
      });
      return { ...result, result: "fail" };
    }
    if (captureFailureRecorded) {
      const failedEvidence = traceCaptureFailure(
        evidence,
        "trace_capture_incomplete",
        "Trace capture reported a failure while persisting the live journal.",
        trace,
      );
      validateQualificationEvidence(failedEvidence, requiredFields);
      await writeFile(result.evidence, `${JSON.stringify(failedEvidence, null, 2)}\n`, {
        mode: 0o600,
      });
      return { ...result, result: "fail" };
    }
    const traceComplete = hasCompleteLiveTrace(trace);
    if (captureRequired && !traceComplete) {
      const failedEvidence = traceCaptureFailure(
        evidence,
        "trace_capture_incomplete",
        trace.events.length === 0
          ? "A successful live qualification produced an empty trace."
          : !hasCompleteTraceProvenance(trace.provenance)
            ? "A successful live qualification lacked exact tool provenance."
            : "A successful live qualification lacked request-bound semantic events.",
        trace,
      );
      validateQualificationEvidence(failedEvidence, requiredFields);
      await writeFile(result.evidence, `${JSON.stringify(failedEvidence, null, 2)}\n`, {
        mode: 0o600,
      });
      return { ...result, result: "fail" };
    }
    evidence.trace = trace;
    validateQualificationEvidence(evidence, requiredFields);
    await writeFile(result.evidence, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    return result;
  } finally {
    await removeTraceArtifacts(traceJournalPath);
  }
}

async function removeTraceArtifacts(traceJournalPath) {
  await rm(traceJournalPath, { force: true });
  await rm(traceJournalFailurePath(traceJournalPath), { force: true });
  await rm(`${traceJournalPath}.lock`, { recursive: true, force: true });
}

async function fileExists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hasCompleteTraceProvenance(provenance) {
  const exactVersions = ["drovr", "herdr", "claude", "codex"].every((key) => {
    const value = provenance?.[key];
    return (
      typeof value === "string" &&
      value.length > 0 &&
      !/^(?:unavailable|not_applicable|drovr\.command\/v1)/u.test(value)
    );
  });
  const facts = provenance?.compatibility?.facts;
  const harness = typeof facts?.integration === "string" &&
      facts.integration.startsWith("herdr-claude/")
    ? "claude"
    : typeof facts?.integration === "string" &&
        facts.integration.startsWith("herdr-codex/")
      ? "codex"
      : null;
  let compatibility;
  try {
    compatibility = harness
      ? qualifyCompatibility(provenance.compatibility, {
          harness,
          adapter: PRODUCTION_ADAPTER_ID,
        })
      : null;
  } catch {
    compatibility = null;
  }
  return exactVersions &&
    compatibility?.status === "qualified" &&
    [facts?.drovr, facts?.herdr, facts?.harness, facts?.integration].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        !/^(?:unavailable|not_applicable|drovr\.command\/v1)$/u.test(value),
    ) &&
    Array.isArray(facts?.adapters) &&
    Array.isArray(facts?.features);
}

function hasCompleteLiveTrace(trace) {
  if (!hasCompleteTraceProvenance(trace.provenance)) return false;
  if (trace.events.some(({ operation }) => operation === "trace.capture")) {
    return false;
  }
  const semanticEvents = trace.events.filter(({ kind }) =>
    ["command_result", "agent_observation", "pane_snapshot", "error"].includes(kind),
  );
  return (
    semanticEvents.length > 0 &&
    semanticEvents.every(({ payload }) => payload.request !== undefined)
  );
}

function traceCaptureFailure(evidence, code, message, trace) {
  if (trace !== undefined) evidence.trace = trace;
  evidence.assertions = [
    ...(evidence.assertions ?? []),
    {
      kind: "capture",
      id: "trace_capture",
      disposition: "fail",
      detail: message,
    },
  ];
  evidence.result = {
    disposition: "fail",
    reason: { code, message },
  };
  return evidence;
}

function replayNativeSession(trace) {
  for (const event of trace.events) {
    const agents = event.payload?.envelope?.result?.agents;
    const nativeSession = agents?.find(
      ({ agent_session }) => typeof agent_session?.value === "string",
    )?.agent_session?.value;
    if (nativeSession) return nativeSession;
  }
  return null;
}

async function runUnknownStagedInputScenario({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  scenarioEnvironment,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  deadline,
  workspace,
  stableQualificationWorkspace,
  trustPreflight,
}) {
  const beforeWorkspace = await workspaceFingerprint(cwd);
  const suffix = randomUUID();
  const groupKey = `qualification-${scenario.id}-${suffix}`;
  const launch = qualificationLaunch(doctorExecution.envelope, "claude");
  const unknownText = `QUALIFY-UNKNOWN-STAGED-${suffix}`;
  const unknownPromptPath = join(scratch, "unknown-staged-input.txt");
  await writeFile(unknownPromptPath, unknownText);
  const records = [
    invocationRecord(
      ["drovr", "doctor"],
      doctorExecution,
      doctorStartedAt,
      doctorFinishedAt,
    ),
  ];
  const invoke = createInvocationRecorder({
    records,
    command: drovrCommand,
    cwd,
    env: scenarioEnvironment,
    now,
    deadline,
  });
  const beforeGroups = await invoke(["group", "list"], "group list");
  const delegate = await invoke(
    [
      "delegate",
      "--group",
      groupKey,
      "--group-label",
      `Qualification ${scenario.id}`,
      "--task-key",
      `task-${suffix}`,
      "--agent-key",
      `agent-${suffix}`,
      "--cwd",
      workspace,
      "--harness",
      "claude",
      "--model",
      launch.model,
      "--effort",
      launch.effort,
      "--capability",
      "read-only",
      "--timeout",
      "60s",
      "Reply exactly: QUALIFY-CLAUDE-STAGED-INITIAL-OK",
    ],
    "delegate",
    { timeoutMs: 65_000 },
  );
  const initialResult = delegate.execution.envelope?.result;
  let group = initialResult?.group;
  if (!group?.id) {
    const discovery = await invoke(["group", "list"], "group list");
    group = discovery.execution.envelope?.result?.groups?.find(
      (candidate) => candidate.key === groupKey,
    );
  }
  const taskId = initialResult?.task?.id;
  const groupId = group?.id;
  const agentId = initialResult?.agent?.id;
  let stagedDelivery;
  let beforeStage;
  let afterStage;
  let inspected;
  let cleared;
  let postClearObservation;
  let afterProcessReentry;
  let beforeStageObservation;
  const stabilityObservations = [];
  let reuse;
  let beforeTurnList;
  if (typeof agentId === "string") {
    beforeTurnList = await invoke(
      ["turn", "list", "--agent", agentId],
      "turn list",
    );
    beforeStage = await invoke(["agent", "get", agentId], "agent get");
    if (beforeStage.execution.envelope?.result?.status === "completed") {
      beforeStageObservation = await invoke(
        ["agent", "staged-input", agentId],
        "agent staged-input",
      );
      stagedDelivery = await invoke(
        [
          "agent",
          "staged-input",
          agentId,
          "--stage-unknown-file",
          unknownPromptPath,
        ],
        "agent staged-input",
        { timeoutMs: 15_000 },
      );
      afterStage = await invoke(
        ["agent", "staged-input", agentId],
        "agent staged-input",
      );
      inspected = afterStage;
    }
    const staged = inspected?.execution.envelope?.result?.staged_input;
    if (
      inspected?.execution.envelope?.result?.status === "staged_input" &&
      staged?.ownership === "unknown" &&
      typeof staged.token === "string" &&
      staged.display_text === unknownText
    ) {
      cleared = await invoke(
        [
          "agent",
          "staged-input",
          agentId,
          "--clear-unknown",
          staged.token,
        ],
        "agent staged-input",
        { timeoutMs: 15_000 },
      );
      const stabilityMs = parseDuration(
        scenario.execution.limits.stability_interval,
      );
      const stabilityStarted = Date.now();
      while (Date.now() - stabilityStarted < stabilityMs) {
        await boundedDelay(
          deadline.commandTimeout(
            Math.min(5_000, stabilityMs - (Date.now() - stabilityStarted)),
          ),
        );
        const observation = await invoke(
          ["agent", "staged-input", agentId],
          "agent staged-input",
        );
        stabilityObservations.push(observation);
        if (observation.execution.envelope?.result?.status !== "ready") break;
      }
      const stable =
        Date.now() - stabilityStarted >= stabilityMs &&
        stabilityObservations.length > 0 &&
        stabilityObservations.every(
          ({ execution }) => execution.envelope?.result?.status === "ready",
        );
      if (stable) {
        postClearObservation = await invoke(
          ["agent", "staged-input", agentId],
          "agent staged-input",
        );
        afterProcessReentry = await invoke(
          ["agent", "staged-input", agentId],
          "agent staged-input",
        );
        if (
          postClearObservation.execution.envelope?.result?.status === "ready" &&
          afterProcessReentry.execution.envelope?.result?.status === "ready"
        ) {
          reuse = await invoke(
            [
              "ask",
              agentId,
              "--timeout",
              "60s",
              correctionReviewPrompt("QUALIFY-CLAUDE-REUSE-OK"),
            ],
            "ask",
            { timeoutMs: 65_000 },
          );
        }
      }
    }
  }
  const finalAgent = reuse && typeof agentId === "string"
    ? await invoke(["agent", "get", agentId], "agent get")
    : null;
  const afterTurnList = typeof agentId === "string"
    ? await invoke(["turn", "list", "--agent", agentId], "turn list")
    : null;
  const afterTurnDetails = [];
  for (const turn of afterTurnList?.execution.envelope?.result?.turns ?? []) {
    afterTurnDetails.push(
      await invoke(
        ["turn", "get", turn.id, "--include-messages"],
        "turn get",
      ),
    );
  }
  deadline.completeScenario();
  let cleanup;
  if (typeof groupId === "string") {
    cleanup = await invoke(
      ["group", "close", groupId, "--force"],
      "group close",
      { timeoutMs: 30_000, cleanup: true },
    );
  }
  const afterGroups = await invoke(["group", "list"], "group list", {
    cleanup: true,
  });
  const afterWorkspace = await workspaceFingerprint(cwd);
  const staged = inspected?.execution.envelope?.result?.staged_input;
  const exactUnknownStaged =
    stagedDelivery?.execution.envelope?.result?.status === "staged_input" &&
    stagedDelivery.execution.envelope.result.staged_input?.ownership ===
      "unknown" &&
    stagedDelivery.execution.envelope.result.staged_input?.display_text ===
      unknownText &&
    inspected?.execution.envelope?.result?.status === "staged_input" &&
    staged?.ownership === "unknown" &&
    staged?.display_text === unknownText;
  const stableClear =
    cleared?.execution.envelope?.result?.status === "cleared" &&
    stabilityObservations.length > 0 &&
    stabilityObservations.every(
      ({ execution }) => execution.envelope?.result?.status === "ready",
    );
  const clearContradiction = stabilityObservations.find(
    ({ execution: observation }) =>
      observation.envelope?.result?.status === "staged_input",
  ) ?? (
    postClearObservation?.execution.envelope?.result?.status === "staged_input"
      ? postClearObservation
      : afterProcessReentry?.execution.envelope?.result?.status === "staged_input"
        ? afterProcessReentry
        : null
  );
  const observedNativeSessions = nativeSessionValues([
    delegate,
    beforeStageObservation,
    beforeStage,
    stagedDelivery,
    afterStage,
    inspected,
    cleared,
    ...stabilityObservations,
    postClearObservation,
    afterProcessReentry,
    finalAgent,
  ]);
  const managedNativeSession = observedNativeSessions[0] ?? null;
  const finalNativeSession =
    finalAgent?.execution.envelope?.result?.agent?.native_session ?? null;
  const exactNativeSession =
    observedNativeSessions.length >= 3 &&
    observedNativeSessions.every((value) => value === managedNativeSession) &&
    (!reuse || finalNativeSession === managedNativeSession);
  const observedModel = initialResult?.agent?.model;
  const observedEffort = initialResult?.agent?.effort;
  const exactLaunchConfiguration =
    observedModel === launch.model && observedEffort === launch.effort;
  const stateSequence = {
    before_staging: stateChangeSeqFromExecution(beforeStageObservation),
    after_staging: stateChangeSeqFromExecution(afterStage ?? stagedDelivery),
    after_clear: stateChangeSeqFromExecution(
      cleared ?? stabilityObservations[0],
    ),
    post_clear: stateChangeSeqFromExecution(
      postClearObservation ?? stabilityObservations.at(-1),
    ),
    after_process_reentry: stateChangeSeqFromExecution(
      afterProcessReentry ?? finalAgent,
    ),
  };
  const antiReplayGap = stateSequenceAntiReplayGap(stateSequence);
  const sameAgentReuse =
    reuse?.execution.envelope?.result?.status === "completed" &&
    reuse.execution.envelope.result.agent?.id === agentId &&
    reuse.execution.envelope.result.turn?.result?.text?.trim() ===
      "QUALIFY-CLAUDE-REUSE-OK";
  const envelopeClaimsUnknownSubmission = records.some(
    ({ envelope }) =>
      JSON.stringify(envelope).includes(unknownText) &&
      envelope.result?.turn?.input_count > 0,
  );
  const noUnknownLogicalInput = proveUnknownInputWasNotSubmitted({
    beforeTurns: beforeTurnList?.execution.envelope?.result?.turns,
    afterTurns: afterTurnDetails.map(
      ({ execution: observation }) => observation.envelope?.result?.turn,
    ),
    reuseTurnId: reuse?.execution.envelope?.result?.turn?.id,
    unknownPayloadSha256: `sha256:${createHash("sha256")
      .update(unknownText)
      .digest("hex")}`,
  });
  const turnHistoryObserved =
    Array.isArray(beforeTurnList?.execution.envelope?.result?.turns) &&
    Array.isArray(afterTurnList?.execution.envelope?.result?.turns) &&
    afterTurnDetails.length ===
      afterTurnList.execution.envelope.result.turns.length &&
    afterTurnDetails.every(
      ({ execution: observation }) => observation.envelope?.ok === true,
    );
  const unknownTextSubmitted =
    envelopeClaimsUnknownSubmission || !noUnknownLogicalInput;
  const clearInvocations = records.filter(
    ({ argv }) => argv[1] === "agent" && argv[2] === "staged-input" &&
      argv.includes("--clear-unknown"),
  );
  const clearedOnlyExactSnapshot =
    clearInvocations.length <= 1 &&
    clearInvocations.every(({ argv }) =>
      argv[argv.indexOf("--clear-unknown") + 1] === staged?.token,
    );
  const observedAgentIds = records
    .map(({ envelope }) => envelope.result?.agent?.id)
    .filter((id) => typeof id === "string");
  const managedAgentPreserved =
    observedAgentIds.length > 0 &&
    observedAgentIds.every((id) => id === agentId);
  const cleanupComplete = cleanup?.execution.envelope?.result?.status === "closed";
  const callerWorkspaceUnchanged =
    JSON.stringify(beforeWorkspace) === JSON.stringify(afterWorkspace);
  const unrelatedResources = compareUnrelatedGroups(
    beforeGroups.execution.envelope?.result?.groups,
    afterGroups.execution.envelope?.result?.groups,
    groupKey,
  );
  const unrelatedResourcesUnchanged = unrelatedResources.unchanged;
  const passed =
    exactUnknownStaged &&
    exactNativeSession &&
    exactLaunchConfiguration &&
    antiReplayGap === false &&
    stableClear &&
    sameAgentReuse &&
    !unknownTextSubmitted &&
    cleanupComplete &&
    callerWorkspaceUnchanged &&
    unrelatedResourcesUnchanged;
  const preconditionBlocked =
    beforeStage?.execution.envelope?.result?.status !== "completed";
  const runnerFailure =
    executionFailure(records) ??
    deadlineFailure(deadline) ??
    cleanupDeadlineFailure(deadline);
  const disposition = runnerFailure || clearContradiction
    ? "fail"
    : preconditionBlocked
    ? "blocked"
    : passed
      ? "pass"
      : "fail";
  const finishedAt = now().toISOString();
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
    qualificationWorkspaceResource(workspace, stableQualificationWorkspace),
    ...(groupId ? [{ kind: "group", identity: groupId }] : []),
    ...(taskId ? [{ kind: "task", identity: taskId }] : []),
    ...(agentId ? [{ kind: "agent", identity: agentId }] : []),
    ...(initialResult?.turn?.id
      ? [{ kind: "turn", identity: initialResult.turn.id }]
      : []),
    ...(reuse?.execution.envelope?.result?.turn?.id
      ? [
          {
            kind: "turn",
            identity: reuse.execution.envelope.result.turn.id,
          },
        ]
      : []),
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: "real_herdr_harness",
    versions: {
      ...versions,
      model: observedModel ?? null,
      reasoning_effort: observedEffort ?? null,
    },
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: await realpath(workspace),
      managed_session_identity: managedNativeSession,
      staged_input_stimulus: {
        kind: "runner_authored_unknown_native_text",
        sha256: createHash("sha256").update(unknownText).digest("hex"),
      },
    },
    limits: {
      declared: scenario.execution.limits,
      measured: {
        turns:
          (initialResult?.turn ? 1 : 0) +
          (reuse?.execution.envelope?.result?.turn ? 1 : 0),
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification: scenario.execution.rationale,
    configuration_deviation_justification: null,
    trust_preflight: trustPreflight,
    invocations: records,
    observations: records.map(({ envelope }) => envelope),
    assertions: [
      { kind: "positive", id: "exact_unknown_snapshot_inspected", disposition: exactUnknownStaged ? "pass" : "fail" },
      { kind: "invariant", id: "exact_native_session_identity", disposition: exactNativeSession ? "pass" : "fail" },
      { kind: "invariant", id: "exact_launch_configuration", disposition: exactLaunchConfiguration ? "pass" : "fail" },
      { kind: "invariant", id: "state_change_seq_transition", disposition: antiReplayGap === false ? "pass" : "fail" },
      { kind: "positive", id: "clear_absent_for_stability_interval", disposition: stableClear ? "pass" : "fail" },
      { kind: "recovery", id: "same_agent_reuse_after_clear", disposition: sameAgentReuse ? "pass" : "fail" },
      { kind: "invariant", id: "non_submission_of_unknown_text", disposition: unknownTextSubmitted ? "fail" : "pass" },
      { kind: "invariant", id: "caller_owned_workspace_preservation", disposition: callerWorkspaceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "unrelated_herdr_resource_preservation", disposition: unrelatedResourcesUnchanged ? "pass" : "fail" },
      { kind: "cleanup", id: "owned_group_closed", disposition: cleanupComplete ? "pass" : "fail" },
    ],
    result: {
      disposition,
      reason: {
        code: runnerFailure?.code ?? (clearContradiction
          ? "clear_contradicted"
          : preconditionBlocked
          ? "live_precondition_unavailable"
          : passed
            ? "scenario_completed"
            : "scenario_assertion_failed"),
        message: runnerFailure?.message ?? (clearContradiction
          ? "The exact unknown staged-input snapshot reappeared during the bounded stability interval."
          : preconditionBlocked
          ? "The disposable Claude agent did not expose an exact native-session identity."
            : passed
            ? "Unknown staged input stayed absent for the full interval and the same agent was reused."
            : antiReplayGap === true
            ? "Herdr did not advance state_change_seq across the clear transition; the cycle remains unqualified."
            : "Staging, stable clearing, no-submission, reuse, or cleanup evidence was incomplete."),
        ...(clearContradiction
          ? {
              legal_recovery_actions: [
                "terminate_exact_native_process",
                "resume_same_native_session",
              ],
              recovery_action_disposition: "retained_for_explicit_operator_action",
            }
          : {}),
      },
    },
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition: resourceDisposition(resource.kind, cleanupComplete),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        {
          fullyObserved:
            scenario.id === "claude_unknown_staged_input_clear_and_reuse" &&
            exactUnknownStaged &&
            turnHistoryObserved,
          unchanged:
            !unknownTextSubmitted &&
            clearedOnlyExactSnapshot &&
            managedAgentPreserved &&
            callerWorkspaceUnchanged,
          basis: [
            "public turn history",
            "exact staged-input snapshot and token",
            "managed agent identity",
            "caller workspace fingerprint",
          ],
        },
      ),
      caller_owned_workspace: {
        path: resolve(cwd),
        before: beforeWorkspace,
        after: afterWorkspace,
      },
      unresolved_obligations: cleanupComplete
        ? []
        : [
            {
              code: "owned_group_not_closed",
              group_id: groupId ?? null,
              retained_state_root: stateHome,
            },
          ],
      completed_at: finishedAt,
    },
    state_sequence: {
      ...stateSequence,
      anti_replay_gap: antiReplayGap,
      post_clear_reappeared: Boolean(clearContradiction),
      process_reentry: "a separate public Drovr process observed the same Herdr session; the Herdr/native process was intentionally not restarted because this qualification does not permit manual termination or resume",
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (cleanupComplete) await rm(scratch, { recursive: true, force: true });
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return { id: scenario.id, result: disposition, evidence: evidencePath };
}

async function recordScenarioFailure({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  env,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  deadline,
  qualificationWorkspace,
  qualificationWorkspaceFingerprintBefore,
  qualificationWorkspaceAvailable,
  stableQualificationWorkspace,
  qualificationWorkspaceLock,
  trustPreflight,
  error,
}) {
  const records = [];
  deadline.completeScenario();
  const list = await invokeDrovr({
    command: drovrCommand,
    args: ["group", "list"],
    expectedCommand: "group list",
    cwd,
    env,
    now,
    deadline,
    cleanup: true,
    timeoutMs: 15_000,
  });
  records.push(list.record);
  const ownedGroups = (list.execution.envelope?.result?.groups ?? []).filter(
    ({ key }) => key?.startsWith(`qualification-${scenario.id}-`),
  );
  const closures = [];
  for (const group of ownedGroups) {
    const closure = await invokeDrovr({
      command: drovrCommand,
      args: ["group", "close", group.id, "--force"],
      expectedCommand: "group close",
      cwd,
      env,
      now,
      deadline,
      cleanup: true,
      timeoutMs: 30_000,
    });
    records.push(closure.record);
    closures.push(closure);
  }
  const cleanupComplete =
    list.execution.envelope?.result?.status === "completed" &&
    closures.every(
      ({ execution }) => execution.envelope?.result?.status === "closed",
    );
  const finishedAt = now().toISOString();
  const qualificationWorkspaceFingerprintAfter = qualificationWorkspace
    ? await safeWorkspaceFingerprint(qualificationWorkspace)
    : null;
  const nativeTrustConfigurationPreservation =
    await observeNativeTrustConfiguration(trustPreflight);
  const failureDisposition =
    scenario.execution.kind === "real_herdr_harness" &&
    trustPreflight?.status === "blocked"
      ? "blocked"
      : "fail";
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
    ...(qualificationWorkspace && qualificationWorkspaceAvailable
      ? [qualificationWorkspaceResource(qualificationWorkspace, stableQualificationWorkspace)]
      : []),
    ...(qualificationWorkspaceLock?.acquired
      ? [qualificationWorkspaceLockResource(qualificationWorkspaceLock)]
      : []),
    ...ownedGroups.map(({ id }) => ({ kind: "group", identity: id })),
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: scenario.execution.kind,
    versions: {
      drovr: "unavailable-after-internal-failure",
      herdr: "unavailable-after-internal-failure",
      integration: { codex: "unavailable", claude: "unavailable" },
      codex: "unavailable",
      claude: "unavailable",
      model: null,
      reasoning_effort: null,
    },
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: resolve(cwd),
      qualification_workspace: qualificationWorkspace,
      qualification_workspace_lock: qualificationWorkspaceLock?.path ?? null,
      managed_session_identity: null,
    },
    limits: {
      declared: scenario.execution.limits ?? {
        max_turns: 0,
        max_retries: 0,
        max_elapsed: "0s",
      },
      measured: {
        turns: 0,
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification:
      scenario.execution.kind === "real_herdr_harness"
        ? scenario.execution.rationale
        : null,
    configuration_deviation_justification: null,
    trust_preflight: trustPreflight,
    invocations: records,
    observations: [
      ...records.map(({ envelope }) => envelope),
      ...(scenario.execution.kind === "real_herdr_harness"
        ? [{ type: "trust_preflight", result: trustPreflight }]
        : []),
    ],
    assertions: [
      {
        kind: "cleanup",
        id: "failure_path_cleanup",
        disposition: cleanupComplete ? "pass" : "fail",
      },
      ...(scenario.execution.kind === "real_herdr_harness"
        ? [{
            kind: "prerequisite",
            id: "qualification_trust_preflight",
            disposition: trustPreflightAssertionDisposition(trustPreflight),
          }]
        : []),
    ],
    result: {
      disposition: failureDisposition,
      reason: {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition:
          resource.kind === "qualification_workspace_lock"
            ? qualificationWorkspaceLockDisposition(qualificationWorkspaceLock)
            : resourceDisposition(resource.kind, cleanupComplete),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        { basis: ["failure-path cleanup envelopes only"] },
      ),
      caller_owned_workspace: {
        path: resolve(cwd),
        before: "not_observed_before_internal_failure",
        after: await safeWorkspaceFingerprint(cwd),
      },
      qualification_workspace:
        qualificationWorkspaceFingerprintBefore ||
        qualificationWorkspaceFingerprintAfter
          ? {
              before: qualificationWorkspaceFingerprintBefore,
              after: qualificationWorkspaceFingerprintAfter,
            }
          : null,
      native_trust_configuration_preservation:
        nativeTrustConfigurationPreservation,
      unresolved_obligations: [
        ...qualificationWorkspaceLockObligations(qualificationWorkspaceLock),
        ...(cleanupComplete
          ? []
          : [
              {
                code: "failure_path_cleanup_incomplete",
                retained_state_root: stateHome,
                group_ids: ownedGroups.map(({ id }) => id),
              },
            ]),
      ],
      completed_at: finishedAt,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (cleanupComplete) await rm(scratch, { recursive: true, force: true });
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return { id: scenario.id, result: failureDisposition, evidence: evidencePath };
}

async function runCodexLifecycleScenario({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  scenarioEnvironment,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  deadline,
  workspace,
  stableQualificationWorkspace,
  trustPreflight,
}) {
  const beforeWorkspace = await workspaceFingerprint(cwd);
  const suffix = randomUUID();
  const groupKey = `qualification-${scenario.id}-${suffix}`;
  const launch = qualificationLaunch(doctorExecution.envelope, "codex");
  const records = [
    invocationRecord(
      ["drovr", "doctor"],
      doctorExecution,
      doctorStartedAt,
      doctorFinishedAt,
    ),
  ];
  const invoke = createInvocationRecorder({
    records,
    command: drovrCommand,
    cwd,
    env: scenarioEnvironment,
    now,
    deadline,
  });
  const beforeGroups = await invoke(["group", "list"], "group list");
  const taskOpen = await invoke(
    [
      "task",
      "open",
      "--group",
      groupKey,
      "--group-label",
      `Qualification ${scenario.id}`,
      "--key",
      `task-${suffix}`,
      "--cwd",
      workspace,
    ],
    "task open",
  );
  const taskId = taskOpen.execution.envelope?.result?.task?.id;
  const groupId = taskOpen.execution.envelope?.result?.group?.id;
  let agentStart;
  if (typeof taskId === "string") {
    agentStart = await invoke(
      [
        "agent",
        "start",
        taskId,
        "--key",
        `agent-${suffix}`,
        "--harness",
        "codex",
        "--model",
        launch.model,
        "--effort",
        launch.effort,
        "--capability",
        "read-only",
      ],
      "agent start",
      { timeoutMs: 15_000 },
    );
  }
  const agentId = agentStart?.execution.envelope?.result?.agent?.id;
  let steeringTurn;
  let timeoutTurn;
  let cancellationTurn;
  let cancellation;
  let reuse;
  let steering;
  let shortWait;
  let steeringSettled;
  let timeoutSettled;
  if (typeof agentId === "string") {
    steeringTurn = await invoke(
      [
        "turn",
        "start",
        agentId,
        "Run a shell command that sleeps for 8 seconds. Do not send a final answer until it completes. Then reply exactly: QUALIFY-CODEX-LIFECYCLE-HOLD-OK",
      ],
      "turn start",
      { timeoutMs: 30_000 },
    );
    const steeringTurnId = steeringTurn.execution.envelope?.result?.turn?.id;
    if (typeof steeringTurnId === "string") {
      steering = await invoke(
        [
          "turn",
          "send",
          steeringTurnId,
          "--caller-key",
          `qualification-steering-${suffix}`,
          "Reply exactly: QUALIFY-CODEX-STEERING-OK",
        ],
        "turn send",
        { timeoutMs: 15_000 },
      );
      steeringSettled = await invoke(
        ["turn", "wait", steeringTurnId, "--timeout", "60s"],
        "turn wait",
        { timeoutMs: 65_000 },
      );
    }
    timeoutTurn = await invoke(
      ["turn", "start", agentId, "Reply exactly: QUALIFY-CODEX-TIMEOUT-OK"],
      "turn start",
      { timeoutMs: 15_000 },
    );
    const timeoutTurnId = timeoutTurn.execution.envelope?.result?.turn?.id;
    if (typeof timeoutTurnId === "string") {
      shortWait = await invoke(
        ["turn", "wait", timeoutTurnId, "--timeout", "1ms"],
        "turn wait",
        { timeoutMs: 5_000 },
      );
      timeoutSettled = await invoke(
        ["turn", "wait", timeoutTurnId, "--timeout", "60s"],
        "turn wait",
        { timeoutMs: 65_000 },
      );
    }
    cancellationTurn = await invoke(
      ["turn", "start", agentId, "Keep working until interrupted."],
      "turn start",
      { timeoutMs: 15_000 },
    );
    const cancellationTurnId =
      cancellationTurn.execution.envelope?.result?.turn?.id;
    if (typeof cancellationTurnId === "string") {
      cancellation = await invoke(
        ["turn", "cancel", cancellationTurnId],
        "turn cancel",
        { timeoutMs: 15_000 },
      );
      reuse = await invoke(
        [
          "ask",
          agentId,
          "--timeout",
          "60s",
          "Reply exactly: QUALIFY-CODEX-REUSE-OK",
        ],
        "ask",
        { timeoutMs: 65_000 },
      );
    }
  }
  const finalAgent = typeof agentId === "string"
    ? await invoke(["agent", "get", agentId], "agent get")
    : null;
  const managedNativeSession =
    agentStart?.execution.envelope?.result?.agent?.native_session ?? null;
  const exactNativeSession =
    typeof managedNativeSession === "string" &&
    finalAgent?.execution.envelope?.result?.agent?.native_session ===
      managedNativeSession;
  deadline.completeScenario();
  let cleanup;
  if (typeof groupId === "string") {
    cleanup = await invoke(
      ["group", "close", groupId, "--force"],
      "group close",
      { timeoutMs: 30_000, cleanup: true },
    );
  }
  const afterGroups = await invoke(["group", "list"], "group list", {
    cleanup: true,
  });
  const afterWorkspace = await workspaceFingerprint(cwd);
  const cancelled =
    cancellation?.execution.envelope?.result?.status === "cancelled" &&
    cancellation.execution.envelope.result.turn?.status === "cancelled" &&
    cancellation.execution.envelope.result.agent?.id === agentId;
  const reused =
    reuse?.execution.envelope?.result?.status === "completed" &&
    reuse.execution.envelope.result.agent?.id === agentId &&
    reuse.execution.envelope.result.turn?.result?.text?.trim() ===
      "QUALIFY-CODEX-REUSE-OK";
  const steered =
    steering?.execution.envelope?.result?.agent?.id === agentId &&
    ["sent", "reconciling", "working"].includes(
      steering?.execution.envelope?.result?.status,
    ) &&
    steeringSettled?.execution.envelope?.result?.status === "completed" &&
    steeringSettled.execution.envelope.result.agent?.id === agentId &&
    steeringSettled.execution.envelope.result.turn?.input_count === 2 &&
    steeringSettled.execution.envelope.result.turn?.result?.text?.trim() ===
      "QUALIFY-CODEX-STEERING-OK";
  const timedOutAndSettled =
    shortWait?.execution.envelope?.result?.status === "still_running" &&
    timeoutSettled?.execution.envelope?.result?.status === "completed" &&
    timeoutSettled.execution.envelope.result.agent?.id === agentId &&
    timeoutSettled.execution.envelope.result.turn?.result?.text?.trim() ===
      "QUALIFY-CODEX-TIMEOUT-OK";
  const cleanupComplete = cleanup?.execution.envelope?.result?.status === "closed";
  const callerWorkspaceUnchanged =
    JSON.stringify(beforeWorkspace) === JSON.stringify(afterWorkspace);
  const unrelatedResources = compareUnrelatedGroups(
    beforeGroups.execution.envelope?.result?.groups,
    afterGroups.execution.envelope?.result?.groups,
    groupKey,
  );
  const unrelatedResourcesUnchanged = unrelatedResources.unchanged;
  const lifecyclePassed = cancelled && reused && steered && timedOutAndSettled;
  const observedModel = agentStart?.execution.envelope?.result?.agent?.model;
  const observedEffort = agentStart?.execution.envelope?.result?.agent?.effort;
  const exactLaunchConfiguration =
    observedModel === launch.model && observedEffort === launch.effort;
  const runnerFailure =
    executionFailure(records) ??
    deadlineFailure(deadline) ??
    cleanupDeadlineFailure(deadline);
  const passed =
    !runnerFailure &&
    lifecyclePassed &&
    exactLaunchConfiguration &&
    exactNativeSession &&
    cleanupComplete &&
    callerWorkspaceUnchanged &&
    unrelatedResourcesUnchanged;
  const finishedAt = now().toISOString();
  const turnIds = [
    steeringTurn?.execution.envelope?.result?.turn?.id,
    timeoutTurn?.execution.envelope?.result?.turn?.id,
    cancellationTurn?.execution.envelope?.result?.turn?.id,
    reuse?.execution.envelope?.result?.turn?.id,
  ].filter(Boolean);
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
    qualificationWorkspaceResource(workspace, stableQualificationWorkspace),
    ...(groupId ? [{ kind: "group", identity: groupId }] : []),
    ...(taskId ? [{ kind: "task", identity: taskId }] : []),
    ...(agentId ? [{ kind: "agent", identity: agentId }] : []),
    ...turnIds.map((identity) => ({ kind: "turn", identity })),
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: "real_herdr_harness",
    versions: {
      ...versions,
      model: observedModel ?? null,
      reasoning_effort: observedEffort ?? null,
    },
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: await realpath(workspace),
      managed_session_identity: managedNativeSession,
    },
    limits: {
      declared: scenario.execution.limits,
      measured: {
        turns: turnIds.length,
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification: scenario.execution.rationale,
    configuration_deviation_justification: null,
    trust_preflight: trustPreflight,
    invocations: records,
    observations: records.map(({ envelope }) => envelope),
    assertions: [
      { kind: "positive", id: "steering_on_exact_native_session", disposition: steered ? "pass" : "fail" },
      { kind: "invariant", id: "exact_native_session_identity", disposition: exactNativeSession ? "pass" : "fail" },
      { kind: "invariant", id: "exact_launch_configuration", disposition: exactLaunchConfiguration ? "pass" : "fail" },
      { kind: "uncertain", id: "bounded_timeout_then_settlement", disposition: timedOutAndSettled ? "pass" : "fail" },
      { kind: "positive", id: "exact_cancellation_settlement", disposition: cancelled ? "pass" : "fail" },
      { kind: "recovery", id: "same_agent_reuse_after_recovery", disposition: reused ? "pass" : "fail" },
      { kind: "invariant", id: "caller_owned_workspace_preservation", disposition: callerWorkspaceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "unrelated_herdr_resource_preservation", disposition: unrelatedResourcesUnchanged ? "pass" : "fail" },
      { kind: "cleanup", id: "owned_group_closed", disposition: cleanupComplete ? "pass" : "fail" },
    ],
    result: {
      disposition: passed ? "pass" : "fail",
      reason: {
        code: runnerFailure?.code ?? (passed ? "scenario_completed" : "scenario_assertion_failed"),
        message: runnerFailure?.message ?? (passed
          ? "The bounded Codex lifecycle scenario and exact cleanup completed."
          : "Lifecycle, identity, safety, or cleanup evidence was incomplete."),
      },
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition: resourceDisposition(resource.kind, cleanupComplete),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        {
          basis: [
            "public lifecycle envelopes",
            "managed native-session identity",
            "caller workspace fingerprint",
          ],
        },
      ),
      caller_owned_workspace: {
        path: resolve(cwd),
        before: beforeWorkspace,
        after: afterWorkspace,
      },
      unresolved_obligations: cleanupComplete
        ? []
        : [{ code: "owned_group_not_closed", group_id: groupId ?? null }],
      completed_at: finishedAt,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (cleanupComplete) await rm(scratch, { recursive: true, force: true });
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return { id: scenario.id, result: passed ? "pass" : "fail", evidence: evidencePath };
}

async function runCodexPromptScenario({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  scenarioEnvironment,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  deadline,
  workspace,
  stableQualificationWorkspace,
  trustPreflight,
}) {
  const secondPromptPath = join(scratch, "prompt-file-2.txt");
  await writeFile(secondPromptPath, "Reply exactly: QUALIFY-CODEX-FILE-2-OK\n");
  const promptSourceBefore = await fileFingerprint(secondPromptPath);
  const beforeWorkspace = await workspaceFingerprint(cwd);
  const suffix = randomUUID();
  const groupKey = `qualification-${scenario.id}-${suffix}`;
  const launch = qualificationLaunch(doctorExecution.envelope, "codex");
  const records = [
    invocationRecord(
      ["drovr", "doctor"],
      doctorExecution,
      doctorStartedAt,
      doctorFinishedAt,
    ),
  ];
  const invoke = createInvocationRecorder({
    records,
    command: drovrCommand,
    cwd,
    env: scenarioEnvironment,
    now,
    deadline,
  });
  const beforeGroups = await invoke(["group", "list"], "group list");
  const delegate = await invoke(
    [
      "delegate",
      "--group",
      groupKey,
      "--group-label",
      `Qualification ${scenario.id}`,
      "--task-key",
      `task-${suffix}`,
      "--agent-key",
      `agent-${suffix}`,
      "--cwd",
      workspace,
      "--harness",
      "codex",
      "--model",
      launch.model,
      "--effort",
      launch.effort,
      "--capability",
      "read-only",
      "--timeout",
      "90s",
      "Reply exactly: QUALIFY-CODEX-POSITIONAL-1-OK",
    ],
    "delegate",
    { timeoutMs: 95_000 },
  );
  let group = delegate.execution.envelope?.result?.group;
  if (!group?.id) {
    const discovery = await invoke(["group", "list"], "group list");
    group = discovery.execution.envelope?.result?.groups?.find(
      (candidate) => candidate.key === groupKey,
    );
  }
  const agentId = delegate.execution.envelope?.result?.agent?.id;
  const initialAgent = typeof agentId === "string"
    ? await invoke(["agent", "get", agentId], "agent get")
    : null;
  let second;
  let third;
  if (typeof agentId === "string") {
    second = await invoke(
      ["ask", agentId, "--prompt-file", secondPromptPath, "--timeout", "90s"],
      "ask",
      { timeoutMs: 95_000 },
    );
    third = await invoke(
      ["ask", agentId, "--timeout", "90s"],
      "ask",
      { timeoutMs: 95_000, input: "Reply exactly: QUALIFY-CODEX-STDIN-3-OK\n" },
    );
  }
  const finalAgent = typeof agentId === "string"
    ? await invoke(["agent", "get", agentId], "agent get")
    : null;
  const managedNativeSession =
    initialAgent?.execution.envelope?.result?.agent?.native_session ?? null;
  const exactNativeSession =
    typeof managedNativeSession === "string" &&
    finalAgent?.execution.envelope?.result?.agent?.native_session ===
      managedNativeSession;
  const groupId = group?.id;
  deadline.completeScenario();
  let cleanup;
  if (typeof groupId === "string") {
    cleanup = await invoke(
      ["group", "close", groupId, "--force"],
      "group close",
      { timeoutMs: 30_000, cleanup: true },
    );
  }
  const afterGroups = await invoke(["group", "list"], "group list", {
    cleanup: true,
  });
  const afterWorkspace = await workspaceFingerprint(cwd);
  const promptSourceAfter = await fileFingerprint(secondPromptPath);
  const promptSourceUnchanged =
    JSON.stringify(promptSourceBefore) === JSON.stringify(promptSourceAfter);
  const turnResults = [delegate, second, third]
    .filter(Boolean)
    .map(({ execution }) => execution.envelope?.result);
  const sameAgent =
    turnResults.length === 3 &&
    turnResults.every((result) => result?.agent?.id === agentId);
  const completed =
    turnResults.length === 3 &&
    turnResults.every(
      (result, index) =>
        result?.status === "completed" &&
        result?.turn?.input_count === 1 &&
        result?.turn?.result?.text?.trim() ===
          [
            "QUALIFY-CODEX-POSITIONAL-1-OK",
            "QUALIFY-CODEX-FILE-2-OK",
            "QUALIFY-CODEX-STDIN-3-OK",
          ][index],
    );
  const observedModel = turnResults[0]?.agent?.model;
  const observedEffort = turnResults[0]?.agent?.effort;
  const exactLaunchConfiguration =
    observedModel === launch.model && observedEffort === launch.effort;
  const cleanupComplete = cleanup?.execution.envelope?.result?.status === "closed";
  const unrelatedResources = compareUnrelatedGroups(
    beforeGroups.execution.envelope?.result?.groups,
    afterGroups.execution.envelope?.result?.groups,
    groupKey,
  );
  const unrelatedResourcesUnchanged = unrelatedResources.unchanged;
  const callerWorkspaceUnchanged =
    JSON.stringify(beforeWorkspace) === JSON.stringify(afterWorkspace);
  const runnerFailure =
    executionFailure(records) ??
    deadlineFailure(deadline) ??
    cleanupDeadlineFailure(deadline);
  const passed =
    !runnerFailure &&
    completed &&
    sameAgent &&
    exactNativeSession &&
    exactLaunchConfiguration &&
    promptSourceUnchanged &&
    cleanupComplete &&
    unrelatedResourcesUnchanged &&
    callerWorkspaceUnchanged;
  const finishedAt = now().toISOString();
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
    qualificationWorkspaceResource(workspace, stableQualificationWorkspace),
    ...(groupId ? [{ kind: "group", identity: groupId }] : []),
    ...(turnResults[0]?.task?.id
      ? [{ kind: "task", identity: turnResults[0].task.id }]
      : []),
    ...(agentId ? [{ kind: "agent", identity: agentId }] : []),
    ...turnResults
      .filter((result) => result?.turn?.id)
      .map((result) => ({ kind: "turn", identity: result.turn.id })),
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: "real_herdr_harness",
    versions: {
      ...versions,
      model: observedModel ?? null,
      reasoning_effort: observedEffort ?? null,
    },
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: await realpath(workspace),
      managed_session_identity: managedNativeSession,
    },
    limits: {
      declared: scenario.execution.limits,
      measured: {
        turns: turnResults.length,
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification: scenario.execution.rationale,
    configuration_deviation_justification: null,
    trust_preflight: trustPreflight,
    invocations: records,
    observations: records.map(({ envelope }) => envelope),
    assertions: [
      { kind: "positive", id: "positional_file_and_stdin_completed", disposition: completed ? "pass" : "fail" },
      { kind: "invariant", id: "same_managed_agent_across_turns", disposition: sameAgent ? "pass" : "fail" },
      { kind: "invariant", id: "exact_native_session_identity", disposition: exactNativeSession ? "pass" : "fail" },
      { kind: "invariant", id: "exact_launch_configuration", disposition: exactLaunchConfiguration ? "pass" : "fail" },
      { kind: "invariant", id: "prompt_source_preservation", disposition: promptSourceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "caller_owned_workspace_preservation", disposition: callerWorkspaceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "unrelated_herdr_resource_preservation", disposition: unrelatedResourcesUnchanged ? "pass" : "fail" },
      { kind: "cleanup", id: "owned_group_closed", disposition: cleanupComplete ? "pass" : "fail" },
    ],
    result: {
      disposition: passed ? "pass" : "fail",
      reason: {
        code: runnerFailure?.code ?? (passed ? "scenario_completed" : "scenario_assertion_failed"),
        message: runnerFailure?.message ?? (passed
          ? "One Codex managed agent completed file and stdin turns and was cleaned up exactly."
          : "The Codex multi-turn scenario or one of its safety assertions failed."),
      },
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition: resourceDisposition(resource.kind, cleanupComplete),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        {
          basis: [
            "prompt source SHA-256",
            "public managed agent identity",
            "caller workspace fingerprint",
          ],
        },
      ),
      prompt_sources: [{ before: promptSourceBefore, after: promptSourceAfter }],
      caller_owned_workspace: {
        path: resolve(cwd),
        before: beforeWorkspace,
        after: afterWorkspace,
      },
      unresolved_obligations: cleanupComplete
        ? []
        : [{ code: "owned_group_not_closed", group_id: groupId ?? null }],
      completed_at: finishedAt,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (cleanupComplete) await rm(scratch, { recursive: true, force: true });
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return { id: scenario.id, result: passed ? "pass" : "fail", evidence: evidencePath };
}

async function runPromptFileScenario({
  catalog,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  scenarioEnvironment,
  scratch,
  stateHome,
  runtimeDirectory,
  now,
  startedAt,
  doctorExecution,
  doctorStartedAt,
  doctorFinishedAt,
  versions,
  deadline,
  workspace,
  stableQualificationWorkspace,
  trustPreflight,
}) {
  const promptPath = join(scratch, "prompt.txt");
  const specification = promptFileSpecifications.get(scenario.id);
  if (!specification) throw new Error(`missing prompt-file specification: ${scenario.id}`);
  const isOwnedRecovery = specification.ownedRecovery === true;
  const reuseAfterCompletion = specification.reuseAfterCompletion === true;
  const harness = specification.harness;
  const launch = qualificationLaunch(doctorExecution.envelope, harness);
  const model = launch.model;
  const expectedResponse = specification.expectedResponse;
  const prompt = specification.prompt(expectedResponse);
  await writeFile(promptPath, prompt);
  const promptSourceBefore = await fileFingerprint(promptPath);
  const limits = scenario.execution.limits ?? {
    max_turns: 1,
    max_retries: 0,
    max_elapsed: "2m",
  };
  const beforeWorkspace = await workspaceFingerprint(cwd);
  const suffix = randomUUID();
  const groupKey = `qualification-${scenario.id}-${suffix}`;
  const invocationRecords = [
    invocationRecord(
      ["drovr", "doctor"],
      doctorExecution,
      doctorStartedAt,
      doctorFinishedAt,
    ),
  ];
  const invoke = createInvocationRecorder({
    records: invocationRecords,
    command: drovrCommand,
    cwd,
    env: scenarioEnvironment,
    now,
    deadline,
  });
  const beforeGroups = await invoke(["group", "list"], "group list");
  const behaviorTimeoutMs = isOwnedRecovery
    ? 45_000
    : Math.max(1_000, parseDuration(limits.max_elapsed) - 60_000);
  const delegate = await invoke(
    [
      "delegate",
      "--group",
      groupKey,
      "--group-label",
      `Qualification ${scenario.id}`,
      "--task-key",
      `task-${suffix}`,
      "--agent-key",
      `agent-${suffix}`,
      "--cwd",
      workspace,
      "--harness",
      harness,
      "--model",
      model,
      "--effort",
      launch.effort,
      "--capability",
      "read-only",
      "--timeout",
      `${behaviorTimeoutMs}ms`,
      "--prompt-file",
      promptPath,
    ],
    "delegate",
    { timeoutMs: behaviorTimeoutMs + 5_000 },
  );

  let group = delegate.execution.envelope?.result?.group;
  if (!group?.id) {
    const discovery = await invoke(["group", "list"], "group list");
    group = discovery.execution.envelope?.result?.groups?.find(
      (candidate) => candidate.key === groupKey,
    );
  }
  const directAgentId = delegate.execution.envelope?.result?.agent?.id;
  let initialAgent = typeof directAgentId === "string"
    ? await invoke(["agent", "get", directAgentId], "agent get")
    : null;
  const result = delegate.execution.envelope?.result;
  const directCompleted =
    delegate.execution.exitCode === 0 &&
    delegate.execution.envelope.ok === true &&
    result?.status === "completed" &&
    result?.turn?.input_count === 1 &&
    result?.turn?.result?.text?.trim() === expectedResponse &&
    result?.agent?.harness === harness &&
    result?.agent?.model === model &&
    result?.agent?.effort === launch.effort;
  const initialFailure = !directCompleted && !isOwnedRecovery
    ? {
        code: delegate.execution.envelope?.error?.outcome ??
          "initial_turn_not_completed",
        message: delegate.execution.envelope?.error?.message ??
          `The initial ${harness} turn did not complete with the expected qualification sentinel.`,
      }
    : null;
  let reuse;
  if (reuseAfterCompletion && directCompleted && typeof directAgentId === "string") {
    const reusePrompt = typeof specification.reusePrompt === "function"
      ? specification.reusePrompt(specification.reuseResponse)
      : correctionReviewPrompt(specification.reuseResponse);
    reuse = await invoke(
      [
        "ask",
        directAgentId,
        "--timeout",
        `${behaviorTimeoutMs}ms`,
        reusePrompt,
      ],
      "ask",
      { timeoutMs: behaviorTimeoutMs + 5_000 },
    );
  }
  let recoveredTask;
  let recoveredAgent;
  let recoveredTurn;
  let ownedInspection;
  let ownedSubmission;
  let ownedProjection;
  if (isOwnedRecovery && group?.id) {
    const taskList = await invoke(
      ["task", "list", "--group", group.id],
      "task list",
    );
    recoveredTask = taskList.execution.envelope?.result?.tasks?.[0];
    if (recoveredTask?.id) {
      const agentList = await invoke(
        ["agent", "list", "--task", recoveredTask.id],
        "agent list",
      );
      recoveredAgent = agentList.execution.envelope?.result?.agents?.[0];
      if (!initialAgent && recoveredAgent?.id) {
        initialAgent = await invoke(
          ["agent", "get", recoveredAgent.id],
          "agent get",
        );
      }
    }
    if (recoveredAgent?.id) {
      const turnList = await invoke(
        ["turn", "list", "--agent", recoveredAgent.id],
        "turn list",
      );
      recoveredTurn = turnList.execution.envelope?.result?.turns?.[0];
      ownedInspection = await invoke(
        ["agent", "staged-input", recoveredAgent.id],
        "agent staged-input",
      );
      const staged = ownedInspection.execution.envelope?.result?.staged_input;
      if (
        staged?.ownership === "drovr" &&
        staged?.turn_id === recoveredTurn?.id &&
        typeof staged.token === "string"
      ) {
        ownedSubmission = await invoke(
          [
            "agent",
            "staged-input",
            recoveredAgent.id,
            "--submit",
            staged.token,
          ],
          "agent staged-input",
          { timeoutMs: 30_000 },
        );
        const projectionDeadline = Date.now() + 30_000;
        do {
          ownedProjection = await invoke(
            ["turn", "get", recoveredTurn.id, "--include-messages"],
            "turn get",
          );
          const turn = ownedProjection.execution.envelope?.result?.turn;
          if (turn?.late_result || turn?.result) break;
          await boundedDelay(deadline.commandTimeout(2_000));
        } while (Date.now() < projectionDeadline);
      }
    }
  }
  const managedAgentId = directAgentId ?? recoveredAgent?.id;
  const finalAgent = typeof managedAgentId === "string"
    ? await invoke(["agent", "get", managedAgentId], "agent get")
    : null;
  const managedNativeSession =
    initialAgent?.execution.envelope?.result?.agent?.native_session ?? null;
  const exactNativeSession =
    typeof managedNativeSession === "string" &&
    finalAgent?.execution.envelope?.result?.agent?.native_session ===
      managedNativeSession;
  deadline.completeScenario();
  let cleanup;
  if (typeof group?.id === "string") {
    cleanup = await invoke(
      ["group", "close", group.id, "--force"],
      "group close",
      { timeoutMs: 30_000, cleanup: true },
    );
  }
  const afterGroups = await invoke(["group", "list"], "group list", {
    cleanup: true,
  });
  const afterWorkspace = await workspaceFingerprint(cwd);
  const promptSourceAfter = await fileFingerprint(promptPath);
  const promptSourceUnchanged =
    JSON.stringify(promptSourceBefore) === JSON.stringify(promptSourceAfter);
  const reuseResult = reuse?.execution.envelope?.result;
  const projectedTurn = ownedProjection?.execution.envelope?.result?.turn;
  const ownedRecovered =
    ownedInspection?.execution.envelope?.result?.status === "staged_input" &&
    ownedInspection.execution.envelope.result.staged_input?.ownership ===
      "drovr" &&
    ownedInspection.execution.envelope.result.staged_input?.turn_id ===
      recoveredTurn?.id &&
    ownedSubmission?.execution.envelope?.result?.status === "submitted" &&
    ownedSubmission.execution.envelope.result.agent?.id === recoveredAgent?.id &&
    (projectedTurn?.late_result?.text?.trim() === expectedResponse ||
      projectedTurn?.result?.text?.trim() === expectedResponse);
  const cleanupComplete = cleanup?.execution.envelope?.result?.status === "closed";
  const unrelatedResources = compareUnrelatedGroups(
    beforeGroups.execution.envelope?.result?.groups,
    afterGroups.execution.envelope?.result?.groups,
    groupKey,
  );
  const unrelatedResourcesUnchanged = unrelatedResources.unchanged;
  const callerWorkspaceUnchanged =
    JSON.stringify(beforeWorkspace) === JSON.stringify(afterWorkspace);
  const observedAgent =
    result?.agent ??
    finalAgent?.execution.envelope?.result?.agent ??
    recoveredAgent;
  const observedModel = observedAgent?.model;
  const observedEffort = observedAgent?.effort;
  const exactLaunchConfiguration =
    observedModel === model && observedEffort === launch.effort;
  const sameAgentReuse =
    !reuseAfterCompletion ||
    (reuseResult?.status === "completed" &&
      reuseResult.agent?.id === managedAgentId &&
      (reuseResult.agent?.native_session ??
        finalAgent?.execution.envelope?.result?.agent?.native_session) ===
        managedNativeSession &&
      reuseResult.turn?.input_count === 1 &&
      reuseResult.turn?.result?.text?.trim() === specification.reuseResponse);
  const runnerFailure =
    executionFailure(invocationRecords) ??
    deadlineFailure(deadline) ??
    cleanupDeadlineFailure(deadline);
  const passed =
    beforeGroups.execution.exitCode === 0 &&
    !runnerFailure &&
    exactNativeSession &&
    exactLaunchConfiguration &&
    promptSourceUnchanged &&
    (isOwnedRecovery ? ownedRecovered : directCompleted) &&
    sameAgentReuse &&
    cleanupComplete &&
    unrelatedResourcesUnchanged &&
    callerWorkspaceUnchanged;
  const ownedPreconditionBlocked =
    isOwnedRecovery &&
    ownedInspection?.execution.envelope?.result?.status !== "staged_input";
  const disposition = runnerFailure
    ? "fail"
    : ownedPreconditionBlocked
      ? "blocked"
      : passed
        ? "pass"
        : "fail";
  const finishedAt = now().toISOString();
  const ownedResources = [
    { kind: "state_root", identity: stateHome },
    { kind: "runtime_root", identity: runtimeDirectory },
    qualificationWorkspaceResource(workspace, stableQualificationWorkspace),
    ...(group?.id ? [{ kind: "group", identity: group.id }] : []),
    ...(result?.task?.id ? [{ kind: "task", identity: result.task.id }] : []),
    ...(!result?.task?.id && recoveredTask?.id
      ? [{ kind: "task", identity: recoveredTask.id }]
      : []),
    ...(result?.agent?.id ? [{ kind: "agent", identity: result.agent.id }] : []),
    ...(!result?.agent?.id && recoveredAgent?.id
      ? [{ kind: "agent", identity: recoveredAgent.id }]
      : []),
    ...(result?.turn?.id ? [{ kind: "turn", identity: result.turn.id }] : []),
    ...(!result?.turn?.id && recoveredTurn?.id
      ? [{ kind: "turn", identity: recoveredTurn.id }]
      : []),
    ...(reuseResult?.turn?.id
      ? [{ kind: "turn", identity: reuseResult.turn.id }]
      : []),
  ];
  const evidence = {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: catalog.version,
    catalog_digest: digestCanonical(catalog),
    scenario_id: scenario.id,
    execution_kind: "real_herdr_harness",
    versions: {
      ...versions,
      model: observedModel ?? null,
      reasoning_effort: observedEffort ?? null,
    },
    environment: {
      os: platform(),
      architecture: arch(),
      isolated_state_root: stateHome,
      isolated_runtime_root: runtimeDirectory,
      cwd: await realpath(workspace),
      managed_session_identity: managedNativeSession,
    },
    limits: {
      declared: limits,
      measured: {
        turns:
          (result?.turn ? 1 : 0) +
          (reuseResult?.turn ? 1 : 0) +
          (!result?.turn && recoveredTurn ? 1 : 0),
        retries: 0,
        elapsed_ms: deadline.scenarioElapsedMs(),
      },
      cleanup: deadline.cleanupMeasurement(),
    },
    live_run_justification:
      scenario.execution.kind === "real_herdr_harness"
        ? scenario.execution.rationale
        : "Issue 65 requires a real Codex/Herdr baseline before issue 66 captures deterministic replay traces.",
    configuration_deviation_justification: null,
    trust_preflight: trustPreflight,
    invocations: invocationRecords,
    observations: invocationRecords.map(({ envelope }) => envelope),
    assertions: [
      {
        kind: isOwnedRecovery ? "recovery" : "positive",
        id: isOwnedRecovery
          ? "exact_owned_snapshot_submitted_to_original_turn"
          : "completed_with_exact_sentinel",
        disposition: (isOwnedRecovery ? ownedRecovered : directCompleted)
          ? "pass"
          : "fail",
      },
      {
        kind: "invariant",
        id: "exact_agent_identity",
        disposition: result?.agent?.id || recoveredAgent?.id ? "pass" : "fail",
      },
      { kind: "invariant", id: "exact_native_session_identity", disposition: exactNativeSession ? "pass" : "fail" },
      { kind: "invariant", id: "exact_launch_configuration", disposition: exactLaunchConfiguration ? "pass" : "fail" },
      { kind: "invariant", id: "prompt_source_preservation", disposition: promptSourceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "caller_owned_workspace_preservation", disposition: callerWorkspaceUnchanged ? "pass" : "fail" },
      { kind: "invariant", id: "unrelated_herdr_resource_preservation", disposition: unrelatedResourcesUnchanged ? "pass" : "fail" },
      ...(reuseAfterCompletion
        ? [{ kind: "recovery", id: "same_agent_reuse_after_initial", disposition: sameAgentReuse ? "pass" : "fail" }]
        : []),
      { kind: "cleanup", id: "owned_group_closed", disposition: cleanupComplete ? "pass" : "fail" },
    ],
    result: {
      disposition,
      reason: {
        code: runnerFailure?.code ?? initialFailure?.code ?? (ownedPreconditionBlocked
          ? "live_precondition_unavailable"
          : passed
            ? "scenario_completed"
            : "scenario_assertion_failed"),
        message: runnerFailure?.message ?? initialFailure?.message ?? (ownedPreconditionBlocked
          ? "The failed Claude turn did not expose a recoverable exact owned staged-input snapshot."
          : initialFailure
            ? initialFailure.message
            : passed
              ? "The live scenario completed and all safety and cleanup assertions passed."
              : reuseAfterCompletion && !sameAgentReuse
                ? "The initial result did not settle a same-agent correction/re-review turn."
                : "One or more live scenario, safety, or cleanup assertions failed."),
      },
    },
    execution_policy: PUBLIC_QUALIFICATION_POLICY,
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: scenario.id,
      owned_resources: ownedResources,
      resource_dispositions: ownedResources.map((resource) => ({
        ...resource,
        disposition: resourceDisposition(resource.kind, cleanupComplete),
      })),
      prohibited_mutations_observed: prohibitedMutationObservations(
        scenario.prohibited_mutations,
        {
          basis: [
            "prompt source SHA-256",
            "public turn and staged-input envelopes",
            "managed agent identity",
            "caller workspace fingerprint",
          ],
        },
      ),
      prompt_sources: [{ before: promptSourceBefore, after: promptSourceAfter }],
      caller_owned_workspace: {
        path: resolve(cwd),
        before: beforeWorkspace,
        after: afterWorkspace,
      },
      unresolved_obligations: cleanupComplete
        ? []
        : [
            {
              code: "owned_group_not_closed",
              group_id: group?.id ?? null,
              retained_state_root: stateHome,
            },
          ],
      completed_at: finishedAt,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (cleanupComplete) {
    await rm(scratch, { recursive: true, force: true });
  }
  const evidencePath = await writeEvidence(
    evidenceDirectory,
    scenario.id,
    startedAt,
    evidence,
    catalog.contracts.qualification_evidence.required_fields,
  );
  return { id: scenario.id, result: disposition, evidence: evidencePath };
}

async function invokeDrovr({
  command,
  args,
  expectedCommand,
  cwd,
  env,
  now,
  timeoutMs = 30_000,
  input,
  deadline,
  cleanup = false,
}) {
  const startedAt = now().toISOString();
  const effectiveTimeout = deadline
    ? cleanup
      ? deadline.cleanupCommandTimeout(timeoutMs)
      : deadline.commandTimeout(timeoutMs)
    : timeoutMs;
  const unavailable = cleanup && effectiveTimeout <= 0
    ? {
        outcome: "cleanup_deadline_exceeded",
        message: "The bounded cleanup interval was exhausted.",
      }
    : !cleanup && interruptionRequested
      ? {
          outcome: "operator_interrupted",
          message: "Qualification was interrupted by the operator.",
        }
      : !cleanup && (deadline?.expired() || effectiveTimeout <= 0)
        ? {
            outcome: "scenario_deadline_exceeded",
            message: "The catalog scenario elapsed-time limit was exhausted.",
          }
        : null;
  const execution = unavailable
    ? {
        exitCode: unavailable.outcome === "operator_interrupted" ? 130 : 124,
        envelope: invalidEnvelope(expectedCommand, unavailable.message, unavailable.outcome),
      }
    : await executeDrovr(command, args, {
        cwd,
        env,
        expectedCommand,
        timeout: effectiveTimeout,
        input,
        ignoreInterruption: cleanup,
      });
  const envelopeError = validateDrovrEnvelope(expectedCommand, execution.envelope);
  if (envelopeError) {
    execution.envelope = invalidEnvelope(
      expectedCommand,
      envelopeError,
    );
    execution.exitCode ||= 5;
  }
  const finishedAt = now().toISOString();
  return {
    execution,
    record: invocationRecord(["drovr", ...args], execution, startedAt, finishedAt),
  };
}

function createInvocationRecorder({ records, ...defaults }) {
  return async (args, expectedCommand, options = {}) => {
    const defaultTimeoutMs = ["task open", "agent start"].includes(
      expectedCommand,
    )
      ? SETUP_COMMAND_LIMIT_MS
      : requiredSuccessCommands.has(expectedCommand)
      ? OBSERVATION_COMMAND_LIMIT_MS
      : undefined;
    const result = await invokeDrovr({
      ...defaults,
      args,
      expectedCommand,
      ...(defaultTimeoutMs ? { timeoutMs: defaultTimeoutMs } : {}),
      ...options,
    });
    records.push(result.record);
    return result;
  };
}

function invocationRecord(argv, execution, startedAt, finishedAt) {
  return {
    argv,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: execution.exitCode,
    envelope: execution.envelope,
  };
}

export async function workspaceFingerprint(cwd) {
  const canonicalPath = await realpath(cwd);
  try {
    const [head, status] = await Promise.all([
      execFileAsync("git", ["-C", canonicalPath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }),
      execFileAsync(
        "git",
        ["-C", canonicalPath, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      ),
    ]);
    const paths = await collectWorkspacePaths(canonicalPath);
    return {
      path: canonicalPath,
      head: head.stdout.trim(),
      status: status.stdout,
      content_sha256: await contentFingerprint(canonicalPath, paths),
    };
  } catch {
    const paths = await collectWorkspacePaths(canonicalPath);
    return {
      path: canonicalPath,
      head: null,
      status: "not-a-git-workspace",
      content_sha256: await contentFingerprint(canonicalPath, paths),
    };
  }
}

async function collectWorkspacePaths(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!relative && entry.name === ".git") continue;
    const path = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) paths.push(...(await collectWorkspacePaths(root, path)));
    else paths.push(path);
  }
  return paths;
}

async function contentFingerprint(root, paths) {
  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    digest.update(`${metadata.mode.toString(8)}\0${path}\0`);
    digest.update(
      metadata.isSymbolicLink()
        ? Buffer.from(await readlink(absolute))
        : metadata.isFile()
          ? await readFile(absolute)
          : Buffer.from(`special-file:${metadata.mode.toString(8)}`),
    );
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (!match) throw new QualificationUsageError(`invalid scenario duration: ${value}`);
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000 }[match[2]];
}

async function writeEvidence(
  directory,
  scenarioId,
  startedAt,
  evidence,
  requiredFields = QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
) {
  const evidencePath = join(
    directory,
    `${scenarioId}-${startedAt.replaceAll(":", "-")}.json`,
  );
  validateQualificationEvidence(evidence, requiredFields);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  return evidencePath;
}

export function validateQualificationEvidence(
  evidence,
  required = QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
) {
  if (
    evidence?.schema !== "drovr.qualification-evidence/v1" ||
    required.some((field) => !Object.hasOwn(evidence, field))
  ) {
    throw new Error("qualification evidence does not satisfy its versioned contract");
  }
  if (
    evidence.trust_preflight?.schema !== QUALIFICATION_TRUST_SCHEMA ||
    !["not_applicable", "not_run", "trusted", "blocked"].includes(
      evidence.trust_preflight.status,
    ) ||
    evidence.trust_preflight.native_work_started !== false ||
    evidence.trust_preflight.configuration?.created !== false
  ) {
    throw new Error("qualification evidence has an invalid trust preflight record");
  }
  const trustPreflight = evidence.trust_preflight;
  if (trustPreflight.binding !== null) {
    let bindingValid = false;
    try {
      bindingValid =
        /^sha256:[0-9a-f]{64}$/u.test(trustPreflight.binding) &&
        trustPreflight.binding ===
          trustPreflightBinding(trustPreflight, Object.keys(trustPreflight.harnesses ?? {}));
    } catch {
      bindingValid = false;
    }
    if (!bindingValid) {
      throw new Error("qualification evidence has an invalid trust binding");
    }
  }
  if (
    trustPreflight.status === "trusted" &&
    !trustPreflightReady(
      trustPreflight,
      Object.keys(trustPreflight.harnesses ?? {}),
    )
  ) {
    throw new Error("qualification evidence has an unverified trusted preflight");
  }
  const liveFailureWithoutTrustedPreflightCodes = [
    "internal_error",
    "operator_interrupted",
    "scenario_deadline_exceeded",
    "process_timeout",
    "cleanup_deadline_exceeded",
  ];
  const liveEvidenceWithoutTrustedPreflight =
    evidence.execution_kind === "real_herdr_harness" &&
    trustPreflight.status !== "trusted";
  if (
    liveEvidenceWithoutTrustedPreflight &&
    evidence.result?.disposition === "pass"
  ) {
    throw new Error(
      "live qualification pass evidence requires a trusted preflight",
    );
  }
  if (
    liveEvidenceWithoutTrustedPreflight &&
    evidence.result?.disposition === "fail" &&
    !liveFailureWithoutTrustedPreflightCodes.includes(
      evidence.result?.reason?.code,
    )
  ) {
    throw new Error(
      "live qualification failure evidence has an invalid non-trusted reason",
    );
  }
  if (
    !evidence.execution_policy ||
    Object.entries(PUBLIC_QUALIFICATION_POLICY).some(
      ([key, expected]) => evidence.execution_policy[key] !== expected,
    )
  ) {
    throw new Error("qualification evidence does not satisfy its execution policy");
  }
  if (evidence.trace !== undefined) validateTrace(evidence.trace);
  if (
    !Array.isArray(evidence.invocations) ||
    evidence.invocations.some(
      (invocation) =>
        !Array.isArray(invocation.argv) ||
        invocation.argv[0] !== "drovr" ||
        validateDrovrEnvelope(
          commandFromArgv(invocation.argv),
          invocation.envelope,
        ) !== null,
    )
  ) {
    throw new Error("qualification invocation lacks a complete Drovr envelope");
  }
  const cleanupRequired = [
    "schema",
    "scenario_id",
    "owned_resources",
    "resource_dispositions",
    "prohibited_mutations_observed",
    "caller_owned_workspace",
    "unresolved_obligations",
    "completed_at",
  ];
  if (
    evidence.cleanup_receipt?.schema !==
      "drovr.qualification-cleanup-receipt/v1" ||
    cleanupRequired.some(
      (field) => !Object.hasOwn(evidence.cleanup_receipt, field),
    )
  ) {
    throw new Error("qualification cleanup receipt is incomplete");
  }
}

function commandFromArgv(argv) {
  return ["group", "task", "agent", "turn"].includes(argv[1])
    ? `${argv[1]} ${argv[2]}`
    : argv[1];
}

export function validateDrovrEnvelope(expectedCommand, envelope) {
  if (envelope?.schema !== "drovr.command/v1") return "unsupported result schema";
  if (envelope.command !== expectedCommand) {
    return `expected command ${expectedCommand}, received ${envelope.command}`;
  }
  if (typeof envelope.ok !== "boolean") return "result envelope lacks boolean ok";
  const hasResult = envelope.result !== null && typeof envelope.result === "object";
  const hasError = envelope.error !== null && typeof envelope.error === "object";
  if (envelope.ok && (!hasResult || hasError)) {
    return "successful result must contain result and must not contain error";
  }
  if (!envelope.ok) {
    const doctorBlock = expectedCommand === "doctor" && hasResult && !hasError;
    if (!doctorBlock && (!hasError || hasResult)) {
      return "unsuccessful result must contain exactly one error object";
    }
    if (hasError &&
      (typeof envelope.error.outcome !== "string" ||
        typeof envelope.error.message !== "string")) {
      return "error result lacks outcome or message";
    }
  }
  if (!hasResult) return null;
  const result = envelope.result;
  if (typeof result.status !== "string" || result.status.length === 0) {
    return "result lacks a non-empty status";
  }
  const requireArray = (field) =>
    Array.isArray(result[field]) ? null : `result.${field} must be an array`;
  const requireId = (field) =>
    typeof result[field]?.id === "string"
      ? null
      : `result.${field}.id must be a string`;
  if (expectedCommand === "doctor") {
    const error = requireArray("checks");
    if (error) return error;
    if (result.checks.some(
      (check) =>
        typeof check?.id !== "string" ||
        typeof check?.status !== "string" ||
        typeof check?.detail !== "string",
    )) return "doctor checks lack id, status, or detail";
    return null;
  }
  const listField = new Map([
    ["group list", "groups"],
    ["task list", "tasks"],
    ["agent list", "agents"],
    ["turn list", "turns"],
  ]).get(expectedCommand);
  if (listField) return requireArray(listField);
  if (["delegate", "ask", "turn start", "turn send", "turn wait", "turn cancel", "turn get"].includes(expectedCommand)) {
    return requireId("group") ?? requireId("task") ?? requireId("agent") ?? requireId("turn");
  }
  if (expectedCommand === "task open") {
    return requireId("group") ?? requireId("task");
  }
  if (expectedCommand === "agent start") {
    return requireId("task") ?? requireId("agent");
  }
  if (expectedCommand === "agent get") return requireId("agent");
  if (expectedCommand === "group close") return requireId("group");
  if (expectedCommand === "agent staged-input") return requireId("agent");
  if (expectedCommand === "attach") {
    return typeof result.agent_id === "string"
      ? null
      : "result.agent_id must be a string";
  }
  return null;
}

async function executeDrovr(command, args, options) {
  const {
    cwd,
    env,
    expectedCommand = args.slice(0, 2).join(" "),
    timeout = 30_000,
    input,
    ignoreInterruption = false,
  } = options;
  return new Promise((resolveExecution) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let failure;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeout);
    const hardTimer = setTimeout(
      () => finish(null, true),
      timeout + COMMAND_EXIT_GRACE_MS,
    );
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => finish(code, false));
    const finish = (code, hardBound) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTermination(child);
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (hardBound) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
      }
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      const interrupted = interruptionRequested && !ignoreInterruption && !timedOut;
      const message = interrupted
        ? "Qualification was interrupted by the operator"
        : timedOut || hardBound
        ? `Drovr exceeded the ${timeout}ms process bound`
        : (failure?.message ?? errorOutput.trim()) || "Drovr command failed";
      resolveExecution({
        exitCode: interrupted ? 130 : timedOut || hardBound ? 124 : (code ?? (failure ? 127 : 5)),
        envelope:
          interrupted
            ? invalidEnvelope(expectedCommand, message, "operator_interrupted")
            : timedOut || hardBound
              ? invalidEnvelope(expectedCommand, message, "process_timeout")
              : parseEnvelope(output, message, expectedCommand),
      });
    };
    child.stdin.end(input);
  });
}

function terminateChild(child) {
  const existing = terminatingChildren.get(child);
  if (existing) {
    clearTimeout(existing);
    terminatingChildren.delete(child);
    signalChild(child, "SIGKILL");
    return;
  }
  signalChild(child, "SIGTERM");
  const timer = setTimeout(() => {
    terminatingChildren.delete(child);
    signalChild(child, "SIGKILL");
  }, 2_000);
  terminatingChildren.set(child, timer);
}

function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function clearTermination(child) {
  const timer = terminatingChildren.get(child);
  if (timer) clearTimeout(timer);
  terminatingChildren.delete(child);
}

function boundedDelay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  if (interruptionRequested) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      interruptionWaiters.delete(finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    interruptionWaiters.add(finish);
  });
}

function parseEnvelope(
  stdout,
  failureMessage = "Drovr returned no result envelope",
  expectedCommand = "doctor",
) {
  try {
    const envelope = JSON.parse(stdout);
    if (envelope?.schema !== "drovr.command/v1") {
      throw new Error("unsupported schema");
    }
    return envelope;
  } catch (error) {
    return invalidEnvelope(expectedCommand, `${failureMessage}: ${error.message}`);
  }
}

function invalidEnvelope(command, message, outcome = "invalid_result_envelope") {
  return {
    schema: "drovr.command/v1",
    command,
    ok: false,
    error: { outcome, message },
  };
}

function versionsFromDoctor(envelope) {
  const checks = new Map(
    (envelope?.result?.checks ?? []).map((check) => [check.id, check.detail]),
  );
  return {
    drovr: checks.get("drovr") ?? "drovr.command/v1",
    herdr: checks.get("herdr") ?? "unavailable",
    integration: {
      codex: checks.get("codex-integration") ?? "unavailable",
      claude: checks.get("claude-integration") ?? "unavailable",
    },
    codex: checks.get("codex") ?? "unavailable",
    claude: checks.get("claude") ?? "unavailable",
    model: null,
    reasoning_effort: null,
  };
}

function liveCompatibility(versions, harness) {
  return {
    schema: COMPATIBILITY_SCHEMA,
    facts: {
      drovr: "drovr.semantic-harness/v1",
      herdr: versions.herdr ?? "unavailable",
      harness: versions[harness] ?? "unavailable",
      integration: integrationIdentity(versions.integration?.[harness], harness),
      adapters: [PRODUCTION_ADAPTER_ID, `${harness}-jsonl/v1`],
      features: [...COMPATIBILITY_FEATURES],
    },
  };
}

function scenarioHarness(scenario) {
  return scenario.id.startsWith("claude_") ? "claude" : "codex";
}

function integrationIdentity(value, harness) {
  if (typeof value !== "string") return "unavailable";
  if (value.startsWith(`herdr-${harness}/v`)) return value;
  const match = value.match(/\(v(\d+)\)/u);
  return match ? `herdr-${harness}/v${match[1]}` : value;
}

function qualificationLaunch(envelope, harness) {
  const configured = envelope?.result?.qualification?.[harness];
  if (
    typeof configured?.model === "string" &&
    typeof configured?.effort === "string"
  ) {
    return configured;
  }
  throw new Error(`doctor did not report ${harness} qualification configuration`);
}

function prerequisiteAssertions(envelope) {
  return (envelope?.result?.checks ?? []).map((check) => ({
    kind: "prerequisite",
    id: check.id,
    disposition: check.status === "fail" ? "fail" : "pass",
    detail: check.detail,
  }));
}

function unrelatedGroups(groups, ownedKey) {
  if (!Array.isArray(groups)) return null;
  return groups.filter((group) => group.key !== ownedKey);
}

export function compareUnrelatedGroups(beforeGroups, afterGroups, ownedKey) {
  if (!Array.isArray(beforeGroups) || !Array.isArray(afterGroups)) {
    return { proven: false, unchanged: false };
  }
  return {
    proven: true,
    unchanged:
      JSON.stringify(unrelatedGroups(beforeGroups, ownedKey)) ===
      JSON.stringify(unrelatedGroups(afterGroups, ownedKey)),
  };
}

export function nativeSessionValues(observations) {
  return observations
    .map(
      (observation) =>
        observation?.execution?.envelope?.result?.agent?.native_session,
    )
    .filter((value) => typeof value === "string" && value.length > 0);
}

function stateChangeSeqFromExecution(observation) {
  const result = observation?.execution?.envelope?.result;
  const candidates = [
    result?.state_change_seq,
    result?.agent?.state_change_seq,
    result?.agent?.observation?.state_change_seq,
    result?.staged_input?.state_change_seq,
  ];
  return candidates.find((value) => Number.isSafeInteger(value)) ?? null;
}

export function proveUnknownInputWasNotSubmitted({
  beforeTurns,
  afterTurns,
  reuseTurnId,
  unknownPayloadSha256,
}) {
  if (!Array.isArray(beforeTurns) || !Array.isArray(afterTurns)) return false;
  if (
    [...beforeTurns, ...afterTurns].some(
      (turn) =>
        typeof turn?.id !== "string" ||
        !Number.isInteger(turn?.input_count),
    )
  ) {
    return false;
  }
  if (
    typeof unknownPayloadSha256 === "string" &&
    afterTurns.some((turn) =>
      turn?.inputs?.some(
        (input) => input?.payload_sha256 === unknownPayloadSha256,
      ))
  ) {
    return false;
  }
  const afterById = new Map(afterTurns.map((turn) => [turn.id, turn]));
  if (
    beforeTurns.some((before) => {
      const after = afterById.get(before.id);
      return !after || after.input_count !== before.input_count;
    })
  ) {
    return false;
  }
  const beforeIds = new Set(beforeTurns.map(({ id }) => id));
  const created = afterTurns.filter(({ id }) => !beforeIds.has(id));
  if (!reuseTurnId) return created.length === 0;
  return (
    created.length === 1 &&
    created[0]?.id === reuseTurnId &&
    created[0]?.input_count === 1
  );
}

export function resourceDisposition(kind, cleanupComplete) {
  if (kind === "turn") return "retained";
  if (kind === "dedicated_qualification_workspace") return "retained";
  if (["group", "task", "agent"].includes(kind)) {
    return cleanupComplete ? "closed" : "cleanup-blocked";
  }
  return cleanupComplete ? "absent" : "retained";
}

export function prohibitedMutationObservations(
  descriptions,
  { fullyObserved = false, unchanged = false, proofs = [], basis = [] } = {},
) {
  return descriptions.map((description) => {
    const matchingProofs = proofs.filter(
      (proof) => proof.description === description,
    );
    const observedProofs = matchingProofs.filter(
      ({ unchanged }) => typeof unchanged === "boolean",
    );
    const observed = fullyObserved || observedProofs.length > 0;
    return {
      description,
      unchanged: observed
        ? observedProofs.length > 0
          ? observedProofs.every(({ unchanged: proofUnchanged }) => proofUnchanged)
          : Boolean(unchanged)
        : "not_observed",
      basis: [
        ...basis,
        ...matchingProofs.map(
          ({ operation, basis: proofBasis }) => `${operation}: ${proofBasis}`,
        ),
      ],
    };
  });
}

async function fileFingerprint(path) {
  const source = await readFile(path);
  return {
    path,
    size: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

async function safeWorkspaceFingerprint(cwd) {
  try {
    return await workspaceFingerprint(cwd);
  } catch {
    return {
      path: resolve(cwd),
      status: "not_observed",
      error: "The workspace fingerprint could not be observed safely.",
    };
  }
}

function scenarioPrerequisitesReady(scenario, envelope) {
  if (envelope?.schema !== "drovr.command/v1" || envelope.command !== "doctor") {
    return false;
  }
  const harnesses = new Set(
    scenario.execution.harnesses ??
      (scenario.id.startsWith("claude_") ? ["claude"] : ["codex"]),
  );
  const required = new Set(["drovr", "herdr"]);
  if (harnesses.has("claude")) {
    ["claude", "claude-transcripts", "claude-integration"].forEach((id) =>
      required.add(id),
    );
  }
  if (harnesses.has("codex")) {
    [
      "codex",
      "codex-launch-capabilities",
      "codex-transcripts",
      "codex-transcript-structure",
      "codex-integration",
      "codex-native-session",
    ].forEach((id) => required.add(id));
  }
  const checks = new Map(
    (envelope.result?.checks ?? []).map((check) => [check.id, check.status]),
  );
  const checksReady = [...required].every(
    (id) => checks.has(id) && (checks.get(id) === "pass" || checks.get(id) === "warn"),
  );
  const qualificationReady = [...harnesses].every((harness) => {
    const configured = envelope.result?.qualification?.[harness];
    return (
      typeof configured?.model === "string" &&
      configured.model.length > 0 &&
      typeof configured?.effort === "string" &&
      configured.effort.length > 0
    );
  });
  return checksReady && qualificationReady;
}

function aggregateStatus(results) {
  if (results.includes("fail")) return "fail";
  if (results.includes("blocked")) return "blocked";
  if (results.includes("skipped") && results.some((result) => result === "pass")) {
    return "incomplete";
  }
  if (results.every((result) => result === "skipped")) return "skipped";
  return "pass";
}

const requiredSuccessCommands = new Set([
  "group list",
  "task list",
  "agent list",
  "turn list",
  "turn get",
  "agent get",
  "group close",
  "task open",
  "agent start",
]);

function executionFailure(records) {
  const outcomes = new Map([
    ["operator_interrupted", "Qualification was interrupted by the operator."],
    ["scenario_deadline_exceeded", "The catalog scenario elapsed-time limit was exhausted."],
    ["process_timeout", "A public Drovr command exceeded its bounded process timeout."],
    ["cleanup_deadline_exceeded", "The bounded cleanup interval was exhausted."],
  ]);
  for (const record of records) {
    const outcome = record.envelope?.error?.outcome;
    if (outcomes.has(outcome)) {
      return { code: outcome, message: outcomes.get(outcome) };
    }
    if (
      requiredSuccessCommands.has(record.envelope?.command) &&
      record.envelope?.ok !== true
    ) {
      return {
        code: outcome ?? "drovr_command_failed",
        message:
          record.envelope?.error?.message ??
          `Drovr ${record.envelope?.command ?? "command"} did not return success.`,
      };
    }
  }
  return null;
}

function deadlineFailure(deadline) {
  return deadline.expired()
    ? {
        code: "scenario_deadline_exceeded",
        message: "The catalog scenario elapsed-time limit was exhausted.",
      }
    : null;
}

function cleanupDeadlineFailure(deadline) {
  return deadline.cleanupExpired()
    ? {
        code: "cleanup_deadline_exceeded",
        message: "The bounded cleanup interval was exhausted.",
      }
    : null;
}

function createDeadline(duration) {
  const limitMs = parseDuration(duration);
  const startedAt = Date.now();
  const expiresAt = startedAt + limitMs;
  let scenarioCompletedAt;
  let cleanupStartedAt;
  const boundedTimeout = (requestedMs, absoluteDeadline) =>
    Math.max(
      0,
      Math.min(
        requestedMs,
        absoluteDeadline - Date.now() - COMMAND_EXIT_GRACE_MS,
      ),
    );
  return {
    limitMs,
    expired: () =>
      (scenarioCompletedAt ?? Date.now()) - startedAt >= limitMs,
    commandTimeout: (requestedMs) => boundedTimeout(requestedMs, expiresAt),
    completeScenario: () => {
      scenarioCompletedAt ??= Date.now();
    },
    scenarioElapsedMs: () =>
      (scenarioCompletedAt ?? Date.now()) - startedAt,
    cleanupCommandTimeout: (requestedMs) => {
      cleanupStartedAt ??= Date.now();
      return boundedTimeout(
        requestedMs,
        cleanupStartedAt + CLEANUP_LIMIT_MS,
      );
    },
    cleanupMeasurement: () => ({
      max_elapsed_ms: CLEANUP_LIMIT_MS,
      measured_elapsed_ms: cleanupStartedAt ? Date.now() - cleanupStartedAt : 0,
    }),
    cleanupExpired: () =>
      cleanupStartedAt !== undefined &&
      Date.now() - cleanupStartedAt >= CLEANUP_LIMIT_MS,
  };
}

export class QualificationUsageError extends Error {}
