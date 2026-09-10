import { digest, freezeCanonical } from "./canonical.mjs";
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
  buildGitHubPendingDraft,
  createInMemoryReviewAuthority,
  createInMemoryGitHubReviewAuthority,
  createGitHubReviewOperationRegistration,
  createReviewOperationRegistration,
  isReviewTargetInvalidationCommand,
  isReviewTargetRefreshCommand,
  GITHUB_REVIEW_OPERATION_CONTRACTS,
  GITHUB_REVIEW_PENDING_CHECKPOINT_ID,
  GITHUB_REVIEW_TARGET_SCHEMA,
  githubPendingEffectIdentity,
  reviewCandidateAuthorityIssue,
  REVIEW_DELEGATE_OUTPUT_VALIDATOR,
} from "./review-flow.mjs";
import { parseReviewDelegateResult } from "./review-rendering.mjs";

const hostRunAuthority = createInMemoryRunAuthority();

export function validateReviewDelegateOutput(output, context = {}) {
  try {
    const lens = typeof context.card_id === "string" &&
        context.card_id.startsWith("review-lens-")
      ? context.card_id.slice("review-lens-".length)
      : null;
    parseReviewDelegateResult(output, {
      lens,
      role: lens === null ? "critic" : "lens",
    });
    return true;
  } catch {
    return false;
  }
}

export function createFlowRuntime({
  planCompiler = compileDynamicPlan,
  runAuthority = hostRunAuthority,
  registeredOperations = {},
  registeredQueries = {},
  delegatedAgentPort = null,
  delegateOutputValidators = {},
  predefinedDefinitions = {},
  reviewAuthority = null,
  githubReviewAuthority = null,
  githubReviewForge = null,
  githubReviewAdapter = null,
} = {}) {
  if (githubReviewAdapter !== null) {
    throw new TypeError(
      "FlowRuntime accepts a raw githubReviewForge, not a registered operation",
    );
  }
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
  const ownedGitHubReviewAuthority = githubReviewAuthority ??
    (attachedReviewAuthority(runAuthority)?.schema === "work.review-authority/v1"
      ? ownedReviewAuthority
      : createInMemoryGitHubReviewAuthority({
          sourceEffectIntentReader: attachedEffectIntentReader(runAuthority),
        }));
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
      githubReviewAuthority: ownedGitHubReviewAuthority,
    }),
  );
  if (githubReviewForge !== null) {
    setRegisteredOperation(
      operationInputs,
      GITHUB_REVIEW_OPERATION_CONTRACTS.pending,
      createGitHubReviewOperationRegistration({
        forge: githubReviewForge,
      }),
    );
  }
  const operationRegistry = snapshotRegisteredOperations(operationInputs);
  const validatorInputs = delegateOutputValidators instanceof Map
    ? new Map(delegateOutputValidators)
    : { ...delegateOutputValidators };
  // This validator is part of the trusted review boundary. A caller may
  // register validators for other contracts, but cannot replace the parser
  // that decides whether review evidence is accepted.
  setRegisteredOperation(validatorInputs, REVIEW_DELEGATE_OUTPUT_VALIDATOR, {
    validate: validateReviewDelegateOutput,
  });
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
                card.inputs.provider_receipt_validator,
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
      if (isReviewTargetInvalidationCommand(command)) {
        return ownedReviewAuthority.command(command);
      }
      if (isReviewTargetRefreshCommand(command)) {
        return ownedReviewAuthority.command(command);
      }
      const before = typeof command?.run_id === "string"
        ? runAuthority.query(command.run_id)
        : null;
      const checkpointBinding = githubCheckpointDraftBinding(before, command);
      if (checkpointBinding?.code || checkpointBinding?.missing) {
        return createRejection({
          operation: "command",
          code: checkpointBinding.code,
          reason: checkpointBinding.reason,
          commandType: command?.type ?? null,
          runId: command?.run_id ?? null,
          bundleDigest: before?.bundle_digest,
          authorityWatermark: before?.watermark,
          authorityWatermarkDomain: "run",
          legalActions: decorateReviewRunProjection(before)?.legal_actions ?? [],
        });
      }
      const authorityCommand = checkpointBinding === null
        ? command
        : bindCheckpointDraft(command, checkpointBinding);
      const registryRejection = commandRegistryRejection(
        authorityCommand,
        operationRegistry,
        runAuthority,
      );
      if (registryRejection) return registryRejection;
      const receipt = runAuthority.command(authorityCommand);
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
                (authorityCommand?.type === "recovery" &&
                  authorityCommand.recovery === "settle_cancelled"),
            },
          );
        } else {
          dispatchRegisteredEffect(intent, operationRegistry, runAuthority, {
            recovery: authorityCommand?.type === "recovery"
              ? authorityCommand.recovery
              : null,
          });
        }
      }
      if (receipt?.accepted === true && authorityCommand?.type === "cancel") {
        for (const subrun of before?.subruns ?? []) {
          const intent = before.effects?.find(({ card_id: cardId }) =>
            cardId === subrun.card_id);
          if (!intent) continue;
          const completeIntent = subrunIntentForEffect(before, intent.effect_id);
          if (completeIntent) subrunRegistration.requestCancellation(completeIntent);
        }
      }
      if (receipt?.accepted === true && authorityCommand?.type === "recovery" &&
          authorityCommand.recovery === "settle_cancelled") {
        const completeIntent = subrunIntentForEffect(before, authorityCommand.effect_id);
        if (completeIntent) subrunRegistration.requestCancellation(completeIntent);
      }
      return receipt;
    },

    query(request = {}) {
      const reviewSubject = reviewRequestSubject(request);
      if (reviewSubject !== null) {
        const authority = ownedGitHubReviewAuthority.query({
          contract: "work.review/v1",
          subject_id: reviewSubject,
        });
        if (authority?.schema !== "flow.rejection/v1" ||
            authority.code !== "unknown_subject") {
          return decorateGitHubReviewProjection(
            authority,
            runAuthority,
          );
        }
        return ownedReviewAuthority.query({
          contract: "work.review/v1",
          subject_id: reviewSubject,
        });
      }
      if (request?.schema === "flow.query/v1") {
        return dispatchRegisteredQuery(request, registeredQueries, runAuthority);
      }
      return decorateReviewRunProjection(runAuthority.query(request?.run_id));
    },

    watch(request = {}) {
      const reviewSubject = reviewRequestSubject(request);
      if (reviewSubject !== null) {
        const githubProjection = ownedGitHubReviewAuthority.query({
          contract: "work.review/v1",
          subject_id: reviewSubject,
        });
        if (githubProjection?.schema !== "flow.rejection/v1" ||
            githubProjection.code !== "unknown_subject") {
          const projection = decorateGitHubReviewProjection(
            githubProjection,
            runAuthority,
          );
          return oneShotReviewObservation(projection);
        }
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
      return decorateReviewRunWatcher(runAuthority.watch(runId));
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

function decorateReviewRunProjection(projection) {
  if (projection?.schema !== "flow.run-projection/v1") return projection;
  const activePlan = projection.active_plan === null ||
      projection.active_plan === undefined
    ? projection.active_plan
    : {
        ...projection.active_plan,
        cards: projection.active_plan.cards.map((card) => {
          if (card.id !== GITHUB_REVIEW_PENDING_CHECKPOINT_ID) return card;
          const binding = githubCheckpointDraftBinding(projection, {
            type: "checkpoint_decision",
            checkpoint_id: card.id,
          }, { validateCommand: false });
          if (binding?.code || !binding?.draft) return card;
          return {
            ...card,
            inputs: {
              ...card.inputs,
              draft: binding.draft,
              draft_digest: binding.draft_digest,
            },
          };
        }),
      };
  const legalActions = projection.legal_actions.flatMap((action) => {
    const binding = githubCheckpointDraftBinding(projection, action, {
      validateCommand: false,
    });
    if (binding?.code === "github_review_checkpoint_draft_unavailable") return [];
    if (binding === null || binding.code || !binding.draft) return [action];
    return [{
      ...action,
      draft: binding.draft,
      draft_digest: digest(binding.draft),
    }];
  });
  return freezeCanonical({ ...projection, active_plan: activePlan, legal_actions: legalActions });
}

function decorateReviewRunWatcher(watcher) {
  return {
    async next(...args) {
      const result = await watcher.next(...args);
      return result.done
        ? result
        : { ...result, value: decorateReviewRunProjection(result.value) };
    },
    async return(...args) {
      return typeof watcher.return === "function"
        ? watcher.return(...args)
        : { value: undefined, done: true };
    },
    async throw(...args) {
      if (typeof watcher.throw === "function") return watcher.throw(...args);
      throw args[0];
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

function githubCheckpointDraftBinding(
  projection,
  command,
  { validateCommand = true } = {},
) {
  if (projection?.schema !== "flow.run-projection/v1" ||
      command?.type !== "checkpoint_decision") return null;
  const checkpoint = projection.active_plan?.cards?.find(({ id }) =>
    id === command.checkpoint_id);
  if (checkpoint?.id !== GITHUB_REVIEW_PENDING_CHECKPOINT_ID ||
      checkpoint.inputs?.operation_card_id !== "review-github-pending") {
    return null;
  }
  const pending = projection.active_plan.cards.find(({ id }) =>
    id === "review-github-pending");
  const target = pending?.inputs?.target;
  const recordEffect = projection.effects?.find(({ card_id: cardId }) =>
    cardId === "review-record");
  const summary = recordEffect?.receipt?.provider_receipt?.summary;
  const identity = githubPendingEffectIdentity({ runId: projection.run_id });
  if (target?.schema !== GITHUB_REVIEW_TARGET_SCHEMA ||
      !summary || !identity) {
    return {
      code: "github_review_checkpoint_draft_unavailable",
      reason: "the exact settled GitHub pending-review draft is unavailable",
    };
  }
  let draft;
  try {
    draft = buildGitHubPendingDraft({
      target,
      summary,
      intent: { idempotency_key: identity.idempotency_key },
    });
  } catch (error) {
    return {
      code: error.code ?? "github_review_checkpoint_draft_unavailable",
      reason: error.message,
    };
  }
  if (!validateCommand) return { draft, draft_digest: digest(draft) };
  if (!Object.hasOwn(command, "draft") &&
      !Object.hasOwn(command, "draft_digest")) {
    return {
      draft,
      draft_digest: digest(draft),
      missing: true,
      code: "github_review_checkpoint_draft_mismatch",
      reason: "checkpoint decision must include the exact rendered GitHub draft",
    };
  }
  if (!isCanonicalEqual(command.draft, draft) ||
      command.draft_digest !== digest(draft)) {
    return {
      code: "github_review_checkpoint_draft_mismatch",
      reason: "checkpoint decision is not bound to the exact rendered GitHub draft",
      draft,
    };
  }
  return { draft, draft_digest: digest(draft) };
}

function bindCheckpointDraft(command, binding) {
  if (!isRecord(command)) return command;
  const { draft: _draft, draft_digest: _draftDigest, ...authorityCommand } = command;
  return {
    ...authorityCommand,
    checkpoint_binding: {
      schema: "flow.checkpoint-binding/v1",
      checkpoint_id: command.checkpoint_id,
      draft: binding.draft,
      draft_digest: binding.draft_digest,
    },
  };
}

function isCanonicalEqual(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decorateGitHubReviewProjection(
  projection,
  runAuthority,
) {
  if (projection?.schema !== "flow.review-projection/v1" ||
      projection.target_kind !== "github") return projection;
  const runProjection = typeof projection.source_run_id === "string"
    ? runAuthority.query(projection.source_run_id)
    : null;
  const pendingEffect = runProjection?.effects?.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  const providerObservation = pendingEffect?.last_observation?.provider_observation;
  const providerReceipt = pendingEffect?.receipt?.outcome === "succeeded"
    ? pendingEffect.receipt.provider_receipt
    : null;
  const remoteReview = githubRemoteReviewProjection(
    projection.remote_review,
    providerReceipt,
  );
  const invalidation = providerObservation?.code === "github_review_target_moved"
      ? {
        intent: { run_id: projection.source_run_id },
        target: projection.target,
        code: providerObservation.code,
        reason: providerObservation.reason,
        target_observation: providerObservation.target_observation ?? null,
      }
      : null;
  if (!invalidation) {
    return remoteReview === projection.remote_review
      ? projection
      : freezeCanonical({ ...projection, remote_review: remoteReview });
  }
  const safeActions = (runProjection?.legal_actions ?? []).filter(({ type }) =>
    ["recovery", "cancel"].includes(type));
  const runWatermark = runProjection?.watermark ?? null;
  return freezeCanonical({
    ...projection,
    status: "invalidated",
    posture: "blocked",
    automated_completion: false,
    automated_evidence_status: "invalidated",
    approval: "blocked",
    integration_authorized: false,
    merge_authorized: false,
    tracker_completion_authorized: false,
    remote_submission_authorized: false,
    remote_review: {
      ...remoteReview,
      status: "invalidated",
      submitted: false,
    },
    review_authority_watermark: projection.watermark,
    invalidation: {
      schema: "flow.github-review-invalidation/v1",
      code: invalidation.code,
      reason: invalidation.reason,
      run_id: invalidation.intent?.run_id ?? projection.source_run_id,
      run_authority_watermark: runWatermark,
      review_authority_watermark: projection.watermark,
      target_observation: invalidation.target_observation ?? null,
      history_preserved: true,
    },
    legal_actions: safeActions,
  });
}

function githubRemoteReviewProjection(remoteReview, providerReceipt) {
  if (!isRecord(providerReceipt) ||
      providerReceipt.schema !== "flow.github-review-receipt/v1" ||
      providerReceipt.action !== "create_pending_review" ||
      providerReceipt.state !== "pending" ||
      providerReceipt.submitted !== false ||
      typeof providerReceipt.review_id !== "string" ||
      providerReceipt.review_id.length === 0) {
    return remoteReview;
  }
  const receiptIdentity = {
    schema: providerReceipt.schema,
    effect_id: providerReceipt.effect_id,
    idempotency_key: providerReceipt.idempotency_key,
    review_id: providerReceipt.review_id,
    target_fingerprint: providerReceipt.target_fingerprint,
    target_authority_watermark: providerReceipt.target_authority_watermark,
    draft_digest: providerReceipt.draft_digest,
  };
  return {
    ...remoteReview,
    status: "created",
    state: "pending",
    submitted: false,
    review_id: providerReceipt.review_id,
    effect_id: providerReceipt.effect_id,
    idempotency_key: providerReceipt.idempotency_key,
    target_fingerprint: providerReceipt.target_fingerprint,
    target_authority_watermark: providerReceipt.target_authority_watermark,
    draft_digest: providerReceipt.draft_digest,
    receipt_identity: receiptIdentity,
  };
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
      const operationCard = projection.active_plan.cards.find(({ id }) =>
        id === effect?.card_id);
      if (!effect || (!isDelegateEffect && operationRegistrationIssue(
        registeredOperation(operationRegistry, effect.operation_contract),
        effect.classification,
        operationCard?.inputs?.provider_receipt_validator,
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
    binding.providerReceiptValidator,
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
      providerReceiptValidator: projection.active_plan.cards.find(({ id }) =>
        id === effect.card_id)?.inputs?.provider_receipt_validator,
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
    providerReceiptValidator: operation.inputs.provider_receipt_validator,
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
