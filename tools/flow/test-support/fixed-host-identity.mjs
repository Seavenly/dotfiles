import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { executionTimeFacts } from "./time-facts.mjs";

export function fixedHostIdentity(bootId, processIdentity) {
  return Object.freeze({
    observe() {
      return Object.freeze({
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      });
    },
  });
}

export function createFixedTimeDurableRunAuthority(options = {}) {
  const bootId = options.hostIdentityAdapter?.observe?.().boot_id ?? "boot-a";
  return createDurableRunAuthority({
    timeObservationAdapter: fixedExecutionTimeAdapter({ bootId }),
    ...options,
  });
}

export function fixedExecutionTimeAdapter({
  bootId = "boot-a",
  wallValueMs = 1_700_000_000_000,
} = {}) {
  return Object.freeze({
    observe() {
      return Object.freeze(executionTimeFacts({ wallValueMs, bootId }));
    },
  });
}
