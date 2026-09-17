#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  runProductionSeedChild,
  runTuicrLiveIntegration,
} from "../src/host-recovery-tuicr-live-integration.mjs";

const args = parseArgs(process.argv.slice(2));

try {
  let result;
  if (args.producer) {
    result = await runProductionSeedChild({
      inputPath: args.input,
      outputPath: args.output,
    });
  } else {
    const input = JSON.parse(await readFile(args.input, "utf8"));
    result = await runTuicrLiveIntegration(input);
    if (args.output !== undefined) {
      await writeFile(args.output, `${JSON.stringify(result)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schema: "flow.host-recovery-tuicr-live-probe-error/v1",
    code: error?.code ?? "probe_failed",
    message: error?.message ?? String(error),
  })}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const result = { producer: false, input: undefined, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--producer") {
      result.producer = true;
      continue;
    }
    if (arg === "--input" || arg === "--output") {
      const value = argv[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error(`${arg} requires an absolute path`);
      }
      result[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === "--help") {
      process.stdout.write("usage: run-host-recovery-tuicr-live-probe.mjs --producer --input ABS --output ABS\n");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (result.input === undefined || (result.producer && result.output === undefined)) {
    throw new Error(result.producer
      ? "--input and --output are required for a producer"
      : "--input is required");
  }
  return result;
}
