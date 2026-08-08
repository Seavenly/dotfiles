export function hasDependencyCycle(cards) {
  const dependencies = new Map(cards.map(({ id, dependencies: values }) => [
    id,
    values,
  ]));
  const visiting = new Set();
  const visited = new Set();

  function visit(cardId) {
    if (visiting.has(cardId)) return true;
    if (visited.has(cardId)) return false;
    visiting.add(cardId);
    if (dependencies.get(cardId).some((dependency) => visit(dependency))) {
      return true;
    }
    visiting.delete(cardId);
    visited.add(cardId);
    return false;
  }

  return [...dependencies.keys()].some((cardId) => visit(cardId));
}

export function hasActiveDependencyOnSuperseded(cards, supersededCardIds) {
  const superseded = new Set(supersededCardIds);
  return cards.some((card) => !superseded.has(card.id) &&
    card.dependencies.some((dependency) => superseded.has(dependency)));
}
