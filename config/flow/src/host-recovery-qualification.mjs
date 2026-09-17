import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  deriveGitTreeSha,
  isGovernedReleasePath,
  RELEASE_CONTENT_GOVERNANCE,
  releaseContentDigest,
} from "../../../tools/flow/src/release-content-contract.mjs";

export const HOST_RECOVERY_QUALIFICATION_SCHEMA =
  "flow.host-recovery-qualification-evidence/v1";
export const HOST_RECOVERY_RAW_RECEIPT_SCHEMA =
  "flow.host-recovery-raw-receipt/v1";
export const HOST_RECOVERY_CATALOG_SCHEMA =
  "flow.host-recovery-qualification-catalog/v1";
export const HOST_RECOVERY_FAILURE_RECEIPT_SCHEMA =
  "flow.host-recovery-cleanup-failure/v1";

export const HOST_RECOVERY_EXECUTION_KINDS = Object.freeze([
  "live_public_process",
  "native_provider",
  "deterministic_supporting_check",
]);

export const HOST_RECOVERY_SCENARIOS = Object.freeze([
  scenario(
    "concurrent_runs_owner_restart",
    "native_provider",
    [
      "bounded_capacity",
      "client_exit",
      "same_boot_owner_restart",
      "no_duplicate_effect",
    ],
    ["native_concurrency_recovery_probe"],
    {
      proofPredicate: "concurrent_owner_restart",
      requiredObservationKinds: ["capacity", "client_exit", "owner_restart", "effect"],
    },
  ),
  scenario(
    "actionable_failure_recovery",
    "native_provider",
    [
      "typed_failure_observations",
      "one_shot_uncertainty_no_duplicate_effect",
    ],
    ["native_failure_recovery_probe"],
    {
      proofPredicate: "failure_recovery",
      requiredObservationKinds: ["failure", "uncertainty"],
    },
  ),
  scenario(
    "backup_restore_reconciliation",
    "native_provider",
    [
      "production_backup",
      "destructive_loss",
      "restore",
      "six_domain_reconciliation",
      "retained_result_admission",
    ],
    ["native_backup_restore_probe"],
    {
      proofPredicate: "backup_restore_reconciliation",
      requiredObservationKinds: ["backup", "loss", "restore", "reconciliation", "admission"],
    },
  ),
  scenario(
    "ubuntu_headless_text_captures",
    "native_provider",
    [
      "capture_inventory",
      "capture_legibility",
      "capture_provenance",
      "capture_watermark",
      "capture_legal_actions",
    ],
    ["status", "query", "watch", "native_headless_capture_probe"],
    {
      proofPredicate: "headless_capture_inventory",
      requiredObservationKinds: ["capture_inventory"],
      publicCommandKinds: ["status", "query", "watch"],
      requiredCaptureKinds: [
        "terminal",
        "status",
        "checkpoint",
        "candidate",
        "review",
        "graph",
        "timeline",
        "tuicr",
      ],
    },
  ),
  scenario(
    "tuicr_review_after_producer_exit",
    "native_provider",
    [
      "producer_exit_before_review",
      "flowruntime_disposition_and_approval",
      "stale_action_rejection",
      "projection_rebuild_identity",
    ],
    ["native_tuicr_live_probe"],
    {
      proofPredicate: "tuicr_after_producer_exit",
      requiredObservationKinds: ["producer_exit", "disposition", "stale_action", "rebuild"],
    },
  ),
  scenario(
    "drovr_registry_lock_reconciliation",
    "native_provider",
    [
      "killed_lock_owner",
      "lock_reconciliation_or_block",
      "negative_age_takeover",
      "negative_force_takeover",
    ],
    ["native_drovr_lock_probe"],
    {
      proofPredicate: "drovr_lock_reconciliation",
      requiredObservationKinds: ["lock_owner", "reconciliation", "negative_age", "negative_force"],
    },
  ),
  scenario(
    "projection_rebuild_readers",
    "native_provider",
    [
      "query_projection",
      "watch_projection",
      "rebuild_without_mutation_lock",
      "multiple_views",
      "history_latency_samples",
    ],
    ["native_projection_reader_probe"],
    {
      proofPredicate: "projection_rebuild_readers",
      requiredObservationKinds: ["query", "watch", "rebuild", "views", "latency"],
    },
  ),
  scenario(
    "suspended_run_admission",
    "native_provider",
    [
      "suspended_run_observation",
      "explicit_admission",
      "actual_reboot_deferred",
    ],
    ["native_suspended_admission_check"],
    {
      proofPredicate: "suspended_run_admission",
      requiredObservationKinds: ["suspended", "admission", "reboot"],
    },
  ),
]);

export const HOST_RECOVERY_DEFERRED_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "actual_host_reboot",
    issue: "47",
    status: "not_run",
    reason: "actual reboot is deferred to issue 47",
  }),
  Object.freeze({
    id: "expanded_macos_visuals",
    issue: "47",
    status: "not_run",
    reason: "expanded macOS visual matrix is deferred to issue 47",
  }),
]);

const SCENARIO_BY_ID = new Map(HOST_RECOVERY_SCENARIOS.map((item) => [item.id, item]));
const STATUS_VALUES = new Set(["pass", "fail", "blocked", "not_run"]);
const EVIDENCE_STATUS_VALUES = new Set(["passed", "failed", "blocked", "not_run"]);
const PATH_FIELDS = Object.freeze([
  "xdgStateHome",
  "authorityDirectory",
  "socketPath",
  "endpointPath",
  "backupDirectory",
  "repositoryRoot",
  "drovrConfigDirectory",
]);
const SECRET_KEY = /(?:api[_-]?key|authorization|credential|password|secret|private[_-]?key|token)/iu;
const ABSOLUTE_PATH = /(?<![\w.-])(?:\/(?:[^\s"'`\[\]()<>{},;]+\/)*[^\s"'`\[\]()<>{},;]+|[A-Z]:\\[^\s"'`\[\]()<>{},;]+)/gu;
const SECRET_ASSIGNMENT = /\b(?!start_token\b)(?:[\w-]+[_-])?(?:api[_-]?key|password|secret|token)\s*[:=]\s*([^\s,;}]+)/giu;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RUN_ID = /^run:[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SECRET_SHAPE = /(?:(?<![\w-])(?!["']?start_token["']?\s*[:=])["']?(?:api[_-]?key|authorization|credential|password|secret|private[_-]?key|token)["']?\s*[:=]\s*["']?[^\s,"'}]+|(?<![\w-])(?:api[_-]?key|authorization|credential|password|secret|private[_-]?key|token)\s*=\s*[^\s]+)/iu;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TZ",
]);
const COMMAND_TERMINATION_GRACE_MS = 2_000;
const OWNED_RESOURCE_REFS = Object.freeze([
  "isolation/qualification-workspace",
  "isolation/state",
  "isolation/authority",
  "isolation/backup",
  "isolation/repository",
  "isolation/drovr-config",
]);
const ASSERTION_PROOF_KINDS = Object.freeze({
  concurrent_runs_owner_restart: Object.freeze({
    bounded_capacity: ["observation:capacity"],
    client_exit: ["observation:client_exit"],
    same_boot_owner_restart: ["observation:owner_restart"],
    no_duplicate_effect: ["observation:effect"],
  }),
  actionable_failure_recovery: Object.freeze({
    typed_failure_observations: ["observation:failure"],
    one_shot_uncertainty_no_duplicate_effect: ["observation:uncertainty"],
  }),
  backup_restore_reconciliation: Object.freeze({
    production_backup: ["observation:backup"],
    destructive_loss: ["observation:loss"],
    restore: ["observation:restore"],
    six_domain_reconciliation: ["observation:reconciliation"],
    retained_result_admission: ["observation:admission"],
  }),
  tuicr_review_after_producer_exit: Object.freeze({
    producer_exit_before_review: ["observation:producer_exit"],
    flowruntime_disposition_and_approval: ["observation:disposition"],
    stale_action_rejection: ["observation:stale_action"],
    projection_rebuild_identity: ["observation:rebuild"],
  }),
  drovr_registry_lock_reconciliation: Object.freeze({
    killed_lock_owner: ["observation:lock_owner"],
    lock_reconciliation_or_block: ["observation:reconciliation"],
    negative_age_takeover: ["observation:negative_age"],
    negative_force_takeover: ["observation:negative_force"],
  }),
  projection_rebuild_readers: Object.freeze({
    query_projection: ["observation:query"],
    watch_projection: ["observation:watch"],
    rebuild_without_mutation_lock: ["observation:rebuild"],
    multiple_views: ["observation:views"],
    history_latency_samples: ["observation:latency"],
  }),
  suspended_run_admission: Object.freeze({
    suspended_run_observation: ["observation:suspended"],
    explicit_admission: ["observation:admission"],
    actual_reboot_deferred: ["observation:reboot"],
  }),
});
export const HOST_RECOVERY_SCENARIO_IDS = Object.freeze(
  HOST_RECOVERY_SCENARIOS.map(({ id }) => id),
);

export class QualificationConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QualificationConfigurationError";
    this.code = code;
  }
}

export class QualificationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QualificationReceiptError";
    this.code = code;
  }
}

/**
 * Build the explicit isolation contract for one issue-46 run.  This function
 * never consults HOME, XDG defaults, or a shared Drovr/Herdr root.
 */
export function createQualificationIsolation(options = {}) {
  const {
    worktreeRoot,
    herdrSession,
    runId,
    runtimeDirectory = undefined,
    qualificationWorkspace = undefined,
  } = options;
  const pinnedWorktree = absoluteInput(worktreeRoot, "worktreeRoot");
  const paths = Object.fromEntries(PATH_FIELDS.map((field) => [
    field,
    absoluteInput(options[field], field),
  ]));
  const optionalRuntime = runtimeDirectory === undefined
    ? undefined
    : absoluteInput(runtimeDirectory, "runtimeDirectory");
  const workspace = qualificationWorkspace === undefined
    ? join(paths.xdgStateHome, "qualification-workspace")
    : absoluteInput(qualificationWorkspace, "qualificationWorkspace");

  const destructiveRoots = [
    paths.xdgStateHome,
    paths.authorityDirectory,
    paths.backupDirectory,
    paths.repositoryRoot,
    paths.drovrConfigDirectory,
    workspace,
    ...(optionalRuntime === undefined ? [] : [optionalRuntime]),
  ];
  if (destructiveRoots.some((root) =>
      isContained(pinnedWorktree, root) || isContained(root, pinnedWorktree))) {
    throw configurationError(
      "isolation_overlaps_worktree",
      "qualification state, provider, repository, and workspace roots must be outside the pinned worktree",
    );
  }
  if (!isContained(paths.authorityDirectory, paths.socketPath) ||
      !isContained(paths.authorityDirectory, paths.endpointPath)) {
    throw configurationError(
      "owner_endpoint_not_isolated",
      "owner socket and endpoint must be contained by the explicit authority directory",
    );
  }
  for (const [leftName, left] of Object.entries(paths)) {
    for (const [rightName, right] of Object.entries(paths)) {
      if (leftName >= rightName || ["authorityDirectory", "socketPath", "endpointPath"].includes(rightName)) {
        continue;
      }
      if (isContained(left, right) || isContained(right, left)) {
        const allowedAuthorityNesting =
          leftName === "xdgStateHome" && rightName === "authorityDirectory";
        if (!allowedAuthorityNesting) {
          throw configurationError(
            "isolation_roots_overlap",
            `${leftName} and ${rightName} overlap; each mutable root must be unique`,
          );
        }
      }
    }
  }
  if (isContained(paths.backupDirectory, paths.repositoryRoot) ||
      isContained(paths.repositoryRoot, paths.backupDirectory)) {
    throw configurationError(
      "backup_repository_overlap",
      "backup and repository roots must be separate",
    );
  }
  assertNoSymlinkAncestors(pinnedWorktree, "worktreeRoot");
  for (const [name, path] of Object.entries(paths)) {
    assertNoSymlinkAncestors(path, name);
  }
  assertNoSymlinkAncestors(workspace, "qualificationWorkspace");
  if (optionalRuntime !== undefined) assertNoSymlinkAncestors(optionalRuntime, "runtimeDirectory");
  if (typeof herdrSession !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(herdrSession) ||
      ["default", "shared", "current"].includes(herdrSession.toLowerCase())) {
    throw configurationError(
      "herdr_session_not_unique",
      "a unique Herdr session identity is required",
    );
  }
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw configurationError(
      "run_id_not_explicit",
      "an explicit run_id using the run:<unique-id> form is required",
    );
  }
  return Object.freeze({
    worktree_root: pinnedWorktree,
    xdg_state_home: paths.xdgStateHome,
    authority_directory: paths.authorityDirectory,
    socket_path: paths.socketPath,
    endpoint_path: paths.endpointPath,
    backup_directory: paths.backupDirectory,
    repository_root: paths.repositoryRoot,
    drovr_config_directory: paths.drovrConfigDirectory,
    runtime_directory: optionalRuntime ?? null,
    qualification_workspace: workspace,
    herdr_session: herdrSession,
    run_id: runId,
  });
}

/** Return the exact environment overlay consumed by the public launcher. */
export function isolatedQualificationEnvironment(isolation, baseEnvironment = {}) {
  assertIsolationShape(isolation);
  const configDirectory = join(isolation.worktree_root, "config", "flow");
  const privateHome = isolation.qualification_workspace;
  const inherited = Object.fromEntries(
    Object.entries(baseEnvironment)
      .filter(([key, value]) => SAFE_ENVIRONMENT_KEYS.has(key) && typeof value === "string"),
  );
  const environment = {
    ...inherited,
    HOME: privateHome,
    TMPDIR: join(privateHome, "tmp"),
    CODEX_HOME: join(privateHome, "codex"),
    XDG_CONFIG_HOME: join(privateHome, "xdg-config"),
    XDG_CACHE_HOME: join(privateHome, "xdg-cache"),
    XDG_DATA_HOME: join(privateHome, "xdg-data"),
    XDG_STATE_HOME: isolation.xdg_state_home,
    FLOW_AUTHORITY_DIRECTORY: isolation.authority_directory,
    FLOW_OWNER_ENDPOINT_PATH: isolation.endpoint_path,
    FLOW_OWNER_SOCKET_PATH: isolation.socket_path,
    FLOW_SOCKET_PATH: isolation.socket_path,
    FLOW_BACKUP_DIRECTORY: isolation.backup_directory,
    FLOW_REPOSITORY_ROOT: isolation.repository_root,
    DROVR_CONFIG_DIR: isolation.drovr_config_directory,
    DROVR_QUALIFICATION_WORKSPACE: isolation.qualification_workspace,
    HERDR_QUALIFICATION_SESSION: isolation.herdr_session,
    FLOW_CONFIG_DIRECTORY: configDirectory,
    FLOW_QUALIFICATION_REPOSITORY_ROOT: isolation.worktree_root,
  };
  if (isolation.runtime_directory !== null) {
    environment.XDG_RUNTIME_DIR = isolation.runtime_directory;
  }
  return Object.freeze(environment);
}

/** Return the immutable identity used to keep receipts in one isolated run. */
export function qualificationIsolationIdentity(isolation) {
  assertIsolationShape(isolation);
  return canonicalDigest({
    run_id: isolation.run_id,
    xdg_state_home: isolation.xdg_state_home,
    authority_directory: isolation.authority_directory,
    socket_path: isolation.socket_path,
    endpoint_path: isolation.endpoint_path,
    backup_directory: isolation.backup_directory,
    repository_root: isolation.repository_root,
    drovr_config_directory: isolation.drovr_config_directory,
    runtime_directory: isolation.runtime_directory,
    qualification_workspace: isolation.qualification_workspace,
    herdr_session: isolation.herdr_session,
  });
}

/** Keep externally supplied receipts out of the pinned source tree. */
export function assertExternalQualificationRoot(path, { worktreeRoot, label = "rawRoot" } = {}) {
  const root = absoluteInput(path, label);
  const worktree = absoluteInput(worktreeRoot, "worktreeRoot");
  if (isContained(worktree, root) || isContained(root, worktree)) {
    throw new QualificationConfigurationError(
      "raw_root_inside_worktree",
      `${label} must be disjoint from the pinned worktree`,
    );
  }
  assertNoSymlinkAncestors(root, label);
  return root;
}

/**
 * Check an external raw/log/output root against every destructive isolation
 * root. Both ancestor directions are rejected so an external root cannot
 * contain an isolated root or be contained by one.
 */
export function assertQualificationPathDisjoint(path, {
  worktreeRoot,
  isolation = undefined,
  forbiddenRoots = [],
  label = "qualification path",
} = {}) {
  const candidate = absoluteInput(path, label);
  const roots = [absoluteInput(worktreeRoot, "worktreeRoot"), ...forbiddenRoots.map((root) =>
    absoluteInput(root, `${label} forbidden root`))];
  if (isolation !== undefined) {
    assertIsolationShape(isolation);
    roots.push(
      isolation.xdg_state_home,
      isolation.authority_directory,
      isolation.backup_directory,
      isolation.repository_root,
      isolation.drovr_config_directory,
      isolation.qualification_workspace,
      ...(isolation.runtime_directory === null ? [] : [isolation.runtime_directory]),
    );
  }
  if (roots.some((root) => isContained(root, candidate) || isContained(candidate, root))) {
    throw new QualificationConfigurationError(
      "qualification_path_overlap",
      `${label} must be disjoint from the worktree and destructive isolation roots`,
    );
  }
  assertNoSymlinkAncestors(candidate, label);
  return candidate;
}

/** Remove only owned isolated roots and prove each post-cleanup disposition. */
export function cleanupQualificationIsolation(isolation) {
  assertIsolationShape(isolation);
  const resources = [
    ["isolation/qualification-workspace", isolation.qualification_workspace],
    ["isolation/state", isolation.xdg_state_home],
    ["isolation/authority", isolation.authority_directory],
    ["isolation/backup", isolation.backup_directory],
    ["isolation/repository", isolation.repository_root],
    ["isolation/drovr-config", isolation.drovr_config_directory],
    ...(isolation.runtime_directory === null
      ? []
      : [["isolation/runtime", isolation.runtime_directory]]),
  ];
  const ownedResources = resources.map(([identityRef]) => ({
    kind: "isolated_root",
    identity_ref: identityRef,
  }));
  const resourceDispositions = [];
  const unresolvedObligations = [];
  for (const [identityRef, path] of resources) {
    const disposition = { kind: "isolated_root", identity_ref: identityRef };
    try {
      if (isContained(isolation.worktree_root, path)) {
        throw new Error("owned cleanup root overlaps pinned worktree");
      }
      assertNoSymlinkAncestors(path, `${identityRef} cleanup root`);
      if (existsSync(path)) {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error("owned cleanup root is not a real directory");
        }
        rmSync(path, { recursive: true, force: false });
      }
      if (existsSync(path)) throw new Error("owned cleanup root remains after removal");
      disposition.disposition = "removed";
      disposition.proof = "absent_after_cleanup";
    } catch (error) {
      disposition.disposition = "cleanup_blocked";
      disposition.proof = "presence_or_removal_unverified";
      unresolvedObligations.push({
        code: "cleanup_unverified",
        identity_ref: identityRef,
        detail: error.message,
      });
    }
    resourceDispositions.push(disposition);
  }
  return {
    disposition: unresolvedObligations.length === 0 ? "complete" : "blocked",
    owned_resources: ownedResources,
    resource_dispositions: resourceDispositions,
    unresolved_obligations: unresolvedObligations,
    completed_at: utcNow(),
  };
}

/**
 * Resolve and hash only source files inside the pinned worktree.  The Node
 * runtime is recorded separately because it is a host tool, not release code.
 */
export function resolvePinnedEntrypoints({
  worktreeRoot,
  launcherPath = join(worktreeRoot ?? "", "config/flow/src/cli.mjs"),
  hostPath = join(worktreeRoot ?? "", "config/flow/src/owner-process.mjs"),
  drovrPath = join(worktreeRoot ?? "", "tools/drovr/src/cli.mjs"),
} = {}) {
  const root = absoluteInput(worktreeRoot, "worktreeRoot");
  return Object.freeze({
    worktree_root: root,
    launcher: pinnedFileIdentity(root, launcherPath, "launcher"),
    host: pinnedFileIdentity(root, hostPath, "host"),
    drovr: pinnedFileIdentity(root, drovrPath, "drovr"),
    node: Object.freeze({
      path: resolve(process.execPath),
      version: process.version,
      sha256: sha256(readFileSync(process.execPath)),
      outside_worktree_allowed: true,
    }),
  });
}

/** Return the exact host-tool identities accepted for a pinned worktree. */
export function resolvePinnedQualificationTools({
  worktreeRoot = undefined,
  entrypoints = undefined,
} = {}) {
  const pinned = entrypoints ?? resolvePinnedEntrypoints({ worktreeRoot });
  return Object.freeze({
    node: Object.freeze({
      path_ref: "runtime/node",
      version: pinned.node.version,
      sha256: pinned.node.sha256,
    }),
    flow_launcher: Object.freeze({
      path_ref: pinned.launcher.path_ref,
      version: "flow-runtime/v1",
      sha256: pinned.launcher.sha256,
    }),
    flow_host: Object.freeze({
      path_ref: pinned.host.path_ref,
      version: "flow-runtime/v1",
      sha256: pinned.host.sha256,
    }),
    drovr: Object.freeze({
      path_ref: pinned.drovr.path_ref,
      version: observePinnedExecutableVersion(pinned.drovr.path, pinned.node.path),
      sha256: pinned.drovr.sha256,
    }),
  });
}

/** Return the host identity observed by qualification commands and receipts. */
export function qualificationHostIdentity() {
  return {
    os: platform(),
    architecture: arch(),
    node: process.version,
    npm: qualificationNpmVersion(),
    git: qualificationCommandVersion("git", ["--version"]).replace(/^git version /u, ""),
  };
}

/**
 * Derive the exact release identity from the pinned worktree without trusting
 * a receipt-provided candidate or content digest.
 */
export function derivePinnedReleaseIdentity({ worktreeRoot, gitCommand = "git" } = {}) {
  const root = absoluteInput(worktreeRoot, "worktreeRoot");
  assertNoSymlinkAncestors(root, "worktreeRoot");
  const manifestPath = securePinnedFile(root, join(root, "config/flow/release-manifest.v1.json"), "release manifest");
  const contentPath = securePinnedFile(root, join(root, "config/flow/evidence/release-content.v1.json"), "release content");
  let manifest;
  let content;
  const contentBytes = readFileSync(contentPath);
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    content = JSON.parse(contentBytes.toString("utf8"));
  } catch (error) {
    throw new QualificationReceiptError("release_identity_unavailable", error.message);
  }
  if (!isRecord(manifest) || typeof manifest.release_id !== "string" ||
      typeof manifest.implementation !== "string" ||
      content?.schema !== "flow.release-content/v1" ||
      content.release_id !== manifest.release_id ||
      content.content_digest !== releaseContentDigest(content) ||
      !sameGovernance(content.git_binding) ||
      deriveGitTreeSha(content.files) !== content.git_binding?.candidate_tree_sha) {
    throw new QualificationReceiptError(
      "release_identity_unverified",
      "pinned worktree release manifest/content binding is not internally consistent",
    );
  }
  let pinnedGitTreeSha;
  try {
    pinnedGitTreeSha = execFileSync(
      gitCommand,
      ["-C", root, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
  } catch (error) {
    throw new QualificationReceiptError(
      "release_git_tree_unavailable",
      `pinned worktree Git tree is unavailable: ${error.message}`,
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(pinnedGitTreeSha)) {
    throw new QualificationReceiptError("release_git_tree_invalid", "pinned Git tree identity is invalid");
  }
  const actualFiles = readCurrentGovernedReleaseFiles(root, gitCommand);
  if (!sameReleaseFiles(content.files, actualFiles) ||
      deriveGitTreeSha(actualFiles) !== content.git_binding.candidate_tree_sha) {
    throw new QualificationReceiptError(
      "release_candidate_dirty",
      "pinned worktree governed release files do not match the declared candidate tree",
    );
  }
  return Object.freeze({
    release_id: manifest.release_id,
    implementation: manifest.implementation,
    candidate_tree_sha: content.git_binding.candidate_tree_sha,
    release_content_digest: content.content_digest,
    pinned_git_tree_sha: pinnedGitTreeSha,
    release_content_bytes_sha256: sha256(contentBytes),
  });
}

function sameGovernance(binding) {
  return isRecord(binding) &&
    binding.schema === RELEASE_CONTENT_GOVERNANCE.schema &&
    JSON.stringify(binding.included_paths) === JSON.stringify(RELEASE_CONTENT_GOVERNANCE.included_paths) &&
    JSON.stringify(binding.excluded_paths) === JSON.stringify(RELEASE_CONTENT_GOVERNANCE.excluded_paths);
}

function readCurrentGovernedReleaseFiles(root, gitCommand) {
  let listing;
  try {
    listing = execFileSync(
      gitCommand,
      [
        "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name",
        ...RELEASE_CONTENT_GOVERNANCE.excluded_paths.map((path) =>
          `--exclude=${path.endsWith("/") ? `${path}**` : path}`),
        "--",
        ...RELEASE_CONTENT_GOVERNANCE.included_paths,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new QualificationReceiptError(
      "release_candidate_unavailable",
      `current governed release files are unavailable: ${error.message}`,
    );
  }
  const paths = listing.toString("utf8").split("\0").filter(Boolean)
    .filter((path) => isGovernedReleasePath(path));
  const files = paths.map((path) => {
    const candidate = securePinnedFile(root, join(root, path), `release content file ${path}`);
    const bytes = readFileSync(candidate);
    let mode;
    try {
      mode = (lstatSync(candidate).mode & 0o111) !== 0 ? "100755" : "100644";
    } catch (error) {
      throw new QualificationReceiptError("release_candidate_unavailable", error.message);
    }
    const blobHeader = Buffer.from(`blob ${bytes.length}\0`);
    return {
      path,
      mode,
      git_blob_sha: createHash("sha1").update(blobHeader).update(bytes).digest("hex"),
      sha256: sha256(bytes),
    };
  });
  return files.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
}

function sameReleaseFiles(expected, actual) {
  if (!Array.isArray(expected) || expected.length !== actual.length) return false;
  return expected.every((entry, index) => {
    const candidate = actual[index];
    return candidate !== undefined &&
      entry.path === candidate.path &&
      entry.mode === candidate.mode &&
      entry.git_blob_sha === candidate.git_blob_sha &&
      entry.sha256 === candidate.sha256;
  });
}

/** Redact paths and credential-shaped values before evidence persistence. */
export function redactQualificationCapture(value, {
  pathMappings = {},
} = {}) {
  const mappings = Object.entries(pathMappings)
    .filter(([, path]) => typeof path === "string" && isAbsolute(path))
    .sort(([, left], [, right]) => right.length - left.length);
  return redactValue(value, [], mappings);
}

/**
 * Invoke the exact pinned public CLI launcher.  No shell lookup is performed;
 * the launcher source, host source, command, timing, and log hashes are all
 * retained in the external receipt.
 */
export function runPinnedPublicCommand({
  entrypoints,
  isolation,
  args,
  logDirectory,
  env = undefined,
  cwd = undefined,
  timeoutMs = 120_000,
  spawnFunction = spawn,
  signal = undefined,
} = {}) {
  assertIsolationShape(isolation);
  assertEntrypointsShape(entrypoints);
  if (!Array.isArray(args) || args.length === 0 ||
      args.some((arg) => typeof arg !== "string")) {
    throw new QualificationConfigurationError(
      "command_arguments_invalid",
      "public command arguments must be a non-empty string array",
    );
  }
  const logs = absoluteInput(logDirectory, "logDirectory");
  assertQualificationPathDisjoint(logs, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "logDirectory",
  });
  assertNoSymlinkAncestors(logs, "logDirectory");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const commandId = `${args[0]}-${randomUUID()}`;
  const startedAt = utcNow();
  const stdoutPath = join(logs, `${commandId}.stdout.log`);
  const stderrPath = join(logs, `${commandId}.stderr.log`);
  const childEnvironment = isolatedQualificationEnvironment(
    isolation,
    env ?? process.env,
  );
  const workingDirectory = cwd === undefined
    ? isolation.worktree_root
    : absoluteInput(cwd, "cwd");
  if (!isContained(isolation.worktree_root, workingDirectory) &&
      resolve(workingDirectory) !== resolve(isolation.repository_root)) {
    throw new QualificationConfigurationError(
      "command_cwd_outside_isolation",
      "public command cwd must be the pinned worktree or isolated repository",
    );
  }
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let terminationTimer;
    const child = spawnFunction(
      entrypoints.node.path,
      [entrypoints.launcher.path, ...args],
      {
        cwd: workingDirectory,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const clearTermination = () => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (signal !== undefined) signal.removeEventListener?.("abort", terminate);
    };
    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close/error event below remains the source of truth.
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The bounded close wait is enforced by the caller's abort grace.
        }
      }, COMMAND_TERMINATION_GRACE_MS);
    };
    const timer = setTimeout(terminate, Math.max(1, timeoutMs));
    if (signal !== undefined) {
      if (signal.aborted) terminate();
      else signal.addEventListener("abort", terminate, { once: true });
    }
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      if (terminating) return;
      settled = true;
      clearTermination();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTermination();
      try {
        const pathMappings = {
          worktree: isolation.worktree_root,
          state: isolation.xdg_state_home,
          authority: isolation.authority_directory,
          backup: isolation.backup_directory,
          repository: isolation.repository_root,
          drovr: isolation.drovr_config_directory,
        };
        const persistedStdout = redactQualificationCapture(stdout, { pathMappings });
        const persistedStderr = redactQualificationCapture(stderr, { pathMappings });
        writePrivateLog(stdoutPath, persistedStdout);
        writePrivateLog(stderrPath, persistedStderr);
        const finishedAt = utcNow();
        resolvePromise({
          id: commandId,
          argv: ["node", relative(isolation.worktree_root, entrypoints.launcher.path),
            ...args.map((arg) => redactQualificationCapture(arg, { pathMappings }))],
          command_kind: args[0],
          launcher_ref: relative(isolation.worktree_root, entrypoints.launcher.path),
          host_ref: relative(isolation.worktree_root, entrypoints.host.path),
          working_directory_ref: pathReference(workingDirectory, isolation),
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
          exit_code: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          expected_exit_code: 0,
          expected_signal: null,
          expected_timed_out: false,
          timed_out: timedOut,
          logs: {
            stdout: logDescriptor(stdoutPath, persistedStdout),
            stderr: logDescriptor(stderrPath, persistedStderr),
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Persist one raw receipt with exclusive, idempotent write semantics. */
export function writeRawQualificationReceipt(path, receipt, { rawRoot } = {}) {
  const root = absoluteInput(rawRoot, "rawRoot");
  ensureRawRoot(root);
  const destination = containedPath(root, path, "raw receipt path", { allowAbsolute: true });
  validateRawQualificationReceipt(receipt, { rawRoot: root });
  if (receipt.result.disposition === "pass" && receipt.execution_kind !== "deterministic_supporting_check") {
    validateScenarioPass(receipt, SCENARIO_BY_ID.get(receipt.scenario_id), {
      validatedEvidenceIds: validateExternalEvidenceFiles(receipt, root),
    });
  }
  const bytes = jsonBytes(receipt);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(destination, "raw receipt path");
  if (existsSync(destination)) {
    assertRegularFile(destination, "raw receipt path");
    const existing = readFileSync(destination);
    if (!existing.equals(bytes)) {
      throw new QualificationReceiptError(
        "raw_receipt_immutable_conflict",
        `raw receipt already exists with different bytes: ${path}`,
      );
    }
    return { path: relative(root, destination), sha256: sha256(existing) };
  }
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  return { path: relative(root, destination), sha256: sha256(bytes) };
}

/** Retain cleanup proof when execution fails after isolated ownership begins. */
export function writeQualificationFailureCleanupReceipt(path, {
  runId,
  scenarioId = null,
  isolation,
  cleanup,
  error,
  startedAt,
  finishedAt,
}, { rawRoot } = {}) {
  const root = absoluteInput(rawRoot, "rawRoot");
  ensureRawRoot(root);
  assertIsolationShape(isolation);
  if (typeof runId !== "string" || runId !== isolation.run_id || !RUN_ID.test(runId)) {
    throw new QualificationReceiptError("run_id_invalid", "failure cleanup receipt requires the isolated run_id");
  }
  validateCleanup(cleanup);
  const destination = containedPath(root, path, "failure cleanup receipt path", { allowAbsolute: true });
  const mappings = {
    worktree: isolation.worktree_root,
    state: isolation.xdg_state_home,
    authority: isolation.authority_directory,
    backup: isolation.backup_directory,
    repository: isolation.repository_root,
    drovr: isolation.drovr_config_directory,
  };
  const receipt = {
    schema: HOST_RECOVERY_FAILURE_RECEIPT_SCHEMA,
    version: 1,
    issue: 46,
    run_id: runId,
    scenario_id: scenarioId,
    isolation_identity: qualificationIsolationIdentity(isolation),
    cleanup: structuredClone(cleanup),
    error: redactQualificationCapture({
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    }, { pathMappings: mappings }),
    started_at: startedAt,
    finished_at: finishedAt,
  };
  rejectSecretShapedValue(receipt, "failure cleanup receipt");
  const bytes = jsonBytes(receipt);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(destination, "failure cleanup receipt path");
  if (existsSync(destination)) {
    assertRegularFile(destination, "failure cleanup receipt path");
    const existing = readFileSync(destination);
    if (!existing.equals(bytes)) {
      throw new QualificationReceiptError(
        "failure_receipt_immutable_conflict",
        `failure cleanup receipt already exists with different bytes: ${path}`,
      );
    }
    return { path: relative(root, destination), sha256: sha256(existing) };
  }
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  return { path: relative(root, destination), sha256: sha256(bytes) };
}

/** Read, hash, and validate an external raw receipt and all referenced logs. */
export function readRawQualificationReceipt(path, { rawRoot } = {}) {
  const root = absoluteInput(rawRoot, "rawRoot");
  ensureRawRoot(root);
  const receiptPath = secureRawFile(root, path, "raw receipt path", { allowAbsolute: true });
  const bytes = readFileSync(receiptPath);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new QualificationReceiptError("raw_receipt_invalid_json", error.message);
  }
  validateRawQualificationReceipt(receipt, { rawRoot: root });
  const validatedEvidenceIds = validateExternalEvidenceFiles(receipt, root);
  if (receipt.result.disposition === "pass" && receipt.execution_kind !== "deterministic_supporting_check") {
    validateScenarioPass(receipt, SCENARIO_BY_ID.get(receipt.scenario_id), { validatedEvidenceIds });
  }
  return Object.freeze({
    ...receipt,
    receipt_sha256: sha256(bytes),
    receipt_path: relative(root, receiptPath),
  });
}

function validateExternalEvidenceFiles(receipt, root) {
  const validated = new Set();
  for (const command of receipt.commands) {
    let hasLog = false;
    for (const stream of ["stdout", "stderr"]) {
      const log = command.logs[stream];
      if (log.path === null) continue;
      hasLog = true;
      const logPath = secureRawFile(root, log.path, `${stream} log path`);
      const logBytes = readFileSync(logPath);
      rejectSecretShapedBytes(logBytes, `${stream} log`);
      if (log.bytes !== logBytes.length || log.sha256 !== sha256(logBytes)) {
        throw new QualificationReceiptError(
          "log_digest_mismatch",
          `${stream} log does not match its recorded bytes or digest`,
        );
      }
    }
    if (hasLog) {
      validated.add(command.id);
      validated.add(`command:${command.id}`);
    }
  }
  for (const capture of receipt.captures) {
    const capturePath = secureRawFile(root, capture.path, "capture path");
    const captureBytes = readFileSync(capturePath);
    rejectSecretShapedBytes(captureBytes, "capture");
    if (capture.sha256 !== sha256(captureBytes)) {
      throw new QualificationReceiptError(
        "capture_digest_mismatch",
        `capture does not match its recorded digest: ${capture.path}`,
      );
    }
    validated.add(capture.id);
    validated.add(`capture:${capture.id}`);
  }
  for (const observation of receipt.observations) {
    validated.add(observation.id);
    validated.add(`observation:${observation.id}`);
  }
  return validated;
}

/**
 * Aggregate immutable external receipts into the tracked issue-46 evidence
 * document. Missing live receipts remain blocked; deterministic supporting
 * checks never satisfy a live scenario.
 */
export function generateHostRecoveryEvidence({
  worktreeRoot,
  rawRoot,
  receiptPaths,
  outputPath,
  expectedRelease = undefined,
  catalog = HOST_RECOVERY_SCENARIOS,
  allowExternalOutput = false,
} = {}) {
  validateHostRecoveryCatalog(catalog);
  const worktree = absoluteInput(worktreeRoot, "worktreeRoot");
  const root = assertExternalQualificationRoot(rawRoot, { worktreeRoot: worktree });
  const output = absoluteInput(outputPath, "outputPath");
  assertEvidenceOutputPath(worktree, output, {
    allowExternal: allowExternalOutput,
    forbiddenRoots: [root],
  });
  if (!Array.isArray(receiptPaths) || receiptPaths.length === 0) {
    throw new QualificationReceiptError(
      "raw_receipts_missing",
      "at least one external raw receipt is required",
    );
  }
  const receipts = receiptPaths.map((path) => readRawQualificationReceipt(path, { rawRoot: root }));
  const seen = new Set();
  for (const receipt of receipts) {
    if (seen.has(receipt.scenario_id)) {
      throw new QualificationReceiptError(
        "duplicate_scenario_receipt",
        `duplicate raw receipt for scenario ${receipt.scenario_id}`,
      );
    }
    seen.add(receipt.scenario_id);
  }
  const first = receipts[0];
  for (const receipt of receipts.slice(1)) {
    if (receipt.run_id !== first.run_id) {
      throw new QualificationReceiptError(
        "run_identity_mismatch",
        "raw receipts are not bound to one explicit run_id",
      );
    }
    if (!sameIdentity(first.isolation, receipt.isolation)) {
      throw new QualificationReceiptError(
        "isolation_identity_mismatch",
        "raw receipts are not bound to one byte-identical isolation identity",
      );
    }
    if (!sameRelease(first.release, receipt.release)) {
      throw new QualificationReceiptError(
        "release_identity_mismatch",
        "raw receipts are not bound to one exact release identity",
      );
    }
    if (!sameIdentity(first.host, receipt.host) || !sameIdentity(first.tools, receipt.tools)) {
      throw new QualificationReceiptError(
        "host_identity_mismatch",
        "raw receipts are not bound to one exact host/tool identity",
      );
    }
  }
  const release = expectedRelease ?? derivePinnedReleaseIdentity({ worktreeRoot: worktree });
  if (!sameRelease(first.release, release)) {
    throw new QualificationReceiptError(
      "release_identity_mismatch",
      "release identity mismatch: raw receipt differs from the pinned worktree release",
    );
  }
  if (expectedRelease !== undefined &&
      (!sameRelease(first.release, expectedRelease) ||
       expectedRelease.implementation !== first.release.implementation)) {
    throw new QualificationReceiptError(
      "release_identity_mismatch",
      "release identity mismatch: raw receipt differs from the expected release",
    );
  }
  const expectedTools = resolvePinnedQualificationTools({ worktreeRoot: worktree });
  const expectedHost = qualificationHostIdentity();
  for (const receipt of receipts) {
    validateReceiptToolIdentity(receipt.tools, expectedTools);
    if (JSON.stringify(receipt.host) !== JSON.stringify(expectedHost)) {
      throw new QualificationReceiptError(
        "host_identity_mismatch",
        "raw receipt host identity does not match the current qualification host",
      );
    }
  }
  const scenarioDefinitions = new Map(catalog.map((scenarioDefinition) => [
    scenarioDefinition.id,
    scenarioDefinition,
  ]));
  for (const receipt of receipts) {
    if (receipt.execution_kind === "deterministic_supporting_check") continue;
    const definition = scenarioDefinitions.get(receipt.scenario_id);
    if (!definition) {
      throw new QualificationReceiptError(
        "unknown_scenario",
        `raw receipt names an unknown issue-46 scenario: ${receipt.scenario_id}`,
      );
    }
    if (receipt.execution_kind !== definition.execution_kind) {
      throw new QualificationReceiptError(
        "execution_kind_mismatch",
        `raw receipt execution kind does not match ${receipt.scenario_id}`,
      );
    }
  }
  const scenarioEvidence = catalog.map((definition) => {
    const receipt = receipts.find(({ scenario_id: id }) => id === definition.id);
    if (!receipt) return blockedScenario(definition, "missing_external_receipt");
    return scenarioProjection(receipt);
  });
  const supportReceipts = receipts
    .filter(({ execution_kind }) => execution_kind === "deterministic_supporting_check")
    .map(supportingProjection);
  const status = aggregateEvidenceStatus(scenarioEvidence);
  const startedAt = receipts.map(({ started_at }) => started_at).sort()[0] ?? utcNow();
  const finishedAt = receipts.map(({ finished_at }) => finished_at).sort().at(-1) ?? startedAt;
  const evidenceWithoutDigest = {
    schema: HOST_RECOVERY_QUALIFICATION_SCHEMA,
    version: 1,
    issue: 46,
    run_id: first.run_id,
    status,
    scope: "first_release_host_recovery_and_local_rendering",
    release: structuredClone(release),
    host: structuredClone(first.host),
    tools: structuredClone(first.tools),
    isolation: structuredClone(first.isolation),
    scenarios: scenarioEvidence,
    supporting_checks: supportReceipts,
    deferred: HOST_RECOVERY_DEFERRED_SCENARIOS.map((item) => ({ ...item })),
    source_receipts: receipts.map(({ receipt_path, receipt_sha256 }) => ({
      path: receipt_path,
      sha256: receipt_sha256,
    })),
    captured_at: startedAt,
    finished_at: finishedAt,
    evidence_digest: null,
  };
  const evidence = {
    ...evidenceWithoutDigest,
    evidence_digest: canonicalDigest(evidenceWithoutDigest),
  };
  validateHostRecoveryEvidence(evidence);
  const bytes = jsonBytes(evidence);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (existsSync(output)) {
    const existing = readFileSync(output);
    let existingEvidence;
    try {
      existingEvidence = JSON.parse(existing.toString("utf8"));
    } catch (error) {
      throw new QualificationReceiptError(
        "tracked_evidence_invalid",
        `existing issue-46 evidence is not valid JSON: ${error.message}`,
      );
    }
    validateHostRecoveryEvidence(existingEvidence);
    if (!existing.equals(bytes)) {
      throw new QualificationReceiptError(
        "tracked_evidence_immutable_conflict",
        "tracked issue-46 evidence already exists with different bytes",
      );
    }
  } else {
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(output, 0o600);
  }
  return Object.freeze(evidence);
}

/** Validate generated evidence and recompute its digest before any persistence. */
export function validateHostRecoveryEvidence(evidence) {
  assertExactKeys(evidence, [
    "schema", "version", "issue", "run_id", "status", "scope", "release", "host",
    "tools", "isolation", "scenarios", "supporting_checks", "deferred", "source_receipts",
    "captured_at", "finished_at", "evidence_digest",
  ], "aggregate evidence");
  if (evidence.schema !== HOST_RECOVERY_QUALIFICATION_SCHEMA || evidence.version !== 1 ||
      evidence.issue !== 46 || !RUN_ID.test(evidence.run_id) ||
      !EVIDENCE_STATUS_VALUES.has(evidence.status) ||
      evidence.scope !== "first_release_host_recovery_and_local_rendering" ||
      !RFC3339_UTC.test(evidence.captured_at) || !RFC3339_UTC.test(evidence.finished_at) ||
      Date.parse(evidence.finished_at) < Date.parse(evidence.captured_at)) {
    throw new QualificationReceiptError("evidence_schema_invalid", "aggregate evidence identity or timing is invalid");
  }
  validateRelease(evidence.release);
  validateHost(evidence.host);
  validateTools(evidence.tools);
  validateIsolationReference(evidence.isolation, evidence.run_id);
  validateHostRecoveryCatalog(HOST_RECOVERY_SCENARIOS);
  if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length !== HOST_RECOVERY_SCENARIOS.length) {
    throw new QualificationReceiptError("evidence_catalog_invalid", "aggregate evidence must contain exactly eight scenarios");
  }
  const scenarioIds = new Set();
  for (const [index, scenarioEvidence] of evidence.scenarios.entries()) {
    const definition = HOST_RECOVERY_SCENARIOS[index];
    assertExactKeys(scenarioEvidence, [
      "id", "execution_kind", "proof_predicate", "required_command_kinds",
      "required_observation_kinds", "required_capture_kinds", "status", "started_at", "finished_at",
      "commands", "observations", "captures", "assertions", "retained_obligations", "cleanup", "reason",
    ], `scenario ${definition.id}`);
    if (scenarioEvidence.id !== definition.id || scenarioIds.has(scenarioEvidence.id) ||
        scenarioEvidence.execution_kind !== definition.execution_kind ||
        scenarioEvidence.proof_predicate !== definition.proof_predicate ||
        JSON.stringify(scenarioEvidence.required_command_kinds) !== JSON.stringify(definition.required_command_kinds) ||
        JSON.stringify(scenarioEvidence.required_observation_kinds) !== JSON.stringify(definition.required_observation_kinds) ||
        JSON.stringify(scenarioEvidence.required_capture_kinds) !== JSON.stringify(definition.required_capture_kinds) ||
        !EVIDENCE_STATUS_VALUES.has(scenarioEvidence.status)) {
      throw new QualificationReceiptError("evidence_scenario_invalid", `aggregate scenario ${definition.id} is invalid`);
    }
    scenarioIds.add(scenarioEvidence.id);
    if ((scenarioEvidence.started_at !== null && !RFC3339_UTC.test(scenarioEvidence.started_at)) ||
        (scenarioEvidence.finished_at !== null && !RFC3339_UTC.test(scenarioEvidence.finished_at))) {
      throw new QualificationReceiptError("evidence_timing_invalid", `aggregate scenario ${definition.id} has invalid timing`);
    }
    if (!Array.isArray(scenarioEvidence.commands) || !Array.isArray(scenarioEvidence.observations) ||
        !Array.isArray(scenarioEvidence.captures) || !Array.isArray(scenarioEvidence.assertions) ||
        !Array.isArray(scenarioEvidence.retained_obligations) || !isRecord(scenarioEvidence.cleanup)) {
      throw new QualificationReceiptError("evidence_scenario_invalid", `aggregate scenario ${definition.id} has invalid arrays`);
    }
    for (const command of scenarioEvidence.commands) validateInvocation(command, { rawRoot: "evidence" });
    for (const observation of scenarioEvidence.observations) validateObservation(observation);
    for (const capture of scenarioEvidence.captures) validateCapture(capture, { rawRoot: "evidence" });
    for (const assertion of scenarioEvidence.assertions) validateEvidenceAssertion(assertion);
    validateCleanup(scenarioEvidence.cleanup);
    if (scenarioEvidence.status === "passed") {
      if (scenarioEvidence.commands.length === 0 || scenarioEvidence.captures.length === 0 ||
          scenarioEvidence.cleanup.disposition !== "complete" ||
          scenarioEvidence.cleanup.unresolved_obligations.length > 0 ||
          scenarioEvidence.cleanup.completed_at === null ||
          scenarioEvidence.assertions.some(({ disposition, evidence_refs }) =>
            disposition !== "pass" || evidence_refs.length === 0)) {
        throw new QualificationReceiptError("evidence_pass_invalid", `aggregate scenario ${definition.id} has incomplete pass proof`);
      }
      validateRetentionEvidence(scenarioEvidence.cleanup, scenarioEvidence.retained_obligations);
      const ids = new Set([
        ...scenarioEvidence.commands.map(({ id }) => id),
        ...scenarioEvidence.captures.map(({ id }) => id),
        ...scenarioEvidence.observations.map(({ id }) => id),
        ...scenarioEvidence.commands.map(({ id }) => `command:${id}`),
        ...scenarioEvidence.captures.map(({ id }) => `capture:${id}`),
        ...scenarioEvidence.observations.map(({ id }) => `observation:${id}`),
      ]);
      for (const assertion of scenarioEvidence.assertions) {
        for (const reference of assertion.evidence_refs) {
          if (!ids.has(reference)) {
            throw new QualificationReceiptError("evidence_reference_unresolved", `aggregate evidence reference is unresolved: ${reference}`);
          }
        }
      }
    }
  }
  if (!Array.isArray(evidence.supporting_checks) || !Array.isArray(evidence.deferred) ||
      !Array.isArray(evidence.source_receipts) || evidence.source_receipts.length === 0) {
    throw new QualificationReceiptError("evidence_sources_invalid", "aggregate evidence source arrays are invalid");
  }
  for (const support of evidence.supporting_checks) {
    assertExactKeys(support, ["id", "execution_kind", "status", "started_at", "finished_at", "commands", "source_receipt", "reason"], "supporting check");
    if (support.execution_kind !== "deterministic_supporting_check" || !EVIDENCE_STATUS_VALUES.has(support.status) ||
        !RFC3339_UTC.test(support.started_at) || !RFC3339_UTC.test(support.finished_at) ||
        !Array.isArray(support.commands) || !/^[0-9a-f]{64}$/u.test(support.source_receipt)) {
      throw new QualificationReceiptError("supporting_check_invalid", "aggregate supporting check is invalid");
    }
    for (const command of support.commands) validateInvocation(command, { rawRoot: "evidence" });
  }
  for (const deferred of evidence.deferred) {
    assertExactKeys(deferred, ["id", "issue", "status", "reason"], "deferred scenario");
    if (deferred.status !== "not_run" || typeof deferred.reason !== "string") {
      throw new QualificationReceiptError("deferred_scenario_invalid", "aggregate deferred scenario is invalid");
    }
  }
  for (const source of evidence.source_receipts) {
    assertExactKeys(source, ["path", "sha256"], "source receipt");
    if (typeof source.path !== "string" || isAbsolute(source.path) ||
        !/^[0-9a-f]{64}$/u.test(source.sha256)) {
      throw new QualificationReceiptError("source_receipt_invalid", "aggregate source receipt is invalid");
    }
  }
  const recomputed = canonicalDigest({ ...evidence, evidence_digest: null });
  if (evidence.evidence_digest !== recomputed) {
    throw new QualificationReceiptError("evidence_digest_mismatch", "aggregate evidence digest does not match its content");
  }
  return true;
}

function validateEvidenceAssertion(assertion) {
  if (!isRecord(assertion) || typeof assertion.id !== "string" ||
      !["pass", "fail", "not_observed"].includes(assertion.disposition) ||
      !Array.isArray(assertion.evidence_refs) || assertion.evidence_refs.some((ref) => typeof ref !== "string" || ref.length === 0)) {
    throw new QualificationReceiptError("assertion_invalid", "aggregate evidence assertion is invalid");
  }
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new QualificationReceiptError("strict_schema_violation", `${label} contains unknown or missing fields`);
  }
}

/** Require the immutable eight-scenario aggregate catalog in its declared order. */
export function validateHostRecoveryCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length !== HOST_RECOVERY_SCENARIOS.length) {
    throw new QualificationReceiptError(
      "catalog_membership_invalid",
      `issue-46 aggregate catalog must contain exactly ${HOST_RECOVERY_SCENARIOS.length} scenarios`,
    );
  }
  const seen = new Set();
  for (const [index, expected] of HOST_RECOVERY_SCENARIOS.entries()) {
    const actual = catalog[index];
    if (!isRecord(actual) || seen.has(actual.id) || actual.id !== expected.id) {
      throw new QualificationReceiptError(
        "catalog_order_invalid",
        "issue-46 aggregate catalog membership/order differs from the versioned catalog",
      );
    }
    seen.add(actual.id);
    for (const field of [
      "execution_kind",
      "proof_predicate",
      "required_assertion_ids",
      "required_capture_kinds",
      "required_command_kinds",
      "required_observation_kinds",
      "public_command_kinds",
    ]) {
      if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) {
        throw new QualificationReceiptError(
          "catalog_definition_invalid",
          `catalog definition for ${expected.id} does not match the versioned harness contract`,
        );
      }
    }
  }
  return true;
}

export function validateRawQualificationReceipt(receipt, { rawRoot = undefined } = {}) {
  if (isRecord(receipt)) {
    // Scan before any schema field is trusted so unknown properties cannot
    // smuggle credential-shaped values through persistence.
    rejectSecretShapedValue(receipt, "raw receipt");
    assertExactKeys(receipt, [
      "schema", "version", "issue", "run_id", "scenario_id", "execution_kind", "release", "host",
      "tools", "isolation", "commands", "observations", "captures", "assertions",
      "retained_obligations", "cleanup", "result", "started_at", "finished_at",
    ], "raw receipt");
  }
  if (!isRecord(receipt) || receipt.schema !== HOST_RECOVERY_RAW_RECEIPT_SCHEMA ||
      receipt.version !== 1 || receipt.issue !== 46) {
    throw new QualificationReceiptError(
      "raw_receipt_schema_invalid",
      `raw receipt must use ${HOST_RECOVERY_RAW_RECEIPT_SCHEMA}`,
    );
  }
  if (typeof receipt.run_id !== "string" || !RUN_ID.test(receipt.run_id)) {
    throw new QualificationReceiptError("run_id_invalid", "raw receipt requires one explicit run_id");
  }
  const definition = SCENARIO_BY_ID.get(receipt.scenario_id);
  const isSupportingCheck = receipt.execution_kind === "deterministic_supporting_check";
  if (!definition && !isSupportingCheck) {
    throw new QualificationReceiptError("unknown_scenario", "raw receipt scenario is unknown");
  }
  if (isSupportingCheck &&
      (typeof receipt.scenario_id !== "string" ||
       !/^supporting:[a-z0-9][a-z0-9._-]*$/u.test(receipt.scenario_id))) {
    throw new QualificationReceiptError(
      "supporting_check_id_invalid",
      "deterministic supporting receipts require a supporting:<name> scenario id",
    );
  }
  if (!HOST_RECOVERY_EXECUTION_KINDS.includes(receipt.execution_kind) ||
      (!isSupportingCheck && receipt.execution_kind !== definition.execution_kind)) {
    throw new QualificationReceiptError("execution_kind_invalid", "raw receipt execution kind is invalid");
  }
  validateRelease(receipt.release);
  validateHost(receipt.host);
  validateTools(receipt.tools);
  validateIsolationReference(receipt.isolation, receipt.run_id);
  if (!Array.isArray(receipt.commands) || !Array.isArray(receipt.observations) ||
      !Array.isArray(receipt.captures) || !Array.isArray(receipt.assertions) ||
      !Array.isArray(receipt.retained_obligations) || !isRecord(receipt.cleanup) ||
      !isRecord(receipt.result) || !STATUS_VALUES.has(receipt.result.disposition) ||
      !RFC3339_UTC.test(receipt.started_at) || !RFC3339_UTC.test(receipt.finished_at) ||
      Date.parse(receipt.finished_at) < Date.parse(receipt.started_at)) {
    throw new QualificationReceiptError("raw_receipt_fields_invalid", "raw receipt fields are incomplete or invalid");
  }
  for (const command of receipt.commands) validateInvocation(command, { rawRoot });
  for (const capture of receipt.captures) validateCapture(capture, { rawRoot });
  for (const observation of receipt.observations) validateObservation(observation);
  validateEvidenceInventory(receipt);
  for (const assertion of receipt.assertions) {
    if (!isRecord(assertion) || typeof assertion.id !== "string" ||
        !["pass", "fail", "not_observed"].includes(assertion.disposition) ||
        !Array.isArray(assertion.evidence_refs)) {
      throw new QualificationReceiptError("assertion_invalid", "raw receipt assertion is invalid");
    }
  }
  validateCleanup(receipt.cleanup);
  rejectSecretShapedValue(receipt.commands.map(({ argv }) => argv), "command arguments");
  rejectSecretShapedValue(receipt.observations, "observations");
  rejectSecretShapedValue(receipt.captures, "capture metadata");
  rejectSecretShapedValue(receipt.cleanup, "cleanup");
  rejectSecretShapedValue(receipt.retained_obligations, "retained obligations");
  rejectSecretShapedValue(receipt.result.reason ?? "", "result reason");
  if (receipt.result.disposition === "pass" && !isSupportingCheck) {
    validateScenarioPass(receipt, definition);
  }
  return true;
}

function validateEvidenceInventory(receipt) {
  const commandIds = new Set();
  for (const command of receipt.commands) {
    if (commandIds.has(command.id)) {
      throw new QualificationReceiptError("command_duplicate", `duplicate command evidence ID: ${command.id}`);
    }
    commandIds.add(command.id);
  }
  const captureIds = new Set();
  const captureKinds = new Set();
  const capturePaths = new Set();
  const captureDigests = new Set();
  for (const capture of receipt.captures) {
    if (captureIds.has(capture.id) || captureKinds.has(capture.kind) ||
        capturePaths.has(capture.path) || captureDigests.has(capture.sha256)) {
      throw new QualificationReceiptError(
        "capture_duplicate",
        "capture evidence must have unique IDs, kinds, paths, and content digests",
      );
    }
    captureIds.add(capture.id);
    captureKinds.add(capture.kind);
    capturePaths.add(capture.path);
    captureDigests.add(capture.sha256);
  }
  const observationIds = new Set();
  for (const observation of receipt.observations) {
    if (observationIds.has(observation.id)) {
      throw new QualificationReceiptError("observation_duplicate", `duplicate observation evidence ID: ${observation.id}`);
    }
    observationIds.add(observation.id);
  }
}

function scenario(id, executionKind, assertionIds, commandKinds, {
  proofPredicate,
  publicCommandKinds = commandKinds,
  requiredCaptureKinds = [],
  requiredObservationKinds = [],
} = {}) {
  return Object.freeze({
    id,
    execution_kind: executionKind,
    required_assertion_ids: Object.freeze([...assertionIds]),
    proof_predicate: proofPredicate,
    required_capture_kinds: Object.freeze([...requiredCaptureKinds]),
    public_command_kinds: Object.freeze([...publicCommandKinds]),
    required_command_kinds: Object.freeze([...commandKinds]),
    required_observation_kinds: Object.freeze([...requiredObservationKinds]),
  });
}

function scenarioProjection(receipt) {
  return {
    id: receipt.scenario_id,
    execution_kind: receipt.execution_kind,
    proof_predicate: SCENARIO_BY_ID.get(receipt.scenario_id)?.proof_predicate ?? null,
    required_command_kinds: SCENARIO_BY_ID.get(receipt.scenario_id)?.required_command_kinds ?? [],
    required_observation_kinds: SCENARIO_BY_ID.get(receipt.scenario_id)?.required_observation_kinds ?? [],
    required_capture_kinds: SCENARIO_BY_ID.get(receipt.scenario_id)?.required_capture_kinds ?? [],
    status: statusFromDisposition(receipt.result.disposition),
    started_at: receipt.started_at,
    finished_at: receipt.finished_at,
    commands: receipt.commands.map((command) => structuredClone(command)),
    observations: receipt.observations.map((observation) =>
      redactQualificationCapture(observation)),
    captures: receipt.captures.map((capture) => structuredClone(capture)),
    assertions: receipt.assertions.map((assertion) => structuredClone(assertion)),
    retained_obligations: receipt.retained_obligations.map((obligation) =>
      redactQualificationCapture(obligation)),
    cleanup: structuredClone(receipt.cleanup),
    reason: receipt.result.reason ?? null,
  };
}

function supportingProjection(receipt) {
  return {
    id: receipt.scenario_id,
    execution_kind: receipt.execution_kind,
    status: statusFromDisposition(receipt.result.disposition),
    started_at: receipt.started_at,
    finished_at: receipt.finished_at,
    commands: receipt.commands.map((command) => structuredClone(command)),
    source_receipt: receipt.receipt_sha256,
    reason: receipt.result.reason ?? null,
  };
}

function blockedScenario(definition, reason) {
  return {
    id: definition.id,
    execution_kind: definition.execution_kind,
    proof_predicate: definition.proof_predicate,
    required_command_kinds: [...definition.required_command_kinds],
    required_observation_kinds: [...definition.required_observation_kinds],
    required_capture_kinds: [...definition.required_capture_kinds],
    status: "blocked",
    started_at: null,
    finished_at: null,
    commands: [],
    observations: [],
    captures: [],
    assertions: [],
    retained_obligations: [{ code: reason }],
    cleanup: {
      disposition: "not_started",
      owned_resources: [],
      resource_dispositions: [],
      unresolved_obligations: [{ code: reason }],
      completed_at: null,
    },
    reason,
  };
}

function aggregateEvidenceStatus(scenarios) {
  if (scenarios.some(({ status }) => status === "failed")) return "failed";
  if (scenarios.some(({ status }) => status === "blocked")) return "blocked";
  if (scenarios.some(({ status }) => status === "not_run")) return "not_run";
  return "passed";
}

function statusFromDisposition(disposition) {
  return disposition === "pass"
    ? "passed"
    : disposition === "fail"
      ? "failed"
      : disposition;
}

function validateRelease(release) {
  if (!isRecord(release) || typeof release.release_id !== "string" ||
      typeof release.implementation !== "string" ||
      !/^[0-9a-f]{40}$/u.test(release.candidate_tree_sha ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(release.release_content_digest ?? "") ||
      !/^[0-9a-f]{40}$/u.test(release.pinned_git_tree_sha ?? "") ||
      !/^[0-9a-f]{64}$/u.test(release.release_content_bytes_sha256 ?? "")) {
    throw new QualificationReceiptError("release_identity_invalid", "raw receipt release identity is invalid");
  }
}

function validateHost(host) {
  if (!isRecord(host) ||
      ["os", "architecture", "node", "npm", "git"].some((field) =>
        typeof host[field] !== "string" || host[field].length === 0)) {
    throw new QualificationReceiptError("host_identity_invalid", "raw receipt host identity is incomplete");
  }
}

function validateObservedHost(host) {
  validateHost(host);
  if (["os", "architecture", "node", "npm", "git"].some((field) =>
      isUnknownIdentity(host[field]))) {
    throw new QualificationReceiptError(
      "host_identity_unobserved",
      "a scenario pass requires observed OS, architecture, runtime, npm, and Git identities",
    );
  }
}

function isUnknownIdentity(value) {
  return ["unknown", "not_observed", "unavailable", "n/a", "na"].includes(
    value.trim().toLowerCase(),
  );
}

function validateTools(tools) {
  if (!isRecord(tools) ||
      ["node", "flow_launcher", "flow_host", "drovr", "herdr"].some((name) =>
        !isRecord(tools[name]) || typeof tools[name].path_ref !== "string" ||
        typeof tools[name].version !== "string" ||
        !/^[0-9a-f]{64}$/u.test(tools[name].sha256 ?? ""))) {
    throw new QualificationReceiptError("tool_identity_invalid", "raw receipt tool identity is incomplete");
  }
}

function validateIsolationReference(isolation, runId) {
  if (!isRecord(isolation) ||
      ["state_root_ref", "authority_root_ref", "socket_ref", "endpoint_ref",
        "backup_root_ref", "repository_root_ref", "drovr_config_root_ref",
        "herdr_session_ref"].some((field) =>
        typeof isolation[field] !== "string" || isolation[field].length === 0 ||
        isAbsolute(isolation[field])) ||
      isolation.run_id !== runId ||
      !/^sha256:[0-9a-f]{64}$/u.test(isolation.identity_digest ?? "")) {
    throw new QualificationReceiptError("isolation_reference_invalid", "raw receipt isolation references are invalid");
  }
}

function validateObservation(observation) {
  if (!isRecord(observation) || typeof observation.id !== "string" || observation.id.length === 0 ||
      typeof observation.kind !== "string" || observation.kind.length === 0 ||
      !isRecord(observation.content) ||
      observation.content_digest !== canonicalDigest(observation.content)) {
    throw new QualificationReceiptError(
      "observation_invalid",
      "raw receipt observations require a stable ID, structured content, and a matching digest",
    );
  }
}

function validateScenarioPass(receipt, definition, { validatedEvidenceIds = undefined } = {}) {
  validateObservedHost(receipt.host);
  if (receipt.commands.length === 0 ||
      receipt.cleanup.disposition !== "complete" ||
      receipt.cleanup.unresolved_obligations.length > 0 ||
      receipt.cleanup.owned_resources.length === 0 ||
      receipt.cleanup.resource_dispositions.length !== receipt.cleanup.owned_resources.length ||
      receipt.cleanup.completed_at === null) {
    throw new QualificationReceiptError(
      "pass_proof_incomplete",
      "a scenario pass requires commands, complete cleanup, and no retained obligations",
    );
  }
  if (definition.execution_kind !== "deterministic_supporting_check" && receipt.captures.length === 0) {
    throw new QualificationReceiptError(
      "capture_required_for_pass",
      `scenario ${definition.id} requires at least one capture for a native/live pass`,
    );
  }
  const expectedCommandKinds = [...definition.required_command_kinds].sort();
  const actualCommandKinds = receipt.commands.map((command) => command.command_kind).sort();
  if (JSON.stringify(expectedCommandKinds) !== JSON.stringify(actualCommandKinds)) {
    throw new QualificationReceiptError(
      "command_inventory_incomplete",
      `scenario ${definition.id} must contain exactly its catalog-required command kinds`,
    );
  }
  for (const command of receipt.commands) {
    if (command.expected_exit_code !== command.exit_code ||
        command.expected_signal !== command.signal ||
        command.expected_timed_out !== command.timed_out ||
        command.exit_code !== 0 || command.signal !== null || command.timed_out !== false) {
      throw new QualificationReceiptError(
        "command_exit_semantics_mismatch",
        `scenario ${definition.id} contains a command whose observed exit differs from expected success`,
      );
    }
  }
  const observationsByKind = new Map();
  for (const observation of receipt.observations) {
    if (observationsByKind.has(observation.kind)) {
      throw new QualificationReceiptError(
        "observation_duplicate",
        `duplicate structured observation kind: ${observation.kind}`,
      );
    }
    observationsByKind.set(observation.kind, observation);
  }
  for (const kind of definition.required_observation_kinds) {
    if (!observationsByKind.has(kind)) {
      throw new QualificationReceiptError(
        "observation_inventory_incomplete",
        `scenario ${definition.id} is missing required structured observation kind: ${kind}`,
      );
    }
  }
  evaluateScenarioProof(receipt, definition, observationsByKind);
  const required = new Set(definition.required_assertion_ids);
  const assertions = new Map();
  for (const assertion of receipt.assertions) {
    if (assertions.has(assertion.id)) {
      throw new QualificationReceiptError("assertion_duplicate", `duplicate assertion ID: ${assertion.id}`);
    }
    assertions.set(assertion.id, assertion);
  }
  for (const id of required) {
    const assertion = assertions.get(id);
    if (!assertion || assertion.disposition !== "pass" || assertion.evidence_refs.length === 0) {
      throw new QualificationReceiptError(
        "pass_proof_incomplete",
        `required passing assertion is missing or unresolved: ${id}`,
      );
    }
  }
  if (assertions.size !== required.size ||
      [...assertions.keys()].some((id) => !required.has(id))) {
    throw new QualificationReceiptError(
      "assertion_inventory_invalid",
      `scenario ${definition.id} must contain exactly its catalog-defined assertion IDs`,
    );
  }
  const evidenceIds = new Set([
    ...receipt.commands.map(({ id }) => id),
    ...receipt.captures.map(({ id }) => id),
    ...receipt.observations.map(({ id }) => id),
    ...receipt.commands.map(({ id }) => `command:${id}`),
    ...receipt.captures.map(({ id }) => `capture:${id}`),
    ...receipt.observations.map(({ id }) => `observation:${id}`),
  ]);
  const validatedIds = validatedEvidenceIds ?? evidenceIds;
  validateAssertionProofMappings(receipt, definition);
  for (const assertion of receipt.assertions) {
    for (const reference of assertion.evidence_refs) {
      if (!evidenceIds.has(reference) || !validatedIds.has(reference) &&
          !validatedIds.has(stripEvidencePrefix(reference))) {
        throw new QualificationReceiptError(
          "evidence_reference_unvalidated",
          `assertion ${assertion.id} references missing or unvalidated evidence: ${reference}`,
        );
      }
    }
  }
  if (definition.required_capture_kinds.some((kind) =>
      !receipt.captures.some(({ kind: captureKind }) => captureKind === kind))) {
    throw new QualificationReceiptError(
      "capture_inventory_incomplete",
      `scenario ${definition.id} is missing a required form capture`,
    );
  }
  const owned = new Set(receipt.cleanup.owned_resources.map(({ identity_ref }) => identity_ref));
  const disposed = new Map(receipt.cleanup.resource_dispositions.map(({ identity_ref, disposition }) => [identity_ref, disposition]));
  const declared = new Set(OWNED_RESOURCE_REFS);
  if (owned.size !== receipt.cleanup.owned_resources.length ||
      owned.size !== declared.size ||
      [...declared].some((identityRef) => !owned.has(identityRef)) ||
      receipt.cleanup.resource_dispositions.length !== declared.size ||
      [...declared].some((identityRef) => !disposed.has(identityRef)) ||
      [...disposed.values()].some((value) => !["removed", "retained"].includes(value)) ||
      receipt.cleanup.resource_dispositions.some(({ disposition, proof }) =>
        disposition === "removed"
          ? proof !== "absent_after_cleanup"
          : proof !== "retention_receipt_recorded")) {
    throw new QualificationReceiptError(
      "cleanup_proof_incomplete",
      "a scenario pass requires exactly the declared owned resources and observed dispositions",
    );
  }
  const retainedDispositions = receipt.cleanup.resource_dispositions
    .filter(({ disposition }) => disposition === "retained");
  const retainedObligations = new Map();
  for (const obligation of receipt.retained_obligations) {
    if (!isRecord(obligation) || typeof obligation.identity_ref !== "string" ||
        retainedObligations.has(obligation.identity_ref)) {
      throw new QualificationReceiptError(
        "retention_proof_incomplete",
        "retained cleanup obligations must have unique resource identities",
      );
    }
    retainedObligations.set(obligation.identity_ref, obligation);
  }
  if (retainedObligations.size !== retainedDispositions.length ||
      retainedDispositions.some(({ identity_ref, durable_holder, retention_receipt }) => {
        const obligation = retainedObligations.get(identity_ref);
        return !obligation || obligation.durable_holder !== durable_holder ||
          JSON.stringify(obligation.retention_receipt) !== JSON.stringify(retention_receipt);
      }) ||
      [...retainedObligations.keys()].some((identityRef) =>
        !retainedDispositions.some(({ identity_ref }) => identity_ref === identityRef))) {
    throw new QualificationReceiptError(
      "retention_proof_incomplete",
      "every retained cleanup resource requires matching durable-holder retention evidence",
    );
  }
  for (const tool of Object.values(receipt.tools)) {
    if (isUnknownIdentity(tool.version)) {
      throw new QualificationReceiptError(
        "tool_identity_unobserved",
        "a scenario pass requires observed versions for every tool",
      );
    }
  }
}

function stripEvidencePrefix(reference) {
  return reference.replace(/^(?:command|capture|observation):/u, "");
}

function validateAssertionProofMappings(receipt, definition) {
  const mapping = ASSERTION_PROOF_KINDS[definition.id] ?? {};
  const evidence = [
    ...receipt.commands.map((item) => ({ type: "command", id: item.id, kind: item.command_kind })),
    ...receipt.captures.map((item) => ({ type: "capture", id: item.id, kind: item.kind })),
    ...receipt.observations.map((item) => ({ type: "observation", id: item.id, kind: item.kind })),
  ];
  for (const assertion of receipt.assertions) {
    const required = definition.id === "ubuntu_headless_text_captures"
      ? definition.required_capture_kinds.map((kind) => `capture:${kind}`)
      : mapping[assertion.id];
    if (!Array.isArray(required) || required.length === 0) {
      throw new QualificationReceiptError(
        "assertion_proof_mapping_invalid",
        `no distinct proof mapping is registered for ${definition.id}/${assertion.id}`,
      );
    }
    for (const requirement of required) {
      const separator = requirement.indexOf(":");
      const type = requirement.slice(0, separator);
      const kind = requirement.slice(separator + 1);
      const satisfied = evidence.some((item) => item.type === type && item.kind === kind &&
        assertion.evidence_refs.some((reference) =>
          reference === item.id || reference === `${item.type}:${item.id}`));
      if (!satisfied) {
        throw new QualificationReceiptError(
          "assertion_proof_mapping_invalid",
          `assertion ${assertion.id} does not reference its distinct ${requirement} proof artifact`,
        );
      }
    }
  }
}

function evaluateScenarioProof(receipt, definition, observationsByKind) {
  const content = (kind) => observationsByKind.get(kind)?.content ?? null;
  const requires = (kind, predicate) => {
    if (!predicate(content(kind))) {
      throw new QualificationReceiptError(
        "scenario_proof_predicate_failed",
        `scenario ${definition.id} did not satisfy proof predicate ${definition.proof_predicate} for ${kind}`,
      );
    }
  };
  switch (definition.proof_predicate) {
    case "concurrent_owner_restart":
      requires("capacity", (value) => value?.bounded_capacity === true);
      requires("client_exit", (value) => value?.client_exited === true);
      requires("owner_restart", (value) => value?.same_boot_restart === true);
      requires("effect", (value) => value?.duplicate_effect === false);
      return;
    case "failure_recovery":
      requires("failure", (value) => value?.typed_failure === true &&
        value?.cancellation === true && value?.deadline === true &&
        value?.capped_recovery === true && value?.provider_outage === true &&
        value?.invalid_output === true &&
        ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
          .every((name) => value?.actionable_failures?.[name]?.observed === true &&
            typeof value.actionable_failures[name].operator_response === "string" &&
            value.actionable_failures[name].operator_response.length > 0 &&
            Array.isArray(value.actionable_failures[name].legal_actions)));
      requires("uncertainty", (value) => value?.one_shot === true && value?.duplicate_effect === false);
      return;
    case "backup_restore_reconciliation":
      requires("backup", (value) => value?.production_backup === true);
      requires("loss", (value) => value?.destructive_loss === true);
      requires("restore", (value) => value?.restored === true);
      requires("reconciliation", (value) => value?.domains_reconciled === 6);
      requires("admission", (value) => value?.retained_result_admitted === true);
      return;
    case "headless_capture_inventory":
      requires("capture_inventory", (value) => value?.inventory_complete === true &&
        value?.legibility === "pass" && value?.provenance === "pass" &&
        value?.watermark === "pass" && value?.legal_actions === "pass");
      if (receipt.captures.some((capture) => capture.legibility !== "pass" ||
          capture.provenance !== "native_provider" || capture.legal_actions !== "pass" ||
          capture.watermark.length === 0)) {
        throw new QualificationReceiptError(
          "capture_quality_incomplete",
          "headless capture inventory has an unproven legibility, provenance, watermark, or legal-action field",
        );
      }
      return;
    case "tuicr_after_producer_exit":
      requires("producer_exit", (value) => value?.producer_exited === true);
      requires("disposition", (value) => value?.flowruntime_disposition === "approved");
      requires("stale_action", (value) => value?.rejected === true);
      requires("rebuild", (value) => value?.identity_stable === true);
      return;
    case "drovr_lock_reconciliation":
      requires("lock_owner", (value) => value?.owner_killed === true);
      requires("reconciliation", (value) => value?.reconciled === true || value?.actionable_block === true);
      requires("negative_age", (value) => value?.rejected === true);
      requires("negative_force", (value) => value?.rejected === true);
      return;
    case "projection_rebuild_readers":
      requires("query", (value) => value?.observed === true);
      requires("watch", (value) => value?.observed === true);
      requires("rebuild", (value) => value?.without_mutation_lock === true);
      requires("views", (value) => value?.count >= 2);
      requires("latency", (value) => Array.isArray(value?.samples) && value.samples.length >= 2);
      return;
    case "suspended_run_admission":
      requires("suspended", (value) => value?.observed === true);
      requires("admission", (value) => value?.explicit === true);
      requires("reboot", (value) => value?.actual_reboot === false && value?.deferred === true);
      return;
    default:
      throw new QualificationReceiptError(
        "scenario_proof_predicate_unknown",
        `no evaluator is registered for proof predicate ${definition.proof_predicate}`,
      );
  }
}

function validateInvocation(command, { rawRoot }) {
  if (!isRecord(command) || typeof command.id !== "string" ||
      !Array.isArray(command.argv) || command.argv.length < 1 ||
      command.argv.some((arg) => typeof arg !== "string") ||
      typeof command.command_kind !== "string" || command.command_kind.length === 0 ||
      typeof command.launcher_ref !== "string" || isAbsolute(command.launcher_ref) ||
      typeof command.working_directory_ref !== "string" ||
      !RFC3339_UTC.test(command.started_at) || !RFC3339_UTC.test(command.finished_at) ||
      !Number.isSafeInteger(command.duration_ms) || command.duration_ms < 0 ||
      ![null, "SIGTERM", "SIGKILL", "SIGINT"].includes(command.signal) ||
      ![null, "SIGTERM", "SIGKILL", "SIGINT"].includes(command.expected_signal) ||
      !(Number.isInteger(command.exit_code) || command.exit_code === null) ||
      !(Number.isInteger(command.expected_exit_code) || command.expected_exit_code === null) ||
      typeof command.timed_out !== "boolean" || typeof command.expected_timed_out !== "boolean" ||
      !isRecord(command.logs) || !isRecord(command.logs.stdout) ||
      !isRecord(command.logs.stderr)) {
    throw new QualificationReceiptError("command_receipt_invalid", "raw receipt command is invalid");
  }
  for (const stream of ["stdout", "stderr"]) {
    const log = command.logs[stream];
    if ((log.path !== null && typeof log.path !== "string") ||
        (typeof log.path === "string" && (isAbsolute(log.path) || rawRoot === undefined)) ||
        !/^[0-9a-f]{64}$/u.test(log.sha256 ?? "") ||
        !Number.isSafeInteger(log.bytes) || log.bytes < 0) {
      throw new QualificationReceiptError("command_log_invalid", "raw receipt command log descriptor is invalid");
    }
  }
}

function validateCapture(capture, { rawRoot }) {
  if (!isRecord(capture) || typeof capture.id !== "string" ||
      typeof capture.kind !== "string" || !["json", "text", "markdown", "html"].includes(capture.format) ||
      typeof capture.path !== "string" || isAbsolute(capture.path) || rawRoot === undefined ||
      !/^[0-9a-f]{64}$/u.test(capture.sha256 ?? "") ||
      !["pass", "fail", "not_observed"].includes(capture.legibility) ||
      !["public_process", "native_provider", "deterministic_supporting_check"].includes(capture.provenance) ||
      typeof capture.watermark !== "string" ||
      !["pass", "fail", "not_observed"].includes(capture.legal_actions)) {
    throw new QualificationReceiptError("capture_invalid", "raw receipt capture is invalid");
  }
}

function validateCleanup(cleanup) {
  if (!["complete", "blocked", "not_started"].includes(cleanup.disposition) ||
      !Array.isArray(cleanup.owned_resources) ||
      !Array.isArray(cleanup.resource_dispositions) ||
      !Array.isArray(cleanup.unresolved_obligations) ||
      (cleanup.completed_at !== null && !RFC3339_UTC.test(cleanup.completed_at)) ||
      (cleanup.disposition === "complete" && cleanup.completed_at === null) ||
      cleanup.owned_resources.some((resource) => !isRecord(resource) ||
        resource.kind !== "isolated_root" || typeof resource.identity_ref !== "string") ||
      cleanup.resource_dispositions.some((resource) => invalidResourceDisposition(resource))) {
    throw new QualificationReceiptError("cleanup_invalid", "raw receipt cleanup is invalid");
  }
}

function invalidResourceDisposition(resource) {
  if (!isRecord(resource) || resource.kind !== "isolated_root" ||
      typeof resource.identity_ref !== "string" ||
      !["removed", "retained", "cleanup_blocked"].includes(resource.disposition) ||
      typeof resource.proof !== "string" || resource.proof.length === 0) return true;
  if (resource.disposition !== "retained") return false;
  return resource.proof !== "retention_receipt_recorded" ||
    typeof resource.durable_holder !== "string" || resource.durable_holder.length === 0 ||
    !isRecord(resource.retention_receipt) ||
    typeof resource.retention_receipt.identity_ref !== "string" ||
    resource.retention_receipt.identity_ref.length === 0 ||
    isAbsolute(resource.retention_receipt.identity_ref) ||
    !/^sha256:[0-9a-f]{64}$/u.test(resource.retention_receipt.sha256 ?? "");
}

function validateRetentionEvidence(cleanup, retainedObligations) {
  const retained = cleanup.resource_dispositions.filter(({ disposition }) => disposition === "retained");
  const obligations = new Map();
  for (const obligation of retainedObligations) {
    if (!isRecord(obligation) || typeof obligation.identity_ref !== "string" || obligations.has(obligation.identity_ref)) {
      throw new QualificationReceiptError("retention_proof_incomplete", "retained obligations must identify unique resources");
    }
    obligations.set(obligation.identity_ref, obligation);
  }
  if (cleanup.resource_dispositions.some(({ disposition, proof }) =>
      disposition === "removed" && proof !== "absent_after_cleanup") ||
      obligations.size !== retained.length ||
      retained.some(({ identity_ref, durable_holder, retention_receipt }) => {
        const obligation = obligations.get(identity_ref);
        return !obligation || obligation.durable_holder !== durable_holder ||
          JSON.stringify(obligation.retention_receipt) !== JSON.stringify(retention_receipt);
      }) ||
      [...obligations.keys()].some((identityRef) => !retained.some(({ identity_ref }) => identity_ref === identityRef))) {
    throw new QualificationReceiptError(
      "retention_proof_incomplete",
      "retained resources require matching durable-holder retention evidence",
    );
  }
}

function pinnedFileIdentity(root, path, label) {
  const candidate = absoluteInput(path, `${label}Path`);
  if (!isContained(root, candidate)) {
    throw new QualificationConfigurationError(
      "pinned_executable_outside_worktree",
      `${label} resolves outside pinned worktree`,
    );
  }
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    throw new QualificationConfigurationError(
      "pinned_executable_unavailable",
      `${label} is not available: ${error.message}`,
    );
  }
  if (!isContained(root, canonical)) {
    throw new QualificationConfigurationError(
      "pinned_executable_outside_worktree",
      `${label} resolves outside pinned worktree`,
    );
  }
  const stats = statSync(canonical);
  if (!stats.isFile()) {
    throw new QualificationConfigurationError(
      "pinned_executable_not_regular",
      `${label} is not a regular file`,
    );
  }
  const bytes = readFileSync(canonical);
  return Object.freeze({
    path: canonical,
    path_ref: relative(root, canonical),
    sha256: sha256(bytes),
    bytes: bytes.length,
  });
}

function observePinnedExecutableVersion(path, nodePath) {
  try {
    const version = execFileSync(nodePath, [path, "--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (version.length === 0) throw new Error("executable returned no version");
    return version;
  } catch {
    return "drovr-source/v1";
  }
}

function qualificationCommandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return "not_observed";
  }
}

function qualificationNpmVersion() {
  const npmPackage = resolve(
    dirname(process.execPath),
    "../lib/node_modules/npm/package.json",
  );
  if (existsSync(npmPackage)) {
    try {
      const version = JSON.parse(readFileSync(npmPackage, "utf8"))?.version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch {
      // Fall through to the host command observation.
    }
  }
  return qualificationCommandVersion("npm", ["--version"]);
}

function assertEntrypointsShape(entrypoints) {
  if (!isRecord(entrypoints) || !isRecord(entrypoints.node) ||
      !isRecord(entrypoints.launcher) || !isRecord(entrypoints.host) ||
      typeof entrypoints.node.path !== "string" ||
      typeof entrypoints.launcher.path !== "string" ||
      typeof entrypoints.host.path !== "string") {
    throw new QualificationConfigurationError(
      "pinned_entrypoints_invalid",
      "pinned launcher and host identities are required",
    );
  }
}

function assertIsolationShape(isolation) {
  if (!isRecord(isolation) ||
      ["worktree_root", "xdg_state_home", "authority_directory", "socket_path",
        "endpoint_path", "backup_directory", "repository_root",
        "drovr_config_directory"].some((field) =>
        typeof isolation[field] !== "string" || !isAbsolute(isolation[field])) ||
      typeof isolation.herdr_session !== "string" || isolation.herdr_session.length === 0 ||
      typeof isolation.run_id !== "string" || !RUN_ID.test(isolation.run_id)) {
    throw new QualificationConfigurationError(
      "isolation_incomplete",
      "qualification isolation is incomplete",
    );
  }
}

function absoluteInput(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw configurationError("path_not_absolute", `${label} must be an absolute path`);
  }
  return resolve(value);
}

function configurationError(code, message) {
  return new QualificationConfigurationError(code, message);
}

function isContained(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const suffix = relative(parentPath, childPath);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function containedPath(root, path, label, { allowAbsolute = false } = {}) {
  const rootPath = absoluteInput(root, "root");
  if (typeof path !== "string" || path.includes("\\") ||
      (!allowAbsolute && isAbsolute(path)) ||
      (!isAbsolute(path) && path.split("/").some((part) =>
        part === "" || part === "." || part === ".."))) {
    throw new QualificationReceiptError("path_invalid", `${label} must be a relative contained path`);
  }
  const candidate = resolve(rootPath, path);
  if (!isContained(rootPath, candidate) || candidate === rootPath) {
    throw new QualificationReceiptError("path_outside_root", `${label} escapes its root`);
  }
  return candidate;
}

function ensureRawRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(root, "rawRoot");
  assertDirectory(root, "rawRoot");
  return realpathSync(root);
}

function secureRawFile(root, path, label, { allowAbsolute = false } = {}) {
  const rootReal = ensureRawRoot(root);
  const lexical = containedPath(root, path, label, { allowAbsolute });
  try {
    assertNoSymlinkAncestors(lexical, label);
    assertRegularFile(lexical, label);
    const canonical = realpathSync(lexical);
    if (!isContained(rootReal, canonical)) {
      throw new Error(`${label} resolves outside rawRoot`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof QualificationReceiptError) throw error;
    throw new QualificationReceiptError("raw_path_untrusted", `${label} is not a regular contained file: ${error.message}`);
  }
}

function assertDirectory(path, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new QualificationReceiptError("raw_root_unavailable", `${label} is unavailable: ${error.message}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new QualificationReceiptError("raw_root_untrusted", `${label} must be a real directory`);
  }
}

function assertRegularFile(path, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new QualificationReceiptError("raw_path_unavailable", `${label} is unavailable: ${error.message}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new QualificationReceiptError("raw_path_untrusted", `${label} must be a regular non-symlink file`);
  }
}

function securePinnedFile(root, path, label) {
  const candidate = containedPath(root, path, label, { allowAbsolute: true });
  try {
    assertNoSymlinkAncestors(candidate, label);
    assertRegularFile(candidate, label);
    const canonical = realpathSync(candidate);
    if (!isContained(realpathSync(root), canonical)) {
      throw new Error(`${label} resolves outside pinned worktree`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof QualificationReceiptError) throw error;
    throw new QualificationReceiptError("release_path_untrusted", `${label} is not a regular pinned file: ${error.message}`);
  }
}

function assertEvidenceOutputPath(worktree, output, { allowExternal, forbiddenRoots = [] }) {
  const parent = dirname(output);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    if (forbiddenRoots.some((root) => {
      const forbidden = absoluteInput(root, "output forbidden root");
      return isContained(forbidden, output) || isContained(output, forbidden);
    })) {
      throw new QualificationConfigurationError(
        "output_path_overlap",
        "output path must be disjoint from external raw roots",
      );
    }
    assertNoSymlinkAncestors(output, "outputPath");
    if (existsSync(output)) assertRegularFile(output, "outputPath");
    const parentReal = realpathSync(parent);
    if (!allowExternal) {
      const evidenceRoot = join(worktree, "config", "flow", "evidence");
      assertNoSymlinkAncestors(evidenceRoot, "tracked evidence root");
      const evidenceReal = realpathSync(evidenceRoot);
      if (!isContained(evidenceReal, parentReal)) {
        throw new QualificationConfigurationError(
          "tracked_output_outside_release",
          "tracked issue-46 evidence must be written below config/flow/evidence",
        );
      }
      if (!isContained(realpathSync(worktree), parentReal)) {
        throw new QualificationConfigurationError(
          "tracked_output_outside_worktree",
          "tracked issue-46 evidence must remain below the pinned worktree",
        );
      }
    }
  } catch (error) {
    if (error instanceof QualificationConfigurationError) throw error;
    throw new QualificationConfigurationError("output_path_untrusted", `output path is not realpath-safe: ${error.message}`);
  }
}

function assertNoSymlinkAncestors(path, label) {
  const absolute = resolve(path);
  let current = absolute;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      let stats;
      try {
        stats = lstatSync(current);
      } catch (error) {
        throw configurationError("path_unreadable", `${label} cannot be inspected: ${error.message}`);
      }
      if (stats.isSymbolicLink()) {
        throw configurationError("path_symlink_ancestor", `${label} contains a symlink ancestor`);
      }
    }
    current = dirname(current);
  }
}

function pathReference(path, isolation) {
  if (isContained(isolation.worktree_root, path)) return "worktree";
  if (isContained(isolation.repository_root, path)) return "repository";
  if (isContained(isolation.xdg_state_home, path)) return "isolation/state";
  return `path:sha256:${sha256(path)}`;
}

function writePrivateLog(path, text) {
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function logDescriptor(path, text) {
  return {
    path: path.split(sep).at(-1),
    sha256: sha256(Buffer.from(text)),
    bytes: Buffer.byteLength(text),
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameRelease(left, right) {
  return isRecord(left) && isRecord(right) &&
    left.release_id === right.release_id &&
    left.implementation === right.implementation &&
    left.candidate_tree_sha === right.candidate_tree_sha &&
    left.release_content_digest === right.release_content_digest &&
    left.pinned_git_tree_sha === right.pinned_git_tree_sha &&
    left.release_content_bytes_sha256 === right.release_content_bytes_sha256;
}

function validateReceiptToolIdentity(tools, expected) {
  for (const name of ["node", "flow_launcher", "flow_host", "drovr"]) {
    const actual = tools?.[name];
    const pinned = expected[name];
    if (!isRecord(actual) || actual.path_ref !== pinned.path_ref ||
        actual.version !== pinned.version || actual.sha256 !== pinned.sha256) {
      throw new QualificationReceiptError(
        "tool_identity_mismatch",
        `raw receipt ${name} identity does not match the pinned worktree entrypoint`,
      );
    }
  }
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function redactValue(value, path, mappings) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value, path.at(-1), mappings);
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, [...path, String(index)], mappings));
  if (!isRecord(value)) return "<redacted:non-json>";
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSecretKey(key)
      ? "<redacted>"
      : redactValue(child, [...path, key], mappings),
  ]));
}

function redactString(value, key, mappings) {
  if (isSecretKey(key)) return "<redacted>";
  let redacted = value;
  for (const [name, path] of mappings) redacted = redacted.split(path).join(`<${name}>`);
  redacted = redacted.replace(SECRET_ASSIGNMENT, (_match, secret) =>
    `[REDACTED sha256:${sha256(secret)}]`);
  return redacted.replace(ABSOLUTE_PATH, (path) =>
    path.startsWith("/usr/") || path.startsWith("/bin/") || path.startsWith("/opt/")
      ? path
      : `<path:sha256:${sha256(path)}>`,
  );
}

function rejectSecretShapedValue(value, label) {
  if (containsSecretShape(value)) {
    throw new QualificationReceiptError(
      "secret_shaped_value",
      `${label} contains a secret-shaped value and cannot be persisted`,
    );
  }
}

function rejectSecretShapedBytes(bytes, label) {
  let text;
  try {
    text = bytes.toString("utf8");
  } catch (error) {
    throw new QualificationReceiptError("log_invalid_utf8", `${label} is not valid UTF-8: ${error.message}`);
  }
  rejectSecretShapedValue(text, label);
}

function containsSecretShape(value) {
  if (typeof value === "string") return SECRET_SHAPE.test(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretShape(item));
  return Object.entries(value).some(([key, child]) => isSecretKey(key) || containsSecretShape(child));
}

function isSecretKey(key) {
  return key !== "start_token" && SECRET_KEY.test(key ?? "");
}

function utcNow() {
  return new Date().toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
