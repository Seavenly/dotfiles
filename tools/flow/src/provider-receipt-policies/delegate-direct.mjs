/** Direct task evidence is separate from historical Drovr registry evidence. */
export const DIRECT_RECEIPT_SCHEMA_FIELDS = new Map([
  ["flow.execution-failure-classification/v1", new Set(["schema", "outcome", "classification"])],
  ["flow.task-settlement-proof/v1", new Set(["schema", "classification", "descriptor_digest", "input_sha256", "output_contract_digest", "stdout_sha256", "terminal_receipt_digest", "native_session", "record_sha256", "description_digest", "launch_comparison_key", "configuration_watermark", "ordered_inputs"])],
  ["flow.execution-watermark/v1", new Set(["schema", "content_sha256"])],
  ["flow.resource-retirement/v1", new Set(["schema", "resource", "proof", "terminal_receipt_digest", "retired"])],
  ["flow.git-candidate-commit-receipt/v1", new Set(["schema", "effect_id", "idempotency_key", "attempt_id", "workspace", "old_commit_sha", "commit_sha", "tree_sha", "ref", "record_sha256", "proof"])],
]);
export const DIRECT_NESTED_FIELDS = new Set(["direct", "execution_watermark", "descriptor_digest", "input_sha256", "output_contract_digest", "stdout_sha256", "terminal_receipt_digest", "native_session", "retired", "old_commit_sha", "commit_sha", "tree_sha", "ref", "proof"]);
