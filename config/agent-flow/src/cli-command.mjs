import { isAbsolute } from "node:path";

import { executeCommandGate } from "./command-gate.mjs";
import { doctorProfiles } from "./doctor.mjs";
import { executeHandoffValidationGate } from "./handoff-gate.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { loadSealedGate } from "./run-bundle-validator.mjs";
import { executeReviewFinalizeGate } from "./review-finalize-gate.mjs";

export async function runCli(
  args,
  {
    adapter = null,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runDoctor = doctorProfiles,
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
  stderr.write(`Unknown command: ${args[0]}\n`);
  usage(stderr);
  return 2;
}

function usage(stream) {
  stream.write(
    "Usage:\n" +
      "  agent-flow doctor profiles [--json]\n" +
      "  agent-flow gate --spec <absolute-gate.json>\n",
  );
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
