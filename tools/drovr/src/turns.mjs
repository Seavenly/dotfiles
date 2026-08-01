import { createHash, randomUUID } from "node:crypto";

import {
  acknowledgeBlockRecord,
  blockAwaitsWorkingObservation,
  blockRepresentsActiveTransition,
  createBlockRecord,
  herdrStateChangedSinceBlock,
  observeBlockWorking,
  resolveBlockRecord,
  supersedeBlockRecord,
} from "./block-record.mjs";
import { DrovrError } from "./errors.mjs";
import { digestCanonical } from "./canonical-json.mjs";
import { describeDelegatedAgent } from "./description.mjs";
import { harnessAdapter } from "./harness-adapter.mjs";
import { HerdrClient } from "./herdr.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "./registry.mjs";
import {
  appendTurnInput,
  normalizeInputText,
  settleTurnRecord,
  terminalProofClassification,
  turnAwaitsPostDeliverySettlement,
} from "./turn-record.mjs";
import { deliverTurn, prepareTurn } from "./turn-lifecycle.mjs";
import { reconcileOrRecoverAgent } from "./recovery.mjs";

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
  const agent = agents.find(({ id }) => id === agentId);
  if (!agent) invalidIdentifier("agent", agentId);
  if (agent.status !== "active") {
    throw new DrovrError(`agent ${agentId} is no longer active`, {
      code: 0,
      outcome: "agent_lost",
    });
  }
  const tasks = await readRecords(registryDirectory, "tasks");
  const task = tasks.find(({ id }) => id === agent.task_id);
  if (!task) corruptRelationship("task", agent.task_id, agent.id);
  if (task.status !== "active") {
    throw new DrovrError(`task ${task.id} is closed`, {
      code: 0,
      outcome: "task_closed",
    });
  }
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
  return withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(initial.task.id),
    async () => {
      if (initial.agent.native_session) {
        const availability = await reconcileOrRecoverAgent(agentId, {
          ...dependencies,
          env,
          herdr,
          now,
        });
        if (!["reconciled", "recovered"].includes(availability.status)) {
          throw new DrovrError(
            `agent ${agentId} cannot be recovered safely (${availability.reason})`,
            { code: 0, outcome: availability.status },
          );
        }
      } else {
        const observed = await herdr.agentRecord(initial.agent.herdr.name);
        if (!observed) {
          throw new DrovrError(
            `Herdr did not report managed agent ${initial.agent.herdr.name}`,
            { code: 0, outcome: "uncertain" },
          );
        }
        if (!["idle", "done"].includes(observed.agent_status)) {
          throw new DrovrError(
            `agent ${agentId} is not settled in Herdr`,
            { code: 0, outcome: "task_busy" },
          );
        }
      }
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
              { code: 0, outcome: "task_busy" },
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
            current.agent.native_session &&
            current.agent.native_session !== observedNativeSession
          ) {
            throw new DrovrError(
              `Herdr did not confirm the expected native session for agent ${agentId}`,
              { code: 0, outcome: "uncertain" },
            );
          }
          if (!current.agent.native_session && observedNativeSession) {
            current.agent.native_session = observedNativeSession;
            await writeRecord(registryDirectory, "agents", current.agent);
          }
          if (
            !current.agent.native_session &&
            turns.some(({ agent_id: candidateAgentId }) =>
              candidateAgentId === agentId
            )
          ) {
            throw new DrovrError(
              `Herdr did not confirm a native session for reused agent ${agentId}`,
              { code: 0, outcome: "uncertain" },
            );
          }

          const adapter = harnessAdapter(current.agent.launch.harness, env);
          const turn = await prepareTurn({
            registryDirectory,
            agent: current.agent,
            task: current.task,
            adapter,
            prompt: options.prompt,
            now,
            inventoryBeforeDelivery:
              adapter.inventoryBeforeDelivery || !current.agent.native_session,
            herdrStateChangeSeq: observed.state_change_seq,
            caller: options.caller,
            inputKey: options.inputKey,
            launchBinding: options.launchBinding,
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
    },
  );
}

export async function discoverTurn(callerKey, dependencies = {}) {
  requireCallerKey(callerKey);
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const turns = await readRecords(registryDirectory, "turns");
  const authorityWatermark = {
    schema: "drovr.registry-authority-watermark/v1",
    authority: "drovr.registry",
    turns_sha256: callerPayloadDigest(turns),
  };
  const matches = turns.filter(
    (turn) => turn.caller?.dispatch_key === callerKey,
  );
  if (matches.length > 1) {
    throw new DrovrError(
      `caller key ${callerKey} owns more than one logical turn`,
      { code: 5, outcome: "corrupt_registry" },
    );
  }
  if (matches.length === 0) {
    return {
      discovery_status: "proven_absent",
      authority_watermark: authorityWatermark,
    };
  }
  return {
    ...(await turnContext(registryDirectory, matches[0].id)),
    discovery_status: "found",
    discovery_watermark: authorityWatermark,
  };
}

export async function dispatchTurn(agentId, options, dependencies = {}) {
  requireCallerKey(options.callerKey);
  requireCallerKey(options.inputKey);
  const prompt = typeof options.prompt === "string"
    ? normalizeInputText(options.prompt)
    : options.prompt;
  requireInputText(prompt);
  validateLaunchBinding(options.launchBinding);
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const payloadSha256 = callerPayloadDigest({
    agent_id: agentId,
    prompt,
    input_key: options.inputKey,
    caller_metadata: options.callerMetadata,
    launch_binding: options.launchBinding,
  });
  return withResourceLock(
    registryDirectory,
    `dispatch-key:${options.callerKey}`,
    async () => {
      const existing = (await readRecords(registryDirectory, "turns")).filter(
        (turn) => turn.caller?.dispatch_key === options.callerKey,
      );
      if (existing.length > 1) {
        throw new DrovrError(
          `caller key ${options.callerKey} owns more than one logical turn`,
          { code: 5, outcome: "corrupt_registry" },
        );
      }
      if (existing.length === 1) {
        if (existing[0].caller.payload_sha256 !== payloadSha256) {
          callerKeyConflict(options.callerKey);
        }
        return {
          ...(await turnContext(registryDirectory, existing[0].id)),
          dispatch_status:
            existing[0].status === "working" &&
            existing[0].inputs[0]?.delivery?.status === "recorded"
              ? "reconciling"
              : "adopted",
        };
      }
      const initial = await agentContext(registryDirectory, agentId);
      requireAgentLaunchBinding(initial);
      const exactDescription = await describeDelegatedAgent({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: Object.fromEntries(
          ["harness", "role", "model", "effort", "capability"]
            .filter((key) => initial.agent.launch[key] !== undefined)
            .map((key) => [key, initial.agent.launch[key]]),
        ),
        caller_metadata: options.callerMetadata,
      }, { env });
      if (
        exactDescription.comparison_keys.launch !==
          options.launchBinding.comparison_key ||
        exactDescription.watermark.content_sha256 !==
          options.launchBinding.configuration_watermark ||
        exactDescription.description_digest !==
          options.launchBinding.description_digest
      ) {
        throw new DrovrError(
          `agent ${agentId} description identity does not match the requested launch binding`,
          { code: 0, outcome: "launch_binding_conflict" },
        );
      }
      validateAgentLaunchBinding(initial, options.launchBinding);
      const context = await startTurn(agentId, {
        prompt,
        inputKey: options.inputKey,
        launchBinding: options.launchBinding,
        caller: {
          dispatch_key: options.callerKey,
          payload_sha256: payloadSha256,
          metadata: structuredClone(options.callerMetadata),
        },
      }, dependencies);
      return { ...context, dispatch_status: "dispatched" };
    },
  );
}

export async function waitForTurn(turnId, options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const clock = dependencies.clock ?? Date.now;
  const wallClock = dependencies.wallClock ?? Date.now;
  const delay =
    dependencies.delay ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const registryDirectory = stateDirectory(env);
  let context = await turnContext(registryDirectory, turnId);
  let acknowledgedBlock;
  if (options.afterBlockId) {
    ({ context, block: acknowledgedBlock } = await acknowledgeCurrentBlock({
      registryDirectory,
      turnId,
      blockId: options.afterBlockId,
      acknowledgedAt: now(),
    }));
  }
  if (!acknowledgedBlock && context.turn.status !== "working") return context;

  const herdr = client(owningSession(context.group), env, dependencies);
  const deadline =
    options.timeoutMs === undefined ? undefined : clock() + options.timeoutMs;
  let correlationDeadline;
  let correlationStage;
  for (;;) {
    context = await turnContext(registryDirectory, turnId);
    if (acknowledgedBlock) {
      const currentBlock = await currentBlockForTurn(
        registryDirectory,
        context.turn,
      );
      if (currentBlock.id !== acknowledgedBlock.id) {
        return { ...context, block: currentBlock };
      }
      acknowledgedBlock = currentBlock;
      if (
        context.turn.status !== "working" &&
        acknowledgedBlock.working_observed_at
      ) {
        return context;
      }
    } else if (context.turn.status !== "working") {
      return context;
    }
    const observedInputCount = context.turn.inputs.length;
    const remaining =
      deadline === undefined ? undefined : Math.max(0, deadline - clock());
    if (remaining === 0) {
      return { ...context, wait_status: "still_running" };
    }
    if (blockAwaitsWorkingObservation(acknowledgedBlock)) {
      const observed = await herdr.agentRecord(context.agent.herdr.name);
      if (!observed) return { ...context, wait_status: "agent_lost" };
      if (observed?.agent_status === "working") {
        const recorded = await recordBlockWorkingObservation({
          registryDirectory,
          turnId,
          blockId: acknowledgedBlock.id,
          observedAt: now(),
          observation: "herdr_working_status",
        });
        if (recorded.currentBlock.id !== acknowledgedBlock.id) {
          return { ...context, block: recorded.currentBlock };
        }
        acknowledgedBlock = recorded.block;
        continue;
      }
      if (
        ["idle", "done"].includes(observed?.agent_status) &&
        herdrStateChangedSinceBlock(
          acknowledgedBlock,
          observed.state_change_seq,
        )
      ) {
        const recorded = await recordBlockWorkingObservation({
          registryDirectory,
          turnId,
          blockId: acknowledgedBlock.id,
          observedAt: now(),
          observation: "herdr_state_changed_before_settlement",
        });
        if (recorded.currentBlock.id !== acknowledgedBlock.id) {
          return { ...context, block: recorded.currentBlock };
        }
        acknowledgedBlock = recorded.block;
        continue;
      }
      if (observed?.agent_status === "blocked") {
        if (
          !blockRepresentsActiveTransition(acknowledgedBlock, {
            herdrStateChangeSeq: observed.state_change_seq,
          })
        ) {
          const blockedExcerpt = await herdr.agentExcerpt(
            context.agent.herdr.name,
          );
          const reconciled = await withResourceLock(
            registryDirectory,
            `turn:${turnId}`,
            async () =>
              reconcileSettledObservation({
                registryDirectory,
                turnId,
                observed,
                observedInputCount,
                blockedExcerpt,
                env,
                now,
                retryCorrelation: true,
              }),
          );
          if (!reconciled.retry_wait) return reconciled;
          continue;
        }
        const currentBlock = await currentBlockForTurn(
          registryDirectory,
          context.turn,
        );
        if (currentBlock?.id !== acknowledgedBlock.id) {
          return { ...context, block: currentBlock };
        }
      }
      await delay(Math.min(25, remaining ?? 25));
      continue;
    }
    const observed = await herdr.waitForAgent(
      context.agent.herdr.name,
      remaining,
    );
    if (observed?.drovr_status === "agent_lost" || !observed) {
      return { ...context, wait_status: "agent_lost" };
    }
    if (observed?.drovr_status === "still_running") {
      return { ...context, wait_status: "still_running" };
    }
    const blockedExcerpt =
      observed?.agent_status === "blocked"
        ? await herdr.agentExcerpt(context.agent.herdr.name)
        : undefined;
    const deliveryObservationExpired = deliveryObservationGraceExpired(
      context.turn,
      observed?.state_change_seq,
      wallClock(),
    );

    const reconciled = await withResourceLock(
      registryDirectory,
      `turn:${turnId}`,
      async () =>
        reconcileSettledObservation({
          registryDirectory,
          turnId,
          observed,
          observedInputCount,
          blockedExcerpt,
          env,
          now,
          retryCorrelation:
            !deliveryObservationExpired &&
            (correlationDeadline === undefined ||
              clock() < correlationDeadline),
          correlationStage,
          deliveryObservationExpired,
        }),
    );
    if (!reconciled.retry_wait) return reconciled;
    if (
      reconciled.correlation_pending &&
      reconciled.correlation_stage !== correlationStage
    ) {
      correlationStage = reconciled.correlation_stage;
      correlationDeadline = clock() + TRANSCRIPT_SETTLE_GRACE_MS;
    }
    await delay(25);
  }
}

async function acknowledgeCurrentBlock({
  registryDirectory,
  turnId,
  blockId,
  acknowledgedAt,
}) {
  return withResourceLock(registryDirectory, `turn:${turnId}`, async () => {
    const context = await turnContext(registryDirectory, turnId);
    const blocks = await readRecords(registryDirectory, "blocks");
    const currentBlockId = context.turn.block_ids?.at(-1);
    const block = blocks.find(({ id }) => id === blockId);
    if (!block && currentBlockId === blockId) {
      corruptRelationship("block", blockId, context.turn.id);
    }
    if (!block) invalidIdentifier("block", blockId);
    if (block.turn_id !== turnId) {
      throw new DrovrError(
        `block ${blockId} belongs to another logical turn`,
        { code: 2, outcome: "invalid_arguments" },
      );
    }
    if (currentBlockId !== blockId || block.status === "superseded") {
      const detail =
        block.status === "superseded"
          ? "has already been superseded"
          : "is not the current block";
      throw new DrovrError(`block ${blockId} ${detail}`, {
        code: 2,
        outcome: "invalid_arguments",
      });
    }
    if (block.status === "open") {
      acknowledgeBlockRecord(block, { acknowledgedAt });
      await writeRecord(registryDirectory, "blocks", block);
    }
    return { context, block };
  });
}

async function recordBlockWorkingObservation({
  registryDirectory,
  turnId,
  blockId,
  observedAt,
  observation,
}) {
  return withResourceLock(registryDirectory, `turn:${turnId}`, async () => {
    const context = await turnContext(registryDirectory, turnId);
    const currentBlock = await currentBlockForTurn(
      registryDirectory,
      context.turn,
    );
    if (currentBlock.id !== blockId) {
      return { block: null, currentBlock };
    }
    const blocks = await readRecords(registryDirectory, "blocks");
    const block = blocks.find(({ id }) => id === blockId);
    if (!block) corruptRelationship("block", blockId, context.turn.id);
    observeBlockWorking(block, { observedAt, observation });
    await writeRecord(registryDirectory, "blocks", block);
    return { block, currentBlock: block };
  });
}

async function currentBlockForTurn(registryDirectory, turn) {
  const currentBlockId = turn.block_ids?.at(-1);
  if (!currentBlockId) return null;
  const blocks = await readRecords(registryDirectory, "blocks");
  const block = blocks.find(({ id }) => id === currentBlockId);
  if (!block) corruptRelationship("block", currentBlockId, turn.id);
  if (block.turn_id !== turn.id) {
    throw new DrovrError(
      `registry turn ${turn.id} references block ${currentBlockId} owned by turn ${block.turn_id}`,
      { code: 5, outcome: "corrupt_registry" },
    );
  }
  return block;
}

async function reconcileSettledObservation({
  registryDirectory,
  turnId,
  observed,
  observedInputCount,
  blockedExcerpt,
  env,
  now,
  retryCorrelation,
  correlationStage,
  deliveryObservationExpired,
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
      const pendingStage = error.details?.correlation_stage ?? "transcript";
      if (
        error.details?.correlation_pending &&
        (retryCorrelation || pendingStage !== correlationStage)
      ) {
        return {
          ...context,
          retry_wait: true,
          correlation_pending: true,
          correlation_stage: pendingStage,
        };
      }
      settleTurnRecord(context.turn, {
        status: error.outcome ?? "uncertain",
        error: error.message,
        settledAt: now(),
      });
      if (error.details?.correlation_pending) {
        context.turn.late_result_recovery = "exact_transcript_correlation";
      }
      await writeRecord(registryDirectory, "turns", context.turn);
      return context;
    }
  }

  if (observed?.agent_status === "blocked") {
    let block = await currentBlockForTurn(registryDirectory, context.turn);
    if (
      !blockRepresentsActiveTransition(block, {
        herdrStateChangeSeq: observed.state_change_seq,
      })
    ) {
      const blockId = randomUUID();
      if (block) {
        supersedeBlockRecord(block, {
          supersededAt: now(),
          supersededBy: blockId,
        });
        await writeRecord(registryDirectory, "blocks", block);
      }
      block = createBlockRecord({
        id: blockId,
        turnId: context.turn.id,
        agentId: context.agent.id,
        taskId: context.task.id,
        harness: context.agent.launch.harness,
        excerpt: blockedExcerpt,
        herdrStateChangeSeq: observed.state_change_seq,
        createdAt: now(),
      });
      context.turn.block_ids = [...(context.turn.block_ids ?? []), block.id];
      await writeRecord(registryDirectory, "turns", context.turn);
      await writeRecord(registryDirectory, "blocks", block);
    }
    return { ...context, block };
  }
  if (
    ["idle", "done"].includes(observed?.agent_status) &&
    turnAwaitsPostDeliverySettlement(
      context.turn,
      observed.state_change_seq,
    ) &&
    !deliveryObservationExpired
  ) {
    return { ...context, retry_wait: true };
  }
  if (!["idle", "done"].includes(observed?.agent_status)) {
    return settleUncertain(registryDirectory, context, null, now());
  }
  const currentBlock = await currentBlockForTurn(
    registryDirectory,
    context.turn,
  );
  if (blockAwaitsWorkingObservation(currentBlock)) {
    return { ...context, retry_wait: true };
  }

  let result;
  try {
    result = await adapter.extract(
      context.turn.transcript_cursor,
      context.turn.inputs.map(({ text }) => text),
    );
  } catch (error) {
    const pendingStage = error.details?.correlation_stage ?? "transcript";
    if (
      !deliveryObservationExpired &&
      error.details?.correlation_pending &&
      (retryCorrelation || pendingStage !== correlationStage)
    ) {
      return {
        ...context,
        retry_wait: true,
        correlation_pending: true,
        correlation_stage: pendingStage,
      };
    }
    settleTurnRecord(context.turn, {
      status: error.outcome ?? "uncertain",
      error: error.message,
      settledAt: now(),
    });
    if (error.details?.correlation_pending) {
      context.turn.late_result_recovery = "exact_transcript_correlation";
    }
    await writeRecord(registryDirectory, "turns", context.turn);
    return context;
  }
  settleTurnRecord(context.turn, {
    status: "completed",
    result,
    settledAt: now(),
  });
  await writeRecord(registryDirectory, "turns", context.turn);
  if (currentBlock && currentBlock.status !== "superseded") {
    resolveBlockRecord(currentBlock, { resolvedAt: now() });
    await writeRecord(registryDirectory, "blocks", currentBlock);
  }
  return context;
}

function deliveryObservationGraceExpired(
  turn,
  herdrStateChangeSeq,
  observedAtMs,
) {
  if (!turnAwaitsPostDeliverySettlement(turn, herdrStateChangeSeq)) {
    return false;
  }
  const submittedAtMs = Date.parse(
    turn.inputs[0]?.submitted_at ?? turn.created_at,
  );
  return (
    Number.isFinite(submittedAtMs) &&
    observedAtMs >= submittedAtMs + TRANSCRIPT_SETTLE_GRACE_MS
  );
}

export async function sendToTurn(turnId, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const prompt = typeof options.prompt === "string"
    ? normalizeInputText(options.prompt)
    : options.prompt;
  if (options.callerKey) requireInputText(prompt);
  const initial = await turnContext(registryDirectory, turnId);
  if (initial.turn.caller && !options.callerKey) {
    throw new DrovrError(
      `caller-owned logical turn ${turnId} requires a caller input key`,
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  if (options.callerKey) {
    const adopted = callerInputDisposition(
      initial.turn,
      options.callerKey,
      prompt,
    );
    if (adopted) {
      return {
        ...initial,
        input_status:
          initial.turn.status === "working" &&
          adopted.delivery?.status === "recorded"
            ? "reconciling"
            : "adopted",
      };
    }
  }
  if (pendingCallerDelivery(initial.turn)) {
    return { ...initial, input_status: "reconciling" };
  }
  const herdr = client(owningSession(initial.group), env, dependencies);
  await herdr.ensureSession();
  const availability = await reconcileOrRecoverAgent(initial.agent.id, {
    ...dependencies,
    env,
    herdr,
    now,
  });
  if (!["reconciled", "recovered"].includes(availability.status)) {
    return {
      ...initial,
      command_status: availability.status,
      recovery_reason: availability.reason,
    };
  }

  const outcome = await withResourceLock(
    registryDirectory,
    `turn:${turnId}`,
    async () => {
      const context = await turnContext(registryDirectory, turnId);
      if (context.turn.status !== "working") {
        return { ...context, command_status: "turn_closed" };
      }
      if (options.callerKey) {
        const adopted = callerInputDisposition(
          context.turn,
          options.callerKey,
          prompt,
        );
        if (adopted) {
          return {
            ...context,
            input_status:
              context.turn.status === "working" &&
              adopted.delivery?.status === "recorded"
                ? "reconciling"
                : "adopted",
          };
        }
      }
      if (pendingCallerDelivery(context.turn)) {
        return { ...context, input_status: "reconciling" };
      }
      if (
        context.turn.cancellation_requested_at ||
        context.turn.cleanup_requested_at
      ) {
        return { ...context, command_status: "task_busy" };
      }
      const observed = await herdr.agentRecord(context.agent.herdr.name);
      if (observed?.agent_status === "blocked") {
        return { ...context, reconcile_status: "needs_input" };
      }
      if (observed?.agent_status !== "working") {
        return { ...context, reconcile_status: "turn_closed" };
      }

      appendTurnInput(context.turn, {
        callerKey: options.callerKey,
        text: prompt,
        submittedAt: now(),
      });
      await writeRecord(registryDirectory, "turns", context.turn);
      await deliverTurn({
        registryDirectory,
        agent: context.agent,
        turn: context.turn,
        prompt,
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

export async function reconcileTurn(
  turnId,
  options = {},
  dependencies = {},
) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new DrovrError("turn reconciliation requires a positive timeout", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  const initial = await getTurn(turnId, dependencies);
  if (initial.turn.status !== "working") return initial;
  const recovery = await reconcileOrRecoverAgent(
    initial.agent.id,
    dependencies,
  );
  if (recovery.status === "reconciled") {
    return waitForTurn(turnId, { timeoutMs: options.timeoutMs }, dependencies);
  }
  const context = await getTurn(turnId, dependencies);
  if (recovery.status === "recovered") return context;
  return {
    ...context,
    command_status: recovery.status,
    ...(recovery.reason ? { recovery_reason: recovery.reason } : {}),
  };
}

function callerInputDisposition(turn, callerKey, prompt) {
  requireCallerKey(callerKey);
  const matches = turn.inputs.filter((input) => input.caller_key === callerKey);
  if (matches.length > 1) {
    throw new DrovrError(
      `caller input key ${callerKey} appears more than once`,
      { code: 5, outcome: "corrupt_registry" },
    );
  }
  if (matches.length === 0) return null;
  const payloadSha256 = textDigest(prompt);
  if (matches[0].payload_sha256 !== payloadSha256) callerKeyConflict(callerKey);
  return matches[0];
}

function pendingCallerDelivery(turn) {
  return turn.status === "working" &&
    turn.inputs.some(({ delivery }) => delivery?.status === "recorded");
}

function validateAgentLaunchBinding(context, requested) {
  const { agent } = context;
  const actual = agent.launch_binding;
  if (
    actual.comparison_key !== requested.comparison_key ||
    actual.configuration_watermark !== requested.configuration_watermark
  ) {
    throw new DrovrError(
      `agent ${agent.id} has a stale immutable launch binding`,
      {
        code: 0,
        outcome: "launch_binding_stale",
        details: { delegation: delegationIdentity(context) },
      },
    );
  }
}

function requireAgentLaunchBinding(context) {
  if (!context.agent.launch_binding) {
    throw new DrovrError(
      `agent ${context.agent.id} predates exact launch bindings`,
      {
        code: 0,
        outcome: "launch_binding_missing",
        details: { delegation: delegationIdentity(context) },
      },
    );
  }
}

function delegationIdentity({ group, task, agent }) {
  return {
    agent_id: agent.id,
    task_id: task.id,
    group_id: group.id,
  };
}

function validateLaunchBinding(binding) {
  if (
    binding?.schema !== "drovr.launch-binding/v1" ||
    !isDigest(binding.comparison_key) ||
    !isDigest(binding.configuration_watermark) ||
    !isDigest(binding.description_digest) ||
    Object.keys(binding).some((key) => ![
      "schema",
      "comparison_key",
      "configuration_watermark",
      "description_digest",
    ].includes(key))
  ) {
    throw new DrovrError("invalid exact launch binding", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
}

function requireCallerKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DrovrError("caller key must be a non-empty string", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
}

function requireInputText(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DrovrError("caller input must be a non-empty string", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
}

function callerKeyConflict(callerKey) {
  throw new DrovrError(`caller key ${callerKey} has a different payload`, {
    code: 0,
    outcome: "caller_key_conflict",
  });
}

function callerPayloadDigest(value) {
  return digestCanonical(value);
}

function textDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export async function cancelTurn(turnId, options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await turnContext(registryDirectory, turnId);
  if (initial.turn.status !== "working") {
    return { ...initial, command_status: "turn_closed" };
  }
  if (initial.turn.cleanup_requested_at) {
    return { ...initial, command_status: "task_busy" };
  }
  const herdr = client(owningSession(initial.group), env, dependencies);
  await herdr.ensureSession?.();
  const availability = await reconcileOrRecoverAgent(initial.agent.id, {
    ...dependencies,
    env,
    herdr,
    now,
  });
  if (!["reconciled", "recovered"].includes(availability.status)) {
    return {
      ...initial,
      command_status: availability.status,
      recovery_reason: availability.reason,
    };
  }
  const current = await turnContext(registryDirectory, turnId);
  if (current.turn.status !== "working") {
    return { ...current, command_status: "turn_closed" };
  }
  if (["idle", "done"].includes(availability.observed?.agent_status)) {
    const reconciled = await waitForTurn(turnId, options, {
      ...dependencies,
      env,
      herdr,
      now,
    });
    return {
      ...reconciled,
      command_status:
        reconciled.turn.status === "completed"
          ? "turn_closed"
          : (reconciled.wait_status ?? reconciled.turn.status),
    };
  }
  if (
    !["working", "blocked"].includes(availability.observed?.agent_status)
  ) {
    return { ...current, command_status: "uncertain" };
  }

  const cancellation = await withResourceLock(
    registryDirectory,
    `turn:${turnId}`,
    async () => {
      const context = await turnContext(registryDirectory, turnId);
      if (context.turn.status !== "working") {
        return { ...context, command_status: "turn_closed" };
      }
      if (context.turn.cleanup_requested_at) {
        return { ...context, command_status: "task_busy" };
      }
      context.turn.cancellation_requested_at ??= now();
      await writeRecord(registryDirectory, "turns", context.turn);
      return context;
    },
  );
  if (cancellation.command_status) {
    return cancellation;
  }

  try {
    await herdr.interruptAgent(initial.agent.herdr.name);
  } catch (error) {
    return withResourceLock(registryDirectory, `turn:${turnId}`, async () => {
      const context = await turnContext(registryDirectory, turnId);
      if (context.turn.status === "working") {
        settleTurnRecord(context.turn, {
          status: "uncertain",
          error: `native interruption could not be delivered: ${error.message}`,
          settledAt: now(),
        });
        await writeRecord(registryDirectory, "turns", context.turn);
      }
      return context;
    });
  }

  let observed;
  try {
    observed = await herdr.waitForAgent(
      initial.agent.herdr.name,
      options.timeoutMs ?? 120_000,
    );
  } catch (error) {
    observed = {
      drovr_status: "settlement_failed",
      error: error.message,
    };
  }
  return withResourceLock(registryDirectory, `turn:${turnId}`, async () => {
    const context = await turnContext(registryDirectory, turnId);
    if (context.turn.status !== "working") return context;
    const observedNativeSession = observed?.agent_session?.value;
    const settled = ["idle", "done"].includes(observed?.agent_status);
    const expectedSession = context.agent.native_session;
    if (
      settled &&
      expectedSession &&
      observedNativeSession === expectedSession
    ) {
      settleTurnRecord(context.turn, {
        status: "cancelled",
        settledAt: now(),
      });
      const currentBlockId = context.turn.block_ids?.at(-1);
      if (currentBlockId) {
        const blocks = await readRecords(registryDirectory, "blocks");
        const block = blocks.find(({ id }) => id === currentBlockId);
        if (block && block.status !== "superseded") {
          resolveBlockRecord(block, { resolvedAt: now() });
          block.resolution = "cancelled";
          await writeRecord(registryDirectory, "blocks", block);
        }
      }
    } else {
      settleTurnRecord(context.turn, {
        status:
          observed?.drovr_status === "still_running" ||
          observed?.drovr_status === "settlement_failed"
            ? "interrupted"
            : "uncertain",
        error: observed?.error
          ? `native interruption settlement failed: ${observed.error}`
          : "native interruption settlement could not be confirmed",
        settledAt: now(),
      });
    }
    await writeRecord(registryDirectory, "turns", context.turn);
    return context;
  });
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
  const context = await turnContext(stateDirectory(env), turnId);
  if (!lateResultRecoveryEligible(context.turn)) return context;
  const adapter = harnessAdapter(context.agent.launch.harness, env);
  let cursor = context.turn.transcript_cursor;
  try {
    if (cursor.transcript_root) {
      const transcriptPath = await adapter.locate(
        cursor.transcript_root,
        context.agent.native_session,
      );
      cursor = await adapter.resolveInventory(
        cursor,
        transcriptPath,
        context.agent.native_session,
      );
    }
    const lateResult = await adapter.extract(
      cursor,
      context.turn.inputs.map(({ text }) => text),
    );
    return { ...context, late_result: lateResult };
  } catch {
    return context;
  }
}

function lateResultRecoveryEligible(turn) {
  if (
    ![
      "cancelled",
      "interrupted",
      "uncertain",
      "unsupported_transcript",
    ].includes(turn.status) ||
    turn.result
  ) {
    return false;
  }
  if (["cancelled", "interrupted"].includes(turn.status)) return true;
  if (turn.late_result_recovery === "exact_transcript_correlation") return true;
  return (
    turn.error === "submitted input was not observed after the transcript cursor" ||
    /^no completed (?:Claude|Codex) assistant result followed the final input$/u.test(
      turn.error ?? "",
    )
  );
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
    (context.dispatch_status === "reconciling" ||
    context.input_status === "reconciling"
      ? "reconciling"
      : undefined) ??
    (pendingCallerDelivery(context.turn) ? "reconciling" : undefined) ??
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
      turn: summarizeTurn(context.turn, {
        ...options,
        lateResult: context.late_result,
      }),
      ...(context.block ? { block: summarizeBlock(context.block) } : {}),
      ...(context.recovery_reason
        ? { recovery: { reason: context.recovery_reason } }
        : {}),
      authority_watermark: turnAuthorityWatermark(context.turn),
      ...(context.discovery_watermark
        ? { discovery_watermark: context.discovery_watermark }
        : {}),
      legal_next_actions: legalNextActions(context),
    },
  };
}

export function turnDiscoveryCommandResult(callerKey, discovery) {
  if (discovery.discovery_status === "found") {
    return turnCommandResult("turn discover", discovery);
  }
  return {
    schema: "drovr.command/v1",
    command: "turn discover",
    ok: true,
    result: {
      status: "proven_absent",
      caller_key: callerKey,
      authority_watermark: discovery.authority_watermark,
      legal_next_actions: ["dispatch_with_same_caller_key"],
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
  { includeMessages = false, compact = false, lateResult } = {},
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
    ...(turn.caller ? { caller: structuredClone(turn.caller) } : {}),
    ...(turn.launch_binding
      ? { launch_binding: structuredClone(turn.launch_binding) }
      : {}),
    ...(turn.settlement_proof
      ? { settlement_proof: structuredClone(turn.settlement_proof) }
      : turn.status !== "working"
        ? {
            terminal_proof: {
              schema: "drovr.terminal-proof/v1",
              classification: terminalProofClassification(turn.status),
            },
          }
        : {}),
    inputs: turn.inputs.map(
      ({ sequence, caller_key, payload_sha256, delivery }) => ({
        sequence,
        ...(caller_key
          ? {
              caller_key,
              payload_sha256,
              delivery: structuredClone(delivery),
            }
          : {}),
      }),
    ),
    ...(result ? { result } : {}),
    ...(lateResult
      ? {
          late_result: {
            turn_id: turn.id,
            disposition: "quarantined",
            proof_classification: "exact_transcript_correlation",
            text: lateResult.text,
            ...(includeMessages ? { messages: lateResult.messages } : {}),
          },
        }
      : {}),
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

function turnAuthorityWatermark(turn) {
  return {
    schema: "drovr.turn-authority-watermark/v1",
    authority: "drovr.registry",
    turn_id: turn.id,
    record_sha256: callerPayloadDigest(turn),
  };
}

function legalNextActions(context) {
  const { turn, block } = context;
  if (
    context.dispatch_status === "reconciling" ||
    context.input_status === "reconciling" ||
    pendingCallerDelivery(turn)
  ) {
    return ["observe_bounded", "wait_bounded", "reconcile_exact_turn"];
  }
  if (
    context.recovery_reason ||
    ["agent_lost", "recovery_blocked", "uncertain"].includes(
      context.command_status,
    ) ||
    context.wait_status === "agent_lost"
  ) {
    return ["observe_bounded", "reconcile_exact_turn", "retire_agent"];
  }
  if (turn.status === "working") {
    if (turn.cancellation_requested_at || turn.cleanup_requested_at) {
      return ["observe_bounded", "wait_bounded", "reconcile_exact_turn"];
    }
    return block
      ? ["observe_bounded", "wait_after_exact_block", "cancel_exact_turn"]
      : [
          "send_caller_keyed_input",
          "observe_bounded",
          "wait_bounded",
          "cancel_exact_turn",
        ];
  }
  if (["uncertain", "unsupported_transcript"].includes(turn.status)) {
    return ["observe_late_result", "reconcile_exact_turn", "retire_agent"];
  }
  return ["observe_exact_turn", "retire_agent"];
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
