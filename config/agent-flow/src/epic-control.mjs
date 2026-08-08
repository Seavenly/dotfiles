export function validateFeatureDependencies(features) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("epic requires at least one feature");
  }
  const ids = new Set();
  for (const feature of features) {
    if (!feature?.id || ids.has(feature.id) || !Array.isArray(feature.depends_on)) {
      throw new Error("epic feature identities and dependencies must be unique arrays");
    }
    ids.add(feature.id);
  }
  for (const feature of features) {
    for (const dependency of feature.depends_on) {
      if (!ids.has(dependency)) throw new Error(`unknown feature dependency: ${dependency}`);
      if (dependency === feature.id) throw new Error("feature dependency cycle detected");
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  function visit(id) {
    if (visiting.has(id)) throw new Error("feature dependency cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return features;
}

export function planReadyWave({ features, statuses, maxStreams }) {
  validateFeatureDependencies(features);
  if (!Number.isInteger(maxStreams) || maxStreams < 1) {
    throw new Error("maxStreams must be a positive integer");
  }
  const active = new Set(["materialized", "running", "review_ready", "approved"]);
  const activeCount = Object.values(statuses).filter((status) => active.has(status)).length;
  const capacity = Math.max(0, maxStreams - activeCount);
  return features
    .filter(({ id, depends_on }) =>
      statuses[id] === "pending" &&
      depends_on.every((dependency) => statuses[dependency] === "integrated")
    )
    .map(({ id }) => id)
    .sort()
    .slice(0, capacity);
}

export function reconcileEpicTarget({
  recordedTarget,
  liveTarget,
  sourceSha,
  generation,
}) {
  for (const revision of [recordedTarget, liveTarget, sourceSha]) {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("epic revisions must be full Git SHAs");
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("stack generation must be a non-negative integer");
  }
  if (recordedTarget === liveTarget) {
    return { action: "current", generation, sourceSha, targetSha: liveTarget };
  }
  return {
    action: "source_refresh",
    generation: generation + 1,
    priorSourceSha: sourceSha,
    priorTargetSha: recordedTarget,
    targetSha: liveTarget,
    requires: ["builder", "gate", "automated_review", "source_verification"],
  };
}
