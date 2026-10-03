import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  deriveGitTreeSha,
  releaseContentDigest,
  isGovernedReleasePath,
  RELEASE_CONTENT_GOVERNANCE,
} from "../../../tools/flow/src/release-content-contract.mjs";
import {
  PRODUCTION_ROUTE_CONFORMANCE_COMMANDS,
} from "../../../tools/flow/src/qualification-recipe.mjs";

const execFile = promisify(execFileCallback);

// Extracted from the existing host-recovery owned runtime-copy fixture. The
// isolation environment pins config to the runtime root, so these two public
// producer tests need a copied runtime instead of a config-directory override.
// No qualification generator or commit is run, and source evidence is untouched.
export async function copyQualifiedRuntimeFixture({ sourceRoot, destination }) {
  await execFile("/usr/bin/git", ["clone", "--quiet", sourceRoot, destination], {
    cwd: sourceRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { stdout } = await execFile("/usr/bin/git", [
    "-C", sourceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], { maxBuffer: 64 * 1024 * 1024 });
  for (const path of stdout.split("\0").filter(Boolean)) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceRoot, path), target, { recursive: true, force: true });
  }
  for (const path of ["config/flow/node_modules", "tools/flow/node_modules"]) {
    await cp(join(sourceRoot, path), join(destination, path), {
      recursive: true, force: true,
    });
  }
  await execFile(process.execPath, [
    join(destination, "config/flow/scripts/generate-release-content.mjs"),
  ], { cwd: destination, maxBuffer: 4 * 1024 * 1024 });
  await bindQualifiedReleaseFixture({
    configDirectory: join(destination, "config/flow"),
    repositoryRoot: sourceRoot,
  });
  return destination;
}

/** Rebind only a disposable copy, preserving qualification status. */
export async function rebindReleaseContentFixture({ configDirectory, repositoryRoot } = {}) {
  if (await realpath(configDirectory) === await realpath(join(repositoryRoot, "config/flow"))) throw new Error("release fixture requires disposable copied config");
  const contentPath = join(configDirectory, "evidence/release-content.v1.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  const { stdout } = await execFile("/usr/bin/git", ["-C", repositoryRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  content.files = await Promise.all([...new Set(stdout.split("\0").filter(isGovernedReleasePath))].sort().map(async path => {
    const bytes = await readFile(join(repositoryRoot, path));
    const stat = await lstat(join(repositoryRoot, path));
    if (!stat.isFile()) throw new Error("qualified fixture source must be a regular file");
    return { path, mode: stat.mode & 0o111 ? "100755" : "100644", git_blob_sha: gitBlobSha(bytes), sha256: sha256(bytes) };
  }));
  content.git_binding = { ...content.git_binding, ...RELEASE_CONTENT_GOVERNANCE };
  content.git_binding.candidate_tree_sha = deriveGitTreeSha(content.files);
  content.content_digest = releaseContentDigest(content);
  const contentBytes = jsonBytes(content);
  await writeFile(contentPath, contentBytes);

  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const catalogBytes = await readFile(join(configDirectory, "contracts/catalog.v1.json"));
  ledger.contracts.catalog = `flow.contract-catalog/v1@${JSON.parse(catalogBytes).catalog_version}`;
  ledger.evidence.find(({ id }) => id === "public_contract_catalog").sha256 = sha256(catalogBytes);
  const contentEvidence = ledger.evidence.find(({ id }) =>
    id === "release_content_binding");
  contentEvidence.sha256 = sha256(contentBytes);
  ledger.release.content.sha256 = contentEvidence.sha256;
  ledger.release.content.digest = content.content_digest;

  const productionEvidence = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  if (productionEvidence?.path !== null) {
    const productionPath = join(configDirectory, productionEvidence.path);
    const production = JSON.parse(await readFile(productionPath, "utf8"));
    production.candidate_tree_sha = content.git_binding.candidate_tree_sha;
    production.release_content_digest = content.content_digest;
    const productionBytes = jsonBytes(production);
    await writeFile(productionPath, productionBytes);
    productionEvidence.sha256 = sha256(productionBytes);
  }

  await writeFile(ledgerPath, jsonBytes(ledger));
  return { candidateTreeSha: content.git_binding.candidate_tree_sha, releaseContentDigest: content.content_digest };
}

/** Qualify only a caller-owned disposable configuration. */
export async function bindQualifiedReleaseFixture({ configDirectory, repositoryRoot } = {}) {
  await rebindReleaseContentFixture({ configDirectory, repositoryRoot });
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const content = JSON.parse(await readFile(join(configDirectory, "evidence/release-content.v1.json"), "utf8"));
  const productionPath = join(configDirectory, "evidence/production-route-conformance.v1.json");
  const production = JSON.parse(await readFile(productionPath, "utf8"));
  const productionEvidence = ledger.evidence.find(({ id }) => id === "production_route_conformance");
  const qualificationPath = join(
    configDirectory,
    "evidence/release-qualification.v1.json",
  );
  const qualification = JSON.parse(await readFile(qualificationPath, "utf8"));
  qualification.release_id = ledger.release.id;
  qualification.qualification_base_commit =
    ledger.release.qualification_base_commit;
  qualification.candidate_tree_sha = content.git_binding.candidate_tree_sha;
  qualification.release_content_digest = ledger.release.content.digest;
  qualification.status = "passed";
  const qualificationBytes = jsonBytes(qualification);
  await writeFile(qualificationPath, qualificationBytes);
  const qualificationEvidence = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  qualificationEvidence.path = "evidence/release-qualification.v1.json";
  qualificationEvidence.status = "passed";
  qualificationEvidence.sha256 = sha256(qualificationBytes);

  production.release_id = ledger.release.id;
  production.qualification_base_commit =
    ledger.release.qualification_base_commit;
  production.candidate_tree_sha = content.git_binding.candidate_tree_sha;
  production.release_content_digest = content.content_digest;
  production.status = "passed";
  production.phase1_evidence_sha256 = qualificationEvidence.sha256;
  production.generation_id = null;
  production.generation_binding_sha256 = null;
  production.recipe = await qualifiedProductionRecipe(configDirectory);
  const qualifiedProductionBytes = jsonBytes(production);
  await writeFile(productionPath, qualifiedProductionBytes);
  productionEvidence.path = "evidence/production-route-conformance.v1.json";
  productionEvidence.status = "passed";
  productionEvidence.sha256 = sha256(qualifiedProductionBytes);
  await writeFile(ledgerPath, jsonBytes(ledger));

  return {
    candidateTreeSha: content.git_binding.candidate_tree_sha,
    releaseContentDigest: content.content_digest,
    qualificationEvidenceSha256: qualificationEvidence.sha256,
    productionEvidenceSha256: productionEvidence.sha256,
  };
}

/**
 * Make a clean temporary worktree carrying the current working files and bind
 * its copied release records to that same tree.  The result is suitable for
 * isolated qualification subprocesses and is never the native worktree.
 */
export async function makeQualifiedPinnedWorktree({
  source,
  destination,
} = {}) {
  await execFile("git", ["clone", "--quiet", source, destination], {
    cwd: source,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { stdout } = await execFile("git", [
    "-C", source, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], { maxBuffer: 64 * 1024 * 1024 });
  for (const path of stdout.split("\0").filter(Boolean)) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, path), target, { recursive: true, force: true });
  }
  await execFile("git", ["-C", destination, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", destination, "config", "user.name", "Flow Qualification"]);
  await execFile(process.execPath, [
    join(destination, "config/flow/scripts/generate-release-content.mjs"),
  ], { cwd: destination, maxBuffer: 4 * 1024 * 1024 });
  await bindQualifiedReleaseFixture({
    configDirectory: join(destination, "config/flow"),
    repositoryRoot: source,
  });
  await execFile("git", ["-C", destination, "add", "-A"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  await execFile("git", [
    "-C", destination, "commit", "--quiet", "-m", "qualified test release",
  ]);
  return destination;
}

async function qualifiedProductionRecipe(configDirectory) {
  const commands = [];
  for (const expected of PRODUCTION_ROUTE_CONFORMANCE_COMMANDS) {
    const receiptBytes = await readFile(join(configDirectory, expected.receipt_path));
    const counts = tapSummary(receiptBytes.toString("utf8"));
    commands.push({
      id: expected.id,
      command: expected.command,
      working_directory: expected.working_directory,
      receipt_path: expected.receipt_path,
      receipt_sha256: sha256(receiptBytes),
      status: "passed",
      exit_code: 0,
      tests: counts.tests,
      passed: counts.pass,
      failed: counts.fail,
      cancelled: counts.cancelled,
      skipped: counts.skipped,
      flaky: 0,
    });
  }
  return {
    schema: "flow.production-route-conformance-recipe/v1",
    digest: canonicalDigest(commands),
    commands,
  };
}

function tapSummary(receipt) {
  const summary = {};
  for (const line of receipt.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (match !== null) summary[match[1]] = Number(match[2]);
  }
  if (!["tests", "pass", "fail", "cancelled", "skipped"].every((key) =>
    Number.isSafeInteger(summary[key]))) {
    throw new Error("qualified production fixture receipt has no TAP summary");
  }
  return summary;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}
