import { readResearchReport, researchAttachCommand, researchConfirmCommand } from "./project-research-view.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";
import { projectRunBlocked, projectRunFacts, terminalText } from "./project-run-view.mjs";
import { reviewAttachCommand } from "./project-review-view.mjs";

const text = value => typeof value === "string" ? value.slice(0, 1024) : value === null || value === undefined ? null : String(value).slice(0, 1024);
const strings = values => Array.isArray(values) ? values.slice(0, 32).map(text) : [];
const display = value => value !== null && typeof value === "object" ? JSON.stringify(value) : value ?? "not observed";
function boundedJson(value, truncated, field) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 256 || depth > 6) { truncated.add(field); return "[truncated]"; }
    if (typeof item === "string") { if (item.length > 1024) truncated.add(field); return item.slice(0, 1024); }
    if (item === null || item === undefined) return null;
    if (Array.isArray(item)) { if (item.length > 32) truncated.add(field); return item.slice(0, 32).map(child => visit(child, depth + 1)); }
    if (typeof item === "object") { const keys = Object.keys(item).sort(); if (keys.length > 32) truncated.add(field); return Object.fromEntries(keys.slice(0, 32).map(key => [key, visit(item[key], depth + 1)])); }
    return item;
  }
  return visit(value, 0);
}
const queryCommand = (client, request) => `${quoteShell(client)} query --input ${quoteShell(JSON.stringify(request))} --json`;
const previewCommand = selection => `flow-supervised run --repository ${quoteShell(selection.repository)} --request ${quoteShell(selection.request)}`;
const attachCommand = (attempt, id) => attempt.kind === "research" ? researchAttachCommand(attempt.selection, id) : attempt.kind === "review" ? reviewAttachCommand(attempt.selection, id) : `${previewCommand(attempt.selection)} --attach ${quoteShell(id)}`;

function reviewFacts(record, copy) {
  if (!record) return null;
  const coverage = record.coverage ?? record.summary?.coverage;
  const findings = record.rendered_findings ?? record.findings ?? record.summary?.rendered_findings ?? record.summary?.findings ?? [];
  return { review_id: text(record.subject_id), source_run_id: text(record.source_run_id), current: record.current ?? null,
    posture: text(record.posture ?? record.summary?.posture), coverage: { complete: coverage?.complete ?? null,
      lenses: (coverage?.lenses ?? []).slice(0, 16).map(lens => ({ lens: text(lens.lens), status: text(lens.status), reason: text(lens.reason) })),
      critic: { status: text(coverage?.critic?.status), reason: text(coverage?.critic?.reason) } },
    approval: copy(record.approval, "review.approval"), human_status: copy(record.human_status, "review.human_status"), integration: copy(record.integration, "review.integration"),
    cap_reasons: copy(record.cap_reasons ?? record.summary?.cap_reasons ?? [], "review.cap_reasons"), finding_count: findings.length, findings_truncated: findings.length > 16,
    findings: findings.slice(0, 16).map(finding => ({ id: text(finding.id), severity: text(finding.severity), title: text(finding.title ?? finding.summary), lens: text(finding.lens) })),
    watermark: copy(record.watermark, "review.watermark") };
}

function attemptRow(attempt) {
  const { selection, run, retained } = attempt, id = run?.run_id ?? null;
  const truncated = new Set(), copy = (value, field) => boundedJson(value, truncated, field);
  const attention = [...(attempt.attention ?? [])];
  let unresolvedCount = 0, quarantinedCount = 0;
  const commands = [];
  const guided = Boolean(retained && attempt.state === "admitted");
  if (guided) commands.push({ kind: "attach", command: attachCommand(attempt, id), disclosure: "Attachment starts/reuses this exact owner and may recover previously accepted work." });
  else if (attempt.state === "prepared") {
    const command = attempt.kind === "research" ? researchConfirmCommand(selection, retained.preview.confirmation_digest).replace(/ --confirm .*$/u, "") : attempt.kind === "review" ? `flow-supervised review --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --producer ${quoteShell(selection.producer_run_id)} --timeout-seconds ${selection.policy.max_elapsed_seconds} --max-revisions ${selection.policy.max_revisions}` : previewCommand(selection);
    commands.push({ kind: "inspect_preview", command: `${quoteShell(selection.client)} local inspect-prepared ${quoteShell(retained.preview.prepared_file)}` });
    commands.push({ kind: "confirm", command: `${command} --confirm ${quoteShell(retained.preview.confirmation_digest)}`, disclosure: "Explicit confirmation may start/reuse the owner and launch this exact retained task; inspect its current confirmation first." });
  } else if (attempt.state === "accepted_unknown" && retained) {
    commands.push({ kind: "inspect_intended_run", command: queryCommand(selection.client, { run_id: retained.preview.run_id }) });
    commands.push({ kind: "resume_exact_attempt", command: attachCommand(attempt, retained.preview.run_id), disclosure: "Accepted intent is not proof of admission. This explicit command inspects/reuses the same attempt and may start its owner; it does not authorize a replacement." });
  } else if (attempt.state === "not_prepared" && attempt.kind === "feature") {
    commands.push({ kind: "preview", command: previewCommand(selection), disclosure: "This explicit preparation starts/reuses the exact owner and can recover previously accepted work; launch still requires confirmation." });
  }
  if (run && !guided) {
    commands.push({ kind: "query", command: queryCommand(selection.client, { run_id: id }) });
    commands.push({ kind: "start_original_owner", command: `${quoteShell(selection.client)} start --json`, disclosure: "Explicit startup can recover previously accepted work. This overview never starts it." });
  }
  if (["incomplete", "archived", "unavailable"].includes(attempt.state)) attention.push("Preserve the retained path and inspect it manually; no guided launch or attach is inferred.");
  let checks = null, critique = null, unresolved = [], quarantined = [], workspace = [];
  if (run) {
    const summary = projectRunFacts(run);
    unresolvedCount = summary.unresolved_effects.length; quarantinedCount = summary.quarantined_effects.length;
    const inherited = retained?.preview.inherited_checks;
    const isReview = attempt.kind === "review" || run.effects?.some(effect => effect.operation_contract === "flow.operation/review-record/v1");
    const check = isReview ? inherited ?? { kind: "inherited_producer_checks", status: "not_observed" } : summary.checks;
    checks = { kind: check.kind, status: text(check.status), outcome: text(check.outcome), exit_code: check.exit_code ?? null, test_count: check.test_count ?? "unknown", project_checks: check.project_checks ?? null, ...(isReview ? { rerun: false } : {}) };
    critique = isReview ? null : text(summary.critique); unresolved = strings(summary.unresolved_effects); quarantined = strings(summary.quarantined_effects);
    workspace = summary.workspace_settlement.slice(0, 16).map(item => ({ claim: { id: text(item.claim?.id), generation: item.claim?.generation ?? null, mutation_epoch: item.claim?.mutation_epoch ?? null },
      disposition: copy(item.disposition, "workspace.disposition"), reason: copy(item.reason, "workspace.reason") }));
    if (summary.unresolved_effects.length > 32) truncated.add("unresolved_effects");
    if (summary.quarantined_effects.length > 32) truncated.add("quarantined_effects");
    if (summary.workspace_settlement.length > 16) truncated.add("workspace_dispositions");
    if (projectRunBlocked(run)) attention.push("Authority reports blocked work.");
    if (unresolved.length) attention.push("Unresolved effects remain; completion and retirement are not established.");
    if (quarantined.length) attention.push("Quarantined effects require authority inspection.");
    if (workspace.some(item => item.disposition !== "released")) attention.push("Workspace disposition is retained; a stopped owner or cancelled phase does not prove reuse.");
    if (attempt.record && (attempt.record.current !== true || (attempt.record.coverage ?? attempt.record.summary?.coverage)?.complete !== true)) attention.push("Independent review is stale, incomplete or capped; inspect the exact record.");
  }
  let research = null;
  if (attempt.kind === "research") {
    const packet = selection.packet ?? run?.active_plan?.cards?.find(card => card.id === "spike-research")?.inputs?.task_inputs?.packet;
    let report = null;
    if (packet && run) {
      try { report = readResearchReport(run, packet); }
      catch { attention.push("Research report does not bind the exact accepted source/evidence attempt; inspect original public evidence."); }
    }
    research = { question: text(packet?.question?.text), packet_digest: text(packet?.packet_digest),
      report_status: report ? "validated_report" : "not_observed", assurance: report?.assurance ?? null,
      finding_count: report?.findings.length ?? null, residual_gap_count: report?.residual_gaps.length ?? null,
      research_evidence_digest: text(report?.research_evidence_digest) };
    checks = null; critique = null;
  }
  const candidate = attempt.kind === "research" ? null : attempt.candidate;
  const result = { kind: attempt.kind, state: attempt.state, run_id: id, intended_run_id: attempt.intended_run_id ?? null,
    client: selection.client, runtime_root: selection.runtime_root, request: selection.request ?? null, retained_directory: selection.retained_directory ?? null,
    observation: attempt.observation ?? "retained", summary: text(research?.question ?? attempt.summary ?? selection.preparation?.brief?.summary ?? selection.preparation?.summary ?? retained?.preview.inspection?.brief?.summary),
    phase: text(run?.phase), sequence: run?.sequence ?? null, watermark: copy(run?.watermark, "watermark"),
    producer_run_id: text(selection.producer_run_id ?? attempt.producer_run_id),
    candidate: candidate ? { id: text(candidate.subject_id), fingerprint: text(candidate.candidate_fingerprint), status: text(candidate.status), generation: candidate.generation ?? null,
      commit: text(candidate.candidate?.git?.commit_sha), watermark: copy(candidate.watermark, "candidate.watermark") } : null,
    research, checks, critique, review: reviewFacts(attempt.record, copy), separate_review_run_ids: strings(attempt.separate_review_run_ids),
    human_approval: copy(attempt.record?.approval, "human_approval") ?? (attempt.separate_review_run_ids?.length ? "inspect_separate_review" : "not_observed"),
    unresolved_effects: unresolved, unresolved_effect_count: unresolvedCount, unresolved_effects_truncated: truncated.has("unresolved_effects"),
    quarantined_effects: quarantined, quarantined_effect_count: quarantinedCount, quarantined_effects_truncated: truncated.has("quarantined_effects"), workspace_dispositions: workspace,
    workspace_disposition_count: run?.resource_dispositions?.length ?? 0, workspace_dispositions_truncated: truncated.has("workspace_dispositions"),
    attention: attention.map(text), field_truncations: [...truncated], next_commands: commands };
  return result;
}

/** Compact public facts, never a second lifecycle projection. */
export function projectRunsReport(inventory) {
  const report = { ...inventory, clients: inventory.clients.map(({ selection: _selection, ...client }) => ({ ...client, ...(client.reason ? { reason: text(client.reason) } : {}) })),
    authorities: inventory.authorities.map(owner => {
      const truncated = new Set();
      return { ...owner, reason: text(owner.reason), watermark: boundedJson(owner.watermark, truncated, "authority.watermark"), field_truncations: [...truncated] };
    }),
    attempts: inventory.attempts.map(attemptRow), diagnostics: inventory.diagnostics.map(item => ({ path: text(item.path), code: text(item.code), message: text(item.message) })) };
  if (report.attempts.some(row => row.field_truncations.length) || report.authorities.some(row => row.field_truncations.length)) { report.complete = false; report.status = "unavailable"; report.diagnostics.push({ code: "field_truncation", path: report.repository, message: "Some compact fields were truncated; counts and field names are shown." }); }
  if (report.complete && report.attempts.some(row => row.attention.length)) report.status = "attention";
  // Bound the actual serialized output, not just the number of rows.
  while (Buffer.byteLength(JSON.stringify(report)) > report.limits.output_bytes && (report.attempts.length || report.authorities.length || report.clients.length || report.diagnostics.length > 1)) {
    if (report.attempts.length) report.attempts.pop();
    else if (report.authorities.length) report.authorities.pop();
    else if (report.clients.length) report.clients.pop();
    else report.diagnostics.splice(report.diagnostics.findIndex(item => item.code !== "output_limit"), 1);
    report.complete = false; report.status = "unavailable";
    if (!report.diagnostics.some(item => item.code === "output_limit")) report.diagnostics.push({ path: report.repository, code: "output_limit", message: "Output limit reached; additional rows are not displayed." });
  }
  return report;
}

export function renderProjectRuns(report) {
  const lines = ["Flow project runs", `Project: ${report.repository}`, `Overview: ${report.status}${report.complete ? "" : " (incomplete; undisplayed work may exist)"}`];
  if (report.status === "uninitialized") lines.push("No initialized project profile in the selected state directory. Run flow-supervised init.");
  for (const owner of report.authorities) lines.push(`Owner: ${owner.owner_state}; observation: ${owner.observation}`, `  ${owner.authority_directory}`, ...(owner.observation === "inspect_only" ? ["  Historical inspect-only facts; no owner was started. Current execution, retirement and workspace reuse are not established."] : []));
  if (!report.attempts.length && report.status !== "uninitialized") lines.push("No retained attempts were found in the inspected scope.");
  for (const row of report.attempts) {
    lines.push("", `${row.kind}: ${row.summary?.slice(0, 160) ?? "retained task"}`, `  ID: ${row.run_id ?? row.intended_run_id ?? "not admitted"}`, `  ${row.state}${row.phase ? `; phase ${row.phase}` : ""}; ${row.observation}`, `  Client runtime: ${row.runtime_root}`, `  Retained: ${row.retained_directory ?? row.request ?? "public authority"}`);
    if (row.research) lines.push(`  Research packet: ${row.research.packet_digest ?? "unavailable"}; report ${row.research.report_status}; assurance ${row.research.assurance ?? "not observed"}; residual gaps ${row.research.residual_gap_count ?? "unknown"}`, "  Supplied-source research only; no candidate, human approval or publication.");
    if (row.checks) lines.push(`  Checks: ${row.checks.kind}; ${row.checks.outcome ?? row.checks.status ?? row.checks.project_checks ?? "not observed"}; test count ${row.checks.test_count}${row.checks.rerun === false ? " (inherited; not rerun)" : ""}`);
    if (row.critique) lines.push(`  Feature critique: ${row.critique}`);
    if (row.candidate) lines.push(`  Candidate: ${row.candidate.id}; ${row.candidate.status}; ${row.candidate.fingerprint}`);
    if (row.separate_review_run_ids.length) lines.push(`  Separate reviews: ${row.separate_review_run_ids.join(", ")}`);
    if (row.review) lines.push(`  Review ${row.review.review_id}: ${row.review.posture ?? "unknown"}; coverage ${row.review.coverage.complete === true ? "complete" : "incomplete/unknown"}; findings ${row.review.finding_count}`, `  Human approval: ${display(row.review.approval)}; human status: ${display(row.review.human_status)}; integration: ${display(row.review.integration)}`, ...row.review.cap_reasons.map(reason => `  Review cap: ${display(reason)}`));
    if (row.unresolved_effect_count) lines.push(`  Unresolved effects: ${row.unresolved_effect_count}${row.unresolved_effects_truncated ? " (ID list truncated)" : ""}`);
    if (row.quarantined_effect_count) lines.push(`  Quarantined effects: ${row.quarantined_effect_count}${row.quarantined_effects_truncated ? " (ID list truncated)" : ""}`);
    for (const item of row.workspace_dispositions) lines.push(`  Workspace claim ${item.claim.id ?? "identity unavailable"} generation ${item.claim.generation ?? "unknown"} epoch ${item.claim.mutation_epoch ?? "unknown"}: ${display(item.disposition)}${item.reason ? ` (${display(item.reason)})` : ""}`);
    if (row.field_truncations.length) lines.push(`  Truncated fields: ${row.field_truncations.join(", ")}`);
    for (const reason of row.attention) lines.push(`  Attention: ${reason}`);
    for (const command of row.next_commands) lines.push(`  ${command.kind}: ${command.command}`, ...(command.disclosure ? [`    ${command.disclosure}`] : []));
  }
  for (const issue of report.diagnostics) lines.push(`Unavailable: ${issue.path} - ${issue.code}: ${issue.message}`);
  lines.push("", "Overview only: no start, recovery, preparation, confirmation, launch or decision was performed.", "");
  return lines.map(terminalText).join("\n");
}
