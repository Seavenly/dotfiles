import { DrovrError } from "./errors.mjs";
import { resolveBlockRecord } from "./block-record.mjs";
import { HerdrClient } from "./herdr.mjs";
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

function client(session, env, dependencies) {
  return (
    dependencies.herdr ??
    new HerdrClient({ session, env, run: dependencies.run })
  );
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

function sessionFor(group) {
  if (!group.herdr?.session) corruptRelationship("group", group.id);
  return group.herdr.session;
}

function nativeIdentityMatches(agent, observed) {
  return (
    Boolean(agent.native_session) &&
    observed?.agent_session?.value === agent.native_session
  );
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
  herdr,
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
      const observations = new Map();
      for (const agent of agents) {
        const observed = await herdr.agentRecord(agent.herdr.name);
        observations.set(agent.id, observed);
        if (!nativeIdentityMatches(agent, observed)) {
          outcomes.set(agent.id, {
            status: "uncertain",
            error: "native session identity changed during force cleanup",
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
        if (["working", "blocked"].includes(observed?.agent_status)) {
          try {
            if (!workingByAgent.get(agent.id)?.cancellation_requested_at) {
              await herdr.interruptAgent(agent.herdr.name);
            }
            const settled = await herdr.waitForAgent(
              agent.herdr.name,
              timeoutMs ?? 120_000,
            );
            if (
              ["idle", "done"].includes(settled?.agent_status) &&
              settled.agent_session?.value === agent.native_session
            ) {
              outcomes.set(agent.id, { status: "interrupted" });
            } else {
              outcomes.set(agent.id, {
                status: "uncertain",
                error: "native interruption settlement could not be confirmed",
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
  herdr,
  force,
}) {
  const activeAgents = agents.filter(({ status }) => status === "active");
  const workingTurns = workingTurnsFor(activeAgents, turns);
  if (!force && workingTurns.length) {
    return { failure: { task, status: "task_busy" } };
  }

  const tabIds = new Set();
  for (const agent of activeAgents) {
    const observed = await herdr.agentRecord(agent.herdr.name);
    if (!observed) {
      return { failure: { task, agent, status: "agent_lost" } };
    }
    if (!nativeIdentityMatches(agent, observed)) {
      return { failure: { task, agent, status: "recovery_blocked" } };
    }
    if (!force && ["working", "blocked"].includes(observed.agent_status)) {
      return { failure: { task, agent, status: "task_busy" } };
    }
    if (
      !["idle", "done", "working", "blocked"].includes(
        observed.agent_status,
      )
    ) {
      return { failure: { task, agent, status: "uncertain" } };
    }
    const paneId = observed.pane_id ?? agent.herdr.pane_id;
    const pane = await herdr.paneRecord(paneId);
    if (!pane?.tab_id) {
      return { failure: { task, agent, status: "agent_lost" } };
    }
    tabIds.add(pane.tab_id);
    agent.herdr.pane_id = paneId;
  }
  if (tabIds.size > 1) {
    return { failure: { task, status: "recovery_blocked" } };
  }
  const tabId = [...tabIds][0] ?? task.herdr.tab_id;
  if (tabId !== task.herdr.tab_id) {
    const originalTab = await herdr.tabRecord(task.herdr.tab_id);
    if (originalTab) {
      return { failure: { task, status: "recovery_blocked" } };
    }
  }
  const registeredTab = await herdr.tabRecord(tabId);
  if (activeAgents.length && !registeredTab) {
    return { failure: { task, status: "agent_lost" } };
  }
  if (
    registeredTab?.workspace_id &&
    group.herdr.workspace_id &&
    registeredTab.workspace_id !== group.herdr.workspace_id
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
  herdr,
  now,
}) {
  if (plan.agents.length || plan.registered) {
    await herdr.closeTab(plan.tabId);
  }
  if (await herdr.tabRecord(plan.tabId)) return false;
  for (const agent of plan.agents) {
    agent.status = "retired";
    agent.retired_at = now();
    await writeRecord(registryDirectory, "agents", agent);
  }
  plan.task.status = "closed";
  plan.task.closed_at = now();
  plan.task.herdr.tab_id = plan.tabId;
  await writeRecord(registryDirectory, "tasks", plan.task);
  return true;
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

          const herdr = client(sessionFor(context.group), env, dependencies);
          await herdr.ensureSession();
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
              herdr,
              force,
            });
            if (preflight.failure) {
              return { ...context, ...preflight.failure };
            }
            plans.push(preflight.plan);
          }

          const interruption = force
            ? await forceInterruptActiveTurns({
                registryDirectory,
                agents: context.agents.filter(
                  ({ status }) => status === "active",
                ),
                turns: context.turns,
                herdr,
                now,
                timeoutMs: dependencies.interruptTimeoutMs,
              })
            : { turns: [] };
          if (interruption.failure) {
            return { ...context, ...interruption.failure };
          }

          for (const plan of plans) {
            if (
              !(await executeTaskCleanup({
                registryDirectory,
                plan,
                herdr,
                now,
              }))
            ) {
              return { ...context, task: plan.task, status: "uncertain" };
            }
          }
          const workspaceId = context.group.herdr.workspace_id;
          if (workspaceId) await herdr.closeWorkspace(workspaceId);
          if (workspaceId && (await herdr.workspaceRecord(workspaceId))) {
            return { ...context, status: "uncertain" };
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
      const herdr = client(sessionFor(context.group), env, dependencies);
      await herdr.ensureSession();
      const observed = await herdr.agentRecord(context.agent.herdr.name);
      if (observed && !nativeIdentityMatches(context.agent, observed)) {
        return { ...context, status: "recovery_blocked" };
      }
      if (observed) {
        const paneId = observed.pane_id ?? context.agent.herdr.pane_id;
        const pane = await herdr.paneRecord(paneId);
        if (pane?.tab_id && pane.tab_id !== context.task.herdr.tab_id) {
          context.task.herdr.tab_id = pane.tab_id;
          await writeRecord(registryDirectory, "tasks", context.task);
        }
        context.agent.herdr.pane_id = paneId;
        await herdr.closePane(paneId);
        if (await herdr.paneRecord(paneId)) {
          return { ...context, status: "uncertain" };
        }
      } else if (await herdr.paneRecord(context.agent.herdr.pane_id)) {
        return { ...context, status: "agent_lost" };
      }
      const turns = await readRecords(registryDirectory, "turns");
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
      const turns = await readRecords(registryDirectory, "turns");
      if (!force && workingTurnsFor(context.agents, turns).length) {
        return { ...context, status: "task_busy" };
      }
      const herdr = client(sessionFor(context.group), env, dependencies);
      await herdr.ensureSession();
      const preflight = await preflightTaskCleanup({
        task: context.task,
        agents: context.agents,
        turns,
        group: context.group,
        herdr,
        force,
      });
      if (preflight.failure) {
        return { ...context, ...preflight.failure };
      }
      const { plan } = preflight;
      const interruption = force
        ? await forceInterruptActiveTurns({
            registryDirectory,
            agents: plan.agents,
            turns: plan.workingTurns,
            herdr,
            now,
            timeoutMs: dependencies.interruptTimeoutMs,
          })
        : { turns: [] };
      if (interruption.failure) {
        return { ...context, ...interruption.failure };
      }
      if (
        !(await executeTaskCleanup({
          registryDirectory,
          plan,
          herdr,
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
