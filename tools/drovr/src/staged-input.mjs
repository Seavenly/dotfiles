import { DrovrError } from "./errors.mjs";
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
  loadRegistryRelationships,
} from "./registry-relationships.mjs";
import { ownedStagedTurn } from "./staged-input-receipt.mjs";

export async function inspectAgentStagedInput(agentId, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const context = await stagedInputContext(registryDirectory, agentId);
  const harness = client(context, env, dependencies);
  const availability = await harness.observeAgent(context.agent);
  if (availability.evidence === "absent") {
    throw new DrovrError(
      `Herdr session ${context.group.herdr.session} is not running`,
      { code: 0, outcome: "session_missing" },
    );
  }
  const observed = await settledOwnedAgent(context, harness);
  return inspectContext(registryDirectory, context, harness, observed);
}

export async function stageUnknownAgentInput(
  agentId,
  { text },
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const initial = await stagedInputContext(registryDirectory, agentId);
  const harness = client(initial, env, dependencies);
  if ((await harness.observeAgent(initial.agent)).evidence === "absent") {
    throw new DrovrError(
      `Herdr session ${initial.group.herdr.session} is not running`,
      { code: 0, outcome: "session_missing" },
    );
  }
  return withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(initial.task.id),
    () =>
      withResourceLock(
        registryDirectory,
        `agent-key:${initial.task.id}:${initial.agent.key}`,
        async () => {
          const context = await stagedInputContext(registryDirectory, agentId);
          const observed = await settledOwnedAgent(context, harness);
          const before = await inspectContext(
            registryDirectory,
            context,
            harness,
            observed,
          );
          if (before.status !== "ready") {
            throw blocked("managed Claude agent already has staged input");
          }
          const turns = await readRecords(registryDirectory, "turns");
          if (
            turns.some(
              (candidate) =>
                candidate.agent_id === agentId &&
                candidate.status === "working",
            )
          ) {
            throw new DrovrError(
              `agent ${agentId} already has an open logical turn`,
              { code: 0, outcome: "task_busy" },
            );
          }
          const staged = await harness.stageUnknownInput({
            agent: context.agent,
            text,
          });
          if (
            staged.outcome !== "staged_input" ||
            staged.snapshot?.display_text !== text
          ) {
            throw blocked("staged input differs from the authorized text");
          }
          return inspectContext(
            registryDirectory,
            context,
            harness,
            staged,
          );
        },
      ),
  );
}

export async function recoverAgentStagedInput(
  agentId,
  { action, token },
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const registryDirectory = stateDirectory(env);
  const initial = await stagedInputContext(registryDirectory, agentId);
  const harness = client(initial, env, dependencies);
  await harness.ensureRuntime();
  return withResourceLock(
    registryDirectory,
    taskLifecycleLockKey(initial.task.id),
    () =>
      withResourceLock(
        registryDirectory,
        `agent-key:${initial.task.id}:${initial.agent.key}`,
        async () => {
          const context = await stagedInputContext(registryDirectory, agentId);
          const observed = await settledOwnedAgent(context, harness);
          const inspected = await inspectContext(
            registryDirectory,
            context,
            harness,
            observed,
          );
          if (
            inspected.status !== "staged_input" ||
            inspected.staged_input.token !== token
          ) {
            throw blocked("staged input changed after inspection");
          }
          const clearsUnknown = action === "clear_unknown";
          if (
            inspected.staged_input.ownership !== "drovr" &&
            !clearsUnknown
          ) {
            throw blocked("staged input is not proven to be Drovr-owned");
          }
          const turns = await readRecords(registryDirectory, "turns");
          if (
            turns.some(
              (candidate) =>
                candidate.agent_id === agentId &&
                candidate.status === "working",
            )
          ) {
            throw new DrovrError(
              `agent ${agentId} already has an open logical turn`,
              { code: 0, outcome: "task_busy" },
            );
          }
          const turn = inspected.staged_input.turn_id
            ? turns.find(({ id }) => id === inspected.staged_input.turn_id)
            : null;
          if (!clearsUnknown && (!turn || turn.status !== "uncertain")) {
            throw blocked("the owning logical turn is no longer recoverable");
          }
          const recovered = await harness.recoverStagedInput({
            agent: context.agent,
            action: clearsUnknown ? "clear" : action,
            token: inspected.staged_input.snapshot_token,
          });
          if (!["submitted", "cleared"].includes(recovered.outcome)) {
            throw new DrovrError(
              recovered.error ?? "staged-input recovery was not confirmed",
              {
                code: 0,
                outcome: recovered.outcome ?? "uncertain",
                details: recovered,
              },
            );
          }
          if (turn) {
            turn.staged_input.recovery = {
              action: action === "submit" ? "submitted" : "cleared",
              recovered_at: now(),
            };
            await writeRecord(registryDirectory, "turns", turn);
          }
          return {
            ...context,
            status: action === "submit" ? "submitted" : "cleared",
            staged_input: inspected.staged_input,
            ...(turn ? { turn } : {}),
          };
        },
      ),
  );
}

async function inspectContext(registryDirectory, context, harness, observed) {
  const stagedResult = observed?.snapshot
    ? observed
    : await harness.inspectStagedInput({ agent: context.agent });
  const staged = stagedResult.snapshot;
  if (!staged) return { ...context, status: "ready", observed };
  const turns = await readRecords(registryDirectory, "turns");
  const ownedTurn = turns.find(
    (turn) => ownedStagedTurn(turn, context.agent, staged),
  );
  return {
    ...context,
    status: "staged_input",
    observed,
    staged_input: {
      display_text: staged.display_text,
      snapshot_token: staged.token,
      token: ownedTurn?.staged_input.token ?? staged.token,
      ownership: ownedTurn ? "drovr" : "unknown",
      ...(ownedTurn ? { turn_id: ownedTurn.id } : {}),
      actions: ownedTurn
        ? [
            {
              action: "submit",
              command: `drovr agent staged-input ${context.agent.id} --submit ${ownedTurn.staged_input.token}`,
            },
            {
              action: "clear",
              command: `drovr agent staged-input ${context.agent.id} --clear ${ownedTurn.staged_input.token}`,
            },
          ]
        : [
            {
              action: "clear_unknown",
              command: `drovr agent staged-input ${context.agent.id} --clear-unknown ${staged.token}`,
            },
          ],
    },
  };
}

async function stagedInputContext(registryDirectory, agentId) {
  const registry = await loadRegistryRelationships(registryDirectory);
  const context = agentRelationship(registry, agentId);
  if (!context) {
    throw new DrovrError(`active agent not found: ${agentId}`, {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  if (
    context.agent.status !== "active" ||
    context.task.status !== "active" ||
    context.group.status !== "active"
  ) {
    throw new DrovrError(`agent ${agentId} is no longer active`, {
      code: 0,
      outcome: "agent_lost",
    });
  }
  if (context.agent.launch.harness !== "claude") {
    throw new DrovrError("staged-input recovery is only available for Claude", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  return context;
}

async function settledOwnedAgent(context, harness) {
  const observation = await harness.observeAgent(context.agent);
  if (observation.evidence === "absent") {
    throw blocked("managed Claude agent is not present");
  }
  if (observation.evidence !== "present") {
    throw blocked("managed Claude identity does not match the registry");
  }
  if (!["idle", "done"].includes(observation.state)) {
    throw new DrovrError("managed Claude agent is not settled", {
      code: 0,
      outcome: "task_busy",
    });
  }
  return observation;
}

function client(context, env, dependencies) {
  return semanticHarnessFor(context, { ...dependencies, env });
}

function blocked(message) {
  return new DrovrError(message, { code: 0, outcome: "recovery_blocked" });
}
