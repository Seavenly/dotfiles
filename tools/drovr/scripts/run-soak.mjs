#!/usr/bin/env node

import { resolve } from "node:path";

import { runSoak } from "../src/qualification-soak.mjs";

class SoakUsageError extends Error {}

function parseArguments(argv) {
  let evidenceDirectory;
  let drovrCommand;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--evidence-dir" && value) {
      evidenceDirectory = resolve(value);
      index += 1;
    } else if (argument === "--drovr-command" && value) {
      drovrCommand = value;
      index += 1;
    } else {
      throw new SoakUsageError(`unsupported or incomplete option: ${argument}`);
    }
  }
  if (!evidenceDirectory) {
    throw new SoakUsageError("--evidence-dir is required");
  }
  return { evidenceDirectory, ...(drovrCommand ? { drovrCommand } : {}) };
}

try {
  const report = await runSoak(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === "promote" ? 0 : 4;
} catch (error) {
  const usage = error instanceof SoakUsageError;
  process.stdout.write(
    `${JSON.stringify({
      schema: "drovr.qualification-soak-report/v1",
      status: "error",
      error: {
        code: usage ? "invalid_arguments" : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = usage ? 2 : 5;
}
