#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertExternalQualificationRoot,
  derivePinnedReleaseIdentity,
  resolveQualificationConfigDirectory,
  validateTrackedHostRecoveryInitialBinding,
  generateHostRecoveryEvidence,
  validateTrackedHostRecoverySuccessor,
} from "../src/host-recovery-qualification.mjs";
import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";

const defaultConfigDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(defaultConfigDirectory, "../..");

try {
  const options = parseArgs(process.argv.slice(2));
  const worktree = options.worktree === undefined ? repositoryRoot : resolveRequired(options, "worktree");
  const configDirectory = resolveQualificationConfigDirectory({ worktreeRoot: worktree, configDirectory: options["config-directory"] });
  const trackedEvidencePath = resolve(configDirectory, "evidence/host-recovery-qualification.v1.json");
  const transitionLedgerPath = resolve(configDirectory, "transition-ledger.v1.json");
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
  const expectedRelease = derivePinnedReleaseIdentity({ worktreeRoot: worktree, configDirectory });
  if (options.release !== undefined &&
      canonicalDigest(JSON.parse(options.release)) !== canonicalDigest(expectedRelease)) {
    throw new Error("--release does not match the pinned worktree release identity");
  }
  const replaceTrackedSuccessor = options.replaceTrackedSuccessor === true;
  const initializeSelectedRelease = options.initializeSelectedRelease === true;
  if (replaceTrackedSuccessor && initializeSelectedRelease) throw new Error("first binding and successor replacement are mutually exclusive");
  if (options["preserve-historical-directory"] !== undefined && !initializeSelectedRelease) throw new Error("--preserve-historical-directory requires --initialize-selected-release");
  if (initializeSelectedRelease && options["config-directory"] === undefined) throw new Error("first binding requires --config-directory");
  if (initializeSelectedRelease && options.allowExternalOutput === true) throw new Error("first binding requires tracked output");
  if ((replaceTrackedSuccessor || initializeSelectedRelease) && resolve(outputPath) !== trackedEvidencePath) {
    throw new Error("tracked promotion requires the selected issue-46 output");
  }
  if (configDirectory !== resolve(worktree, "config/flow") &&
      resolve(outputPath) === trackedEvidencePath &&
      !replaceTrackedSuccessor && !initializeSelectedRelease) {
    throw new Error("selected tracked output requires --initialize-selected-release or --replace-tracked-successor");
  }
  let historicalReceipt;
  const evidence = replaceTrackedSuccessor || initializeSelectedRelease
    ? generateTrackedSuccessor({
      configDirectory, trackedEvidencePath, transitionLedgerPath,
      initializeSelectedRelease,
      preserveDirectory: initializeSelectedRelease ? resolveRequired(options, "preserve-historical-directory") : undefined,
      preserved: (path) => { historicalReceipt = path; },
      worktree,
      rawRoot,
      receiptPaths,
      expectedRelease,
    })
    : generateHostRecoveryEvidence({
      worktreeRoot: worktree,
      configDirectory,
      rawRoot,
      receiptPaths,
      outputPath,
      expectedRelease,
      allowExternalOutput: options.allowExternalOutput === true,
    });
  if (!replaceTrackedSuccessor && !initializeSelectedRelease && resolve(outputPath) === trackedEvidencePath) {
    bindTransitionLedgerEvidence(transitionLedgerPath, evidence, readFileSync(outputPath));
  }
  process.stdout.write(`${JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    output: outputPath,
    evidence_digest: evidence.evidence_digest,
    scenario_count: evidence.scenarios.length,
    source_receipt_count: evidence.source_receipts.length,
    ...(historicalReceipt === undefined ? {} : { historical_receipt: historicalReceipt }),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}

function generateTrackedSuccessor({ worktree, configDirectory, trackedEvidencePath,
  transitionLedgerPath, rawRoot, receiptPaths, expectedRelease,
  initializeSelectedRelease, preserveDirectory, preserved }) {
  const bindingOptions = { worktreeRoot: worktree, configDirectory };
  const validatePredecessor = initializeSelectedRelease
    ? validateTrackedHostRecoveryInitialBinding : validateTrackedHostRecoverySuccessor;
  const predecessor = validatePredecessor(bindingOptions);
  const temporaryOutputPath = `${trackedEvidencePath}.${randomUUID()}.tmp`;
  let temporaryLedgerPath;
  try {
    if (initializeSelectedRelease) {
      preserved(preserveHistoricalBinding({ worktree, rawRoot, preserveDirectory, predecessor, selectedRelease: expectedRelease }));
    }
    const evidence = generateHostRecoveryEvidence({
      worktreeRoot: worktree, configDirectory, rawRoot, receiptPaths,
      outputPath: temporaryOutputPath, expectedRelease,
    });
    const bytes = readFileSync(temporaryOutputPath);
    const ledger = bindLedgerObject(structuredClone(predecessor.ledger), evidence, bytes);
    temporaryLedgerPath = `${trackedEvidencePath}.ledger.${randomUUID()}.tmp`;
    writeDurableExclusive(temporaryLedgerPath, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`));
    const currentPredecessor = validatePredecessor(bindingOptions);
    if (!currentPredecessor.aggregateBytes.equals(predecessor.aggregateBytes) ||
        !currentPredecessor.ledgerBytes.equals(predecessor.ledgerBytes)) {
      throw new Error("tracked issue-46 aggregate or ledger changed during successor generation");
    }
    // Each rename is atomic. An interrupted pair is deliberately unbound and
    // consumers refuse it; this is not an atomic multi-file transaction.
    renameSync(temporaryOutputPath, trackedEvidencePath);
    renameSync(temporaryLedgerPath, transitionLedgerPath);
    return evidence;
  } finally {
    if (existsSync(temporaryOutputPath)) unlinkSync(temporaryOutputPath);
    if (temporaryLedgerPath !== undefined && existsSync(temporaryLedgerPath)) unlinkSync(temporaryLedgerPath);
  }
}

function preserveHistoricalBinding({ worktree, rawRoot, preserveDirectory, predecessor, selectedRelease }) {
  const directory = assertExternalQualificationRoot(preserveDirectory, { worktreeRoot: worktree, label: "historical receipt directory" });
  const raw = assertExternalQualificationRoot(rawRoot, { worktreeRoot: worktree });
  if (directory === raw || directory.startsWith(`${raw}/`) || raw.startsWith(`${directory}/`)) {
    throw new Error("historical receipt directory must be disjoint from raw receipts");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const aggregateHash = sha256(predecessor.aggregateBytes);
  const ledgerHash = sha256(predecessor.ledgerBytes);
  const receiptDirectory = resolve(directory, `${aggregateHash}-${ledgerHash}-${sha256(Buffer.from(canonicalDigest(selectedRelease)))}`);
  assertExternalQualificationRoot(receiptDirectory, { worktreeRoot: worktree, label: "historical receipt" });
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const receipt = {
    schema: "flow.host-recovery-historical-preservation/v1",
    meaning: "immutable historical source bytes; not selected-release proof or predecessor qualification",
    original_release: predecessor.evidence.release,
    selected_release: selectedRelease,
    aggregate_sha256: aggregateHash, ledger_sha256: ledgerHash,
    original_evidence_digest: predecessor.evidence.evidence_digest,
  };
  preserveBytes(resolve(receiptDirectory, "aggregate.json"), predecessor.aggregateBytes, worktree);
  preserveBytes(resolve(receiptDirectory, "ledger.json"), predecessor.ledgerBytes, worktree);
  preserveBytes(resolve(receiptDirectory, "receipt.json"), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), worktree);
  syncDirectory(receiptDirectory);
  syncDirectory(directory);
  return receiptDirectory;
}

function preserveBytes(path, bytes, worktree) {
  assertExternalQualificationRoot(path, { worktreeRoot: worktree, label: "historical source bytes" });
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error("immutable historical receipt conflicts with existing bytes");
    const descriptor = openSync(path, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } else writeDurableExclusive(path, bytes, 0o400);
}

function writeDurableExclusive(path, bytes, mode = 0o600) {
  const descriptor = openSync(path, "wx", mode);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function bindTransitionLedgerEvidence(transitionLedgerPath, evidence, bytes) {
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
    if (argument === "--initialize-selected-release") {
      options.initializeSelectedRelease = true;
      continue;
    }
    if (argument === "--replace-tracked-successor") {
      options.replaceTrackedSuccessor = true;
      continue;
    }
    if (!["--raw-root", "--output", "--worktree", "--receipt", "--release", "--config-directory", "--preserve-historical-directory"].includes(argument)) {
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
    } else if (["--raw-root", "--config-directory", "--preserve-historical-directory"].includes(argument)) {
      options[argument.slice(2)] = value;
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
