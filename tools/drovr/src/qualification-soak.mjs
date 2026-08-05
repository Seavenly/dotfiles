import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { digestCanonical } from "./canonical-json.mjs";
import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "./qualification-catalog.mjs";
import {
  CYCLE_EVIDENCE_REQUIRED_FIELDS,
} from "./qualification-contracts.mjs";
import {
  CLEANUP_LIMIT_MS,
  interruptProcesses,
  runProcess,
} from "./qualification-process.mjs";
import { PUBLIC_QUALIFICATION_POLICY } from "./qualification-policy.mjs";
import {
  STATE_SEQUENCE_PHASES,
  stateSequenceAntiReplayGap,
} from "./qualification-state-sequence.mjs";

export const SOAK_SCHEMA = "drovr.qualification-soak-plan/v1";
export const SOAK_DECISION_SCHEMA = "drovr.qualification-soak-decision/v1";
export const SOAK_REPORT_SCHEMA = "drovr.qualification-soak-report/v1";

const HARNESS_NAMES = ["codex", "claude"];
const DEFAULT_PLAN_URL = new URL(
  "../qualification/soak.v1.json",
  import.meta.url,
);
const QUALIFICATION_RUNNER_URL = new URL(
  "../scripts/run-qualification.mjs",
  import.meta.url,
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFileCallback);
let soakInterruptionRequested = false;

export function interruptSoak() {
  soakInterruptionRequested = true;
  interruptProcesses();
}

export async function loadSoakPlan(url = DEFAULT_PLAN_URL) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function validateSoakPlan(plan) {
  requireCondition(plan?.schema === SOAK_SCHEMA, `schema must be ${SOAK_SCHEMA}`);
  requireCondition(plan.version === 1, "version must be 1");
  requireCondition(
    Number.isInteger(plan.catalog_version) && plan.catalog_version > 0,
    "catalog_version must be a positive integer",
  );

  for (const harness of HARNESS_NAMES) {
    const minimum = plan.minimum_consecutive_cycles?.[harness];
    requireCondition(
      Number.isInteger(minimum) && minimum > 0,
      `${harness} minimum_consecutive_cycles must be a positive integer`,
    );
    requireNonEmptyStrings(
      plan.cycle_scenarios?.[harness],
      `${harness}.cycle_scenarios`,
    );
  }

  requireNonEmptyStrings(plan.required_coverage, "required_coverage");
  requireNonEmptyStrings(
    plan.required_state_sequence_phases,
    "required_state_sequence_phases",
  );
  requireCondition(
    JSON.stringify(plan.required_state_sequence_phases) ===
      JSON.stringify(STATE_SEQUENCE_PHASES),
    "required_state_sequence_phases must match the state-sequence contract",
  );
  requireCondition(
    Array.isArray(plan.required_assertion_groups) &&
      plan.required_assertion_groups.length > 0,
    "required_assertion_groups must be non-empty",
  );
  for (const [index, group] of plan.required_assertion_groups.entries()) {
    requireNonEmptyStrings(group, `required_assertion_groups[${index}]`);
  }
  requireNonEmptyStrings(plan.required_binding_fields, "required_binding_fields");
  requireNonEmptyStrings(
    plan.supporting_scenarios ?? [],
    "supporting_scenarios",
    { allowEmpty: true },
  );
  if (plan.supporting_scenario_reasons !== undefined) {
    requireCondition(
      isRecord(plan.supporting_scenario_reasons),
      "supporting_scenario_reasons must be an object",
    );
    for (const [scenarioId, reason] of Object.entries(
      plan.supporting_scenario_reasons,
    )) {
      requireCondition(
        plan.supporting_scenarios.includes(scenarioId),
        `supporting_scenario_reasons references unplanned scenario ${scenarioId}`,
      );
      requireCondition(
        typeof reason === "string" && reason.trim().length > 0,
        `supporting_scenario_reasons.${scenarioId} must be a non-empty string`,
      );
    }
  }
  if (plan.scenario_coverage !== undefined) {
    requireCondition(
      isRecord(plan.scenario_coverage),
      "scenario_coverage must be an object",
    );
    for (const [scenarioId, coverage] of Object.entries(plan.scenario_coverage)) {
      requireNonEmptyStrings(coverage, `scenario_coverage.${scenarioId}`);
    }
  }
  return plan;
}

export function validateSoakPlanAgainstCatalog(plan, catalog) {
  validateSoakPlan(plan);
  validateQualificationCatalog(catalog);
  requireCondition(
    plan.catalog_version === catalog.version,
    `catalog_version ${plan.catalog_version} does not match catalog version ${catalog.version}`,
  );

  const scenarios = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const plannedScenarioIds = new Set([
    ...HARNESS_NAMES.flatMap((harness) => plan.cycle_scenarios[harness]),
    ...plan.supporting_scenarios,
  ]);
  for (const [harness, ids] of Object.entries(plan.cycle_scenarios)) {
    for (const scenarioId of ids) {
      const scenario = scenarios.get(scenarioId);
      requireCondition(scenario !== undefined, `${harness} references unknown scenario ${scenarioId}`);
      requireCondition(
        scenario.execution.kind === "real_herdr_harness",
        `${scenarioId} must use the real Herdr harness for a live soak`,
      );
      requireCondition(
        scenario.execution.harnesses.includes(harness),
        `${scenarioId} does not declare the ${harness} harness`,
      );
    }
  }
  for (const scenarioId of plan.supporting_scenarios) {
    const scenario = scenarios.get(scenarioId);
    requireCondition(scenario !== undefined, `supporting_scenarios references unknown scenario ${scenarioId}`);
    requireCondition(
      scenario.execution.kind === "real_herdr_harness",
      `${scenarioId} must use the real Herdr harness for a live soak`,
    );
    if (scenario.execution.harnesses.includes("claude")) {
      requireCondition(
        typeof plan.supporting_scenario_reasons?.[scenarioId] === "string" &&
          plan.supporting_scenario_reasons[scenarioId].trim().length > 0,
        `supporting_scenario_reasons.${scenarioId} is required for extra Claude coverage`,
      );
    }
  }
  for (const [scenarioId, coverage] of Object.entries(plan.scenario_coverage ?? {})) {
    requireCondition(
      plannedScenarioIds.has(scenarioId),
      `scenario_coverage references unplanned scenario ${scenarioId}`,
    );
    requireNonEmptyStrings(coverage, `scenario_coverage.${scenarioId}`);
  }
  const availableCoverage = new Set(
    Object.values(plan.scenario_coverage ?? {}).flat(),
  );
  for (const coverage of plan.required_coverage) {
    requireCondition(
      availableCoverage.has(coverage),
      `required_coverage is not provided by scenario_coverage: ${coverage}`,
    );
  }
  return {
    scenario_count: plannedScenarioIds.size,
    coverage: [...availableCoverage].sort(),
  };
}

export async function runSoak({
  plan: suppliedPlan,
  catalog: suppliedCatalog,
  evidenceDirectory,
  drovrCommand = join(REPOSITORY_ROOT, "bin", "drovr"),
  cwd = REPOSITORY_ROOT,
  env = process.env,
  now = () => new Date(),
  binding: suppliedBinding,
  sourceInspection,
  setupResult,
  verification: suppliedVerification,
  verificationRunner,
  cycleRunner,
} = {}) {
  soakInterruptionRequested = false;
  requireCondition(
    typeof evidenceDirectory === "string" && evidenceDirectory.length > 0,
    "evidenceDirectory is required",
  );
  const plan = suppliedPlan ?? await loadSoakPlan();
  const catalog = suppliedCatalog ?? await loadQualificationCatalog();
  validateSoakPlanAgainstCatalog(plan, catalog);
  const startedAt = now().toISOString();
  const catalogDigest = digestCanonical(catalog);
  const absoluteEvidenceDirectory = resolve(evidenceDirectory);
  await mkdir(absoluteEvidenceDirectory, { recursive: true, mode: 0o700 });

  const source = sourceInspection ?? (
    suppliedBinding
      ? {
          commit: suppliedBinding.drovr_commit,
          clean: suppliedBinding.source_clean,
        }
      : await inspectSource(REPOSITORY_ROOT)
  );
  const setup = setupResult ?? await collectSoakSetup({
    drovrCommand,
    cwd,
    env,
    now,
    catalog,
    source,
  });
  const binding = suppliedBinding ?? {
    ...(setup.binding ?? {}),
    drovr_commit: source.commit ?? null,
    source_clean: source.clean === true,
    catalog_version: catalog.version,
    catalog_digest: catalogDigest,
  };
  const verification = suppliedVerification ?? (
    soakInterruptionRequested
      ? {
          interrupted: {
            status: "fail",
            message: "The soak was interrupted before verification completed.",
          },
        }
      : verificationRunner
        ? await verificationRunner({ cwd, env, source, catalog })
        : await runVerificationSuites({
            cwd,
            env,
            evidenceDirectory: absoluteEvidenceDirectory,
            drovrCommand,
          })
  );
  const allVerification = {
    ...(setup.verification ?? {}),
    ...(verification ?? {}),
  };
  const definitions = buildCycleDefinitions(plan, catalog);
  const runCycle = cycleRunner ?? runQualificationCycle;
  const cycles = [];
  for (const definition of definitions) {
    if (soakInterruptionRequested) break;
    let execution;
    try {
      execution = await runCycle({
        ...definition,
        catalog,
        evidenceDirectory: absoluteEvidenceDirectory,
        drovrCommand,
        cwd,
        env,
        now,
      });
    } catch (error) {
      execution = {
        status: "error",
        failure: {
          code: "cycle_runner_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    let evidence = await readCycleEvidence(execution);
    const evidenceFailure = evidence
      ? validateCycleEvidence(evidence, definition, catalog, catalogDigest)
      : null;
    if (evidenceFailure) {
      execution.originalEvidencePath = execution.evidencePath ?? null;
      execution.evidencePath = null;
      execution.failure ??= {
        code: "cycle_evidence_invalid",
        message: evidenceFailure,
      };
      evidence = null;
    }
    if (!evidence) {
      execution.evidencePath = await preserveCycleFailure(
        definition,
        execution,
        absoluteEvidenceDirectory,
      );
    }
    const cycleBinding = evidence
      ? bindingFromCycleEvidence(evidence, binding, definition.harness)
      : binding;
    const summary = evidence
      ? summarizeQualificationEvidence(evidence, {
          harness: definition.harness,
          number: definition.number,
          binding: cycleBinding,
          coverage: definition.coverage,
          additionalCoverageReason: definition.additionalCoverageReason,
        })
      : failedCycleSummary(definition, cycleBinding, execution);
    summary.binding = cycleBinding;
    summary.evidence_path = execution?.evidencePath ?? summary.evidence_path;
    summary.execution = executionSummary(execution);
    cycles.push(summary);
  }

  const unattemptedCycles = soakInterruptionRequested
    ? definitions.slice(cycles.length).map((definition) => ({
        harness: definition.harness,
        number: definition.number,
        scenario_id: definition.scenarioId,
        status: "not_attempted",
      }))
    : [];
  if (soakInterruptionRequested) {
    allVerification.interrupted ??= {
      status: "fail",
      message: "The soak was interrupted before all qualification cycles completed.",
    };
  }

  const decision = evaluateSoak({
    plan,
    binding,
    cycles,
    verification: allVerification,
  });
  const finishedAt = now().toISOString();
  const report = {
    schema: SOAK_REPORT_SCHEMA,
    status: decision.decision,
    plan: {
      schema: plan.schema,
      version: plan.version,
      catalog_version: plan.catalog_version,
      digest: digestCanonical(plan),
    },
    catalog: {
      version: catalog.version,
      digest: catalogDigest,
    },
    binding,
    source,
    setup: {
      invocations: setup.invocations ?? [],
      doctor: setup.doctor ?? null,
      descriptions: setup.descriptions ?? {},
    },
    verification: allVerification,
    cycles,
    unattempted_cycles: unattemptedCycles,
    decision,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  const reportPath = join(
    absoluteEvidenceDirectory,
    `soak-${finishedAt.replaceAll(":", "-")}-${process.pid}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    ...report,
    report_path: reportPath,
  };
}

function buildCycleDefinitions(plan, catalog) {
  const scenarios = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const nextNumber = Object.fromEntries(HARNESS_NAMES.map((harness) => [harness, 1]));
  const definitions = [];
  for (const harness of HARNESS_NAMES) {
    const scenarioIds = plan.cycle_scenarios[harness];
    for (let index = 0; index < plan.minimum_consecutive_cycles[harness]; index += 1) {
      const scenarioId = scenarioIds[index % scenarioIds.length];
      definitions.push(
        cycleDefinition({
          harness,
          number: nextNumber[harness]++,
          scenarioId,
          plan,
          scenarios,
        }),
      );
    }
  }
  for (const scenarioId of plan.supporting_scenarios) {
    const scenario = scenarios.get(scenarioId);
    const harness = scenario.execution.harnesses[0];
    definitions.push(
      cycleDefinition({
        harness,
        number: nextNumber[harness]++,
        scenarioId,
        plan,
        scenarios,
        supporting: true,
      }),
    );
  }
  return definitions;
}

function cycleDefinition({
  harness,
  number,
  scenarioId,
  plan,
  scenarios,
  supporting = false,
}) {
  const scenario = scenarios.get(scenarioId);
  const coverage = plan.scenario_coverage?.[scenarioId] ?? [];
  return {
    harness,
    number,
    scenarioId,
    scenario,
    coverage: [...coverage],
    ...(supporting && harness === "claude"
      ? {
          additionalCoverageReason:
            plan.supporting_scenario_reasons?.[scenarioId] ??
            `Named supporting coverage: ${scenarioId} validates an additional Claude path.`,
        }
      : {}),
  };
}

async function collectSoakSetup({
  drovrCommand,
  cwd,
  env,
  now,
  catalog,
  source,
}) {
  const doctor = await runPublicJsonCommand(
    drovrCommand,
    ["doctor"],
    { cwd, env, now, timeoutMs: 15_000 },
  );
  const descriptions = {};
  const setupInvocations = [doctor.invocation];
  const verification = {
    doctor: {
      status: doctor.exitCode === 0 && doctor.envelope?.ok === true ? "pass" : "fail",
      exit_code: doctor.exitCode,
      message: doctor.envelope?.result?.status ?? doctor.error ?? "doctor did not report ready",
    },
  };
  for (const harness of HARNESS_NAMES) {
    const qualification = doctor.envelope?.result?.qualification?.[harness];
    const args = [
      "describe",
      "--harness",
      harness,
      "--role",
      "reviewer",
      "--capability",
      "read-only",
    ];
    if (typeof qualification?.model === "string") {
      args.push("--model", qualification.model);
    }
    if (typeof qualification?.effort === "string") {
      args.push("--effort", qualification.effort);
    }
    args.push(
      "--caller-metadata",
      JSON.stringify({
        run_id: "drovr-qualification-soak",
        purpose: "compatibility-binding",
        harness,
      }),
    );
    const description = await runPublicJsonCommand(
      drovrCommand,
      args,
      { cwd, env, now, timeoutMs: 15_000 },
    );
    descriptions[harness] = description.envelope;
    setupInvocations.push(description.invocation);
    const descriptionResult = description.envelope?.result;
    const expectedModel = qualification?.model;
    const expectedEffort = qualification?.effort;
    const descriptionMatchesQualification =
      (expectedModel === undefined || descriptionResult?.launch?.model === expectedModel) &&
      (expectedEffort === undefined || descriptionResult?.launch?.effort === expectedEffort) &&
      descriptionResult?.launch?.harness === harness &&
      typeof descriptionResult?.watermark?.content_sha256 === "string";
    verification[`${harness}_description`] = {
      status:
        description.exitCode === 0 &&
        description.envelope?.ok === true &&
        descriptionMatchesQualification
          ? "pass"
          : "fail",
      exit_code: description.exitCode,
      message: description.error ??
        (descriptionMatchesQualification
          ? "description resolved"
          : "description did not match the qualification launch"),
    };
  }
  const configurationWatermarks = configurationWatermarksFromDescriptions(descriptions);
  const configurationDigests = Object.values(configurationWatermarks);
  const configurationDigest = configurationDigestFromDescriptions(descriptions);
  verification.configuration_digest = {
    status: configurationDigest === null ? "fail" : "pass",
    values: configurationDigests,
    by_harness: configurationWatermarks,
    digest: configurationDigest,
  };
  return {
    binding: bindingFromDoctorAndDescriptions({
      doctor: doctor.envelope,
      descriptions,
      drovrCommit: source.commit,
      catalogVersion: catalog.version,
      catalogDigest: digestCanonical(catalog),
    }),
    doctor: doctor.envelope,
    descriptions,
    invocations: setupInvocations,
    verification,
  };
}

async function inspectSource(repositoryRoot) {
  try {
    const { stdout: commitOutput } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    const { stdout: statusOutput } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "status", "--porcelain"],
      { encoding: "utf8" },
    );
    return {
      commit: commitOutput.trim() || null,
      clean: statusOutput.trim().length === 0,
    };
  } catch (error) {
    return {
      commit: null,
      clean: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runVerificationSuites({ cwd, env, evidenceDirectory, drovrCommand }) {
  const suites = {
    deterministic: [
      "tools/drovr/test/qualification-replay.test.mjs",
      "tools/drovr/test/trace-fixtures.test.mjs",
    ],
    fault_matrix: [
      "tools/drovr/test/recovery.test.mjs",
      "tools/drovr/test/staged-input-receipt.test.mjs",
      "tools/drovr/test/staged-input-cli.test.mjs",
    ],
  };
  const results = {};
  for (const [name, files] of Object.entries(suites)) {
    const processResult = await runProcess(
      process.execPath,
      ["--test", ...files],
      { cwd, env, timeoutMs: 5 * 60_000 },
    );
    results[name] = verificationResult(processResult, ["--test", ...files]);
  }
  const liveEvidenceDirectory = join(evidenceDirectory, "live-conformance");
  await mkdir(liveEvidenceDirectory, { recursive: true, mode: 0o700 });
  const liveArgs = [
    fileURLToPath(QUALIFICATION_RUNNER_URL),
    "--full-live",
    "--evidence-dir",
    liveEvidenceDirectory,
    "--drovr-command",
    drovrCommand,
  ];
  const liveProcess = await runProcess(
    process.execPath,
    liveArgs,
    { cwd, env: { ...env, DOTFILES_ROOT: REPOSITORY_ROOT }, timeoutMs: 30 * 60_000 },
  );
  const liveReport = parseJsonOutput(liveProcess.stdout);
  results.live_conformance = verificationResult(
    liveProcess,
    liveArgs,
    liveReport,
  );
  return results;
}

async function runQualificationCycle({
  number,
  scenario,
  evidenceDirectory,
  drovrCommand,
  cwd,
  env,
}) {
  const cycleDirectory = join(
    evidenceDirectory,
    `cycle-${String(number).padStart(2, "0")}-${scenario.id}`,
  );
  await mkdir(cycleDirectory, { recursive: true, mode: 0o700 });
  const maxElapsed = durationMilliseconds(scenario.execution.limits.max_elapsed);
  const processResult = await runProcess(
    process.execPath,
    [
      fileURLToPath(QUALIFICATION_RUNNER_URL),
      "--scenario",
      scenario.id,
      "--evidence-dir",
      cycleDirectory,
      "--drovr-command",
      drovrCommand,
    ],
    {
      cwd,
      env: { ...env, DOTFILES_ROOT: REPOSITORY_ROOT },
      timeoutMs: maxElapsed + CLEANUP_LIMIT_MS,
    },
  );
  const report = parseJsonOutput(processResult.stdout);
  const scenarioResult = report?.scenarios?.find(
    ({ id }) => id === scenario.id,
  );
  const evidencePath = typeof scenarioResult?.evidence === "string"
    ? resolve(scenarioResult.evidence)
    : null;
  return {
    status:
      processResult.exitCode === 0 && report?.status === "pass"
        ? "pass"
        : report?.status ?? "fail",
    evidencePath,
    process: processResult,
    report,
    failure:
      processResult.exitCode === 0 && report?.status === "pass"
        ? null
        : {
            code: processResult.timedOut
              ? "qualification_runner_timeout"
              : "qualification_runner_nonpass",
            message: report?.status
              ? `qualification runner returned ${report.status}`
              : processResult.error ?? "qualification runner returned no report",
          },
  };
}

async function readCycleEvidence(execution) {
  if (execution?.evidence && typeof execution.evidence === "object") {
    return execution.evidence;
  }
  const path = execution?.evidencePath ?? execution?.evidence;
  if (typeof path !== "string") return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    execution.failure ??= {
      code: "cycle_evidence_unreadable",
      message: error instanceof Error ? error.message : String(error),
    };
    return null;
  }
}

function validateCycleEvidence(evidence, definition, catalog, catalogDigest) {
  const required = catalog.contracts.qualification_evidence.required_fields.filter(
    (field) => CYCLE_EVIDENCE_REQUIRED_FIELDS.includes(field),
  );
  if (
    !isRecord(evidence) ||
    required.some((field) => !Object.hasOwn(evidence, field))
  ) {
    return "Cycle evidence is missing one or more versioned evidence fields.";
  }
  if (evidence.schema !== "drovr.qualification-evidence/v1") {
    return "Cycle evidence has an unsupported schema.";
  }
  if (
    evidence.catalog_version !== catalog.version ||
    evidence.catalog_digest !== catalogDigest
  ) {
    return "Cycle evidence is bound to a different qualification catalog.";
  }
  if (evidence.scenario_id !== definition.scenarioId) {
    return "Cycle evidence scenario identity does not match the selected cycle.";
  }
  if (!isRecord(evidence.versions) || !isRecord(evidence.limits?.measured)) {
    return "Cycle evidence is missing version or measurement records.";
  }
  if (
    !Array.isArray(evidence.invocations) ||
    !Array.isArray(evidence.assertions) ||
    !isRecord(evidence.result)
  ) {
    return "Cycle evidence is missing ordered invocations, assertions, or result.";
  }
  const cleanup = evidence.cleanup_receipt;
  if (
    cleanup?.schema !== "drovr.qualification-cleanup-receipt/v1" ||
    cleanup.scenario_id !== definition.scenarioId ||
    !Array.isArray(cleanup.owned_resources) ||
    !Array.isArray(cleanup.resource_dispositions) ||
    !Array.isArray(cleanup.unresolved_obligations)
  ) {
    return "Cycle evidence is missing a complete cleanup receipt.";
  }
  const measurement = evidence.limits.measured;
  if (
    !Number.isSafeInteger(measurement.turns) ||
    !Number.isSafeInteger(measurement.retries) ||
    !Number.isSafeInteger(measurement.elapsed_ms)
  ) {
    return "Cycle evidence is missing bounded live measurements.";
  }
  return executionPolicyFailure(evidence.execution_policy);
}

async function preserveCycleFailure(definition, execution, evidenceDirectory) {
  const directory = join(
    evidenceDirectory,
    `cycle-${String(definition.number).padStart(2, "0")}-${definition.scenarioId}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "cycle-failure.json");
  await writeFile(
    path,
    `${JSON.stringify({
      schema: "drovr.qualification-cycle-failure/v1",
      harness: definition.harness,
      number: definition.number,
      scenario_id: definition.scenarioId,
      execution: executionSummary(execution),
      failure: execution?.failure ?? {
        code: "cycle_evidence_unavailable",
        message: "The cycle runner returned no qualification evidence.",
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}

function failedCycleSummary(definition, binding, execution) {
  return {
    harness: definition.harness,
    number: definition.number,
    scenario_id: definition.scenarioId,
    result: "fail",
    coverage: [...definition.coverage],
    binding,
    assertions: [],
    cleanup: {
      status: "blocked",
      unresolved_obligations: [
        {
          code: "cycle_evidence_unavailable",
          message: execution?.failure?.message ?? "No cycle evidence was returned.",
        },
      ],
    },
    manual_repair: null,
    turns: null,
    retries: null,
    elapsed_ms: execution?.process?.elapsedMs ?? null,
    versions: null,
    evidence_path: null,
    ...(definition.additionalCoverageReason !== undefined
      ? { additional_coverage_reason: definition.additionalCoverageReason }
      : {}),
    ...(definition.harness === "claude"
      ? { claude_reason: definition.scenario.execution.rationale }
      : {}),
  };
}

function executionSummary(execution) {
  const processResult = execution?.process;
  return {
    status: execution?.status ?? "error",
    exit_code: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    elapsed_ms: processResult?.elapsedMs ?? null,
    timed_out: processResult?.timedOut === true,
    stdout_digest: processResult?.stdout === undefined
      ? null
      : digestText(processResult.stdout),
    stderr_digest: processResult?.stderr === undefined
      ? null
      : digestText(processResult.stderr),
    ...(execution?.failure ? { failure: execution.failure } : {}),
    ...(execution?.originalEvidencePath
      ? { original_evidence_path: execution.originalEvidencePath }
      : {}),
  };
}

function bindingFromCycleEvidence(evidence, binding, harness) {
  const versions = evidence?.versions ?? {};
  const integration = (name) => normalizeIntegration(
    versions.integration?.[name],
    name,
  );
  return {
    ...binding,
    drovr_source: versions.drovr ?? null,
    herdr: versions.herdr ?? null,
    integrations: {
      claude: integration("claude"),
      codex: integration("codex"),
    },
    claude: versions.claude ?? null,
    codex: versions.codex ?? null,
    models: {
      ...binding.models,
      [harness]: versions.model ?? null,
    },
    reasoning_effort: {
      ...binding.reasoning_effort,
      [harness]: versions.reasoning_effort ?? null,
    },
    catalog_version: evidence.catalog_version ?? null,
    catalog_digest: evidence.catalog_digest ?? null,
  };
}

function normalizeIntegration(value, harness) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (new RegExp(`^herdr-${harness}/v\\d+$`, "u").test(normalized)) {
    return normalized;
  }
  const match = normalized.match(/\(v(\d+)\)/u);
  return match ? `herdr-${harness}/v${match[1]}` : null;
}

async function runPublicJsonCommand(command, args, { cwd, env, now, timeoutMs }) {
  const startedAt = now().toISOString();
  const processResult = await runProcess(command, args, {
    cwd,
    env: { ...env, DOTFILES_ROOT: REPOSITORY_ROOT },
    timeoutMs,
  });
  const envelope = parseJsonOutput(processResult.stdout);
  return {
    envelope,
    exitCode: processResult.exitCode,
    error: processResult.error,
    invocation: {
      argv: ["drovr", ...args],
      command: "public_drovr_cli",
      started_at: startedAt,
      exit_code: processResult.exitCode,
      signal: processResult.signal,
      timed_out: processResult.timedOut,
      stdout_digest: digestText(processResult.stdout),
      stderr_digest: digestText(processResult.stderr),
      finished_at: now().toISOString(),
    },
  };
}

function verificationResult(processResult, command, report) {
  return {
    status:
      processResult.exitCode === 0 &&
      !processResult.timedOut &&
      (report === undefined || report?.status === "pass")
        ? "pass"
        : "fail",
    command: [process.execPath, ...command],
    exit_code: processResult.exitCode,
    signal: processResult.signal,
    timed_out: processResult.timedOut,
    elapsed_ms: processResult.elapsedMs,
    stdout_digest: digestText(processResult.stdout),
    stderr_digest: digestText(processResult.stderr),
    ...(report
      ? {
          report: {
            schema: report.schema ?? null,
            status: report.status ?? null,
            scenarios: report.scenarios ?? [],
          },
        }
      : {}),
    ...(processResult.error ? { message: processResult.error } : {}),
  };
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split(/\r?\n/u).reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value ?? "").digest("hex")}`;
}

function durationMilliseconds(value) {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (!match) throw new Error(`invalid soak duration: ${value}`);
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000 }[match[2]];
}

export function evaluateSoak({ plan, binding, cycles = [], verification } = {}) {
  validateSoakPlan(plan);
  requireCondition(Array.isArray(cycles), "cycles must be an array");

  const failures = [];
  const residualLimitations = [];
  const observedCoverage = new Set();
  const consecutive = Object.fromEntries(
    HARNESS_NAMES.map((harness) => [
      harness,
      { required: plan.minimum_consecutive_cycles[harness], current: 0, longest: 0 },
    ]),
  );

  for (const [index, cycle] of cycles.entries()) {
    const cycleNumber = cycle?.number ?? index + 1;
    const harness = cycle?.harness;
    const state = harness && consecutive[harness];
    let valid = cycle?.result === "pass";
    const addFailure = (code, message) => {
      failures.push(failure(cycleNumber, code, message, harness));
    };

    if (cycle?.result !== "pass") {
      addFailure(
        "cycle_failed",
        "The cycle did not complete successfully and restarted its consecutive count.",
      );
    }

    if (!state) {
      addFailure("unsupported_harness", "Cycle harness is not codex or claude.");
      valid = false;
    }

    if (binding && !sameValue(cycle?.binding, binding)) {
      addFailure("binding_drift", "Cycle compatibility binding differs from the soak binding.");
      valid = false;
    }

    if (cycle?.manual_repair !== false) {
      addFailure("manual_repair_not_proven", "The cycle did not prove that no manual repair was used.");
      valid = false;
    }

    const policyFailure = executionPolicyFailure(cycle?.execution_policy);
    if (policyFailure) {
      addFailure("execution_policy_not_proven", policyFailure);
      valid = false;
    }

    const assertionFailure = requiredAssertionFailure(
      cycle,
      plan.required_assertion_groups,
    );
    if (assertionFailure) {
      addFailure("cycle_contract_failed", assertionFailure);
      valid = false;
    }

    const sequence = cycle?.state_sequence;
    const sequenceAntiReplayGap = stateSequenceAntiReplayGap(
      sequence,
      plan.required_state_sequence_phases,
    );
    const recordAntiReplayGap = () => {
      addFailure(
        "anti_replay_gap",
        "Herdr state_change_seq did not advance monotonically across the clear transition.",
      );
      residualLimitations.push({
        code: "anti_replay_gap",
        cycle: cycleNumber,
        message: "The live staged-input transition counter did not prove a fresh clear transition.",
      });
      valid = false;
    };

    if (
      !cycle?.coverage?.includes("staged_input_recovery") &&
      (sequenceAntiReplayGap === true || sequence?.anti_replay_gap === true)
    ) {
      recordAntiReplayGap();
    }

    if (cycle?.coverage?.includes("staged_input_recovery")) {
      const missingPhases = (plan.required_state_sequence_phases ?? []).filter(
        (phase) => !Number.isSafeInteger(sequence?.[phase]),
      );
      if (missingPhases.length > 0) {
        addFailure(
          "state_sequence_incomplete",
          `Staged-input evidence is missing state_change_seq phases: ${missingPhases.join(", ")}.`,
        );
        valid = false;
      } else if (sequenceAntiReplayGap !== false) {
        recordAntiReplayGap();
      }
    }

    const cleanupFailure = cleanupContractFailure(cycle?.cleanup);
    if (cleanupFailure) {
      addFailure("cleanup_not_settled", cleanupFailure);
      valid = false;
    }

    if (harness === "claude" && state && cycleNumber > state.required) {
      if (typeof cycle.additional_coverage_reason !== "string" ||
          cycle.additional_coverage_reason.trim().length === 0) {
        addFailure(
          "claude_extra_cycle_reason_missing",
          "Every Claude cycle beyond the minimum needs a named coverage reason.",
        );
        valid = false;
      }
    }

    if (
      harness === "claude" &&
      (typeof cycle.claude_reason !== "string" || cycle.claude_reason.trim().length === 0)
    ) {
      addFailure(
        "claude_reason_missing",
        "Every Claude cycle must record why its live turn was required.",
      );
      valid = false;
    }

    if (state) {
      state.current = valid ? state.current + 1 : 0;
      state.longest = Math.max(state.longest, state.current);
    }
    if (valid) {
      for (const coverage of cycle.coverage ?? []) observedCoverage.add(coverage);
    } else if (cycle?.result === "pass") {
      addFailure(
        "cycle_assertion_failed",
        "A passing cycle failed one or more soak safety contracts.",
      );
    }
    if (cycle?.residual_limitations) {
      residualLimitations.push(...cycle.residual_limitations);
    }
  }

  const missingCoverage = plan.required_coverage.filter(
    (coverage) => !observedCoverage.has(coverage),
  );
  if (missingCoverage.length > 0) {
    failures.push(failure(
      null,
      "coverage_missing",
      `Required soak coverage is missing: ${missingCoverage.join(", ")}.`,
    ));
  }

  for (const harness of HARNESS_NAMES) {
    const result = consecutive[harness];
    if (result.longest < result.required) {
      failures.push(failure(
        null,
        "consecutive_successes_short",
        `${harness} reached ${result.longest} consecutive successful cycles; ${result.required} are required.`,
      ));
    }
  }

  const bindingFailures = requiredBindingFailures(plan.required_binding_fields, binding);
  failures.push(...bindingFailures.map(({ code, message }) => failure(null, code, message)));
  if (binding?.source_clean === false) {
    residualLimitations.push({
      code: "source_dirty",
      message: "The soak source was not clean at the compatibility-binding check.",
    });
    failures.push(failure(
      null,
      "source_dirty",
      "The soak source contains uncommitted tracked changes, so no exact Drovr commit is qualified.",
    ));
  }
  if (verification && Object.values(verification).some(({ status }) => status !== "pass")) {
    for (const [suite, result] of Object.entries(verification)) {
      if (result.status !== "pass") {
        residualLimitations.push({
          code: "verification_failed",
          suite,
          status: result.status,
          message: result.message ?? "verification did not pass",
        });
      }
    }
    failures.push(failure(
      null,
      "verification_failed",
      "A required deterministic, live-conformance, or fault-matrix verification suite did not pass at the soak source.",
    ));
  }

  return {
    schema: SOAK_DECISION_SCHEMA,
    decision: failures.length === 0 ? "promote" : "unqualified",
    consecutive: Object.fromEntries(
      HARNESS_NAMES.map((harness) => [harness, { ...consecutive[harness] }]),
    ),
    coverage: {
      required: [...plan.required_coverage],
      observed: [...observedCoverage].sort(),
      missing: missingCoverage,
    },
    binding: binding ?? null,
    failures,
    residual_limitations: deduplicateResiduals(residualLimitations),
    follow_up_work: followUpWork(failures),
  };
}

export function summarizeQualificationEvidence(
  evidence,
  {
    harness,
    number,
    binding,
    coverage = [],
    additionalCoverageReason,
  } = {},
) {
  const assertions = Array.isArray(evidence?.assertions)
    ? evidence.assertions.map(({ id, disposition }) => ({ id, disposition }))
    : [];
  const cleanup = evidence?.cleanup_receipt;
  const resourceDispositions = Array.isArray(cleanup?.resource_dispositions)
    ? cleanup.resource_dispositions
    : null;
  const unresolvedObligations = Array.isArray(cleanup?.unresolved_obligations)
    ? cleanup.unresolved_obligations
    : null;
  const dispositionsSettled = resourceDispositions?.every(({ disposition }) =>
    ["retained", "closed", "absent"].includes(disposition),
  ) === true;
  const explicitRetainedHolder = (unresolvedObligations?.length ?? 0) > 0 &&
    unresolvedObligations.every(
      ({ retained_state_root }) =>
        typeof retained_state_root === "string" && retained_state_root.length > 0,
    );
  const cleanupStatus = !cleanup || !resourceDispositions || !unresolvedObligations
    ? "blocked"
    : unresolvedObligations.length === 0
      ? dispositionsSettled ? "complete" : "blocked"
      : dispositionsSettled && explicitRetainedHolder
      ? "retained"
      : "blocked";
  const cycle = {
    harness,
    number,
    scenario_id: evidence?.scenario_id ?? null,
    result: evidence?.result?.disposition ?? "fail",
    coverage: [...coverage],
    binding,
    assertions,
    cleanup: {
      status: cleanupStatus,
      unresolved_obligations: unresolvedObligations ?? [],
    },
    manual_repair: evidence?.execution_policy?.manual_repair ?? null,
    execution_policy: evidence?.execution_policy ?? null,
    turns: evidence?.limits?.measured?.turns ?? null,
    retries: evidence?.limits?.measured?.retries ?? null,
    elapsed_ms: evidence?.limits?.measured?.elapsed_ms ?? null,
    versions: evidence?.versions ?? null,
    evidence_path: evidence?.evidence_path ?? null,
  };
  if (additionalCoverageReason !== undefined) {
    cycle.additional_coverage_reason = additionalCoverageReason;
  }
  if (harness === "claude") {
    cycle.claude_reason = evidence?.live_run_justification ?? null;
  }
  if (evidence?.state_sequence) cycle.state_sequence = evidence.state_sequence;
  return cycle;
}

export function bindingFromDoctorAndDescriptions({
  doctor,
  descriptions = {},
  drovrCommit,
  catalogVersion,
  catalogDigest,
}) {
  const checks = new Map(
    (doctor?.result?.checks ?? []).map(({ id, detail }) => [id, detail]),
  );
  const integration = (harness) => {
    return normalizeIntegration(
      checks.get(`${harness}-integration`),
      harness,
    );
  };
  return {
    drovr_commit: drovrCommit ?? null,
    drovr_source: checks.get("drovr") ?? null,
    herdr: checks.get("herdr") ?? null,
    integrations: {
      claude: integration("claude"),
      codex: integration("codex"),
    },
    claude: checks.get("claude") ?? null,
    codex: checks.get("codex") ?? null,
    models: {
      claude: doctor?.result?.qualification?.claude?.model ?? null,
      codex: doctor?.result?.qualification?.codex?.model ?? null,
    },
    reasoning_effort: {
      claude: doctor?.result?.qualification?.claude?.effort ?? null,
      codex: doctor?.result?.qualification?.codex?.effort ?? null,
    },
    configuration_digest: configurationDigestFromDescriptions(descriptions),
    catalog_version: catalogVersion ?? null,
    catalog_digest: catalogDigest ?? null,
  };
}

export function configurationWatermarksFromDescriptions(descriptions = {}) {
  return Object.fromEntries(
    HARNESS_NAMES.map((harness) => [
      harness,
      descriptions[harness]?.result?.watermark?.content_sha256 ?? null,
    ]),
  );
}

export function configurationDigestFromDescriptions(descriptions = {}) {
  const watermarks = configurationWatermarksFromDescriptions(descriptions);
  return HARNESS_NAMES.every((harness) => typeof watermarks[harness] === "string")
    ? digestCanonical(watermarks)
    : null;
}

export function soakPlanPath() {
  return fileURLToPath(DEFAULT_PLAN_URL);
}

function requiredAssertionFailure(cycle, groups) {
  for (const group of groups) {
    const satisfied = group.some((id) =>
      cycle?.assertions?.some(
        (assertion) => assertion.id === id && assertion.disposition === "pass",
      ),
    );
    if (!satisfied) {
      return `Required assertion group is not proven: ${group.join(" or ")}.`;
    }
  }
  return null;
}

function cleanupContractFailure(cleanup) {
  if (!cleanup || !["complete", "retained"].includes(cleanup.status)) {
    return "Cycle cleanup did not produce a complete receipt or retained holder.";
  }
  const unresolved = cleanup.unresolved_obligations ?? [];
  if (unresolved.length > 0 && cleanup.status !== "retained") {
    return "Cycle cleanup has unresolved obligations without an explicit retained holder.";
  }
  return null;
}

function executionPolicyFailure(policy) {
  if (!policy || typeof policy !== "object") {
    return "The cycle did not record the public-command and no-repair execution policy.";
  }
  for (const [key, expected] of Object.entries(PUBLIC_QUALIFICATION_POLICY)) {
    if (policy[key] !== expected) {
      return `Execution policy ${key} must be ${JSON.stringify(expected)}.`;
    }
  }
  return null;
}

function requiredBindingFailures(fields, binding) {
  return fields
    .filter((field) => {
      const value = binding?.[field];
      if (field === "source_clean") return value !== true;
      if (field === "catalog_version") {
        return !Number.isSafeInteger(value) || value <= 0;
      }
      if (["herdr", "claude", "codex"].includes(field)) {
        return versionBindingMissing(value);
      }
      if (["integrations", "models", "reasoning_effort"].includes(field)) {
        return !isRecord(value) || HARNESS_NAMES.some(
          (harness) => bindingValueMissing(value[harness]),
        );
      }
      return bindingValueMissing(value);
    })
    .map((field) => ({
      code: "binding_incomplete",
      message: `Soak binding is missing ${field}.`,
    }));
}

function versionBindingMissing(value) {
  return typeof value !== "string" ||
    !/\b\d+\.\d+(?:\.\d+)?\b/u.test(value.trim());
}

function bindingValueMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized.length === 0 ||
      /^(?:unavailable|unknown|not(?:[-_ ]available|[-_ ]applicable))/u.test(normalized);
  }
  if (Array.isArray(value)) return value.length === 0 || value.some(bindingValueMissing);
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 || entries.some(([, entry]) => bindingValueMissing(entry));
  }
  return typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0;
}

function deduplicateResiduals(residuals) {
  const seen = new Set();
  return residuals.filter((residual) => {
    const key = digestCanonical(residual);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function followUpWork(failures) {
  const seen = new Set();
  return failures
    .filter(({ code }) => code !== "cycle_assertion_failed")
    .map(({ harness, cycle, code, message }) => ({
      harness,
      cycle,
      code,
      action: `Resolve ${code} and rerun the affected qualification coverage.`,
      evidence: message,
    }))
    .filter((item) => {
      const key = `${item.harness ?? "global"}:${item.cycle ?? "global"}:${item.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sameValue(left, right) {
  return digestCanonical(left) === digestCanonical(right);
}

function failure(cycle, code, message, harness = null) {
  return { harness, cycle, code, message };
}

function requireNonEmptyStrings(value, path, { allowEmpty = false } = {}) {
  requireCondition(Array.isArray(value), `${path} must be an array`);
  if (!allowEmpty) requireCondition(value.length > 0, `${path} must be non-empty`);
  for (const [index, entry] of value.entries()) {
    requireCondition(
      typeof entry === "string" && entry.trim().length > 0,
      `${path}[${index}] must be a non-empty string`,
    );
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`invalid soak plan: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
