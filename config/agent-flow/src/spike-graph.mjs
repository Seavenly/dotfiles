export function compileSpikeGraph({
  mode,
  angles,
  maxRevisions,
  maxPrototypeRetries = 0,
  prototype,
}) {
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
    throw new Error("maxRevisions must be a non-negative integer");
  }
  if (!Array.isArray(angles)) throw new Error("angles must be an array");
  if (!Number.isInteger(maxPrototypeRetries) || maxPrototypeRetries < 0) {
    throw new Error("maxPrototypeRetries must be a non-negative integer");
  }
  if (!new Set(["quick", "deep"]).has(mode)) throw new Error(`unknown spike mode: ${mode}`);
  const stages = [stage("spike-root", "flow-controller", "run-dir", "spike-controller")];
  const dependencies = [];
  const transitions = [];

  let tails;
  if (mode === "quick") {
    tails = [addProducer(stages, dependencies, {
      key: "research",
      profile: "analyst",
      workspace: "run-dir",
      skill: "spike-research",
      semantic: true,
    })];
  } else {
    if (angles.length === 0) throw new Error("deep spikes require at least one angle");
    const uniqueAngles = [...new Set(angles)];
    if (uniqueAngles.length !== angles.length) throw new Error("spike angles must be unique");
    tails = uniqueAngles.map((angle) => addProducer(stages, dependencies, {
      key: `angle:${angle}`,
      profile: "analyst",
      workspace: "run-dir",
      skill: "spike-research",
      semantic: true,
    }));
    const critic = stage("gap-critic", "critic", "run-dir", "spike-review", {
      semantic: true,
    });
    stages.push(critic, validator("gap-critic"));
    for (const tail of tails) dependencies.push(edge(tail, "gap-critic"));
    dependencies.push(edge("gap-critic", "validate-handoff:gap-critic"));
    const controller = stage(
      "gap-controller",
      "flow-controller",
      "run-dir",
      "spike-controller",
      { maxAttempts: maxRevisions + 1 },
    );
    stages.push(controller, validator("gap-controller"));
    dependencies.push(
      edge("validate-handoff:gap-critic", "gap-controller"),
      edge("gap-controller", "validate-handoff:gap-controller"),
    );
    tails = ["validate-handoff:gap-controller"];
    if (maxRevisions > 0) {
      transitions.push({
        key: "gap-revision",
        from: "gap-controller",
        max_instances: maxRevisions,
        stages: [
          stage("angle:revision", "analyst", "run-dir", "spike-research", {
            semantic: true,
          }),
          validator("angle:revision"),
        ],
        dependencies: [
          edge("angle:revision", "validate-handoff:angle:revision"),
          edge("validate-handoff:angle:revision", "gap-controller"),
        ],
      });
    }
  }

  if (prototype) {
    let tail = addProducer(stages, dependencies, {
      key: "prototype-planner",
      profile: "analyst",
      workspace: "run-dir",
      skill: "spike-research",
      after: tails,
    });
    const slices = Array.isArray(prototype.slices) ? prototype.slices : [{ id: "prototype" }];
    for (const [index] of slices.entries()) {
      const ordinal = index + 1;
      tail = addProducer(stages, dependencies, {
        key: `prototype-tester:${ordinal}`,
        profile: "builder",
        workspace: "feature-worktree",
        skill: "feature-worker",
        after: tail,
      });
      tail = addProducer(stages, dependencies, {
        key: `prototype-builder:${ordinal}`,
        profile: "builder",
        workspace: "feature-worktree",
        skill: "feature-worker",
        after: tail,
      });
      const gate = stage(
        `prototype-gate:${ordinal}`,
        "gate",
        "feature-worktree",
        "feature-gate",
      );
      stages.push(gate);
      dependencies.push(edge(tail, gate.key));
      tail = addProducer(stages, dependencies, {
        key: `prototype-controller:${ordinal}`,
        profile: "flow-controller",
        workspace: "run-dir",
        skill: "spike-controller",
        maxAttempts: maxPrototypeRetries + 1,
        after: gate.key,
      });
      if (maxPrototypeRetries > 0) {
        transitions.push({
          key: `prototype-retry:${ordinal}`,
          from: `prototype-controller:${ordinal}`,
          max_instances: maxPrototypeRetries,
          stages: [
            stage(`prototype-tester:retry-${ordinal}`, "builder", "feature-worktree", "feature-worker"),
            validator(`prototype-tester:retry-${ordinal}`),
            stage(`prototype-builder:retry-${ordinal}`, "builder", "feature-worktree", "feature-worker"),
            validator(`prototype-builder:retry-${ordinal}`),
            stage(`prototype-gate:retry-${ordinal}`, "gate", "feature-worktree", "feature-gate"),
          ],
          dependencies: [
            edge(`prototype-tester:retry-${ordinal}`, `validate-handoff:prototype-tester:retry-${ordinal}`),
            edge(`validate-handoff:prototype-tester:retry-${ordinal}`, `prototype-builder:retry-${ordinal}`),
            edge(`prototype-builder:retry-${ordinal}`, `validate-handoff:prototype-builder:retry-${ordinal}`),
            edge(`validate-handoff:prototype-builder:retry-${ordinal}`, `prototype-gate:retry-${ordinal}`),
            edge(`prototype-gate:retry-${ordinal}`, `prototype-controller:${ordinal}`),
          ],
        });
      }
    }
    tails = [tail];
  }
  const synthesis = stage("synthesis", "artifact", "run-dir", "spike-synthesis");
  stages.push(synthesis, validator("synthesis"));
  for (const tail of tails) dependencies.push(edge(tail, "synthesis"));
  dependencies.push(
    edge("synthesis", "validate-handoff:synthesis"),
  );
  stages.push(stage("spike-finalize", "gate", "run-dir", "feature-gate"));
  dependencies.push(
    edge("validate-handoff:synthesis", "spike-finalize"),
    edge("spike-finalize", "spike-root"),
  );
  return {
    schema: "agent-flow.graph/v1",
    name: "spike-flow",
    version: 1,
    flow: "spike",
    root: "spike-root",
    stages,
    dependencies,
    transitions,
  };
}

function addProducer(stages, dependencies, {
  key,
  profile,
  workspace,
  skill,
  semantic = false,
  maxAttempts = 1,
  after = [],
}) {
  stages.push(stage(key, profile, workspace, skill, { semantic, maxAttempts }), validator(key));
  for (const parent of Array.isArray(after) ? after : [after]) {
    if (parent) dependencies.push(edge(parent, key));
  }
  dependencies.push(edge(key, `validate-handoff:${key}`));
  return `validate-handoff:${key}`;
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
