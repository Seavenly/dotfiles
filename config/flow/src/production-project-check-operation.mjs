import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";
import { PROJECT_CHECK_CONTRACT, PROJECT_CHECK_VALIDATOR, validateProjectCheckReceipt } from "../../../tools/flow/src/project-check.mjs";
import { resolveProjectCheck, projectCheckError, validateProjectCheck } from "./production-project-check.mjs";
import { createProjectCheckRunner, projectCheckRunnerIdentity } from "./production-project-check-runner.mjs";

export function createProjectCheckOperation({ resolveWorkspace, gitWorkspaceObservationAdapter, authorityDirectory, featureTestCheck, authority }) {
  const runner = createProjectCheckRunner({ authorityDirectory });
  let available = false;
  try { available = process.platform === "linux" && typeof authorityDirectory === "string" && validateProjectCheck(featureTestCheck).schema === "flow.production-project-check/v2"; }
  catch { /* An absent/v1 check does not advertise the additive project route. */ }
  return Object.freeze({
    schema: "flow.registered-operation/v1", classification: "reconcilable", availability: available ? "available" : "unavailable",
    provider_receipt_validator: PROJECT_CHECK_VALIDATOR,
    validateReceipt(receipt, intent) {
      if (!validateProjectCheckReceipt(receipt, intent)) return false;
      try {
        const evidence = runner.read(intent), result = receipt.record ?? receipt;
        return evidence !== null && result.terminal_digest === evidence.terminal.self_digest &&
          result.reservation_digest === evidence.reservation.reservation_digest && result.worker_identity_digest === digest(evidence.terminal.owner) &&
          result.stdout_sha256 === evidence.terminal.stdout_sha256 && result.stderr_sha256 === evidence.terminal.stderr_sha256 &&
          result.outcome === evidence.terminal.outcome && result.exit_code === evidence.terminal.exit_code && result.version === evidence.terminal.version;
      } catch { return false; }
    },
    requestCancellation(identity) { return runner.requestCancellation(identity); },
    async observe(intent) { return observeExisting(intent); },
    async reconcile(intent) { return observeExisting(intent); },
    async invoke(intent) { return execute(intent, false); },
  });
  async function observeExisting(intent) {
    if (authority?.().query(intent.run_id)?.phase === "cancelled") runner.requestCancellation({ run_id: intent.run_id, effect_id: intent.effect_id });
    try {
      const receipt = await execute(intent, true);
      return { schema: "flow.effect-observation/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key,
        presence: receipt.outcome === "succeeded" ? "present" : "absent", causation: receipt.outcome === "succeeded" ? {
          effect_id: intent.effect_id, idempotency_key: intent.idempotency_key,
        } : null, provider_observation: receipt.provider_receipt };
    } catch {
      return { schema: "flow.effect-observation/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key,
        presence: "indeterminate", causation: null, provider_observation: { schema: "flow.provider-observation/v1", reason: "project_check_outcome_unknown" } };
    }
  }
  async function execute(intent, existingOnly) {
      if (intent.operation_contract !== PROJECT_CHECK_CONTRACT || intent.operation_input?.phase !== "project_check") throw projectCheckError("project_check_intent_invalid");
      const workspace = resolveWorkspace(intent.operation_input.workspace.subject_id);
      if (!workspace || featureTestCheck?.schema !== "flow.production-project-check/v2") throw projectCheckError("project_check_unavailable");
      const bound = intent.operation_input.project_check;
      const selection = () => resolveProjectCheck({ config: featureTestCheck, brief: intent.operation_input.brief,
        workspace, runnerIdentity: projectCheckRunnerIdentity(), authorityDirectory });
      if (digest(selection()) !== digest(bound)) throw projectCheckError("project_check_input_drift");
      const captures = intent.operation_input.authority_materialized_result_bindings?.filter(binding => binding.output_contract === "candidate_capture_receipt") ?? [];
      if (captures.length !== 1 || captures[0].content?.schema !== "work.feature-capture-receipt/v1") throw projectCheckError("project_check_capture_missing");
      const captured = captures[0].content;
      const observe = () => gitWorkspaceObservationAdapter.observe({ workspace_path: workspace.path, ref: workspace.ref, repository_id: workspace.repository_id }).git;
      if (captured.git.clean !== true || digest(observe()) !== digest(captured.git)) throw projectCheckError("project_check_candidate_changed");
      const evidence = existingOnly ? await runner.waitExisting(intent) : await runner.run(intent, workspace, bound);
      if (digest(observe()) !== digest(captured.git) || digest(selection()) !== digest(bound)) throw projectCheckError("project_check_candidate_changed");
      const t = evidence.terminal;
      const identity = {
        schema: "work.project-check-receipt/v2", run_id: intent.run_id, effect_id: intent.effect_id,
        attempt_id: intent.attempt_id, idempotency_key: intent.idempotency_key,
        check_fingerprint: bound.fingerprint, scope: bound.scope, candidate: captured.git,
        reservation_digest: evidence.reservation.reservation_digest, worker_identity_digest: digest(t.owner),
        capture_receipt_digest: captured.receipt_digest, outcome: t.outcome, exit_code: t.exit_code,
        version: t.version, test_count: "unknown", stdout_sha256: t.stdout_sha256,
        stderr_sha256: t.stderr_sha256, terminal_digest: t.self_digest,
        retired: t.retired, proof: t.proof,
      };
      const result = { ...identity, self_digest: digest(identity) };
      const absent = { schema: "work.project-check-absence-receipt/v2", found: false, complete: true, record: result };
      const receipt = result.outcome === "passed" ? result : absent;
      if (!validateProjectCheckReceipt(receipt, intent)) throw projectCheckError("project_check_receipt_invalid");
      return freezeCanonical({ schema: "flow.effect-receipt/v1", effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key, outcome: result.outcome === "passed" ? "succeeded" : "not_created", provider_receipt: receipt });
  }
}
