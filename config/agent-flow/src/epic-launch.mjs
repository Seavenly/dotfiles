import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { compileEpicGraph } from "./epic-graph.mjs";
import { parseExternalRef } from "./external-root.mjs";
import { expandedTransitionStages, instantiateTransition } from "./graph-transition.mjs";
import {
  formatTaskAuthority,
  HermesAdapter,
  parseTaskAuthority,
} from "./hermes-adapter.mjs";
import { materializationOrder } from "./review-topology.mjs";
import { hasTerminalCompletedAttempt } from "./run-terminal.mjs";
import { validateContract } from "./schema-validator.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CARD_SKILL_ROOT = join(SOURCE_ROOT, "card-skills");
const CONTRACTS = [
  "agent-flow.run/v1", "agent-flow.graph/v1", "agent-flow.gate/v1",
  "agent-flow.command-result/v1", "agent-flow.handoff/v1",
  "agent-flow.validation/v1", "agent-flow.task-authority/v1",
  "agent-flow.migration-receipt/v1", "agent-flow.epic/v1",
];

export async function launchEpicControlPlane({
  adapter = null,
  epic,
  epicBytes,
  implementationRevision,
  now = () => new Date(),
  repository,
  runDirectory,
  runDoctor,
  sourceWorktree,
}) {
  if (typeof runDoctor !== "function") {
    throw new Error("epic launch requires profile health verification");
  }
  const graph = compileEpicGraph({
    featureCount: epic.features.length,
    maxSourceRefreshes: epic.features.length + 1,
  });
  await requireValid(graph, "epic graph");
  const profiles = requireHealthyProfiles(await runDoctor(), [
    "flow-controller", "analyst", "builder", "critic", "gate",
  ]);
  const revision = implementationRevision ?? await gitRevision();
  const layout = epicLayout(runDirectory);
  const stages = [...graph.stages, ...expandedTransitionStages(graph)];
  const gates = await generateGates({ epic, graph, layout, sourceWorktree });
  const contents = [
    item("brief", "epic.json", layout.epic, epicBytes),
    ...gates.map(({ document, name, path }) => item("gate", name, path, jsonBytes(document))),
  ];
  for (const skill of [...new Set(stages.map(({ skill }) => skill))].sort()) {
    const source = join(CARD_SKILL_ROOT, `${skill}.md`);
    contents.push(item("skill", skill, layout.skill(skill), await readFile(source)));
  }
  for (const profile of [...new Set(stages.map(({ profile }) => profile))].sort()) {
    const source = join(SOURCE_ROOT, "role-contracts", `${profile}.md`);
    contents.push(item("role-contract", profile, layout.role(profile), await readFile(source)));
  }
  const graphBytes = jsonBytes(graph);
  const graphIdentity = {
    name: graph.name, version: graph.version, flow: graph.flow,
    sealed_path: layout.graph, sha256: sha256(graphBytes),
  };
  const inputs = contents.map(({ bytes, kind, name, sealed_path }) => ({
    kind, name, source_path: sealed_path, sealed_path, sha256: sha256(bytes),
  }));
  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision,
      compatible_contracts: CONTRACTS,
      content_set_fingerprint: aggregateFingerprint(graphIdentity, inputs),
    },
    identity: {
      run_id: epic.run_id,
      run_directory: runDirectory,
      artifact_directory: layout.artifacts,
      validation_directory: layout.validated,
      flow: "epic",
      repository: { path: repository, worktree: sourceWorktree, forge_coordinate: null },
      board: epic.kanban.board,
      tenant: epic.run_id,
      parent_run_id: null,
      external_root: parseExternalRef(epic.external_ref),
      supersedes: epic.supersedes ?? null,
    },
    graph: graphIdentity,
    approved_read_roots: [runDirectory, repository, sourceWorktree],
    approved_artifact_roots: [layout.artifacts],
    inputs,
    profiles,
    limits: {
      max_created_cards: graph.stages.length + graph.transitions.reduce(
        (sum, transition) => sum + transition.max_instances * transition.stages.length, 0,
      ),
      max_worker_attempts: graph.stages.reduce((sum, stage) => sum + stage.max_attempts, 0),
      max_elapsed_seconds: epic.limits.max_elapsed_seconds,
      max_feature_streams: epic.limits.max_feature_streams,
    },
    revisions: { base: epic.source.base_sha, source: epic.source.base_sha, target: epic.target.sha },
    sealed_at: now().toISOString(),
  };
  await requireValid(manifest, "epic run manifest");
  const runManifestPath = join(runDirectory, "run.json");
  let resumed = false;
  try {
    const existingBytes = await readFile(runManifestPath);
    const existing = JSON.parse(existingBytes);
    await requireValid(existing, "existing epic run manifest");
    if (
      existing.identity.run_id !== epic.run_id ||
      existing.identity.repository.path !== repository ||
      existing.identity.repository.worktree !== sourceWorktree ||
      existing.graph.sha256 !== manifest.graph.sha256 ||
      existing.implementation.revision !== revision ||
      existing.implementation.content_set_fingerprint !== manifest.implementation.content_set_fingerprint
    ) throw new Error("existing epic run differs from current sealed authority");
    for (const input of existing.inputs) {
      if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
        throw new Error(`existing sealed epic input changed: ${input.kind}/${input.name}`);
      }
    }
    Object.assign(manifest, existing);
    resumed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await publish({ contents, graphBytes, layout, manifest, runDirectory });
  }
  const resolvedAdapter = adapter ?? new HermesAdapter({ board: epic.kanban.board });
  await resolvedAdapter.ensureBoard({
    name: `Agent Flow: ${epic.run_id}`,
    description: epic.summary,
    defaultWorkdir: repository,
  });
  const materialized = await materialize({
    adapter: resolvedAdapter,
    epic,
    gates: new Map(gates.map((gate) => [gate.stage, gate])),
    graph,
    layout,
    manifest,
    runManifestPath,
    sourceWorktree,
  });
  return { ...materialized, resumed, runManifestPath };
}

export async function materializeEpicTransition({
  adapter = null,
  context,
  ordinal,
  runDirectory,
  transitionKey,
}) {
  const [manifestBytes, materializationBytes] = await Promise.all([
    readFile(join(runDirectory, "run.json")),
    readFile(join(runDirectory, "materialization.json")),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const materialization = JSON.parse(materializationBytes);
  await requireValid(manifest, "sealed epic run manifest");
  for (const input of manifest.inputs) {
    if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
      throw new Error(`sealed epic input changed: ${input.kind}/${input.name}`);
    }
  }
  const graph = JSON.parse(await readFile(manifest.graph.sealed_path));
  if (sha256(await readFile(manifest.graph.sealed_path)) !== manifest.graph.sha256) {
    throw new Error("sealed epic graph changed");
  }
  const transition = graph.transitions.find(({ key }) => key === transitionKey);
  if (!transition) throw new Error(`sealed epic graph omits transition ${transitionKey}`);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > transition.max_instances) {
    throw new Error(`epic transition ordinal is outside ${transitionKey}'s bound`);
  }
  const instance = instantiateTransition(transition, ordinal);
  const tasks = new Map(Object.entries(materialization.tasks ?? {}));
  const controllerId = requiredTask(tasks, transition.from);
  const stageKeys = new Set(instance.stages.map(({ key }) => key));
  const resolvedAdapter = adapter ?? new HermesAdapter({ board: manifest.identity.board });
  let created = 0;
  for (const stage of topologicalTransition(instance)) {
    const parents = instance.dependencies
      .filter(({ child, parent }) => child === stage.key && stageKeys.has(parent))
      .map(({ parent }) => requiredTask(tasks, parent));
    const authority = {
      schema: "agent-flow.task-authority/v1", run_id: manifest.identity.run_id,
      stage: stage.key, run_manifest_path: join(runDirectory, "run.json"),
      run_manifest_sha256: sha256(manifestBytes),
    };
    const gate = stage.profile === "gate" ? requiredGate(manifest, stage.key) : null;
    if (gate) {
      authority.gate_spec_path = gate.sealed_path;
      authority.gate_spec_sha256 = gate.sha256;
    }
    if (stage.validates_handoff_for) {
      authority.producer_task_id = requiredTask(tasks, stage.validates_handoff_for);
    }
    await requireValid(authority, `dynamic epic authority ${stage.key}`);
    const skill = requiredInput(manifest, "skill", stage.skill);
    const role = requiredInput(manifest, "role-contract", stage.profile);
    const workspace = stage.workspace === "integration-worktree"
      ? manifest.identity.repository.worktree
      : runDirectory;
    const spec = {
      title: `[${manifest.identity.run_id}/${stage.key}]`,
      body: [
        formatTaskAuthority(authority), "", `Epic transition: ${transitionKey}/${ordinal}`,
        `Prior target: ${context.priorTargetSha}`, `Current target: ${context.targetSha}`,
        `Prior source: ${context.priorSourceSha}`, `Workspace: ${workspace}`,
        gate ? `Command: agent-flow gate --spec ${gate.sealed_path}` : "Follow the sealed card instructions.",
        "", (await readFile(skill.sealed_path, "utf8")).trim(), "",
        (await readFile(role.sealed_path, "utf8")).trim(), "",
      ].join("\n"),
      assignee: stage.profile, tenant: manifest.identity.tenant,
      workspace: { kind: "dir", path: workspace }, parents,
      idempotencyKey: `${manifest.identity.run_id}:${graph.version}:${stage.key}:1`,
      maxAttempts: stage.max_attempts, initialStatus: "running",
    };
    const task = await resolvedAdapter.createTask(spec);
    await auditTask(resolvedAdapter, task.id, spec, true);
    if (!tasks.has(stage.key)) created += 1;
    tasks.set(stage.key, task.id);
    materialization.tasks[stage.key] = task.id;
  }
  for (const { parent, child } of instance.dependencies.filter(({ child }) => child === transition.from)) {
    await resolvedAdapter.linkTasks({ parentId: requiredTask(tasks, parent), childId: controllerId });
  }
  await atomicJson(join(runDirectory, "materialization.json"), materialization);
  return { createdCards: created, ordinal, transition: transitionKey };
}

async function generateGates({ epic, graph, layout, sourceWorktree }) {
  const gates = [];
  for (const stage of [...graph.stages, ...expandedTransitionStages(graph)]
    .filter(({ profile }) => profile === "gate")) {
    let document;
    if (stage.validates_handoff_for) {
      document = {
        schema: "agent-flow.gate/v1", name: safeName(stage.key), version: 1,
        run_id: epic.run_id, stage: stage.key, kind: "handoff-validation",
        workspace: layout.runDirectory, read_roots: [layout.runDirectory],
        write_root: layout.artifacts, timeout_seconds: 120, inputs: [],
        outputs: [join(layout.artifacts, "validations", `${safe(stage.key)}.json`)],
        handoff_validation: {
          producer_stage: stage.validates_handoff_for,
          require_passed: false,
        },
      };
    } else {
      const outputs = epic.verification.map((_, index) =>
        join(layout.artifacts, "gates", safe(stage.key), `${index + 1}.json`)
      );
      document = {
        schema: "agent-flow.gate/v1", name: safeName(stage.key), version: 1,
        run_id: epic.run_id, stage: stage.key, kind: "command",
        workspace: sourceWorktree, read_roots: [layout.runDirectory, sourceWorktree],
        write_root: layout.artifacts, timeout_seconds: 3600, inputs: [], outputs,
        commands: epic.verification.map(({ argv }, index) => ({
          argv, cwd: sourceWorktree, output_path: outputs[index],
        })),
      };
    }
    await requireValid(document, `epic gate ${stage.key}`);
    gates.push({
      document, name: `${safe(stage.key)}.json`, path: layout.gate(stage.key), stage: stage.key,
    });
  }
  return gates;
}

async function materialize({
  adapter, epic, gates, graph, layout, manifest, runManifestPath, sourceWorktree,
}) {
  const order = materializationOrder(graph, "standard");
  const prior = await readOptional(join(layout.runDirectory, "materialization.json"));
  const tasks = new Map();
  const manifestDigest = sha256(await readFile(runManifestPath));
  for (const stage of order) {
    const parents = stage.key === graph.root ? [] : graph.dependencies
      .filter(({ child }) => child === stage.key)
      .map(({ parent }) => requiredTask(tasks, parent));
    const authority = {
      schema: "agent-flow.task-authority/v1", run_id: epic.run_id, stage: stage.key,
      run_manifest_path: runManifestPath, run_manifest_sha256: manifestDigest,
    };
    const gate = gates.get(stage.key);
    if (gate) {
      authority.gate_spec_path = gate.path;
      authority.gate_spec_sha256 = sha256(jsonBytes(gate.document));
    }
    if (stage.validates_handoff_for) {
      authority.producer_task_id = requiredTask(tasks, stage.validates_handoff_for);
    }
    await requireValid(authority, `epic task authority ${stage.key}`);
    const workspace = stage.workspace === "integration-worktree"
      ? sourceWorktree
      : layout.runDirectory;
    const skill = requiredInput(manifest, "skill", stage.skill);
    const role = requiredInput(manifest, "role-contract", stage.profile);
    const spec = {
      title: `[${epic.run_id}/${stage.key}]`,
      body: [
        formatTaskAuthority(authority), "", `Epic: ${epic.summary}`,
        `Stage: ${stage.key}`, `Workspace: ${workspace}`,
        gate ? `Command: agent-flow gate --spec ${gate.path}` : controllerCommand(epic.run_id, stage.key),
        "", (await readFile(skill.sealed_path, "utf8")).trim(), "",
        (await readFile(role.sealed_path, "utf8")).trim(), "",
      ].filter((line) => line !== null).join("\n"),
      assignee: stage.profile,
      tenant: epic.run_id,
      workspace: { kind: "dir", path: workspace },
      parents,
      idempotencyKey: `${epic.run_id}:${graph.version}:${stage.key}:1`,
      maxAttempts: stage.max_attempts,
      initialStatus: stage.key === graph.root ? "blocked" : "running",
    };
    const task = await adapter.createTask(spec);
    tasks.set(stage.key, task.id);
    const auditParents = stage.key !== graph.root &&
      !graph.transitions.some(({ from }) => from === stage.key);
    await auditTask(adapter, task.id, spec, auditParents);
  }
  const rootId = requiredTask(tasks, graph.root);
  for (const { parent, child } of graph.dependencies.filter(({ child }) => child === graph.root)) {
    await adapter.linkTasks({ parentId: requiredTask(tasks, parent), childId: requiredTask(tasks, child) });
  }
  const allowed = declaredStages(graph);
  for (const [stage, taskId] of Object.entries(prior?.tasks ?? {})) {
    if (tasks.has(stage)) continue;
    if (!allowed.has(stage)) throw new Error(`epic materialization contains undeclared stage ${stage}`);
    tasks.set(stage, taskId);
  }
  await auditTenant({ adapter, graph, manifest, runManifestPath, tasks });
  await atomicJson(join(layout.runDirectory, "materialization.json"), {
    run_id: epic.run_id, graph: `${graph.name}/v${graph.version}`,
    tasks: Object.fromEntries(tasks),
  });
  const root = await adapter.getTask({ taskId: rootId });
  if (root.status === "blocked") {
    await adapter.releaseTask({
      taskId: rootId, reason: "agent-flow verified the complete sealed epic topology",
    });
  } else if (root.status === "done") {
    throw new Error("epic run is already terminal and cannot be relaunched");
  } else if (!["todo", "ready", "running"].includes(root.status)) {
    throw new Error(`epic root has unexpected status ${root.status}`);
  }
  return { rootTaskId: rootId };
}

async function auditTenant({ adapter, graph, manifest, runManifestPath, tasks }) {
  const listed = await adapter.listTasks({ tenant: manifest.identity.tenant, includeArchived: true });
  const expected = new Set(tasks.values());
  const actual = new Set(listed.map(({ id }) => id));
  if (actual.size !== listed.length || actual.size !== expected.size ||
    [...expected].some((id) => !actual.has(id))) {
    throw new Error("epic tenant does not contain the exact declared task set");
  }
  const stages = declaredStages(graph);
  const digest = sha256(await readFile(runManifestPath));
  for (const [stage, taskId] of tasks) {
    const declared = stages.get(stage);
    const lifecycle = await adapter.getTaskLifecycle({ taskId });
    const authority = await parseTaskAuthority({ body: lifecycle.body, taskId });
    const gate = manifest.inputs.find(({ kind, sealed_path: path }) =>
      kind === "gate" && path.endsWith(`/${safe(stage)}.json`)
    );
    const skill = requiredInput(manifest, "skill", declared.skill);
    const role = requiredInput(manifest, "role-contract", declared.profile);
    const expectedParents = expectedEpicParents({ graph, stage, tasks });
    if (
      !declared || authority.runId !== manifest.identity.run_id || authority.stage !== stage ||
      authority.runManifestPath !== runManifestPath || authority.runManifestSha256 !== digest ||
      (gate
        ? authority.gateSpecPath !== gate.sealed_path || authority.gateSpecSha256 !== gate.sha256
        : authority.gateSpecPath !== undefined) ||
      lifecycle.title !== `[${manifest.identity.run_id}/${stage}]` ||
      lifecycle.tenant !== manifest.identity.tenant || lifecycle.assignee !== declared.profile ||
      lifecycle.workspace_kind !== "dir" ||
      lifecycle.workspace_path !== (declared.workspace === "integration-worktree"
        ? manifest.identity.repository.worktree : manifest.identity.run_directory) ||
      lifecycle.max_retries !== declared.max_attempts ||
      !sameMembers(lifecycle.parents, expectedParents) ||
      !lifecycle.body.includes((await readFile(skill.sealed_path, "utf8")).trim()) ||
      !lifecycle.body.includes((await readFile(role.sealed_path, "utf8")).trim()) ||
      lifecycle.status === "archived"
    ) throw new Error(`epic task ${taskId} differs from sealed authority`);
    if (lifecycle.status === "done" && !hasTerminalCompletedAttempt(lifecycle)) {
      throw new Error(`epic task ${taskId} is done without a terminal completed attempt`);
    }
  }
}

function expectedEpicParents({ graph, stage, tasks }) {
  const dependencies = [...graph.dependencies];
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      const instance = instantiateTransition(transition, ordinal);
      if (instance.stages.some(({ key }) => tasks.has(key))) {
        dependencies.push(...instance.dependencies);
      }
    }
  }
  return [...new Set(dependencies.filter(({ child }) => child === stage)
    .map(({ parent }) => tasks.get(parent)).filter(Boolean))];
}

function declaredStages(graph) {
  const stages = new Map(graph.stages.map((stage) => [stage.key, stage]));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      for (const stage of instantiateTransition(transition, ordinal).stages) stages.set(stage.key, stage);
    }
  }
  return stages;
}

function topologicalTransition(instance) {
  const pending = new Map(instance.stages.map((stage) => [stage.key, stage]));
  const result = [];
  while (pending.size > 0) {
    const next = [...pending.values()].find((stage) =>
      instance.dependencies
        .filter(({ child }) => child === stage.key)
        .every(({ parent }) => !pending.has(parent))
    );
    if (!next) throw new Error(`transition ${instance.key} is cyclic`);
    pending.delete(next.key);
    result.push(next);
  }
  return result;
}

function controllerCommand(runId, stage) {
  if (stage === "epic-controller") return `Controller command: agent-flow epic wave --run ${runId}`;
  if (stage === "stack-plan-checkpoint") return `Controller command: agent-flow epic checkpoint --run ${runId}`;
  return "Follow the sealed card instructions.";
}

async function auditTask(adapter, taskId, spec, auditParents) {
  const task = await adapter.getTask({ taskId });
  if (
    task.title !== spec.title || task.body !== spec.body || task.assignee !== spec.assignee ||
    task.tenant !== spec.tenant || task.workspace_kind !== spec.workspace.kind ||
    task.workspace_path !== spec.workspace.path || task.max_retries !== spec.maxAttempts ||
    (auditParents && !sameMembers(task.parents, spec.parents)) || task.status === "archived"
  ) throw new Error(`idempotent epic task ${taskId} differs from sealed authority`);
}

async function publish({ contents, graphBytes, layout, manifest, runDirectory }) {
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(runDirectory), `.${runDirectory.split("/").at(-1)}-`));
  try {
    await writeRelative(staging, runDirectory, layout.graph, graphBytes);
    for (const content of contents) {
      await writeRelative(staging, runDirectory, content.sealed_path, content.bytes);
    }
    await writeFile(join(staging, "run.json"), jsonBytes(manifest), { mode: 0o600 });
    await rename(staging, runDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeRelative(staging, runDirectory, destination, bytes) {
  const path = join(staging, relative(runDirectory, destination));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
}

function epicLayout(runDirectory) {
  return {
    runDirectory,
    artifacts: join(runDirectory, "artifacts"),
    validated: join(runDirectory, "validated"),
    graph: join(runDirectory, "inputs", "epic-flow.v1.json"),
    epic: join(runDirectory, "inputs", "epic.json"),
    gate: (name) => join(runDirectory, "inputs", "gates", `${safe(name)}.json`),
    skill: (name) => join(runDirectory, "inputs", "skills", `${safe(name)}.md`),
    role: (name) => join(runDirectory, "inputs", "roles", `${safe(name)}.md`),
  };
}

function requireHealthyProfiles(report, required) {
  if (!report?.ok) throw new Error("agent-flow doctor must pass before epic launch");
  const profiles = new Map((report.profiles ?? []).map((profile) => [profile.name, profile]));
  const profileSet = normalizeDigest(report.profileSetFingerprint);
  if (!profileSet) throw new Error("epic launch requires a verified profile-set fingerprint");
  const names = [...required].sort();
  const fingerprints = {};
  for (const name of names) {
    const profile = profiles.get(name);
    const fingerprint = normalizeDigest(profile?.configurationFingerprint);
    if (!profile?.available || !fingerprint) {
      throw new Error(`required profile is unavailable or unverified: ${name}`);
    }
    fingerprints[name] = fingerprint;
  }
  return {
    profile_set_fingerprint: profileSet,
    required: names,
    fingerprints,
  };
}

function normalizeDigest(value) {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(value)
    ? value.replace(/^sha256:/, "")
    : null;
}

function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((input) => input.kind === kind && input.name === name);
  if (!found) throw new Error(`epic run omits ${kind}/${name}`);
  return found;
}
function requiredGate(manifest, stage) {
  const suffix = `/${safe(stage)}.json`;
  const found = manifest.inputs.find(({ kind, sealed_path: path }) =>
    kind === "gate" && path.endsWith(suffix)
  );
  if (!found) throw new Error(`epic run omits gate ${stage}`);
  return found;
}
function requiredTask(tasks, stage) {
  const id = tasks.get(stage);
  if (!id) throw new Error(`epic task ${stage} is not materialized`);
  return id;
}
async function readOptional(path) {
  try { return JSON.parse(await readFile(path)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomicJson(path, document) {
  const temporary = `${path}.tmp.${process.pid}`;
  await writeFile(temporary, jsonBytes(document), { mode: 0o600 });
  await rename(temporary, path);
}
async function requireValid(document, label) {
  const validation = await validateContract(document);
  if (!validation.valid) {
    const error = validation.errors[0];
    throw new Error(`${label} is invalid: ${error?.instancePath || "/"} ${error?.message}`);
  }
}
async function gitRevision() {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => execFile(
    "git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
  ));
}
function item(kind, name, sealed_path, bytes) { return { kind, name, sealed_path, bytes }; }
function safe(value) { return value.replaceAll(":", "--"); }
function safeName(value) { return `epic-${safe(value)}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 128); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function aggregateFingerprint(graph, inputs) {
  return sha256(Buffer.from(JSON.stringify({
    graph: { name: graph.name, version: graph.version, flow: graph.flow, sha256: graph.sha256 },
    inputs: inputs.map(({ kind, name, sha256: digest }) => ({ kind, name, sha256: digest })),
  })));
}
function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every(
    (value, index) => value === [...right].sort()[index],
  );
}
