import { readFileSync } from "node:fs";

import { createFlowRuntime as createProductionRuntime } from "../src/runtime.mjs";

// Only the sacrificial owner environment supplies this private host recipe.
// Public preparation still selects a check ID; every operation remains real.
export function createFlowRuntime(options = {}) {
  const path = options.env?.FLOW_FEATURE_TEST_FIXTURE_CONFIG;
  const featureTestCheck = path === undefined
    ? undefined
    : JSON.parse(readFileSync(path, "utf8"));
  return createProductionRuntime({ ...options, featureTestCheck });
}
