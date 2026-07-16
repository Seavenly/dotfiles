import { isAbsolute } from "node:path";

import { executeCommandGate } from "./command-gate.mjs";
import { doctorProfiles } from "./doctor.mjs";
import { executeHandoffValidationGate } from "./handoff-gate.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { loadSealedGate } from "./run-bundle-validator.mjs";
import {
  inspectReviewRepository,
  launchReview,
} from "./review-launch.mjs";
import { executeReviewFinalizeGate } from "./review-finalize-gate.mjs";
import {
  recordReviewComments,
  transitionReview,
} from "./review-manifest.mjs";
import {
  cancelRun,
  projectRunStatus,
  renderCancellation,
  renderRunStatus,
} from "./run-lifecycle.mjs";

export async function runCli(
  args,
  {
    adapter = null,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runDoctor = doctorProfiles,
    inspectRepository = inspectReviewRepository,
    implementationRevision = null,
    now = () => new Date(),
    readReviewComments = undefined,
  } = {},
) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage(stdout);
    return 0;
  }
  if (args[0] === "doctor" && args[1] === "profiles") {
    return runDoctorProfiles(args.slice(2), { runDoctor, stdout, stderr });
  }
  if (args[0] === "gate") {
    return runGate(args.slice(1), { adapter, env, stdout, stderr });
  }
  if (args[0] === "launch" && args[1] === "review") {
    return runLaunchReview(args.slice(2), {
      adapter,
      env,
      implementationRevision,
      inspectRepository,
      now,
      runDoctor,
      stderr,
      stdout,
    });
  }
  if (args[0] === "status") {
    return runStatus(args.slice(1), { adapter, env, now, stderr, stdout });
  }
  if (args[0] === "cancel") {
    return runCancel(args.slice(1), { adapter, env, now, stderr, stdout });
  }
  if (args[0] === "review" && args[1] === "transition") {
    return runReviewTransition(args.slice(2), {
      now,
      readReviewComments,
      stderr,
      stdout,
    });
  }
  if (args[0] === "review" && args[1] === "record-comments") {
    return runReviewRecordComments(args.slice(2), {
      now,
      readReviewComments,
      stderr,
      stdout,
    });
  }
  stderr.write(`Unknown command: ${args[0]}\n`);
  usage(stderr);
  return 2;
}

function usage(stream) {
  stream.write(
    "Usage:\n" +
      "  agent-flow doctor profiles [--json]\n" +
      "  agent-flow launch review --manifest <absolute-review.json>\n" +
      "  agent-flow status --run <run-id> [--json]\n" +
      "  agent-flow cancel --run <run-id> --reason <text>\n" +
      "  agent-flow review transition --manifest <review.json> --to <state> --expected-generation <n> --actor <actor> --reason <text> --evidence <path> [--session-slug <slug>] [--head-sha <sha>] [--integration-receipt <path>]\n" +
      "  agent-flow review record-comments --manifest <review.json> --comments <comments.json> --expected-generation <n> --actor <actor> --reason <text> --evidence <path>\n" +
      "  agent-flow gate --spec <absolute-gate.json>\n",
  );
}

async function runReviewTransition(
  options,
  { now, readReviewComments, stderr, stdout },
) {
  const usage = "Usage: agent-flow review transition --manifest <review.json> --to <state> --expected-generation <n> --actor <actor> --reason <text> --evidence <path> [--session-slug <slug>] [--head-sha <sha>] [--integration-receipt <path>]\n";
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set([
      "--manifest",
      "--to",
      "--expected-generation",
      "--actor",
      "--reason",
      "--evidence",
      "--session-slug",
      "--head-sha",
      "--integration-receipt",
    ]));
  } catch {
    stderr.write(usage);
    return 2;
  }
  const required = ["--manifest", "--to", "--expected-generation", "--actor", "--reason", "--evidence"];
  if (required.some((name) => !parsed.has(name))) {
    stderr.write(usage);
    return 2;
  }
  try {
    const result = await transitionReview({
      actor: parsed.get("--actor"),
      evidencePath: parsed.get("--evidence"),
      expectedGeneration: parseGeneration(parsed.get("--expected-generation")),
      headSha: parsed.get("--head-sha") ?? null,
      integrationReceiptPath: parsed.get("--integration-receipt") ?? null,
      manifestPath: parsed.get("--manifest"),
      now,
      readComments: readReviewComments,
      reason: parsed.get("--reason"),
      sessionSlug: parsed.get("--session-slug") ?? null,
      to: parsed.get("--to"),
    });
    stdout.write(
      `${result.changed ? "ok" : "ok - unchanged"} - review ${result.manifest.run_id} ${result.manifest.review.status} generation ${result.manifest.review.generation}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow review transition: ${error.message}\n`);
    return 1;
  }
}

async function runReviewRecordComments(
  options,
  { now, readReviewComments, stderr, stdout },
) {
  const usage = "Usage: agent-flow review record-comments --manifest <review.json> --comments <comments.json> --expected-generation <n> --actor <actor> --reason <text> --evidence <path>\n";
  let parsed;
  try {
    parsed = parseNamedOptions(options, new Set([
      "--manifest",
      "--comments",
      "--expected-generation",
      "--actor",
      "--reason",
      "--evidence",
    ]));
  } catch {
    stderr.write(usage);
    return 2;
  }
  const required = ["--manifest", "--comments", "--expected-generation", "--actor", "--reason", "--evidence"];
  if (required.some((name) => !parsed.has(name))) {
    stderr.write(usage);
    return 2;
  }
  try {
    const result = await recordReviewComments({
      actor: parsed.get("--actor"),
      commentsPath: parsed.get("--comments"),
      evidencePath: parsed.get("--evidence"),
      expectedGeneration: parseGeneration(parsed.get("--expected-generation")),
      manifestPath: parsed.get("--manifest"),
      now,
      readComments: readReviewComments,
      reason: parsed.get("--reason"),
    });
    stdout.write(
      `${result.changed ? "ok" : "ok - unchanged"} - review ${result.manifest.run_id} comments generation ${result.manifest.review.generation}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow review record-comments: ${error.message}\n`);
    return 1;
  }
}

function parseNamedOptions(options, allowed) {
  if (options.length === 0 || options.length % 2 !== 0) throw new Error("invalid options");
  const parsed = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.has(name) || parsed.has(name) || value === undefined || value.length === 0) {
      throw new Error("invalid options");
    }
    parsed.set(name, value);
  }
  return parsed;
}

function parseGeneration(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("expected generation must be a non-negative integer");
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("expected generation exceeds the safe integer range");
  }
  return generation;
}

async function runCancel(options, { adapter, env, now, stderr, stdout }) {
  if (
    options.length !== 4 ||
    options[0] !== "--run" ||
    options[2] !== "--reason" ||
    options[3].trim().length === 0
  ) {
    stderr.write("Usage: agent-flow cancel --run <run-id> --reason <text>\n");
    return 2;
  }
  try {
    const result = await cancelRun({
      adapter,
      env,
      now,
      reason: options[3].trim(),
      runId: options[1],
    });
    const output = renderCancellation(result);
    (result.converged ? stdout : stderr).write(output);
    return result.converged ? 0 : 1;
  } catch (error) {
    stderr.write(`agent-flow cancel: ${error.message}\n`);
    return 1;
  }
}

async function runStatus(options, { adapter, env, now, stderr, stdout }) {
  const json = options.includes("--json");
  const positional = options.filter((option) => option !== "--json");
  if (
    positional.length !== 2 ||
    positional[0] !== "--run" ||
    options.length !== (json ? 3 : 2)
  ) {
    stderr.write("Usage: agent-flow status --run <run-id> [--json]\n");
    return 2;
  }
  try {
    const report = await projectRunStatus({
      adapter,
      env,
      now,
      runId: positional[1],
    });
    stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderRunStatus(report));
    return report.state === "broken" || report.state === "cancelling" ? 1 : 0;
  } catch (error) {
    stderr.write(`agent-flow status: ${error.message}\n`);
    return 1;
  }
}

async function runLaunchReview(
  options,
  {
    adapter,
    env,
    implementationRevision,
    inspectRepository,
    now,
    runDoctor,
    stderr,
    stdout,
  },
) {
  if (options.length !== 2 || options[0] !== "--manifest") {
    stderr.write(
      "Usage: agent-flow launch review --manifest <absolute-review.json>\n",
    );
    return 2;
  }
  if (!isAbsolute(options[1])) {
    stderr.write("launch review --manifest path must be absolute\n");
    return 2;
  }
  try {
    const result = await launchReview({
      adapter,
      env,
      implementationRevision,
      inspectRepository,
      manifestPath: options[1],
      now,
      runDoctor,
    });
    stdout.write(
      `ok - review launch ${result.runId} materialized ${result.cardCount} cards\n` +
        `run: ${result.runManifestPath}\n` +
        `root: ${result.rootTaskId}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`agent-flow launch review: ${error.message}\n`);
    return 1;
  }
}

async function runDoctorProfiles(options, { runDoctor, stdout, stderr }) {
  if (options.some((option) => option !== "--json")) {
    stderr.write(
      `Unknown option: ${options.find((option) => option !== "--json")}\n`,
    );
    usage(stderr);
    return 2;
  }
  const report = await runDoctor();
  if (options.includes("--json")) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      stdout.write(`${check.ok ? "ok" : "not ok"} - ${check.summary}\n`);
      for (const detail of check.details) stdout.write(`  - ${detail}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

async function runGate(options, { adapter, env, stdout, stderr }) {
  if (options.length !== 2 || options[0] !== "--spec") {
    stderr.write("Usage: agent-flow gate --spec <absolute-gate.json>\n");
    return 2;
  }
  if (!isAbsolute(options[1])) {
    stderr.write("gate --spec path must be absolute\n");
    return 2;
  }
  const taskId = env.HERMES_KANBAN_TASK?.trim();
  if (!taskId) {
    stderr.write("agent-flow gate requires HERMES_KANBAN_TASK\n");
    return 2;
  }
  try {
    const resolvedAdapter = adapter ?? new HermesAdapter({
      board: env.HERMES_KANBAN_BOARD?.trim() || null,
    });
    const sealedGate = await loadSealedGate({
      adapter: resolvedAdapter,
      taskId,
      requestedGateSpecPath: options[1],
    });
    if (!sealedGate.valid) {
      throw new Error(
        sealedGate.errors[0]?.message ?? "gate authority is invalid",
      );
    }
    const result = await executeSealedGate({
      adapter: resolvedAdapter,
      inheritedEnv: env,
      sealedGate,
    });
    const label = sealedGate.gate.kind;
    if (result.passed) {
      stdout.write(`ok - ${label} gate passed\n`);
      return 0;
    }
    stderr.write(`not ok - ${label} gate failed\n`);
    return 1;
  } catch (error) {
    stderr.write(`agent-flow gate: ${error.message}\n`);
    return 1;
  }
}

async function executeSealedGate({ adapter, inheritedEnv, sealedGate }) {
  switch (sealedGate.gate.kind) {
    case "command":
      return executeCommandGate({ sealedGate, inheritedEnv });
    case "handoff-validation":
      return executeHandoffValidationGate({ adapter, sealedGate });
    case "review-finalize":
      return executeReviewFinalizeGate({ adapter, sealedGate });
    default:
      throw new Error(`unsupported gate kind: ${sealedGate.gate.kind}`);
  }
}
