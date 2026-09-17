#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  derivePinnedReleaseIdentity,
  generateHostRecoveryEvidence,
} from "../src/host-recovery-qualification.mjs";
import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";

const configDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(configDirectory, "../..");

try {
  const options = parseArgs(process.argv.slice(2));
  const rawRoot = resolveRequired(options, "raw-root");
  const outputPath = options.output === undefined
    ? resolve(configDirectory, "evidence/host-recovery-qualification.v1.json")
    : resolveRequired(options, "output");
  const receiptPaths = options.receipt === undefined
    ? readdirSync(rawRoot)
      .filter((name) => name.endsWith(".json"))
      .sort()
    : [].concat(options.receipt);
  if (receiptPaths.length === 0) throw new Error("no raw receipt files were found");
  const worktree = options.worktree === undefined ? repositoryRoot : resolveRequired(options, "worktree");
  const expectedRelease = derivePinnedReleaseIdentity({ worktreeRoot: worktree });
  if (options.release !== undefined &&
      canonicalDigest(JSON.parse(options.release)) !== canonicalDigest(expectedRelease)) {
    throw new Error("--release does not match the pinned worktree release identity");
  }
  const evidence = generateHostRecoveryEvidence({
    worktreeRoot: worktree,
    rawRoot,
    receiptPaths,
    outputPath,
    expectedRelease,
    allowExternalOutput: options.allowExternalOutput === true,
  });
  process.stdout.write(`${JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    output: outputPath,
    evidence_digest: evidence.evidence_digest,
    scenario_count: evidence.scenarios.length,
    source_receipt_count: evidence.source_receipts.length,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-external-output") {
      options.allowExternalOutput = true;
      continue;
    }
    if (!["--raw-root", "--output", "--worktree", "--receipt", "--release"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    index += 1;
    const key = argument.slice(2).replaceAll("-", "");
    if (argument === "--receipt") {
      options.receipt = options.receipt === undefined
        ? [value]
        : [...options.receipt, value];
    } else if (argument === "--raw-root") {
      options["raw-root"] = value;
    } else if (argument === "--output") {
      options.output = value;
    } else if (argument === "--worktree") {
      options.worktree = value;
    } else if (argument === "--release") {
      options.release = value;
    } else {
      options[key] = value;
    }
  }
  return options;
}

function resolveRequired(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
