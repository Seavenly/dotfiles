import { stat } from "node:fs/promises";

import { loadConfiguration } from "./config.mjs";
import { bindAgentLaunchRuntime } from "./description.mjs";
import { DrovrError } from "./errors.mjs";
import { semanticHarnessFor } from "./harness-interface.mjs";
import {
  readRecords,
  stateDirectory,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import {
  agentRelationship,
  loadRegistryRelationships,
} from "./registry-relationships.mjs";
import { settleTurnRecord } from "./turn-record.mjs";

export async function reconcileOrRecoverAgent(
  agentId,
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await recoveryContext(registryDirectory, agentId);
  if (initial.agent.status !== "active" || initial.task.status !== "active") {
    return { ...initial, status: "recovery_blocked", reason: "resource_closed" };
  }
  const harness =
    dependencies.harness ??
    semanticHarnessFor(initial, { ...dependencies, env });
  await harness.ensureRuntime();

  const activeAgents = initial.agents ?? [initial.agent];
  const observations = await harness.observeAgents(activeAgents);
  const observedIndex = activeAgents.findIndex(
    (agent) => agent.id === initial.agent.id,
  );
  const observed = observations[observedIndex];
  const duplicateOwner =
    observed.reason === "duplicate_native_session" ||
    observations.find(
      (candidate, index) =>
        index !== observedIndex &&
        (candidate.reason === "duplicate_native_session" ||
          (candidate.identity?.native_session &&
            candidate.identity.native_session === initial.agent.native_session)),
    );
  if (duplicateOwner) {
    return blocked(initial, "duplicate_native_session");
  }
  if (
    !initial.agent.native_session &&
    observed.evidence === "present" &&
    typeof observed.identity?.native_session === "string" &&
    observed.identity.native_session.length > 0
  ) {
    await withResourceLock(
      registryDirectory,
      `agent:${agentId}`,
      async () => {
        const current = await recoveryContext(registryDirectory, agentId);
        if (
          current.agent.native_session &&
          current.agent.native_session !== observed.identity.native_session
        ) {
          initial.agent = current.agent;
          return;
        }
        let changed = false;
        if (!current.agent.native_session) {
          current.agent.native_session = observed.identity.native_session;
          changed = true;
        }
        if (observed.compatibility?.managed_pane_identity) {
          current.agent.launch_binding = bindAgentLaunchRuntime(
            current.agent.launch_binding,
            observed.compatibility,
          );
          changed = true;
        }
        if (changed) {
          await writeRecord(registryDirectory, "agents", current.agent);
        }
        initial.agent = current.agent;
      },
    );
  }
  if (
    initial.agent.native_session &&
    observed.identity?.native_session &&
    initial.agent.native_session !== observed.identity.native_session
  ) {
    return blocked(initial, "native_session_mismatch");
  }
  if (!initial.agent.native_session) {
    return blocked(initial, "missing_native_session");
  }
  if (observed.evidence !== "absent") {
    if (observed.evidence !== "present") {
      return blocked(initial, "native_session_mismatch");
    }
    if (observed.identity?.pane &&
        observed.identity.pane !== initial.agent.herdr.pane_id) {
      await withResourceLock(
        registryDirectory,
        `agent:${agentId}`,
        async () => {
          const current = await recoveryContext(registryDirectory, agentId);
          current.agent.herdr.pane_id = observed.identity.pane;
          await writeRecord(registryDirectory, "agents", current.agent);
          initial.agent = current.agent;
        },
      );
    }
    return { ...initial, status: "reconciled", observed };
  }

  const safetyFailure = await recoverySafetyFailure(
    initial,
    env,
    harness,
    observations,
  );
  if (safetyFailure) return blocked(initial, safetyFailure);

  try {
    const launchValidation = await harness.validateLaunch({
      specification: initial.agent.launch,
    });
    if (launchValidation.evidence !== "present") {
      return blocked(initial, "launch_unsatisfied");
    }
  } catch {
    return blocked(initial, "launch_unsatisfied");
  }
  let resumed;
  try {
    await ensureRecoveryPane(
      initial,
      harness,
      registryDirectory,
      observations,
    );
    resumed = await harness.resumeAgent({
      agent: initial.agent,
      registryDirectory,
    });
  } catch (error) {
    if (error.outcome === "compatibility_blocked") {
      return blocked(initial, "managed_runtime_identity");
    }
    return uncertain(initial, "resume_failed", error.message);
  }

  const restored = await harness.waitForAgent(initial.agent, {
    timeoutMs: dependencies.recoveryTimeoutMs ?? 120_000,
  });
  if (
    restored.evidence !== "present" ||
    restored.identity.native_session !== initial.agent.native_session ||
    !["idle", "done"].includes(restored.state)
  ) {
    return uncertain(initial, "resume_identity_unconfirmed");
  }

  return withResourceLock(
    registryDirectory,
    `agent:${agentId}`,
    async () => {
      const context = await recoveryContext(registryDirectory, agentId);
      const turns = await readRecords(registryDirectory, "turns");
      for (const turn of turns.filter(
        (candidate) =>
          candidate.agent_id === agentId && candidate.status === "working",
      )) {
        settleTurnRecord(turn, {
          status: "interrupted",
          error: "native harness was recovered without replaying this input",
          settledAt: now(),
        });
        await writeRecord(registryDirectory, "turns", turn);
      }
      context.agent.recovered_at = now();
      if (restored.identity.pane) {
        context.agent.herdr.pane_id = restored.identity.pane;
      }
      if (resumed?.compatibility?.managed_pane_identity) {
        context.agent.launch_binding = bindAgentLaunchRuntime(
          context.agent.launch_binding,
          resumed.compatibility,
        );
      }
      await writeRecord(registryDirectory, "agents", context.agent);
      return { ...context, status: "recovered", observed: restored };
    },
  );
}

async function recoverySafetyFailure(context, env, harness, observations) {
  if (!context.agent.native_session) return "missing_native_session";
  try {
    if (!(await stat(context.task.cwd)).isDirectory()) return "missing_cwd";
  } catch {
    return "missing_cwd";
  }
  const transcript = await harness.validateRecovery({
    agent: context.agent,
    task: context.task,
  });
  if (transcript.evidence !== "present") {
    return "missing_transcript";
  }
  let configuration;
  try {
    configuration = await loadConfiguration({ env });
  } catch {
    return "launch_unsatisfied";
  }
  const persistedFingerprints = context.agent.launch.catalog_fingerprints;
  if (
    !persistedFingerprints ||
    Object.entries(persistedFingerprints).some(
      ([path, fingerprint]) => configuration.fingerprints[path] !== fingerprint,
    )
  ) {
    return "launch_drift";
  }
  if (harness.capabilities?.topology?.observePane !== false) {
    let pane;
    try {
      pane = await harness.topology.observePane(context.agent.herdr.pane_id);
    } catch {
      return "ambiguous_process_state";
    }
    if (!pane) {
      if (
        harness.capabilities?.topology?.observeTab !== false &&
        (await harness.topology.observeTab(context.task.herdr.tab_id))
      ) {
        const siblingPane = await managedSiblingPane(
          context,
          harness,
          stateDirectory(env),
          observations,
        );
        if (!siblingPane) return "ambiguous_process_state";
      }
      return null;
    }
  }
  let processInfo;
  try {
    processInfo = await harness.topology.observePaneProcess(
      context.agent.herdr.pane_id,
    );
  } catch {
    return "ambiguous_process_state";
  }
  if (
    !processInfo?.shellPid ||
    !Array.isArray(processInfo.foregroundProcesses) ||
    processInfo.foregroundProcesses.some(
      ({ pid }) => pid !== processInfo.shellPid,
    )
  ) {
    return "ambiguous_process_state";
  }
  return null;
}

async function ensureRecoveryPane(
  context,
  harness,
  registryDirectory,
  observations,
) {
  if (
    harness.capabilities?.topology?.observePane === false ||
    (await harness.topology.observePane(context.agent.herdr.pane_id))
  ) {
    return;
  }
  let placement;
  const taskTab = harness.capabilities?.topology?.observeTab === false
    ? null
    : await harness.topology.observeTab(context.task.herdr.tab_id);
  if (taskTab) {
    const siblingPane = await managedSiblingPane(
      context,
      harness,
      registryDirectory,
      observations,
    );
    if (!siblingPane) {
      throw new DrovrError(
        `task ${context.task.id} has no verified pane for recovery`,
        { code: 0, outcome: "recovery_blocked" },
      );
    }
    placement = {
      tabId: context.task.herdr.tab_id,
      paneId: await harness.topology.splitTaskPane({
        paneId: siblingPane,
        direction: "right",
        ratio: 0.5,
        cwd: context.task.cwd,
      }),
    };
    if (context.task.herdr.root_pane_id === context.agent.herdr.pane_id) {
      context.task.herdr.root_pane_id = siblingPane;
    }
  } else if (
    harness.capabilities?.topology?.observeWorkspace !== false &&
    (await harness.topology.observeWorkspace(context.group.herdr.workspace_id))
  ) {
    const createdTab = await harness.topology.createTaskTab({
      workspaceId: context.group.herdr.workspace_id,
      cwd: context.task.cwd,
      label: context.task.label ?? context.task.key ?? context.task.id,
    });
    placement = {
      tabId: createdTab.tabId,
      paneId: createdTab.rootPaneId,
    };
  } else {
    const workspace = await harness.topology.createWorkspace({
      cwd: context.task.cwd,
      label: context.group.label ?? context.group.key ?? context.group.id,
    });
    context.group.herdr.workspace_id = workspace.workspaceId;
    await writeRecord(registryDirectory, "groups", context.group);
    placement = {
      tabId: workspace.tabId,
      paneId: workspace.rootPaneId,
    };
    if (harness.capabilities?.topology?.renameTask !== false) {
      await harness.topology.renameTask(
        placement.tabId,
        context.task.label ?? context.task.key ?? context.task.id,
      );
    }
  }
  context.task.herdr = {
    tab_id: placement.tabId,
    root_pane_id: placement.paneId,
  };
  context.agent.herdr.pane_id = placement.paneId;
  await writeRecord(registryDirectory, "tasks", context.task);
  await writeRecord(registryDirectory, "agents", context.agent);
}

async function managedSiblingPane(
  context,
  harness,
  registryDirectory,
  observations,
) {
  const agents = await readRecords(registryDirectory, "agents");
  const activeAgents = agents.filter(
    (agent) => agent.status === "active" && agent.task_id === context.task.id,
  );
  const liveObservations = observations ??
    await harness.observeAgents(activeAgents);
  const observationAgents = observations
    ? context.agents ?? activeAgents
    : activeAgents;
  const observationByAgentId = new Map(
    observationAgents.map((agent, index) => [agent.id, liveObservations[index]]),
  );
  for (const sibling of activeAgents) {
    if (
      sibling.id === context.agent.id ||
      sibling.task_id !== context.task.id ||
      sibling.status !== "active"
    ) {
      continue;
    }
    const live = observationByAgentId.get(sibling.id);
    if (
      !live ||
      live.evidence !== "present" ||
      live.identity?.pane !== sibling.herdr.pane_id ||
      live.identity?.native_session !== sibling.native_session
    ) {
      continue;
    }
    const pane = await harness.topology.observePane(sibling.herdr.pane_id);
    if (pane?.tabId === context.task.herdr.tab_id) {
      return sibling.herdr.pane_id;
    }
  }
  return null;
}

async function recoveryContext(registryDirectory, agentId) {
  const registry = await loadRegistryRelationships(registryDirectory);
  const context = agentRelationship(registry, agentId);
  if (!context) {
    throw new DrovrError(`active agent not found: ${agentId}`, {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  return {
    ...context,
    agents: registry.agents.filter(
      (agent) => agent.task_id === context.task.id && agent.status === "active",
    ),
  };
}

function blocked(context, reason) {
  return { ...context, status: "recovery_blocked", reason };
}

function uncertain(context, reason, error) {
  return {
    ...context,
    status: "uncertain",
    reason,
    ...(error ? { error } : {}),
  };
}
