import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { validateContract } from "./schema-validator.mjs";
import { acquireFileLock } from "./file-lock.mjs";
import {
  isLegalReviewTransition,
  REVIEW_STATES,
} from "./review-lifecycle.mjs";

const execFile = promisify(execFileCallback);
const STATES = new Set(REVIEW_STATES);

export async function transitionReview({
  actor,
  evidencePath,
  expectedGeneration,
  integrationReceiptPath = null,
  manifestPath,
  now = () => new Date(),
  persistManifest = validateAndWriteManifest,
  readComments = readTuicrComments,
  reason,
  sessionSlug = null,
  headSha = null,
  to,
}) {
  requireMutationArguments({
    actor,
    evidencePath,
    expectedGeneration,
    manifestPath,
    reason,
  });
  if (!STATES.has(to)) throw new Error(`unknown review lifecycle state: ${to}`);
  return withManifestLock(manifestPath, async () => {
    const manifest = await loadReviewManifest(manifestPath);
    normalizeReviewState(manifest);
    const receipt = integrationReceiptPath
      ? await loadIntegrationReceipt(integrationReceiptPath)
      : null;

    if (
      manifest.review.status === "integrated" &&
      to === "integrated" &&
      receipt &&
      manifest.review.integration_receipts.some(
        ({ receipt_id, sha256 }) =>
          receipt.document.receipt_id === receipt_id &&
          receipt.sha256 === sha256,
      )
    ) {
      return { changed: false, manifest };
    }
    assertExpectedGeneration(manifest, expectedGeneration);
    const from = manifest.review.status;
    if (!isLegalReviewTransition(from, to)) {
      throw new Error(`illegal review transition: ${from} -> ${to}`);
    }
    const healthBeforeMutation = await inspectReviewHealth(manifest);

    if (to === "reviewing") {
      if (!sessionSlug?.trim()) {
        throw new Error("transition to reviewing requires --session-slug");
      }
      manifest.review.session_slug = sessionSlug.trim();
      if (from === "approved") manifest.review.reviewed_head_sha = null;
    } else if (sessionSlug !== null) {
      throw new Error("--session-slug is valid only when transitioning to reviewing");
    }

    if (to === "review_ready" && from === "changes_requested") {
      if (headSha === null) {
        throw new Error("changes_requested -> review_ready requires --head-sha");
      }
      await assertGitObject(manifest.repo, headSha, "commit");
      const branchHead = await resolveGitRevision(
        manifest.repo,
        `refs/heads/${manifest.head.branch}^{commit}`,
      );
      if (branchHead !== headSha) {
        throw new Error(`new head ${headSha} does not match branch ${manifest.head.branch}`);
      }
      const issueRequiresNewHead = issueRecordedSinceLatestReady(manifest);
      if (issueRequiresNewHead && headSha === manifest.head.sha) {
        throw new Error("issue comments require a new head before review_ready");
      }
      manifest.head.sha = headSha;
      manifest.review.reviewed_head_sha = null;
      manifest.automated_review.status = "pending";
      manifest.automated_review.reviewed_head_sha = null;
    } else if (headSha !== null) {
      throw new Error("--head-sha is valid only for changes_requested -> review_ready");
    }

    const health = to === "review_ready"
      ? await inspectReviewHealth(manifest)
      : healthBeforeMutation;
    if (to === "reviewing" && health.health !== "current") {
      throw new Error(`review health ${health.health} blocks interactive review`);
    }
    if (to === "approved") {
      assertReviewCanApprove(manifest, health);
      await assertNoUnconsumedLiveComments(manifest, await readComments(manifest));
      manifest.review.reviewed_head_sha = manifest.head.sha;
    }
    if (to === "integrated") {
      if (!receipt) throw new Error("transition to integrated requires an integration receipt");
      const verifiedReceipt = await verifyIntegrationReceipt({
        manifest,
        receipt: receipt.document,
      });
      await assertReviewCanIntegrate(manifest, health, from, verifiedReceipt);
      if (manifest.review.session_slug !== null) {
        await assertNoUnconsumedLiveComments(manifest, await readComments(manifest));
      }
    } else if (receipt) {
      throw new Error("an integration receipt is valid only for transition to integrated");
    }

    const evidence = await evidenceReference(evidencePath);
    const receiptReference = receipt
      ? {
          receipt_id: receipt.document.receipt_id,
          path: integrationReceiptPath,
          sha256: receipt.sha256,
        }
      : null;
    const priorGeneration = manifest.review.generation;
    const generation = priorGeneration + 1;
    manifest.review.status = to;
    manifest.review.generation = generation;
    if (receiptReference) {
      manifest.review.integration_receipts.push({ ...receiptReference });
    }
    manifest.review.events.push({
      actor: actor.trim(),
      comment_ids: [],
      evidence,
      from,
      generation,
      head_sha: manifest.head.sha,
      integration_receipt: receiptReference,
      kind: "transition",
      prior_generation: priorGeneration,
      reason: reason.trim(),
      recorded_at: now().toISOString(),
      to,
    });
    await persistManifest(manifestPath, manifest);
    return { changed: true, manifest };
  });
}

export { isLegalReviewTransition } from "./review-lifecycle.mjs";

export async function recordReviewComments({
  actor,
  commentsPath,
  evidencePath,
  expectedGeneration,
  manifestPath,
  now = () => new Date(),
  readComments = readTuicrComments,
  reason,
}) {
  requireMutationArguments({
    actor,
    evidencePath,
    expectedGeneration,
    manifestPath,
    reason,
  });
  if (!isAbsolute(commentsPath)) throw new Error("comments path must be absolute");
  const comments = await loadJson(commentsPath, "review comment dispositions");
  const contract = await validateContract(comments);
  if (!contract.valid) {
    throw new Error(
      `invalid review comment dispositions: ${contract.errors[0]?.message ?? "unknown error"}`,
    );
  }
  return withManifestLock(manifestPath, async () => {
    const manifest = await loadReviewManifest(manifestPath);
    normalizeReviewState(manifest);
    assertCommentIdentity(manifest, comments);
    const liveComments = await readComments(manifest);
    assertCommentSnapshot(manifest, comments, liveComments);

    const prior = new Map(
      manifest.review.comment_dispositions.map((entry) => [entry.id, entry]),
    );
    const incomingEvidence = new Map();
    const mutationEvidence = await evidenceReference(evidencePath);
    let hasNew = false;
    for (const comment of comments.comments) {
      const commentEvidence = await evidenceReference(comment.evidence_path);
      incomingEvidence.set(comment.id, commentEvidence);
      const existing = prior.get(comment.id);
      if (!existing) {
        hasNew = true;
        continue;
      }
      const recordedEvent = manifest.review.events.find(
        (event) => event.kind === "comments_recorded" && event.comment_ids.includes(comment.id),
      );
      if (
        existing.comment_type !== comment.comment_type ||
        existing.disposition !== comment.disposition ||
        existing.reason !== comment.reason ||
        existing.evidence.path !== commentEvidence.path ||
        existing.evidence.sha256 !== commentEvidence.sha256 ||
        recordedEvent?.evidence.path !== mutationEvidence.path ||
        recordedEvent?.evidence.sha256 !== mutationEvidence.sha256
      ) {
        throw new Error(`conflicting disposition for comment ${comment.id}`);
      }
    }
    if (!hasNew) return { changed: false, manifest };
    if (!["reviewing", "changes_requested"].includes(manifest.review.status)) {
      throw new Error(
        `cannot record new comments while review is ${manifest.review.status}`,
      );
    }
    assertExpectedGeneration(manifest, expectedGeneration);

    const priorGeneration = manifest.review.generation;
    const generation = priorGeneration + 1;
    const newComments = comments.comments.filter(({ id }) => !prior.has(id));
    for (const comment of newComments) {
      manifest.review.comment_dispositions.push({
        comment_type: comment.comment_type,
        disposition: comment.disposition,
        evidence: incomingEvidence.get(comment.id),
        id: comment.id,
        reason: comment.reason,
        recorded_generation: generation,
      });
      manifest.review.consumed_comment_ids.push(comment.id);
    }
    manifest.review.generation = generation;
    manifest.review.events.push({
      actor: actor.trim(),
      comment_ids: newComments.map(({ id }) => id),
      evidence: mutationEvidence,
      from: null,
      generation,
      head_sha: manifest.head.sha,
      integration_receipt: null,
      kind: "comments_recorded",
      prior_generation: priorGeneration,
      reason: reason.trim(),
      recorded_at: now().toISOString(),
      to: null,
    });
    await validateAndWriteManifest(manifestPath, manifest);
    return { changed: true, manifest };
  });
}

export async function readTuicrComments(manifest, { env = process.env } = {}) {
  if (!manifest.review.session_slug) return [];
  const executable = env.AGENT_FLOW_TUICR_BIN?.trim() || "tuicr";
  let stdout;
  try {
    ({ stdout } = await execFile(executable, [
      "review",
      "comments",
      "--repo",
      manifest.worktree,
      "--session",
      manifest.review.session_slug,
    ], { encoding: "utf8" }));
  } catch (error) {
    throw new Error("cannot read the authoritative tuicr comment snapshot", {
      cause: error,
    });
  }
  let document;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    throw new Error("tuicr comments output is not valid JSON", { cause: error });
  }
  const comments = Array.isArray(document) ? document : document?.comments;
  if (!Array.isArray(comments)) {
    throw new Error("tuicr comments output must be an array or contain comments");
  }
  const seen = new Set();
  for (const comment of comments) {
    if (
      !comment ||
      typeof comment.id !== "string" ||
      comment.id.length === 0 ||
      !["issue", "suggestion", "note", "praise"].includes(comment.comment_type)
    ) {
      throw new Error("tuicr comment snapshot contains an invalid stable ID or type");
    }
    if (seen.has(comment.id)) throw new Error(`duplicate tuicr comment ID: ${comment.id}`);
    seen.add(comment.id);
  }
  return comments;
}

export async function inspectReviewHealth(manifest) {
  try {
    const worktree = await stat(manifest.worktree);
    if (!worktree.isDirectory()) return { health: "missing_worktree" };
  } catch (error) {
    if (error.code === "ENOENT") return { health: "missing_worktree" };
    return { health: "missing_worktree", detail: error.message };
  }

  let worktreeHead;
  let worktreeBranch;
  try {
    const [repositoryCommon, worktreeCommon, resolvedHead, resolvedBranch] = await Promise.all([
      gitCommonDirectory(manifest.repo),
      gitCommonDirectory(manifest.worktree),
      resolveGitRevision(manifest.worktree, "HEAD"),
      gitSymbolicBranch(manifest.worktree),
    ]);
    if (repositoryCommon !== worktreeCommon) {
      return { health: "missing_worktree", detail: "worktree belongs to another repository" };
    }
    worktreeHead = resolvedHead;
    worktreeBranch = resolvedBranch;
  } catch (error) {
    return { health: "missing_worktree", detail: error.message };
  }
  try {
    const branchHead = await resolveGitRevision(
      manifest.repo,
      `refs/heads/${manifest.head.branch}^{commit}`,
    );
    if (branchHead !== manifest.head.sha) {
      return { health: "head_mismatch", actual_head_sha: branchHead };
    }
    if (worktreeHead !== manifest.head.sha || worktreeBranch !== manifest.head.branch) {
      return {
        health: "head_mismatch",
        actual_head_sha: worktreeHead,
        actual_branch: worktreeBranch,
      };
    }
  } catch (error) {
    return { health: "head_mismatch", detail: error.message };
  }

  if (
    manifest.review.status === "approved" &&
    manifest.review.reviewed_head_sha !== manifest.head.sha
  ) return { health: "head_mismatch" };
  return { health: "current" };
}

export async function loadReviewManifest(manifestPath) {
  if (!isAbsolute(manifestPath)) throw new Error("review manifest path must be absolute");
  const manifest = await loadJson(manifestPath, "review manifest");
  const contract = await validateContract(manifest);
  if (!contract.valid) {
    throw new Error(`invalid review manifest: ${contract.errors[0]?.message ?? "unknown error"}`);
  }
  return manifest;
}

function normalizeReviewState(manifest) {
  manifest.review.generation ??= 0;
  manifest.review.events ??= [];
  manifest.review.comment_dispositions ??= [];
  manifest.review.integration_receipts ??= [];
}

function requireMutationArguments({ actor, evidencePath, expectedGeneration, manifestPath, reason }) {
  if (!isAbsolute(manifestPath)) throw new Error("review manifest path must be absolute");
  if (!isAbsolute(evidencePath)) throw new Error("evidence path must be absolute");
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new Error("expected generation must be a non-negative integer");
  }
  if (!actor?.trim()) throw new Error("actor is required");
  if (!reason?.trim()) throw new Error("reason is required");
}

function assertExpectedGeneration(manifest, expected) {
  if (manifest.review.generation !== expected) {
    throw new Error(
      `expected generation ${expected}, found ${manifest.review.generation}`,
    );
  }
}

function assertReviewCanApprove(manifest, health) {
  if (health.health !== "current") {
    throw new Error(`review health ${health.health} blocks approval`);
  }
  if (
    manifest.automated_review.status !== "passed" ||
    manifest.automated_review.reviewed_head_sha !== manifest.head.sha
  ) {
    throw new Error("approval requires automated review passed for the current head");
  }
  const latestReadyGeneration = manifest.review.events.reduce(
    (latest, event) =>
      event.kind === "transition" && event.to === "review_ready"
        ? Math.max(latest, event.generation)
        : latest,
    0,
  );
  if (
    manifest.review.comment_dispositions.some(
      (comment) =>
        comment.comment_type === "issue" &&
        comment.recorded_generation > latestReadyGeneration,
    )
  ) {
    throw new Error("issue comments require a revision and review_ready transition before approval");
  }
}

function issueRecordedSinceLatestReady(manifest) {
  const latestReadyGeneration = manifest.review.events.reduce(
    (latest, event) =>
      event.kind === "transition" && event.to === "review_ready"
        ? Math.max(latest, event.generation)
        : latest,
    0,
  );
  return manifest.review.comment_dispositions.some(
    (comment) =>
      comment.comment_type === "issue" &&
      comment.recorded_generation > latestReadyGeneration,
  );
}

async function assertReviewCanIntegrate(manifest, health, from, verifiedReceipt) {
  const integratedInReviewCheckout =
    health.health === "head_mismatch" &&
    health.actual_head_sha === verifiedReceipt.currentTargetCommit &&
    await samePath(manifest.repo, manifest.worktree);
  if (health.health !== "current" && !integratedInReviewCheckout) {
    throw new Error(`review health ${health.health} blocks integration`);
  }
  if (
    manifest.automated_review.status !== "passed" ||
    manifest.automated_review.reviewed_head_sha !== manifest.head.sha
  ) {
    throw new Error("integration requires automated review passed for the current head");
  }
  if (from === "approved") {
    if (manifest.review.reviewed_head_sha !== manifest.head.sha) {
      throw new Error("approval is stale for the current head");
    }
    return;
  }
  if (
    from !== "review_ready" ||
    manifest.review.session_slug !== null ||
    manifest.review.comment_dispositions.some(({ comment_type }) => comment_type === "issue")
  ) {
    throw new Error("human review evidence requires approval before integration");
  }
}

function assertCommentIdentity(manifest, comments) {
  if (comments.run_id !== manifest.run_id) {
    throw new Error("comment dispositions do not match the review run");
  }
  if (comments.head_sha !== manifest.head.sha) {
    throw new Error("comment dispositions do not match the review head");
  }
  if (
    manifest.review.session_slug === null ||
    comments.session_slug !== manifest.review.session_slug
  ) {
    throw new Error("comment dispositions do not match the review session");
  }
}

function assertCommentSnapshot(manifest, dispositions, liveComments) {
  const live = new Map(liveComments.map((comment) => [comment.id, comment]));
  const supplied = new Set(dispositions.comments.map(({ id }) => id));
  for (const disposition of dispositions.comments) {
    const comment = live.get(disposition.id);
    if (!comment) {
      throw new Error(`comment ${disposition.id} is not present in the tuicr session`);
    }
    if (comment.comment_type !== disposition.comment_type) {
      throw new Error(`comment ${disposition.id} type does not match the tuicr session`);
    }
  }
  const consumed = new Set(manifest.review.consumed_comment_ids);
  const omitted = liveComments.find(
    ({ id }) => !consumed.has(id) && !supplied.has(id),
  );
  if (omitted) {
    throw new Error(`new tuicr comment ${omitted.id} has no durable disposition`);
  }
}

async function assertNoUnconsumedLiveComments(manifest, liveComments) {
  const consumed = new Set(manifest.review.consumed_comment_ids);
  const unconsumed = liveComments.find(({ id }) => !consumed.has(id));
  if (unconsumed) {
    throw new Error(`unconsumed tuicr comment ${unconsumed.id} blocks lifecycle advancement`);
  }
}

async function loadIntegrationReceipt(path) {
  if (!isAbsolute(path)) throw new Error("integration receipt path must be absolute");
  const bytes = await readFile(path);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("integration receipt is not valid JSON", { cause: error });
  }
  const contract = await validateContract(document);
  if (!contract.valid) {
    throw new Error(`invalid integration receipt: ${contract.errors[0]?.message ?? "unknown error"}`);
  }
  return { document, sha256: sha256(bytes) };
}

async function verifyIntegrationReceipt({ manifest, receipt }) {
  if (
    receipt.review_run_id !== manifest.run_id ||
    receipt.repository !== manifest.repo ||
    receipt.reviewed_head_sha !== manifest.head.sha
  ) {
    throw new Error("integration receipt does not match the review identity and head");
  }
  const expectedTarget = `refs/heads/${manifest.base.branch}`;
  if (receipt.target_ref !== expectedTarget) {
    throw new Error(`integration receipt target must be ${expectedTarget}`);
  }
  await assertGitObject(manifest.repo, receipt.resulting_commit_sha, "commit");
  const recordedTree = await resolveGitRevision(
    manifest.repo,
    `${receipt.resulting_commit_sha}^{tree}`,
  );
  if (recordedTree !== receipt.resulting_tree_sha) {
    throw new Error("recorded integration commit does not equal the receipt tree");
  }
  const targetCommit = await resolveGitRevision(manifest.repo, `${receipt.target_ref}^{commit}`);
  await assertAncestor(manifest.repo, receipt.resulting_commit_sha, targetCommit);
  if (receipt.approved_assembly_sha) {
    await assertAncestor(manifest.repo, receipt.reviewed_head_sha, receipt.approved_assembly_sha);
    await assertAncestor(
      manifest.repo,
      receipt.approved_assembly_sha,
      receipt.resulting_commit_sha,
    );
  } else {
    await assertAncestor(
      manifest.repo,
      receipt.reviewed_head_sha,
      receipt.resulting_commit_sha,
    );
  }
  return { currentTargetCommit: targetCommit };
}

async function gitSymbolicBranch(path) {
  try {
    const { stdout } = await execFile("git", [
      "-C",
      path,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function samePath(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(left),
    realpath(right),
  ]);
  return canonicalLeft === canonicalRight;
}

async function gitCommonDirectory(path) {
  const { stdout } = await execFile("git", [
    "-C",
    path,
    "rev-parse",
    "--git-common-dir",
  ], { encoding: "utf8" });
  return realpath(resolve(path, stdout.trim()));
}

async function assertAncestor(repository, ancestor, descendant) {
  try {
    await execFile("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]);
  } catch (error) {
    if (error.code === 1) {
      throw new Error(`${ancestor} is not an ancestor of ${descendant}`);
    }
    throw new Error("cannot verify integration ancestry", { cause: error });
  }
}

async function assertGitObject(repository, revision, type) {
  try {
    const { stdout } = await execFile("git", ["-C", repository, "cat-file", "-t", revision]);
    if (stdout.trim() !== type) throw new Error(`${revision} is not a ${type}`);
  } catch (error) {
    throw new Error(`cannot verify Git object ${revision}`, { cause: error });
  }
}

async function resolveGitRevision(repository, revision) {
  const { stdout } = await execFile("git", ["-C", repository, "rev-parse", "--verify", revision]);
  return stdout.trim();
}

async function evidenceReference(path) {
  if (!isAbsolute(path)) throw new Error("evidence path must be absolute");
  const bytes = await readFile(path);
  return { path, sha256: sha256(bytes) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}`, { cause: error });
  }
}

async function validateAndWriteManifest(path, manifest) {
  const contract = await validateContract(manifest);
  if (!contract.valid) {
    throw new Error(`refusing to write invalid review manifest: ${contract.errors[0]?.message ?? "unknown error"}`);
  }
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch(ignoreMissing);
  }
}

async function withManifestLock(manifestPath, operation) {
  const lockPath = `${manifestPath}.lock`;
  const release = await acquireFileLock(lockPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") throw error;
}
