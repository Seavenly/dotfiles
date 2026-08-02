import { digest } from "./canonical.mjs";
import {
  applyRevisionGraphChanges,
  compileDynamicPlan,
} from "./plan-compiler.mjs";
import { createRejection } from "./rejection.mjs";
import { validateLaunchRequest } from "./launch-validation.mjs";
import { createInMemoryRunAuthority } from "./run-authority.mjs";
import {
  delegateCompatibilityIssue,
  dispatchDelegateEffect,
  snapshotDelegatedAgentPort,
  snapshotDelegateOutputValidators,
  snapshotRequiredDrovrFeatures,
} from "./delegate-effects.mjs";
import {
  dispatchRegisteredEffect,
  operationRegistrationIssue,
  registeredOperation,
  snapshotRegisteredOperations,
} from "./operation-effects.mjs";

const hostRunAuthority = createInMemoryRunAuthority();

export function createFlowRuntime({
  planCompiler = compileDynamicPlan,
  runAuthority = hostRunAuthority,
  registeredOperations = {},
  registeredQueries = {},
  delegatedAgentPort = null,
  delegateOutputValidators = {},
} = {}) {
  if (registeredOperations === null ||
      !(registeredOperations instanceof Map) &&
      (typeof registeredOperations !== "object" ||
       Array.isArray(registeredOperations))) {
    throw new TypeError("registeredOperations must be an object or Map");
  }
  const operationRegistry = snapshotRegisteredOperations(registeredOperations);
  const delegateValidators = snapshotDelegateOutputValidators(
    delegateOutputValidators,
  );
  const delegatePort = snapshotDelegatedAgentPort(delegatedAgentPort);
  const requiredDrovrFeatures = snapshotRequiredDrovrFeatures();
  const compile = planCompiler === compileDynamicPlan
    ? (proposal) => compileDynamicPlan(proposal, {
        registeredOperations: operationRegistry,
      })
    : planCompiler;
  const runtime = Object.freeze({
    prepare(proposal) {
      return compile(proposal);
    },

    launch(request) {
      const validation = validateLaunchRequest(request);
      if (validation.accepted) {
        const operationCards = [
          ...validation.prepared.graph.cards,
          ...validation.prepared.revision_templates.flatMap(
            ({ changes }) => changes.add_cards,
          ),
        ];
        const incompatible = operationCards.map((card) => ({
          card,
          issue: card.executor.kind === "operation"
            ? operationRegistrationIssue(
                registeredOperation(operationRegistry, card.executor.contract),
                card.executor.effect_classification,
              )
            : null,
        })).find(({ issue }) => issue !== null);
        if (incompatible) {
          const host = runAuthority.query();
          return createRejection({
            operation: "launch",
            code: incompatible.issue,
            reason: incompatible.card.executor.contract,
            bundleDigest: validation.prepared.bundle_digest,
            authorityWatermark: host.watermark,
            authorityWatermarkDomain: "host",
          });
        }
        const invalidInput = operationValidationContexts(
          validation.prepared,
        ).find(({ card, proposal }) => {
          if (card.executor.kind !== "operation") return false;
          const registration = registeredOperation(
            operationRegistry,
            card.executor.contract,
          );
          if (typeof registration?.validateCard !== "function") return false;
          try {
            registration.validateCard(card, proposal);
            return false;
          } catch {
            return true;
          }
        });
        if (invalidInput) {
          const host = runAuthority.query();
          return createRejection({
            operation: "launch",
            code: "invalid_operation_input",
            reason: invalidInput.card.executor.contract,
            bundleDigest: validation.prepared.bundle_digest,
            authorityWatermark: host.watermark,
            authorityWatermarkDomain: "host",
          });
        }
        const incompatibleDelegate = operationCards
          .filter(({ executor }) => executor.kind === "delegate")
          .map((card) => ({
            card,
            issue: delegateCompatibilityIssue(
              card,
              delegatePort,
              delegateValidators,
              requiredDrovrFeatures,
            ),
          }))
          .find(({ issue }) => issue !== null);
        if (incompatibleDelegate) {
          const host = runAuthority.query();
          return createRejection({
            operation: "launch",
            code: incompatibleDelegate.issue,
            reason: incompatibleDelegate.card.id,
            bundleDigest: validation.prepared.bundle_digest,
            authorityWatermark: host.watermark,
            authorityWatermarkDomain: "host",
          });
        }
        if (operationCards.some(({ executor }) =>
          ["delegate", "operation"].includes(executor.kind)) &&
            typeof runAuthority.invokeEffect !== "function") {
          const host = runAuthority.query();
          return createRejection({
            operation: "launch",
            code: "durable_authority_required",
            reason: "registered operations require durable effect authority",
            bundleDigest: validation.prepared.bundle_digest,
            authorityWatermark: host.watermark,
            authorityWatermarkDomain: "host",
          });
        }
      }
      return runAuthority.launch(request);
    },

    command(command) {
      const registryRejection = commandRegistryRejection(
        command,
        operationRegistry,
        runAuthority,
      );
      if (registryRejection) return registryRejection;
      const receipt = runAuthority.command(command);
      for (const intent of receipt?.effect_intents ?? []) {
        if (["delegate", "delegate_cancellation"].includes(intent.effect_kind)) {
          dispatchDelegateEffect(
            intent,
            delegatePort,
            delegateValidators,
            runAuthority,
            {
              settleCancelled: intent.effect_kind === "delegate_cancellation" ||
                command?.type === "recovery" &&
                command.recovery === "settle_cancelled",
            },
          );
        } else {
          dispatchRegisteredEffect(intent, operationRegistry, runAuthority, {
            recovery: command?.type === "recovery" ? command.recovery : null,
          });
        }
      }
      return receipt;
    },

    query(request = {}) {
      if (request?.schema === "flow.query/v1") {
        return dispatchRegisteredQuery(request, registeredQueries, runAuthority);
      }
      return runAuthority.query(request?.run_id);
    },

    watch({ run_id: runId } = {}) {
      return runAuthority.watch(runId);
    },
  });
  recoverOutstandingEffects(runtime, runAuthority, operationRegistry);
  return runtime;
}

function operationValidationContexts(prepared) {
  const proposal = (graph) => ({
    graph,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
    revision_templates: prepared.revision_templates,
  });
  const contexts = prepared.graph.cards.map((card) => ({
    card,
    proposal: proposal(prepared.graph),
  }));
  for (const template of prepared.revision_templates) {
    const graph = applyRevisionGraphChanges(prepared.graph, template.changes);
    const revisedProposal = proposal(graph);
    contexts.push(...graph.cards.map((card) => ({
      card,
      proposal: revisedProposal,
    })));
  }
  return contexts;
}

function recoverOutstandingEffects(runtime, runAuthority, operationRegistry) {
  if (typeof runAuthority.pendingSameBootRecoveryRunIds !== "function") return;
  const runIds = runAuthority.pendingSameBootRecoveryRunIds();
  if (!Array.isArray(runIds)) return;
  // Keep this sweep synchronous through each pending-set update. Provider
  // settlement remains asynchronous, but another Interface cannot interleave.
  for (const runId of runIds) {
    const projection = runAuthority.query(runId);
    if (projection?.schema !== "flow.run-projection/v1") continue;
    if (projection.admission !== "admitted") continue;
    const outstandingEffects = [];
    let compatible = true;
    for (const action of projection.legal_actions ?? []) {
      if (action.type !== "recovery") continue;
      const effect = projection.effects.find(({ effect_id: effectId }) =>
        effectId === action.effect_id);
      const isDelegateEffect = ["delegate", "delegate_cancellation"].includes(
        effect?.effect_kind,
      );
      if (!effect || (!isDelegateEffect && operationRegistrationIssue(
        registeredOperation(operationRegistry, effect.operation_contract),
        effect.classification,
      ))) {
        compatible = false;
        break;
      }
      outstandingEffects.push(action.effect_id);
    }
    if (!compatible) continue;
    let accepted = true;
    for (const effectId of outstandingEffects) {
      const current = runAuthority.query(runId);
      const action = current?.legal_actions?.find((candidate) =>
        candidate.type === "recovery" && candidate.effect_id === effectId);
      if (!action || runtime.command(action)?.accepted !== true) {
        accepted = false;
        break;
      }
    }
    if (accepted) runAuthority.completeSameBootRecovery?.(runId);
  }
}

function commandRegistryRejection(command, operationRegistry, runAuthority) {
  if (!["checkpoint_decision", "operation_execute", "recovery"].includes(
    command?.type,
  ) || typeof command.run_id !== "string") {
    return null;
  }
  const projection = runAuthority.query(command.run_id);
  let isLegalCommand = false;
  try {
    isLegalCommand = projection?.legal_actions?.some((action) =>
      action.type === command.type && digest(action) === digest(command));
  } catch {
    return null;
  }
  // A miss is not authorization: RunAuthority still validates the command.
  if (!isLegalCommand) return null;
  const binding = operationBinding(command, projection);
  if (!binding) return null;
  const issue = operationRegistrationIssue(
    registeredOperation(operationRegistry, binding.contract),
    binding.classification,
  );
  if (!issue) return null;
  return createRejection({
    operation: "command",
    code: issue,
    reason: binding.contract,
    commandType: command.type,
    runId: command.run_id,
    bundleDigest: projection.bundle_digest,
    authorityWatermark: projection.watermark,
    authorityWatermarkDomain: "run",
    legalActions: projection.legal_actions,
  });
}

function operationBinding(command, projection) {
  if (command.type === "recovery") {
    const effect = projection.effects.find(({ effect_id: effectId }) =>
      effectId === command.effect_id);
    if (["delegate", "delegate_cancellation"].includes(effect?.effect_kind)) {
      return null;
    }
    return effect ? {
      classification: effect.classification,
      contract: effect.operation_contract,
    } : null;
  }
  let operationId = command.card_id;
  if (command.type === "checkpoint_decision") {
    if (command.decision !== "approve") return null;
    const checkpoint = projection.active_plan.cards.find(
      ({ id }) => id === command.checkpoint_id,
    );
    operationId = checkpoint?.inputs?.operation_card_id;
  }
  const operation = projection.active_plan.cards.find(({ executor, id }) =>
    id === operationId && executor.kind === "operation");
  const operationState = projection.cards.find(({ id }) => id === operationId);
  const expectedStatus = command.type === "operation_execute"
    ? "ready"
    : "pending";
  if (!operation || operationState?.status !== expectedStatus) return null;
  return {
    classification: operation.executor.effect_classification,
    contract: operation.executor.contract,
  };
}

function dispatchRegisteredQuery(request, registeredQueries, runAuthority) {
  if (!Object.hasOwn(registeredQueries, request.query)) {
    return hostQueryRejection(runAuthority, "unsupported_query");
  }
  const handler = registeredQueries[request.query];
  if (typeof handler !== "function") {
    return hostQueryRejection(runAuthority, "unsupported_query");
  }
  try {
    return Promise.resolve(handler(request)).catch((error) => {
      if (typeof error?.code !== "string") throw error;
      return hostQueryRejection(runAuthority, error.code, error.reason ?? null);
    });
  } catch (error) {
    if (typeof error?.code !== "string") throw error;
    return hostQueryRejection(runAuthority, error.code, error.reason ?? null);
  }
}

function hostQueryRejection(runAuthority, code, reason = null) {
  const hostProjection = runAuthority.query();
  return createRejection({
    operation: "query",
    code,
    reason,
    authorityWatermark: hostProjection.watermark,
    authorityWatermarkDomain: "host",
  });
}
