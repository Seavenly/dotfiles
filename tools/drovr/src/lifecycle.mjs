import { DrovrError } from "./errors.mjs";
import { HerdrClient } from "./herdr.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import { settleTurnRecord } from "./turn-record.mjs";

function client(session, env, dependencies) {
  return (
    dependencies.herdr ??
    new HerdrClient({ session, env, run: dependencies.run })
  );
}

async function lifecycleContext(registryDirectory, kind, id) {
  const groups = await readRecords(registryDirectory, "groups");
  const tasks = await readRecords(registryDirectory, "tasks");
  const agents = await readRecords(registryDirectory, "agents");
  if (kind === "agent") {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) invalidIdentifier(kind, id);
    const task = tasks.find((candidate) => candidate.id === agent.task_id);
    const group =
      task && groups.find((candidate) => candidate.id === task.group_id);
    if (!task || !group) corruptRelationship(kind, id);
    return { group, task, agent };
  }
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) invalidIdentifier(kind, id);
  const group = groups.find((candidate) => candidate.id === task.group_id);
  if (!group) corruptRelationship(kind, id);
  return {
    group,
    task,
    agents: agents.filter((candidate) => candidate.task_id === task.id),
  };
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
      const activeAgents = context.agents.filter(
        ({ status }) => status === "active",
      );
      const activeAgentIds = new Set(activeAgents.map(({ id }) => id));
      const turns = await readRecords(registryDirectory, "turns");
      const busyTurns = turns.filter(
        (turn) =>
          activeAgentIds.has(turn.agent_id) && turn.status === "working",
      );
      const blocks = await readRecords(registryDirectory, "blocks");
      const busyTurnIds = new Set(busyTurns.map(({ id }) => id));
      const hasOpenBlock = blocks.some(
        (block) =>
          busyTurnIds.has(block.turn_id) &&
          ["open", "acknowledged"].includes(block.status),
      );
      if (busyTurns.length || hasOpenBlock) {
        return { ...context, status: "task_busy" };
      }
      const herdr = client(sessionFor(context.group), env, dependencies);
      await herdr.ensureSession();
      const restoredTabIds = new Set();
      for (const agent of activeAgents) {
        const observed = await herdr.agentRecord(agent.herdr.name);
        if (!observed) return { ...context, status: "agent_lost", agent };
        if (!nativeIdentityMatches(agent, observed)) {
          return { ...context, status: "recovery_blocked", agent };
        }
        if (["working", "blocked"].includes(observed.agent_status)) {
          return { ...context, status: "task_busy", agent };
        }
        if (!["idle", "done"].includes(observed.agent_status)) {
          return { ...context, status: "uncertain", agent };
        }
        const paneId = observed.pane_id ?? agent.herdr.pane_id;
        const pane = await herdr.paneRecord(paneId);
        if (!pane?.tab_id) {
          return { ...context, status: "agent_lost", agent };
        }
        restoredTabIds.add(pane.tab_id);
        agent.herdr.pane_id = paneId;
      }
      if (restoredTabIds.size > 1) {
        return { ...context, status: "recovery_blocked" };
      }
      const tabId = [...restoredTabIds][0] ?? context.task.herdr.tab_id;
      if (tabId !== context.task.herdr.tab_id) {
        context.task.herdr.tab_id = tabId;
        await writeRecord(registryDirectory, "tasks", context.task);
      }
      const registeredTab = await herdr.tabRecord(tabId);
      if (
        registeredTab?.workspace_id &&
        context.group.herdr.workspace_id &&
        registeredTab.workspace_id !== context.group.herdr.workspace_id
      ) {
        return { ...context, status: "recovery_blocked" };
      }
      if (activeAgents.length || registeredTab) await herdr.closeTab(tabId);
      if (await herdr.tabRecord(tabId)) {
        return { ...context, status: "uncertain" };
      }
      for (const agent of activeAgents) {
        agent.status = "retired";
        agent.retired_at = now();
        await writeRecord(registryDirectory, "agents", agent);
      }
      context.task.status = "closed";
      context.task.closed_at = now();
      await writeRecord(registryDirectory, "tasks", context.task);
      return { ...context, status: "closed" };
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
      task: {
        id: context.task.id,
        key: context.task.key,
        label: context.task.label,
        cwd: context.task.cwd,
      },
      ...(context.agent
        ? {
            agent: {
              id: context.agent.id,
              key: context.agent.key,
              label: context.agent.label,
            },
          }
        : {}),
    },
  };
}
