import { compileDynamicPlan } from "./plan-compiler.mjs";
import { createRejection } from "./rejection.mjs";
import { validateLaunchRequest } from "./launch-validation.mjs";
import { createInMemoryRunAuthority } from "./run-authority.mjs";
import {
  dispatchRegisteredEffect,
  hasRegisteredOperation,
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
  const compile = planCompiler === compileDynamicPlan
    ? (proposal) => compileDynamicPlan(proposal, { registeredOperations })
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
        const unregistered = operationCards.find((card) =>
          card.executor.kind === "operation" &&
          !hasRegisteredOperation(registeredOperations, card.executor.contract));
        if (unregistered) {
          const host = runAuthority.query();
          return createRejection({
            operation: "launch",
            code: "unregistered_operation_contract",
            reason: unregistered.executor.contract,
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
      const receipt = runAuthority.command(command);
      for (const intent of receipt?.effect_intents ?? []) {
        dispatchRegisteredEffect(intent, registeredOperations, runAuthority, {
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
