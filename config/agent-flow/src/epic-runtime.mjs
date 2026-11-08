import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { acquireFileLock } from "./file-lock.mjs";
import { loadCompletedGateEvidence } from "./completed-evidence.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { parseExternalRef } from "./external-root.mjs";
import { planReadyWave, reconcileEpicTarget, validateFeatureDependencies } from "./epic-control.mjs";
import {
  launchEpicControlPlane,
  materializeEpicTransition,
} from "./epic-launch.mjs";
import { launchFeature } from "./feature-launch.mjs";
import { acquireExternalOwnershipLock } from "./run-lock.mjs";
import { assertExternalOwnershipAvailable } from "./run-ownership.mjs";
import { validateContract } from "./schema-validator.mjs";
import { hasTerminalCompletedAttempt } from "./run-terminal.mjs";

const execFile = promisify(execFileCallback);

export async function initializeEpic({
  adapter = null,
  env = process.env,
  implementationRevision = null,
  manifestPath,
  now = () => new Date(),
  runDoctor,
}) {
  const bytes = await readFile(manifestPath);
  const epic = JSON.parse(bytes);
  await requireValid(epic, "epic manifest");
  validateFeatureDependencies(epic.features);
  const repository = await realpath(epic.repo);
  const [base, target] = await Promise.all([
    git(repository, "rev-parse", `${epic.source.base_ref}^{commit}`),
    git(repository, "rev-parse", `${epic.target.ref}^{commit}`),
  ]);
  if (base !== epic.source.base_sha) throw new Error("epic source base moved from its pinned SHA");
  if (target !== epic.target.sha) throw new Error("epic target moved before launch");
  const stateHome = stateDirectory(env);
  const runDirectory = join(stateHome, "agent-flow", "runs", epic.run_id);
  const release = await acquireFileLock(join(stateHome, "agent-flow", "locks", `${epic.run_id}.lock`));
  let releaseOwnership = null;
  try {
    const resolvedAdapter = adapter ?? new HermesAdapter({ board: epic.kanban.board });
    const externalRoot = parseExternalRef(epic.external_ref);
    releaseOwnership = await acquireExternalOwnershipLock({
      externalRoot, repositoryPath: repository, stateHome,
    });
    await assertExternalOwnershipAvailable({
      adapterForBoard: (board) => board === epic.kanban.board
        ? resolvedAdapter
        : new HermesAdapter({ board }),
      currentRunId: epic.run_id,
      externalRoot,
      repositoryPath: repository,
      stateHome,
      supersedes: epic.supersedes ?? null,
    });
    const sourceWorktree = await ensureSourceWorktree({ epic, repository, stateHome });
    const control = await launchEpicControlPlane({
      adapter: resolvedAdapter, epic, epicBytes: bytes, implementationRevision, now, repository,
      runDirectory, runDoctor, sourceWorktree,
    });
    const statePath = join(runDirectory, "epic-state.json");
    try {
      const state = JSON.parse(await readFile(statePath));
      await requireValid(state, "epic state");
      if (
        state.run_id !== epic.run_id || state.epic_sha256 !== sha256(bytes) ||
        state.repository !== repository || state.source_worktree !== sourceWorktree ||
        state.run_manifest_path !== control.runManifestPath ||
        state.epic_root_task_id !== control.rootTaskId
      ) throw new Error("existing epic state has a different launch authority");
      return {
        resumed: true, rootTaskId: control.rootTaskId, runDirectory,
        runManifestPath: control.runManifestPath, sourceWorktree, statePath,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(join(runDirectory, "inputs", "features"), { recursive: true, mode: 0o700 });
    const sealedEpic = join(runDirectory, "inputs", "epic.json");
    const state = {
      schema: "agent-flow.epic-state/v1",
      run_id: epic.run_id,
      repository,
      epic_path: sealedEpic,
      epic_sha256: sha256(bytes),
      run_manifest_path: control.runManifestPath,
      epic_root_task_id: control.rootTaskId,
      source_ref: `refs/heads/${epic.source.branch}`,
      source_worktree: sourceWorktree,
      recorded_target_sha: epic.target.sha,
      stack_generation: 0,
      features: Object.fromEntries(epic.features.map(({ id }) => [id, {
        status: "pending", child_run_id: null, manifest_path: null,
        root_task_id: null, worktree: null, error: null,
      }])),
      stack_checkpoints: [],
    };
    await atomicJson(statePath, state);
    return {
      resumed: false, rootTaskId: control.rootTaskId, runDirectory,
      runManifestPath: control.runManifestPath, sourceWorktree, statePath,
    };
  } finally {
    if (releaseOwnership) await releaseOwnership();
    await release();
  }
}

export async function materializeEpicWave({
  adapter = null,
  env = process.env,
  externalAdapter = null,
  implementationRevision = null,
  launchFeatureRun = launchFeature,
  runDoctor,
  runId,
}) {
  const loaded = await loadEpic({ env, runId });
  const release = await acquireFileLock(join(loaded.runDirectory, ".epic-wave.lock"));
  try {
    const { epic, state } = await reloadEpic(loaded);
    const resolvedAdapter = adapter ?? new HermesAdapter({ board: epic.kanban.board });
    await reconstructFeatureProjection({
      adapter: resolvedAdapter, epic, state, stateHome: stateDirectory(env),
    });
    const statuses = Object.fromEntries(Object.entries(state.features).map(([id, value]) => [id, value.status]));
    const ready = planReadyWave({
      features: epic.features,
      statuses,
      maxStreams: epic.limits.max_feature_streams,
    });
    const sourceSha = await git(state.source_worktree, "rev-parse", "HEAD");
    const results = [];
    for (const id of ready) {
      const feature = epic.features.find((candidate) => candidate.id === id);
      const childRunId = `${epic.run_id}.${id}`;
      if (childRunId.length > 128) throw new Error(`child run ID is too long: ${childRunId}`);
      const child = {
        schema: "agent-flow.feature/v1", run_id: childRunId,
        parent_run_id: epic.run_id, summary: feature.summary,
        repo: state.repository,
        base: { branch: epic.source.branch, sha: sourceSha },
        branch: `agent-flow/${epic.run_id}/${id}`,
        kanban: { board: epic.kanban.board, task: epic.kanban.task }, external_ref: null,
        acceptance: feature.acceptance, slices: feature.slices, verification: feature.verification,
        limits: {
          max_slice_retries: epic.limits.max_slice_retries,
          max_completeness_fixes: epic.limits.max_completeness_fixes,
          max_critique_fixes: epic.limits.max_critique_fixes,
          max_elapsed_seconds: epic.limits.max_elapsed_seconds,
        },
      };
      const path = join(loaded.runDirectory, "inputs", "features", `${id}.json`);
      await writeFile(path, `${JSON.stringify(child, null, 2)}\n`, { mode: 0o600, flag: "wx" })
        .catch(async (error) => {
          if (error.code !== "EEXIST") throw error;
          const existing = JSON.parse(await readFile(path));
          if (JSON.stringify(existing) !== JSON.stringify(child)) {
            throw new Error(`sealed child feature ${id} changed across resume`);
          }
        });
      try {
        const launched = await launchFeatureRun({
          adapter: resolvedAdapter, env, implementationRevision, manifestPath: path, runDoctor,
        });
        Object.assign(state.features[id], {
          status: "materialized", child_run_id: childRunId, manifest_path: path,
          root_task_id: launched.rootTaskId, worktree: launched.worktree, error: null,
        });
        results.push({ id, status: "materialized", ...launched });
      } catch (error) {
        Object.assign(state.features[id], { status: "blocked", error: error.message, manifest_path: path });
        results.push({ id, status: "blocked", error: error.message });
      }
      await atomicJson(loaded.statePath, state);
    }
    if (externalAdapter) {
      await externalAdapter.upsertProgress({
        externalRef: epic.external_ref,
        progress: epicProgress(runId, state.features),
      });
    }
    return { ready, results, runId, sourceSha };
  } finally {
    await release();
  }
}

async function reconstructFeatureProjection({ adapter, epic, state, stateHome }) {
  for (const [featureId, projected] of Object.entries(state.features)) {
    if (projected.integration_receipt) {
      if (!projected.child_run_id) {
        throw new Error(`integration receipt for ${featureId} lacks child run authority`);
      }
      const expectedReceipt = join(
        stateHome, "agent-flow", "runs", epic.run_id, "receipts", "integration",
        `${projected.child_run_id}.json`,
      );
      if (resolve(projected.integration_receipt) !== resolve(expectedReceipt)) {
        throw new Error(`integration receipt for ${featureId} is not canonical`);
      }
      const receipt = JSON.parse(await readFile(projected.integration_receipt));
      await requireValid(receipt, `integration receipt for ${featureId}`);
      const sourceHead = await git(state.repository, "rev-parse", state.source_ref);
      const receiptTree = await git(state.repository, "rev-parse", `${receipt.resulting_commit_sha}^{tree}`);
      if (receipt.review_run_id !== projected.child_run_id) {
        throw new Error(`integration receipt for ${featureId} names another child run`);
      }
      if (receipt.repository !== state.repository || receipt.target_ref !== state.source_ref) {
        throw new Error(`integration receipt for ${featureId} names another source`);
      }
      if (receipt.resulting_tree_sha !== receiptTree) {
        throw new Error(`integration receipt for ${featureId} has another tree`);
      }
      if (!(await isAncestor(state.repository, receipt.resulting_commit_sha, sourceHead))) {
        throw new Error(`integration receipt for ${featureId} is not on epic source`);
      }
      projected.status = "integrated";
      projected.error = null;
      continue;
    }
    if (!projected.child_run_id || !projected.manifest_path || !projected.root_task_id) {
      if (projected.status !== "pending" && projected.status !== "blocked") {
        throw new Error(`epic feature ${featureId} has lifecycle state without child authority`);
      }
      projected.status = "pending";
      continue;
    }
    const childDirectory = join(stateHome, "agent-flow", "runs", projected.child_run_id);
    try {
      const childRun = JSON.parse(await readFile(join(childDirectory, "run.json")));
      await requireValid(childRun, `child run ${projected.child_run_id}`);
      if (
        childRun.identity.flow !== "feature" ||
        childRun.identity.parent_run_id !== epic.run_id ||
        childRun.identity.repository.path !== state.repository ||
        projected.child_run_id !== `${epic.run_id}.${featureId}` ||
        resolve(projected.manifest_path) !== resolve(join(
          stateHome, "agent-flow", "runs", epic.run_id, "inputs", "features", `${featureId}.json`,
        ))
      ) throw new Error(`child run ${projected.child_run_id} is not bound to epic ${epic.run_id}`);
      const materialization = JSON.parse(await readFile(join(childDirectory, "materialization.json")));
      if (materialization.tasks?.["feature-root"] !== projected.root_task_id) {
        throw new Error(`child run ${projected.child_run_id} root differs from epic projection`);
      }
      const root = await adapter.getTaskLifecycle({ taskId: projected.root_task_id });
      if (root.status === "done" && hasTerminalCompletedAttempt(root)) {
        const reviewPath = join(childRun.identity.artifact_directory, "review.json");
        try {
          const review = JSON.parse(await readFile(reviewPath));
          await requireValid(review, `child review ${projected.child_run_id}`);
          projected.status = new Set(["review_ready", "reviewing", "approved"]).has(review.review.status)
            ? "review_ready"
            : "running";
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          projected.status = "running";
        }
      } else if (root.status === "blocked") {
        projected.status = "blocked";
      } else {
        projected.status = "running";
      }
      projected.error = null;
    } catch (error) {
      if (error.code === "ENOENT" && projected.status === "materialized") continue;
      throw error;
    }
  }
}

export async function recordEpicFeatureStatus({ env = process.env, featureId, runId, status }) {
  const allowed = new Set(["running", "review_ready", "blocked"]);
  if (!allowed.has(status)) throw new Error(`unknown epic feature status: ${status}`);
  const loaded = await loadEpic({ env, runId });
  const release = await acquireFileLock(join(loaded.runDirectory, ".epic-wave.lock"));
  try {
    const { state } = await reloadEpic(loaded);
    if (!state.features[featureId]) throw new Error(`unknown epic feature: ${featureId}`);
    state.features[featureId].status = status;
    state.features[featureId].error = null;
    await atomicJson(loaded.statePath, state);
    return { featureId, runId, status };
  } finally { await release(); }
}

export async function checkpointEpicTarget({ adapter = null, env = process.env, now = () => new Date(), runId }) {
  const loaded = await loadEpic({ env, runId });
  const release = await acquireFileLock(join(loaded.runDirectory, ".epic-wave.lock"));
  try {
    const { epic, state } = await reloadEpic(loaded);
    const resolvedAdapter = adapter ?? new HermesAdapter({ board: epic.kanban.board });
    await reconstructFeatureProjection({
      adapter: resolvedAdapter, epic, state, stateHome: stateDirectory(env),
    });
    const incomplete = Object.entries(state.features)
      .filter(([, feature]) => feature.status !== "integrated")
      .map(([id]) => id);
    if (incomplete.length > 0) {
      await atomicJson(loaded.statePath, state);
      return { action: "feature_work_required", features: incomplete, runId };
    }
    const [manifest, materialization] = await Promise.all([
      readFile(join(loaded.runDirectory, "run.json"), "utf8").then(JSON.parse),
      readFile(join(loaded.runDirectory, "materialization.json"), "utf8").then(JSON.parse),
    ]);
    await assertEpicGatePassed({
      adapter: resolvedAdapter, manifest, materialization, stage: "source-verification",
    });
    const [liveTarget, sourceSha] = await Promise.all([
      git(state.repository, "rev-parse", `${epic.target.ref}^{commit}`),
      git(state.source_worktree, "rev-parse", "HEAD"),
    ]);
    const pending = state.stack_checkpoints.find((checkpoint) =>
      checkpoint.status === "source_refresh_required" &&
      checkpoint.prior_target_sha === state.recorded_target_sha &&
      checkpoint.target_sha === liveTarget
    );
    if (pending) {
      if (!(await isAncestor(state.repository, pending.source_sha, sourceSha))) {
        throw new Error("epic source moved outside its pending source-refresh generation");
      }
      const finalStage = `validate-handoff:source-refresh-review:${pending.generation}`;
      const finalTaskId = materialization.tasks?.[finalStage];
      if (typeof finalTaskId === "string") {
        const lifecycle = await resolvedAdapter.getTaskLifecycle({ taskId: finalTaskId });
        if (lifecycle.status === "done" && hasTerminalCompletedAttempt(lifecycle)) {
          await assertEpicGatePassed({
            adapter: resolvedAdapter, manifest, materialization,
            stage: `source-refresh-gate:${pending.generation}`,
          });
          await assertEpicSemanticPassed({
            adapter: resolvedAdapter, manifest, materialization,
            stage: `source-refresh-review:${pending.generation}`,
          });
          if (!(await isAncestor(state.repository, liveTarget, sourceSha))) {
            throw new Error("completed source refresh does not contain the live target");
          }
          const status = await git(state.source_worktree, "status", "--porcelain=v1", "--untracked-files=all");
          if (status) throw new Error("completed source refresh left the epic source worktree dirty");
          await runVerification({ commands: epic.verification, worktree: state.source_worktree });
          pending.status = "source_refresh_complete";
          pending.completed_at = now().toISOString();
          pending.completed_source_sha = sourceSha;
          state.recorded_target_sha = liveTarget;
          await atomicJson(loaded.statePath, state);
          return {
            action: "current", generation: pending.generation, runId,
            sourceSha, targetSha: liveTarget,
          };
        }
      }
      const materialized = await materializeEpicTransition({
        adapter: resolvedAdapter,
        context: {
          priorSourceSha: sourceSha,
          priorTargetSha: state.recorded_target_sha,
          targetSha: liveTarget,
        },
        ordinal: pending.generation,
        runDirectory: loaded.runDirectory,
        transitionKey: "source-refresh",
      });
      return {
        action: "source_refresh", generation: pending.generation,
        priorSourceSha: sourceSha, priorTargetSha: state.recorded_target_sha,
        requires: ["builder", "gate", "automated_review", "source_verification"],
        runId, sourceSha, targetSha: liveTarget, ...materialized,
      };
    }
    const result = reconcileEpicTarget({
      recordedTarget: state.recorded_target_sha,
      liveTarget,
      sourceSha,
      generation: state.stack_generation,
    });
    if (result.action === "source_refresh") {
      state.stack_generation = result.generation;
      state.stack_checkpoints.push({
        generation: result.generation, source_sha: sourceSha,
        prior_target_sha: state.recorded_target_sha, target_sha: liveTarget,
        status: "source_refresh_required",
      });
      await atomicJson(loaded.statePath, state);
      const materialized = await materializeEpicTransition({
        adapter,
        context: {
          priorSourceSha: result.priorSourceSha,
          priorTargetSha: result.priorTargetSha,
          targetSha: result.targetSha,
        },
        ordinal: result.generation,
        runDirectory: loaded.runDirectory,
        transitionKey: "source-refresh",
      });
      return { runId, ...result, ...materialized };
    }
    return { runId, ...result };
  } finally { await release(); }
}

async function runVerification({ commands, worktree }) {
  for (const { argv } of commands) {
    try {
      await execFile(argv[0], argv.slice(1), {
        cwd: worktree, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`epic source refresh verification failed: ${argv.join(" ")}`, { cause: error });
    }
  }
}

async function assertEpicGatePassed({ adapter, manifest, materialization, stage }) {
  const suffix = `/${stage.replaceAll(":", "--")}.json`;
  const input = manifest.inputs.find(({ kind, sealed_path: path }) =>
    kind === "gate" && path.endsWith(suffix)
  );
  if (!input) throw new Error(`epic run omits sealed gate ${stage}`);
  const gate = JSON.parse(await readFile(input.sealed_path));
  const evidence = await loadCompletedGateEvidence({
    adapter, gate, manifest, materialization, stage,
  });
  if (!evidence.passed) throw new Error(`epic gate ${stage} did not pass`);
}

async function assertEpicSemanticPassed({ adapter, manifest, materialization, stage }) {
  const taskId = materialization.tasks?.[stage];
  if (typeof taskId !== "string") throw new Error(`epic materialization omits ${stage}`);
  const attempt = await adapter.getTerminalCompletedAttempt({ taskId });
  const handoff = attempt.metadata?.handoff ?? null;
  const validation = await validateContract(handoff);
  if (
    !validation.valid || handoff.run_id !== manifest.identity.run_id ||
    handoff.flow !== "epic" || handoff.stage !== stage || handoff.passed !== true
  ) throw new Error(`epic semantic stage ${stage} lacks a terminal passed verdict`);
}

async function ensureSourceWorktree({ epic, repository, stateHome }) {
  const path = join(stateHome, "agent-flow", "worktrees", `${epic.run_id}-source`);
  try {
    await access(path);
    if (await git(path, "symbolic-ref", "--short", "HEAD") !== epic.source.branch) {
      throw new Error("existing epic source worktree is on another branch");
    }
    const [worktreeCommonRaw, repositoryCommonRaw] = await Promise.all([
      git(path, "rev-parse", "--git-common-dir"),
      git(repository, "rev-parse", "--git-common-dir"),
    ]);
    const worktreeCommon = await realpath(isAbsolute(worktreeCommonRaw)
      ? worktreeCommonRaw
      : resolve(path, worktreeCommonRaw));
    const repositoryCommon = await realpath(isAbsolute(repositoryCommonRaw)
      ? repositoryCommonRaw
      : resolve(repository, repositoryCommonRaw));
    if (worktreeCommon !== repositoryCommon) {
      throw new Error("existing epic source worktree belongs to another repository");
    }
    const [worktreeHead, sourceHead, status] = await Promise.all([
      git(path, "rev-parse", "HEAD"),
      git(repository, "rev-parse", `refs/heads/${epic.source.branch}^{commit}`),
      git(path, "status", "--porcelain=v1", "--untracked-files=all"),
    ]);
    if (worktreeHead !== sourceHead) {
      throw new Error("existing epic source worktree is detached from its sealed source ref");
    }
    if (status) throw new Error("existing epic source worktree is not clean");
    return realpath(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let exists = true;
  try { await git(repository, "show-ref", "--verify", `refs/heads/${epic.source.branch}`); }
  catch { exists = false; }
  if (exists) {
    if (await git(repository, "rev-parse", `${epic.source.branch}^{commit}`) !== epic.source.base_sha) {
      throw new Error("epic source branch has a different launch identity");
    }
    await execFile("git", ["-C", repository, "worktree", "add", path, epic.source.branch]);
  } else {
    await execFile("git", ["-C", repository, "worktree", "add", "-b", epic.source.branch, path, epic.source.base_sha]);
  }
  return realpath(path);
}

async function loadEpic({ env, runId }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error("invalid epic run ID");
  const runDirectory = join(stateDirectory(env), "agent-flow", "runs", runId);
  return { runDirectory, statePath: join(runDirectory, "epic-state.json") };
}
async function reloadEpic(loaded) {
  const state = JSON.parse(await readFile(loaded.statePath));
  await requireValid(state, "epic state");
  const bytes = await readFile(state.epic_path);
  if (sha256(bytes) !== state.epic_sha256) throw new Error("sealed epic manifest changed");
  const epic = JSON.parse(bytes);
  await requireValid(epic, "sealed epic manifest");
  validateFeatureDependencies(epic.features);
  const expectedFeatures = epic.features.map(({ id }) => id).sort();
  const actualFeatures = Object.keys(state.features).sort();
  if (
    state.run_id !== epic.run_id || state.repository !== await realpath(epic.repo) ||
    state.source_ref !== `refs/heads/${epic.source.branch}` ||
    JSON.stringify(actualFeatures) !== JSON.stringify(expectedFeatures)
  ) throw new Error("epic state identity differs from its sealed manifest");
  return { epic, state };
}
function epicProgress(runId, features) {
  const values = Object.values(features);
  return {
    run_id: runId,
    complete: values.filter(({ status }) => status === "integrated").length,
    running: values.filter(({ status }) => ["materialized", "running"].includes(status)).length,
    blocked: values.filter(({ status }) => status === "blocked").length,
    review: values.filter(({ status }) => ["review_ready", "approved"].includes(status)).length,
  };
}
function stateDirectory(env) {
  const value = env.XDG_STATE_HOME?.trim() || (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!value) throw new Error("HOME or XDG_STATE_HOME is required");
  return value;
}
async function atomicJson(path, document) {
  await requireValid(document, "epic state");
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let done = false;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path); done = true;
  } finally {
    if (!done) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
async function requireValid(document, label) {
  const validation = await validateContract(document);
  if (!validation.valid) throw new Error(`${label} is invalid: ${validation.errors[0]?.message}`);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}
async function isAncestor(repo, ancestor, descendant) {
  try {
    await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
