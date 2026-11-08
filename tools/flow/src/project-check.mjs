import { digest } from "./canonical.mjs";

export const PROJECT_CHECK_CONTRACT = "flow.operation/project-check/v2";
export const PROJECT_CHECK_VALIDATOR = "flow.validator/project-check-receipt/v2";
export const PROJECT_CHECK_SCOPE = "Registered project command GREEN-only; no intended-RED evidence; passing exit status applies only to the exact selected suite and captured candidate";
const hashed = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? "");
const keys = (value, names) => value && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export function validProjectCheckBinding(value) {
  if (!value || value.schema !== "flow.project-check-binding/v2" || value.scope !== PROJECT_CHECK_SCOPE ||
      !hashed(value.fingerprint) || !value.registration) return false;
  const { fingerprint, ...identity } = value;
  return digest(identity) === fingerprint;
}

export function validateProjectCheckReceipt(receipt, intent) {
  if (!receipt || !validProjectCheckBinding(intent?.operation_input?.project_check)) return false;
  const passed = receipt.schema === "work.project-check-receipt/v2";
  const result = passed ? receipt : receipt.record;
  if (!passed && (!keys(receipt, ["schema", "found", "complete", "record"]) ||
      receipt.schema !== "work.project-check-absence-receipt/v2" || receipt.found !== false || receipt.complete !== true)) return false;
  if (!keys(result, ["schema", "run_id", "effect_id", "attempt_id", "idempotency_key", "check_fingerprint", "scope", "candidate",
      "reservation_digest", "worker_identity_digest", "capture_receipt_digest", "outcome", "exit_code", "version", "test_count", "stdout_sha256", "stderr_sha256", "terminal_digest", "retired", "proof", "self_digest"])) return false;
  const { self_digest, ...identity } = result;
  const capture = intent.operation_input.authority_materialized_result_bindings?.find(binding => binding.output_contract === "candidate_capture_receipt")?.content;
  return digest(identity) === self_digest && result.schema === "work.project-check-receipt/v2" &&
    result.effect_id === intent.effect_id && result.attempt_id === intent.attempt_id &&
    result.idempotency_key === intent.idempotency_key && result.run_id === intent.run_id &&
    result.check_fingerprint === intent.operation_input.project_check.fingerprint && result.scope === PROJECT_CHECK_SCOPE &&
    capture?.schema === "work.feature-capture-receipt/v1" && digest(result.candidate) === digest(capture.git) && result.capture_receipt_digest === capture.receipt_digest &&
    hashed(result.reservation_digest) && hashed(result.worker_identity_digest) && result.retired === true && result.proof === "linux_subreaper_echild" && hashed(result.terminal_digest) &&
    hashed(result.stdout_sha256) && hashed(result.stderr_sha256) && result.test_count === "unknown" &&
    (result.exit_code === null || Number.isSafeInteger(result.exit_code)) &&
    (passed ? result.outcome === "passed" && result.exit_code === 0 && result.version === intent.operation_input.project_check.registration.version : ["failed", "timeout", "output_limit", "cancelled", "environment_failure"].includes(result.outcome));
}

/** Complete unsuccessful command evidence is not a successful verification effect. */
export function isProjectCheckAbsenceReceipt(receipt, intent) {
  return intent?.operation_contract === PROJECT_CHECK_CONTRACT && receipt?.outcome === "not_created" &&
    receipt.provider_receipt?.schema === "work.project-check-absence-receipt/v2" &&
    validateProjectCheckReceipt(receipt.provider_receipt, intent);
}
