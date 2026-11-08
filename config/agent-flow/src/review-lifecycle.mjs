export const REVIEW_STATES = Object.freeze([
  "review_ready",
  "reviewing",
  "changes_requested",
  "approved",
  "integrated",
  "archived",
]);

export const REVIEW_TRANSITIONS = Object.freeze([
  ["review_ready", "reviewing"],
  ["review_ready", "integrated"],
  ["reviewing", "changes_requested"],
  ["reviewing", "approved"],
  ["changes_requested", "review_ready"],
  ["approved", "reviewing"],
  ["approved", "integrated"],
  ["integrated", "archived"],
]);

const transitionKeys = new Set(
  REVIEW_TRANSITIONS.map(([from, to]) => `${from}:${to}`),
);

export function isLegalReviewTransition(from, to) {
  return transitionKeys.has(`${from}:${to}`);
}

