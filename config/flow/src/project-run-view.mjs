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
    watermark: run.watermark ?? null, sequence: run.sequence ?? null,
    cards: run.cards ?? [],
    effects: (run.effects ?? []).map(effect => ({ effect_id: effect.effect_id, card_id: effect.card_id ?? null,
      contract: effect.operation_contract ?? effect.effect_kind ?? null, status: effect.status,
      outcome: effect.receipt?.provider_receipt?.outcome ?? effect.receipt?.outcome ?? effect.last_observation?.provider_observation?.code ?? null })),
    blocks: run.blocks ?? [], legal_actions: runDecisionActions(run).map(({ command: _command, ...action }) => action),
    ...(run.deep_research ? { deep_research: run.deep_research } : {}),
  };
}

export function renderRunPreview(preview) {
  const { inspection } = preview;
  return ["Prepared supervised task", `Project: ${preview.repository}`, `Client runtime: ${preview.runtime_root}`,
    `Request: ${preview.request}`, `Task: ${inspection.brief?.summary ?? "unknown"}`,
    ...(inspection.brief?.acceptance ?? []).map((criterion, index) => `  ${index + 1}. ${criterion}`),
    `Check: ${inspection.project_check ? JSON.stringify(inspection.project_check.registration?.argv ?? inspection.project_check) : JSON.stringify(inspection.trust_posture?.verification_scope ?? "See retained confirmation")}`,
    `Trust: ${JSON.stringify(inspection.trust_posture)}`, `Limits: ${JSON.stringify(inspection.limits)}`,
    `Requested authority: ${JSON.stringify(inspection.requested_authority ?? null)}`, `Delegate routes: ${JSON.stringify(inspection.routes ?? [])}`,
    `Authority: ${preview.authority_directory}`, `Prepared confirmation: ${preview.prepared_file}`,
    `Confirmation digest: ${preview.confirmation_digest}`, preview.recovery_disclosure, ""].map(terminalText).join("\n");
}

export function renderRunProgress(progress) {
  return [`Run ${progress.run_id}: ${progress.phase}`,
    ...(progress.deep_research ? [`  Deep cycle: ${progress.deep_research.cycle ?? "unavailable"}; remaining cycles: ${progress.deep_research.remaining_cycles ?? "unavailable"}; operationally blocked: ${progress.deep_research.operationally_blocked}`,
      `  Effective question: ${progress.deep_research.scope?.text ?? "unavailable"}`,
      ...(progress.deep_research.operationally_blocked && progress.deep_research.code ? [`  Deep evidence blocked: ${progress.deep_research.code}; inspect the original authority before continuing.`] : []),
      ...(progress.deep_research.completion_block ? [`  Deep completion blocked: ${progress.deep_research.completion_block}; retained report evidence does not authorize success.`] : []),
      ...(progress.deep_research.scope_proposal ? [`  Scope checkpoint: ${progress.deep_research.scope_proposal.checkpoint_id}; explicit approval required; remaining original seconds: ${progress.deep_research.scope_proposal.remaining_elapsed_seconds ?? "unavailable"}`] : []),
      ...(progress.deep_research.report?.cap_exhausted ? ["  Research cycle cap exhausted; findings and residual gaps remain in the cited report."] : [])] : []),
    ...progress.cards.map(card => `  ${card.id}: ${card.status}`),
    ...progress.effects.filter(effect => ["reconciling", "quarantined"].includes(effect.status)).map(effect => `  Effect ${effect.effect_id}: ${effect.status} (${effect.outcome ?? "outcome unresolved"})`),
    ...progress.blocks.map(block => `  Blocked: ${block.type ?? block.quarantine_reason ?? "authority decision required"}`), ""].map(terminalText).join("\n");
}

/** Retry accounting counts admitted attempts, including those still executing. */
export function projectRunBlocked(run) {
  // The session separately reports unresolved effects as blocked. Settled
  // cancellation retains failure history without changing its terminal phase.
  if (run.deep_research?.schema === "flow.deep-research-progress/v1" && run.phase === "cancelled") return false;
  return run.progress === "blocked" || (run.cards ?? []).some(card => card.status === "blocked") ||
    run.deep_research?.schema === "flow.deep-research-progress/v1" && run.deep_research.operationally_blocked === true ||
    run.deep_research?.schema === "flow.deep-research-progress/v1" && ["execution_time_unavailable", "execution_deadline_uncertain", "execution_deadline_exhausted", "deep_cycle_budget_unavailable"].includes(run.deep_research.completion_block) ||
    run.phase === "active" && (run.effects ?? []).some(effect => effect.operation_contract === "flow.operation/project-check/v2" &&
      effect.receipt?.provider_receipt?.schema === "work.project-check-absence-receipt/v2" &&
      ["failed", "timeout", "output_limit", "cancelled", "environment_failure"].includes(effect.receipt.provider_receipt.record?.outcome));
}

/** Pure observed check/resource facts, independent of guided command ownership. */
export function projectRunFacts(run) {
  const effects = run.effects ?? [];
  const configuredCheck = contract => (run.active_plan?.cards ?? []).find(card => card.executor?.contract === contract);
  const checkCard = configuredCheck("flow.operation/project-check/v2");
  const testCard = configuredCheck("flow.operation/feature-test/v1");
  const cardStatus = card => (run.cards ?? []).find(item => item.id === card?.id)?.status ?? "pending";
  const check = effects.find(effect => effect.operation_contract === "flow.operation/project-check/v2");
  const checkEnvelope = check?.receipt?.provider_receipt;
  const checkReceipt = checkEnvelope?.record ?? checkEnvelope;
  const tests = effects.filter(effect => effect.operation_contract === "flow.operation/feature-test/v1");
  const critique = (run.cards ?? []).find(card => /critique/u.test(card.id));
  const unresolved = effects.filter(effect => !effect.receipt && !["not_created", "abandoned"].includes(effect.status));
  const quarantined = effects.filter(effect => /quarantin/u.test(effect.status));
  return {
    checks: check || checkCard ? { kind: "registered_green_only", status: check?.status ?? cardStatus(checkCard), outcome: checkReceipt?.outcome ?? null,
      exit_code: checkReceipt?.exit_code ?? null, test_count: checkReceipt?.test_count ?? "unknown", evidence: checkReceipt ?? null }
      : tests.length ? { kind: "registered_expected_red_then_green", evidence: tests.map(effect => effect.receipt?.provider_receipt ?? null) }
        : testCard ? { kind: "registered_expected_red_then_green", status: cardStatus(testCard), evidence: [] }
        : { kind: "content_only", project_checks: "not_run", scope: (run.trust_posture ?? run.views?.trust?.trust_posture)?.verification_scope ?? null },
    critique: critique?.status ?? "not_observed",
    unresolved_effects: unresolved.map(effect => effect.effect_id), quarantined_effects: quarantined.map(effect => effect.effect_id),
    workspace_settlement: (run.resource_dispositions ?? []).map(disposition => ({ ...disposition })),
  };
}

export function summarizeProjectRun(run, { selection, candidate = null, status, projectionFile } = {}) {
  const effects = run.effects ?? [], facts = projectRunFacts(run);
  const checkReceipt = facts.checks.kind === "registered_green_only" ? facts.checks.evidence : null;
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
    checks: facts.checks,
    critique: facts.critique, separate_review: "not_requested", human_approval: "not_requested",
    unresolved_effects: facts.unresolved_effects, quarantined_effects: facts.quarantined_effects,
    workspace_settlement: facts.workspace_settlement,
    legal_actions: actions.map(({ command: _command, ...action }) => action), next_commands: next,
  };
}

export function renderRunResult(result) {
  return [`Result: ${result.status} (run phase ${result.phase})`, `Run: ${result.run_id}`,
    `Retained evidence: ${result.retained_directory}`, `Candidate: ${result.candidate ? JSON.stringify(result.candidate) : "not sealed/available"}`,
    `Checks: ${result.checks.kind} - ${result.checks.outcome ?? result.checks.status ?? result.checks.project_checks ?? "see retained evidence"}`,
    `Feature critique: ${result.critique}; separate review and human approval: not requested`,
    ...(result.status === "detached" ? ["Frontend detached. Durable work remains retained and was not cancelled by detaching; use the reattach command below."] : []),
    ...(result.unresolved_effects.length ? [`Unresolved effects: ${result.unresolved_effects.join(", ")}. Completion and workspace reuse are not established.`] : []),
    ...(result.quarantined_effects.length ? [`Quarantined effects: ${result.quarantined_effects.join(", ")}`] : []),
    `Workspace dispositions: ${JSON.stringify(result.workspace_settlement)}`,
    "Worker retirement and workspace reuse are separate authority facts. Use an offered settlement action when a cancelled run retains its workspace; this frontend never releases it automatically.",
    "Next commands:", ...result.next_commands.map(command => `  ${command}`), ""].map(terminalText).join("\n");
}
