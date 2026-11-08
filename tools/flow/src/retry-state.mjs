/**
 * Fold durable retry scheduling into the one state used by both projection
 * and effect admission.  A later event replaces the earlier state for the
 * same exact effect identity; no ambient time or retry policy is consulted.
 */
export function foldRetryStates(events = []) {
  const states = new Map();
  for (const event of events) {
    if (event?.type === "effect_invocation_started" &&
        typeof event.effect_id === "string") {
      states.delete(event.effect_id);
    } else if (event?.type === "effect_retry_cleared" &&
        typeof event.effect_id === "string") {
      states.delete(event.effect_id);
    } else if (event?.type === "effect_retry_scheduled" &&
        typeof event.effect_id === "string") {
      states.set(event.effect_id, {
        status: "waiting",
        retry_after_ms: event.retry_after_ms,
        not_before: event.retry_not_before,
      });
    } else if (event?.type === "effect_retry_blocked" &&
        typeof event.effect_id === "string") {
      states.set(event.effect_id, {
        status: "blocked",
        reason: event.reason,
        ...(Number.isSafeInteger(event.retry_after_ms) &&
          event.retry_after_ms >= 0
          ? { retry_after_ms: event.retry_after_ms }
          : {}),
      });
    }
  }
  return states;
}

export function retryStateIsDue(retry, currentTime) {
  return retry?.status === "waiting" &&
    retry.not_before?.schema === "flow.time-fact/v1" &&
    retry.not_before.kind === "wall_clock" &&
    currentTime?.schema === "flow.time-fact/v1" &&
    currentTime.kind === "wall_clock" &&
    currentTime.clock_source_id === retry.not_before.clock_source_id &&
    currentTime.uncertainty_ms === 0 &&
    retry.not_before.uncertainty_ms === 0 &&
    currentTime.value_ms >= retry.not_before.value_ms;
}
