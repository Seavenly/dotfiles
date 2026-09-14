/**
 * Public names and instructions for the independent feature critique seam.
 * Keep this module dependency-free so the feature compiler, lifecycle kernel,
 * and production validator cannot drift by importing one another.
 */
export const FEATURE_CRITIQUE_OUTPUT_SCHEMA =
  "flow.feature-critique-output/v1";

export const AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA =
  "flow.authority-critique-input-binding/v1";

export const FEATURE_CRITIQUE_PROMPT = [
  "Independently inspect the exact authority-materialized candidate and predecessor evidence in this delegate envelope; do not trust apply prose or self-attested bytes.",
  "Return exactly one canonical JSON object with top-level keys feature_critique, observation, and schema.",
  "The top-level schema is flow.delegate-evidence/v1 and feature_critique.schema is flow.feature-critique-output/v1.",
  "feature_critique has exactly candidate_digest, criteria, findings, predecessor_evidence_digest, schema, and task_inputs_digest.",
  "Copy candidate_digest from the exact authority_materialized_candidate digest and predecessor_evidence_digest from the exact authority_materialized_evidence digest delivered in task_inputs; never substitute a digest from implementation output.",
  "Set task_inputs_digest to sha256:<64 lowercase hex> for the SHA-256 digest of the UTF-8 bytes of canonical JSON for the complete task_inputs object.",
  "Canonical JSON recursively sorts object keys, keeps array order, and uses compact separators with no insignificant whitespace; hash the resulting UTF-8 bytes.",
  "Emit one criterion object for every brief.acceptance entry in that exact order, with exactly criterion, evidence, evidence_digest, and verdict.",
  "Each evidence value is the Git-backed {kind: git_file_equals, target, expected} observation for that criterion; evidence_digest must be sha256:<64 lowercase hex> for canonical JSON of {criterion, evidence, verdict}; verdict is independently decided passed or failed.",
  "Emit findings with exactly classification, detail, finding_id, and summary; classification is blocking or non_blocking.",
  "Set finding_id to finding:<64 lowercase hex> where the 64 lowercase hexadecimal characters are the SHA-256 digest of canonical JSON for {classification, detail, summary}; emit unique findings in strictly ascending finding_id order.",
  "Retain every real finding, including non_blocking findings; any blocking finding or failed criterion prevents sealing.",
  "Use only the specified keys and canonical JSON ordering; do not return fabricated empty findings, duplicate or reordered criteria, or prose outside the JSON object.",
].join(" ");
