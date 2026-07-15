import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { formatTaskAuthority, HermesAdapter } from "./hermes-adapter.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GRAPH_SOURCE = join(SOURCE_ROOT, "graphs", "local-review.v1.json");
const LAUNCH_SOURCE = fileURLToPath(import.meta.url);
const REQUIRED_HOTFIX_PROFILES = [
  "analyst",
  "critic",
  "flow-controller",
  "gate",
];
const COMPATIBLE_CONTRACTS = [
  "agent-flow.run/v1",
  "agent-flow.graph/v1",
  "agent-flow.gate/v1",
  "agent-flow.command-result/v1",
  "agent-flow.handoff/v1",
  "agent-flow.validation/v1",
  "agent-flow.task-authority/v1",
  "agent-flow.migration-receipt/v1",
  "agent-flow.local-review/v1",
  "agent-flow.review-comments/v1",
  "agent-flow.review-result/v1",
];

export async function launchReview({
  manifestPath,
  adapter,
  env = process.env,
  runDoctor,
  inspectRepository = inspectReviewRepository,
  implementationRevision = null,
  now = () => new Date(),
}) {
  const reviewBytes = await readFile(manifestPath);
  const review = parseJson(reviewBytes, "review manifest");
  const reviewValidation = await validateContract(review);
  if (!reviewValidation.valid) {
    throw new Error(
      `review manifest is invalid: ${formatValidationError(reviewValidation)}`,
    );
  }
  if (review.automated_review.status !== "pending") {
    throw new Error("review launch requires automated_review.status=pending");
  }
  if (review.automated_review.urgency !== "hotfix") {
    throw new Error(
      "this launch tracer currently supports urgency=hotfix; fast and standard remain Phase 2 follow-up",
    );
  }
  if (review.external_ref !== null) {
    throw new Error(
      "this launch tracer requires external_ref=null until Phase 2 external-root ownership is implemented",
    );
  }
  const resolvedAdapter = adapter ?? new HermesAdapter({
    board: review.kanban.board,
  });

  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!stateHome) throw new Error("HOME or XDG_STATE_HOME is required");
  const runDirectory = join(
    stateHome,
    "agent-flow",
    "runs",
    review.run_id,
  );
  let releaseLaunchLock = null;
  try {
    const doctor = await runDoctor();
    const profileIdentity = requireHealthyProfiles(
      doctor,
      REQUIRED_HOTFIX_PROFILES,
    );
    const repository = await inspectRepository(review);
    if (repository.headSha !== review.head.sha) {
      throw new Error(
        `candidate worktree HEAD ${repository.headSha} does not match ${review.head.sha}`,
      );
    }

    const revision = implementationRevision ?? await currentImplementationRevision();
    if (!/^[0-9a-f]{40,64}$/.test(revision)) {
      throw new Error("agent-flow implementation revision is not a Git revision");
    }
    releaseLaunchLock = await acquireLaunchLock(runDirectory);
    const bundle = await sealOrLoadBundle({
      manifestPath,
      review,
      reviewBytes,
      repository,
      revision,
      profileIdentity,
      runDirectory,
      now,
    });
    return await materializeReview({
      adapter: resolvedAdapter,
      bundle,
      review,
    });
  } catch (error) {
    if (error.code !== "AGENT_FLOW_LAUNCH_BUSY") {
      await protectExistingRoot(resolvedAdapter, runDirectory, error);
    }
    throw error;
  } finally {
    if (releaseLaunchLock) await releaseLaunchLock();
  }
}

async function acquireLaunchLock(runDirectory) {
  const lockPath = `${runDirectory}.launch.lock`;
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, token })}\n`,
      );
    } finally {
      await handle.close();
    }
    return async () => {
      try {
        const owner = parseJson(await readFile(lockPath), "launch lock");
        if (owner.token === token) await unlink(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readLaunchLock(lockPath);
    const stale = owner !== null && !processIsAlive(owner.pid);
    const busy = new Error(
      stale
        ? `stale launch lock detected; remove ${lockPath} after confirming no launcher is active`
        : `another launcher is active for this run; retry after it exits (${lockPath})`,
    );
    busy.code = "AGENT_FLOW_LAUNCH_BUSY";
    throw busy;
  }
}

async function readLaunchLock(lockPath) {
  try {
    const owner = parseJson(await readFile(lockPath), "launch lock");
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch (error) {
    if (error.code === "ENOENT") return { pid: -1 };
    return null;
  }
}

function processIsAlive(pid) {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function protectExistingRoot(adapter, runDirectory, error) {
  try {
    const receipt = parseJson(
      await readFile(join(runDirectory, "materialization.json")),
      "materialization receipt",
    );
    const rootId = receipt.tasks?.["review-root"];
    if (typeof rootId !== "string") return;
    const root = await adapter.getTask({ taskId: rootId });
    const reason = `Launch compatibility check failed: ${error.message}`;
    if (!["blocked", "done", "archived"].includes(root.status)) {
      await adapter.blockTask({ taskId: rootId, reason });
    } else {
      await adapter.commentTask({ taskId: rootId, body: reason });
    }
  } catch {
    // A missing or damaged receipt is reported by the original launch error.
  }
}

async function sealOrLoadBundle({
  manifestPath,
  review,
  reviewBytes,
  repository,
  revision,
  profileIdentity,
  runDirectory,
  now,
}) {
  const runManifestPath = join(runDirectory, "run.json");
  try {
    const existingBytes = await readFile(runManifestPath);
    return loadExistingBundle({
      existingBytes,
      review,
      reviewBytes,
      revision,
      profileIdentity,
      runDirectory,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const graphBytes = await readFile(GRAPH_SOURCE);
  const graph = parseJson(graphBytes, "review graph");
  const graphValidation = await validateContract(graph);
  if (!graphValidation.valid) {
    throw new Error(`review graph is invalid: ${formatValidationError(graphValidation)}`);
  }
  const enabledStages = materializationOrder(graph);
  const layout = bundleLayout(runDirectory, enabledStages);
  const generatedGates = generateGates({ graph, layout, review });
  for (const gate of generatedGates) {
    const gateValidation = await validateContract(gate.document);
    if (!gateValidation.valid) {
      throw new Error(
        `generated gate ${gate.name} is invalid: ${formatValidationError(gateValidation)}`,
      );
    }
  }
  const sources = await loadStaticInputs(enabledStages, layout);
  const inputContents = [
    {
      kind: "review-manifest",
      name: "review.json",
      sourcePath: manifestPath,
      sealedPath: layout.reviewManifest,
      bytes: reviewBytes,
    },
    {
      kind: "machine-input",
      name: "candidate.patch",
      sourcePath: review.worktree,
      sealedPath: layout.candidateDiff,
      bytes: repository.diffBytes ?? Buffer.from(""),
    },
    ...generatedGates.map(({ name, path, document }) => ({
      kind: "gate",
      name,
      sourcePath: LAUNCH_SOURCE,
      sealedPath: path,
      bytes: jsonBytes(document),
    })),
    ...sources,
  ];
  const inputs = inputContents.map((input) => ({
    kind: input.kind,
    name: input.name,
    source_path: input.sourcePath,
    sealed_path: input.sealedPath,
    sha256: sha256(input.bytes),
  }));
  const graphDigest = sha256(graphBytes);
  const graphIdentity = {
    name: graph.name,
    version: graph.version,
    flow: graph.flow,
    sealed_path: layout.graph,
    sha256: graphDigest,
  };
  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision,
      compatible_contracts: COMPATIBLE_CONTRACTS,
      content_set_fingerprint: aggregateFingerprint(graphIdentity, inputs),
    },
    identity: {
      run_id: review.run_id,
      run_directory: runDirectory,
      artifact_directory: layout.artifacts,
      validation_directory: layout.validated,
      flow: "review",
      repository: {
        path: repository.repositoryPath,
        worktree: repository.worktreePath ?? review.worktree,
        forge_coordinate: null,
      },
      board: review.kanban.board,
      tenant: review.run_id,
      parent_run_id: null,
      external_root: null,
      supersedes: null,
    },
    graph: graphIdentity,
    approved_read_roots: [
      runDirectory,
      repository.worktreePath ?? review.worktree,
    ],
    approved_artifact_roots: [layout.artifacts],
    inputs,
    profiles: profileIdentity,
    limits: {
      max_created_cards: enabledStages.length,
      max_worker_attempts: enabledStages.reduce(
        (total, stage) => total + stage.max_attempts,
        0,
      ),
      max_elapsed_seconds: 3600,
      max_feature_streams: 1,
    },
    revisions: {
      base: review.base.sha,
      source: review.head.sha,
      target: null,
    },
    sealed_at: now().toISOString(),
  };
  const validation = await validateContract(manifest);
  if (!validation.valid) {
    throw new Error(`generated run manifest is invalid: ${formatValidationError(validation)}`);
  }

  await publishBundle({
    runDirectory,
    layout,
    graphBytes,
    inputContents,
    manifestBytes: jsonBytes(manifest),
  });
  return {
    graph,
    enabledStages,
    gates: new Map(generatedGates.map((gate) => [gate.stage, gate])),
    layout,
    manifest,
    manifestBytes: jsonBytes(manifest),
    runManifestPath,
  };
}

async function loadExistingBundle({
  existingBytes,
  review,
  reviewBytes,
  revision,
  profileIdentity,
  runDirectory,
}) {
  const manifest = parseJson(existingBytes, "existing run manifest");
  const validation = await validateContract(manifest);
  if (!validation.valid) {
    throw new Error(`existing run manifest is invalid: ${formatValidationError(validation)}`);
  }
  if (
    manifest.identity.run_id !== review.run_id ||
    manifest.identity.run_directory !== runDirectory ||
    manifest.identity.board !== review.kanban.board ||
    manifest.revisions.base !== review.base.sha ||
    manifest.revisions.source !== review.head.sha
  ) {
    throw new Error("existing run identity does not match this review launch");
  }
  if (
    manifest.implementation.revision !== revision ||
    manifest.profiles.profile_set_fingerprint !==
      profileIdentity.profile_set_fingerprint ||
    JSON.stringify(manifest.profiles) !== JSON.stringify(profileIdentity)
  ) {
    throw new Error("existing run is incompatible with the current implementation or profiles");
  }
  const sealedReview = manifest.inputs.find(
    ({ kind, name }) => kind === "review-manifest" && name === "review.json",
  );
  if (
    !sealedReview ||
    sealedReview.sha256 !== sha256(reviewBytes)
  ) {
    throw new Error("existing run was sealed from different review input");
  }
  const graphBytes = await readFile(manifest.graph.sealed_path);
  if (sha256(graphBytes) !== manifest.graph.sha256) {
    throw new Error("existing run graph digest changed");
  }
  for (const input of manifest.inputs) {
    if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
      throw new Error(`existing sealed input changed: ${input.kind}/${input.name}`);
    }
  }
  if (
    aggregateFingerprint(manifest.graph, manifest.inputs) !==
    manifest.implementation.content_set_fingerprint
  ) {
    throw new Error("existing run content-set fingerprint changed");
  }
  const graph = parseJson(graphBytes, "existing review graph");
  const graphValidation = await validateContract(graph);
  if (!graphValidation.valid) {
    throw new Error(
      `existing review graph is invalid: ${formatValidationError(graphValidation)}`,
    );
  }
  if (
    graph.name !== manifest.graph.name ||
    graph.version !== manifest.graph.version ||
    graph.flow !== manifest.graph.flow
  ) {
    throw new Error("existing review graph identity does not match the run manifest");
  }
  const enabledStages = materializationOrder(graph);
  const layout = bundleLayout(runDirectory, enabledStages);
  const expectedGates = generateGates({ graph, layout, review });
  const gateInputs = manifest.inputs.filter(({ kind }) => kind === "gate");
  if (gateInputs.length !== expectedGates.length) {
    throw new Error("existing run does not contain the exact generated gate set");
  }
  const gates = new Map();
  for (const expected of expectedGates) {
    const input = gateInputs.find(({ name, sealed_path: sealedPath }) =>
      name === expected.name && sealedPath === expected.path
    );
    if (!input) {
      throw new Error("existing run does not contain the exact generated gate set");
    }
    const document = parseJson(await readFile(input.sealed_path), input.name);
    const gateValidation = await validateContract(document);
    if (!gateValidation.valid) {
      throw new Error(
        `existing gate ${input.name} is invalid: ` +
          formatValidationError(gateValidation),
      );
    }
    if (JSON.stringify(document) !== JSON.stringify(expected.document)) {
      throw new Error(
        `existing gate ${input.name} does not match its generated operation`,
      );
    }
    gates.set(document.stage, {
      name: input.name,
      path: input.sealed_path,
      document,
    });
  }
  return {
    graph,
    enabledStages,
    gates,
    layout,
    manifest,
    manifestBytes: existingBytes,
    runManifestPath: join(runDirectory, "run.json"),
  };
}

async function publishBundle({
  runDirectory,
  layout,
  graphBytes,
  inputContents,
  manifestBytes,
}) {
  const parent = dirname(runDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, `.${layout.runId}-`));
  try {
    for (const directory of [
      "inputs",
      "inputs/gates",
      "inputs/skills",
      "inputs/roles",
      "artifacts",
      "artifacts/review",
      "artifacts/validations",
      "validated",
    ]) {
      await mkdir(join(staging, directory), { recursive: true, mode: 0o700 });
    }
    await writeSealed(stagingPath(staging, runDirectory, layout.graph), graphBytes);
    for (const input of inputContents) {
      await writeSealed(
        stagingPath(staging, runDirectory, input.sealedPath),
        input.bytes,
      );
    }
    await writeSealed(join(staging, "run.json"), manifestBytes);
    await rename(staging, runDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      throw new Error("another launcher created this run concurrently; retry launch");
    }
    throw error;
  }
}

async function materializeReview({ adapter, bundle, review }) {
  const { graph, enabledStages, layout, manifest, manifestBytes } = bundle;
  const candidateWorktree = manifest.identity.repository.worktree ?? review.worktree;
  const manifestDigest = sha256(manifestBytes);
  const dependencies = graph.dependencies.filter(({ parent, child }) =>
    enabledStages.some(({ key }) => key === parent) &&
    enabledStages.some(({ key }) => key === child)
  );
  const taskIds = new Map();
  let rootId = null;
  try {
    for (const stage of enabledStages) {
      const parents = dependencies
        .filter(({ child }) => child === stage.key && child !== graph.root)
        .map(({ parent }) => requiredTaskId(taskIds, parent));
      const authority = taskAuthority({
        bundle,
        manifestDigest,
        stage,
        taskIds,
      });
      const authorityValidation = await validateContract(authority);
      if (!authorityValidation.valid) {
        throw new Error(
          `generated authority for ${stage.key} is invalid: ` +
            formatValidationError(authorityValidation),
        );
      }
      const io = stageIo(stage, layout);
      const skill = await readFile(
        manifest.inputs.find(
          ({ kind, name }) => kind === "skill" && name === stage.skill,
        ).sealed_path,
        "utf8",
      );
      const role = await readFile(
        manifest.inputs.find(
          ({ kind, name }) => kind === "role-contract" && name === stage.profile,
        ).sealed_path,
        "utf8",
      );
      const spec = {
        title: `[${review.run_id}/${stage.key}]`,
        body: cardBody({
          authority,
          graph,
          io,
          layout,
          review,
          candidateWorktree,
          role,
          skill,
          stage,
        }),
        assignee: stage.profile,
        tenant: review.run_id,
        workspace: {
          kind: "dir",
          path: stage.workspace === "run-dir" ? layout.runDirectory : candidateWorktree,
        },
        parents,
        idempotencyKey: `${review.run_id}:${graph.version}:${stage.key}:1`,
        maxAttempts: stage.max_attempts,
        initialStatus: stage.key === graph.root ? "blocked" : "running",
      };
      const created = await adapter.createTask(spec);
      taskIds.set(stage.key, created.id);
      if (stage.key === graph.root) rootId = created.id;
      await auditTask(adapter, created.id, spec, {
        auditParents: stage.key !== graph.root,
      });
    }

    const finalTaskId = requiredTaskId(taskIds, "finalize");
    rootId = requiredTaskId(taskIds, graph.root);
    await adapter.linkTasks({ parentId: finalTaskId, childId: rootId });
    for (const stage of enabledStages) {
      const expectedParents = dependencies
        .filter(({ child }) => child === stage.key)
        .map(({ parent }) => requiredTaskId(taskIds, parent));
      const task = await adapter.getTask({ taskId: requiredTaskId(taskIds, stage.key) });
      if (!sameMembers(task.parents, expectedParents)) {
        throw new Error(`task ${task.id} has unexpected dependency parents`);
      }
    }
    await writeMaterialization(layout, graph, taskIds);
    const root = await adapter.getTask({ taskId: rootId });
    if (root.status === "blocked") {
      await adapter.releaseTask({
        taskId: rootId,
        reason: "agent-flow verified the complete sealed review topology",
      });
    } else if (!["todo", "ready", "running", "done"].includes(root.status)) {
      throw new Error(`review root has unexpected status ${root.status}`);
    }
    return {
      cardCount: enabledStages.length,
      rootTaskId: rootId,
      runId: review.run_id,
      runManifestPath: bundle.runManifestPath,
    };
  } catch (error) {
    if (rootId !== null) {
      try {
        await adapter.commentTask({
          taskId: rootId,
          body:
            `Launch recovery required: ${error.message}. ` +
            "Re-run the identical agent-flow launch command after correcting the cause.",
        });
      } catch {
        // Preserve the materialization error; the blocked root is the safety boundary.
      }
    }
    throw error;
  }
}

function taskAuthority({ bundle, manifestDigest, stage, taskIds }) {
  const authority = {
    schema: "agent-flow.task-authority/v1",
    run_id: bundle.manifest.identity.run_id,
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
    authority.producer_task_id = requiredTaskId(
      taskIds,
      stage.validates_handoff_for,
    );
  }
  if (stage.key === "finalize") {
    authority.input_task_ids = {};
    for (const input of gate.document.inputs) {
      const validatorStage = bundle.enabledStages.find((candidate) =>
        candidate.validates_handoff_for &&
        bundle.layout.validationEvidence.get(candidate.key) === input
      );
      authority.input_task_ids[input] = requiredTaskId(taskIds, validatorStage.key);
    }
  }
  return authority;
}

function cardBody({
  authority,
  candidateWorktree,
  graph,
  io,
  layout,
  review,
  role,
  skill,
  stage,
}) {
  const declaredInputs = [
    authority.run_manifest_path,
    layout.graph,
    layout.skillPath(stage.skill),
    layout.rolePath(stage.profile),
    ...io.inputs,
  ];
  const gate = stage.profile === "gate"
    ? `\nCommand: agent-flow gate --spec ${authority.gate_spec_path}\n`
    : "";
  return [
    formatTaskAuthority(authority),
    "",
    `Run: ${review.run_id}`,
    `Graph: ${graph.name}/v${graph.version}`,
    `Stage: ${stage.key}`,
    `Attempt cap: ${stage.max_attempts}`,
    `Workspace: ${stage.workspace === "run-dir" ? layout.runDirectory : candidateWorktree}`,
    `Inputs: ${[...new Set(declaredInputs)].join(", ")}`,
    `Outputs: ${io.outputs.length > 0 ? io.outputs.join(", ") : "none"}`,
    `If blocked: block this card with the failed operation and exact human recovery action.`,
    gate.trimEnd(),
    "",
    "Sealed card instructions:",
    skill.trim(),
    "",
    "Sealed role contract:",
    role.trim(),
    "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

async function auditTask(adapter, taskId, spec, { auditParents }) {
  const task = await adapter.getTask({ taskId });
  const mismatched =
    task.title !== spec.title ||
    task.body !== spec.body ||
    task.assignee !== spec.assignee ||
    task.tenant !== spec.tenant ||
    task.workspace_kind !== spec.workspace.kind ||
    task.workspace_path !== spec.workspace.path ||
    task.max_retries !== spec.maxAttempts ||
    (auditParents && !sameMembers(task.parents, spec.parents));
  if (mismatched) {
    throw new Error(`idempotent task ${taskId} does not match sealed launch authority`);
  }
  if (task.status === "archived") {
    throw new Error(`idempotent task ${taskId} is archived`);
  }
}

async function writeMaterialization(layout, graph, taskIds) {
  const document = {
    run_id: layout.runId,
    graph: `${graph.name}/v${graph.version}`,
    tasks: Object.fromEntries(taskIds),
  };
  const temporary = join(layout.runDirectory, ".materialization.json.tmp");
  await writeFile(temporary, jsonBytes(document), { mode: 0o600 });
  await rename(temporary, layout.materialization);
}

function enabledHotfixStages(graph) {
  const byKey = new Map(graph.stages.map((stage) => [stage.key, stage]));
  return graph.stages.filter((stage) => {
    if (stage.optional) return false;
    if (!stage.validates_handoff_for) return true;
    return !byKey.get(stage.validates_handoff_for)?.optional;
  });
}

export function materializationOrder(graph) {
  const enabled = enabledHotfixStages(graph);
  const enabledKeys = new Set(enabled.map(({ key }) => key));
  const root = enabled.find(({ key }) => key === graph.root);
  if (!root) throw new Error("review graph root is not enabled");
  const ordered = [root];
  const created = new Set([root.key]);
  const remaining = new Map(
    enabled.filter(({ key }) => key !== root.key).map((stage) => [stage.key, stage]),
  );
  const dependencies = graph.dependencies.filter(({ parent, child }) =>
    enabledKeys.has(parent) && enabledKeys.has(child)
  );
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((stage) => dependencies
        .filter(({ child }) => child === stage.key)
        .every(({ parent }) => created.has(parent)))
      .sort((left, right) => left.key.localeCompare(right.key));
    if (ready.length === 0) {
      throw new Error("review graph does not have a complete materialization order");
    }
    for (const stage of ready) {
      ordered.push(stage);
      created.add(stage.key);
      remaining.delete(stage.key);
    }
  }
  return ordered;
}

function bundleLayout(runDirectory, stages) {
  const safe = (key) => key.replaceAll(":", "--");
  const artifacts = join(runDirectory, "artifacts");
  const validationEvidence = new Map(
    stages
      .filter(({ validates_handoff_for: producer }) => producer)
      .map((stage) => [
        stage.key,
        join(artifacts, "validations", `${safe(stage.key)}.json`),
      ]),
  );
  return {
    runId: runDirectory.split("/").at(-1),
    runDirectory,
    artifacts,
    validated: join(runDirectory, "validated"),
    graph: join(runDirectory, "inputs", "local-review.v1.json"),
    reviewManifest: join(runDirectory, "inputs", "review.json"),
    candidateDiff: join(runDirectory, "inputs", "candidate.patch"),
    materialization: join(runDirectory, "materialization.json"),
    validationEvidence,
    reviewResult: join(artifacts, "review", "result.json"),
    reviewMarkdown: join(artifacts, "review", "review.md"),
    reviewHtml: join(artifacts, "review", "review.html"),
    reviewDraft: join(artifacts, "review", "draft.json"),
    gatePath: (stage) => join(runDirectory, "inputs", "gates", `${safe(stage)}.json`),
    skillPath: (name) => join(runDirectory, "inputs", "skills", `${name}.md`),
    rolePath: (name) => join(runDirectory, "inputs", "roles", `${name}.md`),
  };
}

function generateGates({ graph, layout, review }) {
  const gates = [];
  for (const stage of enabledHotfixStages(graph)) {
    if (!stage.validates_handoff_for) continue;
    const output = layout.validationEvidence.get(stage.key);
    const document = {
      schema: "agent-flow.gate/v1",
      name: `validate-${stage.validates_handoff_for.replaceAll(":", "-")}`,
      version: 1,
      run_id: review.run_id,
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
    gates.push({
      stage: stage.key,
      name: `${stage.key}.json`,
      path: layout.gatePath(stage.key),
      document,
    });
  }
  const commentsValidation = layout.validationEvidence.get(
    "validate-handoff:critic",
  );
  const outputs = [
    layout.reviewResult,
    layout.reviewMarkdown,
    layout.reviewHtml,
    layout.reviewDraft,
  ];
  const finalize = {
    schema: "agent-flow.gate/v1",
    name: "review-finalize",
    version: 1,
    run_id: review.run_id,
    stage: "finalize",
    kind: "review-finalize",
    workspace: layout.runDirectory,
    read_roots: [layout.runDirectory],
    write_root: layout.artifacts,
    timeout_seconds: 120,
    inputs: [commentsValidation],
    outputs,
    review_policy: {
      urgency: "hotfix",
      minimum_tier: "critical",
      max_comments: review.automated_review.max_comments,
      per_tier_caps: structuredClone(review.automated_review.per_tier_caps),
    },
    review_finalize: {
      comments_validation: commentsValidation,
      supplements: [],
      result_output: layout.reviewResult,
      markdown_output: layout.reviewMarkdown,
      html_output: layout.reviewHtml,
      draft_output: layout.reviewDraft,
    },
  };
  gates.push({
    stage: "finalize",
    name: "finalize.json",
    path: layout.gatePath("finalize"),
    document: finalize,
  });
  return gates;
}

function stageIo(stage, layout) {
  if (stage.key.startsWith("lens:")) {
    return {
      inputs: [layout.reviewManifest, layout.candidateDiff],
      outputs: ["metadata.handoff.artifacts[0].inline (review-findings)"],
    };
  }
  if (stage.validates_handoff_for) {
    return {
      inputs: [],
      outputs: [layout.validationEvidence.get(stage.key)],
    };
  }
  if (stage.key === "critic") {
    const lensValidations = [...layout.validationEvidence.entries()]
      .filter(([key]) => key.startsWith("validate-handoff:lens:"))
      .map(([, path]) => path);
    return {
      inputs: [layout.reviewManifest, layout.candidateDiff, ...lensValidations],
      outputs: ["metadata.handoff.artifacts[0].inline (review-comments)"],
    };
  }
  if (stage.key === "finalize") {
    return {
      inputs: [layout.validationEvidence.get("validate-handoff:critic")],
      outputs: [
        layout.reviewResult,
        layout.reviewMarkdown,
        layout.reviewHtml,
        layout.reviewDraft,
      ],
    };
  }
  if (stage.key === "review-root") {
    return {
      inputs: [layout.reviewResult, layout.reviewMarkdown, layout.reviewHtml],
      outputs: [],
    };
  }
  return { inputs: [], outputs: [] };
}

async function loadStaticInputs(stages, layout) {
  const skills = [...new Set(stages.map(({ skill }) => skill))].sort();
  const profiles = [...new Set(stages.map(({ profile }) => profile))].sort();
  return Promise.all([
    ...skills.map(async (name) => {
      const sourcePath = join(SOURCE_ROOT, "card-skills", `${name}.md`);
      return {
        kind: "skill",
        name,
        sourcePath,
        sealedPath: layout.skillPath(name),
        bytes: await readFile(sourcePath),
      };
    }),
    ...profiles.map(async (name) => {
      const sourcePath = join(SOURCE_ROOT, "role-contracts", `${name}.md`);
      return {
        kind: "role-contract",
        name,
        sourcePath,
        sealedPath: layout.rolePath(name),
        bytes: await readFile(sourcePath),
      };
    }),
  ]);
}

function requireHealthyProfiles(report, required) {
  const byName = new Map(report.profiles?.map((profile) => [profile.name, profile]));
  const unavailable = required.filter((name) => {
    const profile = byName.get(name);
    return !profile?.available || !normalizeDigest(profile.configurationFingerprint);
  });
  const setFingerprint = normalizeDigest(report.profileSetFingerprint);
  if (!report.ok || !setFingerprint || unavailable.length > 0) {
    throw new Error(
      `required Hermes profiles are unhealthy${
        unavailable.length > 0 ? `: ${unavailable.join(", ")}` : ""
      }`,
    );
  }
  return {
    profile_set_fingerprint: setFingerprint,
    required: [...required].sort(),
    fingerprints: Object.fromEntries(
      [...required].sort().map((name) => [
        name,
        normalizeDigest(byName.get(name).configurationFingerprint),
      ]),
    ),
  };
}

export async function inspectReviewRepository(review) {
  const repositoryPath = await realpath(review.repo);
  const worktreePath = await realpath(review.worktree);
  const repositoryCommonDirectory = await gitCommonDirectory(repositoryPath);
  const worktreeCommonDirectory = await gitCommonDirectory(worktreePath);
  if (repositoryCommonDirectory !== worktreeCommonDirectory) {
    throw new Error("candidate worktree does not belong to the declared repository");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  const { stdout: status } = await execFileAsync(
    "git",
    ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (status.length > 0) {
    throw new Error("candidate worktree must be clean before review launch");
  }
  for (const revision of [review.base.sha, review.head.sha]) {
    await execFileAsync(
      "git",
      ["-C", worktreePath, "cat-file", "-e", `${revision}^{commit}`],
    );
  }
  const { stdout: diff } = await execFileAsync(
    "git",
    [
      "-C",
      worktreePath,
      "diff",
      "--binary",
      "--no-ext-diff",
      review.base.sha,
      review.head.sha,
    ],
    { encoding: null, maxBuffer: 100 * 1024 * 1024 },
  );
  return {
    repositoryPath,
    worktreePath,
    headSha: stdout.trim(),
    diffBytes: diff,
  };
}

async function gitCommonDirectory(workingDirectory) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workingDirectory, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  );
  const path = stdout.trim();
  return realpath(isAbsolute(path) ? path : resolve(workingDirectory, path));
}

async function currentImplementationRevision() {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

function aggregateFingerprint(graph, inputs) {
  const entries = [
    `graph\0${graph.name}\0${graph.sha256}`,
    ...inputs.map(({ kind, name, sha256: digest }) =>
      `${kind}\0${name}\0${digest}`
    ),
  ].sort();
  return sha256(entries.join("\n"));
}

function normalizeDigest(value) {
  const digest = typeof value === "string" && value.startsWith("sha256:")
    ? value.slice("sha256:".length)
    : value;
  return /^[0-9a-f]{64}$/.test(digest ?? "") ? digest : null;
}

function requiredTaskId(taskIds, stage) {
  const id = taskIds.get(stage);
  if (!id) throw new Error(`stage ${stage} was not materialized before its consumer`);
  return id;
}

function sameMembers(left = [], right = []) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function formatValidationError(result) {
  const error = result.errors[0];
  return `${error.instancePath || "/"} ${error.message}`;
}

function jsonBytes(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stagingPath(staging, runDirectory, finalPath) {
  return join(staging, finalPath.slice(runDirectory.length + 1));
}

async function writeSealed(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
}
