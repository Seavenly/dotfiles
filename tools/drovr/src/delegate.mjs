import { randomUUID } from "node:crypto";
import { loadConfiguration, resolveLaunchSpecification } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { harnessAdapter } from "./harness-adapter.mjs";
import { HerdrClient } from "./herdr.mjs";
import { resolveTaskIdentity } from "./identity.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import { deliverTurn, prepareTurn } from "./turn-lifecycle.mjs";
import { turnCommandResult, waitForTurn } from "./turns.mjs";
import { reconcileOrRecoverAgent } from "./recovery.mjs";

function sameLaunchSpecification(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function waitForAgentRegistration(herdr, name) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const agent = await herdr.agentRecord(name);
    if (agent) return agent;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new DrovrError(`Herdr did not register managed agent ${name}`, {
    code: 4,
    outcome: "adapter_failure",
  });
}

async function waitForNewAgentReady(herdr, name) {
  let observed = await waitForAgentRegistration(herdr, name);
  if (observed.agent_status === "working") {
    observed = await herdr.waitForAgent(name, 120_000);
  }
  if (!observed || !["idle", "done"].includes(observed.agent_status)) {
    throw new DrovrError(
      `Herdr managed agent ${name} did not finish starting`,
      {
        code: 4,
        outcome: "adapter_failure",
      },
    );
  }
  return observed;
}

export async function delegate(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const configuration = await loadConfiguration({ env });
  const specification = resolveLaunchSpecification(configuration, options);
  const adapter = harnessAdapter(specification.harness, env);
  await adapter.validate(specification, { env, run: dependencies.run });
  const identity = await resolveTaskIdentity({
    cwd: options.cwd,
    groupKey: options.group,
    groupLabel: options.groupLabel,
    run: dependencies.run,
  });
  const registryDirectory = stateDirectory(env);
  const herdr =
    dependencies.herdr ??
    new HerdrClient({
      session: configuration.session,
      env,
      run: dependencies.run,
    });
  await herdr.ensureSession();

  const { group, task } = await withResourceLock(
    registryDirectory,
    `group-key:${identity.groupKey}`,
    async () => {
      const groups = await readRecords(registryDirectory, "groups");
      let group = groups.find(
        (candidate) =>
          candidate.key === identity.groupKey && candidate.status === "active",
      );
      let initialPaneId;
      let initialTabId;
      if (!group) {
        const workspace = await herdr.createWorkspace({
          cwd: identity.cwd,
          label: identity.groupLabel,
        });
        group = {
          schema: "drovr.group/v1",
          id: randomUUID(),
          key: identity.groupKey,
          label: identity.groupLabel,
          inferred: identity.inferred,
          status: "active",
          herdr: {
            session: configuration.session,
            workspace_id: workspace.workspaceId,
          },
          created_at: now(),
        };
        initialPaneId = workspace.paneId;
        initialTabId = workspace.tabId;
        await writeRecord(registryDirectory, "groups", group);
      }

      const tasks = await readRecords(registryDirectory, "tasks");
      let task = tasks.find(
        (candidate) =>
          candidate.group_id === group.id && candidate.key === options.taskKey,
      );
      if (task?.status === "closed") {
        throw new DrovrError(`task key ${options.taskKey} is closed`, {
          code: 0,
          outcome: "task_closed",
        });
      }
      if (task && task.cwd !== identity.cwd) {
        throw new DrovrError(
          `task key ${options.taskKey} is already active with a different cwd`,
          { code: 0, outcome: "configuration_conflict" },
        );
      }
      if (!task) {
        let paneId = initialPaneId;
        let tabId = initialTabId ?? null;
        if (!paneId) {
          const tab = await herdr.createTab({
            workspaceId: group.herdr.workspace_id,
            cwd: identity.cwd,
            label: options.taskLabel ?? options.taskKey,
          });
          paneId = tab.paneId;
          tabId = tab.tabId;
        }
        await herdr.renameTab(tabId, options.taskLabel ?? options.taskKey);
        task = {
          schema: "drovr.task/v1",
          id: randomUUID(),
          group_id: group.id,
          key: options.taskKey,
          label: options.taskLabel ?? options.taskKey,
          cwd: identity.cwd,
          status: "active",
          herdr: { tab_id: tabId, root_pane_id: paneId },
          created_at: now(),
        };
        await writeRecord(registryDirectory, "tasks", task);
      }
      return { group, task };
    },
  );

  const prepared = await withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(task.id),
    async () => {
      const currentTask = (
        await readRecords(registryDirectory, "tasks")
      ).find(({ id }) => id === task.id);
      if (currentTask?.status !== "active") {
        throw new DrovrError(`task ${task.id} is closed`, {
          code: 0,
          outcome: "task_closed",
        });
      }
      const existingAgent = (
        await readRecords(registryDirectory, "agents")
      ).find(
        (candidate) =>
          candidate.task_id === task.id &&
          candidate.key === options.agentKey &&
          candidate.status === "active",
      );
      if (existingAgent) {
        const availability = await reconcileOrRecoverAgent(existingAgent.id, {
          ...dependencies,
          env,
          herdr,
          now,
        });
        if (!["reconciled", "recovered"].includes(availability.status)) {
          throw new DrovrError(
            `agent ${existingAgent.id} cannot be recovered safely (${availability.reason})`,
            { code: 0, outcome: availability.status },
          );
        }
        if (
          !["idle", "done"].includes(availability.observed?.agent_status)
        ) {
          throw new DrovrError(
            `agent ${existingAgent.id} is not settled in Herdr`,
            { code: 0, outcome: "task_busy" },
          );
        }
      }
      const outcome = await withResourceLock(
        registryDirectory,
        `agent-key:${task.id}:${options.agentKey}`,
        async () => {
          const turns = await readRecords(registryDirectory, "turns");
          const agents = await readRecords(registryDirectory, "agents");
          let agent = agents.find(
            (candidate) =>
              candidate.task_id === task.id &&
              candidate.key === options.agentKey &&
              candidate.status === "active",
          );
          if (agent && !sameLaunchSpecification(agent.launch, specification)) {
            throw new DrovrError(
              `agent key ${options.agentKey} already has a different launch specification`,
              { code: 0, outcome: "configuration_conflict" },
            );
          }
          if (
            agent &&
            turns.some(
              (turn) =>
                turn.agent_id === agent.id && turn.status === "working",
            )
          ) {
            throw new DrovrError(
              `agent ${agent.id} already has an open logical turn`,
              { code: 0, outcome: "task_busy" },
            );
          }
          if (agent && !agent.native_session) {
            const observed = await waitForNewAgentReady(
              herdr,
              agent.herdr.name,
            );
            const nativeSession = observed?.agent_session?.value;
            if (nativeSession) {
              agent.native_session = nativeSession;
              await writeRecord(registryDirectory, "agents", agent);
            }
          }

          if (!agent) {
            const id = randomUUID();
            const managedName = `drovr-${id.replaceAll("-", "").slice(0, 26)}`;
            await adapter.startAgent(herdr, {
              name: managedName,
              paneId: task.herdr.root_pane_id,
              label: options.agentLabel ?? options.agentKey,
              specification,
            });
            agent = {
              schema: "drovr.agent/v1",
              id,
              task_id: task.id,
              key: options.agentKey,
              label: options.agentLabel ?? options.agentKey,
              status: "active",
              launch: specification,
              herdr: { name: managedName, pane_id: task.herdr.root_pane_id },
              native_session: null,
              created_at: now(),
            };
            await writeRecord(registryDirectory, "agents", agent);
            const observed = await waitForNewAgentReady(herdr, managedName);
            const nativeSession = observed?.agent_session?.value;
            if (nativeSession) {
              agent.native_session = nativeSession;
              await writeRecord(registryDirectory, "agents", agent);
            }
          }

          const turn = await prepareTurn({
            registryDirectory,
            agent,
            task,
            adapter,
            prompt: options.prompt,
            now,
            inventoryBeforeDelivery: adapter.inventoryBeforeDelivery,
          });
          return { agent, turn };
        },
      );
      await deliverTurn({
        registryDirectory,
        agent: outcome.agent,
        turn: outcome.turn,
        prompt: options.prompt,
        herdr,
        now,
      });
      return outcome;
    },
  );
  const settled = await waitForTurn(
    prepared.turn.id,
    { timeoutMs: options.timeoutMs },
    {
      ...dependencies,
      env,
      herdr,
      now,
    },
  );
  return turnCommandResult(
    "delegate",
    {
      group,
      task,
      agent: settled.agent,
      turn: settled.turn,
      block: settled.block,
    },
    { includeMessages: true, compact: true },
  );
}
