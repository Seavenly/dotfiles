const MAX_PLANNED_SLICES = 32;

export function compileFeatureGraph({
  slices,
  maxSliceRetries,
  maxCompletenessFixes,
  maxCritiqueFixes,
}) {
  requireNonNegativeInteger(maxSliceRetries, "maxSliceRetries");
  requireNonNegativeInteger(maxCompletenessFixes, "maxCompletenessFixes");
  requireNonNegativeInteger(maxCritiqueFixes, "maxCritiqueFixes");
  if (!Array.isArray(slices)) throw new Error("slices must be an array");
  if (slices.length > MAX_PLANNED_SLICES) {
    throw new Error(`feature plans support at most ${MAX_PLANNED_SLICES} slices`);
  }

  const graph = graphBuilder("feature", "feature-flow", "feature-root");
  graph.addStage(stage(
    "feature-root",
    "flow-controller",
    "run-dir",
    "feature-controller",
  ));

  let prior = null;
  if (slices.length === 0) {
    prior = graph.addProducer({
      key: "planner",
      profile: "analyst",
      workspace: "run-dir",
      skill: "feature-planner",
      semantic: true,
      after: prior,
    });
    prior = graph.addProducer({
      key: "plan-controller",
      profile: "flow-controller",
      workspace: "run-dir",
      skill: "feature-controller",
      maxAttempts: MAX_PLANNED_SLICES + 1,
      after: prior,
    });
    graph.addTransition(sliceTransition({
      key: "planned-slice",
      from: "plan-controller",
      suffix: "planned",
      maxInstances: MAX_PLANNED_SLICES,
    }));
  } else {
    for (const [index] of slices.entries()) {
      const ordinal = index + 1;
      prior = addSlice(graph, { ordinal, prior, maxSliceRetries });
      if (maxSliceRetries > 0) {
        graph.addTransition(sliceTransition({
          key: `slice-retry:${ordinal}`,
          from: `slice-controller:${ordinal}`,
          suffix: `retry-${ordinal}`,
          maxInstances: maxSliceRetries,
        }));
      }
    }
  }

  prior = graph.addProducer({
    key: "completeness",
    profile: "critic",
    workspace: "feature-worktree",
    skill: "feature-review",
    semantic: true,
    after: prior,
  });
  prior = graph.addProducer({
    key: "completeness-controller",
    profile: "flow-controller",
    workspace: "run-dir",
    skill: "feature-controller",
    maxAttempts: maxCompletenessFixes + 1,
    after: prior,
  });
  if (maxCompletenessFixes > 0) {
    graph.addTransition(fixTransition({
      key: "completeness-fix",
      from: "completeness-controller",
      suffix: "completeness-fix",
      maxInstances: maxCompletenessFixes,
      recheck: "completeness:fix",
    }));
  }
  prior = graph.addProducer({
    key: "independent-critic",
    profile: "critic",
    workspace: "feature-worktree",
    skill: "feature-review",
    semantic: true,
    after: prior,
  });
  prior = graph.addProducer({
    key: "critique-controller",
    profile: "flow-controller",
    workspace: "run-dir",
    skill: "feature-controller",
    maxAttempts: maxCritiqueFixes + 1,
    after: prior,
  });
  if (maxCritiqueFixes > 0) {
    graph.addTransition(fixTransition({
      key: "critique-fix",
      from: "critique-controller",
      suffix: "critique-fix",
      maxInstances: maxCritiqueFixes,
      recheck: "independent-critic:fix",
    }));
  }
  prior = graph.addProducer({
    key: "review-summary",
    profile: "artifact",
    workspace: "run-dir",
    skill: "feature-summary",
    after: prior,
  });
  prior = graph.addGate({
    key: "final-verification",
    workspace: "feature-worktree",
    skill: "feature-gate",
    after: prior,
  });
  prior = graph.addGate({
    key: "local-review-manifest",
    workspace: "run-dir",
    skill: "feature-gate",
    after: prior,
  });
  graph.connect(prior, "feature-root");
  return graph.document();
}

function fixTransition({ key, from, suffix, maxInstances, recheck }) {
  const transition = sliceTransition({ key, from, suffix, maxInstances });
  const gate = `gate:${suffix}`;
  transition.dependencies = transition.dependencies.filter(({ parent, child }) =>
    parent !== gate || child !== from
  );
  transition.stages.push(
    stage(recheck, "critic", "feature-worktree", "feature-review", { semantic: true }),
    validator(recheck),
  );
  transition.dependencies.push(
    edge(gate, recheck),
    edge(recheck, `validate-handoff:${recheck}`),
    edge(`validate-handoff:${recheck}`, from),
  );
  return transition;
}

function addSlice(graph, { ordinal, prior, maxSliceRetries }) {
  let tail = graph.addProducer({
    key: `tester:${ordinal}`,
    profile: "builder",
    workspace: "feature-worktree",
    skill: "feature-worker",
    after: prior,
  });
  tail = graph.addProducer({
    key: `builder:${ordinal}`,
    profile: "builder",
    workspace: "feature-worktree",
    skill: "feature-worker",
    after: tail,
  });
  tail = graph.addGate({
    key: `gate:${ordinal}`,
    workspace: "feature-worktree",
    skill: "feature-gate",
    after: tail,
  });
  return graph.addProducer({
    key: `slice-controller:${ordinal}`,
    profile: "flow-controller",
    workspace: "run-dir",
    skill: "feature-controller",
    maxAttempts: maxSliceRetries + 1,
    after: tail,
  });
}

function sliceTransition({ key, from, suffix, maxInstances }) {
  const tester = `tester:${suffix}`;
  const testerValidation = `validate-handoff:${tester}`;
  const builder = `builder:${suffix}`;
  const builderValidation = `validate-handoff:${builder}`;
  const gate = `gate:${suffix}`;
  return {
    key,
    from,
    max_instances: maxInstances,
    stages: [
      stage(tester, "builder", "feature-worktree", "feature-worker"),
      validator(tester),
      stage(builder, "builder", "feature-worktree", "feature-worker"),
      validator(builder),
      stage(gate, "gate", "feature-worktree", "feature-gate"),
    ],
    dependencies: [
      edge(tester, testerValidation),
      edge(testerValidation, builder),
      edge(builder, builderValidation),
      edge(builderValidation, gate),
      edge(gate, from),
    ],
  };
}

function graphBuilder(flow, name, root) {
  const stages = [];
  const dependencies = [];
  const transitions = [];
  return {
    addStage(value) {
      stages.push(value);
      return value.key;
    },
    connect(parent, child) {
      if (parent !== null) dependencies.push(edge(parent, child));
    },
    addProducer({
      key,
      profile,
      workspace,
      skill,
      semantic = false,
      maxAttempts = 1,
      after,
    }) {
      this.connect(after, key);
      stages.push(stage(key, profile, workspace, skill, { semantic, maxAttempts }));
      const validation = `validate-handoff:${key}`;
      stages.push(validator(key));
      dependencies.push(edge(key, validation));
      return validation;
    },
    addGate({ key, workspace, skill, after }) {
      this.connect(after, key);
      stages.push(stage(key, "gate", workspace, skill));
      return key;
    },
    addTransition(transition) {
      transitions.push(transition);
    },
    document() {
      return {
        schema: "agent-flow.graph/v1",
        name,
        version: 1,
        flow,
        root,
        stages,
        dependencies,
        transitions,
      };
    },
  };
}

function stage(
  key,
  profile,
  workspace,
  skill,
  { semantic = false, validates = null, maxAttempts = null } = {},
) {
  return {
    key,
    profile,
    workspace,
    skill,
    max_attempts: maxAttempts ?? (profile === "gate" ? 2 : 1),
    semantic_measurement: semantic,
    validates_handoff_for: validates,
    optional: false,
  };
}

function validator(producer) {
  return stage(
    `validate-handoff:${producer}`,
    "gate",
    "run-dir",
    "handoff-validator",
    { validates: producer },
  );
}

function edge(parent, child) {
  return { parent, child };
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
