import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  DETERMINISTIC_QUALIFICATION_ASSERTIONS,
  DETERMINISTIC_QUALIFICATION_COMMANDS,
  DETERMINISTIC_QUALIFICATION_SCOPE,
  PRODUCTION_ROUTE_CONFORMANCE_COMMANDS,
  PRODUCTION_ROUTE_CONFORMANCE_SCOPE,
  createProductionRouteConformanceEvidence,
} from
  "../../../tools/flow/src/qualification-recipe.mjs";
import {
  productionRouteConformanceSessionBinding,
  productionRouteConformanceSessionBytes,
} from "../../../tools/flow/src/qualification-phase2-session.mjs";

const configDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(configDirectory, "../..");
const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
const evidencePath = join(
  configDirectory,
  "evidence/release-qualification.v1.json",
);
const contentPath = join(configDirectory, "evidence/release-content.v1.json");
const manifestPath = join(configDirectory, "release-manifest.v1.json");
const phase2EvidencePath = join(
  configDirectory,
  "evidence/production-route-conformance.v1.json",
);

const ledger = readJson(ledgerPath);
const evidenceTemplate = readJson(evidencePath);
const releaseContentBytes = readFileSync(contentPath);
const releaseContent = JSON.parse(releaseContentBytes);
const releaseManifest = readJson(manifestPath);
const phase1Record = requireLedgerEvidence(ledger, "deterministic_qualification");
const phase2Record = requireLedgerEvidence(ledger, "production_route_conformance");
const contentDigest = `sha256:${sha256(releaseContentBytes)}`;
const manifestDigest = `sha256:${sha256(readFileSync(manifestPath))}`;

await beginQualificationGeneration();
const phase1Results = DETERMINISTIC_QUALIFICATION_COMMANDS.map(
  (command) => runCommand(command),
);
for (const { command, receiptBytes } of phase1Results) {
  writeContainedReceipt(command.receipt_path, receiptBytes);
}

const phase1Commands = recipeCommands(phase1Results);
const phase1CapturedAt = utcNow();
const qualification = {
  ...evidenceTemplate,
  schema: "flow.transition-qualification-evidence/v1",
  release_id: ledger.release.id,
  qualification_base_commit: ledger.release.qualification_base_commit,
  candidate_tree_sha: releaseContent.git_binding.candidate_tree_sha,
  release_content_digest: releaseContent.content_digest,
  status: "passed",
  scope: DETERMINISTIC_QUALIFICATION_SCOPE,
  contracts: [
    "flow.launch-policy/v1",
    "flow.launch-selection/v1",
    "flow.launch-rejection/v1",
    "flow.release-manifest/v1",
    "flow.transition-ledger/v1",
    "flow.transition-projection/v1",
    "flow.production-route-conformance-evidence/v1",
  ],
  assertions: DETERMINISTIC_QUALIFICATION_ASSERTIONS,
  recipe: {
    schema: "flow.deterministic-qualification-recipe/v1",
    digest: canonicalDigest(phase1Commands),
    commands: phase1Commands,
  },
  captured_at: phase1CapturedAt,
  environment: qualificationEnvironment(),
};
const qualificationBytes = Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`);
writeAtomic(evidencePath, qualificationBytes);
phase1Record.path = relative(configDirectory, evidencePath);
phase1Record.sha256 = sha256(qualificationBytes);
phase1Record.status = "passed";
refreshAndWriteLedger(utcNow());

const phase2Results = runProductionRouteConformancePhase();
for (const { command, receiptBytes } of phase2Results) {
  writeContainedReceipt(command.receipt_path, receiptBytes);
}
const phase2Commands = recipeCommands(phase2Results);
const phase2CapturedAt = utcNow();
const phase2Evidence = createProductionRouteConformanceEvidence({
  releaseId: ledger.release.id,
  qualificationBaseCommit: ledger.release.qualification_base_commit,
  candidateTreeSha: releaseContent.git_binding.candidate_tree_sha,
  releaseContentDigest: releaseContent.content_digest,
  status: "passed",
  phase1EvidenceSha256: phase1Record.sha256,
  recipe: {
    schema: "flow.production-route-conformance-recipe/v1",
    digest: canonicalDigest(phase2Commands),
    commands: phase2Commands,
  },
  capturedAt: phase2CapturedAt,
  environment: qualificationEnvironment(),
});
const phase2EvidenceBytes = Buffer.from(
  `${JSON.stringify(phase2Evidence, null, 2)}\n`,
);
writeAtomic(phase2EvidencePath, phase2EvidenceBytes);
phase2Record.path = relative(configDirectory, phase2EvidencePath);
phase2Record.sha256 = sha256(phase2EvidenceBytes);
phase2Record.status = "passed";
refreshAndWriteLedger(utcNow());

process.stdout.write(`${JSON.stringify({
  phase1: {
    path: relative(repositoryRoot, evidencePath),
    evidence_sha256: phase1Record.sha256,
    candidate_tree_sha: qualification.candidate_tree_sha,
    release_content_digest: qualification.release_content_digest,
    commands: phase1Commands.map(({ id, tests, passed, receipt_sha256 }) => ({
      id,
      tests,
      passed,
      receipt_sha256,
    })),
  },
  phase2: {
    path: relative(repositoryRoot, phase2EvidencePath),
    evidence_sha256: phase2Record.sha256,
    commands: phase2Commands.map(({ id, tests, passed, receipt_sha256 }) => ({
      id,
      tests,
      passed,
      receipt_sha256,
    })),
  },
}, null, 2)}\n`);

async function beginQualificationGeneration() {
  const recordedAt = utcNow();
  phase1Record.path = null;
  phase1Record.sha256 = null;
  phase1Record.status = "not_run";
  phase2Record.path = null;
  phase2Record.sha256 = null;
  phase2Record.status = "not_run";
  refreshAndWriteLedger(recordedAt);

  const evidence = createProductionRouteConformanceEvidence({
    releaseId: ledger.release.id,
    qualificationBaseCommit: ledger.release.qualification_base_commit,
    candidateTreeSha: releaseContent.git_binding.candidate_tree_sha,
    releaseContentDigest: releaseContent.content_digest,
    capturedAt: recordedAt,
    environment: qualificationEnvironment(),
  });
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  writeAtomic(phase2EvidencePath, bytes);
  phase2Record.path = relative(configDirectory, phase2EvidencePath);
  phase2Record.sha256 = sha256(bytes);
  refreshAndWriteLedger(utcNow());
}

function runProductionRouteConformancePhase() {
  const scratch = mkdtempSync(join(tmpdir(), "flow-phase2-authority-"));
  const phase2ConfigDirectory = join(scratch, "flow");
  try {
    cpSync(configDirectory, phase2ConfigDirectory, {
      recursive: true,
      filter: (source) => !source.split(sep).includes("node_modules"),
    });
    const phase2LedgerPath = join(
      phase2ConfigDirectory,
      "transition-ledger.v1.json",
    );
    const phase2Ledger = readJson(phase2LedgerPath);
    const phase2RecordInCopy = requireLedgerEvidence(
      phase2Ledger,
      "production_route_conformance",
    );
    const marker = randomBytes(32).toString("hex");
    const generationId = randomUUID();
    const recordedAt = utcNow();
    const phase2Evidence = createProductionRouteConformanceEvidence({
      releaseId: ledger.release.id,
      qualificationBaseCommit: ledger.release.qualification_base_commit,
      candidateTreeSha: releaseContent.git_binding.candidate_tree_sha,
      releaseContentDigest: releaseContent.content_digest,
      status: "running",
      phase1EvidenceSha256: phase1Record.sha256,
      generationId,
      generationBindingSha256: productionRouteConformanceSessionBinding({
        authorityDirectory: phase2ConfigDirectory,
        generationId,
        marker,
      }),
      capturedAt: recordedAt,
      environment: qualificationEnvironment(),
    });
    const phase2EvidenceBytes = Buffer.from(
      `${JSON.stringify(phase2Evidence, null, 2)}\n`,
    );
    writeAtomic(
      join(phase2ConfigDirectory, "evidence/production-route-conformance.v1.json"),
      phase2EvidenceBytes,
    );
    phase2RecordInCopy.path = "evidence/production-route-conformance.v1.json";
    phase2RecordInCopy.sha256 = sha256(phase2EvidenceBytes);
    phase2RecordInCopy.status = "not_run";
    phase2Ledger.recorded_at = recordedAt;
    for (const evidence of phase2Ledger.evidence) evidence.recorded_at = recordedAt;
    writeAtomic(phase2LedgerPath, Buffer.from(`${JSON.stringify(phase2Ledger, null, 2)}\n`));

    const env = {
      ...process.env,
      FLOW_CONFIG_DIRECTORY: phase2ConfigDirectory,
      // The phase-two authority is a disposable copy of config/flow, but
      // qualification must remain bound to the exact governed release tree.
      // Never infer this from the copied config or the disposable backup
      // repository.
      FLOW_QUALIFICATION_REPOSITORY_ROOT: repositoryRoot,
      FLOW_REPOSITORY_ROOT: repositoryRoot,
      FLOW_PRODUCTION_ROUTE_CONFORMANCE_PROCESS: "1",
    };
    return PRODUCTION_ROUTE_CONFORMANCE_COMMANDS.map((command) =>
      runCommand(command, env, {
        phase2Session: {
          authorityDirectory: phase2ConfigDirectory,
          marker,
          tokenDirectory: scratch,
        },
      }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function refreshAndWriteLedger(recordedAt) {
  const catalogBytes = readFileSync(join(configDirectory, "contracts/catalog.v1.json"));
  const catalog = JSON.parse(catalogBytes);
  const inventoryBytes = readFileSync(join(configDirectory, "legacy-baselines.v1.json"));
  const policyBytes = readFileSync(join(configDirectory, "launch-policy.v1.json"));
  ledger.release.content = {
    path: relative(configDirectory, contentPath),
    sha256: contentDigest.slice(7),
    digest: releaseContent.content_digest,
  };
  ledger.capability_manifest.sha256 = manifestDigest.slice(7);
  ledger.legacy_inventory = {
    path: "legacy-baselines.v1.json",
    sha256: sha256(inventoryBytes),
  };
  ledger.contracts.catalog = `flow.contract-catalog/v1@${catalog.catalog_version}`;
  ledger.contracts.production_route_conformance =
    "flow.production-route-conformance-evidence/v1";
  ledger.environment_fingerprint.qualification =
    "two_phase_public_route_conformance";
  ledger.recorded_at = recordedAt;
  for (const evidence of ledger.evidence) evidence.recorded_at = recordedAt;
  const records = new Map(ledger.evidence.map((evidence) => [evidence.id, evidence]));
  bindStaticEvidence(records.get("public_contract_catalog"),
    "contracts/catalog.v1.json", sha256(catalogBytes));
  bindStaticEvidence(records.get("legacy_default_policy"),
    "launch-policy.v1.json", sha256(policyBytes));
  bindStaticEvidence(records.get("frozen_legacy_inventory"),
    "legacy-baselines.v1.json", sha256(inventoryBytes));
  const contentRecord = records.get("release_content_binding");
  contentRecord.path = relative(configDirectory, contentPath);
  contentRecord.sha256 = contentDigest.slice(7);
  contentRecord.status = "passed";
  writeAtomic(ledgerPath, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`));
}

function bindStaticEvidence(record, path, sha256Value) {
  if (record === undefined) throw new Error(`missing ledger evidence record: ${path}`);
  record.path = path;
  record.sha256 = sha256Value;
  record.status = "passed";
}

function requireLedgerEvidence(ledger, id) {
  const record = ledger.evidence.find((evidence) => evidence.id === id);
  if (record === undefined) throw new Error(`missing transition evidence record: ${id}`);
  return record;
}

function recipeCommands(results) {
  return results.map(({ command, summary, receiptBytes }) => ({
    id: command.id,
    command: command.command,
    working_directory: command.working_directory,
    receipt_path: command.receipt_path,
    receipt_sha256: sha256(receiptBytes),
    status: "passed",
    exit_code: 0,
    tests: summary.tests,
    passed: summary.pass,
    failed: summary.fail,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    flaky: 0,
  }));
}

function qualificationEnvironment() {
  return {
    os: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: commandVersion("npm", ["--version"]),
    git: commandVersion("git", ["--version"]).replace(/^git version /u, ""),
  };
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function writeAtomic(path, bytes) {
  const temporaryPath = join(
    dirname(path),
    `.${randomUUID()}.qualification-tmp`,
  );
  writeFileSync(temporaryPath, bytes, { flag: "wx" });
  renameSync(temporaryPath, path);
}

function runCommand(command, env = process.env, { phase2Session = null } = {}) {
  let sessionDescriptor = null;
  if (phase2Session !== null) {
    const tokenPath = join(
      phase2Session.tokenDirectory,
      `.${randomUUID()}.phase2-session`,
    );
    writeFileSync(tokenPath, productionRouteConformanceSessionBytes({
      authorityDirectory: phase2Session.authorityDirectory,
      marker: phase2Session.marker,
    }), { flag: "wx", mode: 0o600 });
    sessionDescriptor = openSync(tokenPath, "r");
    unlinkSync(tokenPath);
  }
  let result;
  try {
    result = spawnSync(process.execPath, command.args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env,
      ...(sessionDescriptor === null ? {} : {
        stdio: ["ignore", "pipe", "pipe", sessionDescriptor],
      }),
    });
  } finally {
    if (sessionDescriptor !== null) closeSync(sessionDescriptor);
  }
  const output = result.stdout ?? "";
  const diagnostics = `${output}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(diagnostics);
    throw new Error(`qualification command failed: ${command.command}`);
  }
  const summary = parseTapSummary(output);
  if (summary.tests < 1 || summary.pass !== summary.tests ||
      summary.fail !== 0 || summary.cancelled !== 0 ||
      summary.skipped !== 0 || summary.todo !== 0) {
    process.stderr.write(diagnostics);
    throw new Error(`qualification command did not pass cleanly: ${command.command}`);
  }
  return {
    command,
    summary,
    receiptPath: join(configDirectory, command.receipt_path),
    receiptBytes: Buffer.from(output),
  };
}

function parseTapSummary(output) {
  const summary = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (match === null) continue;
    if (Object.hasOwn(summary, match[1])) {
      throw new Error(`qualification TAP summary repeats ${match[1]}`);
    }
    summary[match[1]] = Number(match[2]);
  }
  return {
    tests: summary.tests ?? 0,
    pass: summary.pass ?? 0,
    fail: summary.fail ?? 0,
    cancelled: summary.cancelled ?? 0,
    skipped: summary.skipped ?? 0,
    todo: summary.todo ?? 0,
  };
}

function commandVersion(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeContainedReceipt(path, bytes) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) ||
      path.includes("\\") || path.split("/").some((component) =>
        component === "" || component === "." || component === "..")) {
    throw new Error("qualification receipt path is invalid");
  }
  const root = realpathSync(configDirectory);
  let current = root;
  const components = path.split("/");
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current);
      stats = lstatSync(current);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`qualification receipt path contains a symlink: ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`qualification receipt parent is not a directory: ${path}`);
    }
  }
  const parentRealPath = realpathSync(current);
  const relativeParentPath = relative(root, parentRealPath);
  if (relativeParentPath === ".." ||
      relativeParentPath.startsWith(`..${sep}`) ||
      isAbsolute(relativeParentPath)) {
    throw new Error(`qualification receipt parent resolves outside config: ${path}`);
  }
  const receiptPath = join(parentRealPath, components.at(-1));
  try {
    const stats = lstatSync(receiptPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`qualification receipt path contains a symlink: ${path}`);
    }
    if (!stats.isFile() || !statSync(receiptPath).isFile()) {
      throw new Error(`qualification receipt is not a regular file: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const canonicalPath = resolve(parentRealPath, components.at(-1));
  const relativePath = relative(root, canonicalPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)) {
    throw new Error(`qualification receipt resolves outside config: ${path}`);
  }
  writeFileSync(canonicalPath, bytes);
}
