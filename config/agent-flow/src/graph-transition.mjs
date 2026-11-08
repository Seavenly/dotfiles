export function instantiateTransition(transition, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > transition.max_instances) {
    throw new Error(`transition ${transition.key} instance is outside its declared cap`);
  }
  const stageKeys = new Set(transition.stages.map(({ key }) => key));
  const key = (value) => stageKeys.has(value) ? `${value}:${ordinal}` : value;
  return {
    key: transition.key,
    ordinal,
    stages: transition.stages.map((stage) => ({
      ...structuredClone(stage),
      key: key(stage.key),
      validates_handoff_for: stage.validates_handoff_for === null
        ? null
        : key(stage.validates_handoff_for),
    })),
    dependencies: transition.dependencies.map(({ parent, child }) => ({
      parent: key(parent),
      child: key(child),
    })),
  };
}

export function expandedTransitionStages(graph) {
  return graph.transitions.flatMap((transition) =>
    Array.from({ length: transition.max_instances }, (_, index) =>
      instantiateTransition(transition, index + 1).stages
    ).flat()
  );
}
