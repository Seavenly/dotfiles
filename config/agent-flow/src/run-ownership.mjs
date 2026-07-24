import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseCancellationAudit } from "./cancellation-audit.mjs";
import { parseTaskAuthority } from "./hermes-adapter.mjs";
import { loadRunAuthority } from "./run-lifecycle.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { classifyRunTerminal } from "./run-terminal.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function assertExternalOwnershipAvailable({
  adapterForBoard,
  currentRunId,
  externalRoot,
  repositoryPath,
  stateHome,
  supersedes,
}) {
  if (externalRoot === null) return;
  const owners = await matchingOwners({
    adapterForBoard,
    currentRunId,
    externalRoot,
    repositoryPath,
    stateHome,
  });
  const nonterminal = owners.find(({ terminal }) => !terminal);
  if (nonterminal) {
    throw new Error(
      `external root ${externalRoot.system}:${externalRoot.id} is owned by ` +
        `nonterminal run ${nonterminal.runId}`,
    );
  }
  if (owners.length > 0) {
    const superseded = new Set(
      owners.map((owner) => owner.supersedes).filter(Boolean),
    );
    const heads = owners.filter(({ runId }) => !superseded.has(runId));
    if (heads.length !== 1) {
      throw new Error(
        `external root ${externalRoot.system}:${externalRoot.id} has ambiguous ownership`,
      );
    }
    const prior = heads[0];
    if (supersedes === prior.runId) return;
    throw new Error(
      `external root ${externalRoot.system}:${externalRoot.id} must explicitly ` +
        `supersede terminal owner ${prior.runId}`,
    );
  }
  if (supersedes !== null) {
    throw new Error(
      `external root ${externalRoot.system}:${externalRoot.id} has no owner ` +
        `named ${supersedes} to supersede`,
    );
  }
}

async function matchingOwners({
  adapterForBoard,
  currentRunId,
  externalRoot,
  repositoryPath,
  stateHome,
}) {
  const runsDirectory = join(stateHome, "agent-flow", "runs");
  let entries;
  try {
    entries = (await readdir(runsDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const owners = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !RUN_ID_PATTERN.test(entry.name) ||
      entry.name === currentRunId
    ) continue;
    const { manifest } = await loadRunManifest({
      runId: entry.name,
      env: { XDG_STATE_HOME: stateHome },
    });
    if (
      manifest.identity.repository.path !== repositoryPath ||
      !sameExternalRoot(manifest.identity.external_root, externalRoot)
    ) continue;
    const runAuthority = await loadRunAuthority({
      runId: entry.name,
      env: { XDG_STATE_HOME: stateHome },
    });
    if (runAuthority.issues.length > 0) {
      throw new Error(`cannot establish ownership from run ${entry.name}`);
    }
    const taskEntries = Object.entries(runAuthority.tasks);
    const taskIds = taskEntries.map(([, taskId]) => taskId);
    if (
      taskEntries.length === 0 ||
      taskIds.some((taskId) => typeof taskId !== "string") ||
      new Set(taskIds).size !== taskIds.length
    ) {
      throw new Error(`cannot establish ownership from run ${entry.name}`);
    }
    const adapter = adapterForBoard(manifest.identity.board);
    const listed = await adapter.listTasks({
      tenant: manifest.identity.tenant,
      includeArchived: true,
    });
    if (!Array.isArray(listed)) {
      throw new Error(`cannot establish ownership from run ${entry.name}`);
    }
    const listedById = new Map(listed.map((task) => [task.id, task]));
    if (
      listedById.size !== listed.length ||
      taskIds.some((taskId) => !listedById.has(taskId))
    ) {
      throw new Error(`cannot establish ownership from run ${entry.name}`);
    }
    const lifecycles = [];
    for (const { id } of listed) {
      lifecycles.push(await adapter.getTaskLifecycle({ taskId: id }));
    }
    const lifecyclesById = new Map(lifecycles.map((task) => [task.id, task]));
    for (const [stage, taskId] of taskEntries) {
      const task = lifecyclesById.get(taskId);
      const taskAuthority = await parseTaskAuthority({ body: task.body, taskId });
      if (
        task.tenant !== manifest.identity.tenant ||
        task.title !== `[${entry.name}/${stage}]` ||
        taskAuthority.runId !== entry.name ||
        taskAuthority.stage !== stage ||
        taskAuthority.runManifestPath !== runAuthority.manifestPath ||
        taskAuthority.runManifestSha256 !== runAuthority.manifestSha256
      ) {
        throw new Error(`cannot establish ownership from run ${entry.name}`);
      }
    }
    const rootId = runAuthority.tasks[runAuthority.graph.root];
    const root = lifecyclesById.get(rootId);
    const cancellation = parseCancellationAudit(root?.comments, entry.name);
    const terminalClassification = classifyRunTerminal({
      cancellationAudit: cancellation,
      tasks: lifecycles,
    });
    const unexpected = lifecycles.filter(({ id }) => !taskIds.includes(id));
    if (unexpected.length > 0 && terminalClassification !== "nonterminal") {
      throw new Error(`cannot establish ownership from run ${entry.name}`);
    }
    owners.push({
      runId: entry.name,
      supersedes: manifest.identity.supersedes,
      terminal: ["completed", "cancelled"].includes(terminalClassification),
    });
  }
  return owners;
}

function sameExternalRoot(left, right) {
  return left?.system === right.system && left.id === right.id;
}
