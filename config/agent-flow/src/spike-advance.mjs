import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { acquireFileLock } from "./file-lock.mjs";
import {
  loadCompletedEvidence,
  loadCompletedGateEvidence,
} from "./completed-evidence.mjs";
import { instantiateTransition } from "./graph-transition.mjs";
import { formatTaskAuthority, HermesAdapter, parseTaskAuthority } from "./hermes-adapter.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { validateContract } from "./schema-validator.mjs";

export function decideSpikeRevision({ gaps, used, cap, retainedEvidence = [] }) {
  if (!Array.isArray(gaps) || !Array.isArray(retainedEvidence)) {
    throw new Error("spike gap decisions require arrays");
  }
  if (!Number.isInteger(used) || used < 0 || !Number.isInteger(cap) || cap < 0) {
    throw new Error("spike revision counts must be non-negative integers");
  }
  const retained = [...new Set(retainedEvidence)];
  if (gaps.length === 0) return { action: "synthesize", residualGaps: [], retainedEvidence: retained };
  if (used >= cap) return { action: "synthesize", residualGaps: gaps, retainedEvidence: retained };
  const gap = gaps[0];
  if (typeof gap?.angle !== "string" || typeof gap?.gap !== "string") {
    throw new Error("every spike gap requires an angle and gap description");
  }
  return {
    action: "revise",
    gap,
    nextOrdinal: used + 1,
    residualGaps: gaps.slice(1),
    retainedEvidence: retained,
  };
}

export async function advanceSpike({
  adapter = null,
  controllerStage = "gap-controller",
  env = process.env,
  measurementPath,
  runId,
}) {
  if (measurementPath !== undefined && !isAbsolute(measurementPath)) throw new Error("measurement path must be absolute");
  const { manifest, manifestBytes, runDirectory } = await loadRunManifest({ runId, env });
  if (manifest.identity.flow !== "spike") throw new Error(`${runId} is not a spike run`);
  if (measurementPath !== undefined) requireWithin(manifest.identity.artifact_directory, measurementPath);
  const release = await acquireFileLock(join(runDirectory, ".spike-controller.lock"));
  try {
    await verifyInputs(manifest);
    const spike = JSON.parse(await readFile(requiredInput(manifest, "brief", "spike.json").sealed_path));
    const graph = JSON.parse(await readFile(manifest.graph.sealed_path));
    const materializationPath = join(runDirectory, "materialization.json");
    const materialization = JSON.parse(await readFile(materializationPath, "utf8"));
    const statePath = join(runDirectory, "spike-controller.json");
    const state = await readState(statePath, runId);
    const resolvedAdapter = adapter ?? new HermesAdapter({ board: manifest.identity.board });
    await reconstructSpikeCounters({ adapter: resolvedAdapter, graph, manifest, materialization, state });
    const measurement = measurementPath === undefined
      ? await deriveControllerMeasurement({
        adapter: resolvedAdapter, controllerStage, manifest, materialization, state,
      })
      : JSON.parse(await readFile(measurementPath, "utf8"));
    const decision = await decideController({
      adapter: resolvedAdapter, controllerStage, manifest, materialization,
      measurement, spike, state,
    });
    if (decision.retainedEvidence) state.retained_evidence = decision.retainedEvidence;
    if (decision.residualGaps) state.residual_gaps = decision.residualGaps;
    if (decision.action === "synthesize") {
      await atomicJson(statePath, state);
      await writeFile(join(manifest.identity.artifact_directory, "residual-gaps.json"), `${JSON.stringify({
        residual_gaps: decision.residualGaps,
        retained_evidence: decision.retainedEvidence,
      }, null, 2)}\n`, { mode: 0o600 });
      return { action: "synthesize", residualGaps: decision.residualGaps, runId };
    }
    if (decision.action === "continue") {
      await atomicJson(statePath, state);
      return { action: "continue", controllerStage, runId };
    }
    if (decision.action === "needs_input") {
      await makeBlockerVisible({
        adapter: resolvedAdapter, controllerStage, decision, materialization, runDirectory,
      });
      await atomicJson(statePath, state);
      return { action: "needs_input", controllerStage, runId };
    }
    const transition = graph.transitions.find(({ key }) => key === decision.transition);
    if (!transition) throw new Error(`sealed spike graph omits ${decision.transition}`);
    const instance = instantiateTransition(transition, decision.nextOrdinal);
    const tasks = new Map(Object.entries(materialization.tasks));
    const controllerId = requiredTask(tasks, transition.from);
    const manifestDigest = sha256(manifestBytes);
    for (const stage of instance.stages) {
      const parents = instance.dependencies
        .filter(({ child, parent }) => child === stage.key && instance.stages.some(({ key }) => key === parent))
        .map(({ parent }) => requiredTask(tasks, parent));
      const authority = {
        schema: "agent-flow.task-authority/v1", run_id: runId, stage: stage.key,
        run_manifest_path: join(runDirectory, "run.json"),
        run_manifest_sha256: manifestDigest,
      };
      if (stage.profile === "gate") {
        const gate = requiredGate(manifest, stage.key);
        authority.gate_spec_path = gate.sealed_path;
        authority.gate_spec_sha256 = gate.sha256;
      }
      if (stage.validates_handoff_for) {
        authority.producer_task_id = requiredTask(tasks, stage.validates_handoff_for);
      }
      if (!(await validateContract(authority)).valid) throw new Error(`invalid revision authority ${stage.key}`);
      const skill = requiredInput(manifest, "skill", stage.skill);
      const role = requiredInput(manifest, "role-contract", stage.profile);
      const spec = {
        title: `[${runId}/${stage.key}${decision.gap ? `/${decision.gap.angle}` : ""}]`,
        body: [
          formatTaskAuthority(authority), "",
          decision.gap ? `Revise angle: ${decision.gap.angle}` : `Retry prototype slice: ${decision.sliceOrdinal}`,
          decision.gap ? `Gap: ${decision.gap.gap}` : `Prior gate evidence: ${decision.evidence}`,
          decision.retainedEvidence ? `Retain evidence: ${decision.retainedEvidence.join(", ") || "none"}` : null,
          `Measurement: ${measurementPath}`, "",
          stage.profile === "gate" ? `Command: agent-flow gate --spec ${authority.gate_spec_path}` : null,
          (await readFile(skill.sealed_path, "utf8")).trim(), "",
          (await readFile(role.sealed_path, "utf8")).trim(), "",
        ].filter((line) => line !== null).join("\n"),
        assignee: stage.profile, tenant: runId, parents,
        workspace: {
          kind: "dir",
          path: stage.workspace === "feature-worktree"
            ? manifest.identity.repository.worktree
            : runDirectory,
        },
        idempotencyKey: `${runId}:${graph.version}:${stage.key}:1`,
        maxAttempts: stage.max_attempts, initialStatus: "running",
      };
      const task = await resolvedAdapter.createTask(spec);
      await auditTask(resolvedAdapter, task.id, spec);
      tasks.set(stage.key, task.id);
      materialization.tasks[stage.key] = task.id;
    }
    for (const { parent, child } of instance.dependencies) {
      if (child === transition.from) {
        await resolvedAdapter.linkTasks({ parentId: requiredTask(tasks, parent), childId: controllerId });
      }
    }
    if (decision.action === "revise") state.revisions = decision.nextOrdinal;
    else state.prototype_retries[decision.sliceOrdinal] = decision.nextOrdinal;
    state.events.push({
      action: decision.action, controller_stage: controllerStage,
      evidence: decision.evidence ?? measurement.evidence, ordinal: decision.nextOrdinal,
      ...(decision.gap ? { angle: decision.gap.angle } : { slice_ordinal: decision.sliceOrdinal }),
    });
    await atomicJson(materializationPath, materialization);
    await atomicJson(statePath, state);
    return {
      action: decision.action,
      ...(decision.gap ? { angle: decision.gap.angle } : { sliceOrdinal: decision.sliceOrdinal }),
      ordinal: decision.nextOrdinal,
      runId,
    };
  } finally {
    await release();
  }
}

async function deriveControllerMeasurement({ adapter, controllerStage, manifest, materialization, state }) {
  if (controllerStage === "gap-controller") {
    const producer = state.revisions === 0 ? "gap-critic" : `angle:revision:${state.revisions}`;
    const validationStage = `validate-handoff:${producer}`;
    const evidencePath = join(
      manifest.identity.artifact_directory, "validations",
      `${validationStage.replaceAll(":", "--")}.json`,
    );
    const evidence = await loadCompletedEvidence({
      adapter, evidencePath, manifest, materialization,
      stage: producer, validationStage,
    });
    if (evidence.artifacts.length !== 1) throw new Error(`${producer} must produce one gap measurement`);
    const measurement = JSON.parse(evidence.artifacts[0].bytes);
    measurement.evidence = evidence.artifacts[0].snapshot;
    return measurement;
  }
  const match = /^prototype-controller:(\d+)$/.exec(controllerStage);
  if (!match) throw new Error(`stage ${controllerStage} is not a spike transition controller`);
  const ordinal = Number(match[1]);
  const used = state.prototype_retries[ordinal] ?? 0;
  const gateStage = used === 0
    ? `prototype-gate:${ordinal}`
    : `prototype-gate:retry-${ordinal}:${used}`;
  const gate = JSON.parse(await readFile(requiredGate(manifest, gateStage).sealed_path));
  return { evidence: gate.outputs };
}

async function decideController({ adapter, controllerStage, manifest, materialization, measurement, spike, state }) {
  if (controllerStage === "gap-controller") {
    const decision = decideSpikeRevision({
      cap: spike.limits.max_revisions,
      gaps: measurement.gaps ?? [],
      retainedEvidence: [...state.retained_evidence, ...(measurement.retained_evidence ?? [])],
      used: state.revisions,
    });
    return decision.action === "revise"
      ? { ...decision, transition: "gap-revision" }
      : decision;
  }
  const match = /^prototype-controller:(\d+)$/.exec(controllerStage);
  if (!match) throw new Error(`stage ${controllerStage} is not a spike transition controller`);
  const sliceOrdinal = Number(match[1]);
  const used = state.prototype_retries[sliceOrdinal] ?? 0;
  const gateStage = used === 0
    ? `prototype-gate:${sliceOrdinal}`
    : `prototype-gate:retry-${sliceOrdinal}:${used}`;
  const evidence = await derivePrototypeMeasurement({
    adapter, gateStage, manifest, materialization, measurement,
  });
  if (evidence.passed) return { action: "continue", evidence: evidence.paths.join(",") };
  if (used >= spike.limits.max_prototype_retries) {
    return {
      action: "needs_input", evidence: evidence.paths.join(","),
      sliceOrdinal,
      reason: `prototype slice ${sliceOrdinal} retry cap exhausted`,
    };
  }
  return {
    action: "retry", evidence: evidence.paths.join(","),
    nextOrdinal: used + 1, sliceOrdinal,
    transition: `prototype-retry:${sliceOrdinal}`,
  };
}

async function derivePrototypeMeasurement({ adapter, gateStage, manifest, materialization, measurement }) {
  const gateInput = requiredGate(manifest, gateStage);
  const gate = JSON.parse(await readFile(gateInput.sealed_path, "utf8"));
  const completed = await loadCompletedGateEvidence({
    adapter, gate, manifest, materialization, stage: gateStage,
  });
  const paths = Array.isArray(measurement.evidence)
    ? measurement.evidence
    : [measurement.evidence].filter(Boolean);
  if (
    paths.length !== gate.outputs.length ||
    !gate.outputs.every((path) => paths.includes(path))
  ) throw new Error(`prototype controller evidence does not name the exact ${gateStage} outputs`);
  const results = [];
  for (const artifact of completed.artifacts) {
    const result = JSON.parse(artifact.bytes);
    const validation = await validateContract(result);
    if (!validation.valid || result.run_id !== manifest.identity.run_id || result.stage !== gateStage) {
      throw new Error(`prototype controller evidence is not authoritative for ${gateStage}`);
    }
    results.push(result);
  }
  const passed = results.every(({ exit_code, termination }) =>
    exit_code === 0 && termination === "exit"
  );
  if (completed.handoff.passed !== passed) {
    throw new Error(`${gateStage} handoff passed flag differs from its command results`);
  }
  return { passed, paths };
}

async function makeBlockerVisible({ adapter, controllerStage, decision, materialization, runDirectory }) {
  const root = materialization.tasks?.["spike-root"];
  const controller = materialization.tasks?.[controllerStage];
  if (!root || !controller) throw new Error("spike materialization omits controller or root task");
  const body = `Spike needs input: ${decision.reason}. Evidence: ${decision.evidence}`;
  await adapter.blockTask({ taskId: controller, reason: body });
  await adapter.commentTask({ taskId: controller, body });
  await adapter.blockTask({ taskId: root, reason: body });
  await adapter.commentTask({ taskId: root, body });
  await writeFile(join(runDirectory, "artifacts", "prototype-blocker.md"), `${body}\n`, { mode: 0o600 });
  const stuckPath = join(runDirectory, "artifacts", "stuck-slices.json");
  let stuck = { stuck_slices: [] };
  try { stuck = JSON.parse(await readFile(stuckPath)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const item = {
    slice_ordinal: decision.sliceOrdinal,
    reason: decision.reason,
    evidence: decision.evidence,
  };
  stuck.stuck_slices = [
    ...stuck.stuck_slices.filter(({ slice_ordinal: ordinal }) => ordinal !== item.slice_ordinal),
    item,
  ].sort((left, right) => left.slice_ordinal - right.slice_ordinal);
  await writeFile(stuckPath, `${JSON.stringify(stuck, null, 2)}\n`, { mode: 0o600 });
}

async function readState(path, runId) {
  try {
    const state = JSON.parse(await readFile(path));
    if (state.run_id !== runId) throw new Error("spike controller state identity changed");
    state.prototype_retries ??= {};
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      run_id: runId, revisions: 0, prototype_retries: {},
      retained_evidence: [], residual_gaps: [], events: [],
    };
  }
}
async function reconstructSpikeCounters({ adapter, graph, manifest, materialization, state }) {
  const tasks = new Set(Object.keys(materialization.tasks ?? {}));
  state.revisions = 0;
  state.prototype_retries = {};
  for (const transition of graph.transitions) {
    let count = 0;
    let seenMissing = false;
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      const keys = instantiateTransition(transition, ordinal).stages.map(({ key }) => key);
      const present = keys.filter((key) => tasks.has(key)).length;
      if (present !== 0 && present !== keys.length) {
        throw new Error(`transition ${transition.key}/${ordinal} is only partially materialized`);
      }
      if (present === 0) {
        seenMissing = true;
      } else {
        if (seenMissing) throw new Error(`transition ${transition.key} has a materialization gap`);
        const instance = instantiateTransition(transition, ordinal);
        for (const stage of instance.stages) {
          await auditDynamicTask({ adapter, instance, manifest, materialization, stage });
        }
        count = ordinal;
      }
    }
    if (transition.key === "gap-revision") state.revisions = count;
    const prototype = /^prototype-retry:(\d+)$/.exec(transition.key);
    if (prototype) state.prototype_retries[Number(prototype[1])] = count;
  }
}
async function auditDynamicTask({ adapter, instance, manifest, materialization, stage }) {
  const taskId = materialization.tasks[stage.key];
  const task = await adapter.getTaskLifecycle({ taskId });
  const authority = await parseTaskAuthority({ body: task.body, taskId });
  const expectedParents = instance.dependencies.filter(({ child }) => child === stage.key)
    .map(({ parent }) => materialization.tasks[parent]).filter(Boolean).sort();
  if (
    authority.runId !== manifest.identity.run_id || authority.stage !== stage.key ||
    authority.runManifestPath !== manifest.identity.run_directory + "/run.json" ||
    task.tenant !== manifest.identity.tenant || task.assignee !== stage.profile ||
    task.workspace_kind !== "dir" ||
    task.workspace_path !== (stage.workspace === "run-dir"
      ? manifest.identity.run_directory : manifest.identity.repository.worktree) ||
    task.max_retries !== stage.max_attempts ||
    JSON.stringify([...(task.parents ?? [])].sort()) !== JSON.stringify(expectedParents)
  ) throw new Error(`dynamic task ${stage.key} differs from Hermes authority`);
}
async function verifyInputs(manifest) {
  if (sha256(await readFile(manifest.graph.sealed_path)) !== manifest.graph.sha256) throw new Error("sealed spike graph changed");
  for (const input of manifest.inputs) {
    if (sha256(await readFile(input.sealed_path)) !== input.sha256) throw new Error(`sealed spike input changed: ${input.kind}/${input.name}`);
  }
}
function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((input) => input.kind === kind && input.name === name);
  if (!found) throw new Error(`spike run omits ${kind}/${name}`);
  return found;
}
function requiredGate(manifest, stage) {
  const suffix = `/${stage.replaceAll(":", "--")}.json`;
  const found = manifest.inputs.find(({ kind, sealed_path: path }) => kind === "gate" && path.endsWith(suffix));
  if (!found) throw new Error(`spike run omits gate ${stage}`);
  return found;
}
function requiredTask(tasks, stage) {
  const id = tasks.get(stage); if (!id) throw new Error(`spike task ${stage} is missing`); return id;
}
async function auditTask(adapter, taskId, spec) {
  const task = await adapter.getTask({ taskId });
  if (
    task.title !== spec.title || task.body !== spec.body ||
    task.assignee !== spec.assignee || task.tenant !== spec.tenant ||
    task.workspace_kind !== spec.workspace.kind || task.workspace_path !== spec.workspace.path ||
    task.max_retries !== spec.maxAttempts || !sameMembers(task.parents, spec.parents) ||
    task.status === "archived"
  ) throw new Error(`dynamic spike task ${taskId} does not match sealed authority`);
}
function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
function requireWithin(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("spike measurement must be beneath the artifact root");
  }
}
async function atomicJson(path, document) {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let complete = false;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path); complete = true;
  } finally {
    if (!complete) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
