import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { acquireFileLock } from "./file-lock.mjs";
import { validateContract } from "./schema-validator.mjs";
import { assertBuiltStackState, validateStackPlan } from "./stack-operations.mjs";

const execFile = promisify(execFileCallback);

export async function initializeDelivery({ deliveryPath, stackPlanPath, stackStatePath, externalRef, repositoryPolicy }) {
  const planBytes = await readFile(stackPlanPath);
  const stackBytes = await readFile(stackStatePath);
  const plan = JSON.parse(planBytes);
  const stack = JSON.parse(stackBytes);
  const validation = await validateStackPlan(plan);
  if (!validation.valid) throw new Error(`stack plan is invalid: ${validation.errors[0]?.message}`);
  if (plan.approval.status !== "approved" || plan.approval.plan_fingerprint !== plan.plan_fingerprint) {
    throw new Error("delivery requires an approved immutable stack generation");
  }
  if (!new Set(["built", "published"]).has(stack.status)) throw new Error("stack is not ready for delivery");
  if (stack.plan_fingerprint !== plan.plan_fingerprint) throw new Error("stack state and plan differ");
  await assertBuiltStackState(plan, stack);
  if (!stack.final_head_sha || !stack.final_tree_sha) throw new Error("stack state omits its exact final assembly");
  const baseGeneration = (stack.active_generation ?? stack.generation) === stack.generation;
  const sourceSha = baseGeneration ? plan.source.sha : stack.final_head_sha;
  const sourceRef = baseGeneration ? plan.source.ref : stack.created_layers.at(-1)?.branch;
  if (!sourceRef) throw new Error("stack state omits its terminal reviewed layer ref");
  const sourceTree = await git(plan.repo, "rev-parse", `${sourceSha}^{tree}`);
  if (sourceTree !== stack.final_tree_sha) throw new Error("stack assembly does not exactly reproduce its source tree");
  const [liveSource, liveTarget] = await Promise.all([
    git(plan.repo, "rev-parse", `${sourceRef}^{commit}`),
    git(plan.repo, "rev-parse", `${plan.target.ref}^{commit}`),
  ]);
  if (liveSource !== sourceSha || liveTarget !== plan.target.sha) {
    throw new Error("stack source or target moved before delivery initialization");
  }
  const layerReviews = [];
  for (const layer of stack.created_layers) {
    if (!layer.review_manifest || !layer.review_manifest_sha256) {
      throw new Error(`layer ${layer.id} lacks canonical review authority`);
    }
    const bytes = await readFile(layer.review_manifest);
    if (sha256(bytes) !== layer.review_manifest_sha256) {
      throw new Error(`layer ${layer.id} review authority changed`);
    }
    const review = JSON.parse(bytes);
    await requireValid(review, `layer ${layer.id} review manifest`);
    if (
      review.review.status !== "approved" ||
      review.review.reviewed_head_sha !== layer.head_sha ||
      review.head.sha !== layer.head_sha
    ) throw new Error(`layer ${layer.id} canonical review is stale`);
    layerReviews.push({
      layer_id: layer.id, head_sha: layer.head_sha,
      path: layer.review_manifest, sha256: layer.review_manifest_sha256,
    });
  }
  const document = {
    schema: "agent-flow.delivery/v1", run_id: plan.run_id,
    generation: stack.active_generation ?? stack.generation,
    repo: plan.repo, stack_plan: stackPlanPath, stack_plan_sha256: sha256(planBytes),
    stack_state: stackStatePath, stack_state_sha256: sha256(stackBytes),
    source_ref: sourceRef, source_sha: sourceSha, target: structuredClone(plan.target),
    delivery_branch: plan.delivery_branch, external_ref: externalRef,
    verification: structuredClone(plan.verification), repository_policy: repositoryPolicy,
    layer_reviews: layerReviews,
  };
  await requireValid(document, "delivery manifest");
  const statePath = `${deliveryPath}.state.json`;
  const initialState = {
    schema: "agent-flow.delivery-state/v1", run_id: plan.run_id,
    generation: stack.active_generation ?? stack.generation,
    status: "pending", target_sha: plan.target.sha, source_sha: sourceSha,
    delivery_head_sha: null, applied_layers: [], verification: null,
    completion_pr: null, pending_layer: null, rollback_actions: [], error: null,
  };
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const existingDelivery = await readOptionalJson(deliveryPath);
    const existingState = await readOptionalJson(statePath);
    if (existingDelivery || existingState) {
      if (!existingDelivery || !existingState) throw new Error("delivery initialization is incomplete and requires recovery");
      await requireValid(existingDelivery, "existing delivery manifest");
      await requireValid(existingState, "existing delivery state");
      if (JSON.stringify(existingDelivery) !== JSON.stringify(document)) {
        throw new Error("existing delivery has different immutable authority");
      }
      if (
        existingState.run_id !== initialState.run_id ||
        existingState.generation !== initialState.generation ||
        existingState.source_sha !== initialState.source_sha ||
        existingState.target_sha !== initialState.target_sha
      ) throw new Error("existing delivery state belongs to another generation");
      return { deliveryPath, resumed: true, statePath };
    }
    await atomicJson(deliveryPath, document);
    await atomicJson(statePath, initialState);
    return { deliveryPath, resumed: false, statePath };
  } finally { await release(); }
}

export async function assembleNextDeliveryLayer({
  deliveryPath,
  remote = null,
  reviewManifestPath,
  statePath = `${deliveryPath}.state.json`,
}) {
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, plan, stack, state } = await loadDelivery({ deliveryPath, statePath });
    if (remote) await assertDeliveryRemote({ delivery, plan, remote });
    await reconcileDelivery({ delivery, state, statePath });
    await settlePendingRetarget({ delivery, remote, state, statePath });
    const recovered = await recoverPendingLayer({ delivery, remote, stack, state, statePath });
    if (recovered) return recovered;
    const index = state.applied_layers.length;
    const layer = stack.created_layers[index];
    if (!layer) return { action: "complete", applied: index };
    const reviewAuthority = delivery.layer_reviews[index];
    if (
      !reviewAuthority || reviewAuthority.layer_id !== layer.id ||
      reviewAuthority.head_sha !== layer.head_sha
    ) throw new Error(`delivery omits canonical review authority for ${layer.id}`);
    if (
      reviewManifestPath !== undefined &&
      await realpath(reviewManifestPath) !== reviewAuthority.path
    ) {
      throw new Error(`caller-selected review manifest is not canonical for ${layer.id}`);
    }
    const reviewBytes = await readFile(reviewAuthority.path);
    if (sha256(reviewBytes) !== reviewAuthority.sha256) {
      throw new Error(`canonical review manifest changed for ${layer.id}`);
    }
    reviewManifestPath = reviewAuthority.path;
    const review = JSON.parse(reviewBytes);
    await requireValid(review, "layer review manifest");
    if (
      review.review.status !== "approved" ||
      review.review.reviewed_head_sha !== layer.head_sha ||
      review.head.sha !== layer.head_sha
    ) throw new Error(`layer ${layer.id} is not approved at its recorded head`);
    state.pending_layer = {
      base_sha: state.delivery_head_sha ?? delivery.target.sha,
      id: layer.id,
      index,
      review_manifest: reviewManifestPath,
      reviewed_head_sha: layer.head_sha,
    };
    await atomicJson(statePath, state);
    const worktree = await deliveryWorktree({ delivery, state });
    try {
      await git(worktree, "cherry-pick", layer.head_sha);
      await git(worktree, "diff", "--check", `${state.delivery_head_sha ?? delivery.target.sha}..HEAD`);
      const head = await git(worktree, "rev-parse", "HEAD");
      const tree = await git(worktree, "rev-parse", "HEAD^{tree}");
      state.delivery_head_sha = head;
      state.pending_layer = null;
      const nextPr = stack.prs?.[index + 1];
      state.applied_layers.push({
        id: layer.id, reviewed_head_sha: layer.head_sha, resulting_head_sha: head,
        resulting_tree_sha: tree, review_manifest: reviewManifestPath,
        retarget: nextPr ? { id: nextPr.id, status: "pending" } : null,
      });
      state.status = state.applied_layers.length === stack.created_layers.length ? "assembled" : "assembling";
      if (state.applied_layers.length === 1) {
        state.rollback_actions.push({
          argv: ["git", "-C", delivery.repo, "branch", "-D", delivery.delivery_branch],
        });
      }
      await atomicJson(statePath, state);
      await reconcileDelivery({ delivery, state, statePath });
      if (remote && nextPr) {
        await remote.assertTargetRef({ expectedSha: delivery.target.sha, ref: delivery.target.ref, repo: delivery.repo });
        await remote.retargetPullRequest({ id: nextPr.id, base: delivery.delivery_branch, repo: delivery.repo });
        state.applied_layers.at(-1).retarget.status = "complete";
        await atomicJson(statePath, state);
      } else if (nextPr) {
        throw new Error(`retarget of ${nextPr.id} is pending`);
      }
      return { action: "applied", headSha: head, layer: layer.id, treeSha: tree };
    } catch (error) {
      state.status = "assembly_failed"; state.error = error.message;
      await atomicJson(statePath, state).catch(() => {}); throw error;
    } finally {
      await execFile("git", ["-C", delivery.repo, "worktree", "remove", "--force", worktree]).catch(() => {});
      await rm(worktree, { recursive: true, force: true });
    }
  } finally { await release(); }
}

async function recoverPendingLayer({ delivery, remote, stack, state, statePath }) {
  const pending = state.pending_layer;
  if (!pending) return null;
  let live;
  try { live = await git(delivery.repo, "rev-parse", `refs/heads/${delivery.delivery_branch}^{commit}`); }
  catch { return null; }
  if (live === pending.base_sha) return null;
  const layer = stack.created_layers[pending.index];
  if (!layer || layer.id !== pending.id || layer.head_sha !== pending.reviewed_head_sha) {
    throw new Error("pending delivery layer differs from sealed stack authority");
  }
  const [liveTree, expectedTree] = await Promise.all([
    git(delivery.repo, "rev-parse", `${live}^{tree}`),
    git(delivery.repo, "rev-parse", `${layer.head_sha}^{tree}`),
  ]);
  if (liveTree !== expectedTree) {
    throw new Error("delivery branch moved during an unreceipted layer mutation");
  }
  const nextPr = stack.prs?.[pending.index + 1];
  state.delivery_head_sha = live;
  state.pending_layer = null;
  state.applied_layers.push({
    id: layer.id, reviewed_head_sha: layer.head_sha, resulting_head_sha: live,
    resulting_tree_sha: liveTree, review_manifest: pending.review_manifest,
    retarget: nextPr ? { id: nextPr.id, status: "pending" } : null,
  });
  state.status = state.applied_layers.length === stack.created_layers.length ? "assembled" : "assembling";
  state.error = null;
  await atomicJson(statePath, state);
  await settlePendingRetarget({ delivery, remote, state, statePath });
  return { action: "recovered", headSha: live, layer: layer.id, treeSha: liveTree };
}

export async function verifyDelivery({ deliveryPath, statePath = `${deliveryPath}.state.json` }) {
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, stack, state } = await loadDelivery({ deliveryPath, statePath });
    await reconcileDelivery({ delivery, state, statePath });
    if (state.applied_layers.some(({ retarget }) => retarget?.status === "pending")) {
      throw new Error("delivery has a pending stack PR retarget");
    }
    if (state.applied_layers.length !== stack.created_layers.length) throw new Error("delivery omits reviewed layers");
    const results = [];
    try {
      const deliveryTree = await git(delivery.repo, "rev-parse", `${state.delivery_head_sha}^{tree}`);
      const sourceTree = await git(delivery.repo, "rev-parse", `${delivery.source_sha}^{tree}`);
      if (deliveryTree !== sourceTree) throw new Error("delivery tree does not exactly equal the approved source tree");
      const worktree = await mkdtemp(join(tmpdir(), "agent-flow-delivery-verify-"));
      try {
        await execFile("git", ["-C", delivery.repo, "worktree", "add", "--detach", worktree, state.delivery_head_sha]);
        for (const command of delivery.verification) {
          try {
            const { stdout, stderr } = await execFile(command.argv[0], command.argv.slice(1), { cwd: worktree, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
            results.push({ argv: command.argv, exit_code: 0, stdout, stderr });
          } catch (error) {
            results.push({ argv: command.argv, exit_code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message });
            throw new Error(`delivery verification failed: ${command.argv.join(" ")}`);
          }
        }
      } finally {
        await execFile("git", ["-C", delivery.repo, "worktree", "remove", "--force", worktree]).catch(() => {});
        await rm(worktree, { recursive: true, force: true });
      }
      state.status = "verified"; state.verification = { passed: true, delivery_tree: deliveryTree, source_tree: sourceTree, results };
      state.error = null;
      await atomicJson(statePath, state);
      return state.verification;
    } catch (error) {
      state.status = "verification_failed";
      state.verification = { passed: false, results };
      state.error = error.message;
      await atomicJson(statePath, state);
      throw error;
    }
  } finally { await release(); }
}

async function settlePendingRetarget({ delivery, remote, state, statePath }) {
  const pending = state.applied_layers.find(({ retarget }) => retarget?.status === "pending");
  if (!pending) return;
  if (!remote) throw new Error(`retarget of ${pending.retarget.id} is pending`);
  await remote.assertTargetRef({ expectedSha: delivery.target.sha, ref: delivery.target.ref, repo: delivery.repo });
  await remote.retargetPullRequest({
    id: pending.retarget.id,
    base: delivery.delivery_branch,
    repo: delivery.repo,
  });
  pending.retarget.status = "complete";
  state.status = "assembling";
  state.error = null;
  await atomicJson(statePath, state);
}

export async function openCompletionPullRequest({ deliveryPath, remote, statePath = `${deliveryPath}.state.json` }) {
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, plan, stack, state } = await loadDelivery({ deliveryPath, statePath });
    await assertDeliveryRemote({ delivery, plan, remote });
    await reconcileDelivery({ delivery, state, statePath });
    if (!state.verification?.passed) throw new Error("delivery gates must pass before completion PR creation");
    await assertVerifiedDeliveryState({ delivery, stack, state });
    await rerunDeliveryCommands({ delivery, state });
    if (state.completion_pr) return state.completion_pr;
    if (state.status !== "verified") throw new Error("delivery is not ready for completion PR creation");
    await remote.assertTargetRef({ expectedSha: delivery.target.sha, ref: delivery.target.ref, repo: delivery.repo });
    await remote.pushBranch({ branch: delivery.delivery_branch, expectedSha: state.delivery_head_sha, repo: delivery.repo });
    await reconcileDelivery({ delivery, state, statePath });
    const livePolicy = await remote.getRepositoryPolicy({ repo: delivery.repo, target: delivery.target.ref });
    const safe =
      livePolicy.current_base_enforced &&
      delivery.repository_policy.required_checks.every((check) => livePolicy.required_checks.includes(check));
    if (!safe && !delivery.repository_policy.allow_explicit_checkpoint) {
      throw new Error("repository policy is unsafe and no explicit draft merge checkpoint was approved");
    }
    const created = await remote.createPullRequest({
      base: delivery.target.ref.replace(/^refs\/heads\//, ""), head: delivery.delivery_branch,
      repo: delivery.repo,
      draft: !safe,
      title: `Complete ${delivery.run_id}`,
      body: completionBody(delivery, state, safe),
    });
    state.completion_pr = {
      id: created.id, url: created.url, target_sha: delivery.target.sha,
      delivery_head_sha: state.delivery_head_sha,
      status: safe ? "ready" : "merge_checkpoint_required",
    };
    state.status = safe ? "completion_open" : "completion_checkpoint_required";
    await atomicJson(statePath, state);
    return state.completion_pr;
  } finally { await release(); }
}

export async function approveCompletionCheckpoint({
  actor,
  deliveryPath,
  now = () => new Date(),
  reason,
  remote,
  statePath = `${deliveryPath}.state.json`,
}) {
  if (typeof actor !== "string" || actor.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
    throw new Error("completion checkpoint requires an actor and reason");
  }
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, plan, stack, state } = await loadDelivery({ deliveryPath, statePath });
    await assertDeliveryRemote({ delivery, plan, remote });
    await reconcileDelivery({ delivery, state, statePath });
    if (
      state.status !== "completion_checkpoint_required" ||
      state.completion_pr?.status !== "merge_checkpoint_required"
    ) throw new Error("delivery does not have a pending merge checkpoint");
    await assertVerifiedDeliveryState({ delivery, stack, state });
    await rerunDeliveryCommands({ delivery, state });
    await remote.assertTargetRef({
      expectedSha: delivery.target.sha, ref: delivery.target.ref, repo: delivery.repo,
    });
    const observed = await remote.getPullRequest({ id: state.completion_pr.id, repo: delivery.repo });
    if (
      observed.merged || observed.base_ref !== delivery.target.ref.replace(/^refs\/heads\//, "") ||
      observed.head_ref !== delivery.delivery_branch ||
      observed.head_sha !== state.delivery_head_sha
    ) throw new Error("completion PR identity changed before checkpoint approval");
    await remote.markReady({ id: state.completion_pr.id, repo: delivery.repo });
    state.completion_pr.status = "ready";
    state.completion_pr.checkpoint = {
      actor: actor.trim(), approved_at: now().toISOString(), reason: reason.trim(),
      target_sha: delivery.target.sha, delivery_head_sha: state.delivery_head_sha,
    };
    state.status = "completion_open";
    state.error = null;
    await atomicJson(statePath, state);
    return { id: state.completion_pr.id, status: "ready", statePath };
  } finally { await release(); }
}

export async function reconcileOpenCompletion({ deliveryPath, remote, statePath = `${deliveryPath}.state.json` }) {
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, plan, state } = await loadDelivery({ deliveryPath, statePath });
    await assertDeliveryRemote({ delivery, plan, remote });
    try { await reconcileDelivery({ delivery, state, statePath }); return { action: "current" }; }
    catch (error) {
      if (state.completion_pr) {
        try {
          await remote.markDraft({ id: state.completion_pr.id, repo: delivery.repo });
        } catch (draftError) {
          state.status = "unsafe_intervention_required";
          state.error = `target moved and completion PR could not be made draft: ${draftError.message}`;
          await atomicJson(statePath, state);
          throw new Error(state.error);
        }
      }
      return { action: "source_refresh_required", error: error.message };
    }
  } finally { await release(); }
}

export async function observeCompletionMerge({ completionAdapter, deliveryPath, remote, statePath = `${deliveryPath}.state.json` }) {
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const { delivery, plan, stack, state } = await loadDelivery({ deliveryPath, statePath });
    await assertDeliveryRemote({ delivery, plan, remote });
    if (!state.completion_pr) throw new Error("completion PR does not exist");
    if (!state.verification?.passed) throw new Error("completion observation lacks verified delivery authority");
    await assertVerifiedDeliveryState({ delivery, stack, state });
    await rerunDeliveryCommands({ delivery, state });
    const observed = await remote.getPullRequest({ id: state.completion_pr.id, repo: delivery.repo });
    if (!observed.merged || !observed.merge_commit_sha) return { action: "waiting" };
    if (
      observed.base_ref !== delivery.target.ref.replace(/^refs\/heads\//, "") ||
      observed.head_ref !== delivery.delivery_branch ||
      observed.head_sha !== state.delivery_head_sha
    ) throw new Error("observed completion PR identity differs from verified delivery authority");
    const mergeTree = await git(delivery.repo, "rev-parse", `${observed.merge_commit_sha}^{tree}`);
    const deliveryTree = await git(delivery.repo, "rev-parse", `${state.delivery_head_sha}^{tree}`);
    if (mergeTree !== deliveryTree) throw new Error("completion merge tree differs from verified delivery tree");
    let mergedBase;
    try { mergedBase = await git(delivery.repo, "rev-parse", `${observed.merge_commit_sha}^1`); }
    catch { throw new Error("completion merge does not expose a verifiable merged base"); }
    if (mergedBase !== delivery.target.sha) {
      throw new Error("completion PR merged from a stale target base");
    }
    const liveTarget = await git(delivery.repo, "rev-parse", `${delivery.target.ref}^{commit}`);
    if (!(await isAncestor(delivery.repo, observed.merge_commit_sha, liveTarget))) {
      throw new Error("completion merge commit is not present on the target ref");
    }
    if (!(await isAncestor(delivery.repo, delivery.target.sha, observed.merge_commit_sha))) {
      throw new Error("completion merge does not descend from the approved target SHA");
    }
    await completionAdapter.markDone({
      externalRef: delivery.external_ref,
      evidence: { completion_pr: state.completion_pr.url, merge_commit_sha: observed.merge_commit_sha },
    });
    state.status = "complete"; state.completion_pr.status = "merged";
    state.completion_pr.merge_commit_sha = observed.merge_commit_sha;
    await atomicJson(statePath, state);
    return { action: "complete", mergeCommitSha: observed.merge_commit_sha };
  } finally { await release(); }
}

async function deliveryWorktree({ delivery, state }) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-delivery-"));
  if (state.delivery_head_sha === null) {
    let exists = true;
    try { await git(delivery.repo, "show-ref", "--verify", `refs/heads/${delivery.delivery_branch}`); } catch { exists = false; }
    if (exists) {
      const live = await git(delivery.repo, "rev-parse", `refs/heads/${delivery.delivery_branch}^{commit}`);
      if (!state.pending_layer || live !== state.pending_layer.base_sha) {
        throw new Error("delivery branch exists without a reconcilable mutation intent");
      }
      await execFile("git", ["-C", delivery.repo, "worktree", "add", directory, delivery.delivery_branch]);
    } else {
      await execFile("git", ["-C", delivery.repo, "worktree", "add", "-b", delivery.delivery_branch, directory, delivery.target.sha]);
    }
  } else {
    const live = await git(delivery.repo, "rev-parse", `refs/heads/${delivery.delivery_branch}^{commit}`);
    if (live !== state.delivery_head_sha) throw new Error("delivery branch moved outside its durable state");
    await execFile("git", ["-C", delivery.repo, "worktree", "add", directory, delivery.delivery_branch]);
  }
  return directory;
}

async function reconcileDelivery({ delivery, state, statePath }) {
  const source = await git(delivery.repo, "rev-parse", `${delivery.source_ref}^{commit}`);
  if (source !== delivery.source_sha) {
    state.status = "stale"; state.error = "source moved; a newly approved stack generation is required";
    await atomicJson(statePath, state);
    throw new Error(state.error);
  }
  const target = await git(delivery.repo, "rev-parse", `${delivery.target.ref}^{commit}`);
  if (target === delivery.target.sha) {
    if (state.delivery_head_sha !== null) {
      const liveDelivery = await git(delivery.repo, "rev-parse", `refs/heads/${delivery.delivery_branch}^{commit}`);
      if (liveDelivery !== state.delivery_head_sha) {
        throw new Error("delivery branch moved outside its durable state");
      }
    }
    return;
  }
  state.status = "stale"; state.error = "target moved; source refresh and a newly approved stack generation are required";
  await atomicJson(statePath, state);
  throw new Error(state.error);
}
async function loadDelivery({ deliveryPath, statePath }) {
  const delivery = JSON.parse(await readFile(deliveryPath)); await requireValid(delivery, "delivery manifest");
  const state = JSON.parse(await readFile(statePath));
  await requireValid(state, "delivery state");
  if (state.run_id !== delivery.run_id || state.generation !== delivery.generation || state.source_sha !== delivery.source_sha) throw new Error("delivery state identity changed");
  const planBytes = await readFile(delivery.stack_plan); const stackBytes = await readFile(delivery.stack_state);
  if (sha256(planBytes) !== delivery.stack_plan_sha256 || sha256(stackBytes) !== delivery.stack_state_sha256) {
    throw new Error("delivery stack authority changed after initialization");
  }
  const plan = JSON.parse(planBytes); const stack = JSON.parse(stackBytes);
  const planValidation = await validateStackPlan(plan);
  if (!planValidation.valid) throw new Error(`sealed stack plan is invalid: ${planValidation.errors[0]?.message}`);
  await requireValid(stack, "stack state");
  await assertBuiltStackState(plan, stack);
  if (delivery.layer_reviews.length !== stack.created_layers.length) {
    throw new Error("delivery review authority does not cover every active layer");
  }
  for (const [index, authority] of delivery.layer_reviews.entries()) {
    const layer = stack.created_layers[index];
    if (authority.layer_id !== layer.id || authority.head_sha !== layer.head_sha) {
      throw new Error(`delivery review authority differs from active layer ${layer.id}`);
    }
    const bytes = await readFile(authority.path);
    if (sha256(bytes) !== authority.sha256) {
      throw new Error(`delivery review authority changed for ${layer.id}`);
    }
    const review = JSON.parse(bytes);
    await requireValid(review, `delivery review authority for ${layer.id}`);
    if (
      review.review.status !== "approved" ||
      review.review.reviewed_head_sha !== layer.head_sha || review.head.sha !== layer.head_sha
    ) throw new Error(`delivery review authority is no longer approved for ${layer.id}`);
  }
  return { delivery, plan, stack, state };
}
async function assertDeliveryRemote({ delivery, plan, remote }) {
  if (typeof remote?.assertRepositoryCoordinate !== "function") {
    throw new Error("delivery remote cannot reconcile the sealed repository coordinate");
  }
  await remote.assertRepositoryCoordinate({ expected: plan.forge_coordinate, repo: delivery.repo });
}
async function assertVerifiedDeliveryState({ delivery, stack, state }) {
  if (
    state.pending_layer !== null ||
    state.applied_layers.length !== stack.created_layers.length ||
    state.applied_layers.some(({ retarget }) => retarget?.status === "pending")
  ) throw new Error("verified delivery state does not contain every settled layer");
  for (const [index, applied] of state.applied_layers.entries()) {
    const layer = stack.created_layers[index];
    if (applied.id !== layer.id || applied.reviewed_head_sha !== layer.head_sha) {
      throw new Error(`verified delivery layer ${index + 1} differs from sealed stack authority`);
    }
  }
  const final = state.applied_layers.at(-1);
  const [deliveryTree, sourceTree] = await Promise.all([
    git(delivery.repo, "rev-parse", `${state.delivery_head_sha}^{tree}`),
    git(delivery.repo, "rev-parse", `${delivery.source_sha}^{tree}`),
  ]);
  if (
    !final || final.resulting_head_sha !== state.delivery_head_sha ||
    final.resulting_tree_sha !== deliveryTree || deliveryTree !== sourceTree ||
    state.verification.delivery_tree !== deliveryTree ||
    state.verification.source_tree !== sourceTree ||
    state.verification.results.length !== delivery.verification.length ||
    state.verification.results.some((result, index) =>
      result.exit_code !== 0 || JSON.stringify(result.argv) !== JSON.stringify(delivery.verification[index].argv)
    )
  ) throw new Error("verified delivery state does not reconstruct from Git and sealed commands");
}
async function rerunDeliveryCommands({ delivery, state }) {
  const worktree = await mkdtemp(join(tmpdir(), "agent-flow-delivery-open-"));
  try {
    await execFile("git", ["-C", delivery.repo, "worktree", "add", "--detach", worktree, state.delivery_head_sha]);
    for (const command of delivery.verification) {
      await execFile(command.argv[0], command.argv.slice(1), {
        cwd: worktree, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
      });
    }
  } finally {
    await execFile("git", ["-C", delivery.repo, "worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true });
  }
}
async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function completionBody(delivery, state, safe) {
  return `## Summary\n\nCompletes ${delivery.external_ref} from verified delivery assembly ${state.delivery_head_sha}.\n\n## Gates\n\n- Exact source tree: passed\n- Full verification: passed\n- Current-base policy: ${safe ? "enforced" : "explicit merge checkpoint required"}\n`;
}
async function requireValid(document, label) {
  const result = await validateContract(document); if (!result.valid) throw new Error(`${label} is invalid: ${result.errors[0]?.message}`);
}
async function atomicJson(path, document) {
  await requireValid(document, "durable delivery document");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`; let done = false;
  try { await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); done = true; }
  finally { if (!done) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}
async function git(cwd, ...args) { return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })).stdout.trim(); }
async function isAncestor(repo, ancestor, descendant) {
  try { await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
