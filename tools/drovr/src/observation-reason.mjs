export function observationErrorReason(
  error,
  fallback = "session_observation_uncertain",
) {
  const output = [
    error?.message,
    error?.details?.reason,
    error?.adapterFailure?.message,
    error?.adapterFailure?.stdout,
    error?.adapterFailure?.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  if (/protocol[_ ]mismatch|client protocol.*server protocol/iu.test(output)) {
    return "protocol_mismatch";
  }
  const sessionMissing = [
    /session(?:[_ ](?:missing|not[_ ]found)| .*not found)/iu,
    /server[_ ]not[_ ]running/iu,
  ].some((pattern) => pattern.test(output));
  if (sessionMissing) {
    return "session_missing";
  }
  return fallback;
}
