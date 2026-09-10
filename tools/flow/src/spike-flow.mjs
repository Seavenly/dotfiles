import {
  canonicalize,
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";
import {
  bindDelegateEvidenceReceipt,
  createEvidenceSafetyRequest,
  validateEvidenceSafety,
} from "./evidence-safety.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";

export const SPIKE_RESEARCH_OUTPUT_VALIDATOR =
  "flow.validator/spike-research-evidence/v1";
export const SPIKE_REPORT_OUTPUT_VALIDATOR =
  "flow.validator/spike-report/v1";

export const SPIKE_DEFINITION_CONTRACT = "flow.definition/spike/v1";
export const SPIKE_QUESTION_SCHEMA = "flow.spike-question/v1";
export const SPIKE_SOURCE_SCHEMA = "flow.spike-source/v1";
export const SPIKE_CITATION_SCHEMA = "flow.spike-citation/v1";
export const SPIKE_RESEARCH_EVIDENCE_SCHEMA =
  "flow.spike-research-evidence/v1";
export const SPIKE_REPORT_SCHEMA = "flow.spike-report/v1";
export const SPIKE_AUTHORITY_EVIDENCE_SCHEMA =
  "flow.authority-materialized-evidence/v1";
export const SPIKE_DELEGATE_INPUT_SCHEMA = "flow.delegate-input-envelope/v1";

const SPIKE_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const SPIKE_SELECTION_SCHEMA = "flow.spike-delegation-bindings/v1";
const SPIKE_CITATION_KEYS = Object.freeze([
  "digest",
  "immutable",
  "kind",
  "schema",
  "source_id",
]);
const SPIKE_SELECTION_MODES = new Set(["quick"]);
const SPIKE_PROMISED_OUTCOMES = Object.freeze([
  "one confirmed question becomes one evidence-cited canonical report",
  "research and synthesis remain distinct independently routed delegates",
]);
const SPIKE_NEGATIVE_OUTCOME =
  "no prototype, production implementation or candidate, review candidate or approval, publication, tracker completion, or mutation authority";
const SPIKE_TRUST_POSTURE = Object.freeze({
  schema: "flow.spike-trust-posture/v1",
  assurance: "lower",
  evidence: "authority_materialized_delegate_evidence_only",
  delegation: "one_researcher_then_one_independent_synthesizer",
  publication: "validated_report_evidence_only",
});

/**
 * Return the trusted quick-only definition.  It emits a finite graph and
 * leaves all execution, lifecycle, and authority decisions to FlowRuntime.
 */
export function createSpikeDefinition() {
  return {
    schema: SPIKE_DEFINITION_SCHEMA,
    id: "spike/v1",
    contract: SPIKE_DEFINITION_CONTRACT,
    promised_outcomes: [...SPIKE_PROMISED_OUTCOMES],
    negative_outcomes: [SPIKE_NEGATIVE_OUTCOME],
    trust_posture: { ...SPIKE_TRUST_POSTURE },
    compile: compileSpikeSelection,
  };
}

/** Return pure delegate validator registrations for FlowRuntime. */
export function createSpikeOutputValidators() {
  return {
    [SPIKE_RESEARCH_OUTPUT_VALIDATOR]: {
      validate: (output, context) => validateResearchEvidence(output, context),
      evidenceSafety: (output, context) =>
        researchEvidenceSafety(output, context),
    },
    [SPIKE_REPORT_OUTPUT_VALIDATOR]: {
      validate: (output, context) => validateSpikeReport(output, context),
      evidenceSafety: (output, context) => spikeReportSafety(output, context),
    },
  };
}

/** Build one canonical, digest-bound researcher evidence document. */
export function createResearchEvidence({
  answer,
  citations,
  findings = [],
  question_id: questionId,
  residual_gaps: residualGaps = [],
} = {}) {
  const identity = freezeCanonical({
    schema: SPIKE_RESEARCH_EVIDENCE_SCHEMA,
    question_id: questionId,
    answer,
    citations,
    findings,
    residual_gaps: residualGaps,
    assurance: "lower",
  });
  const evidence = freezeCanonical({
    ...identity,
    evidence_digest: digest(identity),
  });
  assertResearchEvidenceObject(evidence, null);
  assertSafety(evidence, "research");
  return evidence;
}

/** Build a report which cites both an immutable source and researcher proof. */
export function createSpikeReport({
  answer,
  question_id: questionId,
  residual_gaps: residualGaps,
  source_citations: sourceCitations,
  research_evidence_digest: researchEvidenceDigest,
} = {}) {
  const citations = [
    ...(sourceCitations ?? []),
    {
      schema: SPIKE_CITATION_SCHEMA,
      kind: "research_evidence",
      source_id: "spike-research",
      digest: researchEvidenceDigest,
      immutable: true,
    },
  ];
  return freezeCanonical({
    schema: SPIKE_REPORT_SCHEMA,
    question_id: questionId,
    answer,
    citations,
    assurance: "lower",
    residual_gaps: residualGaps,
    research_evidence_digest: researchEvidenceDigest,
  });
}

/** Validate canonical researcher output and its confirmed-question binding. */
export function validateResearchEvidence(output, context = {}) {
  try {
    const value = parseCanonicalOutput(output);
    const question = contextQuestion(context);
    assertQuestionContext(question);
    assertResearchEvidenceObject(value, question);
    assertSafety(value, "research");
    return true;
  } catch {
    return false;
  }
}

/** Validate a report against RunAuthority's exact materialized evidence. */
export function validateSpikeReport(output, context = {}) {
  try {
    const value = parseCanonicalOutput(output);
    const question = contextQuestion(context);
    const materialized = context.authority_materialized_evidence;
    assertReportObject(value, question, materialized);
    assertSafety(value, "delegate_evidence");
    return true;
  } catch {
    return false;
  }
}

class SpikeEvidenceValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SpikeEvidenceValidationError";
    this.reason = reason;
  }
}

function compileSpikeSelection({ inputs, explicit_facts: explicitFacts }) {
  const selection = validateSpikeInputs(inputs, explicitFacts);
  const common = {
    success_criteria: ["delegate_observation:accepted"],
    data_references: [selection.question.id],
    evidence_references: [],
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "discover_then_dispatch_exact",
    executor: {
      kind: "delegate",
      contract: "flow.delegated-agent-port/v1",
    },
  };
  const delegate = ({
    id,
    binding,
    dependencies,
    phase,
    prompt,
    validator,
    evidenceCardIds,
  }) => ({
    ...common,
    id,
    dependencies,
    inputs: {
      question: selection.question,
      mode: selection.mode,
      phase,
      prompt,
      wait_timeout_ms: 300_000,
      description: binding.description,
      ...(evidenceCardIds === undefined ? {} : {
        authority_materialization: "exact_digest_bound",
      }),
      ...(evidenceCardIds === undefined ? {} : {
        delegate_evidence_card_ids: evidenceCardIds,
      }),
    },
    outputs: [phase === "research"
      ? SPIKE_RESEARCH_EVIDENCE_SCHEMA
      : SPIKE_REPORT_SCHEMA],
    validators: [validator],
    route: binding.route,
  });
  const cards = [
    delegate({
      id: "spike-research",
      binding: selection.delegation.researcher,
      dependencies: [],
      phase: "research",
      prompt: researchDelegatePrompt(selection.question),
      validator: SPIKE_RESEARCH_OUTPUT_VALIDATOR,
    }),
    delegate({
      id: "spike-synthesis",
      binding: selection.delegation.synthesizer,
      dependencies: ["spike-research"],
      phase: "synthesis",
      prompt: synthesisDelegatePrompt(selection.question),
      validator: SPIKE_REPORT_OUTPUT_VALIDATOR,
      evidenceCardIds: ["spike-research"],
    }),
  ];
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: { schema: "flow.run-plan/v1", cards },
    requested_authority: {
      commands: ["cancel", "delegate_execute", "terminal_disposition"],
      capabilities: [],
      mutations: [],
    },
    explicit_facts: explicitFacts,
    revision_templates: [],
  };
}

function researchDelegatePrompt(question) {
  return [
    "Research the confirmed question using only the immutable source references below.",
    "Return exactly one canonical JSON object with schema flow.spike-research-evidence/v1 and fields answer, assurance, citations, evidence_digest, findings, question_id, residual_gaps.",
    "Set assurance to lower; cite accepted immutable sources; preserve semantic contradictions as findings or residual_gaps.",
    "Do not claim unsupported authority (network, filesystem, mutation).",
    `Confirmed question and sources (canonical JSON): ${JSON.stringify(canonicalize(question))}`,
  ].join("\n");
}

function synthesisDelegatePrompt(question) {
  return [
    "Synthesize only the authority-materialized researcher evidence below.",
    "Return exactly one canonical JSON object with schema flow.spike-report/v1 and fields answer, assurance, citations, question_id, research_evidence_digest, residual_gaps.",
    "Set assurance to lower and include nonempty residual_gaps.",
    "Cite accepted immutable question sources and exactly the materialized researcher evidence digest; research_evidence_digest must exactly equal the accepted researcher evidence digest.",
    "Use no ambient transcript or data and claim no unsupported authority.",
    `Confirmed question and sources (canonical JSON): ${JSON.stringify(canonicalize(question))}`,
  ].join("\n");
}

function validateSpikeInputs(inputs, explicitFacts) {
  if (!isPlainRecord(inputs) ||
      Object.keys(inputs).sort().join(",") !== "delegation,mode,question") {
    invalidSpike("invalid_spike_request", "spike/v1 requires one bounded quick selection");
  }
  if (!SPIKE_SELECTION_MODES.has(inputs.mode)) {
    invalidSpike("invalid_mode", "spike/v1 mode must be quick");
  }
  const question = validateQuestion(inputs.question);
  if (!isPlainRecord(explicitFacts) ||
      !Array.isArray(explicitFacts.validator_contracts) ||
      !explicitFacts.validator_contracts.includes(SPIKE_RESEARCH_OUTPUT_VALIDATOR) ||
      !explicitFacts.validator_contracts.includes(SPIKE_REPORT_OUTPUT_VALIDATOR)) {
    invalidSpike(
      "missing_output_validators",
      "spike/v1 requires independently registered researcher and report validators",
    );
  }
  if (!isPlainRecord(inputs.delegation) ||
      inputs.delegation.schema !== SPIKE_SELECTION_SCHEMA ||
      Object.keys(inputs.delegation).sort().join(",") !==
        "researcher,schema,synthesizer") {
    invalidSpike(
      "missing_delegate_bindings",
      "spike/v1 requires independently declared researcher and synthesizer routes",
    );
  }
  const researcher = validateDelegateBinding(
    inputs.delegation.researcher,
    "researcher",
    explicitFacts,
    SPIKE_RESEARCH_OUTPUT_VALIDATOR,
  );
  const synthesizer = validateDelegateBinding(
    inputs.delegation.synthesizer,
    "synthesizer",
    explicitFacts,
    SPIKE_REPORT_OUTPUT_VALIDATOR,
  );
  if (researcher.route.agent_id === synthesizer.route.agent_id ||
      researcher.description.description_digest ===
        synthesizer.description.description_digest ||
      researcher.description.comparison_keys.launch ===
        synthesizer.description.comparison_keys.launch) {
    invalidSpike(
      "non_independent_synthesizer_route",
      "spike/v1 synthesizer must use an independently declared route",
    );
  }
  try {
    assertSafety(questionSafetyProjection(question), "research");
  } catch {
    invalidSpike(
      "unsafe_prompt_material",
      "spike/v1 question and sources failed evidence safety validation",
    );
  }
  return freezeCanonical({
    mode: inputs.mode,
    question,
    delegation: {
      schema: inputs.delegation.schema,
      researcher,
      synthesizer,
    },
  });
}

function validateQuestion(question) {
  const parsed = parseQuestionStructure(question);
  if (!parsed.ok) invalidSpike(parsed.reason, parsed.message);
  return parsed.value;
}

function parseQuestionStructure(question) {
  if (!isPlainRecord(question) ||
      Object.keys(question).sort().join(",") !== "id,schema,sources,text" ||
      question.schema !== SPIKE_QUESTION_SCHEMA ||
      typeof question.id !== "string" || question.id.length === 0 ||
      typeof question.text !== "string" || question.text.trim().length === 0 ||
      !Array.isArray(question.sources) || question.sources.length === 0) {
    return {
      ok: false,
      reason: "invalid_question",
      message: "spike/v1 requires one confirmed question and immutable source set",
    };
  }
  const sources = [];
  for (const source of question.sources) {
    const parsed = parseSourceStructure(source);
    if (!parsed.ok) return parsed;
    sources.push(parsed.value);
  }
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    return {
      ok: false,
      reason: "duplicate_source",
      message: "spike/v1 source identities must be unique",
    };
  }
  return {
    ok: true,
    value: freezeCanonical({
      schema: SPIKE_QUESTION_SCHEMA,
      id: question.id,
      text: question.text,
      sources,
    }),
  };
}

function parseSourceStructure(source) {
  if (!isPlainRecord(source) ||
      Object.keys(source).sort().join(",") !== "digest,id,schema,uri" ||
      source.schema !== SPIKE_SOURCE_SCHEMA ||
      typeof source.id !== "string" || source.id.length === 0 ||
      !isDigest(source.digest) ||
      typeof source.uri !== "string" ||
      !isHttpsUriWithoutUserInfo(source.uri)) {
    return {
      ok: false,
      reason: "invalid_source",
      message: "spike/v1 sources must be immutable HTTPS references with digests",
    };
  }
  return {
    ok: true,
    value: freezeCanonical({
      schema: SPIKE_SOURCE_SCHEMA,
      id: source.id,
      uri: source.uri,
      digest: source.digest,
    }),
  };
}

function validateDelegateBinding(binding, role, explicitFacts, validator) {
  const description = binding?.description;
  const route = binding?.route;
  if (!isPlainRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "description,route,validators" ||
      !isPlainRecord(description) ||
      description.schema !== "drovr.delegated-agent-description/v1" ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.comparison_keys?.effective_authority) ||
      !isDigest(description.watermark?.content_sha256) ||
      !isPlainRecord(route) ||
      Object.keys(route).sort().join(",") !==
        "agent_id,configuration_watermark,description_digest,launch_comparison_key" ||
      typeof route.agent_id !== "string" || !route.agent_id ||
      route.description_digest !== description.description_digest ||
      route.launch_comparison_key !== description.comparison_keys.launch ||
      route.configuration_watermark !== description.watermark.content_sha256 ||
      !Array.isArray(binding.validators) || binding.validators.length !== 1 ||
      binding.validators[0] !== validator ||
      !explicitFacts.validator_contracts.includes(validator)) {
    invalidSpike(
      "invalid_delegate_binding",
      `spike/v1 ${role} binding is incomplete or not exact`,
    );
  }
  if (!hasReadOnlyEffectiveAuthority(description)) {
    invalidSpike(
      "invalid_delegate_authority",
      `spike/v1 ${role} route must bind the exact read-only authority envelope`,
    );
  }
  const { description_digest: _ignored, legal_actions: _actions, ...identity } =
    description;
  if (digest(identity) !== description.description_digest) {
    invalidSpike(
      "invalid_delegate_binding",
      `spike/v1 ${role} description is not digest-bound`,
    );
  }
  return freezeCanonical({
    description,
    route,
    validators: binding.validators,
  });
}

function hasReadOnlyEffectiveAuthority(description) {
  try {
    const dimensions = description.effective_authority?.dimensions;
    return description.schemas?.effective_authority ===
        "drovr.effective-authority/v1" &&
      description.launch?.capability === "read-only" &&
      description.effective_authority?.schema ===
        "drovr.effective-authority/v1" &&
      description.effective_authority?.capability === "read-only" &&
      isPlainRecord(dimensions) &&
      Object.keys(dimensions).sort().join(",") ===
        "approvals,filesystem,network" &&
      dimensions.approvals === "never" &&
      dimensions.filesystem === "read_only" &&
      dimensions.network === "disabled";
  } catch {
    return false;
  }
}

function assertResearchEvidenceObject(value, question) {
  const fields = [
    "answer",
    "assurance",
    "citations",
    "evidence_digest",
    "findings",
    "question_id",
    "residual_gaps",
    "schema",
  ];
  if (!isPlainRecord(value) ||
      Object.keys(value).sort().join(",") !== fields.slice().sort().join(",") ||
      value.schema !== SPIKE_RESEARCH_EVIDENCE_SCHEMA ||
      typeof value.question_id !== "string" || value.question_id.length === 0 ||
      question && value.question_id !== question.id ||
      typeof value.answer !== "string" || value.answer.trim().length === 0 ||
      value.assurance !== "lower" ||
      !Array.isArray(value.findings) ||
      value.findings.some((finding) =>
        typeof finding !== "string" || finding.trim().length === 0) ||
      !Array.isArray(value.residual_gaps) ||
      value.residual_gaps.some((gap) =>
        typeof gap !== "string" || gap.trim().length === 0) ||
      !Array.isArray(value.citations) || value.citations.length === 0 ||
      value.citations.some((citation) => !validSourceCitation(citation))) {
    throw new SpikeEvidenceValidationError(
      "invalid_research_evidence",
      "research output is not a canonical, cited evidence document",
    );
  }
  const { evidence_digest: _ignored, ...identity } = value;
  if (!isDigest(value.evidence_digest) || digest(identity) !== value.evidence_digest) {
    throw new SpikeEvidenceValidationError(
      "invalid_research_evidence_digest",
      "research evidence digest does not bind its canonical bytes",
    );
  }
  if (question) assertExactSourceCitations(value.citations, question);
}

function assertReportObject(value, question, materialized) {
  assertQuestionContext(question);
  const fields = [
    "answer",
    "assurance",
    "citations",
    "question_id",
    "research_evidence_digest",
    "residual_gaps",
    "schema",
  ];
  if (!isPlainRecord(value) ||
      Object.keys(value).sort().join(",") !== fields.slice().sort().join(",") ||
      value.schema !== SPIKE_REPORT_SCHEMA ||
      typeof value.question_id !== "string" || value.question_id !== question.id ||
      typeof value.answer !== "string" || value.answer.trim().length === 0 ||
      value.assurance !== "lower" || !isDigest(value.research_evidence_digest) ||
      !Array.isArray(value.residual_gaps) || value.residual_gaps.length === 0 ||
      value.residual_gaps.some((gap) =>
        typeof gap !== "string" || gap.trim().length === 0) ||
      !Array.isArray(value.citations) || value.citations.length < 2 ||
      value.citations.some((citation) => !validCitation(citation))) {
    throw new SpikeEvidenceValidationError(
      "invalid_spike_report",
      "synthesis output is not a canonical report with residual gaps",
    );
  }
  const accepted = assertMaterializedResearchEvidence(materialized, question);
  if (value.research_evidence_digest !== accepted.evidence_digest) {
    throw new SpikeEvidenceValidationError(
      "research_evidence_digest_mismatch",
      "synthesis report is not bound to authority-materialized evidence",
    );
  }
  const researchCitations = value.citations.filter(({ kind }) =>
    kind === "research_evidence");
  if (researchCitations.length !== 1 ||
      researchCitations[0].digest !== accepted.evidence_digest ||
      researchCitations[0].immutable !== true ||
      researchCitations[0].source_id !== "spike-research") {
    throw new SpikeEvidenceValidationError(
      "research_evidence_citation_missing",
      "synthesis report must cite the exact researcher evidence digest",
    );
  }
  const sourceCitations = value.citations.filter(({ kind }) => kind === "source");
  assertExactSourceCitations(sourceCitations, question);
}

function assertExactSourceCitations(citations, question) {
  const sources = new Map(question.sources.map((source) => [source.id, source]));
  const seen = new Set();
  if (citations.length !== sources.size || citations.some((citation) => {
    const source = sources.get(citation.source_id);
    if (!source || seen.has(citation.source_id) ||
        source.digest !== citation.digest || citation.kind !== "source" ||
        citation.immutable !== true) {
      return true;
    }
    seen.add(citation.source_id);
    return false;
  }) || seen.size !== sources.size) {
    throw new SpikeEvidenceValidationError(
      "spike_source_citation_set_incomplete",
      "evidence must cite every accepted immutable source exactly once",
    );
  }
}

function assertMaterializedResearchEvidence(materialized, question) {
  if (!isPlainRecord(materialized) ||
      materialized.schema !== SPIKE_AUTHORITY_EVIDENCE_SCHEMA ||
      !isDigest(materialized.evidence_digest) ||
      !Array.isArray(materialized.accepted_delegates) ||
      materialized.accepted_delegates.length !== 1) {
    throw new SpikeEvidenceValidationError(
      "invalid_authority_materialized_evidence",
      "synthesis context is not one authority-materialized researcher envelope",
    );
  }
  const { evidence_digest: _ignored, ...identity } = materialized;
  if (digest(identity) !== materialized.evidence_digest) {
    throw new SpikeEvidenceValidationError(
      "invalid_authority_materialized_evidence_digest",
      "authority-materialized evidence digest does not bind canonical bytes",
    );
  }
  const accepted = materialized.accepted_delegates[0];
  const provider = accepted?.evidence;
  if (!isPlainRecord(accepted) || accepted.card_id !== "spike-research" ||
      !isPlainRecord(provider) || provider.schema !== "flow.delegate-evidence/v1" ||
      typeof provider.validated_output !== "string" ||
      !validateResearchEvidence(provider.validated_output, {
        delegate_input: { question },
      })) {
    throw new SpikeEvidenceValidationError(
      "invalid_authority_materialized_research_evidence",
      "authority materialized evidence does not contain accepted researcher output",
    );
  }
  const research = parseCanonicalOutput(provider.validated_output);
  const rebound = isPlainRecord(provider.evidence_safety_receipt) &&
    bindDelegateEvidenceReceipt(provider.evidence_safety_receipt, {
      subject_digest: digest(research),
    });
  if (!rebound?.accepted || !isPlainRecord(provider.evidence_safety_binding) ||
      digest(rebound.binding) !== digest(provider.evidence_safety_binding) ||
      !sameDigest(provider.evidence_safety_receipt.input_digest,
        digest(research))) {
    throw new SpikeEvidenceValidationError(
      "missing_evidence_safety_binding",
      "accepted researcher evidence is missing its safety receipt binding",
    );
  }
  return research;
}

function researchEvidenceSafety(output) {
  return safetyCheckOutput(output, "research");
}

function spikeReportSafety(output) {
  return safetyCheckOutput(output, "delegate_evidence");
}

function safetyCheckOutput(output, classification) {
  if (typeof output !== "string" || output.length === 0) {
    return { accepted: false };
  }
  let subject = output;
  try {
    subject = parseCanonicalOutput(output);
  } catch {
    // Semantic validation owns JSON/schema correctness.  Safety still scans
    // the exact crossing bytes so safe malformed output remains quarantine
    // evidence while unsafe malformed output is redacted.
  }
  try {
    return assertSafety(subject, classification, subject);
  } catch {
    return { accepted: false };
  }
}

function assertSafety(value, classification, subject = value) {
  let request;
  try {
    request = createEvidenceSafetyRequest({
      classification,
      allowed_use: ["delegate_transfer"],
      input: value,
    });
  } catch (error) {
    throw new SpikeEvidenceValidationError(
      error?.reason ?? "invalid_input",
      "evidence safety request could not be created",
    );
  }
  const validation = validateEvidenceSafety(request);
  if (!validation.accepted) {
    throw new SpikeEvidenceValidationError(
      validation.rejection.code,
      "evidence safety rejected the delegate material",
    );
  }
  const binding = bindDelegateEvidenceReceipt(validation.receipt, {
    subject_digest: digest(subject),
  });
  if (!binding.accepted) {
    throw new SpikeEvidenceValidationError(
      binding.rejection.code,
      "evidence safety receipt could not be bound to the delegate material",
    );
  }
  return {
    accepted: true,
    receipt: validation.receipt,
    binding: binding.binding,
  };
}

/* The shared scanner classifies generic `id` keys as material.  Only the two
 * structural IDs in a confirmed question are adapted; delegate evidence
 * retains its original keys so nested material cannot be hidden. */
function questionSafetyProjection(question) {
  return {
    schema: question.schema,
    subject_id: question.id,
    text: question.text,
    sources: question.sources.map((source) => ({
      schema: source.schema,
      subject_id: source.id,
      uri: source.uri,
      digest: source.digest,
    })),
  };
}

function assertQuestionContext(question) {
  const parsed = parseQuestionStructure(question);
  if (!parsed.ok) {
    throw new SpikeEvidenceValidationError(
      "missing_spike_question_context",
      "spike output validation requires the authority-bound question context",
    );
  }
  assertSafety(questionSafetyProjection(parsed.value), "research");
  return parsed.value;
}

function validSourceCitation(citation) {
  return validCitation(citation) && citation.kind === "source";
}

function validCitation(citation) {
  return isPlainRecord(citation) &&
    Object.keys(citation).sort().join(",") === SPIKE_CITATION_KEYS.slice().sort().join(",") &&
    citation.schema === SPIKE_CITATION_SCHEMA &&
    ["source", "research_evidence"].includes(citation.kind) &&
    typeof citation.source_id === "string" && citation.source_id.length > 0 &&
    isDigest(citation.digest) && citation.immutable === true;
}

function parseCanonicalOutput(output) {
  if (typeof output !== "string" || output.length === 0) throw new Error();
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error();
  }
  if (JSON.stringify(canonicalize(value)) !== output) throw new Error();
  return value;
}

function contextQuestion(context) {
  return isPlainRecord(context?.delegate_input?.question)
    ? context.delegate_input.question
    : isPlainRecord(context?.question) ? context.question : null;
}

function isHttpsUriWithoutUserInfo(value) {
  try {
    const uri = new URL(value);
    return uri.protocol === "https:" && uri.hostname.length > 0 &&
      uri.username === "" && uri.password === "";
  } catch {
    return false;
  }
}

function sameDigest(left, right) {
  return isDigest(left) && left === right;
}

function invalidSpike(reason, message) {
  throw new PredefinedFlowValidationError(reason, message);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
