export function executionTimeFacts({
  wallValueMs,
  bootId,
  wallUncertaintyMs = 0,
  monotonicValueNs,
  monotonicUncertaintyNs = "0",
  wallClockSourceId = "wall:host-a",
  monotonicClockSourceId = "mono:host-a",
  clockSourceIdentity = "clockset:host-a:v1",
} = {}) {
  const monotonicValue = monotonicValueNs ?? String(
    (wallValueMs - 1_700_000_000_000) * 1_000_000 + 1_000_000_000,
  );
  return [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: wallValueMs,
      uncertainty_ms: wallUncertaintyMs,
      clock_source_id: wallClockSourceId,
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: monotonicValue,
      uncertainty_ns: monotonicUncertaintyNs,
      clock_source_id: monotonicClockSourceId,
    },
    {
      schema: "flow.time-fact/v1",
      kind: "boot",
      boot_id: bootId,
    },
    {
      schema: "flow.time-fact/v1",
      kind: "clock_source",
      identity: clockSourceIdentity,
    },
  ];
}
