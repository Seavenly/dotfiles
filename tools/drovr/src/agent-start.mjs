import { randomUUID } from "node:crypto";

import { loadConfiguration, resolveLaunchSpecification } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { createAgentLaunchBinding } from "./description.mjs";
import {
  createSemanticHarness,
} from "./harness-interface.mjs";
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

const STARTUP_TIMEOUT_MS = 120_000;

async function waitForAgentReady(harness, agent, dependencies) {
  const observed = await harness.waitForAgent(agent, {
    timeoutMs: dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
  });
  if (
    observed.outcome !== "observed" ||
    observed.evidence !== "present" ||
    !["idle", "done"].includes(observed.state)
  ) {
    throw new DrovrError(
      `managed agent ${agent.herdr.name} did not stabilize while starting`,
      { code: 4, outcome: "adapter_failure", details: { observed } },
    );
  }
  return observed;
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

async function paneForNewAgent(context, harness, registryDirectory) {
  const activeAgents = context.agents.filter(
    (candidate) => candidate.status === "active",
  );
  if (activeAgents.length === 0) {
    const rootPane = await harness.topology.observePane(
      context.task.herdr.root_pane_id,
    );
    if (rootPane) {
      if (
        !rootPane.tabId ||
        rootPane.tabId !== context.task.herdr.tab_id
      ) {
        throw new DrovrError(
          `task ${context.task.id} root pane moved to an unregistered tab`,
          { code: 0, outcome: "recovery_blocked" },
        );
      }
      return context.task.herdr.root_pane_id;
    }
    if (await harness.topology.observeTab(context.task.herdr.tab_id)) {
      throw new DrovrError(
        `task ${context.task.id} has an unowned surviving Herdr tab`,
        { code: 0, outcome: "recovery_blocked" },
      );
    }
    let tab;
    if (
      await harness.topology.observeWorkspace(context.group.herdr.workspace_id)
    ) {
      tab = await harness.topology.createTaskTab({
        workspaceId: context.group.herdr.workspace_id,
        cwd: context.task.cwd,
        label: context.task.label,
      });
    } else {
      const workspace = await harness.topology.createWorkspace({
        cwd: context.task.cwd,
        label: context.group.label,
      });
      context.group.herdr.workspace_id = workspace.workspaceId;
      await writeRecord(registryDirectory, "groups", context.group);
      tab = {
        tabId: workspace.tabId,
        rootPaneId: workspace.rootPaneId,
      };
      await harness.topology.renameTask(tab.tabId, context.task.label);
    }
    context.task.herdr = {
      tab_id: tab.tabId,
      root_pane_id: tab.rootPaneId,
    };
    await writeRecord(registryDirectory, "tasks", context.task);
    return tab.rootPaneId;
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
  const layout = await harness.topology.observeLayout(
    activeAgents[0].herdr.pane_id,
  );
  const candidates = layout.panes.filter(({ paneId }) =>
    registeredPaneIds.has(paneId),
  );
  if (candidates.length !== activeAgents.length) {
    throw new DrovrError(
      `task ${context.task.id} has registered panes outside its Herdr layout`,
      { code: 0, outcome: "recovery_blocked" },
    );
  }
  const target = candidates.reduce((largest, candidate) => {
    const largestArea =
      largest.geometry.width * largest.geometry.height;
    const candidateArea =
      candidate.geometry.width * candidate.geometry.height;
    return candidateArea > largestArea ? candidate : largest;
  });
  const direction =
    target.geometry.width >= target.geometry.height * 2 ? "right" : "down";
  return harness.topology.splitTaskPane({
    paneId: target.paneId,
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
  const launchBinding = createAgentLaunchBinding(configuration, specification);
  const harness = createSemanticHarness({
    ...dependencies,
    env,
    session: initial.group.herdr.session,
    harness: specification.harness,
  });
  await harness.validateLaunch({ specification });
  await harness.ensureRuntime();

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
            harness,
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
          observed = await harness.observeAgent(agent);
          if (observed.evidence === "absent") {
            observed = await harness.startAgent({
              agent,
              registryDirectory,
            });
          } else {
            observed = await waitForAgentReady(harness, agent, dependencies);
          }
        }
        if (
          observed.identity?.pane &&
          observed.identity.pane !== agent.herdr.pane_id
        ) {
          agent.herdr.pane_id = observed.identity.pane;
          await writeRecord(registryDirectory, "agents", agent);
        }
        const nativeSession = observed?.identity?.native_session;
        if (nativeSession && agent.native_session !== nativeSession) {
          agent.native_session = nativeSession;
          await writeRecord(registryDirectory, "agents", agent);
        }
        if (options.label && options.label !== agent.label) {
          await harness.topology.renameAgentPane(
            agent.herdr.pane_id,
            options.label,
          );
          agent.label = options.label;
          await writeRecord(registryDirectory, "agents", agent);
        }
        return { group: context.group, task: context.task, agent };
      }

      const paneId = await paneForNewAgent(
        context,
        harness,
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
        launch_binding: launchBinding,
        herdr: {
          name: managedName,
          pane_id: paneId,
        },
        native_session: null,
        created_at: now(),
      };
      await writeRecord(registryDirectory, "agents", agent);
      const observed = await harness.startAgent({
        agent,
        registryDirectory,
      });
      const nativeSession = observed?.identity?.native_session;
      if (
        observed.identity?.pane &&
        observed.identity.pane !== agent.herdr.pane_id
      ) {
        agent.herdr.pane_id = observed.identity.pane;
        await writeRecord(registryDirectory, "agents", agent);
      }
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
