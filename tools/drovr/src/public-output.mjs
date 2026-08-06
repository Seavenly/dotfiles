import { digestCanonical } from "./canonical-json.mjs";

export function publicCompatibility(value) {
  if (value === null || typeof value !== "object") return value;
  // Pane, process, and path coordinates are private evidence; the digest below
  // remains available for public correlation without exposing those coordinates.
  const projected = structuredClone(value);
  delete projected.managed_pane_identity;
  delete projected.managed_runtime_identity;
  return projected;
}

export function publicErrorDetails(value, key = "") {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactLocalPaths(value) : value;
  }
  if (key === "managed_runtime_identity" || key === "managed_pane_identity") {
    return undefined;
  }
  if (isManagedRuntimeMismatch(value)) {
    return publicManagedRuntimeMismatch(value);
  }
  if ((key === "expected" || key === "observed") && isManagedRuntimeIdentity(value)) {
    return { managed_runtime_evidence_digest: digestCanonical(value) };
  }
  if (Array.isArray(value)) {
    return value
      .map((child) => publicErrorDetails(child, key))
      .filter((child) => child !== undefined);
  }
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    const sanitized = publicErrorDetails(child, childKey);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

export function publicErrorMessage(error) {
  return error.outcome === "compatibility_blocked"
    ? redactLocalPaths(error.message)
    : error.message;
}

function isManagedRuntimeIdentity(value) {
  return value?.schema === "drovr.managed-pane-runtime-identity/v1";
}

function isManagedRuntimeMismatch(value) {
  return typeof value?.field === "string" &&
    value.field.startsWith("managed_pane_identity");
}

function publicManagedRuntimeMismatch(value) {
  return {
    field: value.field,
    ...(value.expected !== undefined
      ? { expected_digest: digestCanonical(value.expected) }
      : {}),
    ...(value.observed !== undefined
      ? { observed_digest: digestCanonical(value.observed) }
      : {}),
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

function redactLocalPaths(value) {
  return value.replace(/(^|[\s("'`])\/[^\s"'`]+/gu, "$1<local-path>");
}
