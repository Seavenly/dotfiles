import { digest } from "./canonical.mjs";
import {
  applyRevisionGraphChanges,
  compileDynamicPlan,
  compilePredefinedFlowSelection,
  isPredefinedFlowSelection,
  snapshotPredefinedDefinitions,
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
import {
  createSubrunRegistration,
  SUBRUN_CONTRACT,
} from "./subrun-effects.mjs";
import { isBackupRestoreCommand } from "./backup-restore.mjs";
import {
  getReviewAuthority,
  getRunEffectIntentReader,
} from "./work-authority.mjs";
import {
  createInMemoryReviewAuthority,
  createReviewOperationRegistration,
  reviewCandidateAuthorityIssue,
  REVIEW_DELEGATE_OUTPUT_VALIDATOR,
} from "./review-flow.mjs";

const hostRunAuthority = createInMemoryRunAuthority();

export function createFlowRuntime({
  planCompiler = compileDynamicPlan,
  runAuthority = hostRunAuthority,
  registeredOperations = {},
  registeredQueries = {},
  delegatedAgentPort = null,
  delegateOutputValidators = {},
  predefinedDefinitions = {},
  reviewAuthority = null,
} = {}) {
  if (registeredOperations === null ||
      !(registeredOperations instanceof Map) &&
      (typeof registeredOperations !== "object" ||
       Array.isArray(registeredOperations))) {
    throw new TypeError("registeredOperations must be an object or Map");
  }
  let runtime;
  const subrunRegistration = createSubrunRegistration({
    getRuntime: () => runtime,
    runAuthority,
  });
  const ownedReviewAuthority = reviewAuthority ?? attachedReviewAuthority(runAuthority) ??
    createInMemoryReviewAuthority({
      sourceEffectIntentReader: attachedEffectIntentReader(runAuthority),
    });
  const operationInputs = registeredOperations instanceof Map
    ? new Map(registeredOperations)
    : { ...registeredOperations };
  // ReviewAuthority owns this built-in operation. A caller-supplied entry is
  // deliberately replaced by the trusted registration so an injected
  // operation cannot bypass candidate, evidence, or completion authority.
  setRegisteredOperation(
    operationInputs,
    "flow.operation/review-record/v1",
    createReviewOperationRegistration({
      reviewAuthority: ownedReviewAuthority,
    }),
  );
  const operationRegistry = snapshotRegisteredOperations(operationInputs);
  const validatorInputs = delegateOutputValidators instanceof Map
    ? new Map(delegateOutputValidators)
    : { ...delegateOutputValidators };
  if (!registeredOperationPresent(validatorInputs, REVIEW_DELEGATE_OUTPUT_VALIDATOR)) {
    setRegisteredOperation(validatorInputs, REVIEW_DELEGATE_OUTPUT_VALIDATOR, {
      validate(output) {
        try {
          const value = typeof output === "string" ? JSON.parse(output) : output;
          return value?.schema === "flow.review-result/v1" &&
            Array.isArray(value.findings);
        } catch {
          return false;
        }
      },
    });
  }
  const delegateValidators = snapshotDelegateOutputValidators(validatorInputs);
  const delegatePort = snapshotDelegatedAgentPort(delegatedAgentPort);
  const requiredDrovrFeatures = snapshotRequiredDrovrFeatures();
  const predefinedRegistry = snapshotPredefinedDefinitions(predefinedDefinitions);
  operationRegistry.set(SUBRUN_CONTRACT, subrunRegistration);
  const compile = planCompiler === compileDynamicPlan
    ? (proposal) => compileDynamicPlan(proposal, {
        registeredOperations: operationRegistry,
      })
    : planCompiler;
  runtime = Object.freeze({
    prepare(proposal) {
      if (isPredefinedFlowSelection(proposal)) {
        return compilePredefinedFlowSelection(
          proposal,
          predefinedRegistry.get(proposal.definition),
          { registeredOperations: operationRegistry },
        );
      }
      return compile(proposal);
    },

    launch(request) {
      const validation = validateLaunchRequest(request);
      if (validation.accepted) {
        const reviewTargets = executionCards(validation.prepared)
          .map((card) => card.inputs?.target)
          .filter((target) => target?.schema === "flow.review-local-candidate/v1");
        for (const reviewTarget of reviewTargets) {
          const issue = reviewCandidateAuthorityIssue(
            reviewTarget,
            ownedReviewAuthority,
          );
          if (issue) {
            const host = runAuthority.query();
            return createRejection({
              operation: "launch",
              code: issue.code,
              reason: issue.reason,
              bundleDigest: validation.prepared.bundle_digest,
              authorityWatermark: issue.projection?.watermark ?? host.watermark,
              authorityWatermarkDomain: issue.projection?.schema ===
                "work.review-candidate-projection/v1" ? "review" : "host",
              legalActions: issue.projection?.legal_actions ?? [],
            });
          }
        }
        const operationCards = executionCards(validation.prepared);
        const incompatible = operationCards.map((card) => ({
          card,
          issue: ["operation", "subrun"].includes(card.executor.kind)
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
          ["delegate", "operation", "subrun"].includes(executor.kind)) &&
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
      if (isBackupRestoreCommand(command)) {
        if (typeof runAuthority.hostCommand !== "function") {
          const host = runAuthority.query();
          return createRejection({
            operation: "command",
            code: "unsupported_host_command",
            commandType: typeof command?.type === "string"
              ? command.type
              : null,
            authorityWatermark: host.watermark,
            authorityWatermarkDomain: "host",
            legalActions: host.legal_actions ?? host.restore?.legal_actions ??
              host.backup?.legal_actions ?? [],
          });
        }
        return runAuthority.hostCommand(command);
      }
      const before = typeof command?.run_id === "string"
        ? runAuthority.query(command.run_id)
        : null;
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
              settleCancelled:
                (intent.effect_kind === "delegate_cancellation" &&
                  intent.settlement_phase !== "declined") ||
                (command?.type === "recovery" &&
                  command.recovery === "settle_cancelled"),
            },
          );
        } else {
          dispatchRegisteredEffect(intent, operationRegistry, runAuthority, {
            recovery: command?.type === "recovery" ? command.recovery : null,
          });
        }
      }
      if (receipt?.accepted === true && command?.type === "cancel") {
        for (const subrun of before?.subruns ?? []) {
          const intent = before.effects?.find(({ card_id: cardId }) =>
            cardId === subrun.card_id);
          if (!intent) continue;
          const completeIntent = subrunIntentForEffect(before, intent.effect_id);
          if (completeIntent) subrunRegistration.requestCancellation(completeIntent);
        }
      }
      if (receipt?.accepted === true && command?.type === "recovery" &&
          command.recovery === "settle_cancelled") {
        const completeIntent = subrunIntentForEffect(before, command.effect_id);
        if (completeIntent) subrunRegistration.requestCancellation(completeIntent);
      }
      return receipt;
    },

    query(request = {}) {
      const reviewSubject = reviewRequestSubject(request);
      if (reviewSubject !== null) {
        return ownedReviewAuthority.query({
          contract: "work.review/v1",
          subject_id: reviewSubject,
        });
      }
      if (request?.schema === "flow.query/v1") {
        return dispatchRegisteredQuery(request, registeredQueries, runAuthority);
      }
      return runAuthority.query(request?.run_id);
    },

    watch(request = {}) {
      const reviewSubject = reviewRequestSubject(request);
      if (reviewSubject !== null) {
        return typeof ownedReviewAuthority.watch === "function"
          ? ownedReviewAuthority.watch({ subject_id: reviewSubject })
          : oneShotReviewObservation(ownedReviewAuthority.query({
              contract: "work.review/v1",
              subject_id: reviewSubject,
            }));
      }
      if (request?.host === true) {
        return typeof runAuthority.watchHost === "function"
          ? runAuthority.watchHost()
          : runAuthority.watch(undefined);
      }
      const runId = request?.run_id;
      return runAuthority.watch(runId);
    },
  });
  recoverOutstandingEffects(
    runtime,
    runAuthority,
    operationRegistry,
    subrunRegistration,
  );
  return runtime;
}

function registeredOperationPresent(registry, contract) {
  return registry instanceof Map
    ? registry.has(contract) && registry.get(contract) != null
    : Object.hasOwn(registry ?? {}, contract) && registry[contract] != null;
}

function attachedReviewAuthority(runAuthority) {
  try {
    return getReviewAuthority({ runAuthority });
  } catch {
    return null;
  }
}

function attachedEffectIntentReader(runAuthority) {
  try {
    return getRunEffectIntentReader({ runAuthority });
  } catch {
    return null;
  }
}

function setRegisteredOperation(registry, contract, registration) {
  if (registry instanceof Map) registry.set(contract, registration);
  else registry[contract] = registration;
}

function reviewRequestSubject(request) {
  if (request?.review_id || request?.contract === "work.review/v1") {
    return request.review_id ?? request.subject_id;
  }
  if ((request?.schema === "flow.query/v1" || request?.schema === "flow.watch/v1") &&
      ["review", "review/v1"].includes(request.query)) {
    return request.review_id ?? request.subject_id;
  }
  return null;
}

function oneShotReviewObservation(value) {
  let emitted = false;
  return {
    async next() {
      if (emitted) return { value: undefined, done: true };
      emitted = true;
      return { value, done: false };
    },
    async return() { emitted = true; return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

function executionCards(prepared) {
  const cards = [];
  const pending = [prepared];
  const seenBundles = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seenBundles.has(current.bundle_digest)) continue;
    seenBundles.add(current.bundle_digest);
    const currentCards = [
      ...current.graph.cards,
      ...current.revision_templates.flatMap(({ changes }) => changes.add_cards),
    ];
    cards.push(...currentCards);
    pending.push(...currentCards
      .filter(({ executor }) => executor.kind === "subrun")
      .map(({ inputs }) => inputs.child_launch_request.prepared));
  }
  return cards;
}

function operationValidationContexts(prepared) {
  const contexts = [];
  const pending = [prepared];
  const seenBundles = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seenBundles.has(current.bundle_digest)) continue;
    seenBundles.add(current.bundle_digest);
    const proposal = (graph) => ({
      graph,
      requested_authority: current.requested_authority,
      explicit_facts: current.explicit_facts,
      revision_templates: current.revision_templates,
    });
    const graphs = [current.graph];
    for (const template of current.revision_templates) {
      graphs.push(applyRevisionGraphChanges(current.graph, template.changes));
    }
    for (const graph of graphs) {
      contexts.push(...graph.cards.map((card) => ({
        card,
        proposal: proposal(graph),
      })));
    }
    const currentCards = [
      ...current.graph.cards,
      ...current.revision_templates.flatMap(({ changes }) => changes.add_cards),
    ];
    pending.push(...currentCards
      .filter(({ executor }) => executor.kind === "subrun")
      .map(({ inputs }) => inputs.child_launch_request.prepared));
  }
  return contexts;
}

function subrunIntentForEffect(projection, effectId) {
  const effect = projection.effects?.find(({ effect_id: id }) => id === effectId);
  if (effect?.operation_contract !== SUBRUN_CONTRACT) return null;
  const subrun = projection.subruns?.find(({ card_id: cardId }) =>
    cardId === effect?.card_id);
  if (!effect || !subrun) return null;
  return {
    run_id: projection.run_id,
    card_id: subrun.card_id,
    card_identity: subrun.card_identity,
    revision_ordinal: subrun.revision_ordinal,
  };
}

function recoverOutstandingEffects(
  runtime,
  runAuthority,
  operationRegistry,
  subrunRegistration,
) {
  if (typeof runAuthority.pendingSameBootRecoveryRunIds !== "function") return;
  const runIds = runAuthority.pendingSameBootRecoveryRunIds();
  if (!Array.isArray(runIds)) return;
  // Keep this sweep synchronous through each pending-set update. Provider
  // settlement remains asynchronous, but another Interface cannot interleave.
  for (const runId of runIds) {
    const projection = runAuthority.query(runId);
    if (projection?.schema !== "flow.run-projection/v1") continue;
    if (projection.admission !== "admitted" &&
        !(projection.phase === "cancelled" &&
          projection.admission === "released")) continue;
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
      if (!action) {
        accepted = false;
        break;
      }
      const effect = current.effects.find(({ effect_id: currentEffectId }) =>
        currentEffectId === effectId);
      const subrun = current.subruns.find(({ card_id: cardId }) =>
        cardId === effect?.card_id);
      if (effect?.operation_contract === SUBRUN_CONTRACT &&
          ["active", "admission_pending"].includes(subrun?.status)) {
        // Subrun resume owns the initial observation, admission repair,
        // terminal waiting, and final recovery without a competing caller.
        void subrunRegistration.resume({
          effect_id: effectId,
          run_id: current.run_id,
          card_id: subrun.card_id,
          card_identity: subrun.card_identity,
          revision_ordinal: subrun.revision_ordinal,
        }).catch(() => {});
        continue;
      }
      if (runtime.command(action)?.accepted !== true) {
        accepted = false;
        break;
      }
    }
    if (accepted) runAuthority.completeSameBootRecovery?.(runId);
  }
}

function commandRegistryRejection(command, operationRegistry, runAuthority) {
  if (!["checkpoint_decision", "operation_execute", "subrun_execute", "recovery"].includes(
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
    id === operationId && ["operation", "subrun"].includes(executor.kind));
  const operationState = projection.cards.find(({ id }) => id === operationId);
  const expectedStatus = ["operation_execute", "subrun_execute"].includes(
    command.type,
  )
    ? "ready"
    : "pending";
  if (!operation || operationState?.status !== expectedStatus) return null;
  return {
    classification: operation.executor.effect_classification,
    contract: operation.executor.contract,
  };
}

function dispatchRegisteredQuery(request, registeredQueries, runAuthority) {
  if (request?.query === "backup") {
    return runAuthority.query()?.backup ?? hostQueryRejection(
      runAuthority,
      "backup_unavailable",
    );
  }
  if (request?.query === "restore") {
    return runAuthority.query()?.restore ?? hostQueryRejection(
      runAuthority,
      "restore_unavailable",
    );
  }
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
