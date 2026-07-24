export function enabledReviewStages(graph, urgency) {
  if (urgency !== "hotfix") return graph.stages;
  const byKey = new Map(graph.stages.map((stage) => [stage.key, stage]));
  return graph.stages.filter((stage) => {
    if (stage.optional) return false;
    if (!stage.validates_handoff_for) return true;
    return !byKey.get(stage.validates_handoff_for)?.optional;
  });
}

export function materializationOrder(graph, urgency = "hotfix") {
  const enabled = enabledReviewStages(graph, urgency);
  const enabledKeys = new Set(enabled.map(({ key }) => key));
  const root = enabled.find(({ key }) => key === graph.root);
  if (!root) throw new Error("review graph root is not enabled");
  const ordered = [root];
  const created = new Set([root.key]);
  const remaining = new Map(
    enabled.filter(({ key }) => key !== root.key).map((stage) => [stage.key, stage]),
  );
  const dependencies = graph.dependencies.filter(({ parent, child }) =>
    enabledKeys.has(parent) && enabledKeys.has(child)
  );
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((stage) => dependencies
        .filter(({ child }) => child === stage.key)
        .every(({ parent }) => created.has(parent)))
      .sort((left, right) => left.key.localeCompare(right.key));
    if (ready.length === 0) {
      throw new Error("review graph does not have a complete materialization order");
    }
    for (const stage of ready) {
      ordered.push(stage);
      created.add(stage.key);
      remaining.delete(stage.key);
    }
  }
  return ordered;
}
