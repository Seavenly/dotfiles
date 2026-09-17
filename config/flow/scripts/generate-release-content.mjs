import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveGitTreeSha,
  isGovernedReleasePath,
  RELEASE_CONTENT_GOVERNANCE,
  releaseContentDigest,
} from "../../../tools/flow/src/release-content-contract.mjs";
import {
  createProductionRouteConformanceEvidence,
} from "../../../tools/flow/src/qualification-recipe.mjs";

const configDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(configDirectory, "../..");
const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
const manifestPath = join(configDirectory, "release-manifest.v1.json");
const policyPath = join(configDirectory, "launch-policy.v1.json");
const ledger = JSON.parse(readFileSync(
  ledgerPath,
  "utf8",
));
const releaseManifest = JSON.parse(readFileSync(
  manifestPath,
  "utf8",
));
const releaseManifestBytes = readFileSync(manifestPath);
const releaseManifestDigest = createHash("sha256")
  .update(releaseManifestBytes)
  .digest("hex");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const replacementPolicy = policy.implementations?.["flow-runtime/v1"];
if (!replacementPolicy?.dark_opt_in) {
  throw new Error("launch policy has no dark opt-in release binding");
}
replacementPolicy.dark_opt_in.manifest_sha256 = releaseManifestDigest;
writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

if (ledger.release.id !== releaseManifest.release_id ||
    !/^[0-9a-f]{40}$/u.test(ledger.release.qualification_base_commit ?? "") ||
    runGit(repositoryRoot, [
      "cat-file",
      "-e",
      `${ledger.release.qualification_base_commit}^{commit}`,
    ], process.env) !== "") {
  throw new Error("release content cannot bind an inconsistent release identity");
}

const files = readGovernedFiles(repositoryRoot);
const candidateTreeSha = deriveGitTreeSha(files);
const content = {
  schema: "flow.release-content/v1",
  release_id: ledger.release.id,
  git_binding: {
    ...RELEASE_CONTENT_GOVERNANCE,
    candidate_tree_sha: candidateTreeSha,
    qualification_base_commit: ledger.release.qualification_base_commit,
  },
  content_digest: "",
  files,
};
content.content_digest = releaseContentDigest(content);

const evidencePath = join(configDirectory, "evidence/release-content.v1.json");
const contentBytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
writeFileSync(evidencePath, contentBytes);

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const phase2EvidencePath = join(
  configDirectory,
  "evidence/production-route-conformance.v1.json",
);
const phase2Evidence = createProductionRouteConformanceEvidence({
  releaseId: ledger.release.id,
  qualificationBaseCommit: ledger.release.qualification_base_commit,
  candidateTreeSha,
  releaseContentDigest: content.content_digest,
  capturedAt: timestamp,
  environment: qualificationEnvironment(),
});
const phase2EvidenceBytes = Buffer.from(
  `${JSON.stringify(phase2Evidence, null, 2)}\n`,
);
writeFileSync(phase2EvidencePath, phase2EvidenceBytes);
const catalogBytes = readFileSync(join(configDirectory, "contracts/catalog.v1.json"));
const contractCatalog = JSON.parse(catalogBytes);
const inventoryBytes = readFileSync(join(configDirectory, "legacy-baselines.v1.json"));
ledger.release.content = {
  path: relative(configDirectory, evidencePath),
  sha256: createHash("sha256").update(contentBytes).digest("hex"),
  digest: content.content_digest,
};
ledger.capability_manifest.sha256 = releaseManifestDigest;
ledger.legacy_inventory.sha256 = createHash("sha256")
  .update(inventoryBytes)
  .digest("hex");
ledger.contracts.catalog = `flow.contract-catalog/v1@${contractCatalog.catalog_version}`;
ledger.contracts.production_route_conformance =
  "flow.production-route-conformance-evidence/v1";
ledger.environment_fingerprint.qualification =
  "two_phase_public_route_conformance";
ledger.recorded_at = timestamp;
if (!ledger.evidence.some(({ id }) => id === "production_route_conformance")) {
  ledger.evidence.push({
    id: "production_route_conformance",
    path: null,
    sha256: null,
    status: "not_run",
    recorded_at: timestamp,
  });
}
for (const evidence of ledger.evidence) {
  if (evidence.id === "public_contract_catalog") {
    evidence.path = "contracts/catalog.v1.json";
    evidence.sha256 = createHash("sha256").update(catalogBytes).digest("hex");
    evidence.recorded_at = timestamp;
  } else if (evidence.id === "legacy_default_policy") {
    evidence.path = "launch-policy.v1.json";
    evidence.sha256 = createHash("sha256").update(readFileSync(policyPath)).digest("hex");
    evidence.recorded_at = timestamp;
  } else if (evidence.id === "frozen_legacy_inventory") {
    evidence.path = "legacy-baselines.v1.json";
    evidence.sha256 = ledger.legacy_inventory.sha256;
    evidence.recorded_at = timestamp;
  } else if (evidence.id === "release_content_binding") {
    evidence.path = relative(configDirectory, evidencePath);
    evidence.sha256 = ledger.release.content.sha256;
    evidence.status = "passed";
    evidence.recorded_at = timestamp;
  } else if (evidence.id === "deterministic_qualification") {
    evidence.path = null;
    evidence.sha256 = null;
    evidence.status = "not_run";
    evidence.recorded_at = timestamp;
  } else if (evidence.id === "production_route_conformance") {
    evidence.path = relative(configDirectory, phase2EvidencePath);
    evidence.sha256 = createHash("sha256").update(phase2EvidenceBytes).digest("hex");
    evidence.status = "not_run";
    evidence.recorded_at = timestamp;
  }
}
writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  path: relative(repositoryRoot, evidencePath),
  candidate_tree_sha: candidateTreeSha,
  file_count: files.length,
  content_digest: content.content_digest,
  manifest_sha256: releaseManifestDigest,
}, null, 2)}\n`);

function readGovernedFiles(root) {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--full-name",
      ...RELEASE_CONTENT_GOVERNANCE.excluded_paths.map((path) =>
        `--exclude=${path.endsWith("/") ? `${path}**` : path}`),
      "--",
      ...RELEASE_CONTENT_GOVERNANCE.included_paths,
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  const files = [];
  for (const pathBytes of nulSeparatedRows(listing)) {
    const path = pathBytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(pathBytes)) {
      throw new Error("candidate release content path is not valid UTF-8");
    }
    if (!isGovernedReleasePath(path)) continue;
    const absolutePath = resolve(root, path);
    const relativePath = relative(resolve(root), absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
        isAbsolutePath(relativePath)) {
      throw new Error(`candidate Git tree path escapes the repository: ${path}`);
    }
    const canonicalPath = assertRegularFile(root, path, absolutePath);
    const bytes = readFileSync(canonicalPath);
    const mode = workingTreeMode(lstatSync(absolutePath).mode);
    files.push({
      path,
      mode,
      git_blob_sha: gitBlobSha(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  files.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
  return files;
}

function assertRegularFile(root, path, absolutePath) {
  const rootPath = realpathSync(root);
  const components = path.split("/");
  let current = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`candidate release content contains a symlink: ${path}`);
    }
    if (index === components.length - 1) {
      if (!stats.isFile()) {
        throw new Error(`candidate release content is not a regular file: ${path}`);
      }
    } else if (!stats.isDirectory()) {
      throw new Error(`candidate release content has a non-directory parent: ${path}`);
    }
  }
  const realPath = realpathSync(absolutePath);
  const relativeRealPath = relative(rootPath, realPath);
  if (relativeRealPath === ".." || relativeRealPath.startsWith(`..${sep}`) ||
      isAbsolutePath(relativeRealPath) || !statSync(realPath).isFile()) {
    throw new Error(`candidate release content resolves outside the repository: ${path}`);
  }
  return realPath;
}

function nulSeparatedRows(bytes) {
  const rows = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0) continue;
    const row = bytes.subarray(start, index);
    start = index + 1;
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

function workingTreeMode(mode) {
  return (mode & 0o111) !== 0 ? "100755" : "100644";
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function qualificationEnvironment() {
  return {
    os: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: commandVersion(pinnedNpmExecutable(), ["--version"]),
    git: commandVersion("git", ["--version"]).replace(/^git version /u, ""),
  };
}

function pinnedNpmExecutable() {
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidate = join(dirname(process.execPath), npmName);
  let resolved;
  try {
    resolved = realpathSync(candidate);
    accessSync(resolved, fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `the pinned Node installation has no executable npm: ${candidate}`,
      { cause: error },
    );
  }
  return resolved;
}

function commandVersion(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function runGit(root, args, env = process.env) {
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function isAbsolutePath(path) {
  return path.startsWith(sep);
}
