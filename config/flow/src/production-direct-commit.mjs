import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, realpathSync, fstatSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";
import { FEATURE_DIRECT_COMMIT_CONTRACT } from "../../../tools/flow/src/feature-flow.mjs";

const REPOSITORY_ENUMERATION_MAX_BYTES = 64 * 1024 * 1024;

/** One operation-owned local commit, protected by a durable before-CAS record. */
export function createProductionDirectCommitOperation({ resolveWorkspace, authorityDirectory, authority, onBoundary = () => {}, env = process.env, gitIdentity = undefined }) {
  if (gitIdentity !== undefined) validateIdentity(gitIdentity);
  const selectedIdentity = gitIdentity === undefined ? undefined : freezeCanonical(gitIdentity);
  const roots = typeof authorityDirectory === "string" ? join(authorityDirectory, "candidate-commits") : null;
  // Ambient Git redirection/configuration never reaches this mutation path.
  const gitExecutable = realpathSync("/usr/bin/git");
  const gitEnvironment = { PATH: "/usr/bin:/bin", HOME: env.HOME,
    LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const git = (repository, args, options = {}) => execFileSync(gitExecutable,
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
      "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "-C", repository, ...args],
    { encoding: null, timeout: 10000, ...options, env: { ...gitEnvironment, ...identityEnvironment(options.identity), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) } });
  // Scalar replies have one Git-added newline; pathname bytes never get trimmed
  // or decoded before being passed to another Git command.
  const gitText = (repository, args, options = {}) => git(repository, args, options).toString("utf8").replace(/\n$/u, "");
  const enumerateRepository = (repository, args, options = {}) => {
    try { return git(repository, args, { ...options, maxBuffer: REPOSITORY_ENUMERATION_MAX_BYTES }); }
    catch (error) {
      if (error?.code !== "ENOBUFS" && error?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      // Enumeration executes no filters and precedes our commit reservation.
      // Keep process output and repository paths out of public diagnostics.
      const rejection = new Error("candidate_commit_repository_too_large");
      rejection.code = "candidate_commit_repository_too_large";
      rejection.provider_observation = { schema: "flow.provider-observation/v1",
        reason: "repository_enumeration_output_limit", rejection_code: rejection.code };
      throw rejection;
    }
  };
  const configuredIdentity = (repository) => {
    // Only this non-mutating lookup reads the approved machine-local include.
    // Its configuration never reaches status, add, commit-tree or ref mutation.
    return resolveProductionGitIdentity(repository, env);
  };
  const safeRepository = (repository) => {
    if (realpathSync(gitText(repository, ["rev-parse", "--show-toplevel"])) !== realpathSync(repository)) throw new Error("candidate_commit_repository_redirected");
    assertProductionGitFiltersAbsent(
      args => git(repository, args),
      (args, options) => enumerateRepository(repository, args, options),
    );
  };
  const recordRoot = (intent) => join(roots, digest({ effect_id: intent.effect_id, idempotency_key: intent.idempotency_key }).slice(7));
  const exactRecord = (intent) => {
    const path = join(recordRoot(intent), "intent.json");
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    const { record_sha256: hash, ...identity } = value;
    if (digest(identity) !== hash || value.effect_id !== intent.effect_id || value.idempotency_key !== intent.idempotency_key) throw new Error("candidate_commit_identity_conflict");
    const reservation = JSON.parse(readFileSync(join(recordRoot(intent), "identity.json"), "utf8"));
    const { record_sha256: reservationHash, ...reservedIdentity } = reservation;
    if (digest(reservedIdentity) !== reservationHash || reservationHash !== value.identity_record_sha256 ||
        reservation.effect_id !== intent.effect_id || reservation.idempotency_key !== intent.idempotency_key ||
        reservation.old_commit_sha !== value.old_commit_sha || reservation.ref !== value.ref ||
        digest(reservation.identity) !== digest(value.identity)) throw new Error("candidate_commit_identity_conflict");
    validateIdentity(value.identity);
    return value;
  };
  const exactNoChangeRecord = (intent) => {
    const root = recordRoot(intent), path = join(root, "no-change.json");
    if (!existsSync(path)) return null;
    if (existsSync(join(root, "intent.json")) || existsSync(join(root, "index-lock.json"))) throw new Error("candidate_commit_identity_conflict");
    const value = JSON.parse(readFileSync(path, "utf8"));
    const { record_sha256: hash, ...identity } = value;
    const reserved = JSON.parse(readFileSync(join(root, "identity.json"), "utf8"));
    const { record_sha256: reservedHash, ...reservedIdentity } = reserved;
    if (digest(identity) !== hash || digest(reservedIdentity) !== reservedHash ||
        value.schema !== "flow.git-candidate-commit-absence/v1" || value.proof !== "pre_cas_unchanged_tree" ||
        value.effect_id !== intent.effect_id || value.idempotency_key !== intent.idempotency_key ||
        value.attempt_id !== intent.attempt_id || value.identity_record_sha256 !== reservedHash ||
        value.old_commit_sha !== reserved.old_commit_sha || value.ref !== reserved.ref ||
        value.old_commit_sha !== intent.operation_input.workspace.git.commit_sha ||
        value.ref !== intent.operation_input.workspace.git.ref || value.tree_sha !== intent.operation_input.workspace.git.tree_sha) throw new Error("candidate_commit_identity_conflict");
    const repository = resolveWorkspace(intent.operation_input.workspace.subject_id).path;
    safeRepository(repository);
    const index = resolve(repository, gitText(repository, ["rev-parse", "--git-path", "index"]));
    if (gitText(repository, ["rev-parse", "HEAD"]) !== value.old_commit_sha ||
        gitText(repository, ["symbolic-ref", "HEAD"]) !== value.ref ||
        byteDigest(readFileSync(index)) !== value.ordinary_index_sha256 ||
        git(repository, ["status", "--porcelain"]).length !== 0) throw new Error("candidate_commit_outcome_uncertain");
    return value;
  };
  const noChangeEvidence = (record) => ({ schema: "flow.provider-observation/v1", found: false,
    complete: true, reason: "candidate_commit_no_change", rejection_code: "candidate_commit_no_change",
    proof: record.proof, content_sha256: record.record_sha256 });
  const noChangeReceipt = (intent, record) => ({ schema: "flow.effect-receipt/v1", effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key, outcome: "not_created", provider_receipt: noChangeEvidence(record) });
  const receipt = (intent, record) => freezeCanonical({ schema: "flow.git-candidate-commit-receipt/v1",
    effect_id: intent.effect_id, idempotency_key: intent.idempotency_key, attempt_id: intent.attempt_id,
    workspace: intent.operation_input.workspace, old_commit_sha: record.old_commit_sha,
    commit_sha: record.commit_sha, tree_sha: record.tree_sha, ref: record.ref,
    record_sha256: record.record_sha256, proof: "exact_local_ref_cas" });
  const validate = (intent) => {
    const workspace = intent.operation_input?.workspace;
    const resolved = resolveWorkspace(workspace?.subject_id);
    if (!resolved || !workspace?.git?.clean || !workspace.git.ref.startsWith("refs/heads/")) throw new Error("candidate_commit_workspace_invalid");
    const current = getWorkspaceAuthority({ runAuthority: authority() }).query({ contract: "work.workspace/v1", subject_id: workspace.subject_id });
    if (current.generation !== workspace.generation || current.mutation_epoch !== workspace.mutation_epoch ||
        digest({ git: current.git }) !== workspace.fingerprint ||
        !current.claims?.some((claim) => claim.holder === intent.run_id && claim.operations?.includes(intent.card_id))) throw new Error("candidate_commit_claim_unproven");
    const run = authority().query(intent.run_id);
    if (selectedIdentity !== undefined && digest(run.views?.operator?.trust_posture?.git_identity ?? null) !== digest(selectedIdentity)) throw new Error("candidate_commit_author_identity_changed");
    if (!run.capability_bindings?.some((binding) => binding.capability === "repository:write" &&
        (binding.card_ids?.includes(intent.card_id) || binding.card_ids?.includes("*")))) throw new Error("candidate_commit_grant_unproven");
    const bindings = intent.operation_input?.authority_materialized_result_bindings ?? [];
    const apply = bindings.find((record) => record.producer_card_id === "feature-apply")?.content;
    if (apply?.settlement_proof?.schema !== "flow.task-settlement-proof/v1" ||
        apply.terminal_disposition?.proof !== "linux_subreaper_echild") throw new Error("candidate_commit_task_retirement_unproven");
    if (digest(intent.operation_input.permitted_paths) !== digest(["."])) throw new Error("candidate_commit_path_scope_invalid");
    return resolved.path;
  };
  const observe = (intent) => {
    try {
      const record = exactRecord(intent);
      if (!record) {
        const noChange = exactNoChangeRecord(intent);
        return noChange ? observation(intent, "absent", noChangeEvidence(noChange)) :
          observation(intent, "indeterminate", { schema: "flow.provider-observation/v1", reason: "commit_record_missing" });
      }
      if (existsSync(join(recordRoot(intent), "no-change.json"))) throw new Error("candidate_commit_identity_conflict");
      const repository = resolveWorkspace(intent.operation_input.workspace.subject_id).path;
      safeRepository(repository);
      const head = gitText(repository, ["rev-parse", "HEAD"]);
      if (head !== record.commit_sha || gitText(repository, ["symbolic-ref", "HEAD"]) !== record.ref ||
          gitText(repository, ["rev-parse", `${head}^`]) !== record.old_commit_sha ||
          gitText(repository, ["rev-parse", `${head}^{tree}`]) !== record.tree_sha ||
          gitText(repository, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", head]) !==
            [record.identity.author.name, record.identity.author.email, record.identity.committer.name, record.identity.committer.email].join("\0") ||
          git(repository, ["status", "--porcelain"]).length !== 0) return observation(intent, "indeterminate", { schema: "flow.provider-observation/v1", reason: "commit_outcome_uncertain" });
      const lockRecord = JSON.parse(readFileSync(join(recordRoot(intent), "index-lock.json"), "utf8"));
      const { record_sha256: lockHash, ...lockIdentity } = lockRecord;
      if (digest(lockIdentity) !== lockHash || lockRecord.intent_record_sha256 !== record.record_sha256 ||
          lockRecord.owner !== record.index_publication.owner || lockRecord.index_path !== record.index_publication.index_path ||
          existsSync(record.index_publication.index_path + ".lock")) throw new Error("candidate_commit_outcome_uncertain");
      return observation(intent, "present", receipt(intent, record));
    } catch (error) {
      return observation(intent, "indeterminate", error?.code === "candidate_commit_repository_too_large"
        ? error.provider_observation : { schema: "flow.provider-observation/v1", reason: "commit_outcome_uncertain" });
    }
  };
  return Object.freeze({ schema: "flow.registered-operation/v1", classification: "reconcilable", observe, reconcile: observe,
    async invoke(intent) {
      const repository = validate(intent);
      safeRepository(repository);
      const previous = exactRecord(intent);
      if (previous) {
        const result = observe(intent);
        if (result.presence !== "present") throw new Error("candidate_commit_outcome_uncertain");
        return effectReceipt(intent, result.provider_observation);
      }
      const noChange = exactNoChangeRecord(intent);
      if (noChange) return noChangeReceipt(intent, noChange);
      const initial = intent.operation_input.workspace.git;
      let fenced = false;
      try { fenced = gitText(repository, ["rev-parse", "HEAD"]) === initial.commit_sha &&
        gitText(repository, ["symbolic-ref", "HEAD"]) === initial.ref && git(repository, ["diff", "--cached", "--name-only"]).length === 0; } catch { /* Ref loss is drift, never no effect. */ }
      if (!fenced) throw new Error("candidate_commit_git_fence_changed");
      const ordinaryIndex = resolve(repository, gitText(repository, ["rev-parse", "--git-path", "index"]));
      const lockPath = ordinaryIndex + ".lock";
      if (existsSync(lockPath)) throw new Error("candidate_commit_index_locked");
      const identity = selectedIdentity ?? configuredIdentity(repository);
      const root = recordRoot(intent);
      mkdirSync(roots, { recursive: true, mode: 0o700 }); mkdirSync(root, { mode: 0o700 });
      // Existing ancestors can remain after a failed directory publication.
      // Publish this exact hierarchy on every fresh effect before identity,
      // private-index or object writes; existence alone proves no durability.
      for (let directory = resolve(root); ; directory = dirname(directory)) {
        syncDirectory(directory); if (dirname(directory) === directory) break;
      }
      const reservedIdentity = { effect_id: intent.effect_id, idempotency_key: intent.idempotency_key, old_commit_sha: initial.commit_sha, ref: initial.ref, identity };
      const reservation = { ...reservedIdentity, record_sha256: digest(reservedIdentity) };
      writeDurable(root, "identity.json", JSON.stringify(reservation));
      const index = join(root, "index");
      git(repository, ["read-tree", initial.commit_sha], { index });
      git(repository, ["add", "--all", "--", "."], { index });
      const tree = gitText(repository, ["write-tree"], { index });
      if (tree === initial.tree_sha) {
        // This branch precedes commit-tree, the durable commit intent, index
        // locking and ref CAS. Publish an exact absence witness; a missing or
        // damaged witness remains indeterminate on recovery.
        if (gitText(repository, ["rev-parse", "HEAD"]) !== initial.commit_sha ||
            gitText(repository, ["symbolic-ref", "HEAD"]) !== initial.ref ||
            git(repository, ["status", "--porcelain"]).length !== 0) throw new Error("candidate_commit_git_fence_changed");
        const identity = { schema: "flow.git-candidate-commit-absence/v1", effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key, attempt_id: intent.attempt_id,
          old_commit_sha: initial.commit_sha, tree_sha: tree, ref: initial.ref,
          identity_record_sha256: reservation.record_sha256,
          ordinary_index_sha256: byteDigest(readFileSync(ordinaryIndex)), proof: "pre_cas_unchanged_tree" };
        const record = { ...identity, record_sha256: digest(identity) };
        writeDurable(root, "no-change.json", JSON.stringify(record));
        return noChangeReceipt(intent, exactNoChangeRecord(intent));
      }
      const message = `Flow local candidate\n\nEffect: ${intent.effect_id}\nIdempotency: ${intent.idempotency_key}\n`;
      const commit = gitText(repository, ["commit-tree", "--no-gpg-sign", tree, "-p", initial.commit_sha], { input: message, identity });
      const oldIndex = readFileSync(ordinaryIndex), replacement = readFileSync(index);
      const publication = { index_path: ordinaryIndex, old_index_sha256: byteDigest(oldIndex), replacement_sha256: byteDigest(replacement), owner: randomUUID() };
      const recordIdentity = { schema: "flow.git-candidate-commit-intent/v1", effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key, old_commit_sha: initial.commit_sha, tree_sha: tree, commit_sha: commit, ref: initial.ref,
        identity, identity_record_sha256: reservation.record_sha256, index_publication: publication };
      const record = { ...recordIdentity, record_sha256: digest(recordIdentity) };
      writeDurable(root, "intent.json", JSON.stringify(record));
      // The immutable record exists before the only branch mutation. A crash
      // around this CAS is reconciled, never rebuilt into another commit.
      onBoundary("before_ref_cas");
      // Git clients use this same exclusive pathname. Keep it from validation
      // through CAS and atomic index publication; never overwrite staged drift.
      let lockFd;
      try { lockFd = openSync(lockPath, "wx", 0o600); }
      catch (error) { if (error.code === "EEXIST") throw new Error("candidate_commit_index_locked"); throw error; }
      const lockStat = fstatSync(lockFd);
      const ownsLock = () => {
        try { const current = lstatSync(lockPath); return current.dev === lockStat.dev && current.ino === lockStat.ino; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
      };
      try {
        const observedIndex = readFileSync(ordinaryIndex);
        if (byteDigest(observedIndex) !== publication.old_index_sha256) throw new Error("candidate_commit_git_fence_changed");
        // write-tree can update cache-tree/index bytes, so validate a private
        // snapshot instead of letting Git contend with the held ordinary lock.
        const snapshot = join(root, "index-before-publication"); writeFileSync(snapshot, observedIndex, { flag: "wx", mode: 0o600 });
        if (gitText(repository, ["symbolic-ref", "HEAD"]) !== initial.ref || gitText(repository, ["rev-parse", "HEAD"]) !== initial.commit_sha ||
            gitText(repository, ["write-tree"], { index: snapshot }) !== initial.tree_sha) throw new Error("candidate_commit_git_fence_changed");
        writeFileSync(lockFd, replacement); fsyncSync(lockFd); syncDirectory(dirname(ordinaryIndex));
        const lockIdentity = { owner: publication.owner, index_path: ordinaryIndex, device: lockStat.dev, inode: lockStat.ino, intent_record_sha256: record.record_sha256 };
        writeDurable(root, "index-lock.json", JSON.stringify({ ...lockIdentity, record_sha256: digest(lockIdentity) }));
        validate(intent);
        git(repository, ["update-ref", initial.ref, commit, initial.commit_sha]);
        onBoundary("after_ref_cas");
        onBoundary("before_index_publish");
        if (!ownsLock() || byteDigest(readFileSync(ordinaryIndex)) !== publication.old_index_sha256 ||
            gitText(repository, ["symbolic-ref", "HEAD"]) !== initial.ref || gitText(repository, ["rev-parse", "HEAD"]) !== commit) throw new Error("candidate_commit_outcome_uncertain");
        renameSync(lockPath, ordinaryIndex); syncDirectory(dirname(ordinaryIndex));
      } finally {
        try { if (ownsLock()) { unlinkSync(lockPath); syncDirectory(dirname(ordinaryIndex)); } }
        finally { closeSync(lockFd); }
      }
      const result = observe(intent);
      if (result.presence !== "present") throw new Error("candidate_commit_outcome_uncertain");
      return effectReceipt(intent, result.provider_observation);
    },
  });
}
function effectReceipt(intent, providerReceipt) { return { schema: "flow.effect-receipt/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key, outcome: "succeeded", provider_receipt: providerReceipt }; }
function observation(intent, presence, evidence) { return { schema: "flow.effect-observation/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key, presence, causation: presence === "present" ? { effect_id: intent.effect_id, idempotency_key: intent.idempotency_key } : null, provider_observation: evidence }; }
/** Read only the configured identity; unsafe Git options never reach mutation. */
export function resolveProductionGitIdentity(repository, env = process.env) {
  const configEnvironment = { PATH: "/usr/bin:/bin", HOME: env.HOME, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
    ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}) };
  const value = key => {
    try { return execFileSync(realpathSync("/usr/bin/git"), ["-C", repository, "config", "--get", key], { encoding: "utf8", timeout: 10000, env: configEnvironment }).replace(/\n$/u, ""); }
    catch (error) { if (error.status === 1) return undefined; throw error; }
  };
  const userName = value("user.name"), userEmail = value("user.email");
  const identity = { author: { name: value("author.name") ?? userName, email: value("author.email") ?? userEmail },
    committer: { name: value("committer.name") ?? userName, email: value("committer.email") ?? userEmail } };
  validateIdentity(identity);
  return freezeCanonical(identity);
}

function validateIdentity(identity) {
  for (const role of ["author", "committer"]) for (const field of ["name", "email"]) {
    const value = identity?.[role]?.[field];
    if (typeof value !== "string" || !value || value.trim() !== value || /[\x00-\x1f\x7f<>]/u.test(value)) throw new Error("candidate_commit_author_identity_unproven");
  }
}
function identityEnvironment(identity) {
  if (!identity) return {};
  validateIdentity(identity);
  return { GIT_AUTHOR_NAME: identity.author.name, GIT_AUTHOR_EMAIL: identity.author.email,
    GIT_COMMITTER_NAME: identity.committer.name, GIT_COMMITTER_EMAIL: identity.committer.email };
}
function syncDirectory(path) { const directory = openSync(path, "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
function byteDigest(bytes) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
function writeDurable(root, name, text) {
  const path = join(root, name + ".new"); const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path, join(root, name)); syncDirectory(root);
}

/** Discovery and commit share the same no-filter policy before worktree hashing. */
export function assertProductionGitFiltersAbsent(git, enumerate = git) {
  // Even status/add can execute clean/process filters. Reject configured
  // external drivers before any worktree hashing or Git mutation.
  try {
    if (git( ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"]).length) throw new Error("candidate_commit_external_filter_unsupported");
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  // A named driver defined only in suppressed global config becomes Git's
  // silent pass-through. Attribute discovery itself executes no driver.
  const paths = enumerate( ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (paths.length) {
    const attributes = enumerate( ["check-attr", "--all", "-z", "--stdin"], { input: paths });
    for (let offset = 0; offset < attributes.length;) {
      const pathEnd = attributes.indexOf(0, offset);
      const attributeEnd = attributes.indexOf(0, pathEnd + 1);
      const valueEnd = attributes.indexOf(0, attributeEnd + 1);
      if (pathEnd < 0 || attributeEnd < 0 || valueEnd < 0) throw new Error("candidate_commit_attributes_invalid");
      // --all omits unspecified attributes. Reject every declared filter,
      // including ambiguous sentinel-looking driver names and unset values.
      if (attributes.subarray(pathEnd + 1, attributeEnd).equals(Buffer.from("filter"))) throw new Error("candidate_commit_external_filter_unsupported");
      offset = valueEnd + 1;
    }
  }
}
