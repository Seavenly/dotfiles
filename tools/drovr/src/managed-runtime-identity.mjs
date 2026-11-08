export const MANAGED_RUNTIME_BINDING_FIELDS = Object.freeze([
  "harness",
  "pane_id",
  "integration",
  "managed_path_digest",
  "executable",
]);

export const MANAGED_RUNTIME_SHARED_FIELDS = Object.freeze([
  "executable",
  "managed_path_digest",
  "integration",
]);

export const MANAGED_RUNTIME_OBSERVATION_FIELDS = Object.freeze([
  "schema",
  "harness",
  "managed_agent",
  "pane_id",
  "executable",
  "managed_path_digest",
  "integration",
  "native_session",
  "process",
  "model",
  "effort",
]);

export const MANAGED_RUNTIME_QUALIFICATION_FIELDS = Object.freeze([
  "pane_id",
  "integration",
  "managed_path_digest",
  "caller_path_digest",
]);

export const MANAGED_RUNTIME_EXECUTABLE_FIELDS = Object.freeze([
  "observed_path",
  "canonical_path",
  "version",
]);

export const MANAGED_RUNTIME_SETTLED_FIELDS = Object.freeze([
  "model",
  "effort",
]);

export function projectManagedRuntimeIdentity(identity, fields) {
  if (identity === null || typeof identity !== "object") return null;
  return Object.fromEntries(
    fields
      .filter((field) => identity[field] !== undefined && identity[field] !== null)
      .map((field) => [field, structuredClone(identity[field])]),
  );
}
