#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  derivePinnedReleaseIdentity,
  generateHostRecoveryEvidence,
  validateTrackedHostRecoverySuccessor,
} from "../src/host-recovery-qualification.mjs";
import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";

const configDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(configDirectory, "../..");
const trackedEvidencePath = resolve(
  configDirectory,
  "evidence/host-recovery-qualification.v1.json",
);
const transitionLedgerPath = resolve(configDirectory, "transition-ledger.v1.json");

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
  const replaceTrackedSuccessor = options.replaceTrackedSuccessor === true;
  if (replaceTrackedSuccessor && resolve(outputPath) !== trackedEvidencePath) {
    throw new Error("--replace-tracked-successor requires the tracked issue-46 output");
  }
  const evidence = replaceTrackedSuccessor
    ? generateTrackedSuccessor({
      worktree,
      rawRoot,
      receiptPaths,
      expectedRelease,
    })
    : generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths,
      outputPath,
      expectedRelease,
      allowExternalOutput: options.allowExternalOutput === true,
    });
  if (!replaceTrackedSuccessor && resolve(outputPath) === trackedEvidencePath) {
    bindTransitionLedgerEvidence(evidence, readFileSync(outputPath));
  }
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

function generateTrackedSuccessor({ worktree, rawRoot, receiptPaths, expectedRelease }) {
  const predecessor = validateTrackedHostRecoverySuccessor({ worktreeRoot: worktree });
  const temporaryOutputPath = `${trackedEvidencePath}.${randomUUID()}.tmp`;
  let temporaryLedgerPath;
  try {
    const evidence = generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      rawRoot,
      receiptPaths,
      outputPath: temporaryOutputPath,
      expectedRelease,
    });
    const currentPredecessor = validateTrackedHostRecoverySuccessor({ worktreeRoot: worktree });
    if (!currentPredecessor.aggregateBytes.equals(predecessor.aggregateBytes)) {
      throw new Error("tracked issue-46 predecessor changed during successor generation");
    }
    const bytes = readFileSync(temporaryOutputPath);
    const ledger = bindLedgerObject(currentPredecessor.ledger, evidence, bytes);
    temporaryLedgerPath = `${transitionLedgerPath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryOutputPath, trackedEvidencePath);
    renameSync(temporaryLedgerPath, transitionLedgerPath);
    return evidence;
  } finally {
    if (existsSync(temporaryOutputPath)) unlinkSync(temporaryOutputPath);
    if (temporaryLedgerPath !== undefined && existsSync(temporaryLedgerPath)) {
      unlinkSync(temporaryLedgerPath);
    }
  }
}

function bindTransitionLedgerEvidence(evidence, bytes) {
  const ledger = JSON.parse(readFileSync(transitionLedgerPath, "utf8"));
  if (ledger?.schema !== "flow.transition-ledger/v1" || !Array.isArray(ledger.evidence)) {
    throw new Error("transition ledger cannot bind issue-46 aggregate evidence");
  }
  const bound = bindLedgerObject(ledger, evidence, bytes);
  const temporaryPath = `${transitionLedgerPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(bound, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, transitionLedgerPath);
}

function bindLedgerObject(ledger, evidence, bytes) {
  let record = ledger.evidence.find(({ id }) => id === "issue_46_host_recovery");
  if (record === undefined) {
    record = {
      id: "issue_46_host_recovery",
      path: null,
      sha256: null,
      evidence_digest: null,
      status: "not_run",
      recorded_at: ledger.recorded_at,
    };
    ledger.evidence.push(record);
  }
  record.path = "evidence/host-recovery-qualification.v1.json";
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  record.evidence_digest = evidence.evidence_digest;
  record.status = evidence.status;
  record.recorded_at = ledger.recorded_at;
  return ledger;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-external-output") {
      options.allowExternalOutput = true;
      continue;
    }
    if (argument === "--replace-tracked-successor") {
      options.replaceTrackedSuccessor = true;
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
