import { randomUUID } from "node:crypto";

import { DrovrError } from "./errors.mjs";
import { harnessAdapter } from "./harness-adapter.mjs";
import { HerdrClient } from "./herdr.mjs";
import {
  readRecords,
  stateDirectory,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import { appendTurnInput, settleTurnRecord } from "./turn-record.mjs";
import { deliverTurn, prepareTurn } from "./turn-lifecycle.mjs";

const TRANSCRIPT_SETTLE_GRACE_MS = 5000;

async function turnContext(registryDirectory, turnId) {
  const turns = await readRecords(registryDirectory, "turns");
  const turn = turns.find(({ id }) => id === turnId);
  if (!turn) invalidIdentifier("turn", turnId);
  const agents = await readRecords(registryDirectory, "agents");
  const agent = agents.find(({ id }) => id === turn.agent_id);
  if (!agent) corruptRelationship("agent", turn.agent_id, turn.id);
  const tasks = await readRecords(registryDirectory, "tasks");
  const task = tasks.find(({ id }) => id === turn.task_id);
  if (!task) corruptRelationship("task", turn.task_id, turn.id);
  const groups = await readRecords(registryDirectory, "groups");
  const group = groups.find(({ id }) => id === task.group_id);
  if (!group) corruptRelationship("group", task.group_id, turn.id);
  return { group, task, agent, turn };
}

async function agentContext(registryDirectory, agentId) {
  const agents = await readRecords(registryDirectory, "agents");
  const agent = agents.find(
    ({ id, status }) => id === agentId && status === "active",
  );
  if (!agent) invalidIdentifier("active agent", agentId);
  const tasks = await readRecords(registryDirectory, "tasks");
  const task = tasks.find(
    ({ id, status }) => id === agent.task_id && status === "active",
  );
  if (!task) corruptRelationship("active task", agent.task_id, agent.id);
  const groups = await readRecords(registryDirectory, "groups");
  const group = groups.find(
    ({ id, status }) => id === task.group_id && status === "active",
  );
  if (!group) corruptRelationship("active group", task.group_id, task.id);
  return { group, task, agent };
}

function invalidIdentifier(kind, id) {
  throw new DrovrError(`${kind} not found: ${id}`, {
    code: 2,
    outcome: "invalid_arguments",
  });
}

function corruptRelationship(kind, id, ownerId) {
  throw new DrovrError(
    `registry record ${ownerId} references missing ${kind} ${id}`,
    { code: 5, outcome: "corrupt_registry" },
  );
}

function owningSession(group) {
  const session = group.herdr?.session;
  if (typeof session !== "string" || session.length === 0) {
    throw new DrovrError(
      `registry group ${group.id} omits its owning Herdr session`,
      { code: 5, outcome: "corrupt_registry" },
    );
  }
  return session;
}

function client(session, env, dependencies) {
  return (
    dependencies.herdr ??
    new HerdrClient({
      session,
      env,
      run: dependencies.run,
    })
  );
}

export async function startTurn(agentId, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await agentContext(registryDirectory, agentId);
  const herdr = client(owningSession(initial.group), env, dependencies);
  await herdr.ensureSession();

  const context = await withResourceLock(
    registryDirectory,
    `agent-key:${initial.task.id}:${initial.agent.key}`,
    async () => {
      const current = await agentContext(registryDirectory, agentId);
      const turns = await readRecords(registryDirectory, "turns");
      if (
        turns.some(
          ({ agent_id: candidateAgentId, status }) =>
            candidateAgentId === agentId && status === "working",
        )
      ) {
        throw new DrovrError(
          `agent ${agentId} already has an open logical turn`,
          {
            code: 0,
            outcome: "task_busy",
          },
        );
      }
      const observed = await herdr.agentRecord(current.agent.herdr.name);
      if (!observed) {
        throw new DrovrError(
          `Herdr did not report managed agent ${current.agent.herdr.name}`,
          { code: 0, outcome: "uncertain" },
        );
      }
      if (!["idle", "done"].includes(observed.agent_status)) {
        throw new DrovrError(
          `agent ${agentId} is not settled in Herdr (${observed.agent_status ?? "unknown"})`,
          { code: 0, outcome: "task_busy" },
        );
      }
      const observedNativeSession = observed.agent_session?.value;
      if (
        !observedNativeSession ||
        (current.agent.native_session &&
          current.agent.native_session !== observedNativeSession)
      ) {
        throw new DrovrError(
          `Herdr did not confirm the expected native session for agent ${agentId}`,
          { code: 0, outcome: "uncertain" },
        );
      }
      if (!current.agent.native_session) {
        current.agent.native_session = observedNativeSession;
        await writeRecord(registryDirectory, "agents", current.agent);
      }

      const adapter = harnessAdapter(current.agent.launch.harness, env);
      const turn = await prepareTurn({
        registryDirectory,
        agent: current.agent,
        task: current.task,
        adapter,
        prompt: options.prompt,
        now,
      });
      return { ...current, turn };
    },
  );

  await deliverTurn({
    registryDirectory,
    agent: context.agent,
    turn: context.turn,
    prompt: options.prompt,
    herdr,
    now,
  });
  return context;
}

export async function waitForTurn(turnId, options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const clock = dependencies.clock ?? Date.now;
  const registryDirectory = stateDirectory(env);
  let context = await turnContext(registryDirectory, turnId);
  if (context.turn.status !== "working") return context;

  const herdr = client(owningSession(context.group), env, dependencies);
  const deadline =
    options.timeoutMs === undefined ? undefined : clock() + options.timeoutMs;
  let correlationDeadline;
  for (;;) {
    context = await turnContext(registryDirectory, turnId);
    if (context.turn.status !== "working") return context;
    const observedInputCount = context.turn.inputs.length;
    const remaining =
      deadline === undefined ? undefined : Math.max(0, deadline - clock());
    if (remaining === 0) {
      return { ...context, wait_status: "still_running" };
    }
    const observed = await herdr.waitForAgent(
      context.agent.herdr.name,
      remaining,
    );
    if (observed?.drovr_status === "still_running") {
      return { ...context, wait_status: "still_running" };
    }

    const reconciled = await withResourceLock(
      registryDirectory,
      `turn:${turnId}`,
      async () =>
        reconcileSettledObservation({
          registryDirectory,
          turnId,
          observed,
          observedInputCount,
          herdr,
          env,
          now,
          retryCorrelation:
            correlationDeadline === undefined || clock() < correlationDeadline,
        }),
    );
    if (!reconciled.retry_wait) return reconciled;
    if (reconciled.correlation_pending && correlationDeadline === undefined) {
      correlationDeadline = clock() + TRANSCRIPT_SETTLE_GRACE_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reconcileSettledObservation({
  registryDirectory,
  turnId,
  observed,
  observedInputCount,
  herdr,
  env,
  now,
  retryCorrelation,
}) {
  const context = await turnContext(registryDirectory, turnId);
  if (context.turn.status !== "working") return context;
  if (context.turn.inputs.length !== observedInputCount) {
    return { ...context, retry_wait: true };
  }
  const adapter = harnessAdapter(context.agent.launch.harness, env);
  const observedNativeSession = observed?.agent_session?.value;
  if (
    context.agent.native_session &&
    observedNativeSession &&
    context.agent.native_session !== observedNativeSession
  ) {
    return settleUncertain(
      registryDirectory,
      context,
      `Herdr reported a different ${adapter.label} native session identity`,
      now(),
    );
  }
  if (!context.agent.native_session) {
    if (!observedNativeSession) {
      if (retryCorrelation) {
        return { ...context, retry_wait: true, correlation_pending: true };
      }
      return settleUncertain(
        registryDirectory,
        context,
        `Herdr did not report the ${adapter.label} native session identity`,
        now(),
      );
    }
    context.agent.native_session = observedNativeSession;
    await writeRecord(registryDirectory, "agents", context.agent);
  }
  if (context.turn.transcript_cursor.transcript_root) {
    try {
      const transcriptPath = await adapter.locate(
        context.turn.transcript_cursor.transcript_root,
        context.agent.native_session,
      );
      context.turn.transcript_cursor = await adapter.resolveInventory(
        context.turn.transcript_cursor,
        transcriptPath,
        context.agent.native_session,
      );
      await writeRecord(registryDirectory, "turns", context.turn);
    } catch (error) {
      if (error.details?.correlation_pending && retryCorrelation) {
        return { ...context, retry_wait: true, correlation_pending: true };
      }
      settleTurnRecord(context.turn, {
        status: error.outcome ?? "uncertain",
        error: error.message,
        settledAt: now(),
      });
      await writeRecord(registryDirectory, "turns", context.turn);
      return context;
    }
  }

  if (observed?.agent_status === "blocked") {
    const blocks = await readRecords(registryDirectory, "blocks");
    let block = blocks.find(({ id }) => id === context.turn.block_ids?.at(-1));
    if (!block) {
      block = {
        schema: "drovr.block/v1",
        id: randomUUID(),
        turn_id: context.turn.id,
        agent_id: context.agent.id,
        task_id: context.task.id,
        harness: context.agent.launch.harness,
        status: "open",
        excerpt: await herdr.agentExcerpt(context.agent.herdr.name),
        attach: { command: `drovr attach ${context.agent.id}` },
        created_at: now(),
      };
      context.turn.block_ids = [...(context.turn.block_ids ?? []), block.id];
      await writeRecord(registryDirectory, "turns", context.turn);
      await writeRecord(registryDirectory, "blocks", block);
    }
    return { ...context, block };
  }
  if (!["idle", "done"].includes(observed?.agent_status)) {
    return settleUncertain(registryDirectory, context, null, now());
  }

  let result;
  try {
    result = await adapter.extract(
      context.turn.transcript_cursor,
      context.turn.inputs.map(({ text }) => text),
    );
  } catch (error) {
    if (error.details?.correlation_pending && retryCorrelation) {
      return { ...context, retry_wait: true, correlation_pending: true };
    }
    settleTurnRecord(context.turn, {
      status: error.outcome ?? "uncertain",
      error: error.message,
      settledAt: now(),
    });
    await writeRecord(registryDirectory, "turns", context.turn);
    return context;
  }
  settleTurnRecord(context.turn, {
    status: "completed",
    result,
    settledAt: now(),
  });
  await writeRecord(registryDirectory, "turns", context.turn);
  return context;
}

export async function sendToTurn(turnId, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await turnContext(registryDirectory, turnId);
  const herdr = client(owningSession(initial.group), env, dependencies);
  await herdr.ensureSession();

  const outcome = await withResourceLock(
    registryDirectory,
    `turn:${turnId}`,
    async () => {
      const context = await turnContext(registryDirectory, turnId);
      if (context.turn.status !== "working") {
        return { ...context, command_status: "turn_closed" };
      }
      const observed = await herdr.agentRecord(context.agent.herdr.name);
      if (observed?.agent_status === "blocked") {
        return { ...context, reconcile_status: "needs_input" };
      }
      if (observed?.agent_status !== "working") {
        return { ...context, reconcile_status: "turn_closed" };
      }

      appendTurnInput(context.turn, {
        text: options.prompt,
        submittedAt: now(),
      });
      await writeRecord(registryDirectory, "turns", context.turn);
      await deliverTurn({
        registryDirectory,
        agent: context.agent,
        turn: context.turn,
        prompt: options.prompt,
        herdr,
        now,
      });
      return context;
    },
  );
  if (!outcome.reconcile_status) return outcome;
  const reconciled = await waitForTurn(turnId, {}, dependencies);
  return { ...reconciled, command_status: outcome.reconcile_status };
}

async function settleUncertain(registryDirectory, context, error, settledAt) {
  settleTurnRecord(context.turn, {
    status: "uncertain",
    ...(error ? { error } : {}),
    settledAt,
  });
  await writeRecord(registryDirectory, "turns", context.turn);
  return context;
}

export async function getTurn(turnId, { env = process.env } = {}) {
  return turnContext(stateDirectory(env), turnId);
}

export async function listTurns(filters = {}, { env = process.env } = {}) {
  const turns = await readRecords(stateDirectory(env), "turns");
  return turns
    .filter(
      (turn) =>
        (!filters.agentId || turn.agent_id === filters.agentId) &&
        (!filters.taskId || turn.task_id === filters.taskId) &&
        (!filters.status || turn.status === filters.status),
    )
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    );
}

export function turnCommandResult(command, context, options = {}) {
  const status =
    context.command_status ??
    context.wait_status ??
    (context.block ? "needs_input" : context.turn.status);
  return {
    schema: "drovr.command/v1",
    command,
    ok: true,
    result: {
      status,
      group: summarizeGroup(context.group),
      task: summarizeTask(context.task),
      agent: summarizeAgent(context.agent),
      turn: summarizeTurn(context.turn, options),
      ...(context.block ? { block: summarizeBlock(context.block) } : {}),
    },
  };
}

export function turnListCommandResult(turns) {
  return {
    schema: "drovr.command/v1",
    command: "turn list",
    ok: true,
    result: {
      status: "completed",
      turns: turns.map((turn) => summarizeTurn(turn)),
    },
  };
}

function summarizeGroup(group) {
  return { id: group.id, key: group.key, label: group.label };
}

function summarizeTask(task) {
  return {
    id: task.id,
    key: task.key,
    label: task.label,
    cwd: task.cwd,
  };
}

function summarizeAgent(agent) {
  return {
    id: agent.id,
    key: agent.key,
    label: agent.label,
    harness: agent.launch.harness,
    model: agent.launch.model,
    effort: agent.launch.effort,
    capability: agent.launch.capability,
  };
}

function summarizeTurn(
  turn,
  { includeMessages = false, compact = false } = {},
) {
  const result = turn.result
    ? {
        text: turn.result.text,
        ...(includeMessages ? { messages: turn.result.messages } : {}),
      }
    : undefined;
  const summary = {
    id: turn.id,
    status: turn.status,
    input_count: turn.inputs.length,
    ...(result ? { result } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  };
  if (compact) return summary;
  return {
    ...summary,
    agent_id: turn.agent_id,
    task_id: turn.task_id,
    created_at: turn.created_at,
    ...(turn.settled_at ? { settled_at: turn.settled_at } : {}),
  };
}

function summarizeBlock(block) {
  return {
    id: block.id,
    turn_id: block.turn_id,
    agent_id: block.agent_id,
    task_id: block.task_id,
    harness: block.harness,
    excerpt: block.excerpt,
    attach: block.attach,
  };
}
