export const QUALIFICATION_EVIDENCE_REQUIRED_FIELDS = Object.freeze([
  "schema",
  "catalog_version",
  "catalog_digest",
  "scenario_id",
  "execution_kind",
  "versions",
  "environment",
  "limits",
  "live_run_justification",
  "configuration_deviation_justification",
  "invocations",
  "observations",
  "assertions",
  "result",
  "execution_policy",
  "cleanup_receipt",
  "started_at",
  "finished_at",
]);

const CYCLE_EVIDENCE_REQUIRED_FIELD_NAMES = new Set([
  "schema",
  "catalog_version",
  "catalog_digest",
  "scenario_id",
  "versions",
  "limits",
  "invocations",
  "assertions",
  "result",
  "cleanup_receipt",
  "execution_policy",
]);

export const CYCLE_EVIDENCE_REQUIRED_FIELDS = Object.freeze(
  QUALIFICATION_EVIDENCE_REQUIRED_FIELDS.filter((field) =>
    CYCLE_EVIDENCE_REQUIRED_FIELD_NAMES.has(field),
  ),
);

if (
  CYCLE_EVIDENCE_REQUIRED_FIELDS.length !==
  CYCLE_EVIDENCE_REQUIRED_FIELD_NAMES.size
) {
  throw new Error("cycle evidence contract contains an unknown required field");
}
