export const STATE_SEQUENCE_PHASES = Object.freeze([
  "before_staging",
  "after_staging",
  "after_clear",
  "post_clear",
  "after_process_reentry",
]);

export function stateSequenceComplete(
  sequence,
  phases = STATE_SEQUENCE_PHASES,
) {
  return hasRequiredPhases(phases) &&
    phases.every((phase) => Number.isSafeInteger(sequence?.[phase]));
}

export function stateSequenceAntiReplayGap(
  sequence,
  phases = STATE_SEQUENCE_PHASES,
) {
  if (!stateSequenceComplete(sequence, phases)) return "unobserved";
  const values = phases.map((phase) => sequence[phase]);
  const monotonic = values.every(
    (value, index) => index === 0 || value >= values[index - 1],
  );
  const exactSnapshotTransition =
    sequence.clear_transition_proof === "exact_snapshot_disappearance" &&
    sequence.after_clear === sequence.after_staging;
  return monotonic &&
    (sequence.after_clear > sequence.after_staging || exactSnapshotTransition) &&
    sequence.post_clear === sequence.after_process_reentry
    ? false
    : true;
}

function hasRequiredPhases(phases) {
  return Array.isArray(phases) &&
    STATE_SEQUENCE_PHASES.every((phase) => phases.includes(phase));
}
