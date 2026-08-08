import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { acquireFileLock } from "./file-lock.mjs";
import { transitionReview } from "./review-manifest.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFile = promisify(execFileCallback);

export async function integrateEpicFeature({
  actor = "agent-flow",
  env = process.env,
  epicManifestPath,
  now = () => new Date(),
  receiptDirectory,
  reviewManifestPath,
  transitionReviewRun = transitionReview,
}) {
  const suppliedEpicBytes = await readFile(epicManifestPath);
  const suppliedEpic = JSON.parse(suppliedEpicBytes);
  const review = JSON.parse(await readFile(reviewManifestPath));
  await requireValid(suppliedEpic, "epic manifest");
  await requireValid(review, "feature review manifest");
  const stateHome = stateDirectory(env);
  const epicRunDirectory = join(stateHome, "agent-flow", "runs", suppliedEpic.run_id);
  const epicStatePath = join(epicRunDirectory, "epic-state.json");
  const epicState = JSON.parse(await readFile(epicStatePath));
  await requireValid(epicState, "epic state");
  const sealedEpicBytes = await readFile(epicState.epic_path);
  if (
    epicState.run_id !== suppliedEpic.run_id ||
    epicState.epic_sha256 !== sha256(sealedEpicBytes) ||
    sha256(suppliedEpicBytes) !== epicState.epic_sha256
  ) throw new Error("epic integration input does not match initialized sealed authority");
  const epic = JSON.parse(sealedEpicBytes);
  const featureEntry = Object.entries(epicState.features)
    .find(([, value]) => value.child_run_id === review.run_id);
  if (!featureEntry) throw new Error("feature review is not a sealed child of this epic");
  const [featureId, featureState] = featureEntry;
  const expectedReviewPath = join(stateHome, "agent-flow", "runs", review.run_id, "artifacts", "review.json");
  const expectedReceiptDirectory = join(epicRunDirectory, "receipts", "integration");
  if (resolve(reviewManifestPath) !== resolve(expectedReviewPath)) {
    throw new Error("feature review path is not the initialized child's canonical review artifact");
  }
  if (featureState.worktree !== review.worktree) {
    throw new Error("feature review worktree differs from initialized child authority");
  }
  if (resolve(receiptDirectory) !== resolve(expectedReceiptDirectory)) {
    throw new Error("integration receipts must use the epic run's canonical receipt directory");
  }
  if (review.repo !== epic.repo) throw new Error("feature review belongs to another repository");
  if (review.base.branch !== epic.source.branch) {
    throw new Error("feature review is not based on the epic source branch");
  }
  if (review.review.session_slug !== null && review.review.status !== "approved") {
    return { action: "human_review_pending", runId: review.run_id };
  }
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(join(receiptDirectory, ".source-integration.lock"));
  try {
    const sourceRef = `refs/heads/${epic.source.branch}`;
    const sourceHead = await git(epic.repo, "rev-parse", `${sourceRef}^{commit}`);
    const featureHead = await git(review.worktree, "rev-parse", "HEAD");
    if (featureHead !== review.head.sha) {
      throw new Error("feature review head moved before source integration");
    }
    if (!(await isAncestor(epic.repo, sourceHead, featureHead))) {
      return await mergeSourceForRereview({
        epic,
        featureHead,
        review,
        sourceHead,
      });
    }
    const receiptPath = join(receiptDirectory, `${review.run_id}.json`);
    const existing = await readReceipt(receiptPath);
    if (existing) {
      await verifyReceiptRecovery({ epic, receipt: existing, review, sourceRef });
      if (review.review.status !== "integrated") {
        await integrateReviewLifecycle({
          actor,
          now,
          receiptPath,
          review,
          reviewManifestPath,
          transitionReviewRun,
        });
      }
      await markIntegratedState({ epicState, epicStatePath, featureId, receiptPath });
      return { action: "integrated", receiptPath, recovered: true, runId: review.run_id };
    }
    const automatedReady =
      review.review.status === "review_ready" &&
      review.review.session_slug === null &&
      review.automated_review.status === "passed" &&
      review.automated_review.reviewed_head_sha === featureHead;
    const approved =
      review.review.status === "approved" &&
      review.review.reviewed_head_sha === featureHead;
    if (!automatedReady && !approved) {
      return { action: "review_pending", runId: review.run_id };
    }
    await verifyCandidateInTemporaryWorktree({
      commands: [...reviewVerification(review), ...epic.verification],
      head: featureHead,
      repository: epic.repo,
    });
    await git(epic.repo, "update-ref", sourceRef, featureHead, sourceHead);
    const tree = await git(epic.repo, "rev-parse", `${featureHead}^{tree}`);
    const receipt = {
      schema: "agent-flow.integration-receipt/v1",
      receipt_id: `${review.run_id}-${featureHead.slice(0, 12)}`,
      review_run_id: review.run_id,
      repository: epic.repo,
      reviewed_head_sha: featureHead,
      approved_assembly_sha: null,
      target_ref: sourceRef,
      resulting_commit_sha: featureHead,
      resulting_tree_sha: tree,
      actor,
      integrated_at: now().toISOString(),
    };
    await requireValid(receipt, "integration receipt");
    await atomicJson(receiptPath, receipt);
    await integrateReviewLifecycle({
      actor,
      now,
      receiptPath,
      review,
      reviewManifestPath,
      transitionReviewRun,
    });
    await markIntegratedState({ epicState, epicStatePath, featureId, receiptPath });
    return { action: "integrated", receiptPath, recovered: false, runId: review.run_id };
  } finally {
    await release();
  }
}

async function markIntegratedState({ epicState, epicStatePath, featureId, receiptPath }) {
  epicState.features[featureId].status = "integrated";
  epicState.features[featureId].integration_receipt = receiptPath;
  epicState.features[featureId].error = null;
  await atomicJson(epicStatePath, epicState);
}

async function mergeSourceForRereview({ epic, featureHead, review, sourceHead }) {
  const status = await git(review.worktree, "status", "--porcelain=v1", "--untracked-files=all");
  if (status) throw new Error("feature worktree must be clean before source reconciliation");
  try {
    await git(review.worktree, "merge", "--no-edit", sourceHead);
  } catch (error) {
    return {
      action: "conflict_revision_required",
      featureHead,
      runId: review.run_id,
      sourceHead,
      worktree: review.worktree,
      error: error.message,
    };
  }
  const reconciledHead = await git(review.worktree, "rev-parse", "HEAD");
  return {
    action: "rereview_required",
    priorHead: featureHead,
    reconciledHead,
    runId: review.run_id,
    sourceHead,
  };
}

async function verifyCandidateInTemporaryWorktree({ commands, head, repository }) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-epic-integrate-"));
  try {
    await execFile("git", ["-C", repository, "worktree", "add", "--detach", directory, head]);
    for (const { argv } of commands) {
      try {
        await execFile(argv[0], argv.slice(1), {
          cwd: directory,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (error) {
        throw new Error(`epic source verification failed: ${argv.join(" ")}`, { cause: error });
      }
    }
  } finally {
    await execFile("git", ["-C", repository, "worktree", "remove", "--force", directory])
      .catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function reviewVerification(review) {
  return [{ argv: ["git", "diff", "--check", review.base.sha, review.head.sha] }];
}

async function integrateReviewLifecycle({
  actor,
  now,
  receiptPath,
  review,
  reviewManifestPath,
  transitionReviewRun,
}) {
  const current = JSON.parse(await readFile(reviewManifestPath));
  if (current.review.status === "integrated") return;
  await transitionReviewRun({
    actor,
    evidencePath: receiptPath,
    expectedGeneration: current.review.generation,
    integrationReceiptPath: receiptPath,
    manifestPath: reviewManifestPath,
    now,
    reason: "reviewed feature entered the serialized epic source ref",
    to: "integrated",
  });
}

async function verifyReceiptRecovery({ epic, receipt, review, sourceRef }) {
  await requireValid(receipt, "existing integration receipt");
  if (
    receipt.review_run_id !== review.run_id ||
    receipt.reviewed_head_sha !== review.head.sha ||
    receipt.repository !== epic.repo || receipt.target_ref !== sourceRef
  ) throw new Error("existing integration receipt has a different authority");
  const sourceHead = await git(epic.repo, "rev-parse", `${sourceRef}^{commit}`);
  if (!(await isAncestor(epic.repo, receipt.resulting_commit_sha, sourceHead))) {
    throw new Error("existing integration receipt is not present on epic source");
  }
  const tree = await git(epic.repo, "rev-parse", `${receipt.resulting_commit_sha}^{tree}`);
  if (tree !== receipt.resulting_tree_sha) throw new Error("existing integration receipt tree changed");
}

async function readReceipt(path) {
  try { return JSON.parse(await readFile(path)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomicJson(path, document) {
  await requireValid(document, "durable epic document");
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
async function requireValid(document, label) {
  const validation = await validateContract(document);
  if (!validation.valid) throw new Error(`${label} is invalid: ${validation.errors[0]?.message}`);
}
function stateDirectory(env) {
  const value = env.XDG_STATE_HOME?.trim() || (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!value) throw new Error("HOME or XDG_STATE_HOME is required");
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function isAncestor(repo, ancestor, descendant) {
  try { await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}
