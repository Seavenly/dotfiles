import { DrovrError } from "./errors.mjs";
import { resolveBlockRecord } from "./block-record.mjs";
import { semanticHarnessFor } from "./harness-interface.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import {
  agentRelationship,
  groupRelationship,
  loadRegistryRelationships,
  taskRelationship,
} from "./registry-relationships.mjs";
import { settleTurnRecord } from "./turn-record.mjs";

function client(context, env, dependencies) {
  return semanticHarnessFor(context, { ...dependencies, env });
}

async function lifecycleContext(registryDirectory, kind, id) {
  const registry = await loadRegistryRelationships(registryDirectory);
  const context =
    kind === "agent"
      ? agentRelationship(registry, id)
      : taskRelationship(registry, id);
  if (!context) invalidIdentifier(kind, id);
  return context;
}

function invalidIdentifier(kind, id) {
  throw new DrovrError(`${kind} not found: ${id}`, {
    code: 2,
    outcome: "invalid_arguments",
  });
}

function corruptRelationship(kind, id) {
  throw new DrovrError(`registry ${kind} ${id} has a missing owner`, {
    code: 5,
    outcome: "corrupt_registry",
  });
}

function isUnboundAgent(agent) {
  return !agent.native_session;
}

async function classifyManagedAgent({ agent, harness, observation }) {
  if (["changed", "uncertain"].includes(observation.evidence)) {
    return {
      failure: {
        agent,
        status: observation.evidence === "changed"
          ? "recovery_blocked"
          : "uncertain",
      },
    };
  }
  const observed = observation.evidence === "present" ? observation : null;
  const paneId = observation.identity?.pane ?? agent.herdr.pane_id;
  const pane = await harness.topology.observePane(paneId);
  if (!observed && pane && !isUnboundAgent(agent)) {
    return { failure: { agent, status: "agent_lost" } };
  }
  if (observed && !pane?.tabId && !isUnboundAgent(agent)) {
    return { failure: { agent, status: "agent_lost" } };
  }
  return { observed, pane, paneId, observation };
}

async function groupLifecycleContext(registryDirectory, groupId) {
  const registry = await loadRegistryRelationships(registryDirectory);
  const context = groupRelationship(registry, groupId);
  if (!context) invalidIdentifier("group", groupId);
  return context;
}

function withTaskLifecycleLocks(
  registryDirectory,
  taskIds,
  operation,
) {
  return withOrderedResourceLocks(
    registryDirectory,
    taskIds.map(taskLifecycleLockKey),
    operation,
  );
}

function withOrderedResourceLocks(
  registryDirectory,
  keys,
  operation,
  index = 0,
) {
  if (index === keys.length) return operation();
  return withResourceLock(
    registryDirectory,
    keys[index],
    () =>
      withOrderedResourceLocks(
        registryDirectory,
        keys,
        operation,
        index + 1,
      ),
  );
}

function durableBusyTask(context) {
  const busyTurn = workingTurnsFor(context.agents, context.turns)[0];
  return context.tasks.find(({ id }) => id === busyTurn?.task_id);
}

function workingTurnsFor(agents, turns) {
  const activeAgentIds = new Set(
    agents
      .filter(({ status }) => status === "active")
      .map(({ id }) => id),
  );
  return turns.filter(
    (turn) => activeAgentIds.has(turn.agent_id) && turn.status === "working",
  );
}

async function forceInterruptActiveTurns({
  registryDirectory,
  agents,
  turns,
  harness,
  now,
  timeoutMs,
}) {
  const turnIds = turns
    .filter(({ status }) => status === "working")
    .map(({ id }) => id)
    .sort();
  return withOrderedResourceLocks(
    registryDirectory,
    turnIds.map((turnId) => `turn:${turnId}`),
    async () => {
      const currentTurns = await readRecords(registryDirectory, "turns");
      const workingTurns = currentTurns.filter(
        (turn) => turnIds.includes(turn.id) && turn.status === "working",
      );
      const blocks = await readRecords(registryDirectory, "blocks");
      for (const turn of workingTurns) {
        turn.cleanup_requested_at ??= now();
        await writeRecord(registryDirectory, "turns", turn);
      }
      const workingByAgent = new Map(
        workingTurns.map((turn) => [turn.agent_id, turn]),
      );
      const outcomes = new Map();
      const observations = new Map(
        (await harness.observeAgents(agents)).map((observation, index) => [
          agents[index].id,
          observation,
        ]),
      );
      for (const agent of agents) {
        const observed = observations.get(agent.id);
        if (["changed", "uncertain"].includes(observed.evidence)) {
          outcomes.set(agent.id, {
            status: "uncertain",
            error:
              observed.evidence === "changed"
                ? "native session identity changed during force cleanup"
                : "managed agent identity could not be confirmed during force cleanup",
          });
        }
      }
      const identityFailure = agents.find((agent) => outcomes.has(agent.id));
      if (identityFailure) {
        for (const agent of agents) {
          outcomes.set(
            agent.id,
            outcomes.get(agent.id) ?? {
              status: "uncertain",
              error:
                "force cleanup stopped after native identity validation failed",
            },
          );
        }
      }

      for (const agent of identityFailure ? [] : agents) {
        const observed = observations.get(agent.id);
        if (["working", "blocked"].includes(observed?.state)) {
          try {
            const interruption = await harness.interruptTurn({
              agent,
              timeoutMs: timeoutMs ?? 120_000,
              timeoutOutcome: "uncertain",
              skipIfAlreadyRequested: Boolean(
                workingByAgent.get(agent.id)?.cancellation_requested_at,
              ),
            });
            if (["cancelled", "interrupted"].includes(interruption.outcome)) {
              outcomes.set(agent.id, { status: "interrupted" });
            } else {
              outcomes.set(agent.id, {
                status: "uncertain",
                error: interruption.error ??
                  "native interruption settlement could not be confirmed",
              });
            }
          } catch (error) {
            outcomes.set(agent.id, {
              status: "uncertain",
              error: `native interruption failed: ${error.message}`,
            });
          }
        } else if (workingByAgent.has(agent.id)) {
          outcomes.set(agent.id, {
            status: "uncertain",
            error:
              "force cleanup found durable work after the native agent had settled",
          });
        }
      }

      for (const turn of workingTurns) {
        const outcome = outcomes.get(turn.agent_id) ?? {
          status: "uncertain",
          error: "force cleanup could not identify the native agent state",
        };
        settleTurnRecord(turn, {
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
          settledAt: now(),
        });
        await writeRecord(registryDirectory, "turns", turn);
        for (const block of blocks.filter(
          (candidate) =>
            candidate.turn_id === turn.id &&
            ["open", "acknowledged"].includes(candidate.status),
        )) {
          resolveBlockRecord(block, { resolvedAt: now() });
          block.resolution = "force_cleanup";
          await writeRecord(registryDirectory, "blocks", block);
        }
      }
      return {
        turns: workingTurns,
        ...(identityFailure
          ? { failure: { agent: identityFailure, status: "recovery_blocked" } }
          : {}),
      };
    },
  );
}

async function preflightTaskCleanup({
  task,
  agents,
  turns,
  group,
  harness,
  observations,
  force,
}) {
  const activeAgents = agents.filter(({ status }) => status === "active");
  const workingTurns = workingTurnsFor(activeAgents, turns);
  if (!force && workingTurns.length) {
    return { failure: { task, status: "task_busy" } };
  }

  const tabIds = new Set();
  let observedBoundAgent = false;
  for (const agent of activeAgents) {
    const classification = await classifyManagedAgent({
      agent,
      harness,
      observation: observations.get(agent.id),
    });
    if (classification.failure) {
      return { failure: { task, ...classification.failure } };
    }
    const { observed, pane, paneId } = classification;
    const unbound = isUnboundAgent(agent);
    observedBoundAgent ||= Boolean(observed && !unbound);
    if (
      !force &&
      ["working", "blocked"].includes(observed?.state)
    ) {
      return { failure: { task, agent, status: "task_busy" } };
    }
    if (
      observed &&
      !["idle", "done", "working", "blocked"].includes(
        observed.state,
      )
    ) {
      return { failure: { task, agent, status: "uncertain" } };
    }
    if (!pane?.tabId) {
      continue;
    }
    tabIds.add(pane.tabId);
    agent.herdr.pane_id = paneId;
  }
  if (tabIds.size > 1) {
    return { failure: { task, status: "recovery_blocked" } };
  }
  const tabId = [...tabIds][0] ?? task.herdr.tab_id;
  if (tabId !== task.herdr.tab_id) {
    const originalTab = await harness.topology.observeTab(task.herdr.tab_id);
    if (originalTab) {
      return { failure: { task, status: "recovery_blocked" } };
    }
  }
  const registeredTab = await harness.topology.observeTab(tabId);
  if (observedBoundAgent && !registeredTab) {
    return { failure: { task, status: "agent_lost" } };
  }
  if (
    registeredTab?.workspaceId &&
    group.herdr.workspace_id &&
    registeredTab.workspaceId !== group.herdr.workspace_id
  ) {
    return { failure: { task, status: "recovery_blocked" } };
  }
  return {
    plan: {
      task,
      agents: activeAgents,
      workingTurns,
      tabId,
      registered: Boolean(registeredTab),
    },
  };
}

async function executeTaskCleanup({
  registryDirectory,
  plan,
  harness,
  now,
}) {
  if (plan.registered) {
    await harness.topology.closeTaskTab(plan.tabId);
  }
  if (await harness.topology.observeTab(plan.tabId)) return false;
  await finalizeTaskCleanup({ registryDirectory, plan, now });
  return true;
}

async function finalizeTaskCleanup({ registryDirectory, plan, now }) {
  for (const agent of plan.agents) {
    agent.status = "retired";
    agent.retired_at = now();
    await writeRecord(registryDirectory, "agents", agent);
  }
  plan.task.status = "closed";
  plan.task.closed_at = now();
  plan.task.herdr.tab_id = plan.tabId;
  await writeRecord(registryDirectory, "tasks", plan.task);
}

async function preflightIdleTab({ group, task, harness }) {
  const workspaceId = group.herdr.workspace_id;
  if (!workspaceId || !(await harness.topology.observeWorkspace(workspaceId))) {
    return { failure: { status: "recovery_blocked" } };
  }
  const idleTab = group.herdr.idle_tab;
  if (!idleTab) return { plan: { create: true } };
  if (idleTab.tab_id === task.herdr.tab_id) {
    return { failure: { status: "recovery_blocked" } };
  }
  const [tab, pane] = await Promise.all([
    harness.topology.observeTab(idleTab.tab_id),
    harness.topology.observePane(idleTab.root_pane_id),
  ]);
  if (
    tab?.workspaceId !== workspaceId ||
    pane?.tabId !== idleTab.tab_id
  ) {
    return { failure: { status: "recovery_blocked" } };
  }
  return { plan: { create: false } };
}

async function ensureIdleTab({ registryDirectory, group, task, harness }) {
  if (group.herdr.idle_tab) return true;
  const created = await harness.topology.createTaskTab({
    workspaceId: group.herdr.workspace_id,
    cwd: task.cwd,
    label: `${group.label} idle`,
  });
  group.herdr.idle_tab = {
    tab_id: created.tabId,
    root_pane_id: created.rootPaneId,
  };
  await writeRecord(registryDirectory, "groups", group);
  const [tab, pane] = await Promise.all([
    harness.topology.observeTab(created.tabId),
    harness.topology.observePane(created.rootPaneId),
  ]);
  return (
    tab?.workspaceId === group.herdr.workspace_id &&
    pane?.tabId === created.tabId
  );
}

export async function closeGroup(groupId, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const force = dependencies.force ?? false;
  const registryDirectory = stateDirectory(env);
  const initial = await groupLifecycleContext(registryDirectory, groupId);
  return withResourceLock(
    registryDirectory,
    `group-key:${initial.group.key}`,
    async () => {
      const lockedContext = await groupLifecycleContext(
        registryDirectory,
        groupId,
      );
      return withTaskLifecycleLocks(
        registryDirectory,
        lockedContext.tasks.map(({ id }) => id).sort(),
        async () => {
          const context = await groupLifecycleContext(
            registryDirectory,
            groupId,
          );
          if (context.group.status !== "active") {
            return { ...context, status: "closed" };
          }
          const busyTask = durableBusyTask(context);
          if (!force && busyTask) {
            return { ...context, task: busyTask, status: "task_busy" };
          }

          const harness = client(context, env, dependencies);
          await harness.ensureRuntime();
          const activeAgents = context.agents.filter(
            ({ status }) => status === "active",
          );
          const observedAgents = new Map(
            (await harness.observeAgents(activeAgents)).map(
              (observation, index) => [activeAgents[index].id, observation],
            ),
          );
          const plans = [];
          for (const task of context.tasks.filter(
            ({ status }) => status === "active",
          )) {
            const agents = context.agents.filter(
              (agent) => agent.task_id === task.id,
            );
            const preflight = await preflightTaskCleanup({
              task,
              agents,
              turns: context.turns,
              group: context.group,
              harness,
              observations: new Map(
                agents.map((agent) => [agent.id, observedAgents.get(agent.id)]),
              ),
              force,
            });
            if (preflight.failure) {
              return { ...context, ...preflight.failure };
            }
            plans.push(preflight.plan);
          }

          const workspaceId = context.group.herdr.workspace_id;
          if (!workspaceId) corruptRelationship("group", context.group.id);
          const registeredWorkspace = await harness.topology.observeWorkspace(
            workspaceId,
          );
          if (
            !registeredWorkspace &&
            plans.some(({ registered }) => registered)
          ) {
            return { ...context, status: "recovery_blocked" };
          }

          const interruption = force
            ? await forceInterruptActiveTurns({
                registryDirectory,
                agents: activeAgents,
                turns: context.turns,
                harness,
                now,
                timeoutMs: dependencies.interruptTimeoutMs,
              })
            : { turns: [] };
          if (interruption.failure) {
            return { ...context, ...interruption.failure };
          }

          if (registeredWorkspace) {
            await harness.topology.closeGroupWorkspace(workspaceId);
          }
          if (await harness.topology.observeWorkspace(workspaceId)) {
            return { ...context, status: "uncertain" };
          }
          for (const plan of plans) {
            if (await harness.topology.observeTab(plan.tabId)) {
              return { ...context, task: plan.task, status: "uncertain" };
            }
          }
          for (const plan of plans) {
            await finalizeTaskCleanup({ registryDirectory, plan, now });
          }
          context.group.status = "closed";
          context.group.closed_at = now();
          await writeRecord(registryDirectory, "groups", context.group);
          return {
            ...context,
            status: "closed",
            ...(force ? { turn_outcomes: interruption.turns } : {}),
          };
        },
      );
    },
  );
}

export async function retireAgent(agentId, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await lifecycleContext(registryDirectory, "agent", agentId);
  return withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(initial.task.id),
    async () => {
      const context = await lifecycleContext(registryDirectory, "agent", agentId);
      if (context.agent.status !== "active") {
        return { ...context, status: "retired" };
      }
      const harness = client(context, env, dependencies);
      await harness.ensureRuntime();
      const [observation] = await harness.observeAgents([context.agent]);
      const classification = await classifyManagedAgent({
        agent: context.agent,
        harness,
        observation,
      });
      if (classification.failure) {
        return { ...context, status: classification.failure.status };
      }
      const { observed, pane, paneId } = classification;
      const turns = await readRecords(registryDirectory, "turns");
      if (observed) {
        if (pane?.tabId && pane.tabId !== context.task.herdr.tab_id) {
          context.task.herdr.tab_id = pane.tabId;
          await writeRecord(registryDirectory, "tasks", context.task);
        }
        context.agent.herdr.pane_id = paneId;
        await harness.topology.closePane(paneId);
        if (await harness.topology.observePane(paneId)) {
          return { ...context, status: "uncertain" };
        }
      } else if (pane) {
        await harness.topology.closePane(paneId);
        if (await harness.topology.observePane(paneId)) {
          return { ...context, status: "uncertain" };
        }
      }
      for (const turn of turns.filter(
        (candidate) =>
          candidate.agent_id === context.agent.id &&
          candidate.status === "working",
      )) {
        settleTurnRecord(turn, { status: "interrupted", settledAt: now() });
        await writeRecord(registryDirectory, "turns", turn);
      }
      context.agent.status = "retired";
      context.agent.retired_at = now();
      await writeRecord(registryDirectory, "agents", context.agent);
      return { ...context, status: "retired" };
    },
  );
}

export async function closeTask(taskId, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const force = dependencies.force ?? false;
  const registryDirectory = stateDirectory(env);
  const initial = await lifecycleContext(registryDirectory, "task", taskId);
  return withResourceLock(
    registryDirectory,
    `group-key:${initial.group.key}`,
    () =>
      withResourceLock(
        registryDirectory,
        taskLifecycleLockKey(taskId),
        async () => {
          const context = await lifecycleContext(
            registryDirectory,
            "task",
            taskId,
          );
          if (context.task.status !== "active") {
            return { ...context, status: "task_closed" };
          }
          const [turns, tasks] = await Promise.all([
            readRecords(registryDirectory, "turns"),
            readRecords(registryDirectory, "tasks"),
          ]);
          if (!force && workingTurnsFor(context.agents, turns).length) {
            return { ...context, status: "task_busy" };
          }
          const harness = client(context, env, dependencies);
          await harness.ensureRuntime();
          const activeAgents = context.agents.filter(
            ({ status }) => status === "active",
          );
          const observedAgents = new Map(
            (await harness.observeAgents(activeAgents)).map(
              (observation, index) => [activeAgents[index].id, observation],
            ),
          );
          const preflight = await preflightTaskCleanup({
            task: context.task,
            agents: context.agents,
            turns,
            group: context.group,
            harness,
            observations: new Map(
              context.agents.map((agent) => [
                agent.id,
                observedAgents.get(agent.id),
              ]),
            ),
            force,
          });
          if (preflight.failure) {
            return { ...context, ...preflight.failure };
          }
          const finalActiveTask = !tasks.some(
            (candidate) =>
              candidate.group_id === context.group.id &&
              candidate.id !== context.task.id &&
              candidate.status === "active",
          );
          const idlePreflight = finalActiveTask
            ? await preflightIdleTab({
                group: context.group,
                task: context.task,
                harness,
              })
            : null;
          if (idlePreflight?.failure) {
            return { ...context, ...idlePreflight.failure };
          }
          const { plan } = preflight;
          const interruption = force
            ? await forceInterruptActiveTurns({
                registryDirectory,
                agents: plan.agents,
                turns: plan.workingTurns,
                harness,
                now,
                timeoutMs: dependencies.interruptTimeoutMs,
              })
            : { turns: [] };
          if (interruption.failure) {
            return { ...context, ...interruption.failure };
          }
          if (
            finalActiveTask &&
            idlePreflight.plan.create &&
            !(await ensureIdleTab({
              registryDirectory,
              group: context.group,
              task: context.task,
              harness,
            }))
          ) {
            return { ...context, status: "uncertain" };
          }
          if (
            !(await executeTaskCleanup({
              registryDirectory,
              plan,
              harness,
              now,
            }))
          ) {
            return { ...context, status: "uncertain" };
          }
          return {
            ...context,
            status: "closed",
            ...(force ? { turn_outcomes: interruption.turns } : {}),
          };
        },
      ),
  );
}

export function lifecycleCommandResult(command, context) {
  return {
    schema: "drovr.command/v1",
    command,
    ok: true,
    result: {
      status: context.status,
      ...(context.group
        ? {
            group: {
              id: context.group.id,
              key: context.group.key,
              label: context.group.label,
            },
          }
        : {}),
      ...(context.task
        ? {
            task: {
              id: context.task.id,
              key: context.task.key,
              label: context.task.label,
              cwd: context.task.cwd,
            },
          }
        : {}),
      ...(context.agent
        ? {
            agent: {
              id: context.agent.id,
              key: context.agent.key,
              label: context.agent.label,
            },
          }
        : {}),
      ...(context.turn_outcomes
        ? {
            turns: context.turn_outcomes.map((turn) => ({
              id: turn.id,
              status: turn.status,
              ...(turn.error ? { error: turn.error } : {}),
            })),
          }
        : {}),
    },
  };
}
