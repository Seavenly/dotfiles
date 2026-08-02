import { digest } from "./canonical.mjs";
import { compileDynamicPlan } from "./plan-compiler.mjs";
import { createRejection } from "./rejection.mjs";
import { validateLaunchRequest } from "./launch-validation.mjs";
import { createInMemoryRunAuthority } from "./run-authority.mjs";
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
} = {}) {
  if (registeredOperations === null ||
      !(registeredOperations instanceof Map) &&
      (typeof registeredOperations !== "object" ||
       Array.isArray(registeredOperations))) {
    throw new TypeError("registeredOperations must be an object or Map");
  }
  const operationRegistry = snapshotRegisteredOperations(registeredOperations);
  const compile = planCompiler === compileDynamicPlan
    ? (proposal) => compileDynamicPlan(proposal, {
        registeredOperations: operationRegistry,
      })
    : planCompiler;
  return Object.freeze({
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
        if (operationCards.some(({ executor }) => executor.kind === "operation") &&
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
      const registryRejection = recoveryRegistryRejection(
        command,
        operationRegistry,
        runAuthority,
      );
      if (registryRejection) return registryRejection;
      const receipt = runAuthority.command(command);
      for (const intent of receipt?.effect_intents ?? []) {
        dispatchRegisteredEffect(intent, operationRegistry, runAuthority, {
          recovery: command?.type === "recovery",
        });
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
}

function recoveryRegistryRejection(command, operationRegistry, runAuthority) {
  if (command?.type !== "recovery" || typeof command.run_id !== "string") {
    return null;
  }
  const projection = runAuthority.query(command.run_id);
  let isLegalRecovery = false;
  try {
    isLegalRecovery = projection?.legal_actions?.some((action) =>
      action.type === "recovery" && digest(action) === digest(command));
  } catch {
    return null;
  }
  if (!isLegalRecovery) return null;
  const effect = projection.effects.find(({ effect_id: effectId }) =>
    effectId === command.effect_id);
  const issue = operationRegistrationIssue(
    registeredOperation(operationRegistry, effect.operation_contract),
    effect.classification,
  );
  if (!issue) return null;
  return createRejection({
    operation: "command",
    code: issue,
    reason: effect.operation_contract,
    commandType: command.type,
    runId: command.run_id,
    bundleDigest: projection.bundle_digest,
    authorityWatermark: projection.watermark,
    authorityWatermarkDomain: "run",
    legalActions: projection.legal_actions,
  });
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
