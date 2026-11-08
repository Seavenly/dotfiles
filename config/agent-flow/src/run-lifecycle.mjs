import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatCancellationComment,
  parseCancellationAudit,
} from "./cancellation-audit.mjs";
import { HermesAdapter, parseTaskAuthority } from "./hermes-adapter.mjs";
import { materializationOrder } from "./review-topology.mjs";
import { expandedTransitionStages, instantiateTransition } from "./graph-transition.mjs";
import { acquireRunMutationLock } from "./run-lock.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { classifyRunTerminal } from "./run-terminal.mjs";
import { validateContract } from "./schema-validator.mjs";

const TASK_STATUSES = [
  "triage",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "scheduled",
  "done",
  "archived",
];
const TERMINAL_STATUSES = new Set(["done", "archived"]);

export async function projectRunStatus({
  runId,
  adapter = null,
  env = process.env,
  now = () => new Date(),
}) {
  const authority = await loadRunAuthority({ runId, env });
  const resolvedAdapter = adapter ?? new HermesAdapter({
    board: authority.manifest.identity.board,
  });
  const listed = await resolvedAdapter.listTasks({
    tenant: authority.manifest.identity.tenant,
    includeArchived: true,
  });
  if (!Array.isArray(listed)) {
    throw new Error("Hermes adapter did not return a task list");
  }
  const listedById = new Map(listed.map((task) => [task.id, task]));
  const issues = [...authority.issues];
  const cards = [];
  const lifecycles = new Map();
  const terminalTimes = [];
  const expectedTaskIds = new Set(Object.values(authority.tasks));
  const stagesByKey = new Map(
    authority.enabledStages.map((stage) => [stage.key, stage]),
  );

  for (const [stage, taskId] of Object.entries(authority.tasks)) {
    const listedTask = listedById.get(taskId);
    if (!listedTask) {
      issues.push(`missing Hermes task ${taskId} for stage ${stage}`);
      continue;
    }
    const task = await resolvedAdapter.getTaskLifecycle({ taskId });
    lifecycles.set(taskId, task);
    const attempts = Array.isArray(task.runs) ? task.runs.length : 0;
    const retrying = task.status === "ready" && attempts > 0 &&
      task.runs.at(-1)?.outcome !== "completed";
    if (task.tenant !== authority.manifest.identity.tenant) {
      issues.push(`task ${taskId} has tenant ${task.tenant ?? "null"}`);
    }
    const expectedTitle = `[${runId}/${stage}]`;
    if (task.title !== expectedTitle) {
      issues.push(`task ${taskId} does not match stage ${stage}`);
    }
    const expectedParents = authority.dependencies
      .filter(({ parent, child }) => child === stage && authority.tasks[parent])
      .map(({ parent }) => authority.tasks[parent]);
    if (!sameMembers(task.parents, expectedParents)) {
      issues.push(`task ${taskId} has unexpected dependency parents`);
    }
    const declaredStage = stagesByKey.get(stage);
    const declaredAttempts = declaredStage?.max_attempts;
    if (Number.isInteger(declaredAttempts) && attempts > declaredAttempts) {
      issues.push(`task ${taskId} exceeds the ${stage} attempt limit`);
    }
    if (
      declaredStage &&
      (
        task.assignee !== declaredStage.profile ||
        task.workspace_kind !== "dir" ||
        task.workspace_path !== expectedWorkspace(authority, declaredStage) ||
        task.max_retries !== declaredStage.max_attempts
      )
    ) {
      issues.push(`task ${taskId} execution settings do not match stage ${stage}`);
    }
    try {
      const taskAuthority = await parseTaskAuthority({ body: task.body, taskId });
      if (!taskAuthorityMatches({ authority, stage, taskAuthority })) {
        issues.push(`task ${taskId} authority does not match stage ${stage}`);
      }
    } catch (error) {
      issues.push(error.message);
    }
    if (task.status === "done" && !hasTerminalCompletedAttempt(task.runs)) {
      issues.push(`task ${taskId} is done without a terminal completed attempt`);
    }
    const terminalTime = taskTerminalTime(task);
    if (terminalTime) terminalTimes.push(terminalTime);
    else if (TERMINAL_STATUSES.has(task.status)) {
      issues.push(`task ${taskId} is terminal without a native terminal timestamp`);
    }
    cards.push({
      id: taskId,
      stage,
      status: task.status,
      attempts,
      retrying,
    });
    listedById.delete(taskId);
  }
  for (const task of listedById.values()) {
    if (expectedTaskIds.has(task.id)) continue;
    const lifecycle = await resolvedAdapter.getTaskLifecycle({ taskId: task.id });
    lifecycles.set(task.id, lifecycle);
    issues.push(`undeclared Hermes task ${task.id} in run tenant`);
    const terminalTime = taskTerminalTime(lifecycle);
    if (terminalTime) terminalTimes.push(terminalTime);
    cards.push({
      id: task.id,
      stage: stageFromTitle(task.title, runId),
      status: lifecycle.status,
      attempts: Array.isArray(lifecycle.runs) ? lifecycle.runs.length : 0,
      retrying: lifecycle.status === "ready" &&
        lifecycle.runs?.length > 0 &&
        lifecycle.runs.at(-1)?.outcome !== "completed",
    });
  }

  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const card of cards) {
    if (Object.hasOwn(counts, card.status)) counts[card.status] += 1;
    else issues.push(`task ${card.id} has unexpected status ${card.status}`);
  }
  counts.total = cards.length;

  const rootId = authority.tasks[authority.graph.root] ?? null;
  const rootCard = cards.find(({ id }) => id === rootId) ?? null;
  const rootLifecycle = lifecycles.get(rootId) ?? null;
  const cancellationAudit = cancellationFromComments(
    rootLifecycle?.comments,
    cards,
    runId,
  );
  issues.push(...cancellationAudit.issues);
  const cancellation = cancellationAudit.cancellation;
  const terminalClassification = classifyRunTerminal({
    cancellationAudit: {
      issues: cancellationAudit.issues,
      request: cancellation.requested ? cancellation : null,
    },
    tasks: [...lifecycles.values()],
  });
  const attemptCount = cards.reduce((total, card) => total + card.attempts, 0);
  const observedAt = now();
  const terminalAt = cards.every(({ status }) => TERMINAL_STATUSES.has(status))
    ? terminalTimestamp({ cancellation, rootLifecycle, terminalTimes })
    : null;
  const elapsedSeconds = Math.max(
    0,
    Math.floor(
      ((terminalAt ?? observedAt).getTime() -
        new Date(authority.manifest.sealed_at).getTime()) / 1000,
    ),
  );
  const limits = {
    created_cards: limitReport(
      cards.length,
      authority.manifest.limits.max_created_cards,
    ),
    worker_attempts: limitReport(
      attemptCount,
      authority.manifest.limits.max_worker_attempts,
    ),
    elapsed_seconds: limitReport(
      elapsedSeconds,
      authority.manifest.limits.max_elapsed_seconds,
    ),
    feature_streams: limitReport(
      0,
      authority.manifest.limits.max_feature_streams,
    ),
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (limit.exceeded) issues.push(`${name} limit exceeded`);
  }

  if (!cancellation.requested) {
    for (const card of cards.filter(({ status }) => status === "archived")) {
      issues.push(
        `task ${card.id} is archived without an audited cancellation request`,
      );
    }
  }

  return {
    run_id: runId,
    flow: authority.manifest.identity.flow,
    board: authority.manifest.identity.board,
    tenant: authority.manifest.identity.tenant,
    external_root: structuredClone(authority.manifest.identity.external_root),
    supersedes: authority.manifest.identity.supersedes,
    state: deriveState({
      cancellation,
      cards,
      issues,
      rootCard,
      terminalClassification,
    }),
    root: rootCard === null
      ? null
      : { id: rootCard.id, stage: rootCard.stage, status: rootCard.status },
    counts,
    cards,
    limits,
    artifacts: artifactProjection(authority),
    cancellation,
    issues,
  };
}

export async function cancelRun({
  runId,
  reason,
  adapter = null,
  env = process.env,
  now = () => new Date(),
}) {
  const initialAuthority = await loadRunAuthority({ runId, env });
  const resolvedAdapter = adapter ?? new HermesAdapter({
    board: initialAuthority.manifest.identity.board,
  });
  const releaseLock = await acquireRunMutationLock(
    initialAuthority.manifest.identity.run_directory,
    { operation: "cancellation" },
  );
  try {
    const authority = await loadRunAuthority({ runId, env });
    return await cancelLocked({
      authority,
      now,
      reason,
      resolvedAdapter,
      runId,
    });
  } finally {
    await releaseLock();
  }
}

async function cancelLocked({ authority, now, reason, resolvedAdapter, runId }) {
  if (authority.issues.length > 0) {
    throw new Error(
      `run ${runId} cannot be cancelled safely: ${authority.issues.join("; ")}`,
    );
  }
  const initialTasks = await resolvedAdapter.listTasks({
    tenant: authority.manifest.identity.tenant,
    includeArchived: true,
  });
  const rootId = authority.tasks[authority.graph.root];
  if (!initialTasks.some(({ id }) => id === rootId)) {
    throw new Error(`run ${runId} root is absent from its sealed tenant`);
  }
  let root = null;
  for (const [stage, taskId] of Object.entries(authority.tasks)) {
    if (!initialTasks.some(({ id }) => id === taskId)) {
      throw new Error(`run ${runId} task ${taskId} is absent from its sealed tenant`);
    }
    const task = await resolvedAdapter.getTaskLifecycle({ taskId });
    if (
      task.tenant !== authority.manifest.identity.tenant ||
      task.title !== `[${runId}/${stage}]`
    ) {
      throw new Error(`run ${runId} task ${taskId} does not match stage ${stage}`);
    }
    const taskAuthority = await parseTaskAuthority({ body: task.body, taskId });
    if (!taskAuthorityMatches({ authority, stage, taskAuthority })) {
      throw new Error(`run ${runId} task ${taskId} has mismatched authority`);
    }
    if (taskId === rootId) root = task;
  }
  const cancellationAudit = parseCancellationAudit(root.comments, runId);
  if (cancellationAudit.issues.length > 0) {
    throw new Error(
      `run ${runId} has ambiguous cancellation audit: ` +
        cancellationAudit.issues.join("; "),
    );
  }
  let request = cancellationAudit.request;
  if (request === null) {
    if (nonterminalTasks(initialTasks).length === 0) {
      throw new Error(`run ${runId} is already terminal`);
    }
    request = {
      run_id: runId,
      reason,
      requested_at: now().toISOString(),
    };
    await resolvedAdapter.commentTask({
      taskId: rootId,
      body: formatCancellationComment(request),
    });
  }

  let archived = 0;
  let reclaimed = 0;
  let priorSurvivorCount = Number.POSITIVE_INFINITY;
  while (true) {
    const tasks = await resolvedAdapter.listTasks({
      tenant: authority.manifest.identity.tenant,
      includeArchived: true,
    });
    const survivors = nonterminalTasks(tasks);
    if (survivors.length === 0) {
      return {
        runId,
        converged: true,
        archived,
        reclaimed,
        reason: request.reason,
        survivors: [],
      };
    }
    if (survivors.length >= priorSurvivorCount) {
      return {
        runId,
        converged: false,
        archived,
        reclaimed,
        reason: request.reason,
        survivors: survivorReport(survivors, runId),
      };
    }
    priorSurvivorCount = survivors.length;
    const rootLast = [...survivors].sort(
      (left, right) => Number(left.id === rootId) - Number(right.id === rootId),
    );
    for (const task of rootLast) {
      if (task.status === "running") {
        if (await resolvedAdapter.reclaimTask({
          taskId: task.id,
          reason: `agent-flow cancellation: ${request.reason}`,
        })) reclaimed += 1;
      }
      if (await resolvedAdapter.archiveTask({ taskId: task.id })) archived += 1;
    }
  }
}

export function renderCancellation(result) {
  if (result.converged) {
    return (
      `ok - cancellation converged for ${result.runId}\n` +
      `archived: ${result.archived} reclaimed: ${result.reclaimed}\n`
    );
  }
  return [
    `not ok - cancellation incomplete for ${result.runId}`,
    "survivors:",
    ...result.survivors.map(
      ({ id, stage, status }) => `  - ${id} ${stage} ${status}`,
    ),
    "",
  ].join("\n");
}

export function renderRunStatus(report) {
  const active = report.cards.filter(
    ({ status }) => !TERMINAL_STATUSES.has(status),
  ).length;
  return [
    `run ${report.run_id}: ${report.state}`,
    `board: ${report.board} tenant: ${report.tenant}`,
    ...(report.external_root
      ? [
          `external root: ${report.external_root.system}:${report.external_root.id}`,
          ...(report.supersedes ? [`supersedes: ${report.supersedes}`] : []),
        ]
      : []),
    `root: ${report.root ? `${report.root.id} (${report.root.status})` : "missing"}`,
    `cards: ${report.counts.total} total, ${active} nonterminal`,
    `artifacts: ${report.artifacts.directory}`,
    ...(report.cancellation.requested
      ? [
          `cancellation: ${report.cancellation.reason}`,
          ...report.cancellation.survivors.map(
            ({ id, stage, status }) => `survivor: ${id} ${stage} ${status}`,
          ),
        ]
      : []),
    ...report.issues.map((issue) => `issue: ${issue}`),
    "",
  ].join("\n");
}

export async function loadRunAuthority({ runId, env = process.env }) {
  const { manifest, manifestBytes, manifestPath, runDirectory } =
    await loadRunManifest({ runId, env });

  const issues = [];
  const graphBytes = await readFile(manifest.graph.sealed_path);
  if (sha256(graphBytes) !== manifest.graph.sha256) {
    throw new Error(`run ${runId} graph digest does not match its manifest`);
  }
  const graph = JSON.parse(graphBytes);
  if (!(await validateContract(graph)).valid) {
    throw new Error(`run ${runId} has an invalid sealed graph`);
  }
  if (
    graph.name !== manifest.graph.name ||
    graph.version !== manifest.graph.version ||
    graph.flow !== manifest.graph.flow
  ) {
    issues.push("sealed graph identity does not match the run manifest");
  }

  const sealedInputs = new Map();
  for (const input of manifest.inputs) {
    const bytes = await readFile(input.sealed_path);
    if (sha256(bytes) !== input.sha256) {
      throw new Error(
        `run ${runId} sealed input digest does not match: ${input.kind}/${input.name}`,
      );
    }
    sealedInputs.set(`${input.kind}/${input.name}`, bytes);
  }
  const reviewBytes = sealedInputs.get("review-manifest/review.json");
  const review = reviewBytes ? JSON.parse(reviewBytes.toString("utf8")) : null;
  if (manifest.identity.flow === "review" && (!review || !(await validateContract(review)).valid)) {
    throw new Error(`run ${runId} has an invalid sealed review input`);
  }
  const gates = new Map();
  for (const input of manifest.inputs.filter(({ kind }) => kind === "gate")) {
    const document = JSON.parse(
      sealedInputs.get(`gate/${input.name}`).toString("utf8"),
    );
    if (!(await validateContract(document)).valid) {
      throw new Error(`run ${runId} has an invalid sealed gate ${input.name}`);
    }
    gates.set(document.stage, { document, input });
  }

  let receipt;
  try {
    receipt = JSON.parse(
      await readFile(join(runDirectory, "materialization.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      issues.push("materialization receipt is unreadable");
    } else {
      issues.push("materialization receipt is missing");
    }
    receipt = { tasks: {} };
  }
  const receiptTasks = receipt && typeof receipt === "object"
    ? receipt.tasks
    : null;
  const tasks = validTaskMap(receiptTasks) ? receiptTasks : {};
  if (!validTaskMap(receiptTasks)) {
    issues.push("materialization receipt has an invalid task map");
  } else {
    const staticStages = manifest.identity.flow === "review"
      ? materializationOrder(graph, review.automated_review.urgency)
      : graph.stages;
    const permittedStages = new Map([
      ...graph.stages,
      ...expandedTransitionStages(graph),
    ].map((stage) => [stage.key, stage]));
    const enabledStages = manifest.identity.flow === "review"
      ? staticStages
      : Object.keys(tasks).map((key) => permittedStages.get(key)).filter(Boolean);
    const requiredStaticKeys = new Set(staticStages.map(({ key }) => key));
    if (receipt.run_id !== runId) {
      issues.push("materialization receipt names a different run");
    }
    if (receipt.graph !== `${graph.name}/v${graph.version}`) {
      issues.push("materialization receipt names a different graph");
    }
    for (const stage of Object.keys(tasks)) {
      if (!permittedStages.has(stage)) {
        issues.push(`materialization receipt names undeclared stage ${stage}`);
      }
    }
    if (!Object.hasOwn(tasks, graph.root)) {
      issues.push(`materialization receipt omits root stage ${graph.root}`);
    }
    if (manifest.identity.flow === "review") {
      const enabledKeys = enabledStages.map(({ key }) => key);
      if (!sameMembers(Object.keys(tasks), enabledKeys)) {
        issues.push("materialization receipt does not name the exact enabled stages");
      }
    } else if ([...requiredStaticKeys].some((key) => !Object.hasOwn(tasks, key))) {
      issues.push("materialization receipt omits a required static stage");
    }
    if (Object.keys(tasks).length > manifest.limits.max_created_cards) {
      issues.push(
        `materialization receipt has ${Object.keys(tasks).length} tasks; ` +
          `maximum is ${manifest.limits.max_created_cards}`,
      );
    }
    const dependencies = materializedDependencies({ graph, tasks });
    return {
      dependencies, enabledStages, gates, graph, issues, manifest, manifestPath,
      manifestSha256: sha256(manifestBytes), review, tasks,
    };
  }
  return {
    dependencies: graph.dependencies, enabledStages: graph.stages, gates, graph,
    issues, manifest, manifestPath, manifestSha256: sha256(manifestBytes), review, tasks,
  };
}

function materializedDependencies({ graph, tasks }) {
  const dependencies = [...graph.dependencies];
  for (const transition of graph.transitions ?? []) {
    for (let ordinal = 1; ordinal <= transition.max_instances; ordinal += 1) {
      const instance = instantiateTransition(transition, ordinal);
      if (instance.stages.some(({ key }) => Object.hasOwn(tasks, key))) {
        dependencies.push(...instance.dependencies);
      }
    }
  }
  return dependencies;
}

function cancellationFromComments(comments, cards, runId) {
  const audit = parseCancellationAudit(comments, runId);
  const survivors = cards
    .filter(({ status }) => !TERMINAL_STATUSES.has(status))
    .map(({ id, stage, status }) => ({ id, stage, status }));
  return {
    cancellation: {
      requested: audit.request !== null,
      reason: audit.request?.reason ?? null,
      requested_at: audit.request?.requested_at ?? null,
      survivors: audit.request === null ? [] : survivors,
    },
    issues: audit.issues,
  };
}

function terminalTimestamp({ cancellation, rootLifecycle, terminalTimes }) {
  if (terminalTimes.length > 0) {
    return new Date(Math.max(...terminalTimes.map((date) => date.getTime())));
  }
  const completedAt = rootLifecycle?.completed_at;
  if (Number.isInteger(completedAt) && completedAt > 0) {
    return new Date(completedAt * 1000);
  }
  return cancellation.requested_at ? new Date(cancellation.requested_at) : null;
}

function nonterminalTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error("Hermes adapter did not return a task list");
  }
  return tasks.filter(({ status }) => !TERMINAL_STATUSES.has(status));
}

function artifactProjection(authority) {
  const finalize = authority.gates.get("finalize")?.document;
  const outputs = finalize?.outputs ?? [];
  const validations = [...authority.gates.values()]
    .filter(({ document }) => document.kind === "handoff-validation")
    .flatMap(({ document }) => document.outputs);
  return {
    directory: authority.manifest.identity.artifact_directory,
    validation_directory: authority.manifest.identity.validation_directory,
    outputs,
    validations,
    result: finalize?.review_finalize?.result_output ?? null,
  };
}

function expectedWorkspace(authority, stage) {
  return stage.workspace === "run-dir"
    ? authority.manifest.identity.run_directory
    : authority.manifest.identity.repository.worktree;
}

function taskAuthorityMatches({ authority, stage, taskAuthority }) {
  if (
    taskAuthority.runId !== authority.manifest.identity.run_id ||
    taskAuthority.stage !== stage ||
    taskAuthority.runManifestPath !== authority.manifestPath ||
    taskAuthority.runManifestSha256 !== authority.manifestSha256
  ) return false;

  const gate = authority.gates.get(stage);
  if (
    gate
      ? taskAuthority.gateSpecPath !== gate.input.sealed_path ||
        taskAuthority.gateSpecSha256 !== gate.input.sha256
      : taskAuthority.gateSpecPath !== undefined ||
        taskAuthority.gateSpecSha256 !== undefined
  ) return false;

  const stageSpec = authority.enabledStages.find(({ key }) => key === stage);
  const expectedProducer = stageSpec?.validates_handoff_for
    ? authority.tasks[stageSpec.validates_handoff_for]
    : undefined;
  if (taskAuthority.producerTaskId !== expectedProducer) return false;

  const expectedInputs = stage === "finalize"
    ? expectedFinalizeInputs(authority)
    : undefined;
  return sameRecord(taskAuthority.inputTaskIds, expectedInputs);
}

function expectedFinalizeInputs(authority) {
  const inputs = authority.gates.get("finalize")?.document.inputs ?? [];
  const validationStages = new Map();
  for (const [stage, { document }] of authority.gates) {
    if (document.kind !== "handoff-validation") continue;
    for (const output of document.outputs) validationStages.set(output, stage);
  }
  return Object.fromEntries(inputs.map((input) => [
    input,
    authority.tasks[validationStages.get(input)],
  ]));
}

function sameRecord(left, right) {
  if (left === undefined || right === undefined) return left === right;
  const keys = Object.keys(left);
  return sameMembers(keys, Object.keys(right)) &&
    keys.every((key) => left[key] === right[key]);
}

function hasTerminalCompletedAttempt(runs) {
  const terminal = Array.isArray(runs) ? runs.at(-1) : null;
  return terminal?.status === "done" && terminal.outcome === "completed";
}

function taskTerminalTime(task) {
  if (task.status === "done" && Number.isInteger(task.completed_at)) {
    return new Date(task.completed_at * 1000);
  }
  if (task.status !== "archived" || !Array.isArray(task.events)) return null;
  const archivedAt = task.events
    .filter(({ kind, created_at: createdAt }) =>
      kind === "archived" && Number.isInteger(createdAt)
    )
    .map(({ created_at: createdAt }) => createdAt)
    .at(-1);
  return archivedAt === undefined ? null : new Date(archivedAt * 1000);
}

function survivorReport(tasks, runId) {
  return tasks
    .map(({ id, title, status }) => ({
      id,
      stage: stageFromTitle(title, runId),
      status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function deriveState({
  cards,
  cancellation,
  issues,
  rootCard,
  terminalClassification,
}) {
  if (issues.length > 0) return "broken";
  if (terminalClassification === "cancelled") return "cancelled";
  if (cancellation.requested) {
    return cancellation.survivors.length === 0 ? "cancelled" : "cancelling";
  }
  if (terminalClassification === "completed") return "complete";
  if (cards.some(({ status }) => ["blocked", "triage"].includes(status))) {
    return "blocked";
  }
  if (cards.some(({ retrying }) => retrying)) return "retrying";
  return "running";
}

function validTaskMap(tasks) {
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return false;
  const ids = Object.values(tasks);
  return ids.length > 0 &&
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length;
}

function limitReport(actual, maximum) {
  return { actual, maximum, exceeded: actual > maximum };
}

function stageFromTitle(title, runId) {
  const prefix = `[${runId}/`;
  return typeof title === "string" && title.startsWith(prefix) && title.endsWith("]")
    ? title.slice(prefix.length, -1)
    : "unknown";
}

function sameMembers(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
