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

export function projectManagedRuntimeIdentity(identity, fields) {
  if (identity === null || typeof identity !== "object") return null;
  return Object.fromEntries(
    fields
      .filter((field) => identity[field] !== undefined && identity[field] !== null)
      .map((field) => [field, structuredClone(identity[field])]),
  );
}
