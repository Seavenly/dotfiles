/**
 * Fields shared by every provider receipt and the evidence-safety receipts.
 * Domain policy modules own domain-specific schema fields; this module only
 * supplies the conservative generic envelope and scalar nested fields.
 */

const GENERIC_PROVIDER_RECEIPT_FIELDS = new Set([
  "authority_watermark",
  "child_attempts",
  "child_phase",
  "child_run_id",
  "child_watermark",
  "code",
  "comment_id",
  "content_sha256",
  "detail",
  "effect_id",
  "idempotency_key",
  "issue_number",
  "mutation",
  "operation_attempt_id",
  "operation_contract",
  "operation_effect_id",
  "operation_idempotency_key",
  "owner_run_id",
  "owner",
  "provider_error_code",
  "provider_id",
  "publication_digest",
  "project",
  "git_retention",
  "record",
  "reason",
  "review_candidate",
  "repository",
  "resource_cleanup",
  "schema",
  "status",
  "system",
  "tracker",
]);

// Provider observations which are deliberately receipt-shaped use the same
// allowlist as durable receipts plus this small, domain-neutral evidence
// envelope.  Keeping these keys here makes write-time and replay-time
// sanitization agree without teaching the generic boundary provider details.
export const OBSERVATION_DERIVED_RECEIPT_FIELDS = new Set([
  "complete",
  "found",
  "matching_review_count",
  "pending_review_count",
  "proof",
  "rejection_code",
]);

export const CORE_RECEIPT_SCHEMA_FIELDS = new Map([
  ["flow.provider-receipt/v1", GENERIC_PROVIDER_RECEIPT_FIELDS],
  ["flow.provider-receipt-redacted/v1", new Set([
    "original_schema",
    "reason",
    "schema",
    "status",
  ])],
  ["flow.evidence-safety-receipt/v1", new Set([
    "allowed_use",
    "catalog_id",
    "classification",
    "input_digest",
    "policy_id",
    "receipt_digest",
    "schema",
    "self_digest",
  ])],
  ["flow.evidence-safety-binding/v1", new Set([
    "binding_digest",
    "boundary",
    "input_digest",
    "receipt_digest",
    "schema",
    "self_digest",
    "subject_digest",
  ])],
  ["flow.evidence-safety-rejection/v1", new Set([
    "code",
    "operation",
    "reason",
    "redacted",
    "schema",
  ])],
]);

export const CORE_NESTED_FIELDS = new Set([
  "accepted",
  "attempt_id",
  "card_id",
  "code",
  "complete",
  "contract",
  "count",
  "detail",
  "digest",
  "effect_id",
  "effect_idempotency_key",
  "effect_kind",
  "found",
  "id",
  "idempotency_key",
  "name",
  "operation",
  "operation_attempt_id",
  "operation_contract",
  "operation_effect_id",
  "operation_id",
  "operation_idempotency_key",
  "outcome",
  "owner_run_id",
  "reason",
  "record",
  "run_id",
  "schema",
  "status",
  "subject_id",
  "summary",
  "type",
  "watermark",
]);

export const SENSITIVE_PROVIDER_RECEIPT_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "password",
  "private",
  "secret",
  "stack",
  "token",
]);
