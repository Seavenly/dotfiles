import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { digest as canonicalDigest } from "./canonical.mjs";
import { resolveAuthorityRoot } from "./authority-root.mjs";
import {
  deriveGitTreeSha,
  isGovernedReleasePath,
  RELEASE_CONTENT_GOVERNANCE,
  releaseContentDigest,
} from "./release-content-contract.mjs";
import { loadContractCatalog } from "./contract-catalog.mjs";
import {
  auditLegacyBaselines,
  auditLegacyBaselinesSync,
} from "./legacy-baselines.mjs";
import {
  DETERMINISTIC_QUALIFICATION_ASSERTIONS,
  DETERMINISTIC_QUALIFICATION_COMMANDS,
  DETERMINISTIC_QUALIFICATION_SCOPE,
  PRODUCTION_ROUTE_CONFORMANCE_ASSERTIONS,
  PRODUCTION_ROUTE_CONFORMANCE_COMMANDS,
  PRODUCTION_ROUTE_CONFORMANCE_ROUTES,
  PRODUCTION_ROUTE_CONFORMANCE_SCOPE,
} from "./qualification-recipe.mjs";
import {
  projectCapabilityManifest,
  resolveLaunchPolicy,
  validateReleaseManifest,
} from "./launch-selector.mjs";
import { isExactSequence } from "./validation.mjs";
import {
  inheritedProductionRouteConformanceSession,
  productionRouteConformanceSessionBinding,
} from "./qualification-phase2-session.mjs";

const STATUSES = ["passed", "failed", "blocked", "not_run"];
const LEGACY_LAUNCH_EVIDENCE = [
  "public_contract_catalog",
  "legacy_default_policy",
  "frozen_legacy_inventory",
];
const QUALIFICATION_EVIDENCE = Object.freeze([
  "release_content_binding",
  "deterministic_qualification",
  "production_route_conformance",
]);
const PHASE1_QUALIFICATION_EVIDENCE = Object.freeze([
  "release_content_binding",
  "deterministic_qualification",
]);
let qualificationEnvironmentCache;
const REQUIRED_PREREQUISITES = Object.freeze([
  [80, "cca3158", "cca3158a3d41bda0064d43366e686b9647863bd7"],
  [81, "da66e76", "da66e76dfd5760388b70d65e46a01ca3d756b614"],
  [82, "6935cb2", "6935cb28b9246785508e6cf11983fbab365eac87"],
  [83, "685b075", "685b075e42ab94e3fb8c2960988e9388dd569337"],
  [26, "da95b977", "da95b9779184868cae679376b36e39a2910993cb"],
  [29, "a4a9a88", "a4a9a88a330be2b668339cf1a9b1b7c1b992564e"],
]);
export async function queryTransition({
  configDirectory,
  repositoryRoot,
  homeDirectory,
  stateDirectory,
}) {
  if (!repositoryRoot) {
    throw new Error("transition query requires the repository root for baseline audit");
  }
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const policyPath = join(configDirectory, "launch-policy.v1.json");
  const releaseManifestPath = join(configDirectory, "release-manifest.v1.json");
  const catalogPath = join(configDirectory, "contracts", "catalog.v1.json");
  const inventoryPath = join(configDirectory, "legacy-baselines.v1.json");
  const [
    ledgerBytes,
    policyBytes,
    releaseManifestBytes,
    inventoryBytes,
    catalogBytes,
    catalog,
    selection,
    legacyBaselineAudit,
  ] =
    await Promise.all([
      readFile(ledgerPath),
      readFile(policyPath),
      readFile(releaseManifestPath),
      readFile(inventoryPath),
      readFile(catalogPath),
      loadContractCatalog({ catalogPath, homeDirectory, stateDirectory }),
      resolveLaunchPolicy({
        policyPath,
        releaseManifestPath,
        homeDirectory,
        stateDirectory,
      }),
      auditLegacyBaselines({ repositoryRoot, inventoryPath }),
    ]);
  const ledger = JSON.parse(ledgerBytes);
  const policy = JSON.parse(policyBytes);
  const releaseManifest = JSON.parse(releaseManifestBytes);
  const inventory = JSON.parse(inventoryBytes);

  validateLedger(ledger);
  validateReleaseManifest(releaseManifest);
  await validateEvidence(configDirectory, ledger.evidence);
  const releaseContent = validateReleaseContent({
    configDirectory,
    repositoryRoot,
    ledger,
  });
  await validateQualificationEvidence({
    configDirectory,
    ledger,
    releaseManifest,
    releaseContent,
  });
  validateProductionRouteEvidence({
    configDirectory,
    ledger,
    releaseContent,
    generationSession: null,
  });
  validateAuthorityConsistency({
    catalog,
    inventory,
    ledger,
    policy,
    releaseManifest,
    releaseManifestBytes,
    inventoryBytes,
    selection,
  });
  await validatePrerequisites({
    repositoryRoot,
    qualificationBaseCommit: ledger.release.qualification_base_commit,
    prerequisites: ledger.prerequisites,
  });

  const evidenceStatuses = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const evidence of ledger.evidence) evidenceStatuses[evidence.status] += 1;
  const evidenceById = new Map(
    ledger.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const qualificationEvidenceIsClear = QUALIFICATION_EVIDENCE.every(
    (id) => evidenceById.get(id)?.status === "passed",
  );

  const legalActions = [];
  const launchAuthorityIsClear = LEGACY_LAUNCH_EVIDENCE.every(
    (id) => evidenceById.get(id)?.status === "passed",
  ) &&
    ledger.defects.length === 0 && ledger.exceptions.length === 0 &&
    legacyBaselineAudit.status === "passed" &&
    legacyBaselineAudit.working_tree_clean;
  if (launchAuthorityIsClear) {
    if (selection.implementation.startsWith("legacy-")) {
      legalActions.push("launch_default_legacy");
    }
    if (selection.implementation !== "legacy-agent-flow/v1" &&
        policy.implementations["legacy-agent-flow/v1"]?.launch_enabled) {
      legalActions.push("launch_explicit_legacy_agent_flow");
    }
  }
  if (inventory.baselines.every(({ frozen }) => frozen === true) &&
      evidenceById.get("frozen_legacy_inventory")?.status === "passed" &&
      legacyBaselineAudit.status === "passed") {
    legalActions.push("inspect_frozen_baselines");
  }

  const defects = [...ledger.defects];
  if (legacyBaselineAudit.status !== "passed") {
    defects.push("frozen_legacy_baseline_audit_failed");
  }
  if (!legacyBaselineAudit.working_tree_clean) {
    defects.push("frozen_legacy_worktree_dirty");
  }
  const qualificationClear = defects.length === 0 &&
    ledger.exceptions.length === 0 &&
    qualificationEvidenceIsClear &&
    ledger.prerequisites.every(({ status }) => status === "integrated") &&
    legacyBaselineAudit.status === "passed" &&
    legacyBaselineAudit.working_tree_clean;

  return {
    schema: "flow.transition-projection/v1",
    watermark: {
      sequence: ledger.sequence,
      ledger: digest(ledgerBytes),
      policy: selection.policy_watermark,
      catalog: digest(catalogBytes),
      release_manifest: digest(releaseManifestBytes),
      legacy_inventory: digest(inventoryBytes),
      legacy_baseline_audit: digest(JSON.stringify(legacyBaselineAudit)),
      authority_root: digest(JSON.stringify({
        implementation: selection.implementation,
        specification: selection.authority_root_spec,
        resolved: selection.authority_root,
      })),
    },
    release: ledger.release.id,
    qualification_base_commit: ledger.release.qualification_base_commit,
    environment: ledger.environment,
    contracts: ledger.contracts,
    routes: ledger.routes,
    capability_manifest: projectCapabilityManifest(
      releaseManifest,
      digest(releaseManifestBytes),
    ),
    legacy_inventory_digest: digest(inventoryBytes),
    prerequisites: ledger.prerequisites,
    not_run: ledger.not_run,
    deferred_scope: ledger.deferred_scope,
    environment_fingerprint: ledger.environment_fingerprint,
    dark_opt_in: {
      schema: "flow.dark-opt-in/v1",
      available: qualificationClear,
      scope: releaseManifest.scope,
      not_authorized_before_issue: releaseManifest.not_authorized_before_issue,
      routes: releaseManifest.supported_routes.map(({ flow, mode }) => ({
        flow,
        mode,
      })),
      normal_use_authorized: releaseManifest.normal_use_authorized,
      remote_mutations_authorized: releaseManifest.remote_mutations_authorized,
      sacrificial_followups: ledger.not_run.filter(({ id }) =>
        ["issue-84", "issue-44", "issue-46"].includes(id)),
    },
    selected_implementation: selection.implementation,
    selected_authority_root: selection.authority_root,
    evidence_statuses: evidenceStatuses,
    evidence_digests: Object.fromEntries(ledger.evidence
      .filter(({ sha256 }) => typeof sha256 === "string")
      .map(({ id, sha256 }) => [id, `sha256:${sha256}`])),
    legacy_baseline_audit: legacyBaselineAudit,
    defects,
    exceptions: ledger.exceptions,
    decision: ledger.decision,
    legal_actions: legalActions,
  };
}

export function publicQualificationIsAvailable({
  configDirectory,
  repositoryRoot,
  selection,
  homeDirectory,
  stateDirectory,
}) {
  if (!repositoryRoot) {
    throw new Error("public qualification requires the repository root");
  }
  const configRoot = realpathSync(resolve(configDirectory));
  const ledgerBytes = readFileSync(join(configRoot, "transition-ledger.v1.json"));
  const policyBytes = readFileSync(join(configRoot, "launch-policy.v1.json"));
  const manifestBytes = readFileSync(join(configRoot, "release-manifest.v1.json"));
  const catalogBytes = readFileSync(join(configRoot, "contracts/catalog.v1.json"));
  const inventoryPath = join(configRoot, "legacy-baselines.v1.json");
  const inventoryBytes = readFileSync(inventoryPath);
  const ledger = JSON.parse(ledgerBytes);
  const policy = JSON.parse(policyBytes);
  const releaseManifest = JSON.parse(manifestBytes);
  const catalog = JSON.parse(catalogBytes);
  const inventory = JSON.parse(inventoryBytes);

  validateLedger(ledger);
  validateReleaseManifest(releaseManifest);
  const defaultImplementation = policy.default_implementation;
  const defaultAuthorityRoot = policy.implementations?.[defaultImplementation]
    ?.authority_root;
  const defaultSelection = {
    implementation: defaultImplementation,
    authority_root_spec: defaultAuthorityRoot,
    authority_root: resolveAuthorityRoot(defaultAuthorityRoot, {
      homeDirectory,
      stateDirectory,
    }),
  };
  validateAuthorityConsistency({
    catalog,
    inventory,
    ledger,
    policy,
    releaseManifest,
    releaseManifestBytes: manifestBytes,
    inventoryBytes,
    selection: defaultSelection,
  });
  const evidenceById = new Map(
    ledger.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const phase2Record = evidenceById.get("production_route_conformance");
  const phase2GenerationSession = inheritedProductionRouteConformanceSession();
  const sessionMatchesAuthority = phase2GenerationSession?.authorityDirectory ===
    configRoot;
  if (!LEGACY_LAUNCH_EVIDENCE.every((id) =>
    evidenceById.get(id)?.status === "passed") ||
      !PHASE1_QUALIFICATION_EVIDENCE.every((id) =>
        evidenceById.get(id)?.status === "passed") ||
      (phase2Record?.status !== "passed" &&
       !(sessionMatchesAuthority && phase2Record?.status === "not_run")) ||
      ledger.defects.length !== 0 || ledger.exceptions.length !== 0 ||
      !ledger.prerequisites.every(({ status }) => status === "integrated")) {
    return false;
  }

  validateEvidence(configRoot, ledger.evidence);
  const releaseContent = validateReleaseContent({
    configDirectory: configRoot,
    repositoryRoot,
    ledger,
  });
  validateQualificationEvidence({
    configDirectory: configRoot,
    ledger,
    releaseManifest,
    releaseContent,
  });
  const productionRoutesAreQualified = validateProductionRouteEvidence({
    configDirectory: configRoot,
    ledger,
    releaseContent,
    generationSession: sessionMatchesAuthority ? phase2GenerationSession : null,
  });
  if (!productionRoutesAreQualified) return false;
  validatePrerequisites({
    repositoryRoot,
    qualificationBaseCommit: ledger.release.qualification_base_commit,
    prerequisites: ledger.prerequisites,
  });

  const releaseManifestDigest = digest(manifestBytes);
  const qualificationRecord = evidenceById.get("deterministic_qualification");
  const contentRecord = evidenceById.get("release_content_binding");
  if (selection?.schema !== "flow.launch-selection/v1" ||
      selection.release_id !== releaseManifest.release_id ||
      selection.implementation !== "flow-runtime/v1" ||
      selection.policy_watermark !== digest(policyBytes) ||
      selection.release_manifest?.digest !== releaseManifestDigest ||
      selection.capability_manifest?.digest !== releaseManifestDigest ||
      policy.default_implementation !== "legacy-claude/v1" ||
      ledger.release.id !== releaseManifest.release_id ||
      ledger.release.implementation !== releaseManifest.implementation ||
      ledger.capability_manifest.path !== "release-manifest.v1.json" ||
      ledger.capability_manifest.release_id !== releaseManifest.release_id ||
      ledger.capability_manifest.sha256 !== releaseManifestDigest.slice(7) ||
      ledger.release.content.path !== contentRecord.path ||
      ledger.release.content.sha256 !== contentRecord.sha256 ||
      ledger.release.content.digest !== releaseContent?.content_digest ||
      ledger.legacy_inventory.path !== "legacy-baselines.v1.json" ||
      ledger.legacy_inventory.sha256 !== digest(inventoryBytes).slice(7) ||
      policy.implementations?.["flow-runtime/v1"]?.dark_opt_in?.enabled !== true ||
      policy.implementations["flow-runtime/v1"].dark_opt_in.manifest !==
        "release-manifest.v1.json" ||
      policy.implementations["flow-runtime/v1"].dark_opt_in.manifest_sha256 !==
        releaseManifestDigest.slice(7) ||
      ledger.decision?.dark_opt_in_enabled !== true ||
      ledger.decision?.dark_opt_in_release_id !== releaseManifest.release_id ||
      ledger.decision?.normal_use_authorized !== false ||
      ledger.decision?.remote_mutations_authorized !== false ||
      qualificationRecord.status !== "passed" ||
      inventory.schema !== "flow.legacy-baseline-inventory/v1") {
    return false;
  }

  const legacyBaselineAudit = auditLegacyBaselinesSync({
    repositoryRoot,
    inventoryPath,
  });
  return legacyBaselineAudit.status === "passed" &&
    legacyBaselineAudit.working_tree_clean;
}

function validateLedger(ledger) {
  if (ledger.schema !== "flow.transition-ledger/v1") {
    throw new Error(`unsupported transition ledger: ${ledger.schema ?? "missing"}`);
  }
  if (!isExactSequence(ledger.status_vocabulary, STATUSES)) {
    throw new Error("transition ledger status vocabulary is invalid");
  }
  if (!ledger.release?.id ||
      !/^[0-9a-f]{40}$/u.test(ledger.release.qualification_base_commit ?? "") ||
      ledger.release.implementation !== "flow-runtime/v1" ||
      !ledger.release.content?.path ||
      !/^[0-9a-f]{64}$/u.test(ledger.release.content.sha256 ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(ledger.release.content.digest ?? "") ||
      !ledger.environment?.id ||
      !ledger.environment?.kind || !ledger.environment?.os ||
      !ledger.environment?.architecture || !Number.isInteger(ledger.sequence) ||
      typeof ledger.recorded_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(ledger.recorded_at)) {
    throw new Error("transition ledger identity is incomplete");
  }
  if (!Array.isArray(ledger.evidence) || !Array.isArray(ledger.defects) ||
      !Array.isArray(ledger.exceptions) || !ledger.contracts ||
      !Array.isArray(ledger.routes?.supported) ||
      !ledger.capability_manifest ||
      !ledger.legacy_inventory ||
      !Array.isArray(ledger.prerequisites) ||
      !Array.isArray(ledger.not_run) ||
      !Array.isArray(ledger.deferred_scope) ||
      !ledger.environment_fingerprint) {
    throw new Error(
      "transition ledger evidence, defects, and exceptions must be explicit arrays",
    );
  }
  const catalogEvidence = ledger.evidence.find(({ id }) =>
    id === "public_contract_catalog");
  const productionRouteEvidence = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  if (productionRouteEvidence === undefined ||
      ledger.contracts.production_route_conformance !==
        "flow.production-route-conformance-evidence/v1") {
    throw new Error("transition ledger production qualification binding is incomplete");
  }
  if (catalogEvidence !== undefined &&
      catalogEvidence.recorded_at !== ledger.recorded_at) {
    throw new Error(
      "catalog evidence timestamp must match the transition ledger timestamp",
    );
  }
  const evidenceIdentities = new Set();
  for (const evidence of ledger.evidence) {
    if (typeof evidence.id !== "string" || !evidence.id) {
      throw new Error("invalid transition evidence: missing");
    }
    if (evidenceIdentities.has(evidence.id)) {
      throw new Error(`duplicate transition evidence identity: ${evidence.id}`);
    }
    evidenceIdentities.add(evidence.id);
    if (!STATUSES.includes(evidence.status) || !evidence.recorded_at) {
      throw new Error(`invalid transition evidence: ${evidence.id ?? "missing"}`);
    }
    const requiresEvidence = evidence.status === "passed" || evidence.status === "failed";
    if (requiresEvidence &&
        (!evidence.path || !/^[0-9a-f]{64}$/.test(evidence.sha256))) {
      throw new Error(
        `${evidence.status} transition evidence requires digest-backed bytes: ${evidence.id}`,
      );
    }
    const hasEvidence = evidence.path !== null || evidence.sha256 !== null;
    if (hasEvidence && (!evidence.path || !/^[0-9a-f]{64}$/.test(evidence.sha256))) {
      throw new Error(`transition evidence is incomplete: ${evidence.id}`);
    }
  }
}

function validateEvidence(configDirectory, evidenceRecords) {
  const authorityRoot = realpathSync(resolve(configDirectory));
  for (const evidence of evidenceRecords) {
    if (evidence.path === null) continue;
    let bytes;
    try {
      bytes = readContainedRegularFile(authorityRoot, evidence.path);
    } catch (cause) {
      const message = cause?.code === "ERR_OUTSIDE_AUTHORITY"
        ? `transition evidence is outside the transition configuration root: ${evidence.id}`
        : cause?.code === "ERR_AUTHORITY_SYMLINK"
          ? `transition evidence symlink is forbidden: ${evidence.id}`
          : cause?.code === "ERR_AUTHORITY_NOT_REGULAR"
            ? `transition evidence is not a regular file: ${evidence.id}`
            : `transition evidence is unavailable: ${evidence.id}`;
      throw new Error(message, { cause });
    }
    if (digest(bytes) !== `sha256:${evidence.sha256}`) {
      throw new Error(`transition evidence digest changed: ${evidence.id}`);
    }
  }
}

function validateReleaseContent({ configDirectory, repositoryRoot, ledger }) {
  const contentRecord = ledger.evidence.find(({ id }) =>
    id === "release_content_binding");
  if (contentRecord?.status !== "passed") return null;
  const authorityRoot = realpathSync(resolve(configDirectory));
  let bytes;
  let content;
  try {
    bytes = readContainedRegularFile(authorityRoot, contentRecord.path);
    content = JSON.parse(bytes);
  } catch (cause) {
    throw new Error("release content evidence is unreadable", { cause });
  }
  if (digest(bytes) !== `sha256:${contentRecord.sha256}` ||
      content.schema !== "flow.release-content/v1" ||
      content.release_id !== ledger.release.id ||
      content.git_binding?.schema !== RELEASE_CONTENT_GOVERNANCE.schema ||
      !/^[0-9a-f]{40}$/u.test(content.git_binding?.candidate_tree_sha ?? "") ||
      content.git_binding.qualification_base_commit !==
        ledger.release.qualification_base_commit ||
      !isDeepStrictEqual(content.git_binding.included_paths,
        RELEASE_CONTENT_GOVERNANCE.included_paths) ||
      !isDeepStrictEqual(content.git_binding.excluded_paths,
        RELEASE_CONTENT_GOVERNANCE.excluded_paths) ||
      ledger.release.content.path !== contentRecord.path ||
      ledger.release.content.sha256 !== contentRecord.sha256 ||
      ledger.release.content.digest !== content.content_digest ||
      content.content_digest !== releaseContentDigest(content) ||
      !Array.isArray(content.files)) {
    throw new Error("release content evidence is not bound to the release");
  }

  const baseCommitType = gitText(repositoryRoot, [
    "cat-file",
    "-t",
    `${content.git_binding.qualification_base_commit}^{commit}`,
  ]);
  if (baseCommitType !== "commit") {
    throw new Error("release qualification base commit is unavailable");
  }
  if (!content.files.every((entry) => entry !== null &&
      typeof entry === "object" && !Array.isArray(entry) &&
      typeof entry.path === "string")) {
    throw new Error("release content entry is invalid");
  }
  const filePaths = content.files.map(({ path }) => path);
  const workingPaths = listGovernedWorkingPaths(repositoryRoot);
  const sortedFilePaths = [...filePaths].sort(comparePaths);
  if (!isDeepStrictEqual(filePaths, sortedFilePaths) ||
      new Set(filePaths).size !== filePaths.length ||
      !isDeepStrictEqual(workingPaths, filePaths)) {
    throw new Error("release content governed file listing differs from the working tree");
  }

  for (const entry of content.files) {
    if (typeof entry?.path !== "string" ||
        !isGovernedReleasePath(entry.path) ||
        !["100644", "100755"].includes(entry.mode) ||
        !/^[0-9a-f]{40}$/u.test(entry.git_blob_sha ?? "") ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error("release content entry is invalid");
    }
    let file;
    try {
      file = readGovernedReleaseFile(repositoryRoot, entry.path);
    } catch (cause) {
      throw new Error(`release content entry is unavailable: ${entry.path}`, { cause });
    }
    if (file.mode !== entry.mode || gitBlobSha(file.bytes) !== entry.git_blob_sha ||
        digest(file.bytes) !== `sha256:${entry.sha256}`) {
      throw new Error(`release content digest changed: ${entry.path}`);
    }
  }
  if (deriveGitTreeSha(content.files) !== content.git_binding.candidate_tree_sha) {
    throw new Error("release content candidate tree does not match the governed files");
  }
  return content;
}

function listGovernedWorkingPaths(repositoryRoot) {
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
    { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = nulSeparatedValues(listing)
    .filter((path) => isGovernedReleasePath(path));
  paths.sort(comparePaths);
  return paths;
}

export function readGovernedReleaseFile(repositoryRoot, path) {
  if (!isGovernedReleasePath(path) || path.includes("\\") ||
      path.split("/").some((component) => component === "" ||
        component === "." || component === "..")) {
    throw new Error(`release content path is invalid: ${path}`);
  }
  const authorityRoot = realpathSync(resolve(repositoryRoot));
  const lexicalPath = resolve(authorityRoot, path);
  const relativeLexicalPath = relative(authorityRoot, lexicalPath);
  if (isOutsideAuthority(relativeLexicalPath)) {
    throw new Error(`release content entry is outside authority: ${path}`);
  }
  let current = authorityRoot;
  let finalStats;
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`release content symlink is forbidden: ${path}`);
    }
    if (index === components.length - 1) {
      if (!stats.isFile()) {
        throw new Error(`release content is not a regular file: ${path}`);
      }
      finalStats = stats;
    } else if (!stats.isDirectory()) {
      throw new Error(`release content parent is not a directory: ${path}`);
    }
  }
  const canonicalPath = realpathSync(lexicalPath);
  const relativeCanonicalPath = relative(authorityRoot, canonicalPath);
  if (isOutsideAuthority(relativeCanonicalPath) ||
      !statSync(canonicalPath).isFile()) {
    throw new Error(`release content resolves outside authority: ${path}`);
  }
  return {
    bytes: readFileSync(canonicalPath),
    mode: (finalStats.mode & 0o111) !== 0 ? "100755" : "100644",
  };
}

function readContainedRegularFile(authorityRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 ||
      isAbsolute(relativePath) || relativePath.includes("\\") ||
      relativePath.split(/[\\/]/u).some((component) =>
        component === "" || component === "." || component === "..")) {
    const error = new Error("authority file path is invalid");
    error.code = "ERR_OUTSIDE_AUTHORITY";
    throw error;
  }
  const lexicalPath = resolve(authorityRoot, relativePath);
  if (isOutsideAuthority(relative(authorityRoot, lexicalPath))) {
    const error = new Error("authority file path is outside its root");
    error.code = "ERR_OUTSIDE_AUTHORITY";
    throw error;
  }
  let current = authorityRoot;
  const components = relativePath.split("/");
  let fileStats;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (cause) {
      throw cause;
    }
    if (stats.isSymbolicLink()) {
      const error = new Error("authority file symlink is forbidden");
      error.code = "ERR_AUTHORITY_SYMLINK";
      throw error;
    }
    if (index === components.length - 1) {
      if (!stats.isFile()) {
        const error = new Error("authority evidence is not a regular file");
        error.code = "ERR_AUTHORITY_NOT_REGULAR";
        throw error;
      }
      fileStats = stats;
    } else if (!stats.isDirectory()) {
      const error = new Error("authority evidence parent is not a directory");
      error.code = "ERR_AUTHORITY_NOT_REGULAR";
      throw error;
    }
  }
  const canonicalPath = realpathSync(lexicalPath);
  const relativeCanonicalPath = relative(authorityRoot, canonicalPath);
  if (isOutsideAuthority(relativeCanonicalPath)) {
    const error = new Error("authority file resolves outside its root");
    error.code = "ERR_OUTSIDE_AUTHORITY";
    throw error;
  }
  if (!statSync(canonicalPath).isFile() || fileStats === undefined) {
    const error = new Error("authority evidence is not a regular file");
    error.code = "ERR_AUTHORITY_NOT_REGULAR";
    throw error;
  }
  return readFileSync(canonicalPath);
}

function nulSeparatedValues(bytes) {
  const values = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0) continue;
    const valueBytes = bytes.subarray(start, index);
    start = index + 1;
    if (valueBytes.length === 0) continue;
    const value = valueBytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(valueBytes)) {
      throw new Error("governed working tree path is not valid UTF-8");
    }
    values.push(value);
  }
  return values;
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function gitText(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateQualificationEvidence({
  configDirectory,
  ledger,
  releaseManifest,
  releaseContent,
}) {
  const record = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  if (record?.status !== "passed") return;
  if (record.path === null) {
    throw new Error("deterministic qualification evidence has no receipt path");
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(join(configDirectory, record.path), "utf8"));
  } catch (cause) {
    throw new Error("deterministic qualification evidence is unreadable", { cause });
  }
  const supportedRoutes = releaseManifest.supported_routes.map(({ flow, mode }) => ({
    flow,
    mode,
  }));
  const negativeRoutes = releaseManifest.disabled_routes.map(({ flow, mode, outcome }) => ({
    flow,
    mode,
    outcome,
  }));
  if (evidence.schema !== "flow.transition-qualification-evidence/v1" ||
      evidence.release_id !== ledger.release.id ||
      evidence.qualification_base_commit !==
        ledger.release.qualification_base_commit ||
      evidence.candidate_tree_sha !==
        releaseContent?.git_binding?.candidate_tree_sha ||
      evidence.release_content_digest !== ledger.release.content.digest ||
      evidence.status !== "passed" ||
      evidence.scope !== DETERMINISTIC_QUALIFICATION_SCOPE ||
      !isDeepStrictEqual(
        evidence.assertions,
        DETERMINISTIC_QUALIFICATION_ASSERTIONS,
      ) ||
      !isDeepStrictEqual(evidence.routes?.supported, supportedRoutes) ||
      !isDeepStrictEqual(evidence.routes?.negative_classes, negativeRoutes) ||
      !isDeepStrictEqual(evidence.contracts, [
        "flow.launch-policy/v1",
        "flow.launch-selection/v1",
        "flow.launch-rejection/v1",
        "flow.release-manifest/v1",
        "flow.transition-ledger/v1",
        "flow.transition-projection/v1",
        "flow.production-route-conformance-evidence/v1",
      ]) ||
      !isDeepStrictEqual(evidence.real_scenarios, [
        { id: "issue-84", status: "not_run" },
        { id: "issue-44", status: "not_run" },
        { id: "issue-46", status: "not_run" },
        { id: "quick-spike", status: "not_run" },
      ]) ||
      !qualificationEnvironmentMatches(evidence.environment) ||
      !recipeIsBound(
        configDirectory,
        evidence.recipe,
        "flow.deterministic-qualification-recipe/v1",
        DETERMINISTIC_QUALIFICATION_COMMANDS,
      )) {
    throw new Error("deterministic qualification evidence is not bound to the release");
  }
}

function validateProductionRouteEvidence({
  configDirectory,
  ledger,
  releaseContent,
  generationSession,
}) {
  const record = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  if (record === undefined) {
    throw new Error("production route conformance evidence is missing");
  }
  if (record.path === null && record.status === "not_run") return false;
  if (record.path === null) {
    throw new Error("production route conformance evidence is missing");
  }
  let evidence;
  try {
    const configRoot = realpathSync(resolve(configDirectory));
    evidence = JSON.parse(readContainedRegularFile(configRoot, record.path));
  } catch (cause) {
    throw new Error("production route conformance evidence is unreadable", { cause });
  }
  const phase1Record = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  const configRoot = realpathSync(resolve(configDirectory));
  const generationState = generationSession?.authorityDirectory === configRoot &&
    record.status === "not_run" && evidence.status === "running" &&
    evidence.generation_binding_sha256 ===
      productionRouteConformanceSessionBinding({
        authorityDirectory: generationSession.authorityDirectory,
        generationId: evidence.generation_id,
        marker: generationSession.marker,
      });
  if (evidence.schema !== "flow.production-route-conformance-evidence/v1" ||
      evidence.release_id !== ledger.release.id ||
      evidence.qualification_base_commit !==
        ledger.release.qualification_base_commit ||
      evidence.candidate_tree_sha !==
        releaseContent?.git_binding?.candidate_tree_sha ||
      evidence.release_content_digest !== ledger.release.content.digest ||
      evidence.scope !== PRODUCTION_ROUTE_CONFORMANCE_SCOPE ||
      !isDeepStrictEqual(evidence.routes, PRODUCTION_ROUTE_CONFORMANCE_ROUTES) ||
      !isDeepStrictEqual(evidence.assertions,
        PRODUCTION_ROUTE_CONFORMANCE_ASSERTIONS) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
        evidence.captured_at ?? "") ||
      !qualificationEnvironmentMatches(evidence.environment) ||
      (evidence.status !== record.status && !generationState) ||
      (!generationState && evidence.generation_binding_sha256 !== null) ||
      (evidence.phase1_evidence_sha256 !== null &&
       evidence.phase1_evidence_sha256 !== phase1Record?.sha256)) {
    throw new Error("production route conformance evidence is not bound to the release");
  }
  if (record.status === "not_run" && evidence.status === "not_run") return false;
  if (record.status === "failed" || record.status === "blocked") return false;
  if (generationState) {
    return phase1Record?.status === "passed" &&
      /^[0-9a-f-]{36}$/u.test(evidence.generation_id ?? "") &&
      evidence.generation_binding_sha256 !== null &&
      evidence.recipe === null &&
      evidence.phase1_evidence_sha256 === phase1Record.sha256;
  }
  if (record.status !== "passed" || evidence.status !== "passed" ||
      phase1Record?.status !== "passed" ||
      !/^[0-9a-f]{64}$/u.test(evidence.phase1_evidence_sha256 ?? "") ||
      evidence.generation_id !== null ||
      !recipeIsBound(
        configDirectory,
        evidence.recipe,
        "flow.production-route-conformance-recipe/v1",
        PRODUCTION_ROUTE_CONFORMANCE_COMMANDS,
      )) {
    return false;
  }
  return true;
}

function qualificationEnvironmentMatches(environment) {
  if (qualificationEnvironmentCache === undefined) {
    try {
      qualificationEnvironmentCache = Object.freeze({
        os: process.platform,
        architecture: process.arch,
        node: process.version,
        npm: execFileSync("npm", ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
        git: execFileSync("git", ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().replace(/^git version /u, ""),
      });
    } catch {
      qualificationEnvironmentCache = null;
    }
  }
  return qualificationEnvironmentCache !== null &&
    isDeepStrictEqual(environment, qualificationEnvironmentCache);
}

function recipeIsBound(configDirectory, recipe, recipeSchema, expectedCommands) {
  if (recipe?.schema !== recipeSchema ||
      !/^sha256:[0-9a-f]{64}$/u.test(recipe.digest ?? "") ||
      recipe.digest !== canonicalDigest(recipe.commands) ||
      !Array.isArray(recipe.commands) ||
      recipe.commands.length !== expectedCommands.length) return false;
  const commands = new Map(recipe.commands.map((command) => [command.id, command]));
  if (commands.size !== recipe.commands.length) return false;
  const expected = new Map(expectedCommands.map((entry) =>
    [entry.id, entry]));
  if (commands.size !== expected.size ||
      recipe.commands.length !== expected.size) return false;
  for (const [id, expectedCommand] of expected) {
    const command = commands.get(id);
    if (!(command?.status === "passed" &&
      command.command === expectedCommand.command &&
      command.working_directory === expectedCommand.working_directory &&
      command.receipt_path === expectedCommand.receipt_path &&
      Number.isSafeInteger(command.tests) && command.tests > 0 &&
      command.passed === command.tests &&
      command.exit_code === 0 &&
      command.failed === 0 && command.cancelled === 0 &&
      command.skipped === 0 && command.flaky === 0 &&
      /^[0-9a-f]{64}$/u.test(command.receipt_sha256 ?? ""))) return false;
    const configRoot = realpathSync(resolve(configDirectory));
    let receiptBytes;
    try {
      receiptBytes = readContainedRegularFile(configRoot, command.receipt_path);
    } catch {
      return false;
    }
    if (digest(receiptBytes) !== `sha256:${command.receipt_sha256}` ||
        !receiptMatchesCounts(receiptBytes.toString("utf8"), command)) return false;
  }
  return true;
}

function receiptMatchesCounts(receipt, command) {
  const summary = new Map();
  for (const line of receipt.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (match === null) continue;
    if (summary.has(match[1])) return false;
    summary.set(match[1], Number(match[2]));
  }
  return summary.get("tests") === command.tests &&
    summary.get("pass") === command.passed &&
    summary.get("fail") === command.failed &&
    summary.get("cancelled") === command.cancelled &&
    summary.get("skipped") === command.skipped &&
    (summary.get("todo") ?? 0) === 0 &&
    command.flaky === 0;
}

function isOutsideAuthority(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
}

function validateAuthorityConsistency({
  catalog,
  inventory,
  ledger,
  policy,
  releaseManifest,
  releaseManifestBytes,
  inventoryBytes,
  selection,
}) {
  if (inventory.schema !== "flow.legacy-baseline-inventory/v1") {
    throw new Error("legacy baseline inventory contract is invalid");
  }
  if (ledger.release.source_commit !== inventory.source_commit) {
    throw new Error("transition release differs from the frozen inventory");
  }
  if (ledger.release.id !== releaseManifest.release_id ||
      ledger.release.implementation !== releaseManifest.implementation ||
      ledger.contracts.catalog_path !== "contracts/catalog.v1.json" ||
      ledger.contracts.launch_policy !== "flow.launch-policy/v1" ||
      ledger.contracts.launch_selection !== "flow.launch-selection/v1" ||
      ledger.contracts.launch_rejection !== "flow.launch-rejection/v1" ||
      ledger.contracts.release_manifest !== "flow.release-manifest/v1" ||
      ledger.contracts.transition_projection !== "flow.transition-projection/v1" ||
      ledger.contracts.production_route_conformance !==
        "flow.production-route-conformance-evidence/v1" ||
      ledger.capability_manifest.path !== "release-manifest.v1.json" ||
      ledger.capability_manifest.release_id !== releaseManifest.release_id ||
      ledger.capability_manifest.normal_use_authorized !== false ||
      ledger.capability_manifest.remote_mutations_authorized !== false ||
      ledger.legacy_inventory.path !== "legacy-baselines.v1.json" ||
      ledger.capability_manifest.sha256 !== digest(releaseManifestBytes).slice(7) ||
      ledger.legacy_inventory.sha256 !== digest(inventoryBytes).slice(7) ||
      !isDeepStrictEqual(ledger.routes.supported,
        releaseManifest.supported_routes.map(({ flow, mode }) => ({ flow, mode }))) ||
      ledger.routes.scope_expansion !== releaseManifest.scope_expansion ||
      policy.implementations["flow-runtime/v1"]?.dark_opt_in?.enabled !== true ||
      policy.implementations["flow-runtime/v1"]?.dark_opt_in?.manifest !==
        "release-manifest.v1.json" ||
      policy.implementations["flow-runtime/v1"]?.dark_opt_in?.manifest_sha256 !==
        digest(releaseManifestBytes).slice(7) ||
      ledger.contracts.catalog !== `flow.contract-catalog/v1@${catalog.catalog_version}`) {
    throw new Error("transition release bindings differ from the qualified manifest");
  }
  const baselines = new Map(
    inventory.baselines.map((baseline) => [baseline.implementation, baseline]),
  );
  for (const [implementation, rootName] of [
    ["legacy-claude/v1", "legacy_claude"],
    ["legacy-agent-flow/v1", "legacy_agent_flow"],
  ]) {
    const expectedRoot = catalog.authority_roots[rootName];
    if (!isDeepStrictEqual(baselines.get(implementation)?.authority_root, expectedRoot) ||
        !isDeepStrictEqual(
          policy.implementations[implementation]?.authority_root,
          expectedRoot,
        )) {
      throw new Error(`authority root differs for ${implementation}`);
    }
  }
  if (!isDeepStrictEqual(
    policy.implementations["flow-runtime/v1"]?.authority_root,
    catalog.authority_roots.replacement,
  )) {
    throw new Error("replacement authority root differs from the catalog");
  }
  if (selection.implementation !== policy.default_implementation ||
      selection.implementation !== inventory.baselines[0]?.implementation) {
    throw new Error("legacy default differs across transition authority");
  }
  if (ledger.decision?.selected_implementation !== selection.implementation ||
      ledger.decision?.replacement_launch_enabled !==
        policy.implementations["flow-runtime/v1"]?.launch_enabled) {
    throw new Error("transition decision contradicts the launch policy");
  }
  if (ledger.decision?.dark_opt_in_enabled !== true ||
      ledger.decision?.dark_opt_in_release_id !== releaseManifest.release_id ||
      ledger.decision?.normal_use_authorized !== false ||
      ledger.decision?.remote_mutations_authorized !== false) {
    throw new Error("transition decision contradicts dark qualification authority");
  }
}

function validatePrerequisites({
  repositoryRoot,
  qualificationBaseCommit,
  prerequisites,
}) {
  if (prerequisites.length !== REQUIRED_PREREQUISITES.length ||
      prerequisites.some((prerequisite, index) => {
        const [issue, shortCommit, commit] = REQUIRED_PREREQUISITES[index] ?? [];
        return prerequisite.issue !== issue ||
          prerequisite.short_commit !== shortCommit ||
          prerequisite.commit !== commit ||
          prerequisite.status !== "integrated";
      })) {
    throw new Error("transition prerequisites are incomplete or not integrated");
  }
  for (const prerequisite of prerequisites) {
    try {
      execFileSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          prerequisite.commit,
          qualificationBaseCommit,
        ],
        { cwd: repositoryRoot, stdio: "ignore" },
      );
    } catch (cause) {
      throw new Error(
        `transition prerequisite is not an ancestor: issue ${prerequisite.issue}`,
        { cause },
      );
    }
  }
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
