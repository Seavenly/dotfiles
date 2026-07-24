import { randomUUID } from "node:crypto";

import { loadConfiguration, resolveLaunchSpecification } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { harnessAdapter } from "./harness-adapter.mjs";
import { HerdrClient } from "./herdr.mjs";
import {
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import {
  loadRegistryRelationships,
  taskRelationship,
} from "./registry-relationships.mjs";
import { reconcileOrRecoverAgent } from "./recovery.mjs";

function sameLaunchSpecification(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const STARTUP_STABILITY_MS = 2000;
const STARTUP_STABILITY_ATTEMPTS = 60;
const STARTUP_TIMEOUT_MS = 120_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAgentRegistration(herdr, name, pause, clock, deadline) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const agent = await herdr.agentRecord(name);
    if (agent) return agent;
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await pause(Math.min(50, remaining));
  }
  throw new DrovrError(`Herdr did not register managed agent ${name}`, {
    code: 4,
    outcome: "adapter_failure",
  });
}

async function waitForNewAgentReady(herdr, name, dependencies) {
  const pause = dependencies.delay ?? delay;
  const clock = dependencies.monotonicNow ?? (() => performance.now());
  const deadline = clock() + STARTUP_TIMEOUT_MS;
  for (
    let attempt = 0;
    attempt < STARTUP_STABILITY_ATTEMPTS;
    attempt += 1
  ) {
    let observed = await waitForAgentRegistration(
      herdr,
      name,
      pause,
      clock,
      deadline,
    );
    if (observed.agent_status === "working") {
      const remaining = deadline - clock();
      if (remaining <= 0) break;
      observed = await herdr.waitForAgent(
        name,
        Math.max(1, Math.floor(remaining)),
      );
    }
    if (!observed || !["idle", "done"].includes(observed.agent_status)) {
      throw new DrovrError(
        `Herdr managed agent ${name} did not finish starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await pause(Math.min(STARTUP_STABILITY_MS, remaining));
    if (clock() >= deadline) break;
    const confirmed = await herdr.agentRecord(name);
    if (confirmed?.agent_status === "working") continue;
    if (!confirmed || !["idle", "done"].includes(confirmed.agent_status)) {
      throw new DrovrError(
        `Herdr managed agent ${name} did not remain settled after starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const firstSession = observed.agent_session?.value;
    const confirmedSession = confirmed.agent_session?.value;
    if (firstSession && !confirmedSession) {
      throw new DrovrError(
        `Herdr managed agent ${name} lost native session identity while starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    if (firstSession && firstSession !== confirmedSession) {
      throw new DrovrError(
        `Herdr managed agent ${name} changed native session while starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    return confirmed;
  }
  throw new DrovrError(
    `Herdr managed agent ${name} did not stabilize while starting`,
    { code: 4, outcome: "adapter_failure" },
  );
}

function invalidTask(taskId) {
  throw new DrovrError(`task not found: ${taskId}`, {
    code: 2,
    outcome: "invalid_arguments",
  });
}

async function contextFor(registryDirectory, taskId) {
  const registry = await loadRegistryRelationships(registryDirectory);
  const context = taskRelationship(registry, taskId);
  if (!context) invalidTask(taskId);
  return context;
}

async function paneForNewAgent(context, herdr, registryDirectory) {
  const activeAgents = context.agents.filter(
    (candidate) => candidate.status === "active",
  );
  if (activeAgents.length === 0) {
    const rootPane = await herdr.paneRecord(context.task.herdr.root_pane_id);
    if (rootPane) {
      if (
        !rootPane.tab_id ||
        rootPane.tab_id !== context.task.herdr.tab_id
      ) {
        throw new DrovrError(
          `task ${context.task.id} root pane moved to an unregistered tab`,
          { code: 0, outcome: "recovery_blocked" },
        );
      }
      return context.task.herdr.root_pane_id;
    }
    if (await herdr.tabRecord(context.task.herdr.tab_id)) {
      throw new DrovrError(
        `task ${context.task.id} has an unowned surviving Herdr tab`,
        { code: 0, outcome: "recovery_blocked" },
      );
    }
    let tab;
    if (await herdr.workspaceRecord(context.group.herdr.workspace_id)) {
      tab = await herdr.createTab({
        workspaceId: context.group.herdr.workspace_id,
        cwd: context.task.cwd,
        label: context.task.label,
      });
    } else {
      const workspace = await herdr.createWorkspace({
        cwd: context.task.cwd,
        label: context.group.label,
      });
      context.group.herdr.workspace_id = workspace.workspaceId;
      await writeRecord(registryDirectory, "groups", context.group);
      tab = { tabId: workspace.tabId, paneId: workspace.paneId };
      await herdr.renameTab(tab.tabId, context.task.label);
    }
    context.task.herdr = {
      tab_id: tab.tabId,
      root_pane_id: tab.paneId,
    };
    await writeRecord(registryDirectory, "tasks", context.task);
    return tab.paneId;
  }

  const registeredPaneIds = new Set(
    activeAgents.map((agent) => agent.herdr.pane_id),
  );
  if (registeredPaneIds.size !== activeAgents.length) {
    throw new DrovrError(
      `task ${context.task.id} has duplicate registered agent panes`,
      { code: 0, outcome: "recovery_blocked" },
    );
  }
  const layout = await herdr.paneLayout(activeAgents[0].herdr.pane_id);
  const candidates = layout.panes.filter(({ pane_id: paneId }) =>
    registeredPaneIds.has(paneId),
  );
  if (candidates.length !== activeAgents.length) {
    throw new DrovrError(
      `task ${context.task.id} has registered panes outside its Herdr layout`,
      { code: 0, outcome: "recovery_blocked" },
    );
  }
  const target = candidates.reduce((largest, candidate) => {
    const largestArea = largest.rect.width * largest.rect.height;
    const candidateArea = candidate.rect.width * candidate.rect.height;
    return candidateArea > largestArea ? candidate : largest;
  });
  const direction =
    target.rect.width >= target.rect.height * 2 ? "right" : "down";
  return herdr.splitPane({
    paneId: target.pane_id,
    direction,
    ratio: 0.5,
    cwd: context.task.cwd,
  });
}

export async function startAgent(taskId, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await contextFor(registryDirectory, taskId);
  const configuration = await loadConfiguration({ env });
  const specification = resolveLaunchSpecification(configuration, options);
  const adapter = harnessAdapter(specification.harness, env);
  await adapter.validate(specification, { env, run: dependencies.run });
  const herdr =
    dependencies.herdr ??
    new HerdrClient({
      session: initial.group.herdr.session,
      env,
      run: dependencies.run,
    });
  await herdr.ensureSession();

  return withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(taskId),
    async () => {
      const context = await contextFor(registryDirectory, taskId);
      if (
        context.task.status !== "active" ||
        context.group.status !== "active"
      ) {
        throw new DrovrError(`task ${taskId} is closed`, {
          code: 0,
          outcome: "task_closed",
        });
      }
      const matching = context.agents.filter(
        (candidate) => candidate.key === options.key,
      );
      if (matching.length > 1) {
        throw new DrovrError(
          `task ${taskId} has duplicate agent key ${options.key}`,
          { code: 5, outcome: "corrupt_registry" },
        );
      }
      let agent = matching[0];
      if (agent) {
        if (agent.status !== "active") {
          throw new DrovrError(
            `agent key ${options.key} was retired and cannot be replaced`,
            { code: 0, outcome: "configuration_conflict" },
          );
        }
        if (!sameLaunchSpecification(agent.launch, specification)) {
          throw new DrovrError(
            `agent key ${options.key} already has a different launch specification`,
            { code: 0, outcome: "configuration_conflict" },
          );
        }
        let observed;
        if (agent.native_session) {
          const availability = await reconcileOrRecoverAgent(agent.id, {
            ...dependencies,
            env,
            herdr,
            now,
          });
          if (!["reconciled", "recovered"].includes(availability.status)) {
            throw new DrovrError(
              `agent ${agent.id} cannot be recovered safely (${availability.reason})`,
              { code: 0, outcome: availability.status },
            );
          }
          agent = availability.agent;
          observed = availability.observed;
        } else {
          observed = await herdr.agentRecord(agent.herdr.name);
          if (!observed) {
            await adapter.startAgent(herdr, {
              name: agent.herdr.name,
              paneId: agent.herdr.pane_id,
              label: agent.label,
              specification: agent.launch,
            });
          }
          observed = await waitForNewAgentReady(
            herdr,
            agent.herdr.name,
            dependencies,
          );
        }
        const nativeSession = observed?.agent_session?.value;
        if (nativeSession && agent.native_session !== nativeSession) {
          agent.native_session = nativeSession;
          await writeRecord(registryDirectory, "agents", agent);
        }
        if (options.label && options.label !== agent.label) {
          await herdr.renamePane(agent.herdr.pane_id, options.label);
          agent.label = options.label;
          await writeRecord(registryDirectory, "agents", agent);
        }
        return { group: context.group, task: context.task, agent };
      }

      const paneId = await paneForNewAgent(
        context,
        herdr,
        registryDirectory,
      );
      const id = randomUUID();
      const managedName = `drovr-${id.replaceAll("-", "").slice(0, 26)}`;
      agent = {
        schema: "drovr.agent/v1",
        id,
        task_id: context.task.id,
        key: options.key,
        label: options.label ?? options.key,
        status: "active",
        launch: specification,
        herdr: {
          name: managedName,
          pane_id: paneId,
        },
        native_session: null,
        created_at: now(),
      };
      await writeRecord(registryDirectory, "agents", agent);
      await adapter.startAgent(herdr, {
        name: managedName,
        paneId: agent.herdr.pane_id,
        label: agent.label,
        specification,
      });
      const observed = await waitForNewAgentReady(
        herdr,
        managedName,
        dependencies,
      );
      const nativeSession = observed?.agent_session?.value;
      if (nativeSession) {
        agent.native_session = nativeSession;
        await writeRecord(registryDirectory, "agents", agent);
      }
      return { group: context.group, task: context.task, agent };
    },
  );
}

export function agentStartCommandResult({ group, task, agent }) {
  return {
    schema: "drovr.command/v1",
    command: "agent start",
    ok: true,
    result: {
      status: "completed",
      group: {
        id: group.id,
        key: group.key,
        label: group.label,
      },
      task: {
        id: task.id,
        group_id: task.group_id,
        key: task.key,
        label: task.label,
        cwd: task.cwd,
      },
      agent: {
        id: agent.id,
        task_id: agent.task_id,
        key: agent.key,
        label: agent.label,
        harness: agent.launch.harness,
        role: agent.launch.role,
        model: agent.launch.model,
        effort: agent.launch.effort,
        capability: agent.launch.capability,
        native: agent.launch.native,
        native_session: agent.native_session,
      },
    },
  };
}
