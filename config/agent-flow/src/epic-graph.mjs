export function compileEpicGraph({ featureCount, maxSourceRefreshes = 1 }) {
  if (!Number.isInteger(featureCount) || featureCount < 1) {
    throw new Error("epic graph requires a positive feature count");
  }
  if (!Number.isInteger(maxSourceRefreshes) || maxSourceRefreshes < 1) {
    throw new Error("epic graph requires a positive source refresh cap");
  }
  const stages = [
    stage("epic-root", "flow-controller", "run-dir", "epic-controller", { maxAttempts: featureCount + 2 }),
    stage("epic-plan", "analyst", "run-dir", "epic-planner", { semantic: true }),
    validator("epic-plan"),
    stage("epic-controller", "flow-controller", "run-dir", "epic-controller", { maxAttempts: featureCount + 2 }),
    validator("epic-controller"),
    stage("source-verification", "gate", "integration-worktree", "feature-gate"),
    stage("stack-plan-checkpoint", "flow-controller", "run-dir", "epic-controller", { maxAttempts: maxSourceRefreshes + 1 }),
    validator("stack-plan-checkpoint"),
  ];
  const dependencies = [
    edge("epic-plan", "validate-handoff:epic-plan"),
    edge("validate-handoff:epic-plan", "epic-controller"),
    edge("epic-controller", "validate-handoff:epic-controller"),
    edge("validate-handoff:epic-controller", "source-verification"),
    edge("source-verification", "stack-plan-checkpoint"),
    edge("stack-plan-checkpoint", "validate-handoff:stack-plan-checkpoint"),
    edge("validate-handoff:stack-plan-checkpoint", "epic-root"),
  ];
  const transitions = [{
    key: "source-refresh",
    from: "stack-plan-checkpoint",
    max_instances: maxSourceRefreshes,
    stages: [
      stage("source-refresh-builder", "builder", "integration-worktree", "feature-worker"),
      validator("source-refresh-builder"),
      stage("source-refresh-gate", "gate", "integration-worktree", "feature-gate"),
      stage("source-refresh-review", "critic", "integration-worktree", "feature-review", { semantic: true }),
      validator("source-refresh-review"),
    ],
    dependencies: [
      edge("source-refresh-builder", "validate-handoff:source-refresh-builder"),
      edge("validate-handoff:source-refresh-builder", "source-refresh-gate"),
      edge("source-refresh-gate", "source-refresh-review"),
      edge("source-refresh-review", "validate-handoff:source-refresh-review"),
      edge("validate-handoff:source-refresh-review", "stack-plan-checkpoint"),
    ],
  }];
  return {
    schema: "agent-flow.graph/v1", name: "epic-flow", version: 1, flow: "epic",
    root: "epic-root", stages, dependencies, transitions,
  };
}

function stage(key, profile, workspace, skill, { semantic = false, validates = null, maxAttempts = null } = {}) {
  return {
    key, profile, workspace, skill,
    max_attempts: maxAttempts ?? (profile === "gate" ? 2 : 1),
    semantic_measurement: semantic, validates_handoff_for: validates, optional: false,
  };
}
function validator(producer) {
  return stage(`validate-handoff:${producer}`, "gate", "run-dir", "handoff-validator", { validates: producer });
}
function edge(parent, child) { return { parent, child }; }
