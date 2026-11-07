import { digest } from "../../../tools/flow/src/canonical.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";

export const terminalText = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/gu, character => JSON.stringify(character).slice(1, -1));
const unsupportedActions = new Set(["operation_execute", "delegate_execute", "delegate_recover", "operation_reconcile", "subrun_execute"]);

/** Only decisions already offered by authority are selectable; executor work stays with its runner. */
export function runDecisionActions(run) {
  return (run.legal_actions ?? []).filter(action => action.schema === "flow.command/v1" &&
    !unsupportedActions.has(action.type) && ["checkpoint_decision", "capability_grant", "revision_decision", "terminal_disposition", "cancel", "recovery"].includes(action.type))
    .map(action => ({ digest: digest(action), type: action.type, label: [action.type, action.recovery, action.checkpoint_id, action.decision].filter(Boolean).join(" "), command: action }));
}

export function projectRunProgress(run) {
  return { schema: "flow.project-run-progress/v1", run_id: run.run_id, phase: run.phase,
    watermark: run.watermark, sequence: run.sequence,
    cards: run.cards ?? [],
    effects: (run.effects ?? []).map(effect => ({ effect_id: effect.effect_id, card_id: effect.card_id,
      contract: effect.operation_contract ?? effect.effect_kind, status: effect.status,
      outcome: effect.receipt?.provider_receipt?.outcome ?? effect.last_observation?.provider_observation?.code ?? null })),
    blocks: run.blocks ?? [], legal_actions: runDecisionActions(run).map(({ command: _command, ...action }) => action),
  };
}

export function renderRunPreview(preview) {
  const { inspection } = preview;
  return ["Prepared supervised task", `Project: ${preview.repository}`, `Client runtime: ${preview.runtime_root}`,
    `Request: ${preview.request}`, `Task: ${inspection.brief?.summary ?? "unknown"}`,
    ...(inspection.brief?.acceptance ?? []).map((criterion, index) => `  ${index + 1}. ${criterion}`),
    `Check: ${inspection.project_check ? JSON.stringify(inspection.project_check.registration?.argv ?? inspection.project_check) : JSON.stringify(inspection.trust_posture?.verification_scope ?? "See retained confirmation")}`,
    `Trust: ${JSON.stringify(inspection.trust_posture)}`, `Limits: ${JSON.stringify(inspection.limits)}`,
    `Authority: ${preview.authority_directory}`, `Prepared confirmation: ${preview.prepared_file}`,
    `Confirmation digest: ${preview.confirmation_digest}`, preview.recovery_disclosure, ""].map(terminalText).join("\n");
}

export function renderRunProgress(progress) {
  return [`Run ${progress.run_id}: ${progress.phase}`,
    ...progress.cards.map(card => `  ${card.id}: ${card.status}`),
    ...progress.effects.filter(effect => ["reconciling", "quarantined"].includes(effect.status)).map(effect => `  Effect ${effect.effect_id}: ${effect.status} (${effect.outcome ?? "outcome unresolved"})`),
    ...progress.blocks.map(block => `  Blocked: ${block.type ?? block.quarantine_reason ?? "authority decision required"}`), ""].map(terminalText).join("\n");
}

export function summarizeProjectRun(run, { selection, candidate = null, status, projectionFile } = {}) {
  const effects = run.effects ?? [];
  const check = effects.find(effect => effect.operation_contract === "flow.operation/project-check/v2");
  const checkReceipt = check?.receipt?.provider_receipt;
  const tests = effects.filter(effect => effect.operation_contract === "flow.operation/feature-test/v1");
  const critique = (run.cards ?? []).find(card => /critique/u.test(card.id));
  const unresolved = effects.filter(effect => !effect.receipt && !["not_created", "abandoned"].includes(effect.status));
  const quarantined = effects.filter(effect => /quarantin/u.test(effect.status));
  const retained = candidate?.candidate ?? candidate?.capture ?? null;
  const git = retained?.git ?? candidate?.git ?? null;
  const capture = effects.find(effect => effect.operation_contract === "flow.operation/feature-capture/v1")?.receipt?.provider_receipt;
  const commit = git?.commit_sha ?? capture?.git?.commit_sha ?? checkReceipt?.candidate?.commit_sha ?? null;
  const ref = git?.ref ?? capture?.git?.ref ?? null;
  const next = [`flow-supervised run --repository ${quoteShell(selection.repository)} --request ${quoteShell(selection.request)} --attach ${quoteShell(run.run_id)}`];
  if (commit) next.push(`/usr/bin/git -C ${quoteShell(selection.repository)} show --stat ${quoteShell(commit)}`, `/usr/bin/git -C ${quoteShell(selection.repository)} show ${quoteShell(commit)}`);
  const actions = runDecisionActions(run);
  next.push(...actions.filter(action => action.type !== "cancel").map(action => `${next[0]} --action ${quoteShell(action.digest)}`));
  return { schema: "flow.project-run-result/v1", status, run_id: run.run_id, phase: run.phase,
    request: selection.request, client: selection.client, retained_directory: selection.retained_directory,
    projection_file: projectionFile, candidate: candidate === null ? null : { id: candidate.subject_id ?? run.review_candidate_reference?.candidate_id,
      status: candidate.status, fingerprint: candidate.candidate_fingerprint ?? run.review_candidate_reference?.candidate_fingerprint, commit, ref },
    checks: check ? { kind: "registered_green_only", status: check.status, outcome: checkReceipt?.outcome ?? null,
      exit_code: checkReceipt?.exit_code ?? null, test_count: checkReceipt?.test_count ?? "unknown", evidence: checkReceipt ?? null }
      : tests.length ? { kind: "registered_expected_red_then_green", evidence: tests.map(effect => effect.receipt?.provider_receipt ?? null) }
        : { kind: "content_only", project_checks: "not_run", scope: run.trust_posture?.verification_scope ?? null },
    critique: critique?.status ?? "not_observed", separate_review: "not_requested", human_approval: "not_requested",
    unresolved_effects: unresolved.map(effect => effect.effect_id), quarantined_effects: quarantined.map(effect => effect.effect_id),
    workspace_settlement: (run.resource_dispositions ?? []).map(disposition => ({ ...disposition })),
    legal_actions: actions.map(({ command: _command, ...action }) => action), next_commands: next,
  };
}

export function renderRunResult(result) {
  return [`Result: ${result.status} (run phase ${result.phase})`, `Run: ${result.run_id}`,
    `Retained evidence: ${result.retained_directory}`, `Candidate: ${result.candidate ? JSON.stringify(result.candidate) : "not sealed/available"}`,
    `Checks: ${result.checks.kind} - ${result.checks.outcome ?? result.checks.status ?? result.checks.project_checks ?? "see retained evidence"}`,
    `Feature critique: ${result.critique}; separate review and human approval: not requested`,
    ...(result.unresolved_effects.length ? [`Unresolved effects: ${result.unresolved_effects.join(", ")}. Completion and workspace reuse are not established.`] : []),
    ...(result.quarantined_effects.length ? [`Quarantined effects: ${result.quarantined_effects.join(", ")}`] : []),
    "Next commands:", ...result.next_commands.map(command => `  ${command}`), ""].map(terminalText).join("\n");
}
