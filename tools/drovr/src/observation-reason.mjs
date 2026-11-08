export function observationErrorReason(
  error,
  fallback = "session_observation_uncertain",
) {
  if (error?.outcome === "compatibility_blocked") {
    return "compatibility_blocked";
  }
  const structuredCodes = [
    error?.details,
    error?.adapterFailure?.details,
    parseJson(error?.adapterFailure?.stdout),
    parseJson(error?.adapterFailure?.stderr),
  ]
    .flatMap((value) => collectCodes(value))
    .join("\n");
  if (/protocol[_ -]?(?:version[_ -]?)?mismatch/iu.test(structuredCodes)) {
    return "protocol_mismatch";
  }
  if (
    /session[_ -]?(?:missing|not[_ -]?found)|server[_ -]not[_ -]running/iu.test(
      structuredCodes,
    )
  ) {
    return "session_missing";
  }
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

function parseJson(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectCodes(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCodes(item, seen));
  }
  return [
    ...(typeof value.code === "string" ? [value.code] : []),
    ...(typeof value.reason === "string" ? [value.reason] : []),
    ...Object.values(value).flatMap((item) => collectCodes(item, seen)),
  ];
}
