import { quoteShell } from "../scripts/feature-client-files.mjs";
import { projectRunBlocked, summarizeProjectRun, terminalText } from "./project-run-view.mjs";
import { reviewAttachCommand } from "./project-review-view.mjs";

const text = value => typeof value === "string" ? value.slice(0, 1024) : value === null || value === undefined ? null : String(value).slice(0, 1024);
const strings = values => Array.isArray(values) ? values.slice(0, 32).map(text) : [];
const queryCommand = (client, request) => `${quoteShell(client)} query --input ${quoteShell(JSON.stringify(request))} --json`;
const previewCommand = selection => `flow-supervised run --repository ${quoteShell(selection.repository)} --request ${quoteShell(selection.request)}`;
const attachCommand = (attempt, id) => attempt.kind === "review" ? reviewAttachCommand(attempt.selection, id) : `${previewCommand(attempt.selection)} --attach ${quoteShell(id)}`;

function reviewFacts(record) {
  if (!record) return null;
  const coverage = record.coverage ?? record.summary?.coverage;
  const findings = record.rendered_findings ?? record.findings ?? record.summary?.rendered_findings ?? record.summary?.findings ?? [];
  return { review_id: text(record.subject_id), source_run_id: text(record.source_run_id), current: record.current ?? null,
    posture: text(record.posture ?? record.summary?.posture), coverage: { complete: coverage?.complete ?? null,
      lenses: (coverage?.lenses ?? []).slice(0, 16).map(lens => ({ lens: text(lens.lens), status: text(lens.status), reason: text(lens.reason) })),
      critic: { status: text(coverage?.critic?.status), reason: text(coverage?.critic?.reason) } },
    approval: text(record.approval), human_status: text(record.human_status), integration: text(record.integration),
    cap_reasons: strings(record.cap_reasons ?? record.summary?.cap_reasons), finding_count: findings.length,
    findings: findings.slice(0, 16).map(finding => ({ id: text(finding.id), severity: text(finding.severity), title: text(finding.title ?? finding.summary), lens: text(finding.lens) })),
    watermark: text(record.watermark) };
}

function attemptRow(attempt) {
  const { selection, run, retained } = attempt, id = run?.run_id ?? null;
  const attention = [...(attempt.attention ?? [])];
  const commands = [];
  const guided = Boolean(retained && attempt.state === "admitted");
  if (guided) commands.push({ kind: "attach", command: attachCommand(attempt, id), disclosure: "Attachment starts/reuses this exact owner and may recover previously accepted work." });
  else if (attempt.state === "prepared") {
    const command = attempt.kind === "review" ? `flow-supervised review --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --producer ${quoteShell(selection.producer_run_id)} --timeout-seconds ${selection.policy.max_elapsed_seconds} --max-revisions ${selection.policy.max_revisions}` : previewCommand(selection);
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
    const summary = summarizeProjectRun(run, { selection });
    const inherited = retained?.preview.inherited_checks;
    const isReview = attempt.kind === "review" || run.effects?.some(effect => effect.operation_contract === "flow.operation/review-record/v1");
    const check = isReview ? inherited ?? { kind: "inherited_producer_checks", status: "not_observed" } : summary.checks;
    checks = { kind: check.kind, status: text(check.status), outcome: text(check.outcome), exit_code: check.exit_code ?? null, test_count: check.test_count ?? "unknown", project_checks: check.project_checks ?? null, ...(isReview ? { rerun: false } : {}) };
    critique = isReview ? null : text(summary.critique); unresolved = strings(summary.unresolved_effects); quarantined = strings(summary.quarantined_effects);
    workspace = summary.workspace_settlement.slice(0, 16).map(item => ({ resource: text(item.resource?.subject_id ?? item.resource?.path ?? item.resource_id), status: text(item.status ?? item.disposition ?? item.state), reason: text(item.reason) }));
    if (projectRunBlocked(run)) attention.push("Authority reports blocked work.");
    if (unresolved.length) attention.push("Unresolved effects remain; completion and retirement are not established.");
    if (quarantined.length) attention.push("Quarantined effects require authority inspection.");
    if (workspace.length) attention.push("Workspace disposition is retained; a stopped owner or cancelled phase does not prove reuse.");
    if (attempt.record && (attempt.record.current !== true || (attempt.record.coverage ?? attempt.record.summary?.coverage)?.complete !== true)) attention.push("Independent review is stale, incomplete or capped; inspect the exact record.");
  }
  const candidate = attempt.candidate;
  const result = { kind: attempt.kind, state: attempt.state, run_id: id, intended_run_id: attempt.intended_run_id ?? null,
    client: selection.client, runtime_root: selection.runtime_root, request: selection.request ?? null, retained_directory: selection.retained_directory ?? null,
    observation: attempt.observation ?? "retained", summary: text(attempt.summary ?? selection.preparation?.brief?.summary ?? selection.preparation?.summary ?? retained?.preview.inspection?.brief?.summary),
    phase: text(run?.phase), sequence: run?.sequence ?? null, watermark: text(run?.watermark),
    producer_run_id: text(selection.producer_run_id ?? attempt.producer_run_id),
    candidate: candidate ? { id: text(candidate.subject_id), fingerprint: text(candidate.candidate_fingerprint), status: text(candidate.status), generation: candidate.generation ?? null,
      commit: text(candidate.candidate?.git?.commit_sha), watermark: text(candidate.watermark) } : null,
    checks, critique, review: reviewFacts(attempt.record), separate_review_run_ids: strings(attempt.separate_review_run_ids),
    human_approval: attempt.record?.approval ?? (attempt.separate_review_run_ids?.length ? "inspect_separate_review" : "not_observed"),
    unresolved_effects: unresolved, quarantined_effects: quarantined, workspace_dispositions: workspace,
    attention: attention.map(text), next_commands: commands };
  return result;
}

/** Compact public facts, never a second lifecycle projection. */
export function projectRunsReport(inventory) {
  const report = { ...inventory, clients: inventory.clients.map(({ selection: _selection, ...client }) => client),
    attempts: inventory.attempts.map(attemptRow), diagnostics: inventory.diagnostics.map(item => ({ path: text(item.path), code: text(item.code), message: text(item.message) })) };
  if (report.complete && report.attempts.some(row => row.attention.length)) report.status = "attention";
  // Bound the actual serialized output, not just the number of rows.
  while (Buffer.byteLength(JSON.stringify(report)) > report.limits.output_bytes && report.attempts.length) {
    report.attempts.pop(); report.complete = false; report.status = "unavailable";
    if (!report.diagnostics.some(item => item.code === "output_limit")) report.diagnostics.push({ path: report.repository, code: "output_limit", message: "Output limit reached; additional attempts are not displayed." });
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
    if (row.checks) lines.push(`  Checks: ${row.checks.kind}; ${row.checks.outcome ?? row.checks.status ?? row.checks.project_checks ?? "not observed"}; test count ${row.checks.test_count}${row.checks.rerun === false ? " (inherited; not rerun)" : ""}`);
    if (row.critique) lines.push(`  Feature critique: ${row.critique}`);
    if (row.candidate) lines.push(`  Candidate: ${row.candidate.id}; ${row.candidate.status}; ${row.candidate.fingerprint}`);
    if (row.separate_review_run_ids.length) lines.push(`  Separate reviews: ${row.separate_review_run_ids.join(", ")}`);
    if (row.review) lines.push(`  Review ${row.review.review_id}: ${row.review.posture ?? "unknown"}; coverage ${row.review.coverage.complete === true ? "complete" : "incomplete/unknown"}; findings ${row.review.finding_count}`, `  Human approval: ${row.review.approval ?? "not observed"}; human status: ${row.review.human_status ?? "not observed"}`, ...row.review.cap_reasons.map(reason => `  Review cap: ${reason}`));
    for (const reason of row.attention) lines.push(`  Attention: ${reason}`);
    for (const command of row.next_commands) lines.push(`  ${command.kind}: ${command.command}`, ...(command.disclosure ? [`    ${command.disclosure}`] : []));
  }
  for (const issue of report.diagnostics) lines.push(`Unavailable: ${issue.path} - ${issue.code}: ${issue.message}`);
  lines.push("", "Overview only: no start, recovery, preparation, confirmation, launch or decision was performed.", "");
  return lines.map(terminalText).join("\n");
}
