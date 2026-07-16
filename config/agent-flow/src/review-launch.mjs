import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { formatTaskAuthority, HermesAdapter } from "./hermes-adapter.mjs";
import { resolveHermesKanbanHome } from "./hermes-home.mjs";
import { parseExternalRef } from "./external-root.mjs";
import { parseCancellationAudit } from "./cancellation-audit.mjs";
import {
  deriveResumeCompatibility,
  requireMigrationApproval,
} from "./migration-compatibility.mjs";
import {
  acquireBoardRegistryLock,
  acquireExternalOwnershipLock,
  acquireRunMutationLock,
} from "./run-lock.mjs";
import { assertExternalOwnershipAvailable } from "./run-ownership.mjs";
import { materializationOrder } from "./review-topology.mjs";
import { validateContract } from "./schema-validator.mjs";
import { projectRunStatus } from "./run-lifecycle.mjs";
import { hasTerminalCompletedAttempt } from "./run-terminal.mjs";

export { materializationOrder } from "./review-topology.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GRAPH_SOURCE = join(SOURCE_ROOT, "graphs", "local-review.v1.json");
const LAUNCH_SOURCE = fileURLToPath(import.meta.url);
const REVIEW_MINIMUM_TIER = {
  hotfix: "critical",
  fast: "important",
  standard: "nit",
};
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
  "agent-flow.review-comment-dispositions/v1",
  "agent-flow.integration-receipt/v1",
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
  const resolvedAdapter = adapter ?? new HermesAdapter({
    board: review.kanban.board,
  });

  const stateHome = env.XDG_STATE_HOME?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!stateHome) throw new Error("HOME or XDG_STATE_HOME is required");
  const kanbanHome = resolveHermesKanbanHome({ env });
  const runDirectory = join(
    stateHome,
    "agent-flow",
    "runs",
    review.run_id,
  );
  let releaseLaunchLock = null;
  let releaseBoardLock = null;
  let releaseOwnershipLock = null;
  try {
    const graphSource = await loadReviewGraph(
      review.automated_review.urgency,
    );
    const doctor = await runDoctor();
    const existingProfiles = await existingRequiredProfiles(runDirectory);
    if (existingProfiles.length > 0) {
      requireHealthyProfiles(doctor, existingProfiles);
    }
    const profileIdentity = requireHealthyProfiles(
      doctor,
      [...new Set(graphSource.enabledStages.map(({ profile }) => profile))],
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
    const externalRoot = parseExternalRef(review.external_ref);
    if (externalRoot !== null) {
      releaseOwnershipLock = await acquireExternalOwnershipLock({
        externalRoot,
        repositoryPath: repository.repositoryPath,
        stateHome,
      });
    }
    releaseBoardLock = await acquireBoardRegistryLock({
      kanbanHome,
    });
    await assertExternalOwnershipAvailable({
      adapterForBoard: (board) => board === review.kanban.board
        ? resolvedAdapter
        : new HermesAdapter({ board }),
      currentRunId: review.run_id,
      externalRoot,
      repositoryPath: repository.repositoryPath,
      stateHome,
      supersedes: review.supersedes ?? null,
    });
    releaseLaunchLock = await acquireRunMutationLock(runDirectory);
    const bundle = await sealOrLoadBundle({
      manifestPath,
      review,
      reviewBytes,
      repository,
      revision,
      profileIdentity,
      runDirectory,
      now,
      graphSource,
    });
    await resolvedAdapter.ensureBoard({
      name: `Agent Flow: ${review.run_id}`,
      description: review.summary,
      defaultWorkdir: repository.repositoryPath,
    });
    if (bundle.resumed) {
      const status = await projectRunStatus({
        adapter: resolvedAdapter,
        env,
        now,
        runId: review.run_id,
      });
      if (status.cancellation.requested) {
        throw new Error(
          "resume blocked: cancellation has been requested for this run",
        );
      }
      const exceeded = Object.entries(status.limits)
        .filter(([, limit]) => limit.exceeded)
        .map(([name]) => `${name} limit exceeded`);
      const hasReceipt = await materializationReceiptExists(runDirectory);
      const blockingIssues = [
        ...(hasReceipt ? status.issues : []),
        ...exceeded,
      ];
      if (blockingIssues.length > 0) {
        throw new Error(
          `resume blocked: ${[...new Set(blockingIssues)].join("; ")}`,
        );
      }
    }
    return await materializeReview({
      adapter: resolvedAdapter,
      bundle,
      review,
    });
  } catch (error) {
    if (releaseLaunchLock !== null) {
      await protectExistingRoot(resolvedAdapter, runDirectory, error);
    }
    throw error;
  } finally {
    try {
      if (releaseLaunchLock) await releaseLaunchLock();
    } finally {
      try {
        if (releaseBoardLock) await releaseBoardLock();
      } finally {
        if (releaseOwnershipLock) await releaseOwnershipLock();
      }
    }
  }
}

async function materializationReceiptExists(runDirectory) {
  try {
    await readFile(join(runDirectory, "materialization.json"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function existingRequiredProfiles(runDirectory) {
  try {
    const manifest = parseJson(
      await readFile(join(runDirectory, "run.json")),
      "existing run manifest",
    );
    return Array.isArray(manifest?.profiles?.required)
      ? manifest.profiles.required.filter((name) => typeof name === "string")
      : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
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
  graphSource,
}) {
  const candidate = await prepareCandidateBundle({
    graphSource,
    manifestPath,
    repository,
    review,
    reviewBytes,
    runDirectory,
  });
  const runManifestPath = join(runDirectory, "run.json");
  try {
    const existingBytes = await readFile(runManifestPath);
    return loadExistingBundle({
      candidate,
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

  const {
    enabledStages,
    gates: generatedGates,
    graph,
    graphBytes,
    graphIdentity,
    inputContents,
    inputs,
    layout,
  } = candidate;
  const manifest = {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision,
      compatible_contracts: COMPATIBLE_CONTRACTS,
      content_set_fingerprint: candidate.contentSetFingerprint,
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
      external_root: parseExternalRef(review.external_ref),
      supersedes: review.supersedes ?? null,
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
    resumed: false,
    runManifestPath,
  };
}

async function loadReviewGraph(urgency) {
  const graphBytes = await readFile(GRAPH_SOURCE);
  const graph = parseJson(graphBytes, "review graph");
  const graphValidation = await validateContract(graph);
  if (!graphValidation.valid) {
    throw new Error(
      `review graph is invalid: ${formatValidationError(graphValidation)}`,
    );
  }
  return {
    graphBytes,
    graph,
    enabledStages: materializationOrder(graph, urgency),
  };
}

async function loadExistingBundle({
  candidate,
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
  const compatibility = deriveResumeCompatibility({
    candidate,
    manifest,
    profileIdentity,
    revision,
  });
  const sealedReview = manifest.inputs.find(
    ({ kind, name }) => kind === "review-manifest" && name === "review.json",
  );
  if (!sealedReview) {
    throw new Error("existing run omits its sealed review input");
  }
  if (
    !compatibility.contentChanged &&
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
  const sealedReviewDocument = parseJson(
    await readFile(sealedReview.sealed_path),
    "existing sealed review input",
  );
  const sealedReviewValidation = await validateContract(sealedReviewDocument);
  if (!sealedReviewValidation.valid) {
    throw new Error("existing run has an invalid sealed review input");
  }
  const enabledStages = materializationOrder(
    graph,
    sealedReviewDocument.automated_review.urgency,
  );
  const layout = bundleLayout(runDirectory, enabledStages);
  const expectedGates = compatibility.contentChanged
    ? expectedSealedGateTopology(enabledStages, layout)
    : candidate.gates;
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
    if (document.stage !== expected.stage) {
      throw new Error("existing run does not contain the exact generated gate set");
    }
    if (
      !compatibility.contentChanged &&
      JSON.stringify(document) !== JSON.stringify(expected.document)
    ) {
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
  if (compatibility.changes.length > 0) {
    await requireMigrationApproval({
      changes: compatibility.changes,
      from: compatibility.from,
      runDirectory,
      runId: review.run_id,
      to: compatibility.to,
    });
  }
  return {
    graph,
    enabledStages,
    gates,
    layout,
    manifest,
    manifestBytes: existingBytes,
    resumed: true,
    runManifestPath: join(runDirectory, "run.json"),
  };
}

async function prepareCandidateBundle({
  graphSource,
  manifestPath,
  repository,
  review,
  reviewBytes,
  runDirectory,
}) {
  const { graphBytes, graph, enabledStages } = graphSource;
  const layout = bundleLayout(runDirectory, enabledStages);
  const gates = generateGates({ enabledStages, layout, review });
  for (const gate of gates) {
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
    ...gates.map(({ name, path, document }) => ({
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
  const graphIdentity = {
    name: graph.name,
    version: graph.version,
    flow: graph.flow,
    sealed_path: layout.graph,
    sha256: sha256(graphBytes),
  };
  return {
    compatibleContracts: COMPATIBLE_CONTRACTS,
    contentSetFingerprint: aggregateFingerprint(graphIdentity, inputs),
    enabledStages,
    gates,
    graph,
    graphBytes,
    graphIdentity,
    inputContents,
    inputs,
    layout,
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
      "migrations",
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
      const io = stageIo(stage, layout, enabledStages);
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
    await auditMaterializedTenant({
      adapter,
      enabledStages,
      rootStage: graph.root,
      taskIds,
      tenant: manifest.identity.tenant,
    });
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

async function auditMaterializedTenant({
  adapter,
  enabledStages,
  rootStage,
  taskIds,
  tenant,
}) {
  const listed = await adapter.listTasks({ tenant, includeArchived: true });
  if (!Array.isArray(listed)) {
    throw new Error("Hermes adapter did not return a task list");
  }
  const expected = new Set(taskIds.values());
  const actual = new Set(listed.map(({ id }) => id));
  if (
    actual.size !== listed.length ||
    actual.size !== expected.size ||
    [...expected].some((taskId) => !actual.has(taskId))
  ) {
    throw new Error("materialized tenant does not contain the exact sealed task set");
  }
  const stages = new Map(enabledStages.map((stage) => [stage.key, stage]));
  const lifecycles = new Map();
  for (const [stage, taskId] of taskIds) {
    const lifecycle = await adapter.getTaskLifecycle({ taskId });
    lifecycles.set(taskId, lifecycle);
    const attempts = Array.isArray(lifecycle.runs) ? lifecycle.runs.length : 0;
    if (attempts > stages.get(stage).max_attempts) {
      throw new Error(`task ${taskId} exceeds the ${stage} attempt limit`);
    }
    if (
      lifecycle.status === "done" &&
      !hasTerminalCompletedAttempt(lifecycle)
    ) {
      throw new Error(
        `task ${taskId} is done without a terminal completed attempt`,
      );
    }
  }
  if ([...lifecycles.values()].some(({ status }) => status === "archived")) {
    const root = lifecycles.get(taskIds.get(rootStage));
    const cancellation = parseCancellationAudit(root?.comments, tenant);
    if (cancellation.request === null || cancellation.issues.length > 0) {
      throw new Error("materialized tenant has an archived task without cancellation");
    }
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

function generateGates({ enabledStages, layout, review }) {
  const gates = [];
  for (const stage of enabledStages) {
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
  const supplements = reviewSupplements(enabledStages, layout);
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
    inputs: [
      commentsValidation,
      ...supplements.map(({ validation }) => validation),
    ],
    outputs,
    review_policy: {
      urgency: review.automated_review.urgency,
      minimum_tier: REVIEW_MINIMUM_TIER[review.automated_review.urgency],
      max_comments: review.automated_review.max_comments,
      per_tier_caps: structuredClone(review.automated_review.per_tier_caps),
    },
    review_finalize: {
      comments_validation: commentsValidation,
      supplements,
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

function stageIo(stage, layout, enabledStages) {
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
    const byKey = new Map(
      enabledStages.map((candidate) => [candidate.key, candidate]),
    );
    const lensValidations = enabledStages
      .filter(({ validates_handoff_for: producer }) =>
        producer?.startsWith("lens:") && !byKey.get(producer).optional
      )
      .map(({ key }) => layout.validationEvidence.get(key));
    return {
      inputs: [layout.reviewManifest, layout.candidateDiff, ...lensValidations],
      outputs: ["metadata.handoff.artifacts[0].inline (review-comments)"],
    };
  }
  if (stage.key === "finalize") {
    return {
      inputs: [
        layout.validationEvidence.get("validate-handoff:critic"),
        ...reviewSupplements(enabledStages, layout).map(
          ({ validation }) => validation,
        ),
      ],
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
  if (stage.key === "orientation" || stage.key === "diagram") {
    return {
      inputs: [layout.reviewManifest, layout.candidateDiff],
      outputs: [
        `metadata.handoff.artifacts[0].inline (review-${stage.key})`,
      ],
    };
  }
  return { inputs: [], outputs: [] };
}

function reviewSupplements(enabledStages, layout) {
  return enabledStages
    .filter(({ optional }) => optional)
    .map(({ key }) => ({
      kind: key,
      validation: layout.validationEvidence.get(`validate-handoff:${key}`),
    }));
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

function expectedSealedGateTopology(enabledStages, layout) {
  return [
    ...enabledStages
      .filter(({ validates_handoff_for: producer }) => producer)
      .map(({ key }) => ({
        name: `${key}.json`,
        path: layout.gatePath(key),
        stage: key,
      })),
    {
      name: "finalize.json",
      path: layout.gatePath("finalize"),
      stage: "finalize",
    },
  ];
}

function stagingPath(staging, runDirectory, finalPath) {
  return join(staging, finalPath.slice(runDirectory.length + 1));
}

async function writeSealed(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
}
