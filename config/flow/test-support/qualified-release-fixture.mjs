import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  deriveGitTreeSha,
  releaseContentDigest,
} from "../../../tools/flow/src/release-content-contract.mjs";
import {
  PRODUCTION_ROUTE_CONFORMANCE_COMMANDS,
} from "../../../tools/flow/src/qualification-recipe.mjs";

const execFile = promisify(execFileCallback);

/**
 * Bind a copied Flow configuration to the current repository as a disposable
 * qualified release fixture.  This never changes native evidence in the
 * source worktree; callers own the copied config or temporary worktree.
 */
export async function bindQualifiedReleaseFixture({
  configDirectory,
  repositoryRoot,
} = {}) {
  const contentPath = join(configDirectory, "evidence/release-content.v1.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  for (const entry of content.files) {
    const bytes = await readFile(join(repositoryRoot, entry.path));
    entry.git_blob_sha = gitBlobSha(bytes);
    entry.sha256 = sha256(bytes);
  }
  content.git_binding.candidate_tree_sha = deriveGitTreeSha(content.files);
  content.content_digest = releaseContentDigest(content);
  const contentBytes = jsonBytes(content);
  await writeFile(contentPath, contentBytes);

  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const contentEvidence = ledger.evidence.find(({ id }) =>
    id === "release_content_binding");
  contentEvidence.sha256 = sha256(contentBytes);
  ledger.release.content.sha256 = contentEvidence.sha256;
  ledger.release.content.digest = content.content_digest;

  const productionPath = join(
    configDirectory,
    "evidence/production-route-conformance.v1.json",
  );
  const production = JSON.parse(await readFile(productionPath, "utf8"));
  production.candidate_tree_sha = content.git_binding.candidate_tree_sha;
  production.release_content_digest = content.content_digest;
  const productionBytes = jsonBytes(production);
  await writeFile(productionPath, productionBytes);
  const productionEvidence = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  productionEvidence.sha256 = sha256(productionBytes);

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
    repositoryRoot: destination,
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
