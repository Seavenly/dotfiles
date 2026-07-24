import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import {
  resolveGateRuntime,
  validateDeclaredOutputs,
  withGateTimeout,
  writeFilesAtomically,
} from "./gate-runtime.mjs";
import { serializeInlineArtifact } from "./inline-artifact.mjs";
import { loadSealedGate } from "./run-bundle-validator.mjs";
import { validateContract } from "./schema-validator.mjs";

const TIERS = ["critical", "important", "recommended", "nit"];
const POSTURE_LABELS = {
  do_not_merge: "do not merge",
  merge_after_fixes: "merge after fixes",
  merge_ready_with_followups: "merge ready with follow-ups",
};
const SUPPLEMENT_ARTIFACT_KINDS = {
  "lens:style": "review-findings",
  "lens:observability": "review-findings",
  orientation: "review-orientation",
  diagram: "review-diagram",
};

export async function executeReviewFinalizeGate({ adapter, sealedGate }) {
  const { gate, manifest, taskAuthority } = sealedGate;
  if (gate.kind !== "review-finalize") {
    throw new Error(
      `unsupported gate kind for review finalization: ${gate.kind}`,
    );
  }

  return withGateTimeout(gate.kind, gate.timeout_seconds, async (
    signal,
    commit,
  ) => {
    const runtime = await resolveGateRuntime(gate, manifest);
    const commentsEvidence = await loadEvidence({
      adapter,
      declaration: gate.review_finalize.comments_validation,
      expectedStage: "critic",
      expectedArtifactKind: "review-comments",
      validatorTaskId:
        taskAuthority.inputTaskIds[gate.review_finalize.comments_validation],
      runtime,
      manifest,
      taskAuthority,
      signal,
    });
    if (!commentsEvidence.validation.semantic.required) {
      throw new Error("review comments evidence must contain a critic measurement");
    }
    if (commentsEvidence.artifacts.length !== 1) {
      throw new Error("review comments evidence must contain exactly one artifact");
    }
    const commentsArtifact = commentsEvidence.artifacts[0];
    let comments;
    try {
      comments = JSON.parse(commentsArtifact.bytes);
    } catch (error) {
      throw new Error("review comments artifact is not valid JSON", {
        cause: error,
      });
    }
    const commentsContract = await validateContract(comments);
    if (!commentsContract.valid) {
      throw new Error("review comments artifact does not satisfy its contract");
    }
    if (
      comments.run_id !== gate.run_id ||
      comments.urgency !== gate.review_policy.urgency
    ) {
      throw new Error(
        "review comments identity or urgency does not match the sealed gate",
      );
    }

    const supplements = [];
    for (const supplement of gate.review_finalize.supplements) {
      const evidence = await loadEvidence({
        adapter,
        declaration: supplement.validation,
        expectedStage: supplement.kind,
        expectedArtifactKind: SUPPLEMENT_ARTIFACT_KINDS[supplement.kind],
        validatorTaskId: taskAuthority.inputTaskIds[supplement.validation],
        runtime,
        manifest,
        taskAuthority,
        signal,
      });
      if (evidence.artifacts.length !== 1) {
        throw new Error(
          `review ${supplement.kind} evidence must contain exactly one artifact`,
        );
      }
      validateSupplementMeasurement(supplement.kind, evidence.validation);
      const artifact = evidence.artifacts[0];
      validateSupplementContent(supplement.kind, artifact.bytes);
      supplements.push({
        kind: supplement.kind,
        passed: evidence.validation.semantic.passed,
        validation_path: supplement.validation,
        artifact_path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      });
    }

    const policyResult = applyPolicy(comments.findings, gate.review_policy);
    const failedLenses = supplements.filter(
      ({ kind, passed }) => kind.startsWith("lens:") && !passed,
    );
    const posture = failedLenses.length > 0 &&
        comments.posture === "merge_ready_with_followups"
      ? "merge_after_fixes"
      : comments.posture;
    const postureRationale = failedLenses.length === 0
      ? comments.posture_rationale
      : `${comments.posture_rationale} Blocking supplemental lens: ${failedLenses
          .map(({ kind }) => kind)
          .join(", ")}.`;
    const result = {
      schema: "agent-flow.review-result/v1",
      run_id: gate.run_id,
      stage: gate.stage,
      policy: structuredClone(gate.review_policy),
      source: {
        validation_path: gate.review_finalize.comments_validation,
        stage: commentsEvidence.validation.stage,
        task_id: commentsEvidence.validation.task_id,
        attempt: commentsEvidence.validation.attempt,
        artifact_path: commentsArtifact.path,
        sha256: commentsArtifact.sha256,
      },
      posture,
      posture_rationale: postureRationale,
      cluster: comments.cluster,
      findings: policyResult.findings,
      counts: policyResult.counts,
      supplements: supplements.map(
        ({ bytes: _bytes, ...supplement }) => supplement,
      ),
    };
    if (!(await validateContract(result)).valid) {
      throw new Error("review finalization does not satisfy its result contract");
    }

    const markdown = renderMarkdown(result, supplements);
    const html = renderHtml(result, supplements);
    const draft = renderDraft(result, supplements);
    const output = gate.review_finalize;
    await writeFilesAtomically(
      [
        {
          path: runtime.outputPathByDeclaration.get(output.result_output),
          bytes: `${JSON.stringify(result, null, 2)}\n`,
        },
        {
          path: runtime.outputPathByDeclaration.get(output.markdown_output),
          bytes: markdown,
        },
        {
          path: runtime.outputPathByDeclaration.get(output.html_output),
          bytes: html,
        },
        {
          path: runtime.outputPathByDeclaration.get(output.draft_output),
          bytes: `${JSON.stringify(draft, null, 2)}\n`,
        },
      ],
      { signal, beforePublish: commit },
    );
    await validateDeclaredOutputs(runtime);
    return { passed: true, result };
  });
}

async function loadEvidence({
  adapter,
  declaration,
  expectedStage,
  expectedArtifactKind,
  validatorTaskId,
  runtime,
  manifest,
  taskAuthority,
  signal,
}) {
  const evidencePath = runtime.inputPathByDeclaration.get(declaration);
  const bytes = await readFile(evidencePath, { signal });
  let validation;
  try {
    validation = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`validation evidence is not valid JSON: ${declaration}`, {
      cause: error,
    });
  }
  if (!(await validateContract(validation)).valid || !validation.valid) {
    throw new Error(
      `review input is not valid completed-attempt evidence: ${declaration}`,
    );
  }
  await validateEvidenceAuthority({
    adapter,
    declaration,
    expectedStage,
    expectedArtifactKind,
    manifest,
    signal,
    taskAuthority,
    validation,
    validatorTaskId,
  });
  if (
    validation.run_id !== manifest.identity.run_id ||
    validation.provenance.run_manifest_path !== taskAuthority.runManifestPath ||
    validation.provenance.run_manifest_sha256 !== taskAuthority.runManifestSha256
  ) {
    throw new Error(
      "review input evidence does not match the sealed run authority",
    );
  }
  const validatedRoot = await realpath(manifest.identity.validation_directory);
  if (await realpath(validation.validated_artifact_root) !== validatedRoot) {
    throw new Error("review input evidence names a different validation root");
  }
  const approvedRoots = await Promise.all(
    manifest.approved_artifact_roots.map((root) => realpath(root)),
  );
  const evidenceRoots = await Promise.all(
    validation.approved_artifact_roots.map((root) => realpath(root)),
  );
  if (!sameSet(approvedRoots, evidenceRoots)) {
    throw new Error(
      "review input evidence names different approved artifact roots",
    );
  }
  const artifacts = [];
  for (const artifact of validation.artifacts) {
    const path = await realpath(artifact.path);
    if (!pathIsWithin(validatedRoot, path)) {
      throw new Error("review input artifact resolves outside the validation root");
    }
    const artifactBytes = await readFile(path, { signal });
    const digest = sha256(artifactBytes);
    if (digest !== artifact.actual_sha256) {
      throw new Error("review input artifact digest changed after validation");
    }
    artifacts.push({
      path,
      sha256: digest,
      bytes: artifactBytes.toString("utf8"),
    });
  }
  return { validation, artifacts };
}

async function validateEvidenceAuthority({
  adapter,
  declaration,
  expectedStage,
  expectedArtifactKind,
  manifest,
  signal,
  taskAuthority,
  validation,
  validatorTaskId,
}) {
  const validatorBundle = await loadSealedGate({
    adapter,
    taskId: validatorTaskId,
  });
  if (!validatorBundle.valid) {
    throw new Error(
      "review input validator does not have valid sealed authority: " +
        JSON.stringify(validatorBundle.errors),
    );
  }
  const validatorGate = validatorBundle.gate;
  const validatorAuthority = validatorBundle.taskAuthority;
  if (
    validatorGate.kind !== "handoff-validation" ||
    validatorGate.handoff_validation.producer_stage !== expectedStage ||
    validatorGate.outputs.length !== 1 ||
    validatorGate.outputs[0] !== declaration ||
    validatorAuthority.runId !== taskAuthority.runId ||
    validatorAuthority.runManifestPath !== taskAuthority.runManifestPath ||
    validatorAuthority.runManifestSha256 !== taskAuthority.runManifestSha256
  ) {
    throw new Error("review input does not match its launcher-pinned validator task");
  }
  const validatorCompleted = await adapter.getTerminalCompletedAttempt({
    taskId: validatorTaskId,
    signal,
  });
  assertTerminalCompleted(validatorCompleted, validatorTaskId);
  const producerTaskId = validatorAuthority.producerTaskId;
  const producer = await adapter.getTerminalCompletedAttempt({
    taskId: producerTaskId,
    signal,
  });
  assertTerminalCompleted(producer, producerTaskId);
  const handoff = producer.metadata?.handoff ?? null;
  if (!(await validateContract(handoff)).valid) {
    throw new Error("review input producer completed without a valid handoff");
  }
  if (
    validation.run_id !== manifest.identity.run_id ||
    validation.stage !== expectedStage ||
    validation.task_id !== producerTaskId ||
    validation.attempt !== producer.attempt ||
    validation.provenance.hermes_attempt_id !== producer.attemptId ||
    validation.source_metadata_sha256 !==
      sha256(JSON.stringify(producer.metadata ?? null)) ||
    validation.semantic.passed !== handoff.passed ||
    handoff.run_id !== manifest.identity.run_id ||
    handoff.flow !== manifest.identity.flow ||
    handoff.stage !== expectedStage ||
    (handoff.attempt !== undefined && handoff.attempt !== producer.attempt) ||
    (validatorGate.handoff_validation.require_passed && !handoff.passed)
  ) {
    throw new Error("review input evidence does not match the producer completed attempt");
  }
  if (
    handoff.artifacts.length !== 1 ||
    handoff.artifacts[0].kind !== expectedArtifactKind
  ) {
    throw new Error(
      `review ${expectedStage} handoff must contain exactly one ${expectedArtifactKind} artifact`,
    );
  }
  const declaredArtifacts = handoff.artifacts.map((artifact) =>
    Object.hasOwn(artifact, "inline")
      ? `inline\0${sha256(serializeInlineArtifact(artifact.inline))}`
      : `file\0${artifact.path}\0${artifact.sha256}`
  );
  const evidencedArtifacts = validation.artifacts.map((artifact) =>
    artifact.source_path === artifact.path
      ? `inline\0${artifact.expected_sha256}`
      : `file\0${artifact.source_path}\0${artifact.expected_sha256}`
  );
  if (!sameSequence(declaredArtifacts, evidencedArtifacts)) {
    throw new Error("review input evidence does not match producer artifacts");
  }
}

function validateSupplementContent(kind, bytes) {
  if (kind === "orientation") {
    if (!bytes.startsWith("## Orientation\n") || bytes.trim().length === 0) {
      throw new Error(
        "review orientation artifact must be a Markdown orientation section",
      );
    }
    return;
  }
  if (kind === "diagram") {
    if (!/^flowchart (?:TB|TD|BT|RL|LR)\n/.test(bytes)) {
      throw new Error("review diagram artifact must be a Mermaid flowchart");
    }
    return;
  }
  let findings;
  try {
    findings = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`review ${kind} artifact is not valid JSON`, { cause: error });
  }
  const expectedLens = kind.slice("lens:".length);
  if (
    !findings ||
    typeof findings !== "object" ||
    Array.isArray(findings) ||
    Object.keys(findings).sort().join(",") !== "findings,lens,summary" ||
    findings.lens !== expectedLens ||
    typeof findings.summary !== "string" ||
    findings.summary.length === 0 ||
    !Array.isArray(findings.findings) ||
    !findings.findings.every(
      (finding) => reviewFindingIsValid(finding, expectedLens),
    )
  ) {
    throw new Error(`review ${kind} artifact does not satisfy its findings shape`);
  }
}

function validateSupplementMeasurement(kind, validation) {
  if (kind.startsWith("lens:")) {
    if (
      !validation.semantic.required ||
      typeof validation.semantic.passed !== "boolean"
    ) {
      throw new Error(`review ${kind} evidence must contain a lens measurement`);
    }
    return;
  }
  if (validation.semantic.passed !== true) {
    throw new Error(`review ${kind} evidence must report successful production`);
  }
}

function reviewFindingIsValid(finding, expectedLens) {
  if (
    !finding ||
    typeof finding !== "object" ||
    Array.isArray(finding) ||
    Object.keys(finding).sort().join(",") !== "body,lens,line,path,side,tier"
  ) return false;
  return (
    typeof finding.path === "string" &&
    finding.path.length > 0 &&
    !finding.path.startsWith("/") &&
    !finding.path.split("/").includes("..") &&
    Number.isInteger(finding.line) &&
    finding.line >= 1 &&
    ["LEFT", "RIGHT"].includes(finding.side) &&
    TIERS.includes(finding.tier) &&
    finding.lens === expectedLens &&
    typeof finding.body === "string" &&
    finding.body.length > 0
  );
}

function assertTerminalCompleted(attempt, taskId) {
  if (
    attempt?.taskId !== taskId ||
    attempt.state !== "completed" ||
    !Number.isInteger(attempt.attempt) ||
    attempt.attempt < 1 ||
    typeof attempt.attemptId !== "string" ||
    attempt.attemptId.length === 0
  ) {
    throw new Error("Hermes adapter did not return a terminal completed attempt");
  }
}

function applyPolicy(findings, policy) {
  const inputIds = findings.map(findingId);
  if (new Set(inputIds).size !== inputIds.length) {
    throw new Error("review comments contain duplicate findings");
  }
  const minimumIndex = TIERS.indexOf(policy.minimum_tier);
  const byTier = Object.fromEntries(TIERS.map((tier) => [tier, []]));
  const droppedByUrgency = zeroCounts();
  const droppedByTierCap = zeroCounts();
  const droppedByTotalCap = zeroCounts();
  for (const finding of findings) byTier[finding.tier].push(finding);

  const afterTierCaps = [];
  for (const [index, tier] of TIERS.entries()) {
    if (index > minimumIndex) {
      droppedByUrgency[tier] = byTier[tier].length;
      continue;
    }
    const cap = policy.per_tier_caps[tier];
    afterTierCaps.push(...byTier[tier].slice(0, cap));
    droppedByTierCap[tier] = Math.max(0, byTier[tier].length - cap);
  }
  const kept = afterTierCaps.slice(0, policy.max_comments);
  for (const finding of afterTierCaps.slice(policy.max_comments)) {
    droppedByTotalCap[finding.tier] += 1;
  }
  const withIds = kept.map((finding) => ({
    id: findingId(finding),
    ...finding,
  }));
  const byTierCounts = zeroCounts();
  for (const finding of withIds) byTierCounts[finding.tier] += 1;
  return {
    findings: withIds,
    counts: {
      input: findings.length,
      included: withIds.length,
      by_tier: byTierCounts,
      dropped_by_urgency: droppedByUrgency,
      dropped_by_tier_cap: droppedByTierCap,
      dropped_by_total_cap: droppedByTotalCap,
    },
  };
}

function findingId(finding) {
  const identity = [
    finding.path,
    finding.line,
    finding.side,
    finding.tier,
    finding.lens,
    finding.body,
  ];
  return `finding-${sha256(JSON.stringify(identity)).slice(0, 16)}`;
}

function renderMarkdown(result, supplements) {
  const lines = [
    "# Automated review",
    "",
    `**Verdict: ${POSTURE_LABELS[result.posture]}** - urgency: ${result.policy.urgency}`,
    "",
    result.posture_rationale,
    "",
  ];
  if (result.cluster) lines.push("## Through-line", "", result.cluster, "");
  for (const supplement of supplements.filter(
    ({ kind }) => kind === "orientation",
  )) {
    lines.push(supplement.bytes.trim(), "");
  }
  for (const tier of TIERS) {
    const findings = result.findings.filter((finding) => finding.tier === tier);
    if (findings.length === 0) continue;
    lines.push(`## ${tier} (${findings.length})`, "");
    for (const finding of findings) {
      lines.push(
        `### ${finding.id} - \`${finding.path}:${finding.line}\` [${finding.lens}]`,
        "",
        finding.body,
        "",
      );
    }
  }
  const diagrams = result.supplements.filter(({ kind }) => kind === "diagram");
  if (diagrams.length > 0) {
    lines.push("## Diagram artifacts", "");
    for (const diagram of diagrams) lines.push(`- \`${diagram.artifact_path}\``);
    lines.push("");
  }
  const lensSupplements = supplementalLensArtifacts(result);
  if (lensSupplements.length > 0) {
    lines.push("## Supplemental lens evidence", "");
    for (const lens of lensSupplements) {
      lines.push(
        `- ${lens.kind} (${lens.passed ? "passed" : "blocking"}): ` +
          `\`${lens.artifact_path}\` (` +
          `sha256:${lens.sha256})`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Policy report",
    "",
    `- Input findings: ${result.counts.input}`,
    `- Included findings: ${result.counts.included}`,
    `- Maximum comments: ${result.policy.max_comments}`,
  );
  for (const note of policyNotes(result)) lines.push(`- ${note}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderHtml(result, supplements) {
  const cluster = result.cluster
    ? `<section><h2>Through-line</h2><p>${escapeHtml(result.cluster)}</p></section>`
    : "";
  const orientation = supplements
    .filter(({ kind }) => kind === "orientation")
    .map(
      ({ bytes }) =>
        `<section><h2>Orientation</h2><pre>${escapeHtml(orientationBody(bytes))}</pre></section>`,
    )
    .join("");
  const diagrams = result.supplements
    .filter(({ kind }) => kind === "diagram")
    .map(
      ({ artifact_path: path }) =>
        `<li><code>${escapeHtml(path)}</code></li>`,
    )
    .join("");
  const diagramSection = diagrams
    ? `<section><h2>Diagram artifacts</h2><ul>${diagrams}</ul></section>`
    : "";
  const lensSupplements = supplementalLensArtifacts(result)
    .map(
      ({ kind, passed, artifact_path: path, sha256: digest }) =>
        `<li>${escapeHtml(kind)} (${passed ? "passed" : "blocking"}): ` +
        `<code>${escapeHtml(path)}</code> ` +
        `(sha256:${digest})</li>`,
    )
    .join("");
  const lensSupplementSection = lensSupplements
    ? `<section><h2>Supplemental lens evidence</h2><ul>${lensSupplements}</ul></section>`
    : "";
  const findings = result.findings
    .map(
      (finding) =>
        `<article id="${finding.id}"><h2>${escapeHtml(finding.tier)} - ${finding.id}</h2>` +
        `<p><code>${escapeHtml(`${finding.path}:${finding.line}`)}</code> [${escapeHtml(finding.lens)}]</p>` +
        `<p>${escapeHtml(finding.body)}</p></article>`,
    )
    .join("");
  const policy = policyNotes(result)
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");
  return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Automated review</title></head><body><main><h1>Automated review</h1>" +
    `<p><strong>Verdict: ${escapeHtml(POSTURE_LABELS[result.posture])}</strong> - urgency: ${escapeHtml(result.policy.urgency)}</p>` +
    `<p>${escapeHtml(result.posture_rationale)}</p>${cluster}${orientation}${diagramSection}${lensSupplementSection}${findings}` +
    `<section><h2>Policy report</h2><p>Included ${result.counts.included} of ${result.counts.input} findings.</p><ul>${policy}</ul></section>` +
    "</main></body></html>\n";
}

function renderDraft(result, supplements) {
  const orientation = supplements
    .filter(({ kind }) => kind === "orientation")
    .map(({ bytes }) => bytes.trim())
    .join("\n\n");
  const notes = policyNotes(result);
  const diagrams = result.supplements
    .filter(({ kind }) => kind === "diagram")
    .map(({ artifact_path: path }) => `- \`${path}\``)
    .join("\n");
  const lensSupplements = supplementalLensArtifacts(result)
    .map(
      ({ kind, passed, artifact_path: path, sha256: digest }) =>
        `- ${kind} (${passed ? "passed" : "blocking"}): ` +
        `\`${path}\` (sha256:${digest})`,
    )
    .join("\n");
  const body = [
    `**Verdict: ${POSTURE_LABELS[result.posture]}** - urgency: ${result.policy.urgency}`,
    result.posture_rationale,
    result.cluster ? `## Through-line\n${result.cluster}` : null,
    orientation || null,
    diagrams ? `## Diagram artifacts\n${diagrams}` : null,
    lensSupplements
      ? `## Supplemental lens evidence\n${lensSupplements}`
      : null,
    notes.length > 0 ? `## Policy report\n${notes.map((note) => `- ${note}`).join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
  return {
    body,
    comments: result.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: `**[${finding.tier}] [${finding.lens}] ${finding.id}**\n\n${finding.body}`,
    })),
  };
}

function supplementalLensArtifacts(result) {
  return result.supplements.filter(({ kind }) => kind.startsWith("lens:"));
}

function policyNotes(result) {
  const fields = [
    ["dropped_by_urgency", "urgency floor"],
    ["dropped_by_tier_cap", "per-tier cap"],
    ["dropped_by_total_cap", "total cap"],
  ];
  const notes = [];
  for (const [field, reason] of fields) {
    for (const tier of TIERS) {
      const count = result.counts[field][tier];
      if (count > 0) notes.push(`Dropped ${count} ${tier} by ${reason}`);
    }
  }
  return notes;
}

function orientationBody(bytes) {
  return bytes.trim().replace(/^## Orientation\s*\n+/, "");
}

function zeroCounts() {
  return Object.fromEntries(TIERS.map((tier) => [tier, 0]));
}

function sameSet(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    left.length === leftSet.size &&
    right.length === rightSet.size &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function sameSequence(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsWithin(root, path) {
  const candidate = relative(root, path);
  return candidate === "" || (
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
