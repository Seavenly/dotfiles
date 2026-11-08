import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { acquireFileLock } from "./file-lock.mjs";
import {
  expandedTransitionStages,
  instantiateTransition,
} from "./graph-transition.mjs";
import {
  formatTaskAuthority,
  HermesAdapter,
  parseTaskAuthority,
} from "./hermes-adapter.mjs";
import { parseExternalRef } from "./external-root.mjs";
import { materializationOrder } from "./review-topology.mjs";
import { acquireExternalOwnershipLock } from "./run-lock.mjs";
import { assertExternalOwnershipAvailable } from "./run-ownership.mjs";
import { hasTerminalCompletedAttempt } from "./run-terminal.mjs";
import { validateContract } from "./schema-validator.mjs";
import { compileSpikeGraph } from "./spike-graph.mjs";

const execFile = promisify(execFileCallback);
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CARD_SKILL_ROOT = join(SOURCE_ROOT, "card-skills");
const LAUNCH_SOURCE = fileURLToPath(import.meta.url);
const CONTRACTS = [
  "agent-flow.run/v1", "agent-flow.graph/v1", "agent-flow.gate/v1",
  "agent-flow.command-result/v1", "agent-flow.handoff/v1",
  "agent-flow.validation/v1", "agent-flow.task-authority/v1",
  "agent-flow.migration-receipt/v1", "agent-flow.spike/v1",
];

export async function launchSpike({
  adapter = null,
  env = process.env,
  implementationRevision = null,
  manifestPath,
  now = () => new Date(),
  runDoctor,
}) {
  const spikeBytes = await readFile(manifestPath);
  const spike = JSON.parse(spikeBytes);
  await requireValid(spike, "spike manifest");
  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!stateHome) throw new Error("HOME or XDG_STATE_HOME is required");
  const runDirectory = join(stateHome, "agent-flow", "runs", spike.run_id);
  const resolvedAdapter = adapter ?? new HermesAdapter({ board: spike.kanban.board });
  const release = await acquireFileLock(
    join(stateHome, "agent-flow", "locks", `${spike.run_id}.lock`),
  );
  let releaseOwnership = null;
  try {
    const profiles = requireHealthyProfiles(await runDoctor(), [
      "flow-controller", "analyst", "critic", "builder", "artifact", "gate",
    ]);
    const repository = await realpath(spike.repo);
    const externalRoot = parseExternalRef(spike.external_ref);
    if (externalRoot !== null) {
      releaseOwnership = await acquireExternalOwnershipLock({
        externalRoot, repositoryPath: repository, stateHome,
      });
    }
    await assertExternalOwnershipAvailable({
      adapterForBoard: (board) => board === spike.kanban.board
        ? resolvedAdapter
        : new HermesAdapter({ board }),
      currentRunId: spike.run_id,
      externalRoot,
      repositoryPath: repository,
      stateHome,
      supersedes: spike.supersedes ?? null,
    });
    const source = await git(repository, "rev-parse", `${spike.source.ref}^{commit}`);
    if (source !== spike.source.sha) throw new Error("spike source ref moved from its pinned SHA");
    const worktree = spike.prototype
      ? await ensurePrototypeWorktree({ repository, spike, stateHome })
      : null;
    const graph = compileSpikeGraph({
      angles: spike.angles,
      maxPrototypeRetries: spike.limits.max_prototype_retries,
      maxRevisions: spike.limits.max_revisions,
      mode: spike.mode,
      prototype: spike.prototype,
    });
    await requireValid(graph, "spike graph");
    const revision = implementationRevision ?? await git(REPOSITORY_ROOT, "rev-parse", "HEAD");
    const bundle = await sealOrLoadSpike({
      graph,
      implementationRevision: revision,
      manifestPath,
      now,
      profiles,
      repository,
      runDirectory,
      spike,
      spikeBytes,
      worktree,
    });
    await resolvedAdapter.ensureBoard({
      name: `Agent Flow: ${spike.run_id}`,
      description: spike.summary,
      defaultWorkdir: repository,
    });
    return materializeSpike({ adapter: resolvedAdapter, bundle, spike, worktree });
  } finally {
    if (releaseOwnership) await releaseOwnership();
    await release();
  }
}

async function ensurePrototypeWorktree({ repository, spike, stateHome }) {
  const path = join(stateHome, "agent-flow", "worktrees", spike.run_id);
  try {
    await access(path);
    const [repositoryCommon, worktreeCommon, branch] = await Promise.all([
      gitCommonDirectory(repository),
      gitCommonDirectory(path),
      git(path, "symbolic-ref", "--short", "HEAD"),
    ]);
    if (repositoryCommon !== worktreeCommon || branch !== spike.prototype.branch) {
      throw new Error("existing prototype worktree has the wrong identity");
    }
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let exists = true;
  try { await git(repository, "show-ref", "--verify", `refs/heads/${spike.prototype.branch}`); }
  catch { exists = false; }
  if (exists) {
    const head = await git(repository, "rev-parse", `${spike.prototype.branch}^{commit}`);
    if (head !== spike.source.sha) throw new Error("prototype branch has a different run identity");
    await execFile("git", ["-C", repository, "worktree", "add", path, spike.prototype.branch]);
  } else {
    await execFile("git", [
      "-C", repository, "worktree", "add", "-b", spike.prototype.branch,
      path, spike.source.sha,
    ]);
  }
  await mkdir(join(path, spike.prototype.experiment_path), { recursive: true });
  return realpath(path);
}

async function sealOrLoadSpike({
  graph,
  implementationRevision,
  manifestPath,
  now,
  profiles,
  repository,
  runDirectory,
  spike,
  spikeBytes,
  worktree,
}) {
  const layout = spikeLayout(runDirectory);
  const graphBytes = jsonBytes(graph);
  const gates = await generateSpikeGates({ graph, layout, spike, worktree });
  const stages = [...graph.stages, ...expandedTransitionStages(graph)];
  const contents = [
    item("brief", "spike.json", manifestPath, layout.spike, spikeBytes),
    ...gates.map((gate) => item(
      "gate", gate.name, LAUNCH_SOURCE, gate.path, jsonBytes(gate.document),
    )),
  ];
  for (const skill of [...new Set(stages.map(({ skill }) => skill))].sort()) {
    const source = join(CARD_SKILL_ROOT, `${skill}.md`);
    contents.push(item("skill", skill, source, layout.skill(skill), await readFile(source)));
  }
  for (const profile of [...new Set(stages.map(({ profile }) => profile))].sort()) {
    const source = join(SOURCE_ROOT, "role-contracts", `${profile}.md`);
    contents.push(item("role-contract", profile, source, layout.role(profile), await readFile(source)));
  }
  const inputs = contents.map(({ bytes, ...identity }) => ({ ...identity, sha256: sha256(bytes) }));
  const graphIdentity = {
    name: graph.name, version: graph.version, flow: graph.flow,
    sealed_path: layout.graph, sha256: sha256(graphBytes),
  };
  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision: implementationRevision,
      compatible_contracts: CONTRACTS,
      content_set_fingerprint: aggregateFingerprint(graphIdentity, inputs),
    },
    identity: {
      run_id: spike.run_id,
      run_directory: runDirectory,
      artifact_directory: layout.artifacts,
      validation_directory: layout.validated,
      flow: "spike",
      repository: { path: repository, worktree, forge_coordinate: null },
      board: spike.kanban.board,
      tenant: spike.run_id,
      parent_run_id: null,
      external_root: parseExternalRef(spike.external_ref),
      supersedes: spike.supersedes ?? null,
    },
    graph: graphIdentity,
    approved_read_roots: [runDirectory, repository, ...(worktree ? [worktree] : [])],
    approved_artifact_roots: [layout.artifacts],
    inputs,
    profiles,
    limits: {
      max_created_cards: graph.stages.length + graph.transitions.reduce(
        (sum, transition) => sum + transition.max_instances * transition.stages.length, 0,
      ),
      max_worker_attempts: graph.stages.reduce((sum, stage) => sum + stage.max_attempts, 0),
      max_elapsed_seconds: spike.limits.max_elapsed_seconds,
      max_feature_streams: 1,
    },
    revisions: { base: spike.source.sha, source: spike.source.sha, target: null },
    sealed_at: now().toISOString(),
  };
  await requireValid(manifest, "generated spike run manifest");
  const runManifestPath = join(runDirectory, "run.json");
  try {
    const existingBytes = await readFile(runManifestPath);
    const existing = JSON.parse(existingBytes);
    await requireValid(existing, "existing spike run manifest");
    if (
      existing.identity.run_id !== spike.run_id ||
      existing.identity.repository.path !== repository ||
      existing.identity.repository.worktree !== worktree ||
      existing.implementation.revision !== implementationRevision ||
      JSON.stringify(existing.profiles) !== JSON.stringify(profiles) ||
      existing.graph.sha256 !== manifest.graph.sha256 ||
      existing.implementation.content_set_fingerprint !== manifest.implementation.content_set_fingerprint
    ) throw new Error("existing spike run does not match current sealed authority");
    for (const input of existing.inputs) {
      if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
        throw new Error(`existing sealed input changed: ${input.kind}/${input.name}`);
      }
    }
    return {
      gates: await loadGates(existing), graph, manifest: existing,
      manifestBytes: existingBytes, runDirectory, runManifestPath,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await publish({ contents, graphBytes, layout, manifest, runDirectory });
  return {
    gates: new Map(gates.map((gate) => [gate.stage, gate])), graph, manifest,
    manifestBytes: jsonBytes(manifest), runDirectory, runManifestPath,
  };
}

async function generateSpikeGates({ graph, layout, spike, worktree }) {
  const gates = [];
  for (const stage of [...graph.stages, ...expandedTransitionStages(graph)]
    .filter(({ profile }) => profile === "gate")) {
    let document;
    if (stage.validates_handoff_for) {
      document = {
        schema: "agent-flow.gate/v1", name: safeName(stage.key), version: 1,
        run_id: spike.run_id, stage: stage.key, kind: "handoff-validation",
        workspace: layout.runDirectory, read_roots: [layout.runDirectory],
        write_root: layout.artifacts, timeout_seconds: 120, inputs: [],
        outputs: [join(layout.artifacts, "validations", `${safe(stage.key)}.json`)],
        handoff_validation: {
          producer_stage: stage.validates_handoff_for,
          require_passed: false,
        },
      };
    } else if (stage.key === "spike-finalize") {
      const commandOutput = join(layout.artifacts, "gates", "spike-finalize", "1.json");
      document = {
        schema: "agent-flow.gate/v1", name: "spike-finalize", version: 1,
        run_id: spike.run_id, stage: stage.key, kind: "command",
        workspace: layout.runDirectory, read_roots: [layout.runDirectory, ...(worktree ? [worktree] : [])],
        write_root: layout.artifacts, timeout_seconds: 300, inputs: [],
        outputs: [commandOutput, join(layout.artifacts, "spike-result.json")],
        commands: [{
          argv: ["agent-flow", "spike", "finalize", "--run", spike.run_id],
          cwd: layout.runDirectory,
          output_path: commandOutput,
        }],
      };
    } else {
      if (!worktree) throw new Error("research-only spike graph contains a product gate");
      const ordinal = Number(stage.key.match(/prototype-gate:(?:retry-)?(\d+)/)?.[1] ?? 1);
      const commands = spike.prototype.slices[ordinal - 1]?.verification ?? spike.prototype.verification;
      const outputs = commands.map((_, index) =>
        join(layout.artifacts, "gates", safe(stage.key), `${index + 1}.json`)
      );
      document = {
        schema: "agent-flow.gate/v1", name: safeName(stage.key), version: 1,
        run_id: spike.run_id, stage: stage.key, kind: "command",
        workspace: worktree, read_roots: [layout.runDirectory, worktree],
        write_root: layout.artifacts, timeout_seconds: 3600, inputs: [], outputs,
        commands: commands.map(({ argv }, index) => ({ argv, cwd: worktree, output_path: outputs[index] })),
      };
    }
    await requireValid(document, `spike gate ${stage.key}`);
    gates.push({ document, name: `${safe(stage.key)}.json`, path: layout.gate(stage.key), stage: stage.key });
  }
  return gates;
}

async function materializeSpike({ adapter, bundle, spike, worktree }) {
  const order = materializationOrder(bundle.graph, "standard");
  const tasks = new Map();
  const materializationPath = join(bundle.runDirectory, "materialization.json");
  const prior = await readOptionalJson(materializationPath);
  const digest = sha256(bundle.manifestBytes);
  for (const stage of order) {
    const parents = stage.key === bundle.graph.root ? [] : bundle.graph.dependencies
      .filter(({ child }) => child === stage.key)
      .map(({ parent }) => requiredTask(tasks, parent));
    const authority = {
      schema: "agent-flow.task-authority/v1", run_id: spike.run_id,
      stage: stage.key, run_manifest_path: bundle.runManifestPath,
      run_manifest_sha256: digest,
    };
    const gate = bundle.gates.get(stage.key);
    if (gate) {
      authority.gate_spec_path = gate.path;
      authority.gate_spec_sha256 = sha256(jsonBytes(gate.document));
    }
    if (stage.validates_handoff_for) {
      authority.producer_task_id = requiredTask(tasks, stage.validates_handoff_for);
    }
    await requireValid(authority, `spike task authority ${stage.key}`);
    const skill = requiredInput(bundle.manifest, "skill", stage.skill);
    const role = requiredInput(bundle.manifest, "role-contract", stage.profile);
    const workspace = stage.workspace === "feature-worktree" ? worktree : bundle.runDirectory;
    const spec = {
      title: `[${spike.run_id}/${stage.key}]`,
      body: [
        formatTaskAuthority(authority), "", `Spike: ${spike.question}`,
        `Stage: ${stage.key}`, `Workspace: ${workspace}`,
        spike.prototype ? `Approved experiment path: ${join(worktree, spike.prototype.experiment_path)}` : "Product writes and Git ref mutation are forbidden.",
        gate ? `Command: agent-flow gate --spec ${gate.path}` : "Follow the sealed card instructions.",
        stage.key === "gap-controller" || stage.key.startsWith("prototype-controller:")
          ? `Controller command: agent-flow spike advance --run ${spike.run_id} --controller ${stage.key}`
          : null,
        "", (await readFile(skill.sealed_path, "utf8")).trim(), "",
        (await readFile(role.sealed_path, "utf8")).trim(), "",
      ].filter((line) => line !== null).join("\n"),
      assignee: stage.profile, tenant: spike.run_id,
      workspace: { kind: "dir", path: workspace }, parents,
      idempotencyKey: `${spike.run_id}:${bundle.graph.version}:${stage.key}:1`,
      maxAttempts: stage.max_attempts,
      initialStatus: stage.key === bundle.graph.root ? "blocked" : "running",
    };
    const task = await adapter.createTask(spec);
    tasks.set(stage.key, task.id);
    await auditTask(
      adapter,
      task.id,
      spec,
      stage.key !== bundle.graph.root &&
        !bundle.graph.transitions.some(({ from }) => from === stage.key),
    );
  }
  const root = requiredTask(tasks, bundle.graph.root);
  for (const { parent, child } of bundle.graph.dependencies.filter(({ child }) => child === bundle.graph.root)) {
    await adapter.linkTasks({ parentId: requiredTask(tasks, parent), childId: requiredTask(tasks, child) });
  }
  const declaredDynamic = new Set(expandedTransitionStages(bundle.graph).map(({ key }) => key));
  for (const [stage, taskId] of Object.entries(prior?.tasks ?? {})) {
    if (tasks.has(stage)) continue;
    if (!declaredDynamic.has(stage)) throw new Error(`spike materialization contains undeclared stage ${stage}`);
    tasks.set(stage, taskId);
  }
  await auditSpikeTenant({
    adapter, graph: bundle.graph, manifest: bundle.manifest,
    runManifestPath: bundle.runManifestPath, spike, tasks, worktree,
  });
  await writeFile(materializationPath, jsonBytes({
    run_id: spike.run_id, graph: `${bundle.graph.name}/v${bundle.graph.version}`,
    tasks: Object.fromEntries(tasks),
  }), { mode: 0o600 });
  const rootTask = await adapter.getTask({ taskId: root });
  if (rootTask.status === "blocked") {
    await adapter.releaseTask({ taskId: root, reason: "agent-flow verified the complete sealed spike topology" });
  } else if (rootTask.status === "done") {
    throw new Error("spike run is already terminal and cannot be relaunched");
  } else if (!["todo", "ready", "running"].includes(rootTask.status)) {
    throw new Error(`spike root has unexpected status ${rootTask.status}`);
  }
  return {
    cardCount: order.length, rootTaskId: root, runId: spike.run_id,
    runManifestPath: bundle.runManifestPath, worktree,
  };
}

async function auditSpikeTenant({
  adapter,
  graph,
  manifest,
  runManifestPath,
  spike,
  tasks,
  worktree,
}) {
  const listed = await adapter.listTasks({ tenant: spike.run_id, includeArchived: true });
  if (!Array.isArray(listed)) throw new Error("Hermes adapter did not return a task list");
  const expectedIds = new Set(tasks.values());
  const actualIds = new Set(listed.map(({ id }) => id));
  if (
    actualIds.size !== listed.length || actualIds.size !== expectedIds.size ||
    [...expectedIds].some((taskId) => !actualIds.has(taskId))
  ) throw new Error("spike tenant does not contain the exact sealed task set");

  const stages = declaredSpikeStages(graph);
  const manifestDigest = sha256(await readFile(runManifestPath));
  for (const [stageKey, taskId] of tasks) {
    const stage = stages.get(stageKey);
    if (!stage) throw new Error(`spike materialization contains undeclared stage ${stageKey}`);
    const lifecycle = await adapter.getTaskLifecycle({ taskId });
    const authority = await parseTaskAuthority({ body: lifecycle.body, taskId });
    const workspace = stage.workspace === "feature-worktree"
      ? worktree
      : manifest.identity.run_directory;
    const expectedParents = spikeStageParents(graph, stageKey, tasks);
    const skill = requiredInput(manifest, "skill", stage.skill);
    const role = requiredInput(manifest, "role-contract", stage.profile);
    if (
      authority.runId !== spike.run_id || authority.stage !== stageKey ||
      authority.runManifestPath !== runManifestPath ||
      authority.runManifestSha256 !== manifestDigest ||
      lifecycle.tenant !== spike.run_id || lifecycle.assignee !== stage.profile ||
      lifecycle.workspace_kind !== "dir" || lifecycle.workspace_path !== workspace ||
      lifecycle.max_retries !== stage.max_attempts ||
      !sameMembers(lifecycle.parents, expectedParents) || lifecycle.status === "archived" ||
      !lifecycle.title.startsWith(`[${spike.run_id}/${stageKey}`) ||
      (!lifecycle.body.includes(skill.sealed_path) &&
        !lifecycle.body.includes((await readFile(skill.sealed_path, "utf8")).trim())) ||
      !lifecycle.body.endsWith(`${(await readFile(role.sealed_path, "utf8")).trim()}\n`)
    ) throw new Error(`spike task ${taskId} differs from sealed authority`);
    const attempts = Array.isArray(lifecycle.runs) ? lifecycle.runs.length : 0;
    if (attempts > stage.max_attempts) {
      throw new Error(`spike task ${taskId} exceeds the ${stageKey} attempt limit`);
    }
    if (lifecycle.status === "done" && !hasTerminalCompletedAttempt(lifecycle)) {
      throw new Error(`spike task ${taskId} is done without a terminal completed attempt`);
    }
  }
}

function declaredSpikeStages(graph) {
  const stages = new Map(graph.stages.map((stage) => [stage.key, stage]));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      for (const stage of instantiateTransition(transition, ordinal).stages) {
        stages.set(stage.key, stage);
      }
    }
  }
  return stages;
}

function spikeStageParents(graph, stageKey, tasks) {
  const parents = graph.dependencies
    .filter(({ child }) => child === stageKey)
    .map(({ parent }) => requiredTask(tasks, parent));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      const instance = instantiateTransition(transition, ordinal);
      for (const { parent, child } of instance.dependencies) {
        if (child !== stageKey || !tasks.has(parent)) continue;
        if (child !== transition.from && !tasks.has(child)) continue;
        parents.push(requiredTask(tasks, parent));
      }
    }
  }
  return [...new Set(parents)];
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function auditTask(adapter, taskId, spec, auditParents) {
  const task = await adapter.getTask({ taskId });
  if (
    task.title !== spec.title || task.body !== spec.body || task.assignee !== spec.assignee ||
    task.tenant !== spec.tenant || task.workspace_kind !== spec.workspace.kind ||
    task.workspace_path !== spec.workspace.path || task.max_retries !== spec.maxAttempts ||
    (auditParents && !sameMembers(task.parents, spec.parents)) || task.status === "archived"
  ) throw new Error(`idempotent spike task ${taskId} does not match sealed authority`);
}

async function publish({ contents, graphBytes, layout, manifest, runDirectory }) {
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(runDirectory), `.${runDirectory.split("/").at(-1)}-`));
  try {
    await writeRelative(staging, runDirectory, layout.graph, graphBytes);
    for (const content of contents) await writeRelative(staging, runDirectory, content.sealed_path, content.bytes);
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

async function loadGates(manifest) {
  const gates = new Map();
  for (const input of manifest.inputs.filter(({ kind }) => kind === "gate")) {
    const document = JSON.parse(await readFile(input.sealed_path));
    await requireValid(document, `sealed spike gate ${input.name}`);
    gates.set(document.stage, { document, name: input.name, path: input.sealed_path, stage: document.stage });
  }
  return gates;
}

function spikeLayout(runDirectory) {
  return {
    runDirectory, artifacts: join(runDirectory, "artifacts"),
    validated: join(runDirectory, "validated"), graph: join(runDirectory, "inputs", "spike-flow.v1.json"),
    spike: join(runDirectory, "inputs", "spike.json"),
    gate: (name) => join(runDirectory, "inputs", "gates", `${safe(name)}.json`),
    skill: (name) => join(runDirectory, "inputs", "skills", `${safe(name)}.md`),
    role: (name) => join(runDirectory, "inputs", "roles", `${safe(name)}.md`),
  };
}

function item(kind, name, source_path, sealed_path, bytes) { return { kind, name, source_path, sealed_path, bytes }; }
function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((input) => input.kind === kind && input.name === name);
  if (!found) throw new Error(`spike run omits ${kind}/${name}`);
  return found;
}
function requiredTask(tasks, stage) {
  const id = tasks.get(stage);
  if (!id) throw new Error(`spike task ${stage} is not materialized`);
  return id;
}
function safe(value) { return value.replaceAll(":", "--"); }
function safeName(value) { return `spike-${safe(value)}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 128); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function aggregateFingerprint(graph, inputs) {
  return sha256(Buffer.from(JSON.stringify({
    graph: { name: graph.name, version: graph.version, flow: graph.flow, sha256: graph.sha256 },
    inputs: inputs.map(({ kind, name, sha256: digest }) => ({ kind, name, sha256: digest })),
  })));
}
function sameMembers(left = [], right = []) {
  const a = [...left].sort(); const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function normalizeDigest(value) {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(value)
    ? value.replace(/^sha256:/, "") : null;
}
function requireHealthyProfiles(report, required) {
  const byName = new Map(report.profiles?.map((profile) => [profile.name, profile]));
  const digest = normalizeDigest(report.profileSetFingerprint);
  if (!report.ok || !digest || required.some((name) =>
    !byName.get(name)?.available || !normalizeDigest(byName.get(name)?.configurationFingerprint)
  )) throw new Error("required Hermes profiles are unhealthy");
  return {
    profile_set_fingerprint: digest,
    required: [...required].sort(),
    fingerprints: Object.fromEntries([...required].sort().map((name) => [
      name, normalizeDigest(byName.get(name).configurationFingerprint),
    ])),
  };
}
async function requireValid(document, label) {
  const result = await validateContract(document);
  if (!result.valid) throw new Error(`${label} is invalid: ${result.errors[0]?.message}`);
}
async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}
async function gitCommonDirectory(path) {
  const common = await git(path, "rev-parse", "--git-common-dir");
  return realpath(resolve(path, common));
}
