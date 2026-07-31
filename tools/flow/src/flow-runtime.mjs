import { compileDynamicPlan } from "./plan-compiler.mjs";
import { createInMemoryRunAuthority } from "./run-authority.mjs";

const hostRunAuthority = createInMemoryRunAuthority();

export function createFlowRuntime({
  planCompiler = compileDynamicPlan,
  runAuthority = hostRunAuthority,
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

    query({ run_id: runId } = {}) {
      return runAuthority.query(runId);
    },

    watch({ run_id: runId }) {
      return runAuthority.watch(runId);
    },
  });
}
