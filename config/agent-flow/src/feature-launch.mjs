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
import { compileFeatureGraph } from "./feature-graph.mjs";
import { expandedTransitionStages } from "./graph-transition.mjs";
import {
  formatTaskAuthority,
  HermesAdapter,
  parseTaskAuthority,
} from "./hermes-adapter.mjs";
import { instantiateTransition } from "./graph-transition.mjs";
import { parseExternalRef } from "./external-root.mjs";
import { materializationOrder } from "./review-topology.mjs";
import { acquireExternalOwnershipLock } from "./run-lock.mjs";
import { assertExternalOwnershipAvailable } from "./run-ownership.mjs";
import { hasTerminalCompletedAttempt } from "./run-terminal.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFile = promisify(execFileCallback);
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CARD_SKILL_ROOT = join(SOURCE_ROOT, "card-skills");
const LAUNCH_SOURCE = fileURLToPath(import.meta.url);
const CONTRACTS = [
  "agent-flow.run/v1",
  "agent-flow.graph/v1",
  "agent-flow.gate/v1",
  "agent-flow.command-result/v1",
  "agent-flow.handoff/v1",
  "agent-flow.validation/v1",
  "agent-flow.task-authority/v1",
  "agent-flow.migration-receipt/v1",
  "agent-flow.local-review/v1",
  "agent-flow.review-comment-dispositions/v1",
  "agent-flow.integration-receipt/v1",
  "agent-flow.feature/v1",
];

export async function launchFeature({
  adapter = null,
  env = process.env,
  implementationRevision = null,
  manifestPath,
  now = () => new Date(),
  runDoctor,
}) {
  const manifestBytes = await readFile(manifestPath);
  const feature = JSON.parse(manifestBytes);
  await requireValid(feature, "feature manifest");
  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!stateHome) throw new Error("HOME or XDG_STATE_HOME is required");
  const runDirectory = join(stateHome, "agent-flow", "runs", feature.run_id);
  const resolvedAdapter = adapter ?? new HermesAdapter({ board: feature.kanban.board });
  const lockPath = join(stateHome, "agent-flow", "locks", `${feature.run_id}.lock`);
  const release = await acquireFileLock(lockPath);
  let releaseOwnership = null;
  try {
    const profiles = requireHealthyProfiles(await runDoctor(), [
      "flow-controller",
      "analyst",
      "critic",
      "builder",
      "artifact",
      "gate",
    ]);
    const repository = await inspectFeatureRepository(feature);
    const externalRoot = parseExternalRef(feature.external_ref);
    if (externalRoot !== null) {
      releaseOwnership = await acquireExternalOwnershipLock({
        externalRoot, repositoryPath: repository, stateHome,
      });
    }
    await assertExternalOwnershipAvailable({
      adapterForBoard: (board) => board === feature.kanban.board
        ? resolvedAdapter
        : new HermesAdapter({ board }),
      currentRunId: feature.run_id,
      externalRoot,
      repositoryPath: repository,
      stateHome,
      supersedes: feature.supersedes ?? null,
    });
    const worktree = await ensureFeatureWorktree({
      baseSha: feature.base.sha,
      branch: feature.branch,
      repository,
      runId: feature.run_id,
      stateHome,
    });
    const graph = compileFeatureGraph({
      slices: feature.slices,
      maxSliceRetries: feature.limits.max_slice_retries,
      maxCompletenessFixes: feature.limits.max_completeness_fixes,
      maxCritiqueFixes: feature.limits.max_critique_fixes,
    });
    await requireValid(graph, "feature graph");
    const revision = implementationRevision ?? await git(REPOSITORY_ROOT, "rev-parse", "HEAD");
    const bundle = await sealOrLoadFeatureBundle({
      feature,
      graph,
      implementationRevision: revision,
      manifestBytes,
      manifestPath,
      now,
      profiles,
      repository,
      runDirectory,
      worktree,
    });
    await resolvedAdapter.ensureBoard({
      name: `Agent Flow: ${feature.run_id}`,
      description: feature.summary,
      defaultWorkdir: repository,
    });
    return await materializeFeature({
      adapter: resolvedAdapter,
      bundle,
      feature,
      worktree,
    });
  } finally {
    if (releaseOwnership) await releaseOwnership();
    await release();
  }
}

export async function inspectFeatureRepository(feature) {
  const repository = await realpath(feature.repo);
  const branchHead = await git(
    repository,
    "rev-parse",
    "--verify",
    `refs/heads/${feature.base.branch}^{commit}`,
  );
  if (branchHead !== feature.base.sha) {
    throw new Error("feature base branch does not match its pinned SHA");
  }
  await git(repository, "cat-file", "-e", `${feature.base.sha}^{commit}`);
  return repository;
}

async function ensureFeatureWorktree({ baseSha, branch, repository, runId, stateHome }) {
  const worktree = join(stateHome, "agent-flow", "worktrees", runId);
  try {
    await access(worktree);
    const [commonRepository, commonWorktree, actualBranch] = await Promise.all([
      gitCommonDirectory(repository),
      gitCommonDirectory(worktree),
      git(worktree, "symbolic-ref", "--short", "HEAD"),
    ]);
    if (commonRepository !== commonWorktree || actualBranch !== branch) {
      throw new Error("existing feature worktree does not match the run identity");
    }
    return await realpath(worktree);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
  let branchExists = true;
  try {
    await git(repository, "show-ref", "--verify", `refs/heads/${branch}`);
  } catch {
    branchExists = false;
  }
  if (branchExists) {
    const existingHead = await git(
      repository,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    );
    if (existingHead !== baseSha) {
      throw new Error("feature branch already exists with a different run identity");
    }
    await execFile("git", ["-C", repository, "worktree", "add", worktree, branch]);
  } else {
    await execFile("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      branch,
      worktree,
      baseSha,
    ]);
  }
  return realpath(worktree);
}

async function sealOrLoadFeatureBundle({
  feature,
  graph,
  implementationRevision,
  manifestBytes,
  manifestPath,
  now,
  profiles,
  repository,
  runDirectory,
  worktree,
}) {
  const layout = flowLayout(runDirectory);
  const gates = await generateFeatureGates({ feature, graph, layout, worktree });
  const graphBytes = jsonBytes(graph);
  const inputContents = await featureInputContents({
    feature,
    gates,
    graph,
    layout,
    manifestBytes,
    manifestPath,
  });
  const expectedInputs = inputContents.map(({ bytes, ...identity }) => ({
    ...identity,
    sha256: sha256(bytes),
  }));
  const runManifestPath = join(runDirectory, "run.json");
  try {
    const existingBytes = await readFile(runManifestPath);
    const manifest = JSON.parse(existingBytes);
    await requireValid(manifest, "existing feature run manifest");
    const sealedFeature = manifest.inputs.find(
      ({ kind, name }) => kind === "brief" && name === "feature.json",
    );
    if (
      manifest.identity.flow !== "feature" ||
      manifest.identity.run_id !== feature.run_id ||
      manifest.identity.repository.path !== repository ||
      manifest.identity.repository.worktree !== worktree ||
      manifest.implementation.revision !== implementationRevision ||
      JSON.stringify(manifest.profiles) !== JSON.stringify(profiles) ||
      !sealedFeature ||
      sealedFeature.sha256 !== sha256(manifestBytes)
    ) {
      throw new Error("existing feature run does not match this launch");
    }
    const sealedGraphBytes = await readFile(manifest.graph.sealed_path);
    if (
      sha256(sealedGraphBytes) !== manifest.graph.sha256 ||
      manifest.graph.sha256 !== sha256(graphBytes)
    ) {
      throw new Error("existing feature graph does not match current sealed authority");
    }
    for (const item of manifest.inputs) {
      if (sha256(await readFile(item.sealed_path)) !== item.sha256) {
        throw new Error(`existing sealed input changed: ${item.kind}/${item.name}`);
      }
    }
    if (
      manifest.inputs.length !== expectedInputs.length ||
      expectedInputs.some((expected) => !manifest.inputs.some((actual) =>
        actual.kind === expected.kind &&
        actual.name === expected.name &&
        actual.source_path === expected.source_path &&
        actual.sealed_path === expected.sealed_path &&
        actual.sha256 === expected.sha256
      )) ||
      aggregateFingerprint(manifest.graph, manifest.inputs) !==
        manifest.implementation.content_set_fingerprint
    ) {
      throw new Error("existing feature input set does not match current sealed authority");
    }
    const sealedGraph = JSON.parse(sealedGraphBytes);
    await requireValid(sealedGraph, "existing feature graph");
    return {
      gates: await loadGateMap(manifest),
      graph: sealedGraph,
      manifest,
      manifestBytes: existingBytes,
      runDirectory,
      runManifestPath,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const inputs = expectedInputs;
  const graphIdentity = {
    name: graph.name,
    version: graph.version,
    flow: graph.flow,
    sealed_path: layout.graph,
    sha256: sha256(graphBytes),
  };
  const transitionCards = graph.transitions.reduce(
    (total, transition) => total + transition.max_instances * transition.stages.length,
    0,
  );
  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision: implementationRevision,
      compatible_contracts: CONTRACTS,
      content_set_fingerprint: aggregateFingerprint(graphIdentity, inputs),
    },
    identity: {
      run_id: feature.run_id,
      run_directory: runDirectory,
      artifact_directory: layout.artifacts,
      validation_directory: layout.validated,
      flow: "feature",
      repository: { path: repository, worktree, forge_coordinate: null },
      board: feature.kanban.board,
      tenant: feature.run_id,
      parent_run_id: feature.parent_run_id ?? null,
      external_root: parseExternalRef(feature.external_ref),
      supersedes: feature.supersedes ?? null,
    },
    graph: graphIdentity,
    approved_read_roots: [runDirectory, repository, worktree],
    approved_artifact_roots: [layout.artifacts],
    inputs,
    profiles,
    limits: {
      max_created_cards: graph.stages.length + transitionCards,
      max_worker_attempts: graph.stages.reduce((sum, stage) => sum + stage.max_attempts, 0) + transitionCards * 2,
      max_elapsed_seconds: feature.limits.max_elapsed_seconds,
      max_feature_streams: 1,
    },
    revisions: { base: feature.base.sha, source: feature.base.sha, target: null },
    sealed_at: now().toISOString(),
  };
  await requireValid(manifest, "generated feature run manifest");

  await publishBundle({
    graphBytes,
    inputContents,
    manifestBytes: jsonBytes(manifest),
    runDirectory,
    graphPath: layout.graph,
  });
  return {
    gates: new Map(gates.map((gate) => [gate.stage, gate])),
    graph,
    manifest,
    manifestBytes: jsonBytes(manifest),
    runDirectory,
    runManifestPath,
  };
}

async function featureInputContents({
  feature,
  gates,
  graph,
  layout,
  manifestBytes,
  manifestPath,
}) {
  const stages = [
    ...graph.stages,
    ...expandedTransitionStages(graph),
  ];
  const contents = [
    input("brief", "feature.json", manifestPath, layout.feature, manifestBytes),
    input("plan", "slices.json", manifestPath, layout.plan, jsonBytes(feature.slices)),
    ...gates.map((gate) =>
      input("gate", gate.name, LAUNCH_SOURCE, gate.path, jsonBytes(gate.document))
    ),
  ];
  for (const skill of [...new Set(stages.map(({ skill }) => skill))].sort()) {
    const source = join(CARD_SKILL_ROOT, `${skill}.md`);
    contents.push(input(
      "skill",
      skill,
      source,
      layout.skill(skill),
      await readFile(source),
    ));
  }
  for (const profile of [...new Set(stages.map(({ profile }) => profile))].sort()) {
    const source = join(SOURCE_ROOT, "role-contracts", `${profile}.md`);
    contents.push(input(
      "role-contract",
      profile,
      source,
      layout.role(profile),
      await readFile(source),
    ));
  }
  return contents;
}

async function generateFeatureGates({ feature, graph, layout, worktree }) {
  const gates = [];
  const stages = [
    ...graph.stages,
    ...expandedTransitionStages(graph),
  ];
  for (const stage of stages.filter(({ profile }) => profile === "gate")) {
    let document;
    if (stage.validates_handoff_for) {
      const output = join(layout.artifacts, "validations", `${safe(stage.key)}.json`);
      document = {
        schema: "agent-flow.gate/v1",
        name: safeName(stage.key),
        version: 1,
        run_id: feature.run_id,
        stage: stage.key,
        kind: "handoff-validation",
        workspace: layout.runDirectory,
        read_roots: [layout.runDirectory],
        write_root: layout.artifacts,
        timeout_seconds: 120,
        inputs: [],
        outputs: [output],
        handoff_validation: {
          producer_stage: stage.validates_handoff_for,
          require_passed: false,
        },
      };
    } else {
      const commands = commandsForStage(feature, stage.key, worktree);
      const outputs = commands.map((_, index) =>
        join(layout.artifacts, "gates", safe(stage.key), `${index + 1}.txt`)
      );
      if (stage.key === "local-review-manifest") {
        outputs.push(join(layout.artifacts, "review.json"));
      }
      document = {
        schema: "agent-flow.gate/v1",
        name: safeName(stage.key),
        version: 1,
        run_id: feature.run_id,
        stage: stage.key,
        kind: "command",
        workspace: stage.workspace === "run-dir" ? layout.runDirectory : worktree,
        read_roots: [layout.runDirectory, worktree],
        write_root: layout.artifacts,
        timeout_seconds: 3600,
        inputs: [],
        outputs,
        commands: commands.map(({ argv }, index) => ({
          argv,
          cwd: stage.workspace === "run-dir" ? layout.runDirectory : worktree,
          output_path: outputs[index],
        })),
      };
    }
    await requireValid(document, `generated feature gate ${stage.key}`);
    gates.push({
      document,
      name: `${safe(stage.key)}.json`,
      path: layout.gate(stage.key),
      stage: stage.key,
    });
  }
  return gates;
}

function commandsForStage(feature, stageKey, worktree) {
  const match = /^gate:(\d+)$/.exec(stageKey);
  if (match) return feature.slices[Number(match[1]) - 1].verification;
  const retry = /^gate:retry-(\d+):\d+$/.exec(stageKey);
  if (retry) return feature.slices[Number(retry[1]) - 1].verification;
  if (/^gate:(?:planned|completeness-fix|critique-fix):\d+$/.test(stageKey)) {
    return feature.verification;
  }
  if (stageKey === "final-verification") return feature.verification;
  if (stageKey === "local-review-manifest") {
    return [{ argv: ["agent-flow", "feature", "finalize", "--run", feature.run_id] }];
  }
  return [{ argv: ["git", "-C", worktree, "rev-parse", "HEAD"] }];
}

async function materializeFeature({ adapter, bundle, feature, worktree }) {
  const order = materializationOrder(bundle.graph, "hotfix");
  const taskIds = new Map();
  const receiptPath = join(bundle.runDirectory, "materialization.json");
  const priorMaterialization = await readOptionalJson(receiptPath);
  const manifestDigest = sha256(bundle.manifestBytes);
  let rootTaskId = null;
  try {
    for (const stage of order) {
      const lookup = new Map([
        ...Object.entries(priorMaterialization?.tasks ?? {}),
        ...taskIds,
      ]);
      const parents = stage.key === bundle.graph.root
        ? []
        : expectedStageParents(bundle.graph, stage.key, lookup);
      const authority = {
        schema: "agent-flow.task-authority/v1",
        run_id: feature.run_id,
        stage: stage.key,
        run_manifest_path: bundle.runManifestPath,
        run_manifest_sha256: manifestDigest,
      };
      const gate = bundle.gates.get(stage.key);
      if (gate) {
        authority.gate_spec_path = gate.path;
        authority.gate_spec_sha256 = sha256(jsonBytes(gate.document));
      }
      if (stage.validates_handoff_for) {
        authority.producer_task_id = requiredTask(taskIds, stage.validates_handoff_for);
      }
      await requireValid(authority, `task authority for ${stage.key}`);
      const workspace = stage.workspace === "run-dir" ? bundle.runDirectory : worktree;
      const skillInput = requiredInput(bundle.manifest, "skill", stage.skill);
      const roleInput = requiredInput(bundle.manifest, "role-contract", stage.profile);
      const [skill, role] = await Promise.all([
        readFile(skillInput.sealed_path, "utf8"),
        readFile(roleInput.sealed_path, "utf8"),
      ]);
      const spec = {
        title: `[${feature.run_id}/${stage.key}]`,
        body: featureCardBody({
          authority,
          feature,
          gate,
          role,
          rolePath: roleInput.sealed_path,
          skill,
          skillPath: skillInput.sealed_path,
          stage,
          workspace,
        }),
        assignee: stage.profile,
        tenant: feature.run_id,
        workspace: { kind: "dir", path: workspace },
        parents,
        idempotencyKey: `${feature.run_id}:${bundle.graph.version}:${stage.key}:1`,
        maxAttempts: stage.max_attempts,
        initialStatus: stage.key === bundle.graph.root ? "blocked" : "running",
      };
      const task = await adapter.createTask(spec);
      taskIds.set(stage.key, task.id);
      if (stage.key === bundle.graph.root) rootTaskId = task.id;
      await auditTask(adapter, task.id, spec, { auditParents: stage.key !== bundle.graph.root });
    }
    rootTaskId = requiredTask(taskIds, bundle.graph.root);
    for (const { parent, child } of bundle.graph.dependencies.filter(
      ({ child }) => child === bundle.graph.root,
    )) {
      await adapter.linkTasks({
        parentId: requiredTask(taskIds, parent),
        childId: requiredTask(taskIds, child),
      });
    }
    for (const stage of order) {
      const lookup = new Map([
        ...Object.entries(priorMaterialization?.tasks ?? {}),
        ...taskIds,
      ]);
      const expectedParents = expectedStageParents(bundle.graph, stage.key, lookup);
      const task = await adapter.getTask({ taskId: requiredTask(taskIds, stage.key) });
      if (!sameMembers(task.parents, expectedParents)) {
        throw new Error(`task ${task.id} has unexpected dependency parents`);
      }
    }
    const allTasks = mergeDeclaredDynamicTasks({
      graph: bundle.graph,
      prior: priorMaterialization?.tasks ?? {},
      staticTasks: taskIds,
    });
    await auditFeatureTenant({
      adapter,
      graph: bundle.graph,
      manifest: bundle.manifest,
      order,
      rootStage: bundle.graph.root,
      runManifestPath: bundle.runManifestPath,
      taskIds: allTasks,
      tenant: feature.run_id,
    });
    await writeFile(receiptPath, jsonBytes({
      run_id: feature.run_id,
      graph: `${bundle.graph.name}/v${bundle.graph.version}`,
      tasks: Object.fromEntries(allTasks),
    }), { mode: 0o600 });
    const root = await adapter.getTask({ taskId: rootTaskId });
    if (root.status === "blocked") {
      await adapter.releaseTask({
        taskId: rootTaskId,
        reason: "agent-flow verified the complete sealed feature topology",
      });
    } else if (root.status === "done") {
      throw new Error("feature run is already terminal and cannot be relaunched");
    } else if (!["todo", "ready", "running"].includes(root.status)) {
      throw new Error(`feature root has unexpected status ${root.status}`);
    }
    return {
      cardCount: order.length,
      rootTaskId,
      runId: feature.run_id,
      runManifestPath: bundle.runManifestPath,
      worktree,
    };
  } catch (error) {
    if (rootTaskId !== null) {
      await adapter.commentTask?.({
        taskId: rootTaskId,
        body: `Launch recovery required: ${error.message}. Re-run the identical feature launch after correcting the cause.`,
      }).catch(() => {});
    }
    throw error;
  }
}

async function publishBundle({ graphBytes, graphPath, inputContents, manifestBytes, runDirectory }) {
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(runDirectory), `.${runDirectory.split("/").at(-1)}-`));
  try {
    await writeRelative(staging, runDirectory, graphPath, graphBytes);
    for (const item of inputContents) {
      await writeRelative(staging, runDirectory, item.sealed_path, item.bytes);
    }
    await writeFile(join(staging, "run.json"), manifestBytes, { mode: 0o600 });
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

async function loadGateMap(manifest) {
  const gates = new Map();
  for (const input of manifest.inputs.filter(({ kind }) => kind === "gate")) {
    const document = JSON.parse(await readFile(input.sealed_path));
    await requireValid(document, `sealed gate ${input.name}`);
    gates.set(document.stage, {
      document,
      name: input.name,
      path: input.sealed_path,
      stage: document.stage,
    });
  }
  return gates;
}

function featureCardBody({
  authority,
  feature,
  gate,
  role,
  rolePath,
  skill,
  skillPath,
  stage,
  workspace,
}) {
  const controllerCommand = isFeatureTransitionController(stage.key)
    ? `Controller command: agent-flow feature advance --run ${feature.run_id} --controller ${stage.key}`
    : null;
  return [
    formatTaskAuthority(authority),
    "",
    `Feature: ${feature.summary}`,
    `Stage: ${stage.key}`,
    `Attempt cap: ${stage.max_attempts}`,
    `Workspace: ${workspace}`,
    `Run manifest: ${authority.run_manifest_path}`,
    `Sealed skill: ${skillPath}`,
    `Sealed role contract: ${rolePath}`,
    gate ? `Command: agent-flow gate --spec ${gate.path}` : "Write only declared run artifacts and the feature worktree.",
    controllerCommand,
    "If blocked: block this card with the failed operation and exact recovery action.",
    "",
    "Sealed card instructions:",
    skill.trim(),
    "",
    "Sealed role contract:",
    role.trim(),
    "",
  ].filter((line) => line !== null).join("\n");
}

function isFeatureTransitionController(stage) {
  return stage === "plan-controller" ||
    stage === "completeness-controller" ||
    stage === "critique-controller" ||
    /^slice-controller:\d+$/.test(stage);
}

async function auditTask(adapter, taskId, spec, { auditParents }) {
  const task = await adapter.getTask({ taskId });
  if (
    task.title !== spec.title ||
    task.body !== spec.body ||
    task.assignee !== spec.assignee ||
    task.tenant !== spec.tenant ||
    task.workspace_kind !== spec.workspace.kind ||
    task.workspace_path !== spec.workspace.path ||
    task.max_retries !== spec.maxAttempts ||
    (auditParents && !sameMembers(task.parents, spec.parents))
  ) {
    throw new Error(`idempotent task ${taskId} does not match sealed launch authority`);
  }
  if (task.status === "archived") {
    throw new Error(`idempotent task ${taskId} is archived`);
  }
}

async function auditFeatureTenant({
  adapter,
  graph,
  manifest,
  order,
  rootStage,
  runManifestPath,
  taskIds,
  tenant,
}) {
  const listed = await adapter.listTasks({ tenant, includeArchived: true });
  if (!Array.isArray(listed)) throw new Error("Hermes adapter did not return a task list");
  const expected = new Set(taskIds.values());
  const actual = new Set(listed.map(({ id }) => id));
  if (
    actual.size !== listed.length ||
    actual.size !== expected.size ||
    [...expected].some((taskId) => !actual.has(taskId))
  ) {
    throw new Error("materialized tenant does not contain the exact sealed task set");
  }
  const stages = new Map(order.map((stage) => [stage.key, stage]));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      for (const stage of instantiateTransition(transition, ordinal).stages) {
        stages.set(stage.key, stage);
      }
    }
  }
  for (const [stage, taskId] of taskIds) {
    const lifecycle = await adapter.getTaskLifecycle({ taskId });
    const authority = await parseTaskAuthority({ body: lifecycle.body, taskId });
    const declared = stages.get(stage);
    const expectedParents = expectedStageParents(graph, stage, taskIds);
    const gate = manifest.inputs.find(({ kind, sealed_path: path }) =>
      kind === "gate" && path.endsWith(`/${safe(stage)}.json`)
    );
    const skill = requiredInput(manifest, "skill", declared.skill);
    const role = requiredInput(manifest, "role-contract", declared.profile);
    const mismatches = [];
    if (authority.runId !== tenant) mismatches.push("run");
    if (authority.stage !== stage) mismatches.push("stage");
    if (authority.runManifestPath !== runManifestPath) mismatches.push("manifest-path");
    if (authority.runManifestSha256 !== sha256(await readFile(runManifestPath))) mismatches.push("manifest-digest");
    if (gate
      ? authority.gateSpecPath !== gate.sealed_path || authority.gateSpecSha256 !== gate.sha256
      : authority.gateSpecPath !== undefined) mismatches.push("gate");
    if (lifecycle.title !== `[${tenant}/${stage}]`) mismatches.push("title");
    if (lifecycle.assignee !== declared.profile) mismatches.push("assignee");
    if (lifecycle.tenant !== tenant) mismatches.push("tenant");
    if (lifecycle.workspace_kind !== "dir" || lifecycle.workspace_path !== (declared.workspace === "run-dir"
      ? manifest.identity.run_directory : manifest.identity.repository.worktree)) mismatches.push("workspace");
    if (lifecycle.max_retries !== declared.max_attempts) mismatches.push("attempts");
    if (!sameMembers(lifecycle.parents, expectedParents)) mismatches.push("parents");
    if (!lifecycle.body.includes((await readFile(skill.sealed_path, "utf8")).trim())) mismatches.push("skill");
    if (!lifecycle.body.includes((await readFile(role.sealed_path, "utf8")).trim())) mismatches.push("role");
    if (
      authority.runId !== tenant ||
      authority.stage !== stage ||
      authority.runManifestPath !== runManifestPath ||
      authority.runManifestSha256 !== sha256(await readFile(runManifestPath)) ||
      (gate
        ? authority.gateSpecPath !== gate.sealed_path || authority.gateSpecSha256 !== gate.sha256
        : authority.gateSpecPath !== undefined) ||
      lifecycle.title !== `[${tenant}/${stage}]` || lifecycle.assignee !== declared.profile ||
      lifecycle.tenant !== tenant || lifecycle.workspace_kind !== "dir" ||
      lifecycle.workspace_path !== (declared.workspace === "run-dir"
        ? manifest.identity.run_directory : manifest.identity.repository.worktree) ||
      lifecycle.max_retries !== declared.max_attempts ||
      !sameMembers(lifecycle.parents, expectedParents) ||
      !lifecycle.body.includes((await readFile(skill.sealed_path, "utf8")).trim()) ||
      !lifecycle.body.includes((await readFile(role.sealed_path, "utf8")).trim())
    ) {
      const parentDetail = mismatches.includes("parents")
        ? ` actual=${JSON.stringify(lifecycle.parents)} expected=${JSON.stringify(expectedParents)}`
        : "";
      throw new Error(`task ${taskId} authority does not match feature stage ${stage}: ${mismatches.join(", ")}${parentDetail}`);
    }
    const attempts = Array.isArray(lifecycle.runs) ? lifecycle.runs.length : 0;
    if (attempts > stages.get(stage).max_attempts) {
      throw new Error(`task ${taskId} exceeds the ${stage} attempt limit`);
    }
    if (lifecycle.status === "done" && !hasTerminalCompletedAttempt(lifecycle)) {
      throw new Error(`task ${taskId} is done without a terminal completed attempt`);
    }
    if (lifecycle.status === "archived") {
      throw new Error(`task ${taskId} is archived without feature cancellation authority`);
    }
  }
  if (!taskIds.has(rootStage)) throw new Error("feature root was not materialized");
}

function mergeDeclaredDynamicTasks({ graph, prior, staticTasks }) {
  const allowed = new Set(graph.stages.map(({ key }) => key));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      for (const stage of instantiateTransition(transition, ordinal).stages) {
        allowed.add(stage.key);
      }
    }
  }
  const merged = new Map(staticTasks);
  for (const [stage, taskId] of Object.entries(prior)) {
    if (!allowed.has(stage)) throw new Error(`materialization contains undeclared stage ${stage}`);
    if (!merged.has(stage)) merged.set(stage, taskId);
  }
  return merged;
}

function expectedStageParents(graph, stageKey, tasks) {
  const parents = graph.dependencies
    .filter(({ child }) => child === stageKey)
    .map(({ parent }) => requiredTask(tasks, parent));
  for (const transition of graph.transitions) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      const instance = instantiateTransition(transition, ordinal);
      for (const { parent, child } of instance.dependencies) {
        if (child === stageKey && tasks.has(parent)) parents.push(requiredTask(tasks, parent));
      }
    }
  }
  return [...new Set(parents)];
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((item) => item.kind === kind && item.name === name);
  if (!found) throw new Error(`run omits sealed ${kind}/${name}`);
  return found;
}

function sameMembers(left = [], right = []) {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function flowLayout(runDirectory) {
  return {
    runDirectory,
    artifacts: join(runDirectory, "artifacts"),
    validated: join(runDirectory, "validated"),
    graph: join(runDirectory, "inputs", "feature-flow.v1.json"),
    feature: join(runDirectory, "inputs", "feature.json"),
    plan: join(runDirectory, "inputs", "slices.json"),
    gate: (name) => join(runDirectory, "inputs", "gates", `${safe(name)}.json`),
    skill: (name) => join(runDirectory, "inputs", "skills", `${safe(name)}.md`),
    role: (name) => join(runDirectory, "inputs", "roles", `${safe(name)}.md`),
  };
}

function input(kind, name, source_path, sealed_path, bytes) {
  return { kind, name, source_path, sealed_path, bytes };
}

function safe(value) {
  return value.replaceAll(":", "--");
}

function safeName(value) {
  return `feature-${safe(value)}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 128);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function aggregateFingerprint(graph, inputs) {
  return sha256(Buffer.from(JSON.stringify({
    graph: { name: graph.name, version: graph.version, flow: graph.flow, sha256: graph.sha256 },
    inputs: inputs.map(({ kind, name, sha256: digest }) => ({ kind, name, sha256: digest })),
  })));
}

function requireHealthyProfiles(report, required) {
  const byName = new Map(report.profiles?.map((profile) => [profile.name, profile]));
  const digest = normalizeDigest(report.profileSetFingerprint);
  if (!report.ok || !digest || required.some((name) =>
    !byName.get(name)?.available || !normalizeDigest(byName.get(name)?.configurationFingerprint)
  )) {
    throw new Error("required Hermes profiles are unhealthy");
  }
  return {
    profile_set_fingerprint: digest,
    required: [...required].sort(),
    fingerprints: Object.fromEntries([...required].sort().map((name) => [
      name,
      normalizeDigest(byName.get(name).configurationFingerprint),
    ])),
  };
}

function normalizeDigest(value) {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(value)
    ? value.replace(/^sha256:/, "")
    : null;
}

async function requireValid(document, label) {
  const result = await validateContract(document);
  if (!result.valid) {
    throw new Error(`${label} is invalid: ${result.errors[0]?.message ?? "unknown error"}`);
  }
}

function requiredTask(tasks, stage) {
  const id = tasks.get(stage);
  if (!id) throw new Error(`task ${stage} has not been materialized`);
  return id;
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function gitCommonDirectory(path) {
  const common = await git(path, "rev-parse", "--git-common-dir");
  return realpath(resolve(path, common));
}
