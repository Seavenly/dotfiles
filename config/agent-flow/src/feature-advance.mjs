import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { acquireFileLock } from "./file-lock.mjs";
import {
  loadCompletedEvidence,
  loadCompletedGateEvidence,
} from "./completed-evidence.mjs";
import { decideFeatureContinuation } from "./feature-controller.mjs";
import { instantiateTransition } from "./graph-transition.mjs";
import { formatTaskAuthority, HermesAdapter, parseTaskAuthority } from "./hermes-adapter.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { validateContract } from "./schema-validator.mjs";

export async function advanceFeature({
  adapter = null,
  controllerStage,
  env = process.env,
  measurementPath,
  runId,
}) {
  if (measurementPath !== undefined && !isAbsolute(measurementPath)) throw new Error("measurement path must be absolute");
  const loaded = await loadRunManifest({ runId, env });
  const { manifest, manifestBytes, runDirectory } = loaded;
  if (manifest.identity.flow !== "feature") throw new Error(`${runId} is not a feature run`);
  if (measurementPath !== undefined) requireWithin(manifest.identity.artifact_directory, measurementPath, "measurement");
  const release = await acquireFileLock(join(runDirectory, ".feature-controller.lock"));
  try {
    await verifySealedRun(manifest);
    const feature = JSON.parse(await readFile(requiredInput(manifest, "brief", "feature.json").sealed_path));
    const graph = JSON.parse(await readFile(manifest.graph.sealed_path));
    const materializationPath = join(runDirectory, "materialization.json");
    const materialization = JSON.parse(await readFile(materializationPath, "utf8"));
    const statePath = join(runDirectory, "feature-controller.json");
    const state = await readState(statePath, runId);
    const resolvedAdapter = adapter ?? new HermesAdapter({ board: manifest.identity.board });
    state.transitions = await reconstructTransitionCounts({
      adapter: resolvedAdapter, graph, manifest, materialization,
    });
    const measurement = measurementPath === undefined
      ? await deriveControllerMeasurement({
        adapter: resolvedAdapter, controllerStage, manifest, materialization, state,
      })
      : JSON.parse(await readFile(measurementPath, "utf8"));
    const decision = await controllerDecision({
      adapter: resolvedAdapter,
      controllerStage,
      feature,
      manifest,
      materialization,
      measurement,
      state,
    });

    if (decision.action === "needs_input") {
      await makeBlockerVisible({
        adapter: resolvedAdapter,
        controllerStage,
        decision,
        materialization,
        runDirectory,
      });
      return { action: decision.action, controllerStage, runId };
    }
    if (decision.action === "continue") {
      if (decision.deferred?.length) {
        await appendSummary(runDirectory, `Deferred findings: ${decision.deferred.join("; ")}\n`);
      }
      return { action: decision.action, controllerStage, runId };
    }

    const transition = graph.transitions.find(({ key }) => key === decision.transition);
    if (!transition) throw new Error(`sealed graph omits transition ${decision.transition}`);
    const ordinal = decision.nextOrdinal;
    if ((state.transitions[transition.key] ?? 0) >= ordinal) {
      return { action: decision.action, controllerStage, ordinal, resumed: true, runId };
    }
    const instance = instantiateTransition(transition, ordinal);
    const created = await materializeTransition({
      adapter: resolvedAdapter,
      feature,
      graph,
      instance,
      manifest,
      manifestBytes,
      materialization,
      runDirectory,
    });
    state.transitions = await reconstructTransitionCounts({
      adapter: resolvedAdapter, graph, manifest, materialization,
    });
    state.events.push({
      action: decision.action,
      controller_stage: controllerStage,
      evidence: measurement.evidence,
      ordinal,
      transition: transition.key,
    });
    await atomicJson(materializationPath, materialization);
    await atomicJson(statePath, state);
    return {
      action: decision.action,
      controllerStage,
      createdCards: created,
      ordinal,
      runId,
    };
  } finally {
    await release();
  }
}

async function deriveControllerMeasurement({ adapter, controllerStage, manifest, materialization, state }) {
  const slice = /^slice-controller:(\d+)$/.exec(controllerStage);
  if (slice) return { evidence: [] };
  const used = state.transitions[
    controllerStage === "completeness-controller" ? "completeness-fix" :
      controllerStage === "critique-controller" ? "critique-fix" : "planned-slice"
  ] ?? 0;
  const producer = controllerStage === "plan-controller" ? "planner"
    : controllerStage === "completeness-controller"
      ? (used === 0 ? "completeness" : `completeness:fix:${used}`)
      : controllerStage === "critique-controller"
        ? (used === 0 ? "independent-critic" : `independent-critic:fix:${used}`)
        : null;
  if (!producer) throw new Error(`stage ${controllerStage} is not a feature transition controller`);
  const validationStage = `validate-handoff:${producer}`;
  const evidencePath = join(
    manifest.identity.artifact_directory, "validations",
    `${validationStage.replaceAll(":", "--")}.json`,
  );
  const evidence = await loadCompletedEvidence({
    adapter, evidencePath, manifest, materialization,
    stage: producer, validationStage,
  });
  if (evidence.artifacts.length !== 1) throw new Error(`${producer} must produce one controller measurement`);
  const measurement = JSON.parse(evidence.artifacts[0].bytes);
  measurement.evidence = evidence.artifacts[0].snapshot;
  return measurement;
}

async function controllerDecision({ adapter, controllerStage, feature, manifest, materialization, measurement, state }) {
  if (controllerStage === "plan-controller") {
    const slices = validatePlannedSlices(measurement.slices);
    const used = state.transitions["planned-slice"] ?? 0;
    if (used >= slices.length) return { action: "continue", evidence: measurement.evidence };
    return {
      action: "retry",
      evidence: measurement.evidence,
      nextOrdinal: used + 1,
      transition: "planned-slice",
    };
  }
  const slice = /^slice-controller:(\d+)$/.exec(controllerStage);
  if (slice) {
    const transition = `slice-retry:${slice[1]}`;
    const used = state.transitions[transition] ?? 0;
    const authoritativeMeasurement = await deriveSliceMeasurement({
      adapter, manifest, materialization,
      measurement,
      ordinal: Number(slice[1]),
      retry: used,
    });
    const decision = decideFeatureContinuation({
      kind: "slice",
      measurement: authoritativeMeasurement,
      used,
      cap: feature.limits.max_slice_retries,
    });
    return { ...decision, transition };
  }
  if (controllerStage === "completeness-controller") {
    const transition = "completeness-fix";
    const decision = decideFeatureContinuation({
      kind: "completeness",
      measurement,
      used: state.transitions[transition] ?? 0,
      cap: feature.limits.max_completeness_fixes,
    });
    return { ...decision, transition };
  }
  if (controllerStage === "critique-controller") {
    const transition = "critique-fix";
    const decision = decideFeatureContinuation({
      kind: "critique",
      measurement,
      used: state.transitions[transition] ?? 0,
      cap: feature.limits.max_critique_fixes,
    });
    return { ...decision, transition };
  }
  throw new Error(`stage ${controllerStage} is not a feature transition controller`);
}

async function deriveSliceMeasurement({ adapter, manifest, materialization, measurement, ordinal, retry }) {
  const gateStage = retry === 0 ? `gate:${ordinal}` : `gate:retry-${ordinal}:${retry}`;
  const gateInput = requiredGateInput(manifest, gateStage);
  const gate = JSON.parse(await readFile(gateInput.sealed_path, "utf8"));
  const completed = await loadCompletedGateEvidence({
    adapter, gate, manifest, materialization, stage: gateStage,
  });
  const evidence = Array.isArray(measurement.evidence) && measurement.evidence.length > 0
    ? measurement.evidence
    : gate.outputs;
  if (
    evidence.length !== gate.outputs.length ||
    !gate.outputs.every((path) => evidence.includes(path))
  ) {
    throw new Error(`slice controller evidence does not name the exact ${gateStage} outputs`);
  }
  const results = [];
  for (const artifact of completed.artifacts) {
    const result = JSON.parse(artifact.bytes);
    const validation = await validateContract(result);
    if (!validation.valid || result.run_id !== manifest.identity.run_id || result.stage !== gateStage) {
      throw new Error(`slice controller evidence is not authoritative for ${gateStage}`);
    }
    results.push(result);
  }
  const passed = results.every(({ exit_code, termination }) =>
    exit_code === 0 && termination === "exit"
  );
  if (completed.handoff.passed !== passed) {
    throw new Error(`${gateStage} handoff passed flag differs from its command results`);
  }
  return {
    evidence: evidence.join(","),
    passed,
    testable: gate.commands.length > 0,
  };
}

async function materializeTransition({
  adapter,
  feature,
  graph,
  instance,
  manifest,
  manifestBytes,
  materialization,
  runDirectory,
}) {
  const tasks = new Map(Object.entries(materialization.tasks ?? {}));
  const controllerId = requiredTask(tasks, graph.transitions.find(({ key }) => key === instance.key).from);
  const stageKeys = new Set(instance.stages.map(({ key }) => key));
  const ordered = topologicalTransition(instance);
  let created = 0;
  for (const stage of ordered) {
    const parents = instance.dependencies
      .filter(({ child, parent }) => child === stage.key && stageKeys.has(parent))
      .map(({ parent }) => requiredTask(tasks, parent));
    const authority = {
      schema: "agent-flow.task-authority/v1",
      run_id: feature.run_id,
      stage: stage.key,
      run_manifest_path: join(runDirectory, "run.json"),
      run_manifest_sha256: sha256(manifestBytes),
    };
    if (stage.profile === "gate") {
      const gate = requiredGateInput(manifest, stage.key);
      authority.gate_spec_path = gate.sealed_path;
      authority.gate_spec_sha256 = gate.sha256;
    }
    if (stage.validates_handoff_for) {
      authority.producer_task_id = requiredTask(tasks, stage.validates_handoff_for);
    }
    const validation = await validateContract(authority);
    if (!validation.valid) throw new Error(`dynamic authority for ${stage.key} is invalid`);
    const skillInput = requiredInput(manifest, "skill", stage.skill);
    const roleInput = requiredInput(manifest, "role-contract", stage.profile);
    const workspace = stage.workspace === "run-dir"
      ? runDirectory
      : manifest.identity.repository.worktree;
    const body = [
      formatTaskAuthority(authority),
      "",
      `Feature: ${feature.summary}`,
      `Dynamic stage: ${stage.key}`,
      `Workspace: ${workspace}`,
      `Sealed skill: ${skillInput.sealed_path}`,
      `Sealed role contract: ${roleInput.sealed_path}`,
      stage.profile === "gate"
        ? `Command: agent-flow gate --spec ${authority.gate_spec_path}`
        : "Follow the sealed skill and role contract.",
      "",
      (await readFile(skillInput.sealed_path, "utf8")).trim(),
      "",
      (await readFile(roleInput.sealed_path, "utf8")).trim(),
      "",
    ].join("\n");
    const spec = {
      title: `[${feature.run_id}/${stage.key}]`,
      body,
      assignee: stage.profile,
      tenant: feature.run_id,
      workspace: { kind: "dir", path: workspace },
      parents,
      idempotencyKey: `${feature.run_id}:${graph.version}:${stage.key}:1`,
      maxAttempts: stage.max_attempts,
      initialStatus: "running",
    };
    const task = await adapter.createTask(spec);
    tasks.set(stage.key, task.id);
    materialization.tasks[stage.key] = task.id;
    await auditTask(adapter, task.id, spec);
    created += 1;
  }
  for (const { parent, child } of instance.dependencies) {
    if (child !== graph.transitions.find(({ key }) => key === instance.key).from) continue;
    await adapter.linkTasks({ parentId: requiredTask(tasks, parent), childId: controllerId });
  }
  return created;
}

function topologicalTransition(instance) {
  const pending = new Map(instance.stages.map((stage) => [stage.key, stage]));
  const ordered = [];
  while (pending.size > 0) {
    const next = [...pending.values()].find((stage) =>
      instance.dependencies
        .filter(({ child }) => child === stage.key)
        .every(({ parent }) => !pending.has(parent))
    );
    if (!next) throw new Error(`transition ${instance.key} is cyclic`);
    pending.delete(next.key);
    ordered.push(next);
  }
  return ordered;
}

async function verifySealedRun(manifest) {
  const graphBytes = await readFile(manifest.graph.sealed_path);
  if (sha256(graphBytes) !== manifest.graph.sha256) throw new Error("sealed graph changed");
  for (const item of manifest.inputs) {
    if (sha256(await readFile(item.sealed_path)) !== item.sha256) {
      throw new Error(`sealed input changed: ${item.kind}/${item.name}`);
    }
  }
}

async function makeBlockerVisible({ adapter, controllerStage, decision, materialization, runDirectory }) {
  const root = materialization.tasks?.["feature-root"];
  if (!root) throw new Error("feature materialization omits its root task");
  const controller = materialization.tasks?.[controllerStage];
  if (!controller) throw new Error(`feature materialization omits controller ${controllerStage}`);
  const body = `Feature needs input: ${decision.reason}. Evidence: ${decision.evidence}`;
  await adapter.blockTask({ taskId: controller, reason: body });
  await adapter.commentTask({ taskId: controller, body });
  await adapter.blockTask({ taskId: root, reason: body });
  await adapter.commentTask({ taskId: root, body });
  await appendSummary(runDirectory, `${body}\n`);
}

async function appendSummary(runDirectory, text) {
  const path = join(runDirectory, "artifacts", "review-summary.md");
  let existing = "# Feature review summary\n\n";
  try { existing = await readFile(path, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(path, `${existing}${text}`, { mode: 0o600 });
}

async function readState(path, runId) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state.run_id !== runId || typeof state.transitions !== "object") {
      throw new Error("feature controller state has the wrong identity");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { run_id: runId, transitions: {}, events: [] };
  }
}

async function reconstructTransitionCounts({ adapter, graph, manifest, materialization }) {
  const tasks = new Set(Object.keys(materialization.tasks ?? {}));
  const counts = {};
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
    counts[transition.key] = count;
  }
  return counts;
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

function validatePlannedSlices(slices) {
  if (!Array.isArray(slices) || slices.length < 1 || slices.length > 32) {
    throw new Error("planner measurement must contain 1 to 32 slices");
  }
  for (const slice of slices) {
    if (typeof slice?.id !== "string" || typeof slice?.title !== "string") {
      throw new Error("every planned slice requires an id and title");
    }
  }
  return slices;
}

function requiredGateInput(manifest, stage) {
  const suffix = `/${safe(stage)}.json`;
  const found = manifest.inputs.find(({ kind, sealed_path: path }) =>
    kind === "gate" && path.endsWith(suffix)
  );
  if (!found) throw new Error(`run omits sealed gate for ${stage}`);
  return found;
}

function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((item) => item.kind === kind && item.name === name);
  if (!found) throw new Error(`run omits ${kind}/${name}`);
  return found;
}

function requiredTask(tasks, stage) {
  const id = tasks.get(stage);
  if (!id) throw new Error(`materialization omits task ${stage}`);
  return id;
}

async function auditTask(adapter, taskId, spec) {
  const task = await adapter.getTask({ taskId });
  if (
    task.title !== spec.title || task.body !== spec.body ||
    task.assignee !== spec.assignee || task.tenant !== spec.tenant ||
    task.workspace_kind !== spec.workspace.kind || task.workspace_path !== spec.workspace.path ||
    task.max_retries !== spec.maxAttempts || !sameMembers(task.parents, spec.parents) ||
    task.status === "archived"
  ) throw new Error(`dynamic task ${taskId} does not match sealed authority`);
}

function requireWithin(root, path, label) {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} path must be beneath the approved artifact root`);
  }
}

async function atomicJson(path, document) {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let complete = false;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    complete = true;
  } finally {
    if (!complete) await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function sameMembers(left = [], right = []) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safe(value) { return value.replaceAll(":", "--"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
