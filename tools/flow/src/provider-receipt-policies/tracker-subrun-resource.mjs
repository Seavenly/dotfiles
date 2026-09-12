/** Versioned receipt policy owned by tracker, subrun, and resource modules. */

export const TRACKER_SUBRUN_RESOURCE_RECEIPT_SCHEMA_FIELDS = new Map([
  ["flow.resource-handoff/v1", new Set([
    "attempt_id",
    "durable_holder",
    "managed_agent_binding",
    "reason",
    "resource",
    "schema",
    "terminal_disposition",
    "turn_disposition",
  ])],
  ["flow.resource-cleanup-receipt/v1", new Set([
    "outcome",
    "request",
    "schema",
  ])],
  ["flow.resource-cleanup-request/v1", new Set([
    "contract",
    "expected_watermark",
    "preview_digest",
    "schema",
    "subject_id",
  ])],
  ["flow.git-retention-receipt/v1", new Set([
    "commit_sha",
    "ref",
    "repository_id",
    "retention_ref",
    "schema",
    "tree_sha",
  ])],
]);

export const TRACKER_SUBRUN_RESOURCE_NESTED_FIELDS = new Set([
  "authority",
  "body",
  "clean",
  "commit_id",
  "commit_sha",
  "content_sha256",
  "fingerprint",
  "generation",
  "git",
  "git_retention",
  "mutation_epoch",
  "owner",
  "path",
  "publication_digest",
  "ref",
  "repository",
  "resource",
  "tree_sha",
]);
