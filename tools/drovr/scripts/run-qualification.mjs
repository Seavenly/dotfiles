#!/usr/bin/env node

import { resolve } from "node:path";

import {
  interruptQualification,
  QualificationUsageError,
  runQualification,
} from "../src/qualification-runner.mjs";

function parseArguments(argv) {
  const scenarioIds = [];
  let evidenceDirectory;
  let fullLive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--scenario" && value) {
      scenarioIds.push(value);
      index += 1;
    } else if (argument === "--evidence-dir" && value) {
      evidenceDirectory = resolve(value);
      index += 1;
    } else if (argument === "--full-live") {
      fullLive = true;
    } else {
      throw new QualificationUsageError(`unsupported or incomplete option: ${argument}`);
    }
  }
  if (!evidenceDirectory) {
    throw new QualificationUsageError("--evidence-dir is required");
  }
  if (fullLive && scenarioIds.length) {
    throw new QualificationUsageError(
      "--full-live cannot be combined with --scenario",
    );
  }
  return {
    scenarioIds,
    fullLive,
    evidenceDirectory,
  };
}

let interruptionCount = 0;
const interrupt = () => {
  interruptionCount += 1;
  interruptQualification();
  if (interruptionCount > 1) process.exitCode = 130;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  const report = await runQualification(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = {
    pass: 0,
    skipped: 3,
    incomplete: 3,
    blocked: 3,
    fail: 4,
  }[report.status];
} catch (error) {
  const usage = error instanceof QualificationUsageError;
  process.stdout.write(
    `${JSON.stringify({
      schema: "drovr.qualification-run/v1",
      status: "error",
      error: {
        code: usage ? "invalid_arguments" : "internal_error",
        message: error.message,
      },
    })}\n`,
  );
  process.exitCode = usage ? 2 : 5;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
