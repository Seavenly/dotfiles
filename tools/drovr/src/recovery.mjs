import { stat } from "node:fs/promises";

import { loadConfiguration } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { harnessAdapter } from "./harness-adapter.mjs";
import { HerdrClient } from "./herdr.mjs";
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
  const herdr =
    dependencies.herdr ??
    new HerdrClient({
      session: initial.group.herdr.session,
      env,
      run: dependencies.run,
    });
  await herdr.ensureSession();

  const liveAgents = herdr.agentRecords ? await herdr.agentRecords() : null;
  const observed = liveAgents
    ? liveAgents.find(({ name }) => name === initial.agent.herdr.name)
    : await herdr.agentRecord(initial.agent.herdr.name);
  const duplicateOwner = (liveAgents ?? []).find(
    (candidate) =>
      candidate.name !== initial.agent.herdr.name &&
      candidate.agent_session?.value === initial.agent.native_session,
  );
  if (duplicateOwner) {
    return blocked(initial, "duplicate_native_session");
  }
  if (observed) {
    if (
      !initial.agent.native_session ||
      observed.agent_session?.value !== initial.agent.native_session
    ) {
      return blocked(initial, "native_session_mismatch");
    }
    if (
      observed.pane_id &&
      observed.pane_id !== initial.agent.herdr.pane_id
    ) {
      await withResourceLock(
        registryDirectory,
        `agent:${agentId}`,
        async () => {
          const current = await recoveryContext(registryDirectory, agentId);
          current.agent.herdr.pane_id = observed.pane_id;
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
    herdr,
    liveAgents,
  );
  if (safetyFailure) return blocked(initial, safetyFailure);

  const adapter = harnessAdapter(initial.agent.launch.harness, env);
  try {
    await adapter.validate(initial.agent.launch, {
      env,
      run: dependencies.run,
    });
  } catch {
    return blocked(initial, "launch_unsatisfied");
  }
  try {
    await ensureRecoveryPane(
      initial,
      herdr,
      registryDirectory,
      liveAgents,
    );
    const launchRuntime = await adapter.prepareLaunch(
      registryDirectory,
      initial.agent,
    );
    await adapter.resumeAgent(herdr, {
      name: initial.agent.herdr.name,
      paneId: initial.agent.herdr.pane_id,
      label: initial.agent.label ?? initial.agent.key,
      specification: initial.agent.launch,
      nativeSession: initial.agent.native_session,
      ...launchRuntime,
    });
  } catch (error) {
    return uncertain(initial, "resume_failed", error.message);
  }

  let restored;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    restored = await herdr.agentRecord(initial.agent.herdr.name);
    if (restored) break;
    await (dependencies.delay ?? delay)(25);
  }
  if (restored?.agent_status === "working") {
    try {
      restored = await herdr.waitForAgent(
        initial.agent.herdr.name,
        dependencies.recoveryTimeoutMs ?? 120_000,
      );
    } catch (error) {
      return uncertain(initial, "resume_settlement_failed", error.message);
    }
  }
  if (
    !restored ||
    restored.agent_session?.value !== initial.agent.native_session ||
    !["idle", "done"].includes(restored.agent_status)
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
      if (restored.pane_id) context.agent.herdr.pane_id = restored.pane_id;
      await writeRecord(registryDirectory, "agents", context.agent);
      return { ...context, status: "recovered", observed: restored };
    },
  );
}

async function recoverySafetyFailure(context, env, herdr, liveAgents) {
  if (!context.agent.native_session) return "missing_native_session";
  try {
    if (!(await stat(context.task.cwd)).isDirectory()) return "missing_cwd";
  } catch {
    return "missing_cwd";
  }
  const adapter = harnessAdapter(context.agent.launch.harness, env);
  try {
    const transcript = await adapter.locate(
      adapter.root,
      context.agent.native_session,
    );
    await adapter.validateTranscript(
      transcript,
      context.agent.native_session,
      context.task.cwd,
    );
  } catch {
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
  if (herdr.paneRecord) {
    let pane;
    try {
      pane = await herdr.paneRecord(context.agent.herdr.pane_id);
    } catch {
      return "ambiguous_process_state";
    }
    if (!pane) {
      if (herdr.tabRecord && (await herdr.tabRecord(context.task.herdr.tab_id))) {
        const siblingPane = await managedSiblingPane(
          context,
          herdr,
          stateDirectory(env),
          liveAgents,
        );
        if (!siblingPane) return "ambiguous_process_state";
      }
      return null;
    }
  }
  let processInfo;
  try {
    processInfo = await herdr.paneProcessInfo(context.agent.herdr.pane_id);
  } catch {
    return "ambiguous_process_state";
  }
  if (
    !processInfo?.shell_pid ||
    !Array.isArray(processInfo.foreground_processes) ||
    processInfo.foreground_processes.some(
      ({ pid }) => pid !== processInfo.shell_pid,
    )
  ) {
    return "ambiguous_process_state";
  }
  return null;
}

async function ensureRecoveryPane(
  context,
  herdr,
  registryDirectory,
  liveAgents,
) {
  if (
    !herdr.paneRecord ||
    (await herdr.paneRecord(context.agent.herdr.pane_id))
  ) {
    return;
  }
  let placement;
  const taskTab = herdr.tabRecord
    ? await herdr.tabRecord(context.task.herdr.tab_id)
    : null;
  if (taskTab) {
    const siblingPane = await managedSiblingPane(
      context,
      herdr,
      registryDirectory,
      liveAgents,
    );
    if (!siblingPane) {
      throw new DrovrError(
        `task ${context.task.id} has no verified pane for recovery`,
        { code: 0, outcome: "recovery_blocked" },
      );
    }
    placement = {
      tabId: context.task.herdr.tab_id,
      paneId: await herdr.splitPane({
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
    herdr.workspaceRecord &&
    (await herdr.workspaceRecord(context.group.herdr.workspace_id))
  ) {
    placement = await herdr.createTab({
      workspaceId: context.group.herdr.workspace_id,
      cwd: context.task.cwd,
      label: context.task.label ?? context.task.key ?? context.task.id,
    });
  } else {
    const workspace = await herdr.createWorkspace({
      cwd: context.task.cwd,
      label: context.group.label ?? context.group.key ?? context.group.id,
    });
    context.group.herdr.workspace_id = workspace.workspaceId;
    await writeRecord(registryDirectory, "groups", context.group);
    placement = { tabId: workspace.tabId, paneId: workspace.paneId };
    if (herdr.renameTab) {
      await herdr.renameTab(
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
  herdr,
  registryDirectory,
  liveAgents,
) {
  const agents = await readRecords(registryDirectory, "agents");
  const liveByName = new Map(
    (liveAgents ?? (await herdr.agentRecords())).map((agent) => [
      agent.name,
      agent,
    ]),
  );
  for (const sibling of agents) {
    if (
      sibling.id === context.agent.id ||
      sibling.task_id !== context.task.id ||
      sibling.status !== "active"
    ) {
      continue;
    }
    const live = liveByName.get(sibling.herdr.name);
    if (
      !live ||
      live.pane_id !== sibling.herdr.pane_id ||
      live.agent_session?.value !== sibling.native_session
    ) {
      continue;
    }
    const pane = await herdr.paneRecord(sibling.herdr.pane_id);
    if (pane?.tab_id === context.task.herdr.tab_id) {
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
  return context;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
