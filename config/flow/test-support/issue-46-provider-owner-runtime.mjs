import {
  createIssue46ProviderRuntime,
} from "../src/host-recovery-provider-scenarios.mjs";

/**
 * Pinned detached-owner injection used only by the issue-46 provider probes.
 * The probe's provider is constructed inside this owner process, so public
 * CLI clients cannot replace or bypass the provider seam.
 */
export async function createFlowRuntime(options = {}) {
  return createIssue46ProviderRuntime(options);
}
