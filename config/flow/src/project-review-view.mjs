import { quoteShell } from "../scripts/feature-client-files.mjs";
import { failRun } from "./project-run-state.mjs";
import { input, noReceipt, requirePublic } from "./project-session.mjs";
import { runDecisionActions, terminalText } from "./project-run-view.mjs";

export function reviewAttachCommand(selection, runId) {
  return `flow-supervised review --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --attach ${quoteShell(runId)}`;
}

export function reviewConfirmCommand(selection, confirmation) {
  const execution = selection.execution;
  const choices = execution ? execution.lenses.map(lens => ` --lens ${lens}`).join("") + ` --parallel ${execution.parallel}` : "";
  return `flow-supervised review --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --producer ${quoteShell(selection.producer_run_id)}${choices} --timeout-seconds ${selection.policy.max_elapsed_seconds} --max-revisions ${selection.policy.max_revisions} --confirm ${confirmation}`;
}

function structuredLines(label, value, indent = "  ") {
  if (value === null || typeof value !== "object") return [`${label}: ${value ?? "not supplied; inspect full confirmation"}`];
  return [`${label}:`, ...JSON.stringify(value, null, 2).split("\n").map(line => indent + line)];
}

export function renderReviewPreview(preview) {
  const inspection = preview.inspection, trust = inspection.trust_posture ?? {};
  const roles = (inspection.routes ?? []).flatMap(route => {
    const launch = route.launch ?? {}, executable = route.executable ?? {};
    return [`  ${launch.role ?? route.card_id}`,
      `    Harness: ${launch.harness ?? "see full confirmation"}; model: ${launch.model ?? "see full confirmation"}; effort: ${launch.effort ?? "see full confirmation"}`,
      `    Capability: ${launch.capability ?? "see full confirmation"}`,
      `    Executable: ${executable.path ?? "see full confirmation"}`,
      `    Version: ${executable.version ?? "see full confirmation"}; SHA-256: ${executable.sha256 ?? "see full confirmation"}`,
      ...structuredLines("    Requested permissions", route.requested_permissions, "      ")];
  });
  return ["Prepared independent local review", `Project: ${preview.repository}`, `Client runtime: ${preview.runtime_root}`,
    `Producer: ${preview.producer_run_id}`, `Candidate: ${preview.target.candidate_id}`,
    `Fingerprint: ${preview.target.candidate_fingerprint}`,
    `Lifecycle: ${preview.target.lifecycle_generation}; sealed authority watermark: ${preview.target.candidate_authority_watermark}`,
    `Exact comparison: ${preview.comparison.base_commit_sha} -> ${preview.comparison.commit_sha}`,
    ...preview.comparison.diff.split("\n"),
    ...(preview.comparison.truncated ? ["Diff preview truncated; inspect the full exact comparison with:"] : ["Full exact comparison:"]),
    preview.comparison.full_inspection_command,
    `Inherited producer check: ${preview.inherited_checks.kind}; outcome: ${preview.inherited_checks.outcome ?? preview.inherited_checks.status ?? preview.inherited_checks.project_checks ?? "see producer evidence"} (not rerun by review)`,
    `Trust contract: ${trust.execution_contract ?? "see full confirmation"}`,
    `Operator supervision: ${trust.operator_supervision ?? "see full confirmation"}`,
    `Permission enforcement: ${trust.permissions ?? "see full confirmation"}`,
    `Ambient startup: ${trust.ambient_startup ?? "see full confirmation"}`,
    `Independent workspace/tool-network enforcement: ${trust.independent_workspace_and_tool_network_enforcement ?? "not established"}`,
    `Strict qualification: ${trust.qualification ?? "not claimed"}`,
    `Overall prepared-run budget: ${inspection.limits?.max_elapsed_seconds ?? "see full confirmation"} seconds; revisions: ${inspection.limits?.max_revisions ?? "see full confirmation"}`,
    "These are overall run limits, not independent per-role timers.",
    ...(preview.execution ? [`Selected lenses: ${preview.execution.lenses.join(", ")}`,
      `Confirmed read-only lens concurrency: ${preview.execution.parallel}; total native attempts: ${preview.execution.lenses.length + 1} (one per lens and one fresh critic)`,
      `Observed original owner runner delegate capacity: ${preview.execution.owner_delegate_capacity ?? "unavailable; inspect original owner status"}`,
      ...structuredLines("Prepared execution policy", inspection.execution_policy),
      "The critic waits for every selected lens; findings do not grant human approval."] : []),
    ...structuredLines("Requested authority", inspection.requested_authority), "Review roles:", ...roles,
    `Authority: ${preview.authority_directory}`, `Full exact confirmation: ${preview.prepared_file}`,
    `Confirmation digest: ${preview.confirmation_digest}`, preview.recovery_disclosure,
    "This command grants no human approval and performs no Git publication.", ""].map(terminalText).join("\n");
}

/** The record receipt identifies the record; candidate-only legacy IDs are never inferred. */
export async function readReviewRecord(run, selection, call) {
  const effects = (run.effects ?? []).filter(effect => effect.operation_contract === "flow.operation/review-record/v1" && effect.receipt?.provider_receipt?.schema === "flow.review-receipt/v1");
  if (!effects.length) return null;
  if (effects.length !== 1) failRun("More than one review-record receipt exists for this exact run. Preserve the public projections.", "review_record_changed", 1);
  const [effect] = effects, receipt = effect.receipt.provider_receipt;
  const record = requirePublic(await call(selection, input("query", { contract: "work.review/v1", subject_id: receipt.review_id })), "Exact review record");
  const target = selection.target;
  if (typeof receipt.review_id !== "string" || record.schema !== "flow.review-projection/v1" || record.contract !== "work.review/v1" ||
      record.subject_id !== receipt.review_id || record.source_run_id !== run.run_id ||
      record.operation_contract !== effect.operation_contract || record.operation_effect_id !== effect.effect_id ||
      record.operation_attempt_id !== effect.attempt_id || record.operation_idempotency_key !== effect.idempotency_key ||
      !effect.attempt_id || !effect.idempotency_key ||
      receipt.candidate_fingerprint !== target.candidate_fingerprint || receipt.lifecycle_generation !== target.lifecycle_generation ||
      record.candidate?.candidate_id !== target.candidate_id || record.candidate_fingerprint !== target.candidate_fingerprint ||
      record.lifecycle_generation !== target.lifecycle_generation || record.candidate_authority_watermark !== target.candidate_authority_watermark) {
    failRun("Public review record does not bind this exact review attempt and retained candidate. No completion is inferred.", "review_record_changed", 1);
  }
  return { receipt, record, effect_id: effect.effect_id };
}

export async function summarizeProjectReview(run, { selection, status, projectionFile, call, preview }) {
  const observed = await readReviewRecord(run, selection, call);
  const record = observed?.record ?? null;
  const coverage = record?.coverage ?? record?.summary?.coverage ?? null;
  const posture = record?.posture ?? record?.summary?.posture ?? null;
  const complete = record?.current === true && coverage?.complete === true && ["no_findings", "findings"].includes(posture);
  const actions = runDecisionActions(run);
  const attach = reviewAttachCommand(selection, run.run_id);
  return { schema: "flow.project-review-result/v1", status: status === "completed" ? complete ? "succeeded" : "blocked" : status,
    run_id: run.run_id, phase: run.phase, producer_run_id: selection.producer_run_id, target: selection.target,
    client: selection.client, runtime_root: selection.runtime_root, retained_directory: selection.retained_directory,
    projection_file: projectionFile, review_id: record?.subject_id ?? null,
    review_status: record ? record.current !== true ? "stale" : coverage?.complete !== true ? "review_incomplete" : posture : "not_recorded",
    record, coverage, posture, cap_reasons: record?.cap_reasons ?? record?.summary?.cap_reasons ?? [], findings: record?.rendered_findings ?? record?.findings ?? record?.summary?.rendered_findings ?? record?.summary?.findings ?? [],
    inherited_checks: preview.inherited_checks, project_checks_rerun: false,
    approval: record?.approval ?? null, human_status: record?.human_status ?? null, integration: record?.integration ?? null,
    guided_approval_granted: false, merge_ready: record?.summary?.merge_ready ?? record?.merge_ready ?? false,
    unresolved_effects: (run.effects ?? []).filter(noReceipt).map(effect => effect.effect_id),
    quarantined_effects: (run.effects ?? []).filter(effect => /quarantin/u.test(effect.status)).map(effect => effect.effect_id),
    workspace_settlement: run.resource_dispositions ?? [],
    legal_actions: actions.map(({ command: _command, ...action }) => action),
    next_commands: [attach, ...(record ? [`${quoteShell(selection.client)} query --input ${quoteShell(JSON.stringify({ contract: "work.review/v1", subject_id: record.subject_id }))} --json`] : []),
      ...actions.filter(action => action.type !== "cancel").map(action => `${attach} --action ${quoteShell(action.digest)}`), preview.comparison.full_inspection_command] };
}

export function renderReviewResult(result) {
  const coverage = result.coverage, checks = result.inherited_checks ?? {};
  const withReason = source => `${source?.status ?? "not observed"}${source?.reason ? ` (${typeof source.reason === "string" ? source.reason : JSON.stringify(source.reason)})` : ""}`;
  const workspace = result.workspace_settlement ?? [];
  return [`Review result: ${result.status} (run phase ${result.phase})`, `Run: ${result.run_id}`, `Producer: ${result.producer_run_id}`,
    `Candidate: ${result.target.candidate_id}`, `Fingerprint: ${result.target.candidate_fingerprint}`,
    `Review record: ${result.review_id ?? "not recorded"}`, `Review posture: ${result.posture ?? result.review_status}`,
    `Coverage: ${coverage?.complete === true ? "complete" : coverage?.complete === false ? "incomplete" : "not observed"}`,
    ...(coverage?.lenses ?? []).map(lens => `  Lens ${lens.lens}: ${withReason(lens)}`),
    `  Critic: ${withReason(coverage?.critic)}`,
    `Authority cap reasons: ${result.cap_reasons.length ? result.cap_reasons.map(reason => typeof reason === "string" ? reason : JSON.stringify(reason)).join("; ") : "none observed"}`,
    ...result.findings.slice(0, 100).flatMap(finding => [
      `Finding (${finding.urgency ?? "unspecified urgency"}, ${finding.lens ?? finding.source ?? "review"}, ${finding.classification ?? "see record"}): ${finding.summary ?? "See exact record"}`,
      `  Location: ${JSON.stringify(finding.location ?? null)}`, `  ${finding.detail ?? ""}`]),
    ...(result.findings.length > 100 ? ["Finding display truncated. Inspect the exact public record below."] : []),
    `Inherited producer checks (not rerun): ${checks.kind ?? "not observed"}`,
    `  Status: ${checks.status ?? checks.project_checks ?? "not observed"}; outcome: ${checks.outcome ?? "not observed"}; exit: ${checks.exit_code ?? "unknown"}; test count: ${checks.test_count ?? "unknown"}`,
    `Observed human approval: ${JSON.stringify(result.approval)}; human status: ${JSON.stringify(result.human_status)}; integration: ${JSON.stringify(result.integration)}`,
    `This guided command grants no human approval or Git publication. Automated merge_ready: ${result.merge_ready}`,
    ...(result.status === "detached" ? ["Frontend detached. Durable work continues and has not been cancelled. Reattach below."] : []),
    ...(result.unresolved_effects.length ? [`Unresolved effects: ${result.unresolved_effects.join(", ")}. Completion is not established.`] : []),
    ...(result.quarantined_effects.length ? [`Quarantined effects: ${result.quarantined_effects.join(", ")}`] : []),
    workspace.length ? "Workspace dispositions:" : "Workspace dispositions: none observed; workspace reuse is not inferred.",
    ...workspace.map(item => `  ${item.disposition ?? "not observed"}: ${item.claim?.id ?? "resource identity not supplied"}${item.claim?.generation !== undefined ? `; generation ${item.claim.generation}` : ""}${item.claim?.mutation_epoch !== undefined ? `; epoch ${item.claim.mutation_epoch}` : ""}${item.reason ? `; ${typeof item.reason === "string" ? item.reason : JSON.stringify(item.reason)}` : ""}`),
    `Retained evidence: ${result.retained_directory}`, "Next commands:", ...result.next_commands.map(command => `  ${command}`), ""].map(terminalText).join("\n");
}
