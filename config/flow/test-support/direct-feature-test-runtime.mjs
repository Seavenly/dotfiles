import { readFileSync } from "node:fs";
import { codexExecutionAdapter } from "../../../tools/flow/src/codex-execution-adapter.mjs";

import { createFlowRuntime as createProductionRuntime } from "../src/runtime.mjs";

// This identity is fixture-only. It proves subprocess mechanics, not official
// Codex startup or permission enforcement, and is injected only by test code.
export const fixtureCodexAdapter = Object.freeze({
  ...codexExecutionAdapter,
  id: "flow.fixture-codex-exec",
  nativeQualificationIssue() { return null; },
  authorityIssue(context) {
    const issue = codexExecutionAdapter.authorityIssue(context);
    return issue === "codex_native_policy_unproven" ? null : issue;
  },
});

export function fixtureExecutionOptions(options = {}) {
  return { ...options, directExecutionOptions: {
    ...options.directExecutionOptions, providers: { codex: fixtureCodexAdapter },
  } };
}

// Only the sacrificial owner environment supplies this private host recipe.
// Public preparation still selects a check ID; every operation remains real.
export function createFlowRuntime(options = {}) {
  const path = options.env?.FLOW_FEATURE_TEST_FIXTURE_CONFIG;
  const featureTestCheck = path === undefined
    ? undefined
    : JSON.parse(readFileSync(path, "utf8"));
  return createProductionRuntime({ ...fixtureExecutionOptions(options), featureTestCheck });
}
