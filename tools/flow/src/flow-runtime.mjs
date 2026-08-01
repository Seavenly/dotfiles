import { compileDynamicPlan } from "./plan-compiler.mjs";
import { createRejection } from "./rejection.mjs";
import { createInMemoryRunAuthority } from "./run-authority.mjs";

const hostRunAuthority = createInMemoryRunAuthority();

export function createFlowRuntime({
  planCompiler = compileDynamicPlan,
  runAuthority = hostRunAuthority,
  registeredQueries = {},
} = {}) {
  return Object.freeze({
    prepare(proposal) {
      return planCompiler(proposal);
    },

    launch(request) {
      return runAuthority.launch(request);
    },

    command(command) {
      return runAuthority.command(command);
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
