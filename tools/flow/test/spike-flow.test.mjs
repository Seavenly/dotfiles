import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, digest } from "../src/canonical.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createResearchEvidence,
  createSpikeDefinition,
  createSpikeOutputValidators,
  createSpikeReport,
  SPIKE_DELEGATE_INPUT_SCHEMA,
  SPIKE_RESEARCH_OUTPUT_VALIDATOR,
  SPIKE_REPORT_SCHEMA,
  SPIKE_RESEARCH_EVIDENCE_SCHEMA,
  validateResearchEvidence,
  validateSpikeReport,
} from "../src/spike-flow.mjs";
import { completedTurnProjection } from "../test-support/delegate-card.mjs";
import { dynamicCheckpointProposal } from "../test-support/dynamic-checkpoint.mjs";
import {
  rebindDescriptionDigest,
  supportedDescription,
} from "../test-support/delegated-agent-description.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";

test("spike/v1 quick preparation binds distinct non-mutating researcher and synthesizer routes", async () => {
  const researcher = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "spike-research" },
  }, {});
  const synthesizer = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "spike-synthesis" },
  }, {});
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.validator_contracts.push(
    "flow.validator/spike-research-evidence/v1",
    "flow.validator/spike-report/v1",
  );
  facts.limits.max_cards = 2;

  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "spike/v1": createSpikeDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "spike/v1",
    inputs: {
      mode: "quick",
      question: {
        schema: "flow.spike-question/v1",
        id: "question:one",
        text: "Which design should we choose?",
        sources: [{
          schema: "flow.spike-source/v1",
          id: "source:one",
          uri: "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3",
          digest: `sha256:${"1".repeat(64)}`,
        }],
      },
      delegation: {
        schema: "flow.spike-delegation-bindings/v1",
        researcher: spikeBinding("researcher", researcher),
        synthesizer: spikeBinding("synthesizer", synthesizer),
      },
    },
    explicit_facts: facts,
  });

  assert.deepEqual(prepared.graph.cards.map(({ id }) => id), [
    "spike-research",
    "spike-synthesis",
  ]);
  assert.deepEqual(prepared.graph.cards[1].dependencies, ["spike-research"]);
  assert.deepEqual(prepared.graph.cards[1].inputs.delegate_evidence_card_ids, [
    "spike-research",
  ]);
  assert.notEqual(
    prepared.graph.cards[0].route.agent_id,
    prepared.graph.cards[1].route.agent_id,
  );
  assert.deepEqual(prepared.requested_authority.mutations, []);
  assert.deepEqual(prepared.requested_authority.capabilities, []);
});

test("spike/v1 accepts opaque native launch representation but rejects mutating authority", async () => {
  const descriptions = await spikeDescriptions();
  const opaqueResearcher = withDescriptionChanges(descriptions.researcher, {
    native: {
      provider_mode: "opaque-read-only",
      transport: "delegated-runtime",
    },
  });
  const mutatingSynthesizer = withDescriptionChanges(descriptions.synthesizer, {
    effective_authority: {
      ...descriptions.synthesizer.effective_authority,
      capability: "workspace-write",
      dimensions: {
        approvals: "human",
        filesystem: "workspace_write",
        network: "approval_gated",
      },
    },
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "spike/v1": createSpikeDefinition() },
  });
  const selection = (researcher, synthesizer) => ({
    schema: "flow.predefined-flow-selection/v1",
    definition: "spike/v1",
    inputs: {
      mode: "quick",
      question: spikeQuestion(),
      delegation: {
        schema: "flow.spike-delegation-bindings/v1",
        researcher: spikeBinding("researcher", researcher),
        synthesizer: spikeBinding("synthesizer", synthesizer),
      },
    },
    explicit_facts: spikeFacts(),
  });

  const prepared = runtime.prepare(selection(opaqueResearcher, descriptions.synthesizer));
  assert.equal(prepared.graph.cards[0].inputs.description.launch.native.provider_mode,
    "opaque-read-only");
  assert.throws(
    () => runtime.prepare(selection(descriptions.researcher, mutatingSynthesizer)),
    (error) => error.reason === "invalid_delegate_authority",
  );
});

test("RunAuthority materializes accepted researcher evidence into an exact synthesis envelope", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-spike-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-spike", "process-spike"),
  });
  t.after(() => authority.close());

  const question = spikeQuestion();
  const descriptions = await spikeDescriptions();
  const researcherEvidence = createResearchEvidence({
    question_id: question.id,
    answer: "The pinned design is the clearest bounded option.",
    citations: [sourceCitation(question)],
    findings: ["The pinned design has a smaller operational surface."],
    residual_gaps: ["A live usability comparison remains untested."],
  });
  const dispatches = [];
  const turns = new Map();
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      const isResearch = request.agent_id === "agent:spike-researcher";
      const turnId = isResearch ? "turn:spike-research" : "turn:spike-synthesis";
      let output = JSON.stringify(researcherEvidence);
      if (!isResearch) {
        const envelope = JSON.parse(request.prompt);
        assert.equal(envelope.schema, SPIKE_DELEGATE_INPUT_SCHEMA);
        assert.equal(Object.hasOwn(request, "authority_materialized_evidence"), false);
        const materialized = envelope.authority_materialized_evidence;
        const accepted = materialized.accepted_delegates[0];
        const acceptedResearch = JSON.parse(accepted.evidence.validated_output);
        output = JSON.stringify(createSpikeReport({
          question_id: question.id,
          answer: "The pinned design is the clearest bounded option.",
          residual_gaps: ["A live usability comparison remains untested."],
          source_citations: [sourceCitation(question)],
          research_evidence_digest: acceptedResearch.evidence_digest,
        }));
      }
      turns.set(turnId, {
        callerKey: request.caller_key,
        description: isResearch ? descriptions.researcher : descriptions.synthesizer,
        output,
        prompt: request.prompt,
        agentId: request.agent_id,
      });
      dispatches.push(request);
      return workingProjection(request, turnId);
    },
    async send() {},
    async observe() {},
    async wait(request) {
      const turn = turns.get(request.turn_id);
      assert.ok(turn, `unknown turn ${request.turn_id}`);
      return completedTurnProjection({
        agentId: turn.agentId,
        callerKey: turn.callerKey,
        description: turn.description,
        output: turn.output,
        prompt: turn.prompt,
        turnId: request.turn_id,
      });
    },
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      return retiredProjection(request);
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort,
    delegateOutputValidators: createSpikeOutputValidators(),
    predefinedDefinitions: { "spike/v1": createSpikeDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "spike/v1",
    inputs: {
      mode: "quick",
      question,
      delegation: {
        schema: "flow.spike-delegation-bindings/v1",
        researcher: spikeBinding("researcher", descriptions.researcher),
        synthesizer: spikeBinding("synthesizer", descriptions.synthesizer),
      },
    },
    explicit_facts: spikeFacts(),
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));

  let completed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: launch.run_id });
    if (projection.phase === "succeeded") {
      completed = projection;
      break;
    }
    const action = projection.legal_actions?.find(({ type }) =>
      ["delegate_execute", "recovery"].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(completed?.phase, "succeeded");
  assert.equal(dispatches.length, 2);
  assert.match(dispatches[0].prompt,
    /Research the confirmed question using only the immutable source references below\./u);
  assert.match(dispatches[0].prompt,
    /flow\.spike-research-evidence\/v1/u);
  assert.match(dispatches[0].prompt,
    /fields answer, assurance, citations, evidence_digest, findings, question_id, residual_gaps/u);
  assert.match(dispatches[0].prompt, /assurance to lower/u);
  assert.match(dispatches[0].prompt, /citations/u);
  assert.match(dispatches[0].prompt, /findings/u);
  assert.match(dispatches[0].prompt, /residual_gaps/u);
  assert.match(dispatches[0].prompt,
    /Do not claim unsupported authority \(network, filesystem, mutation\)\./u);
  const questionMarker = "Confirmed question and sources (canonical JSON): ";
  assert.equal(
    dispatches[0].prompt.slice(
      dispatches[0].prompt.indexOf(questionMarker) + questionMarker.length,
    ),
    JSON.stringify(canonicalize(question)),
  );
  assert.ok(dispatches[0].prompt.includes(question.sources[0].digest));
  const envelope = JSON.parse(dispatches[1].prompt);
  const materialized = envelope.authority_materialized_evidence;
  assert.equal(materialized.schema, "flow.authority-materialized-evidence/v1");
  assert.match(materialized.evidence_digest, /^sha256:[0-9a-f]{64}$/u);
  const { evidence_digest: _ignored, ...materializedIdentity } = materialized;
  assert.equal(materialized.evidence_digest, digest(materializedIdentity));
  const accepted = materialized.accepted_delegates[0];
  assert.equal(accepted.card_id, "spike-research");
  assert.equal(accepted.evidence.schema, "flow.delegate-evidence/v1");
  assert.ok(accepted.evidence.evidence_safety_receipt);
  assert.ok(accepted.evidence.evidence_safety_binding);
  assert.match(envelope.prompt,
    /Synthesize only the authority-materialized researcher evidence below\./u);
  assert.match(envelope.prompt, /flow\.spike-report\/v1/u);
  assert.match(envelope.prompt,
    /fields answer, assurance, citations, question_id, research_evidence_digest, residual_gaps/u);
  assert.match(envelope.prompt, /assurance to lower/u);
  assert.match(envelope.prompt, /nonempty residual_gaps/u);
  assert.match(envelope.prompt,
    /research_evidence_digest must exactly equal the accepted researcher evidence digest\./u);
  assert.match(envelope.prompt, /accepted immutable question sources/u);
  assert.match(envelope.prompt, /no ambient transcript or data/u);
  assert.match(envelope.prompt, /no unsupported authority/u);
  assert.ok(envelope.prompt.includes(JSON.stringify(canonicalize(question))));
  assert.ok(JSON.stringify(envelope).includes(
    JSON.parse(accepted.evidence.validated_output).evidence_digest,
  ));
  assert.deepEqual(Object.keys(envelope).sort(), [
    "authority_materialized_evidence",
    "prompt",
    "schema",
  ]);
  assert.equal(Object.hasOwn(envelope, "researcher_evidence"), false);
  const report = JSON.parse(completed.delegate_attempts.find(
    ({ card_id: cardId }) => cardId === "spike-synthesis",
  ).validated_output);
  assert.equal(report.schema, SPIKE_REPORT_SCHEMA);
  assert.equal(report.research_evidence_digest,
    JSON.parse(accepted.evidence.validated_output).evidence_digest);
  assert.equal(report.assurance, "lower");
  assert.ok(report.residual_gaps.length > 0);
});

test("spike contracts preserve cited semantic uncertainty and quarantine malformed, uncited, and shared-safety-rejected evidence", () => {
  const question = spikeQuestion();
  const context = { delegate_input: { question } };
  const research = createResearchEvidence({
    question_id: question.id,
    answer: "A bounded conceptual answer.",
    citations: [sourceCitation(question)],
    findings: ["The cited source is internally contradictory; no semantic winner is claimed."],
    residual_gaps: [],
  });
  const validators = createSpikeOutputValidators();
  const safety = validators[SPIKE_RESEARCH_OUTPUT_VALIDATOR].evidenceSafety(
    JSON.stringify(research),
    context,
  );
  const provider = {
    schema: "flow.delegate-evidence/v1",
    evidence_safety_receipt: safety.receipt,
    evidence_safety_binding: safety.binding,
    validated_output: JSON.stringify(research),
  };
  const materializedIdentity = {
    schema: "flow.authority-materialized-evidence/v1",
    accepted_delegates: [{
      card_id: "spike-research",
      evidence: provider,
    }],
  };
  const materialized = {
    ...materializedIdentity,
    evidence_digest: digest(materializedIdentity),
  };
  const report = createSpikeReport({
    question_id: question.id,
    answer: "A bounded conceptual answer.",
    residual_gaps: ["The contradictory finding remains unresolved pending a live comparison."],
    source_citations: [sourceCitation(question)],
    research_evidence_digest: research.evidence_digest,
  });
  assert.equal(validateResearchEvidence(JSON.stringify(research), context), true);
  assert.match(research.findings[0], /contradictory/u);
  assert.equal(research.schema, SPIKE_RESEARCH_EVIDENCE_SCHEMA);
  assert.equal(validateSpikeReport(JSON.stringify(report), {
    ...context,
    authority_materialized_evidence: materialized,
  }), true);
  assert.ok(report.residual_gaps.some((gap) => /contradictory/u.test(gap)));

  const { evidence_digest: _researchDigest, ...researchIdentity } = research;
  const nestedIdIdentity = {
    ...researchIdentity,
    findings: [{ id: "nested-material", value: "opaque nested material" }],
  };
  const nestedIdResearch = {
    ...nestedIdIdentity,
    evidence_digest: digest(nestedIdIdentity),
  };
  assert.equal(validateResearchEvidence(
    JSON.stringify(canonicalize(nestedIdResearch)),
    context,
  ), false);

  const malformed = "not-json";
  assert.equal(validateResearchEvidence(malformed, context), false);
  assert.equal(validateSpikeReport(JSON.stringify({ ...report, citations: [] }), {
    ...context,
    authority_materialized_evidence: materialized,
  }), false);

  const unsafeIdentity = {
    ...research,
    answer: "password: leaked-material",
  };
  const unsafe = {
    ...unsafeIdentity,
    evidence_digest: digest(unsafeIdentity),
  };
  assert.equal(validateResearchEvidence(
    JSON.stringify(canonicalize(unsafe)),
    context,
  ), false);

  const forgedMaterializedIdentity = {
    ...materialized,
    accepted_delegates: [{
      ...materialized.accepted_delegates[0],
      evidence: {
        ...provider,
        evidence_safety_binding: {
          ...provider.evidence_safety_binding,
          subject_digest: digest(unsafe),
        },
      },
    }],
  };
  const forgedMaterialized = {
    ...forgedMaterializedIdentity,
    evidence_digest: digest(forgedMaterializedIdentity),
  };
  assert.equal(validateSpikeReport(JSON.stringify(report), {
    ...context,
    authority_materialized_evidence: forgedMaterialized,
  }), false);
});

test("spike narrows safety projection to confirmed question IDs and scans delegate output unchanged", () => {
  const question = spikeQuestion();
  const context = { delegate_input: { question } };
  const valid = createResearchEvidence({
    question_id: question.id,
    answer: "The answer is grounded in the confirmed source.",
    citations: [sourceCitation(question)],
    findings: ["One bounded finding."],
  });

  // The confirmed question and source IDs are adapted only at the question
  // boundary so the shared scanner can accept those structural identities.
  assert.equal(validateResearchEvidence(JSON.stringify(valid), context), true);

  // A nested JSON result is still delegate material.  Rewriting its generic
  // `id` key to `subject_id` before scanning would incorrectly evade #79.
  const { evidence_digest: _ignored, ...identity } = valid;
  const unsafeIdentity = {
    ...identity,
    answer: JSON.stringify({ result: { id: "opaque delegate material" } }),
  };
  const unsafe = {
    ...unsafeIdentity,
    evidence_digest: digest(unsafeIdentity),
  };
  assert.equal(validateResearchEvidence(
    JSON.stringify(canonicalize(unsafe)),
    context,
  ), false);
});

test("spike research and reports cite every accepted source exactly once", () => {
  const question = multiSourceQuestion();
  const context = { delegate_input: { question } };
  const citations = question.sources.map((source) => sourceCitation({
    sources: [source],
  }));
  const research = createResearchEvidence({
    question_id: question.id,
    answer: "A bounded answer grounded in both immutable sources.",
    citations,
    findings: ["The sources leave one semantic comparison unresolved."],
  });
  const { evidence_digest: _multiResearchDigest, ...researchIdentity } = research;
  const safety = createSpikeOutputValidators()[SPIKE_RESEARCH_OUTPUT_VALIDATOR]
    .evidenceSafety(JSON.stringify(research), context);
  const provider = {
    schema: "flow.delegate-evidence/v1",
    evidence_safety_receipt: safety.receipt,
    evidence_safety_binding: safety.binding,
    validated_output: JSON.stringify(research),
  };
  const materializedIdentity = {
    schema: "flow.authority-materialized-evidence/v1",
    accepted_delegates: [{ card_id: "spike-research", evidence: provider }],
  };
  const materialized = {
    ...materializedIdentity,
    evidence_digest: digest(materializedIdentity),
  };
  const report = createSpikeReport({
    question_id: question.id,
    answer: "A bounded answer grounded in both immutable sources.",
    residual_gaps: ["The semantic comparison remains unresolved."],
    source_citations: citations,
    research_evidence_digest: research.evidence_digest,
  });

  assert.equal(validateResearchEvidence(JSON.stringify(research), context), true);
  assert.equal(validateSpikeReport(JSON.stringify(report), {
    ...context,
    authority_materialized_evidence: materialized,
  }), true);

  const extraCitation = {
    schema: "flow.spike-citation/v1",
    kind: "source",
    source_id: "source:extra",
    digest: `sha256:${"e".repeat(64)}`,
    immutable: true,
  };
  for (const alteredCitations of [
    [citations[0]],
    [...citations, citations[0]],
    [...citations, extraCitation],
  ]) {
    const alteredResearchIdentity = {
      ...researchIdentity,
      citations: alteredCitations,
    };
    const alteredResearch = {
      ...alteredResearchIdentity,
      evidence_digest: digest(alteredResearchIdentity),
    };
    assert.equal(validateResearchEvidence(
      JSON.stringify(canonicalize(alteredResearch)),
      context,
    ), false);
    assert.equal(validateSpikeReport(JSON.stringify({
      ...report,
      citations: [...alteredCitations, report.citations.at(-1)],
    }), {
      ...context,
      authority_materialized_evidence: materialized,
    }), false);
  }
});

test("shared evidence safety rejection quarantines a researcher before synthesis dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-spike-reject-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-spike-reject", "process-spike-reject"),
  });
  t.after(() => authority.close());
  const question = spikeQuestion();
  const descriptions = await spikeDescriptions();
  const validResearch = createResearchEvidence({
    question_id: question.id,
    answer: "A valid answer before corruption.",
    citations: [sourceCitation(question)],
  });
  const unsafeIdentity = {
    ...validResearch,
    answer: "authorization: bearer leaked-material at /home/nschott/private",
  };
  const unsafeResearch = JSON.stringify(canonicalize({
    ...unsafeIdentity,
    evidence_digest: digest(unsafeIdentity),
  }));
  const dispatched = [];
  const turns = new Map();
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      assert.equal(request.agent_id, "agent:spike-researcher");
      const turnId = "turn:spike-research-rejected";
      turns.set(turnId, {
        callerKey: request.caller_key,
        description: descriptions.researcher,
        output: unsafeResearch,
        prompt: request.prompt,
      });
      dispatched.push(request);
      return workingProjection(request, turnId);
    },
    async send() {},
    async observe() {},
    async wait({ turn_id: turnId }) {
      const turn = turns.get(turnId);
      return completedTurnProjection({
        agentId: "agent:spike-researcher",
        callerKey: turn.callerKey,
        description: turn.description,
        output: turn.output,
        prompt: turn.prompt,
        turnId,
      });
    },
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      return retiredProjection(request);
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort,
    delegateOutputValidators: createSpikeOutputValidators(),
    predefinedDefinitions: { "spike/v1": createSpikeDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "spike/v1",
    inputs: {
      mode: "quick",
      question,
      delegation: {
        schema: "flow.spike-delegation-bindings/v1",
        researcher: spikeBinding("researcher", descriptions.researcher),
        synthesizer: spikeBinding("synthesizer", descriptions.synthesizer),
      },
    },
    explicit_facts: spikeFacts(),
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  let rejected;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: launch.run_id });
    rejected = projection.delegate_attempts?.find(({ card_id: cardId }) =>
      cardId === "spike-research" &&
      ["quarantined", "late_quarantined"].includes(projection.delegate_attempts
        .find(({ card_id: id }) => id === cardId)?.status));
    if (rejected) break;
    const action = projection.legal_actions?.find(({ type }) =>
      ["delegate_execute", "recovery"].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(dispatched.length, 1);
  assert.equal(projection.delegate_attempts[0].status, "quarantined");
  assert.equal(projection.delegate_attempts[0].validated_output, null);
  assert.equal(projection.quarantined_delegate_outputs[0]
    .quarantine_record.quarantine_reason, "independent_validation_failed");
  const quarantine = projection.quarantined_delegate_outputs[0]
    .quarantine_record;
  assert.equal(quarantine.correlated_output, null);
  assert.doesNotMatch(JSON.stringify(projection), /leaked-material|\/home\/nschott\/private/u);
  assert.equal(quarantine.validator_receipts[0].accepted, false);
  assert.equal(quarantine.validator_receipts[0].evidence_safety_accepted, false);
  assert.equal(quarantine.validator_receipts[0]
    .evidence_safety_rejection.redacted, true);
  assert.equal(projection.legal_actions.some(({ card_id: cardId }) =>
    cardId === "spike-synthesis"), false);
});

test("spike safety cannot be omitted or replaced by a validator registration", async (t) => {
  const safeResearch = createResearchEvidence({
    question_id: spikeQuestion().id,
    answer: "A bounded answer before validator tampering.",
    citations: [sourceCitation(spikeQuestion())],
  });
  const { evidence_digest: _ignored, ...researchIdentity } = safeResearch;
  const unsafeIdentity = {
    ...researchIdentity,
    answer: "authorization: bearer leaked-material; capability: workspace-write; path: /home/nschott/private",
  };
  const unsafeResearch = JSON.stringify(canonicalize({
    ...unsafeIdentity,
    evidence_digest: digest(unsafeIdentity),
  }));
  let overriddenSafetyCalls = 0;
  const registrations = [
    { validate: () => true },
    {
      validate: () => true,
      evidenceSafety() {
        overriddenSafetyCalls += 1;
        return {
          accepted: true,
          receipt: { forged: true },
          binding: { forged: true },
        };
      },
    },
  ];

  for (const registration of registrations) {
    const validators = createSpikeOutputValidators();
    validators[SPIKE_RESEARCH_OUTPUT_VALIDATOR] = registration;
    const projection = await runSpikeResearchAttempt(t, {
      output: unsafeResearch,
      delegateOutputValidators: validators,
    });
    const attempt = projection.delegate_attempts[0];
    const quarantine = projection.quarantined_delegate_outputs[0]
      .quarantine_record;

    assert.equal(attempt.status, "quarantined");
    assert.equal(attempt.validated_output, null);
    assert.equal(quarantine.correlated_output, null);
    assert.equal(quarantine.validator_receipts[0].accepted, false);
    assert.equal(quarantine.validator_receipts[0].evidence_safety_accepted, false);
    assert.doesNotMatch(
      JSON.stringify(projection),
      /leaked-material|workspace-write|\/home\/nschott\/private/u,
    );
  }
  assert.equal(overriddenSafetyCalls, 0);
});

test("unsafe late researcher output is redacted from the serialized projection", async (t) => {
  const safeResearch = createResearchEvidence({
    question_id: spikeQuestion().id,
    answer: "A bounded answer before the late result is corrupted.",
    citations: [sourceCitation(spikeQuestion())],
  });
  const { evidence_digest: _ignored, ...researchIdentity } = safeResearch;
  const unsafeIdentity = {
    ...researchIdentity,
    answer: "authorization: bearer late-leaked-material at /home/nschott/private",
  };
  const research = {
    ...unsafeIdentity,
    evidence_digest: digest(unsafeIdentity),
  };
  const projection = await runSpikeResearchAttempt(t, {
    output: JSON.stringify(research),
    late: true,
  });
  const quarantine = projection.quarantined_delegate_outputs[0]
    .quarantine_record;

  assert.equal(quarantine.quarantine_reason, "late_output");
  assert.equal(quarantine.correlated_output, null);
  assert.doesNotMatch(
    JSON.stringify(projection),
    /late-leaked-material|\/home\/nschott\/private/u,
  );
  assert.equal(projection.delegate_attempts[0].validated_output, null);
});

test("safe malformed researcher output remains explicit quarantine evidence", async (t) => {
  const projection = await runSpikeResearchAttempt(t, { output: "not-json" });
  const quarantine = projection.quarantined_delegate_outputs[0]
    .quarantine_record;

  assert.equal(quarantine.quarantine_reason, "independent_validation_failed");
  assert.equal(quarantine.correlated_output, "not-json");
  assert.equal(quarantine.validator_receipts[0].accepted, false);
  assert.equal(quarantine.validator_receipts[0].evidence_safety_accepted, true);
  assert.ok(quarantine.evidence_safety_receipt);
  assert.ok(quarantine.evidence_safety_binding);
  assert.equal(projection.delegate_attempts[0].validated_output, null);
});

async function runSpikeResearchAttempt(
  t,
  {
    output,
    late = false,
    delegateOutputValidators = createSpikeOutputValidators(),
  },
) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-spike-safety-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-spike-safety", `process-${late ? "late" : "completed"}`),
  });
  t.after(() => authority.close());
  const question = spikeQuestion();
  const descriptions = await spikeDescriptions();
  const turns = new Map();
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      const turnId = "turn:spike-safety";
      turns.set(turnId, {
        callerKey: request.caller_key,
        description: descriptions.researcher,
        output,
        prompt: request.prompt,
      });
      return workingProjection(request, turnId);
    },
    async send() {},
    async observe() {},
    async wait({ turn_id: turnId }) {
      const turn = turns.get(turnId);
      const projection = completedTurnProjection({
        agentId: "agent:spike-researcher",
        callerKey: turn.callerKey,
        description: turn.description,
        output: turn.output,
        prompt: turn.prompt,
        turnId,
      });
      if (late) {
        projection.status = "interrupted";
        projection.turn.status = "interrupted";
        projection.turn.late_result = {
          turn_id: turnId,
          disposition: "quarantined",
          proof_classification: "exact_transcript_correlation",
          text: turn.output,
        };
        delete projection.turn.result;
        projection.turn.settlement_proof.classification =
          "interruption_unconfirmed";
        projection.turn.settlement_proof.ordered_inputs[0].delivery_proof =
          "unproven";
      }
      return projection;
    },
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      return retiredProjection(request);
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort,
    delegateOutputValidators,
    predefinedDefinitions: { "spike/v1": createSpikeDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "spike/v1",
    inputs: {
      mode: "quick",
      question,
      delegation: {
        schema: "flow.spike-delegation-bindings/v1",
        researcher: spikeBinding("researcher", descriptions.researcher),
        synthesizer: spikeBinding("synthesizer", descriptions.synthesizer),
      },
    },
    explicit_facts: spikeFacts(),
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: launch.run_id });
    if (projection.delegate_attempts?.[0]?.status === "quarantined") {
      return projection;
    }
    const action = projection.legal_actions?.find(({ type }) =>
      ["delegate_execute", "recovery"].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("researcher did not reach quarantine");
}

function spikeBinding(role, description) {
  const bound = structuredClone(description);
  delete bound.description_digest;
  delete bound.legal_actions;
  bound.description_digest = digest(bound);
  return {
    description: bound,
    route: {
      agent_id: `agent:spike-${role}`,
      configuration_watermark: bound.watermark.content_sha256,
      description_digest: bound.description_digest,
      launch_comparison_key: bound.comparison_keys.launch,
    },
    validators: [
      role === "researcher"
        ? "flow.validator/spike-research-evidence/v1"
        : "flow.validator/spike-report/v1",
    ],
  };
}

function withDescriptionChanges(description, changes) {
  const bound = structuredClone(description);
  if (changes.native !== undefined) {
    bound.launch.native = changes.native;
    bound.comparison_keys.launch = digest(bound.launch);
  }
  if (changes.effective_authority !== undefined) {
    bound.effective_authority = changes.effective_authority;
    bound.comparison_keys.effective_authority =
      digest(bound.effective_authority);
  }
  rebindDescriptionDigest(bound);
  return bound;
}

async function spikeDescriptions() {
  const [researcher, synthesizer] = await Promise.all([
    supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "spike-research" },
    }, {}),
    supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "claude",
        role: "reviewer",
        model: "haiku",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "spike-synthesis" },
    }, {}),
  ]);
  return { researcher, synthesizer };
}

function spikeQuestion() {
  return {
    schema: "flow.spike-question/v1",
    id: "question:one",
    text: "Which design should we choose?",
    sources: [{
      schema: "flow.spike-source/v1",
      id: "source:one",
      uri: "https://github.com/Seavenly/dotfiles/commit/8fa9d02504a18b4a01d015403b47c097fc99e5f3",
      digest: `sha256:${"1".repeat(64)}`,
    }],
  };
}

function multiSourceQuestion() {
  const question = spikeQuestion();
  return {
    ...question,
    sources: [
      ...question.sources,
      {
        schema: "flow.spike-source/v1",
        id: "source:two",
        uri: "https://github.com/Seavenly/dotfiles/commit/450ed46d43e5bb7d9c37e45c6b6d7007014a7c46",
        digest: `sha256:${"2".repeat(64)}`,
      },
    ],
  };
}

function sourceCitation(question) {
  return {
    schema: "flow.spike-citation/v1",
    kind: "source",
    source_id: question.sources[0].id,
    digest: question.sources[0].digest,
    immutable: true,
  };
}

function spikeFacts() {
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.validator_contracts.push(
    "flow.validator/spike-research-evidence/v1",
    "flow.validator/spike-report/v1",
  );
  facts.limits.max_cards = 2;
  return facts;
}

function confirmedPredefinedLaunchRequest(prepared) {
  return {
    prepared,
    confirmation: {
      schema: "flow.predefined-flow-confirmation-decision/v1",
      decision: "accept",
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    },
    closed_facts: {
      schema: "flow.closed-fact-observation/v1",
      bundle_digest: prepared.bundle_digest,
      facts: structuredClone(prepared.explicit_facts),
    },
  };
}

function absentDiscovery() {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: `sha256:${"0".repeat(64)}`,
    },
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
}

function workingProjection(request, turnId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: absentDiscovery().watermark,
    delegation: {
      agent_id: request.agent_id,
      task_id: `task:${request.agent_id}`,
      group_id: "group:spike",
    },
    turn: { id: turnId, status: "working" },
    legal_next_actions: ["wait_bounded"],
  };
}

function retiredProjection(request) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "retire",
    status: "retired",
    watermark: {
      schema: "drovr.agent-authority-watermark/v1",
      authority: "drovr.registry",
      agent_id: request.agent_id,
      record_sha256: digest(request.agent_id),
    },
    delegation: { agent_id: request.agent_id },
    turn: null,
    legal_next_actions: [],
  };
}
