import { readOnlySiblingPolicyIssue } from "./read-only-sibling-policy.mjs";
import { digest, freezeCanonical } from "./canonical.mjs";
import {
  applyRevisionGraphChanges,
  compileDynamicPlan,
  compilePredefinedFlowSelection,
  isPredefinedFlowSelection,
  snapshotPredefinedDefinitions,
} from "./plan-compiler.mjs";
import {
  createSpikeOutputValidators,
  SPIKE_RESEARCH_OUTPUT_VALIDATOR,
  SPIKE_REPORT_OUTPUT_VALIDATOR,
} from "./spike-flow.mjs";
import { createRejection } from "./rejection.mjs";
import { validateLaunchRequest } from "./launch-validation.mjs";
import {
  attachAuthorityBindingCatalogs,
  createInMemoryRunAuthority,
} from "./run-authority.mjs";
import {
  createAuthorityFact,
  snapshotPredefinedAuthorityCatalog,
  snapshotRegisteredAuthorities,
} from "./authority-bindings.mjs";
import {
  delegateCompatibilityIssue,
  dispatchDelegateEffect,
  snapshotDelegatedAgentPort,
  snapshotDelegatedAgentResourcePort,
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
  isReviewHumanCommand,
  projectReviewInbox,
  REVIEW_INBOX_QUERY_CONTRACT,
  GITHUB_REVIEW_OPERATION_CONTRACTS,
  GITHUB_REVIEW_PENDING_CHECKPOINT_ID,
  GITHUB_REVIEW_TARGET_SCHEMA,
  githubPendingEffectIdentity,
  reviewCandidateAuthorityIssue,
  REVIEW_DELEGATE_OUTPUT_VALIDATOR,
} from "./review-flow.mjs";
import { parseReviewDelegateResult } from "./review-rendering.mjs";
import { validateDelegateEvidenceSafety } from "./evidence-safety.mjs";
import {
  reviewExplicitFactsFromPreparationFacts,
  reviewPreparationFactsDigest,
  validateReviewPreparationFacts,
} from "./review-preparation-facts.mjs";
import {
  createFlowRuntimeRunner,
  FLOW_RUNTIME_BACKGROUND_WATCH,
} from "./flow-runtime-runner.mjs";

const hostRunAuthority = createInMemoryRunAuthority();
const runtimeRunners = new WeakMap();

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
  reviewPreparationProvider = null,
  delegatedAgentPort = null,
  delegatedAgentResourcePort = null,
  delegateOutputValidators = {},
  predefinedDefinitions = {},
  registeredAuthorities = {},
  reviewAuthority = null,
  githubReviewAuthority = null,
  githubReviewForge = null,
  githubReviewAdapter = null,
  autonomous = false,
  runnerOptions = {},
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
    evidenceSafety: validateDelegateEvidenceSafety,
  });
  const trustedSpikeOutputValidators = createSpikeOutputValidators();
  setRegisteredOperation(
    validatorInputs,
    SPIKE_RESEARCH_OUTPUT_VALIDATOR,
    trustedSpikeOutputValidators[SPIKE_RESEARCH_OUTPUT_VALIDATOR],
  );
  setRegisteredOperation(
    validatorInputs,
    SPIKE_REPORT_OUTPUT_VALIDATOR,
    trustedSpikeOutputValidators[SPIKE_REPORT_OUTPUT_VALIDATOR],
  );
  const delegateValidators = snapshotDelegateOutputValidators(validatorInputs);
  const delegatePort = snapshotDelegatedAgentPort(delegatedAgentPort);
  const delegateResourcePort = snapshotDelegatedAgentResourcePort(
    delegatedAgentResourcePort,
  );
  const requiredDrovrFeatures = snapshotRequiredDrovrFeatures();
  const predefinedRegistry = snapshotPredefinedDefinitions(predefinedDefinitions);
  const authorityRegistry = snapshotRegisteredAuthorities(registeredAuthorities);
  const predefinedAuthorityCatalog = snapshotPredefinedAuthorityCatalog(
    predefinedRegistry,
  );
  const preparationProvider = reviewPreparationProvider;
  attachAuthorityBindingCatalogs(runAuthority, {
    authorities: authorityRegistry,
    predefinedDefinitions: predefinedAuthorityCatalog,
  });
  operationRegistry.set(SUBRUN_CONTRACT, subrunRegistration);
  const compile = planCompiler === compileDynamicPlan
    ? (proposal) => compileDynamicPlan(proposal, {
        registeredOperations: operationRegistry,
      })
    : planCompiler;
  runtime = Object.freeze({
    prepare(proposal) {
      const preparedReview = prepareReviewSelectionWithFacts(
        proposal,
        preparationProvider,
      );
      if (preparedReview?.schema === "flow.rejection/v1") return preparedReview;
      proposal = preparedReview;
      if (isPredefinedFlowSelection(proposal)) {
        return compilePredefinedFlowSelection(
          proposal,
          predefinedRegistry.get(proposal.definition),
          {
            registeredOperations: operationRegistry,
            registeredAuthorities: authorityRegistry,
          },
        );
      }
      return compile(proposal);
    },

    launch(request) {
      const validation = validateLaunchRequest(request);
      if (validation.accepted &&
          validation.prepared?.selection?.inputs?.preparation_facts === undefined &&
          executionCards(validation.prepared).some((card) =>
            card.inputs?.target?.schema === "flow.review-local-candidate/v1")) {
        return createRejection({
          operation: "launch",
          code: "review_preparation_required",
          reason: "local review requires authority-derived preparation_facts",
          bundleDigest: validation.prepared.bundle_digest,
          authorityWatermark: runAuthority.query().watermark,
          authorityWatermarkDomain: "host",
          legalActions: [],
        });
      }
      const factsBoundReview = validation.accepted &&
        validation.prepared?.selection?.inputs?.preparation_facts !== undefined;
      const reviewAuthorityRejection = () => {
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
            const authorityFact = reviewAuthorityFact(issue.projection);
            return createRejection({
              operation: "launch",
              code: issue.code,
              reason: issue.reason,
              bundleDigest: validation.prepared.bundle_digest,
              authorityWatermark: host.watermark,
              authorityWatermarkDomain: "host",
              legalActions: authorityFact.legal_actions,
              authorityFact,
            });
          }
        }
        return null;
      };
      const launchValidated = () => {
        const authorityRejection = reviewAuthorityRejection();
        if (authorityRejection !== null) return authorityRejection;
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
              delegateResourcePort,
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
        const settlePreparation = (preparationIssue) => {
          if (preparationIssue !== null) {
            return reviewPreparationLaunchRejection(
              runAuthority,
              validation.prepared,
              preparationIssue,
            );
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
          return runAuthority.launch(request);
        };
        const preparationIssue = factsBoundReview
          ? null
          : revalidatePreparedReviewFacts(validation.prepared, preparationProvider);
        if (isPromiseLike(preparationIssue)) {
          return preparationIssue.then(settlePreparation);
        }
        return settlePreparation(preparationIssue);
      };
      if (validation.accepted && factsBoundReview) {
        const settleReviewPreparation = (preparationIssue) => {
          if (preparationIssue !== null) {
            return reviewPreparationLaunchRejection(
              runAuthority,
              validation.prepared,
              preparationIssue,
            );
          }
          const authorityRejection = reviewAuthorityRejection();
          if (authorityRejection !== null) return authorityRejection;
          const adopted = typeof runAuthority.adoptExactLaunch === "function"
            ? runAuthority.adoptExactLaunch(request)
            : null;
          return adopted !== null && adopted !== undefined
            ? adopted
            : launchValidated();
        };
        const preparationIssue = revalidatePreparedReviewFacts(
          validation.prepared,
          preparationProvider,
        );
        if (isPromiseLike(preparationIssue)) {
          return preparationIssue.then(settleReviewPreparation);
        }
        return settleReviewPreparation(preparationIssue);
      }
      if (validation.accepted) {
        // Non-review retries remain read-only and idempotent. A missing run
        // continues through every fresh compatibility and authority check.
        const adopted = typeof runAuthority.adoptExactLaunch === "function"
          ? runAuthority.adoptExactLaunch(request)
          : null;
        if (adopted !== null && adopted !== undefined) return adopted;
        return launchValidated();
      }
      const adopted = typeof runAuthority.adoptExactLaunch === "function"
        ? runAuthority.adoptExactLaunch(request)
        : null;
      if (adopted !== null && adopted !== undefined) return adopted;
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
      if (isReviewHumanCommand(command)) {
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
              resourcePort: delegateResourcePort,
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
        for (const effect of before?.effects ?? []) {
          const registration = registeredOperation(operationRegistry, effect.operation_contract);
          if (typeof registration?.requestCancellation === "function" &&
              effect.invocation_started !== false && !effect.receipt) {
            try { registration.requestCancellation({ run_id: before.run_id, effect_id: effect.effect_id }); }
            catch { /* The accepted cancellation remains authoritative; missing worker proof retains uncertainty. */ }
          }
        }
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
      if (isReviewPreparationFactsQuery(request)) {
        return dispatchReviewPreparationFactsQuery(
          request,
          preparationProvider,
          runAuthority,
        );
      }
      if (request?.query === "review_inbox") {
        if (!isExactReviewInboxRequest(request, "flow.query/v1")) {
          return reviewInboxRequestRejection(ownedReviewAuthority, "query");
        }
        return ownedReviewAuthority.query({
          contract: REVIEW_INBOX_QUERY_CONTRACT,
        });
      }
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
      const watchOptions = request?.[FLOW_RUNTIME_BACKGROUND_WATCH] === true
        ? { unrefPollTimer: true }
        : null;
      if (request?.query === "review_inbox") {
        if (!isExactReviewInboxRequest(request, "flow.watch/v1")) {
          return oneShotReviewObservation(
            reviewInboxRequestRejection(ownedReviewAuthority, "watch"),
          );
        }
        return oneShotReviewObservation(ownedReviewAuthority.query({
          contract: REVIEW_INBOX_QUERY_CONTRACT,
        }));
      }
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
        if (typeof runAuthority.watchHost === "function") {
          return watchOptions === null
            ? runAuthority.watchHost()
            : runAuthority.watchHost(watchOptions);
        }
        return watchOptions === null
          ? runAuthority.watch(undefined)
          : runAuthority.watch(undefined, watchOptions);
      }
      const runId = request?.run_id;
      const watcher = watchOptions === null
        ? runAuthority.watch(runId)
        : runAuthority.watch(runId, watchOptions);
      return decorateReviewRunWatcher(watcher);
    },
  });
  recoverOutstandingEffects(
    runtime,
    runAuthority,
    operationRegistry,
    subrunRegistration,
    {
      allowIndeterminateRecovery: !autonomous,
      allowOneShotRecovery: !autonomous,
    },
  );
  if (autonomous) {
    const runner = createFlowRuntimeRunner({
      runtime,
      runAuthority,
      ...runnerOptions,
    });
    runtimeRunners.set(runtime, runner);
    runner.start();
  }
  return runtime;
}

export function createAutonomousFlowRuntime(options = {}) {
  return createFlowRuntime({ ...options, autonomous: true });
}

export function startAutonomousFlowRuntime(runtime) {
  return runtimeRunners.get(runtime)?.start() ?? null;
}

export function statusAutonomousFlowRuntime(runtime) {
  return runtimeRunners.get(runtime)?.status() ?? null;
}

export function stopAutonomousFlowRuntime(runtime) {
  return runtimeRunners.get(runtime)?.stop();
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

function reviewAuthorityFact(projection) {
  const existing = isRecord(projection?.authority_fact)
    ? projection.authority_fact
    : {};
  const existingFacts = isRecord(existing.facts) ? existing.facts : {};
  let projectionDigest = null;
  try {
    projectionDigest = digest(projection);
  } catch {
    // Keep available authority identity even when the projection is malformed.
  }
  return createAuthorityFact({
    authorityId: "ReviewAuthority",
    authorityContract: "work.review/v1",
    providerIdentity: {
      schema: "flow.registered-authority/v1",
      id: "flow.production.review-authority",
      version: "1",
    },
    watermark: projection?.watermark ?? null,
    watermarkDomain: "review",
    subjectId: projection?.subject_id ?? null,
    disposition: projection?.status ?? null,
    generation: projection?.generation ?? null,
    facts: {
      ...existingFacts,
      candidate_fingerprint: projection?.candidate_fingerprint ?? null,
      workspace_subject_id: projection?.candidate?.workspace?.subject_id ?? null,
      workspace_generation: projection?.candidate?.workspace?.generation ?? null,
      workspace_fingerprint: projection?.candidate?.workspace?.fingerprint ?? null,
      projection_digest: projectionDigest,
    },
    legalActions: projection?.legal_actions ?? [],
  });
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

function isExactReviewInboxRequest(request, schema) {
  return request !== null && typeof request === "object" &&
    !Array.isArray(request) &&
    Object.keys(request).sort().join(",") === "query,schema" &&
    request.schema === schema && request.query === "review_inbox";
}

function reviewInboxRequestRejection(reviewAuthority, operation) {
  let current = null;
  try {
    current = reviewAuthority.query({
      contract: REVIEW_INBOX_QUERY_CONTRACT,
    });
  } catch {
    // A malformed public request must still produce a stable rejection when
    // the backing authority is unavailable or corrupt.
  }
  return createRejection({
    operation,
    code: "invalid_review_query",
    authorityWatermark: current?.watermark ?? null,
    authorityWatermarkDomain: "review",
    legalActions: [],
  });
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
  {
    allowIndeterminateRecovery = true,
    allowOneShotRecovery = true,
  } = {},
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
      if (!allowIndeterminateRecovery &&
          effect?.last_observation?.presence === "indeterminate") {
        continue;
      }
      if (!allowOneShotRecovery &&
          effect?.classification === "one_shot_uncertain") {
        continue;
      }
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

function isReviewPreparationFactsQuery(request) {
  return request?.query === "review_preparation_facts";
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isPublicReviewPreparationSelection(selection) {
  const selectionKeys = isRecord(selection) ? Reflect.ownKeys(selection) : [];
  if (!isRecord(selection) ||
      selection.schema !== "flow.review-preparation-selection/v1" ||
      !Array.isArray(selection.lenses) || selection.lenses.length === 0 ||
      !isRecord(selection.routes) || !isRecord(selection.routes.lenses) ||
      !isRecord(selection.routes.critic) ||
      selectionKeys.some((key) =>
        !["schema", "target", "lenses", "routes", "execution"].includes(key)) ||
      selection.target !== undefined &&
        (!isRecord(selection.target) ||
         Object.keys(selection.target).sort().join(",") !==
           "candidate_fingerprint,candidate_id" ||
         typeof selection.target.candidate_id !== "string" ||
         selection.target.candidate_id.length === 0 ||
         !isDigest(selection.target.candidate_fingerprint))) {
    return false;
  }
  if (selection.execution !== undefined && (readOnlySiblingPolicyIssue(selection.execution) !== null ||
      digest([...selection.execution.card_ids].sort()) !== digest(selection.lenses.map(lens => `review-lens-${lens}`).sort()))) return false;
  if (selection.lenses.some((lens) =>
    typeof lens !== "string" || lens.length === 0)) {
    return false;
  }
  if (Reflect.ownKeys(selection.routes).sort().join(",") !== "critic,lenses") {
    return false;
  }
  const selectedLenses = new Set(selection.lenses);
  if (selectedLenses.size !== selection.lenses.length ||
      Object.keys(selection.routes.lenses).some((lens) =>
        !selectedLenses.has(lens)) ||
      selection.lenses.some((lens) =>
        !Object.hasOwn(selection.routes.lenses, lens))) return false;
  const choices = [
    ...selection.lenses.map((lens) => selection.routes.lenses[lens]),
    selection.routes.critic,
  ];
  return choices.every((choice) => isPublicReviewRouteChoice(choice)) &&
    !containsReviewAuthorityFacts(selection);
}

function isPublicReviewRouteChoice(choice) {
  return isRecord(choice) &&
    Reflect.ownKeys(choice).every((key) =>
      ["launch", "description"].includes(key)) &&
    (choice.launch === undefined || isRecord(choice.launch)) &&
    (choice.description === undefined || isRecord(choice.description)) &&
    (choice.launch !== undefined || choice.description !== undefined);
}

function containsReviewAuthorityFacts(value) {
  const forbidden = new Set([
    "authority_bindings",
    "authority_facts",
    "catalog_fingerprint",
    "explicit_facts",
    "facts_digest",
    "preparation_facts",
    "resource_claims",
    "route_snapshot",
    "time_facts",
  ]);
  if (Array.isArray(value)) return value.some(containsReviewAuthorityFacts);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    forbidden.has(key) || containsReviewAuthorityFacts(nested));
}

function dispatchReviewPreparationFactsQuery(
  request,
  provider,
  runAuthority,
) {
  const required = [
    "schema",
    "query",
    "candidate_id",
    "candidate_fingerprint",
    "selection",
  ];
  const keys = isRecord(request) ? Reflect.ownKeys(request) : [];
  const candidateId = request?.candidate_id;
  const candidateFingerprint = request?.candidate_fingerprint;
  if (!isRecord(request) ||
      request.schema !== "flow.query/v1" ||
      keys.length !== required.length ||
      required.some((key) => !Object.hasOwn(request, key)) ||
      keys.some((key) => !required.includes(key)) ||
      typeof candidateId !== "string" || candidateId.length === 0 ||
      !isDigest(candidateFingerprint) ||
      !isPublicReviewPreparationSelection(request.selection)) {
    return hostQueryRejection(
      runAuthority,
      "invalid_review_preparation_query",
      "review preparation query must identify one exact candidate and bounded selection",
    );
  }
  if (typeof provider?.derive !== "function") {
    return hostQueryRejection(
      runAuthority,
      "review_preparation_unavailable",
      "review preparation facts authority is unavailable",
    );
  }
  const safeRequest = Object.freeze({
    schema: request.schema,
    query: request.query,
    ...(typeof request.candidate_id === "string"
      ? { candidate_id: request.candidate_id }
      : {}),
    ...(typeof request.candidate_fingerprint === "string"
      ? { candidate_fingerprint: request.candidate_fingerprint }
      : {}),
    selection: structuredClone(request.selection),
  });
  let result;
  try {
    result = provider.derive(safeRequest, { runAuthority });
  } catch (error) {
    return reviewPreparationProviderRejection(runAuthority, error);
  }
  if (isPromiseLike(result)) {
    return result.then((value) => normalizeReviewPreparationQueryResult(
      value,
      runAuthority,
      { candidateId, candidateFingerprint },
    )).catch((error) => reviewPreparationProviderRejection(
      runAuthority,
      error,
    ));
  }
  return normalizeReviewPreparationQueryResult(result, runAuthority, {
    candidateId,
    candidateFingerprint,
  });
}

function normalizeReviewPreparationQueryResult(
  result,
  runAuthority,
  { candidateId, candidateFingerprint } = {},
) {
  const rejection = reviewPreparationRejectionValue(result);
  if (rejection?.schema === "flow.rejection/v1") {
    return reviewPreparationIssueRejection(runAuthority, rejection);
  }
  if (result?.accepted === false) {
    return reviewPreparationIssueRejection(runAuthority, rejection);
  }
  const facts = result?.accepted === true ? result.facts : result;
  const validation = validateReviewPreparationFacts(facts);
  if (!validation.valid) {
    return reviewPreparationIssueRejection(
      runAuthority,
      validation.issues[0],
    );
  }
  if (facts.candidate.candidate_id !== candidateId ||
      facts.candidate.candidate_fingerprint !== candidateFingerprint) {
    return reviewPreparationIssueRejection(runAuthority, {
      code: "candidate_fingerprint_mismatch",
      reason: "review preparation facts do not match the requested candidate",
      authority_watermark: facts.candidate.authority_watermark,
      authority_watermark_domain: "candidate",
    });
  }
  return facts;
}

function reviewPreparationRejectionValue(value) {
  if (value?.schema === "flow.rejection/v1") return value;
  if (value?.rejection !== undefined) return value.rejection;
  if (value?.issue !== undefined) return value.issue;
  return value?.accepted === false ? value : null;
}

function reviewPreparationProviderRejection(runAuthority, error) {
  return reviewPreparationIssueRejection(runAuthority, {
    code: typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : "review_preparation_unavailable",
    reason: error?.reason ?? "review preparation facts authority is unavailable",
    legal_actions: error?.legal_actions ?? [],
    authority_watermark: error?.authority_watermark,
    authority_watermark_domain: error?.authority_watermark_domain,
    authority_fact: error?.authority_fact,
  });
}

function reviewPreparationIssueRejection(runAuthority, issue = {}) {
  const host = runAuthority?.query?.() ?? null;
  const topLevelDomain = ["host", "run"].includes(
    issue?.authority_watermark_domain,
  ) ? issue.authority_watermark_domain : "host";
  const authorityFact = sanitizeTerminalWorkspaceAuthorityFact(
    issue?.authority_fact,
  );
  const terminalWorkspace = isTerminalWorkspaceAuthorityFact(authorityFact);
  return createRejection({
    operation: "query",
    code: typeof issue?.code === "string"
      ? issue.code
      : "review_preparation_unavailable",
    reason: typeof issue?.reason === "string" ? issue.reason : null,
    authorityWatermark: topLevelDomain === "run"
      ? issue?.authority_watermark ?? host?.watermark ?? null
      : host?.watermark ?? null,
    authorityWatermarkDomain: topLevelDomain,
    legalActions: terminalWorkspace
      ? []
      : Array.isArray(issue?.legal_actions)
        ? issue.legal_actions
        : authorityFact?.legal_actions ?? [],
    authorityFact,
  });
}

function reviewPreparationLaunchRejection(runAuthority, prepared, issue) {
  const host = runAuthority.query();
  const sourceRunId = issue.authority_watermark_domain === "run" &&
      issue.authority_fact?.authority_id === "RunAuthority" &&
      issue.authority_fact.watermark_domain === "run" &&
      typeof issue.authority_fact.subject_id === "string"
    ? issue.authority_fact.subject_id
    : null;
  return createRejection({
    operation: "launch",
    code: issue.code,
    reason: issue.reason ?? null,
    runId: sourceRunId,
    bundleDigest: prepared.bundle_digest,
    authorityWatermark: sourceRunId === null
      ? host?.watermark ?? null
      : issue.authority_watermark ?? issue.authority_fact.watermark ?? null,
    authorityWatermarkDomain: sourceRunId === null ? "host" : "run",
    legalActions: issue.legal_actions ?? [],
    authorityFact: issue.authority_fact,
  });
}

function prepareReviewSelectionWithFacts(proposal, provider) {
  if (!isPredefinedFlowSelection(proposal) ||
      proposal.definition !== "review/v1" ||
      !isRecord(proposal.inputs)) {
    return proposal;
  }
  const localReview = proposal.inputs.target?.schema ===
    "flow.review-local-candidate/v1";
  if (localReview && proposal.inputs.preparation_facts === undefined) {
    return createRejection({
      operation: "prepare",
      code: "review_preparation_required",
      reason: "local review requires authority-derived preparation_facts",
      authorityWatermark: null,
      authorityWatermarkDomain: "host",
      legalActions: [],
    });
  }
  if (proposal.inputs.preparation_facts === undefined) return proposal;
  const facts = proposal.inputs.preparation_facts;
  const validation = validateReviewPreparationFacts(facts);
  if (!validation.valid) {
    const issue = validation.issues[0];
    return createRejection({
      operation: "prepare",
      code: issue?.code ?? "facts_changed",
      reason: issue?.reason ?? "review preparation facts are invalid",
      authorityWatermark: null,
      authorityWatermarkDomain: "host",
      legalActions: [],
    });
  }
  let explicitFacts;
  try {
    const materialized = typeof provider?.materialize === "function"
      ? provider.materialize({ facts, proposal })
      : null;
    if (isPromiseLike(materialized)) {
      return createRejection({
        operation: "prepare",
        code: "review_preparation_unavailable",
        reason: "review preparation materialization must be synchronous",
        authorityWatermark: facts.authority_watermarks.candidate,
        authorityWatermarkDomain: "candidate",
        legalActions: [],
      });
    }
    explicitFacts = materialized?.explicit_facts ?? materialized ??
      reviewExplicitFactsFromPreparationFacts(facts, {
        limits: proposal.inputs.limits,
      });
  } catch (error) {
    return createRejection({
      operation: "prepare",
      code: error?.code ?? "review_preparation_unavailable",
      reason: error?.reason ?? "review preparation facts could not be materialized",
      authorityWatermark: facts.authority_watermarks.candidate,
      authorityWatermarkDomain: "candidate",
      legalActions: [],
    });
  }
  return {
    ...proposal,
    explicit_facts: explicitFacts,
  };
}

export function revalidatePreparedReviewFacts(prepared, provider) {
  const facts = prepared?.selection?.inputs?.preparation_facts;
  if (facts === undefined) return null;
  const validation = validateReviewPreparationFacts(facts);
  if (!validation.valid) {
    return preparationLaunchIssue(validation.issues[0]);
  }
  const localTargets = [
    prepared.selection.inputs.target,
    ...(prepared.graph?.cards ?? []).map((card) => card.inputs?.target),
    ...(prepared.revision_templates ?? []).flatMap(({ changes }) =>
      (changes.add_cards ?? []).map((card) => card.inputs?.target)),
  ].filter((target) => target?.schema === "flow.review-local-candidate/v1");
  if (localTargets.some((target) =>
    target.candidate?.candidate_id !== facts.candidate.candidate_id ||
    target.candidate_fingerprint !== facts.candidate.candidate_fingerprint)) {
    return preparationLaunchIssue({
      code: "preparation_facts_candidate_mismatch",
      reason: "review preparation facts do not identify the exact review target",
    });
  }
  if (typeof provider?.revalidate !== "function") {
    return preparationLaunchIssue({
      code: "review_preparation_unavailable",
      reason: "review preparation owners cannot be revalidated",
    });
  }
  let result;
  try {
    result = provider.revalidate({
      facts,
      prepared,
      inputs: prepared.selection.inputs,
    });
  } catch (error) {
    return preparationLaunchIssue({
      code: error?.code ?? "review_preparation_unavailable",
      reason: error?.reason ?? "review preparation owner revalidation failed",
      legal_actions: error?.legal_actions,
      authority_watermark: error?.authority_watermark,
      authority_watermark_domain: error?.authority_watermark_domain,
      authority_fact: error?.authority_fact,
    });
  }
  const settle = (value) => {
    if (value?.valid === false || value?.accepted === false) {
      return preparationLaunchIssue(reviewPreparationRejectionValue(value));
    }
    const freshFacts = value?.valid === true || value?.accepted === true
      ? value.facts
      : value;
    const freshValidation = validateReviewPreparationFacts(freshFacts);
    if (!freshValidation.valid) {
      return preparationLaunchIssue(freshValidation.issues[0]);
    }
    if (reviewPreparationFactsDigest(freshFacts) !==
        reviewPreparationFactsDigest(facts)) {
      const changedOwner = ["run", "review", "workspace"].find((owner) =>
        digest(freshFacts?.owner_authorities?.[owner] ?? null) !==
          digest(facts?.owner_authorities?.[owner] ?? null)) ?? "review";
      const authorityFact = freshFacts?.owner_authorities?.[changedOwner];
      return preparationLaunchIssue({
        code: "facts_changed",
        reason: "review preparation authority facts changed",
        authority_watermark: authorityFact?.watermark ??
          freshFacts.authority_watermarks.candidate,
        authority_watermark_domain: authorityFact?.watermark_domain ?? "host",
        legal_actions: authorityFact?.legal_actions ?? [],
        authority_fact: authorityFact,
      });
    }
    return null;
  };
  if (isPromiseLike(result)) {
    return result.then(settle).catch((error) => preparationLaunchIssue({
      code: error?.code ?? "review_preparation_unavailable",
      reason: error?.reason ?? "review preparation owner revalidation failed",
      legal_actions: error?.legal_actions,
      authority_watermark: error?.authority_watermark,
      authority_watermark_domain: error?.authority_watermark_domain,
      authority_fact: error?.authority_fact,
    }));
  }
  return settle(result);
}

function preparationLaunchIssue(issue = {}) {
  const rejection = reviewPreparationRejectionValue(issue) ?? issue;
  const authorityFact = sanitizeTerminalWorkspaceAuthorityFact(
    rejection?.authority_fact,
  );
  const terminalWorkspace = isTerminalWorkspaceAuthorityFact(authorityFact);
  return {
    code: typeof rejection?.code === "string" ? rejection.code : "facts_changed",
    reason: typeof rejection?.reason === "string" ? rejection.reason : null,
    authority_watermark: rejection?.authority_watermark ?? null,
    authority_watermark_domain: rejection?.authority_watermark_domain ?? "host",
    legal_actions: terminalWorkspace
      ? []
      : Array.isArray(rejection?.legal_actions)
        ? rejection.legal_actions
        : [],
    authority_fact: authorityFact,
  };
}

function isTerminalWorkspaceAuthorityFact(authorityFact) {
  return authorityFact?.authority_contract === "work.workspace/v1" &&
    ["cleaned", "released", "disposed"].includes(authorityFact.disposition);
}

function sanitizeTerminalWorkspaceAuthorityFact(authorityFact) {
  return isTerminalWorkspaceAuthorityFact(authorityFact)
    ? { ...authorityFact, legal_actions: [] }
    : authorityFact;
}

function isPromiseLike(value) {
  return value !== null && (typeof value === "object" ||
    typeof value === "function") && typeof value.then === "function";
}
