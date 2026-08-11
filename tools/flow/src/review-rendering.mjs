import { digest, freezeCanonical } from "./canonical.mjs";

const REVIEW_OPERATION_CONTRACT = "flow.operation/review-record/v1";

const URGENCY = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

/**
 * Normalize one semantic finding without consulting a clock, filesystem, or
 * provider. The resulting identity is stable across renderers and retries.
 */
export function normalizeReviewFinding(finding, {
  defaultLens = null,
  source = "lens",
} = {}) {
  if (!isRecord(finding)) {
    throw reviewValidationError("malformed_finding", "finding must be an object");
  }
  const lens = finding.lens ?? defaultLens;
  const urgency = finding.urgency ?? finding.severity;
  const classification = finding.classification ??
    (finding.blocking === true ? "blocking" : "non_blocking");
  const summary = finding.summary ?? finding.title;
  const detail = finding.detail ?? finding.description;
  if (!nonEmpty(lens) || !Object.hasOwn(URGENCY, urgency) ||
      !["blocking", "non_blocking"].includes(classification) ||
      !nonEmpty(summary) || !nonEmpty(detail)) {
    throw reviewValidationError(
      "malformed_finding",
      "finding requires a lens, urgency, classification, summary, and detail",
    );
  }
  const location = normalizeFindingLocation(finding.location, finding.inline);
  const inline = location === null ? null : location;
  const identity = {
    schema: "flow.review-finding/v1",
    lens,
    urgency,
    classification,
    summary,
    detail,
    location,
    inline,
  };
  const findingId = finding.finding_id ?? `finding:${digest(identity).slice("sha256:".length)}`;
  if (!/^finding:[0-9a-f]{64}$/u.test(findingId)) {
    throw reviewValidationError("malformed_finding", "finding identity is invalid");
  }
  const normalized = {
    ...identity,
    finding_id: findingId,
  };
  if (finding.finding_id !== undefined && digest(identity) !==
      `sha256:${findingId.slice("finding:".length)}`) {
    throw reviewValidationError(
      "finding_identity_mismatch",
      "finding identity is not bound to its semantic content",
    );
  }
  return freezeCanonical({ ...normalized, source });
}

export function normalizeReviewFindings(findings, {
  lens = null,
  source = "lens",
} = {}) {
  if (!Array.isArray(findings)) {
    throw reviewValidationError("malformed_findings", "findings must be an array");
  }
  const normalized = findings.map((finding) => normalizeReviewFinding(finding, {
    defaultLens: lens,
    source,
  }));
  const ids = new Set();
  for (const finding of normalized) {
    if (ids.has(finding.finding_id)) {
      throw reviewValidationError(
        "duplicate_finding",
        `finding identity is duplicated: ${finding.finding_id}`,
      );
    }
    ids.add(finding.finding_id);
  }
  return normalized.sort(compareFindings);
}

/**
 * Parse a delegated result. Delegates may return a JSON object or a JSON
 * string, but only the canonical review result shape becomes evidence.
 */
export function parseReviewDelegateResult(output, {
  lens = null,
  role = "lens",
} = {}) {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      throw reviewValidationError(
        "malformed_delegate_result",
        `${role} delegate output is not valid JSON`,
      );
    }
  }
  if (!isRecord(value) || value.schema !== "flow.review-result/v1" ||
      !Array.isArray(value.findings)) {
    throw reviewValidationError(
      "malformed_delegate_result",
      `${role} delegate output has an invalid review result contract`,
    );
  }
  const findings = normalizeReviewFindings(value.findings, {
    lens,
    source: role,
  });
  if (lens !== null && findings.some((finding) => finding.lens !== lens)) {
    throw reviewValidationError(
      "finding_lens_mismatch",
      `${role} findings are not bound to the selected lens`,
    );
  }
  const posture = value.posture ?? "no_findings";
  if (![
    "no_findings",
    "findings",
    "review_incomplete",
    "blocked",
  ].includes(posture)) {
    throw reviewValidationError("malformed_delegate_result", "review posture is invalid");
  }
  return freezeCanonical({
    schema: "flow.review-result/v1",
    posture,
    findings,
    evidence: value.evidence ?? null,
    cap_reasons: normalizeCapReasons(value.cap_reasons),
  });
}

export function buildReviewSummary({
  candidateFingerprint,
  candidateAuthorityWatermark,
  lifecycleGeneration,
  enabledLenses,
  lensResults,
  criticResult,
  sourceAuthorityWatermark,
  findingCap = 100,
}) {
  if (!isDigest(candidateFingerprint) ||
      !isDigest(candidateAuthorityWatermark) ||
      !Number.isSafeInteger(lifecycleGeneration) || lifecycleGeneration < 1 ||
      !Array.isArray(enabledLenses) || enabledLenses.length === 0 ||
      !isRecord(lensResults) || !isReviewResultInput(criticResult) ||
      !isDigest(sourceAuthorityWatermark)) {
    throw reviewValidationError("invalid_review_evidence", "review evidence is incomplete");
  }
  if (!Number.isSafeInteger(findingCap) || findingCap < 1) {
    throw reviewValidationError("invalid_finding_cap", "finding cap must be positive");
  }
  const orderedLenses = [...enabledLenses].sort();
  if (new Set(orderedLenses).size !== orderedLenses.length ||
      orderedLenses.some((lens) => !nonEmpty(lens))) {
    throw reviewValidationError(
      "invalid_review_evidence",
      "review evidence contains duplicate or invalid lenses",
    );
  }
  const results = orderedLenses.map((lens) => {
    if (!Object.hasOwn(lensResults, lens)) {
      throw reviewValidationError("incomplete_lens_join", `missing finding lens: ${lens}`);
    }
    return parseReviewDelegateResult(lensResults[lens], { lens, role: "lens" });
  });
  const critic = parseReviewDelegateResult(criticResult, { role: "critic" });
  const lensFindings = results.flatMap(({ findings }) => findings);
  const criticFindings = critic.findings;
  const allFindings = [...lensFindings, ...criticFindings]
    .map((finding) => ({ ...finding, source: "review" }))
    .sort(compareFindings);
  const stableFindings = deduplicateSemanticFindings(allFindings);
  const capReasons = normalizeCapReasons([
    ...results.flatMap(({ cap_reasons: reasons }) => reasons),
    ...critic.cap_reasons,
  ]);
  const renderedFindings = stableFindings.slice(0, findingCap);
  if (stableFindings.length > findingCap) {
    capReasons.push({
      code: "finding_cap",
      detail: `${stableFindings.length - findingCap} findings retained outside the rendered cap`,
      count: stableFindings.length - findingCap,
    });
  }
  capReasons.sort(compareCapReasons);
  const postures = [...results, critic].map(({ posture: value }) => value);
  const posture = postures.includes("blocked")
    ? "blocked"
    : postures.includes("review_incomplete")
      ? "review_incomplete"
      : postures.includes("findings") || stableFindings.length > 0
        ? "findings"
        : "no_findings";
  return freezeCanonical({
    schema: "flow.review-summary/v1",
    candidate_fingerprint: candidateFingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    enabled_lenses: orderedLenses,
    finding_cap: findingCap,
    lens_results: results,
    critic_result: critic,
    findings: stableFindings,
    rendered_findings: renderedFindings,
    cap_reasons: capReasons,
    posture,
    automated_evidence: {
      schema: "flow.review-automated-evidence/v1",
      source_authority_watermark: sourceAuthorityWatermark,
      lens_evidence: results.map((result, index) => ({
        lens: orderedLenses[index],
        evidence_digest: digest(result),
      })),
      critic_evidence_digest: digest(critic),
    },
  });
}

export function renderReviewArtifacts({
  summary,
  provenance,
  watermark,
}) {
  if (summary?.schema !== "flow.review-summary/v1" ||
      !isDigest(summary.candidate_fingerprint) ||
      !isDigest(summary.candidate_authority_watermark) ||
      !Number.isSafeInteger(summary.lifecycle_generation) ||
      summary.lifecycle_generation < 1 ||
      !Number.isSafeInteger(summary.finding_cap) || summary.finding_cap < 1 ||
      !Array.isArray(summary.findings) ||
      !Array.isArray(summary.rendered_findings) ||
      !Array.isArray(summary.cap_reasons) ||
      summary.rendered_findings.length > summary.finding_cap ||
      !["no_findings", "findings", "review_incomplete", "blocked"]
        .includes(summary.posture) ||
      !isRecord(summary.automated_evidence) ||
      summary.automated_evidence.schema !== "flow.review-automated-evidence/v1" ||
      !isDigest(summary.automated_evidence.source_authority_watermark) ||
      !isDigest(watermark) || !isRecord(provenance) ||
      provenance.operation_contract !== REVIEW_OPERATION_CONTRACT ||
      !nonEmpty(provenance.run_id) ||
      !nonEmpty(provenance.operation_effect_id) ||
      !nonEmpty(provenance.operation_attempt_id) ||
      !nonEmpty(provenance.operation_idempotency_key)) {
    throw reviewValidationError("invalid_render_input", "review renderer input is incomplete");
  }
  const canonicalProvenance = freezeCanonical({
    schema: "flow.review-provenance/v1",
    operation_contract: REVIEW_OPERATION_CONTRACT,
    operation_idempotency_key: provenance.operation_idempotency_key,
    run_id: provenance.run_id,
    operation_effect_id: provenance.operation_effect_id,
    operation_attempt_id: provenance.operation_attempt_id,
    candidate_fingerprint: summary.candidate_fingerprint,
    lifecycle_generation: summary.lifecycle_generation,
    candidate_authority_watermark: summary.candidate_authority_watermark,
    source_authority_watermark: summary.automated_evidence.source_authority_watermark,
    review_authority_watermark: watermark,
  });
  const jsonValue = {
    schema: "flow.review-artifact-json/v1",
    watermark,
    provenance: canonicalProvenance,
    posture: summary.posture,
    findings: summary.rendered_findings,
    semantic_findings: summary.findings,
    finding_cap: summary.finding_cap,
    cap_reasons: summary.cap_reasons,
    automated_evidence: summary.automated_evidence,
    approval: {
      status: "not_requested",
      integration_authorized: false,
      merge_authorized: false,
      tracker_completion_authorized: false,
      remote_submission_authorized: false,
    },
  };
  const json = `${JSON.stringify(jsonValue, null, 2)}\n`;
  const markdownLines = [
    "# Automated review",
    "",
    `- Posture: ${summary.posture}`,
    `- Candidate: ${summary.candidate_fingerprint}`,
    `- Lifecycle generation: ${summary.lifecycle_generation}`,
    `- Run: ${canonicalProvenance.run_id}`,
    `- Operation effect: ${canonicalProvenance.operation_effect_id}`,
    `- Operation attempt: ${canonicalProvenance.operation_attempt_id}`,
    `- Candidate seal watermark: ${canonicalProvenance.candidate_authority_watermark}`,
    `- Source authority watermark: ${canonicalProvenance.source_authority_watermark}`,
    `- Authority watermark: ${watermark}`,
    "- Approval: not requested (automated completion is not approval)",
    "",
    "## Findings",
    "",
  ];
  for (const finding of summary.rendered_findings) {
    const anchor = finding.inline?.path
      ? ` (${finding.inline.path}:${finding.inline.start_line ?? "?"})`
      : "";
    markdownLines.push(
      `- [${finding.urgency}] ${finding.summary}${anchor} - ${finding.detail}`,
    );
  }
  if (summary.rendered_findings.length === 0) markdownLines.push("- No findings.");
  if (summary.cap_reasons.length > 0) {
    markdownLines.push("", "## Cap reasons", "");
    for (const reason of summary.cap_reasons) {
      markdownLines.push(`- ${reason.code}: ${reason.detail}`);
    }
  }
  const markdown = `${markdownLines.join("\n")}\n`;
  const escaped = escapeHtml(markdown);
  const html = [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>Automated review - ${summary.candidate_fingerprint}</title>`,
    `<article data-schema="flow.review-artifact-html/v1" data-watermark="${watermark}">`,
    `<pre>${escaped}</pre>`,
    "</article>",
    "",
  ].join("\n");
  return freezeCanonical({
    schema: "flow.review-artifacts/v1",
    watermark,
    provenance: canonicalProvenance,
    formats: {
      json,
      markdown,
      html,
    },
    digests: {
      json: digest(json),
      markdown: digest(markdown),
      html: digest(html),
    },
  });
}

export function reviewValidationError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function deduplicateSemanticFindings(findings) {
  const byId = new Map();
  for (const finding of findings) {
    const identity = semanticFindingIdentity(finding);
    const existing = byId.get(identity);
    if (existing === undefined || compareFindings(finding, existing) < 0) {
      byId.set(identity, finding);
    }
  }
  return [...byId.values()].sort(compareFindings);
}

function semanticFindingIdentity(finding) {
  const { finding_id: _findingId, source: _source, ...identity } = finding;
  return digest(identity);
}

function compareFindings(left, right) {
  return (URGENCY[left.urgency] - URGENCY[right.urgency]) ||
    left.finding_id.localeCompare(right.finding_id);
}

function compareCapReasons(left, right) {
  return left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail);
}

function normalizeCapReasons(reasons) {
  if (reasons === undefined) return [];
  if (!Array.isArray(reasons) || reasons.some((reason) => !isRecord(reason) ||
      !nonEmpty(reason.code) || !nonEmpty(reason.detail) ||
      reason.count !== undefined &&
        (!Number.isSafeInteger(reason.count) || reason.count < 0))) {
    throw reviewValidationError("malformed_cap_reason", "cap reasons are malformed");
  }
  const normalized = reasons.map((reason) => ({
    code: reason.code,
    detail: reason.detail,
    ...(Number.isSafeInteger(reason.count) ? { count: reason.count } : {}),
  }));
  return [...new Map(normalized.map((reason) => [digest(reason), reason])).values()];
}

function normalizeFindingLocation(location, inline) {
  const candidate = location ?? inline ?? null;
  if (candidate === null) return null;
  if (!isRecord(candidate) || !nonEmpty(candidate.path) ||
      !Number.isSafeInteger(candidate.start_line) || candidate.start_line < 1 ||
      candidate.end_line !== undefined &&
        (!Number.isSafeInteger(candidate.end_line) || candidate.end_line < candidate.start_line) ||
      candidate.start_column !== undefined &&
        (!Number.isSafeInteger(candidate.start_column) || candidate.start_column < 1) ||
      candidate.end_column !== undefined &&
        (!Number.isSafeInteger(candidate.end_column) || candidate.end_column < 1)) {
    throw reviewValidationError("malformed_finding", "finding location is invalid");
  }
  return {
    path: candidate.path,
    start_line: candidate.start_line,
    ...(candidate.end_line === undefined ? {} : { end_line: candidate.end_line }),
    ...(candidate.start_column === undefined ? {} : { start_column: candidate.start_column }),
    ...(candidate.end_column === undefined ? {} : { end_column: candidate.end_column }),
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReviewResultInput(value) {
  return typeof value === "string" || isRecord(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}
