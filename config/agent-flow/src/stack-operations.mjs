import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { acquireFileLock } from "./file-lock.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFile = promisify(execFileCallback);
const SPLIT_SCRIPT = fileURLToPath(new URL("../../agents/skills/split/scripts/split_diff.py", import.meta.url));

export async function analyzeStackDiff({ repo, sourceSha, targetSha }) {
  await assertCommit(repo, sourceSha); await assertCommit(repo, targetSha);
  const diff = await git(repo, "diff", "--binary", "--find-renames", targetSha, sourceSha);
  const analysis = await runAnalyze(diff);
  return { source_sha: sourceSha, target_sha: targetSha, ...analysis };
}

export function stackPlanFingerprint(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_fingerprint;
  delete copy.approval;
  return sha256(Buffer.from(stableStringify(copy)));
}

export async function validateStackPlan(plan) {
  const contract = await validateContract(plan);
  if (!contract.valid) return contract;
  const errors = [];
  if (stackPlanFingerprint(plan) !== plan.plan_fingerprint) {
    errors.push({ instancePath: "/plan_fingerprint", keyword: "planFingerprint", message: "must bind every immutable plan field" });
  }
  const analysis = await analyzeStackDiff({ repo: plan.repo, sourceSha: plan.source.sha, targetSha: plan.target.sha });
  validateAssignments(plan, analysis, errors);
  return { valid: errors.length === 0, errors };
}

export async function approveStackPlan({ actor, now = () => new Date(), planPath }) {
  const plan = JSON.parse(await readFile(planPath));
  const validation = await validateStackPlan(plan);
  if (!validation.valid) throw new Error(`stack plan is invalid: ${validation.errors[0]?.message}`);
  await assertLiveIdentity(plan);
  plan.approval = {
    status: "approved", actor, approved_at: now().toISOString(),
    plan_fingerprint: plan.plan_fingerprint,
  };
  await atomicJson(planPath, plan);
  return { generation: plan.generation, planFingerprint: plan.plan_fingerprint, planPath };
}

export async function approveRestack({
  actor,
  changedHeadSha,
  changedLayerIndex,
  newGeneration,
  now = () => new Date(),
  planPath,
  statePath = `${planPath}.state.json`,
}) {
  if (typeof actor !== "string" || actor.trim() === "") {
    throw new Error("restack approval requires an actor");
  }
  const plan = JSON.parse(await readFile(planPath));
  await requireApprovedPlan(plan);
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const state = JSON.parse(await readFile(statePath));
    await requireValidContract(state, "stack state");
    requireStackStateIdentity(state, plan);
    await assertRestackBaseState({ changedHeadSha, changedLayerIndex, plan, state });
    const currentGeneration = state.active_generation ?? state.generation;
    if (!Number.isInteger(newGeneration) || newGeneration <= currentGeneration) {
      throw new Error("restack approval requires a newer generation");
    }
    const layer = plan.layers[changedLayerIndex];
    const prior = state.created_layers[changedLayerIndex];
    if (!layer || !prior) throw new Error("restack approval names an unknown layer");
    const live = await git(plan.repo, "rev-parse", `refs/heads/${layer.branch}^{commit}`);
    if (live !== changedHeadSha) throw new Error("restack approval head is not the live owning layer");
    await assertOwningLayerChange({
      afterSha: changedHeadSha, beforeSha: prior.head_sha, layer, repo: plan.repo,
    });
    await reconcileOrStale({ plan, planPath });
    const fingerprint = sha256(Buffer.from(stableStringify({
      changed_head_sha: changedHeadSha, changed_layer_index: changedLayerIndex,
      new_generation: newGeneration, plan_fingerprint: plan.plan_fingerprint,
    })));
    state.restack_approval = {
      actor: actor.trim(), approved_at: now().toISOString(),
      changed_head_sha: changedHeadSha, changed_layer_index: changedLayerIndex,
      fingerprint, new_generation: newGeneration, status: "approved",
    };
    await atomicJson(statePath, state);
    return { fingerprint, newGeneration, statePath };
  } finally { await release(); }
}

async function assertRestackBaseState({ changedHeadSha, changedLayerIndex, plan, state }) {
  if (state.status !== "built" || state.created_layers.length !== plan.layers.length) {
    throw new Error("restack approval requires a complete built stack");
  }
  let parent = plan.target.sha;
  for (const [index, recorded] of state.created_layers.entries()) {
    const layer = plan.layers[index];
    if (recorded.id !== layer.id || recorded.parent_sha !== parent) {
      throw new Error(`restack base layer ${layer.id} differs from approved topology`);
    }
    const live = await git(plan.repo, "rev-parse", `refs/heads/${layer.branch}^{commit}`);
    const expectedLive = index === changedLayerIndex ? changedHeadSha : recorded.head_sha;
    if (live !== expectedLive) throw new Error(`restack base layer ${layer.id} differs from Git`);
    await assertCommit(plan.repo, recorded.head_sha);
    parent = recorded.head_sha;
  }
  const [originalTree, sourceTree] = await Promise.all([
    git(plan.repo, "rev-parse", `${state.final_head_sha}^{tree}`),
    git(plan.repo, "rev-parse", `${plan.source.sha}^{tree}`),
  ]);
  if (state.final_head_sha !== parent || state.final_tree_sha !== originalTree || originalTree !== sourceTree) {
    throw new Error("restack base no longer proves the approved source tree");
  }
}

export async function buildStack({ planPath, statePath = `${planPath}.state.json` }) {
  const plan = JSON.parse(await readFile(planPath));
  const validation = await validateStackPlan(plan);
  if (!validation.valid) throw new Error(`stack plan is invalid: ${validation.errors[0]?.message}`);
  if (
    plan.approval.status !== "approved" ||
    plan.approval.plan_fingerprint !== plan.plan_fingerprint
  ) throw new Error("stack generation requires human approval of this exact plan");
  const release = await acquireFileLock(`${statePath}.lock`);
  const worktree = await mkdtemp(join(tmpdir(), "agent-flow-stack-"));
  let state = await loadStackState(statePath, plan);
  try {
    const sourceTree = await git(plan.repo, "rev-parse", `${plan.source.sha}^{tree}`);
    let parent = plan.target.sha;
    await execFile("git", ["-C", plan.repo, "worktree", "add", "--detach", worktree, parent]);
    for (const [index, layer] of plan.layers.entries()) {
      await reconcileOrStale({ plan, planPath });
      const recorded = state.created_layers[index];
      if (recorded) {
        const current = await git(plan.repo, "rev-parse", `refs/heads/${layer.branch}^{commit}`);
        if (current !== recorded.head_sha || recorded.parent_sha !== parent) {
          throw new Error(`existing layer ${layer.id} differs from its durable receipt`);
        }
        parent = current;
        continue;
      }
      await git(worktree, "switch", "--detach", parent);
      try {
        await git(worktree, "switch", "-c", layer.branch, parent);
      } catch (error) {
        throw new Error(`cannot create layer branch ${layer.branch}`, { cause: error });
      }
      await materializeLayerTree({ index, plan, worktree });
      const owned = ownedPaths(layer);
      await git(worktree, "add", "--", ...owned);
      await git(worktree, "commit", "-m", layer.commit_message);
      const head = await git(worktree, "rev-parse", "HEAD");
      const actualPaths = await changedPaths(worktree, parent, head);
      if (!sameSet(actualPaths, owned)) {
        throw new Error(`layer ${layer.id} changed paths outside its ownership`);
      }
      if (!(await isAncestor(plan.repo, parent, head))) throw new Error(`layer ${layer.id} is not linear`);
      const receipt = { id: layer.id, branch: layer.branch, parent_sha: parent, head_sha: head };
      state.created_layers.push(receipt); state.status = "building";
      state.rollback_actions.push({ argv: ["git", "-C", plan.repo, "branch", "-D", layer.branch] });
      await atomicJson(statePath, state);
      parent = head;
    }
    const finalTree = await git(plan.repo, "rev-parse", `${parent}^{tree}`);
    if (finalTree !== sourceTree) throw new Error("final stack layer tree does not equal the immutable source tree");
    await reconcileOrStale({ plan, planPath });
    state.status = "built"; state.final_head_sha = parent; state.final_tree_sha = finalTree;
    await atomicJson(statePath, state);
    return { finalHeadSha: parent, finalTreeSha: finalTree, statePath };
  } catch (error) {
    state.status = "failed"; state.error = error.message;
    await atomicJson(statePath, state).catch(() => {});
    throw new Error(`${error.message}; partial-failure manifest: ${statePath}`);
  } finally {
    await execFile("git", ["-C", plan.repo, "worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true });
    await release();
  }
}

export async function assertOwningLayerChange({ afterSha, beforeSha, layer, repo }) {
  const actual = await changedPaths(repo, beforeSha, afterSha);
  const owned = ownedPaths(layer);
  if (!actual.every((path) => owned.includes(path))) {
    throw new Error(`review change escaped owning layer ${layer.id}`);
  }
  const wholeFiles = new Set(layer.changes
    .filter(({ hunks }) => hunks === "all")
    .map(({ path }) => path));
  const parent = await git(repo, "rev-parse", `${beforeSha}^`);
  const [ownedRanges, reviewRanges] = await Promise.all([
    changedLineRanges(repo, parent, beforeSha, "new"),
    changedLineRanges(repo, beforeSha, afterSha, "old"),
  ]);
  for (const range of reviewRanges) {
    if (wholeFiles.has(range.path)) continue;
    const permitted = ownedRanges.filter(({ path }) => path === range.path);
    if (!permitted.some((ownedRange) => rangesOverlap(range, ownedRange))) {
      throw new Error(`review change escaped owning hunks for ${range.path}`);
    }
  }
  return { changed: actual, layer: layer.id };
}

export async function restackSuffix({
  changedHeadSha,
  changedLayerIndex,
  newGeneration,
  beforeMutation = async () => {},
  planPath,
  statePath = `${planPath}.state.json`,
}) {
  const plan = JSON.parse(await readFile(planPath));
  await requireApprovedPlan(plan);
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
  const state = JSON.parse(await readFile(statePath));
  await requireValidContract(state, "stack state");
  requireStackStateIdentity(state, plan);
  if (!Number.isInteger(changedLayerIndex) || changedLayerIndex < 0 || changedLayerIndex >= plan.layers.length) {
    throw new Error("changed layer index is outside the stack");
  }
  const currentGeneration = state.active_generation ?? state.generation;
  if (
    !Number.isInteger(newGeneration) || newGeneration <= currentGeneration ||
    state.restacks?.some(({ generation }) => generation === newGeneration)
  ) {
    throw new Error("suffix restack requires a newer generation");
  }
  const expectedApproval = sha256(Buffer.from(stableStringify({
    changed_head_sha: changedHeadSha, changed_layer_index: changedLayerIndex,
    new_generation: newGeneration, plan_fingerprint: plan.plan_fingerprint,
  })));
  if (
    state.restack_approval?.status !== "approved" ||
    state.restack_approval.fingerprint !== expectedApproval
  ) throw new Error("suffix restack requires human approval of this exact generation");
  await reconcileOrStale({ plan, planPath });
  const changedLayer = plan.layers[changedLayerIndex];
  const recorded = state.created_layers[changedLayerIndex];
  const liveChanged = await git(plan.repo, "rev-parse", `refs/heads/${changedLayer.branch}^{commit}`);
  if (liveChanged !== changedHeadSha) throw new Error("changed owning layer ref does not match its reviewed head");
  await assertOwningLayerChange({
    afterSha: changedHeadSha,
    beforeSha: recorded.head_sha,
    layer: changedLayer,
    repo: plan.repo,
  });
  const worktree = await mkdtemp(join(tmpdir(), "agent-flow-restack-"));
  const restack = {
    generation: newGeneration,
    changed_layer: changedLayer.id,
    prefix: state.created_layers.slice(0, changedLayerIndex),
    owning_layer: {
      id: recorded.id, branch: recorded.branch,
      parent_sha: recorded.parent_sha, head_sha: changedHeadSha,
    },
    suffix: [],
  };
  let parent = changedHeadSha;
  try {
    await execFile("git", ["-C", plan.repo, "worktree", "add", "--detach", worktree, parent]);
    for (let index = changedLayerIndex + 1; index < plan.layers.length; index += 1) {
      await beforeMutation({ index, restack });
      await reconcileOrStale({ plan, planPath });
      const layer = plan.layers[index];
      const original = state.created_layers[index];
      const branch = `${layer.branch}-g${newGeneration}`;
      await git(worktree, "switch", "--detach", parent);
      await git(worktree, "switch", "-c", branch, parent);
      await git(worktree, "cherry-pick", original.head_sha);
      const head = await git(worktree, "rev-parse", "HEAD");
      restack.suffix.push({ id: layer.id, branch, parent_sha: parent, head_sha: head, replayed_from: original.head_sha });
      parent = head;
    }
    restack.final_head_sha = parent;
    restack.final_tree_sha = await git(plan.repo, "rev-parse", `${parent}^{tree}`);
    await verifyStackCommands({ commands: plan.verification, head: parent, repo: plan.repo });
    state.restacks ??= [];
    state.restacks.push(restack);
    for (const layer of restack.suffix) {
      state.rollback_actions.push({ argv: ["git", "-C", plan.repo, "branch", "-D", layer.branch] });
    }
    state.active_generation = newGeneration;
    state.reviewed_source_sha = parent;
    state.created_layers = [
      ...restack.prefix,
      restack.owning_layer,
      ...restack.suffix,
    ];
    state.final_head_sha = parent;
    state.final_tree_sha = restack.final_tree_sha;
    state.prs = [];
    state.status = "built";
    state.restack_approval.status = "consumed";
    state.error = null;
    await atomicJson(statePath, state);
    return restack;
  } catch (error) {
    restack.error = error.message;
    state.restacks ??= []; state.restacks.push(restack);
    await atomicJson(statePath, state).catch(() => {});
    throw new Error(`${error.message}; suffix restack receipt: ${statePath}`);
  } finally {
    await execFile("git", ["-C", plan.repo, "worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true });
  }
  } finally { await release(); }
}

export async function prototypeAssemblyPolicy({ layerHeads, policy, repo, sourceSha, targetSha }) {
  if (!new Set(["merge", "squash", "replay"]).has(policy)) throw new Error(`unknown assembly policy: ${policy}`);
  const directory = await mkdtemp(join(tmpdir(), `agent-flow-${policy}-`));
  try {
    await execFile("git", ["-C", repo, "worktree", "add", "--detach", directory, targetSha]);
    let priorLayer = targetSha;
    for (const [index, head] of layerHeads.entries()) {
      if (policy === "merge") {
        await git(directory, "merge", "--no-ff", "--no-edit", head);
      } else if (policy === "replay") {
        await git(directory, "cherry-pick", head);
      } else {
        const patch = await gitRaw(repo, "diff", "--binary", priorLayer, head);
        await applyPatch(directory, patch);
        await git(directory, "commit", "-m", `squash layer ${index + 1}`);
      }
      priorLayer = head;
    }
    const assembled = await git(directory, "rev-parse", "HEAD");
    const tree = await git(directory, "rev-parse", "HEAD^{tree}");
    const sourceTree = await git(repo, "rev-parse", `${sourceSha}^{tree}`);
    return { assembled, exactTree: tree === sourceTree, policy, tree };
  } finally {
    await execFile("git", ["-C", repo, "worktree", "remove", "--force", directory]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishStack({ planPath, remote, statePath = `${planPath}.state.json` }) {
  const plan = JSON.parse(await readFile(planPath));
  await requireApprovedPlan(plan);
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
  const state = JSON.parse(await readFile(statePath));
  await requireValidContract(state, "stack state");
  requireStackStateIdentity(state, plan);
  await assertBuiltStackState(plan, state);
  if (state.status === "published") {
    await reconcileOrStale({ plan, planPath });
    return { prs: state.prs ?? [], statePath };
  }
  if (!new Set(["built", "publish_failed"]).has(state.status)) {
    throw new Error("stack must be built before remote publication");
  }
  state.prs ??= [];
  try {
    if (typeof remote.assertRepositoryCoordinate !== "function") {
      throw new Error("stack remote cannot reconcile the sealed repository coordinate");
    }
    await remote.assertRepositoryCoordinate({
      expected: plan.forge_coordinate, repo: plan.repo,
    });
    for (const [index, layer] of state.created_layers.entries()) {
      await reconcileOrStale({ plan, planPath });
      await remote.assertTargetRef({ expectedSha: plan.target.sha, ref: plan.target.ref, repo: plan.repo });
      let entry = state.prs[index];
      const base = index === 0 ? plan.delivery_branch : state.created_layers[index - 1].branch;
      if (entry && (entry.layer_id !== layer.id || entry.branch !== layer.branch || entry.base !== base)) {
        throw new Error(`partial publication receipt changed for ${layer.id}`);
      }
      await remote.pushBranch({ branch: layer.branch, expectedSha: layer.head_sha, repo: plan.repo });
      await reconcileOrStale({ plan, planPath });
      const created = await remote.createPullRequest({
        base, draft: true, head: layer.branch, repo: plan.repo, title: plan.layers[index].title,
        body: stackPrBody(plan, index),
      });
      if (entry) {
        if (String(created.id) !== String(entry.id)) {
          throw new Error(`remote PR identity changed for ${layer.id}`);
        }
      } else {
        entry = { layer_id: layer.id, branch: layer.branch, base, id: created.id, url: created.url, status: "created" };
        state.prs.push(entry); await atomicJson(statePath, state);
      }
    }
    state.status = "published"; state.error = null; await atomicJson(statePath, state);
    return { prs: state.prs, statePath };
  } catch (error) {
    state.status = "publish_failed"; state.error = error.message; await atomicJson(statePath, state).catch(() => {});
    throw new Error(`${error.message}; partial publication manifest: ${statePath}`);
  }
  } finally { await release(); }
}

export async function registerLayerReview({
  env = process.env,
  layerId,
  planPath,
  reviewManifestPath,
  statePath = `${planPath}.state.json`,
}) {
  const plan = JSON.parse(await readFile(planPath));
  await requireApprovedPlan(plan);
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
    const state = JSON.parse(await readFile(statePath));
    await requireValidContract(state, "stack state");
    requireStackStateIdentity(state, plan);
    await assertBuiltStackState(plan, state);
    const layer = state.created_layers.find(({ id }) => id === layerId);
    if (!layer) throw new Error(`stack generation omits layer ${layerId}`);
    const canonicalPath = await realpath(reviewManifestPath);
    await assertRegisteredReview({ env, manifestPath: canonicalPath });
    const bytes = await readFile(canonicalPath);
    const review = JSON.parse(bytes);
    await requireValidContract(review, "layer review manifest");
    if (
      review.repo !== plan.repo || review.review.status !== "approved" ||
      review.review.reviewed_head_sha !== layer.head_sha || review.head.sha !== layer.head_sha
    ) throw new Error(`layer ${layerId} review does not approve its active head`);
    for (const event of review.review.events) {
      const evidence = await readFile(event.evidence.path);
      if (sha256(evidence) !== event.evidence.sha256) {
        throw new Error(`layer ${layerId} review event evidence changed`);
      }
    }
    const path = canonicalPath;
    const digest = sha256(bytes);
    if (
      layer.review_manifest &&
      (layer.review_manifest !== path || layer.review_manifest_sha256 !== digest)
    ) throw new Error(`layer ${layerId} already has different review authority`);
    layer.review_manifest = path;
    layer.review_manifest_sha256 = digest;
    await atomicJson(statePath, state);
    return { layerId, reviewManifestPath: path, sha256: digest, statePath };
  } finally { await release(); }
}

async function assertRegisteredReview({ env, manifestPath }) {
  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  const registryPath = env.TUICR_REVIEWS_FILE?.trim() ||
    (stateHome ? join(stateHome, "dotfiles", "tuicr-reviews.jsonl") : null);
  if (!registryPath) throw new Error("review registration requires the tuicr registry");
  const entries = (await readFile(registryPath, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
  const matches = [];
  for (const entry of entries.filter(({ kind }) => kind === "manifest")) {
    try {
      if (await realpath(entry.manifest) === manifestPath) matches.push(entry);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (matches.length !== 1) {
    throw new Error("review manifest must have exactly one canonical tuicr registry entry");
  }
}

export async function assertBuiltStackState(plan, state) {
  requireStackStateIdentity(state, plan);
  if (!new Set(["built", "published", "publish_failed"]).has(state.status)) {
    throw new Error("stack state is not a completed build");
  }
  if (state.created_layers.length !== plan.layers.length) {
    throw new Error("stack state does not contain every approved layer");
  }
  let parent = plan.target.sha;
  const activeGeneration = state.active_generation ?? state.generation;
  const activeRestack = activeGeneration === state.generation
    ? null
    : state.restacks?.find(({ generation }) => generation === activeGeneration);
  if (activeGeneration !== state.generation && !activeRestack) {
    throw new Error("stack state active generation lacks a restack receipt");
  }
  const expectedActiveLayers = activeRestack
    ? [...activeRestack.prefix, activeRestack.owning_layer, ...activeRestack.suffix]
    : null;
  for (const [index, layer] of state.created_layers.entries()) {
    const approved = plan.layers[index];
    if (
      layer.id !== approved.id ||
      (expectedActiveLayers
        ? !sameLayerReceipt(layer, expectedActiveLayers[index])
        : layer.branch !== approved.branch) ||
      layer.parent_sha !== parent
    ) throw new Error(`stack state layer ${index + 1} differs from the approved topology`);
    const live = await git(plan.repo, "rev-parse", `refs/heads/${layer.branch}^{commit}`);
    if (live !== layer.head_sha || !(await isAncestor(plan.repo, parent, live))) {
      throw new Error(`stack state layer ${layer.id} differs from Git`);
    }
    parent = live;
  }
  const [finalTree, sourceTree] = await Promise.all([
    git(plan.repo, "rev-parse", `${parent}^{tree}`),
    git(plan.repo, "rev-parse", `${plan.source.sha}^{tree}`),
  ]);
  if (
    state.final_head_sha !== parent || state.final_tree_sha !== finalTree ||
    (activeRestack === null && finalTree !== sourceTree) ||
    (activeRestack !== null && (
      state.reviewed_source_sha !== parent || activeRestack.final_head_sha !== parent ||
      activeRestack.final_tree_sha !== finalTree
    ))
  ) throw new Error("stack state final assembly is not the approved source tree");
}

export async function retargetNextLayer({ assembledLayerIndex, planPath, remote, statePath = `${planPath}.state.json` }) {
  const plan = JSON.parse(await readFile(planPath));
  await requireApprovedPlan(plan);
  const release = await acquireFileLock(`${statePath}.lock`);
  try {
  const state = JSON.parse(await readFile(statePath));
  await requireValidContract(state, "stack state");
  requireStackStateIdentity(state, plan);
  const next = state.prs?.[assembledLayerIndex + 1];
  if (!next) return { changed: false, reason: "no next layer" };
  await reconcileOrStale({ plan, planPath });
  await remote.assertTargetRef({ expectedSha: plan.target.sha, ref: plan.target.ref, repo: plan.repo });
  await remote.retargetPullRequest({ id: next.id, base: plan.delivery_branch, repo: plan.repo });
  next.base = plan.delivery_branch; await atomicJson(statePath, state);
  return { changed: true, id: next.id, base: next.base };
  } finally { await release(); }
}

async function requireApprovedPlan(plan) {
  const validation = await validateStackPlan(plan);
  if (!validation.valid) throw new Error(`stack plan is invalid: ${validation.errors[0]?.message}`);
  if (plan.approval.status !== "approved" || plan.approval.plan_fingerprint !== plan.plan_fingerprint) {
    throw new Error("stack generation requires human approval of this exact plan");
  }
}

function requireStackStateIdentity(state, plan) {
  if (
    state.run_id !== plan.run_id || state.generation !== plan.generation ||
    state.plan_fingerprint !== plan.plan_fingerprint
  ) throw new Error("stack state belongs to another approved generation");
}

async function materializeLayerTree({ index, plan, worktree }) {
  const assignments = cumulativeAssignments(plan.layers.slice(0, index + 1));
  const current = plan.layers[index];
  for (const change of current.changes) {
    const all = assignments.get(change.path);
    if (change.change_type === "D") {
      await git(worktree, "rm", "--", change.path); continue;
    }
    if (["A", "B", "R"].includes(change.change_type) || all.some(({ hunks }) => hunks === "all")) {
      await git(worktree, "checkout", plan.source.sha, "--", change.path);
      if (change.change_type === "R" && change.old_path) await git(worktree, "rm", "--ignore-unmatch", "--", change.old_path);
      continue;
    }
    const hunks = [...new Set(all.flatMap(({ hunks }) => hunks))].sort((a, b) => a - b);
    await reconstructFile({ hunks, path: change.path, plan, worktree });
  }
}

async function reconstructFile({ hunks, path, plan, worktree }) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-hunk-"));
  try {
    const base = join(directory, "base"); const diffPath = join(directory, "diff");
    await writeFile(base, await gitRaw(plan.repo, "show", `${plan.target.sha}:${path}`));
    await writeFile(diffPath, await gitRaw(plan.repo, "diff", "--no-ext-diff", plan.target.sha, plan.source.sha, "--", path));
    await execFile("python3", [SPLIT_SCRIPT, "reconstruct", "--base-file", base, "--diff-file", diffPath, "--hunks", hunks.join(","), "--output", join(worktree, path)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function validateAssignments(plan, analysis, errors) {
  const ids = plan.layers.map(({ id }) => id);
  const branches = plan.layers.map(({ branch }) => branch);
  if (new Set(ids).size !== ids.length || new Set(branches).size !== branches.length) {
    errors.push({ instancePath: "/layers", keyword: "layerIdentity", message: "layer IDs and branches must be unique" });
  }
  if (branches.includes(plan.source.ref) || branches.includes(plan.target.ref)) {
    errors.push({ instancePath: "/layers", keyword: "protectedRef", message: "layer branches must not reuse source or target refs" });
  }
  const byPath = new Map();
  for (const [layerIndex, layer] of plan.layers.entries()) {
    for (const [changeIndex, change] of layer.changes.entries()) {
      const list = byPath.get(change.path) ?? [];
      list.push({ ...change, layerIndex, changeIndex }); byPath.set(change.path, list);
    }
  }
  const files = new Map(analysis.files.map((file) => [file.path, file]));
  for (const path of byPath.keys()) if (!files.has(path)) {
    errors.push({ instancePath: "/layers", keyword: "diffCoverage", message: `assigns unchanged path ${path}` });
  }
  for (const file of analysis.files) {
    const assignments = byPath.get(file.path) ?? [];
    if (assignments.length === 0) {
      errors.push({ instancePath: "/layers", keyword: "diffCoverage", message: `omits changed path ${file.path}` }); continue;
    }
    const expectedType = file.is_binary ? "B" : file.change_type;
    if (assignments.some(({ change_type: type, old_path: oldPath }) =>
      type !== expectedType || (file.change_type === "R" && oldPath !== file.old_path)
    )) {
      errors.push({ instancePath: "/layers", keyword: "changeIdentity", message: `misstates change identity for ${file.path}` });
    }
    const all = assignments.filter(({ hunks }) => hunks === "all");
    if (all.length > 0) {
      if (assignments.length !== 1) errors.push({ instancePath: "/layers", keyword: "hunkCoverage", message: `duplicates whole-file assignment for ${file.path}` });
      continue;
    }
    const hunks = assignments.flatMap(({ hunks }) => hunks);
    const expected = Array.from({ length: file.hunk_count }, (_, index) => index);
    if (!sameSet(hunks, expected) || hunks.length !== new Set(hunks).size) {
      errors.push({ instancePath: "/layers", keyword: "hunkCoverage", message: `must assign every hunk of ${file.path} exactly once` });
    }
  }
}

async function reconcileOrStale({ plan, planPath }) {
  try { await assertLiveIdentity(plan); }
  catch (error) {
    plan.approval.status = "stale"; await atomicJson(planPath, plan); throw error;
  }
}
async function assertLiveIdentity(plan) {
  const [source, target] = await Promise.all([
    git(plan.repo, "rev-parse", `${plan.source.ref}^{commit}`),
    git(plan.repo, "rev-parse", `${plan.target.ref}^{commit}`),
  ]);
  if (source !== plan.source.sha || target !== plan.target.sha) {
    throw new Error("stack source or target moved; generation is stale and requires new approval");
  }
}
async function loadStackState(path, plan) {
  try {
    const state = JSON.parse(await readFile(path));
    await requireValidContract(state, "stack state");
    if (state.run_id !== plan.run_id || state.generation !== plan.generation || state.plan_fingerprint !== plan.plan_fingerprint) {
      throw new Error("stack state belongs to another generation");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      schema: "agent-flow.stack-state/v1", run_id: plan.run_id, generation: plan.generation,
      active_generation: plan.generation, reviewed_source_sha: null,
      plan_fingerprint: plan.plan_fingerprint, status: "building", created_layers: [],
      final_head_sha: null, final_tree_sha: null, prs: [], rollback_actions: [], error: null,
    };
  }
}
async function verifyStackCommands({ commands, head, repo }) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-stack-verify-"));
  try {
    await execFile("git", ["-C", repo, "worktree", "add", "--detach", directory, head]);
    for (const { argv } of commands) {
      await execFile(argv[0], argv.slice(1), {
        cwd: directory, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      });
    }
  } finally {
    await execFile("git", ["-C", repo, "worktree", "remove", "--force", directory]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
function cumulativeAssignments(layers) {
  const result = new Map();
  for (const layer of layers) for (const change of layer.changes) {
    const list = result.get(change.path) ?? []; list.push(change); result.set(change.path, list);
  }
  return result;
}
function ownedPaths(layer) {
  return [...new Set(layer.changes.flatMap(({ path, old_path: old }) => old ? [path, old] : [path]))].sort();
}
async function changedPaths(repo, from, to) {
  return (await git(repo, "diff", "--name-only", "--no-renames", from, to)).split("\n").filter(Boolean).sort();
}
async function changedLineRanges(repo, from, to, side) {
  const patch = await gitRaw(repo, "diff", "--no-ext-diff", "--no-renames", "--unified=0", from, to);
  const ranges = [];
  let path = null;
  for (const line of patch.toString("utf8").split("\n")) {
    if (line.startsWith("+++ b/")) path = line.slice(6);
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match || path === null) continue;
    const start = Number(side === "old" ? match[1] : match[3]);
    const count = Number((side === "old" ? match[2] : match[4]) ?? 1);
    ranges.push({ path, start, end: start + count - 1, empty: count === 0 });
  }
  return ranges;
}
function rangesOverlap(left, right) {
  if (left.empty && right.empty) return left.start === right.start;
  if (left.empty) return right.start <= left.start && left.start <= right.end;
  if (right.empty) return left.start <= right.start && right.start <= left.end;
  return left.start <= right.end && right.start <= left.end;
}
function sameLayerReceipt(left, right) {
  return ["id", "branch", "parent_sha", "head_sha", "replayed_from"]
    .every((key) => left[key] === right[key]);
}
async function runAnalyze(diff) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SPLIT_SCRIPT, "analyze"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject); child.on("close", (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8")));
      else resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
    });
    child.stdin.end(diff);
  });
}
async function applyPatch(cwd, patch) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "apply", "--index", "--binary", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
    child.stdin.end(patch);
  });
}
async function assertCommit(repo, sha) { await git(repo, "cat-file", "-e", `${sha}^{commit}`); }
async function isAncestor(repo, ancestor, descendant) {
  try { await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
async function atomicJson(path, document) {
  await requireValidContract(document, "durable stack document");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`; let done = false;
  try { await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); done = true; }
  finally { if (!done) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}
async function requireValidContract(document, label) {
  const validation = await validateContract(document);
  if (!validation.valid) throw new Error(`${label} is invalid: ${validation.errors[0]?.message}`);
}
function sameSet(left, right) { return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stackPrBody(plan, index) {
  return `## Summary\n\nLayer ${index + 1} of ${plan.layers.length}: ${plan.layers[index].title}\n\n## Stack\n\nGeneration ${plan.generation} - ${plan.plan_fingerprint}\n\n## Test plan\n\n${plan.verification.map(({ argv }) => `- [ ] \`${argv.join(" ")}\``).join("\n")}\n`;
}
async function git(cwd, ...args) { return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })).stdout.trim(); }
async function gitRaw(cwd, ...args) { return (await execFile("git", ["-C", cwd, ...args], { maxBuffer: 20 * 1024 * 1024 })).stdout; }
