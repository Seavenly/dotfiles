import { digest, freezeCanonical } from "./canonical.mjs";

const REVIEW_OPERATION_CONTRACT = "flow.operation/review-record/v1";

export const REVIEW_ARTIFACT_MARKDOWN_SCHEMA =
  "flow.review-artifact-markdown/v1";
export const REVIEW_FINDING_SUMMARY_MAX_LENGTH = 240;
export const REVIEW_FINDING_DETAIL_MAX_LENGTH = 4_000;
export const REVIEW_COVERAGE_REASON_MAX_LENGTH = 256;
export const REVIEW_FINDING_LENS_MAX_LENGTH = 128;
export const REVIEW_FINDING_PATH_MAX_LENGTH = 2_048;
export const REVIEW_DELEGATE_FINDING_MAX_COUNT = 512;
export const REVIEW_CAP_REASON_MAX_COUNT = 64;
export const REVIEW_CAP_REASON_CODE_MAX_LENGTH = 128;
export const REVIEW_CAP_REASON_DETAIL_MAX_LENGTH = 512;

const URGENCY = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

export const REVIEW_URGENCY_PRESETS = Object.freeze({
  hotfix: "critical",
  fast: "high",
  standard: "info",
});

const REVIEW_COVERAGE_STATUSES = Object.freeze([
  "produced",
  "degraded",
  "unavailable",
]);

const REVIEW_ORIENTATION_SCHEMA = "flow.review-orientation/v1";
const REVIEW_DIAGRAM_SCHEMA = "flow.review-diagram/v1";
const MAX_REVIEW_ORIENTATION_LENGTH = 20_000;
const MAX_REVIEW_DIAGRAMS = 16;
const MAX_REVIEW_DIAGRAM_NAME_LENGTH = 128;
const MAX_REVIEW_DIAGRAM_SOURCE_LENGTH = 50_000;

/**
 * Normalize one semantic finding without consulting a clock, filesystem, or
 * provider. The resulting identity is stable across renderers and retries.
 */
export function normalizeReviewFinding(finding, {
  defaultLens = null,
  source = "lens",
  urgencyFloor = "info",
} = {}) {
  if (!isRecord(finding)) {
    throw reviewValidationError("malformed_finding", "finding must be an object");
  }
  if (finding.schema !== undefined && finding.schema !== "flow.review-finding/v1") {
    throw reviewValidationError(
      "malformed_finding",
      "finding schema is invalid",
    );
  }
  const lens = finding.lens ?? defaultLens;
  // The urgency floor filters the projection; it never rewrites delegate
  // evidence or semantic identity.
  const urgency = finding.urgency ?? finding.severity;
  const classification = finding.classification ??
    (finding.blocking === true ? "blocking" : "non_blocking");
  const summary = finding.summary ?? finding.title;
  const detail = finding.detail ?? finding.description;
  if (!isSafeReviewText(lens, REVIEW_FINDING_LENS_MAX_LENGTH) ||
      !Object.hasOwn(URGENCY, urgency) ||
      !["blocking", "non_blocking"].includes(classification) ||
      !isSafeReviewText(summary, REVIEW_FINDING_SUMMARY_MAX_LENGTH) ||
      !isSafeReviewText(detail, REVIEW_FINDING_DETAIL_MAX_LENGTH)) {
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
  urgencyFloor = "info",
} = {}) {
  if (!Array.isArray(findings)) {
    throw reviewValidationError("malformed_findings", "findings must be an array");
  }
  if (findings.length > REVIEW_DELEGATE_FINDING_MAX_COUNT) {
    throw reviewValidationError(
      "malformed_findings",
      `findings exceed the maximum of ${REVIEW_DELEGATE_FINDING_MAX_COUNT}`,
    );
  }
  const normalized = findings.map((finding) => normalizeReviewFinding(finding, {
    defaultLens: lens,
    source,
    urgencyFloor,
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
  urgencyFloor = "info",
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
  if (!isRecord(value) ||
      value.schema !== "flow.review-result/v1" ||
      !Array.isArray(value.findings)) {
    throw reviewValidationError(
      "malformed_delegate_result",
      `${role} delegate output has an invalid review result contract`,
    );
  }
  const findings = normalizeReviewFindings(value.findings, {
    lens,
    source: role,
    urgencyFloor,
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
  const coverage = normalizeReviewCoverage(value, { role });
  return freezeCanonical({
    schema: "flow.review-result/v1",
    posture,
    findings,
    coverage,
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
  urgencyFloor = "info",
  orientation = null,
  diagrams = [],
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
  const normalizedUrgencyFloor = normalizeReviewUrgencyFloor(urgencyFloor);
  const normalizedOrientation = normalizeReviewOrientation(orientation);
  const normalizedDiagrams = normalizeReviewDiagrams(diagrams);
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
    return parseReviewDelegateResult(lensResults[lens], {
      lens,
      role: "lens",
      urgencyFloor: normalizedUrgencyFloor,
    });
  });
  const critic = parseReviewDelegateResult(criticResult, {
    role: "critic",
    urgencyFloor: normalizedUrgencyFloor,
  });
  const lensFindings = results.flatMap(({ findings }) => findings);
  const criticFindings = critic.findings;
  const allFindings = [...lensFindings, ...criticFindings]
    .map((finding) => ({ ...finding, source: "review" }))
    .sort(compareFindings);
  const stableFindings = deduplicateSemanticFindings(allFindings);
  const selectedFindings = stableFindings.filter((finding) =>
    urgencyMeetsFloor(finding.urgency, normalizedUrgencyFloor));
  const capReasons = normalizeCapReasons([
    ...results.flatMap(({ cap_reasons: reasons }) => reasons),
    ...critic.cap_reasons,
  ]);
  const urgencyOmitted = stableFindings.filter((finding) =>
    !urgencyMeetsFloor(finding.urgency, normalizedUrgencyFloor));
  if (urgencyOmitted.length > 0) {
    capReasons.push({
      code: "urgency_floor",
      detail: `${urgencyOmitted.length} findings omitted below the ${normalizedUrgencyFloor} urgency floor`,
      count: urgencyOmitted.length,
      omitted_urgencies: [...new Set(urgencyOmitted.map(({ urgency }) => urgency))]
        .sort((left, right) => URGENCY[left] - URGENCY[right]),
    });
  }
  const renderedFindings = selectedFindings.slice(0, findingCap);
  if (selectedFindings.length > findingCap) {
    const overflowFindings = selectedFindings.slice(findingCap);
    capReasons.push({
      code: "finding_cap",
      detail: `${selectedFindings.length - findingCap} findings retained outside the rendered cap`,
      count: selectedFindings.length - findingCap,
      overflow_urgencies: [...new Set(overflowFindings.map(({ urgency }) => urgency))]
        .sort((left, right) => URGENCY[left] - URGENCY[right]),
    });
  }
  capReasons.sort(compareCapReasons);
  const postures = [...results, critic].map(({ posture: value }) => value);
  const coverage = {
    schema: "flow.review-coverage/v1",
    complete: [...results, critic].every(({ coverage: resultCoverage }) =>
      resultCoverage.status === "produced"),
    lenses: results.map(({ coverage: resultCoverage }, index) => ({
      lens: orderedLenses[index],
      status: resultCoverage.status,
      reason: resultCoverage.reason,
    })),
    critic: {
      status: critic.coverage.status,
      reason: critic.coverage.reason,
    },
  };
  const posture = postures.includes("blocked")
    ? "blocked"
    : !coverage.complete || postures.includes("review_incomplete")
      ? "review_incomplete"
      : postures.includes("findings") || selectedFindings.length > 0
        ? "findings"
        : "no_findings";
  return freezeCanonical({
    schema: "flow.review-summary/v1",
    candidate_fingerprint: candidateFingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    enabled_lenses: orderedLenses,
    finding_cap: findingCap,
    urgency_floor: normalizedUrgencyFloor,
    orientation: normalizedOrientation,
    diagrams: normalizedDiagrams,
    lens_results: results,
    critic_result: critic,
    findings: selectedFindings,
    rendered_findings: renderedFindings,
    cap_reasons: capReasons,
    posture,
    coverage,
    merge_ready: false,
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
      !isUrgency(summary.urgency_floor) ||
      summary.orientation === undefined ||
      !Array.isArray(summary.diagrams) ||
      !Array.isArray(summary.findings) ||
      !Array.isArray(summary.rendered_findings) ||
      !Array.isArray(summary.cap_reasons) ||
      summary.rendered_findings.length > summary.finding_cap ||
      !["no_findings", "findings", "review_incomplete", "blocked"]
        .includes(summary.posture) ||
      !isRecord(summary.coverage) ||
      summary.coverage.schema !== "flow.review-coverage/v1" ||
      typeof summary.coverage.complete !== "boolean" ||
      !isCanonicalReviewCoverage(summary.coverage, summary.enabled_lenses) ||
      summary.merge_ready !== false ||
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
  let normalizedOrientation;
  let normalizedDiagrams;
  try {
    normalizedOrientation = normalizeReviewOrientation(summary.orientation);
    normalizedDiagrams = normalizeReviewDiagrams(summary.diagrams);
  } catch {
    throw reviewValidationError(
      "invalid_render_input",
      "review renderer supplements are malformed",
    );
  }
  if (digest(normalizedOrientation) !== digest(summary.orientation) ||
      digest(normalizedDiagrams) !== digest(summary.diagrams)) {
    throw reviewValidationError(
      "invalid_render_input",
      "review renderer supplements are not canonical",
    );
  }
  let normalizedFindings;
  let normalizedRenderedFindings;
  let normalizedCapReasons;
  try {
    normalizedFindings = normalizeReviewFindings(summary.findings, {
      source: "review",
      urgencyFloor: summary.urgency_floor,
    });
    normalizedRenderedFindings = normalizeReviewFindings(summary.rendered_findings, {
      source: "review",
      urgencyFloor: summary.urgency_floor,
    });
    normalizedCapReasons = normalizeCapReasons(summary.cap_reasons);
  } catch {
    throw reviewValidationError(
      "invalid_render_input",
      "review renderer findings are malformed",
    );
  }
  if (digest(normalizedFindings) !== digest(summary.findings) ||
      digest(normalizedRenderedFindings) !== digest(summary.rendered_findings) ||
      digest(normalizedCapReasons) !== digest(summary.cap_reasons)) {
    throw reviewValidationError(
      "invalid_render_input",
      "review renderer findings are not canonical",
    );
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
    urgency_floor: summary.urgency_floor,
    orientation: summary.orientation,
    diagrams: summary.diagrams,
    coverage: summary.coverage,
    merge_ready: false,
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
    `<!-- ${REVIEW_ARTIFACT_MARKDOWN_SCHEMA} -->`,
    "# Automated review",
    "",
    `- Posture: ${summary.posture}`,
    `- Candidate: ${summary.candidate_fingerprint}`,
    `- Lifecycle generation: ${summary.lifecycle_generation}`,
    `- Run: ${canonicalProvenance.run_id}`,
    `- Operation contract: ${canonicalProvenance.operation_contract}`,
    `- Operation effect: ${canonicalProvenance.operation_effect_id}`,
    `- Operation attempt: ${canonicalProvenance.operation_attempt_id}`,
    `- Operation idempotency key: ${canonicalProvenance.operation_idempotency_key}`,
    `- Candidate seal watermark: ${canonicalProvenance.candidate_authority_watermark}`,
    `- Source authority watermark: ${canonicalProvenance.source_authority_watermark}`,
    `- Authority watermark: ${watermark}`,
    `- Urgency floor: ${summary.urgency_floor}`,
    "- Approval: not requested (automated completion is not approval)",
    "",
  ];
  if (summary.orientation !== null) {
    markdownLines.push("## Orientation", "", summary.orientation.markdown, "");
  }
  if (summary.diagrams.length > 0) {
    markdownLines.push("## Diagrams", "");
    for (const diagram of summary.diagrams) {
      markdownLines.push(
        `### ${diagram.name}`,
        "",
        "```mermaid",
        diagram.source,
        "```",
        "",
      );
    }
  }
  markdownLines.push("## Coverage", "", `- Complete: ${summary.coverage.complete}`);
  for (const participant of [
    ...summary.coverage.lenses.map((entry) => ({
      name: `Lens ${entry.lens}`,
      status: entry.status,
      reason: entry.reason,
    })),
    {
      name: "Critic",
      status: summary.coverage.critic.status,
      reason: summary.coverage.critic.reason,
    },
  ]) {
    markdownLines.push(
      `- ${participant.name}: ${participant.status}` +
        (participant.reason === null ? "" : ` (${participant.reason})`),
    );
  }
  markdownLines.push("");
  markdownLines.push("## Findings", "");
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

function urgencyMeetsFloor(urgency, floor) {
  return isUrgency(urgency) && URGENCY[urgency] <= URGENCY[floor];
}

export function normalizeReviewUrgencyFloor(floor) {
  if (floor === undefined || floor === null) return "info";
  if (Object.hasOwn(REVIEW_URGENCY_PRESETS, floor)) {
    return REVIEW_URGENCY_PRESETS[floor];
  }
  if (isUrgency(floor)) return floor;
  throw reviewValidationError("invalid_urgency_floor", "urgency floor is invalid");
}

export function normalizeReviewOrientation(value) {
  if (value === undefined || value === null) return null;
  let markdown = value;
  if (isRecord(value)) {
    if (value.schema !== undefined && value.schema !== REVIEW_ORIENTATION_SCHEMA ||
        Object.keys(value).some((key) => !["schema", "markdown"].includes(key))) {
      throw reviewValidationError(
        "malformed_review_supplement",
        "review orientation has an invalid shape",
      );
    }
    markdown = value.markdown;
  }
  if (typeof markdown !== "string" || markdown.trim().length === 0 ||
      markdown.length > MAX_REVIEW_ORIENTATION_LENGTH) {
    throw reviewValidationError(
      "malformed_review_supplement",
      "review orientation must be bounded non-empty markdown",
    );
  }
  return freezeCanonical({ schema: REVIEW_ORIENTATION_SCHEMA, markdown });
}

export function normalizeReviewDiagrams(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REVIEW_DIAGRAMS) {
    throw reviewValidationError(
      "malformed_review_supplement",
      "review diagrams must be a bounded array",
    );
  }
  const normalized = value.map((diagram, index) => {
    let name;
    let source;
    if (typeof diagram === "string") {
      source = diagram;
      name = `diagram-${digest(source).slice("sha256:".length, "sha256:".length + 12)}`;
    } else if (isRecord(diagram)) {
      if (diagram.schema !== undefined && diagram.schema !== REVIEW_DIAGRAM_SCHEMA ||
          Object.keys(diagram).some((key) => !["schema", "name", "source"].includes(key))) {
        throw reviewValidationError(
          "malformed_review_supplement",
          `review diagram ${index + 1} has an invalid shape`,
        );
      }
      name = diagram.name;
      source = diagram.source;
    } else {
      throw reviewValidationError(
        "malformed_review_supplement",
        `review diagram ${index + 1} must be an object or string`,
      );
    }
    if (typeof name !== "string" || name.trim().length === 0 ||
        name.length > MAX_REVIEW_DIAGRAM_NAME_LENGTH ||
        typeof source !== "string" || source.trim().length === 0 ||
        source.length > MAX_REVIEW_DIAGRAM_SOURCE_LENGTH ||
        source.includes("```")) {
      throw reviewValidationError(
        "malformed_review_supplement",
        `review diagram ${index + 1} is not bounded and renderable`,
      );
    }
    return {
      schema: REVIEW_DIAGRAM_SCHEMA,
      name,
      source,
    };
  });
  normalized.sort((left, right) =>
    left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
  const seen = new Set();
  for (const diagram of normalized) {
    const identity = digest(diagram);
    if (seen.has(identity)) {
      throw reviewValidationError(
        "malformed_review_supplement",
        "review diagrams must not contain duplicates",
      );
    }
    seen.add(identity);
  }
  return freezeCanonical(normalized);
}

function isUrgency(value) {
  return Object.hasOwn(URGENCY, value);
}

function normalizeCapReasons(reasons) {
  if (reasons === undefined) return [];
  if (!Array.isArray(reasons) || reasons.length > REVIEW_CAP_REASON_MAX_COUNT ||
      reasons.some((reason) => !isRecord(reason) ||
      !isSafeReviewText(reason.code, REVIEW_CAP_REASON_CODE_MAX_LENGTH) ||
      !isSafeReviewText(reason.detail, REVIEW_CAP_REASON_DETAIL_MAX_LENGTH) ||
      reason.count !== undefined &&
        (!Number.isSafeInteger(reason.count) || reason.count < 0) ||
      reason.omitted_urgencies !== undefined &&
        (!Array.isArray(reason.omitted_urgencies) ||
          reason.omitted_urgencies.some((urgency) => !isUrgency(urgency))) ||
      reason.overflow_urgencies !== undefined &&
        (!Array.isArray(reason.overflow_urgencies) ||
        reason.overflow_urgencies.some((urgency) => !isUrgency(urgency))))) {
    throw reviewValidationError("malformed_cap_reason", "cap reasons are malformed");
  }
  const normalized = reasons.map((reason) => ({
    code: reason.code,
    detail: reason.detail,
    ...(Number.isSafeInteger(reason.count) ? { count: reason.count } : {}),
    ...(reason.omitted_urgencies === undefined ? {} : {
      omitted_urgencies: [...new Set(reason.omitted_urgencies)]
        .sort((left, right) => URGENCY[left] - URGENCY[right]),
    }),
    ...(reason.overflow_urgencies === undefined ? {} : {
      overflow_urgencies: [...new Set(reason.overflow_urgencies)]
        .sort((left, right) => URGENCY[left] - URGENCY[right]),
    }),
  }));
  return [...new Map(normalized.map((reason) => [digest(reason), reason])).values()];
}

function normalizeReviewCoverage(value, { role }) {
  const hasCoverage = Object.hasOwn(value, "coverage");
  const hasTerminalDisposition = Object.hasOwn(value, "terminal_disposition");
  if (hasCoverage && hasTerminalDisposition) {
    throw reviewValidationError(
      "malformed_review_coverage",
      `${role} result declares both coverage and terminal_disposition`,
    );
  }
  const candidate = hasCoverage
    ? value.coverage
    : hasTerminalDisposition ? value.terminal_disposition : null;
  let status = candidate;
  let reason = null;
  if (isRecord(candidate)) {
    if (candidate.schema !== undefined &&
        candidate.schema !== "flow.review-coverage/v1") {
      throw reviewValidationError(
        "malformed_review_coverage",
        `${role} coverage schema is invalid`,
      );
    }
    status = candidate.status ?? candidate.disposition ??
      candidate.terminal_disposition;
    reason = candidate.reason ?? candidate.code ?? null;
  }
  if (status === null || status === undefined) status = "produced";
  if (!REVIEW_COVERAGE_STATUSES.includes(status) ||
      status !== "produced" &&
        !isSafeReviewText(reason, REVIEW_COVERAGE_REASON_MAX_LENGTH)) {
    throw reviewValidationError(
      "malformed_review_coverage",
      `${role} coverage must be produced, or non-produced with a bounded reason`,
    );
  }
  return {
    schema: "flow.review-coverage/v1",
    status,
    reason: status === "produced" ? null : reason,
  };
}

function isCanonicalReviewCoverage(coverage, enabledLenses) {
  if (!isRecord(coverage) || coverage.schema !== "flow.review-coverage/v1" ||
      typeof coverage.complete !== "boolean" || !Array.isArray(coverage.lenses) ||
      !isRecord(coverage.critic) ||
      !isCanonicalCoverageEntry(coverage.critic) ||
      !Array.isArray(enabledLenses) ||
      coverage.lenses.length !== enabledLenses.length) {
    return false;
  }
  const expectedLenses = [...enabledLenses].sort();
  const actualLenses = coverage.lenses.map((entry) => entry?.lens);
  if (JSON.stringify(actualLenses) !== JSON.stringify(expectedLenses) ||
      coverage.lenses.some((entry) => !isRecord(entry) ||
        !isCanonicalCoverageEntry(entry))) {
    return false;
  }
  const complete = [...coverage.lenses, coverage.critic]
    .every((entry) => entry.status === "produced");
  return coverage.complete === complete;
}

function isCanonicalCoverageEntry(entry) {
  return isRecord(entry) && REVIEW_COVERAGE_STATUSES.includes(entry.status) &&
    (entry.status === "produced"
      ? entry.reason === null
      : isSafeReviewText(entry.reason, REVIEW_COVERAGE_REASON_MAX_LENGTH));
}

function normalizeFindingLocation(location, inline) {
  const candidate = location ?? inline ?? null;
  if (candidate === null) return null;
  if (!isRecord(candidate) ||
      !isSafeReviewText(candidate.path, REVIEW_FINDING_PATH_MAX_LENGTH) ||
      !Number.isSafeInteger(candidate.start_line) || candidate.start_line < 1 ||
      candidate.end_line !== undefined &&
        (!Number.isSafeInteger(candidate.end_line) || candidate.end_line < candidate.start_line) ||
      candidate.start_column !== undefined &&
        (!Number.isSafeInteger(candidate.start_column) || candidate.start_column < 1) ||
      candidate.end_column !== undefined &&
        (!Number.isSafeInteger(candidate.end_column) || candidate.end_column < 1 ||
          (candidate.end_line ?? candidate.start_line) === candidate.start_line &&
            candidate.start_column !== undefined &&
            candidate.end_column < candidate.start_column)) {
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

function isSafeReviewText(value, maximumLength) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maximumLength || value !== value.trim() ||
      /[\r\n\u2028\u2029`<>]/u.test(value)) {
    return false;
  }
  // Delegate-controlled text is interpolated into Markdown list items. Reject
  // block constructs even when a caller has not supplied a newline yet.
  return !/^ {0,3}(?:#{1,6}(?:\s|$)|[-+*](?:\s|$)|>(?:\s|$)|~{3,}|\d+[.)](?:\s|$))/u.test(value);
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
