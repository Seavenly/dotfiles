import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { validateDelegateEvidenceSafety } from "../src/evidence-safety.mjs";
import {
  delegateCompatibilityIssue,
  snapshotRequiredDrovrFeatures,
} from "../src/delegate-effects.mjs";
import {
  DELEGATE_INPUT_ENVELOPE_SCHEMA,
  digestDelegateInputBytes,
} from "../src/delegate-input-envelope.mjs";
import { observeCardBlock } from
  "../src/card-block-observation-adapter.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  capabilityBlockedDelegateProposal,
  completedTurnProjection,
  DELEGATE_OUTPUT_VALIDATOR,
  delegateCardProposal,
} from "../test-support/delegate-card.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";
import { confirmedLaunchRequest } from
  "../test-support/dynamic-checkpoint.mjs";
import {
  createFixedTimeDurableRunAuthority as createDurableRunAuthority,
  fixedHostIdentity,
} from
  "../test-support/fixed-host-identity.mjs";
import { executionTimeFacts } from "../test-support/time-facts.mjs";

test("FlowRuntime executes one exact delegate card from reserved authority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const calls = [];
  let projectionAtDiscovery;
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    ...completePortOperations(calls),
    async discover(request) {
      calls.push(["discover", request]);
      projectionAtDiscovery = runtime.query({ run_id: launch.run_id });
      return absentDiscovery();
    },
    async dispatch(request) {
      calls.push(["dispatch", request]);
      return workingProjection(request);
    },
    async wait(request) {
      calls.push(["wait", request]);
      return completedTurnProjection({
        callerKey: calls[0][1].caller_key,
        description,
      });
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output === "accepted output";
        },
        evidenceSafety: validateDelegateEvidenceSafety,
      },
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });

  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const ready = runtime.query({ run_id: launch.run_id });
  const execute = ready.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  );
  const receipt = runtime.command(execute);

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.effect_intents.length, 1);
  assert.equal(receipt.effect_intents[0].attempt_id,
    `${launch.run_id}:delegate-review:attempt:1`);
  const legacyEffectIdentity = digest({
    schema: "flow.delegate-effect-identity/v1",
    run_id: launch.run_id,
    card_id: "delegate-review",
    attempt_id: `${launch.run_id}:delegate-review:attempt:1`,
    route_binding: prepared.graph.cards[1].route,
  });
  assert.equal(receipt.effect_intents[0].effect_id,
    `effect:${legacyEffectIdentity.slice("sha256:".length)}`);
  assert.deepEqual(receipt.effect_intents[0].route_binding,
    prepared.graph.cards[1].route);
  assert.equal(receipt.effect_intents[0].terminal_disposition_policy.schema,
    "flow.delegate-terminal-disposition-policy/v1");
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(calls.map(([operation]) => operation), [
    "discover",
    "dispatch",
    "wait",
    "retire",
  ]);
  const callerKey =
    `${launch.run_id}:delegate-review:attempt:1`;
  assert.equal(calls[0][1].caller_key, callerKey);
  assert.equal(calls[1][1].caller_key, callerKey);
  assert.equal(calls[1][1].input_key, `${callerKey}:input:1`);
  const transmitted = JSON.parse(calls[1][1].prompt);
  assert.equal(transmitted.schema, DELEGATE_INPUT_ENVELOPE_SCHEMA);
  assert.equal(transmitted.instructions, "inspect the exact candidate");
  assert.deepEqual(transmitted.execution_authority, {
    schema: "flow.delegate-execution-authority/v1",
    owner: "RunAuthority",
    capability: description.launch.capability,
    effective_authority_digest:
      description.comparison_keys.effective_authority,
    capability_envelope_ids: [],
  });
  assert.deepEqual(transmitted.task_inputs, {
    schema: "flow.delegate-task-inputs/v1",
  });
  assert.deepEqual(transmitted.resource_references, []);
  assert.equal(calls[1][1].payload_sha256,
    digestDelegateInputBytes(calls[1][1].prompt));
  assert.equal(projectionAtDiscovery.cards[1].status, "executing");
  assert.equal(projectionAtDiscovery.delegate_attempts[0].status, "reserved");
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.delegate_attempts[0].status, "accepted");
  assert.equal(completed.delegate_attempts[0].validated_output,
    "accepted output");
  assert.equal(completed.delegate_attempts[0].evidence
    .terminal_disposition.status, "retired");
  assert.equal(completed.delegate_attempts[0].evidence.drovr_watermark.schema,
    "drovr.turn-authority-watermark/v1");
  assert.ok(completed.delegate_attempts[0].evidence.evidence_safety_receipt);
  assert.ok(completed.delegate_attempts[0].evidence.evidence_safety_binding);
  assert.equal(completed.delegate_attempts[0].evidence.terminal_disposition
    .watermark.schema, "drovr.agent-authority-watermark/v1");
  assert.deepEqual(completed.quarantined_delegate_outputs, []);
  assert.deepEqual(completed.legal_actions, []);
});

test("plan preparation rejects an unapproved route capability", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-authority", "process-authority"),
  });
  t.after(() => authority.close());
  const description = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "workspace-write",
    },
    caller_metadata: { owner: "unapproved-route-capability" },
  }, {});
  const dispatches = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
  });
  assert.throws(
    () => runtime.prepare(delegateCardProposal(description)),
    (error) => error?.reason === "delegate_capability_unavailable",
  );
  assert.deepEqual(dispatches, []);
});

test("mapped Drovr capabilities transmit accepted Flow grant IDs", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-mapped-capability", "process-mapped-capability"),
  });
  t.after(() => authority.close());
  const description = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "workspace-write",
    },
    caller_metadata: { owner: "mapped-capability" },
  }, {});
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.capabilities.push("repository:write");
  proposal.explicit_facts.capability_envelopes.push("repository:write");
  proposal.explicit_facts.limits.max_capabilities = 1;
  const dispatches = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
        prompt: dispatches[0]?.prompt,
      });
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.equal(dispatches.length, 1);
  const envelope = JSON.parse(dispatches[0].prompt);
  assert.deepEqual(envelope.execution_authority.capability_envelope_ids, [
    "repository:write",
  ]);
});

test("workspace-write cannot bypass a workspace claim by declaring read_only", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-read-only-label"),
  });
  t.after(() => authority.close());
  const description = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "workspace-write",
    },
    caller_metadata: { owner: "issue-81-workspace-label" },
  }, {});
  const proposal = delegateCardProposal(description);
  const claim = {
    kind: "workspace",
    id: "workspace:label-check",
    generation: 1,
    mutation_epoch: 0,
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
  proposal.graph.cards[1].inputs.resource_references = [{
    schema: "flow.delegate-execution-resource-selection/v1",
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: claim.id,
    generation: claim.generation,
    mutation_epoch: claim.mutation_epoch,
    fingerprint: claim.fingerprint,
    access: "read_only",
    authority_binding_id: "resource:facts",
  }];
  proposal.graph.cards[1].resource_claims = [claim];
  proposal.explicit_facts.resource_claims.push(claim);
  proposal.explicit_facts.capability_envelopes.push("repository:write");
  proposal.explicit_facts.limits.max_capabilities = 1;
  proposal.explicit_facts.limits.max_resources = 1;
  proposal.requested_authority.capabilities.push("repository:write");
  const definition = {
    schema: "flow.predefined-definition/v1",
    id: "workspace-label/v1",
    contract: "flow.definition/workspace-label/v1",
    promised_outcomes: ["an exact fenced workspace outcome"],
    negative_outcomes: ["no untracked workspace mutation"],
    trust_posture: { authority: "RunAuthority" },
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "resource:facts",
      contract: "flow.resource-authority/v1",
      observation_input: { fact: "resource_claims" },
    }],
    compile() {
      return proposal;
    },
  };
  const registeredAuthorities = {
    "resource:facts": {
      schema: "flow.registered-authority/v1",
      id: "resource:facts",
      contract: "flow.resource-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "provider:workspace-label",
        version: "v1",
      },
      observe({ observation_input }) {
        return {
          schema: "flow.authority-observation/v1",
          status: "available",
          watermark: digest(proposal.explicit_facts.resource_claims),
          observation_input,
        };
      },
    },
  };
  let dispatches = 0;
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredAuthorities,
    predefinedDefinitions: { "workspace-label/v1": definition },
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      ...completePortOperations(),
      async discover() {
        return absentDiscovery();
      },
      async dispatch(request) {
        dispatches += 1;
        return completedTurnProjection({
          callerKey: request.caller_key,
          description,
          prompt: request.prompt,
        });
      },
      async wait() {},
    },
    delegatedAgentResourcePort: {
      contract: "flow.delegated-agent-resource-port/v1",
      async ensure() {
        throw new Error("invalid input must not provision a resource");
      },
      async retire() {
        throw new Error("invalid input must not retire a resource");
      },
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output === "accepted output";
        },
        evidenceSafety: validateDelegateEvidenceSafety,
      },
    },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "workspace-label/v1",
    inputs: {},
    explicit_facts: proposal.explicit_facts,
  });
  const launch = runtime.launch({
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
  });
  assert.equal(launch.created, true, JSON.stringify(launch));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(({ decision }) =>
    decision === "approve"));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "delegate_execute"));
  await until(() => ["succeeded", "reconciling"].includes(
    runtime.query({ run_id: launch.run_id }).effects[0]?.status,
  ));

  const effect = runtime.query({ run_id: launch.run_id }).effects[0];
  assert.equal(dispatches, 0);
  assert.equal(effect.last_observation.provider_observation.code,
    "workspace_claim_missing");
});

test("an altered route description digest cannot reach delegate dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-altered-route", "process-altered-route"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  description.caller_metadata = { owner: "altered-after-description" };
  const dispatches = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(dispatches, []);
  assert.equal(
    runtime.query({ run_id: launch.run_id }).delegate_attempts[0].status,
    "reconciling",
  );
});

test("delegate recovery discovers the reserved attempt before dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const description = await compatibleDescription();
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstCalls = [];
  const firstRuntime = delegateRuntime(firstAuthority, {
    async discover(request) {
      firstCalls.push(request);
      throw new Error("process exited after intent commit");
    },
  });
  const prepared = firstRuntime.prepare(delegateCardProposal(description));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(firstRuntime, launch.run_id);
  await until(() => firstCalls.length === 1);
  const unresolved = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(unresolved.delegate_attempts[0].status, "reconciling");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredCalls = [];
  const recoveredRuntime = delegateRuntime(recoveredAuthority, {
    async discover(request) {
      recoveredCalls.push(["discover", request]);
      return completedTurnProjection({
        callerKey: request.caller_key,
        description,
      });
    },
    async dispatch() {
      recoveredCalls.push(["dispatch"]);
      assert.fail("recovery must adopt the discovered exact turn");
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(recoveredCalls.map(([operation]) => operation), ["discover"]);
  assert.equal(recoveredCalls[0][1].caller_key,
    `${launch.run_id}:delegate-review:attempt:1`);
  assert.equal(recoveredRuntime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status, "accepted");
});

test("credential-shaped delegate output is quarantined before validated_output", async (t) => {
  const credentialShapedOutput = ["sk", "live", "1234567890credential"].join("_");
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-credential-output"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait({ turn_id: turnId }) {
      return completedTurnProjection({
        callerKey: `${launch.run_id}:delegate-review:attempt:1`,
        description,
        turnId,
        output: credentialShapedOutput,
      });
    },
  }, () => true);
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ status }) => status === "quarantined",
  ));
  const projection = runtime.query({ run_id: launch.run_id });
  const attempt = projection.delegate_attempts[0];
  assert.equal(attempt.validated_output, null);
  assert.equal(JSON.stringify(projection).includes(credentialShapedOutput),
    false);
  assert.equal(projection.quarantined_delegate_outputs.length, 1);
});

test("delegate launch rejects validators without evidence safety", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-missing-safety"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {}, () => true, {
    evidenceSafety: null,
  });
  const prepared = runtime.prepare(delegateCardProposal(description));

  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(launch.code, "unregistered_delegate_evidence_safety");
});

test("delegate settlement rejects forged evidence safety receipt or binding", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-forged-safety"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait({ turn_id: turnId }) {
      return completedTurnProjection({
        callerKey: `${launch.run_id}:delegate-review:attempt:1`,
        description,
        turnId,
      });
    },
  }, () => true, {
    evidenceSafety: () => ({
      accepted: true,
      receipt: {},
      binding: {},
    }),
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  const attempt = runtime.query({ run_id: launch.run_id }).delegate_attempts[0];
  assert.equal(attempt.validated_output, null);
});

test("delegate recovery settles retirement before accepting output", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let discoverCalls = 0;
  let dispatchCalls = 0;
  let retireCalls = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      discoverCalls += 1;
      return discoverCalls === 1
        ? absentDiscovery()
        : completedTurnProjection({ callerKey: request.caller_key, description });
    },
    async dispatch(request) {
      dispatchCalls += 1;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
    async retire(request) {
      retireCalls += 1;
      if (retireCalls === 1) throw new Error("retirement unavailable");
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => retireCalls === 1);

  const unresolved = runtime.query({ run_id: launch.run_id });
  assert.equal(unresolved.delegate_attempts[0].status, "reconciling");
  runtime.command(unresolved.legal_actions.find(
    ({ type }) => type === "recovery",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.equal(dispatchCalls, 1);
  assert.equal(discoverCalls, 2);
  assert.equal(retireCalls, 2);
});

test("bounded wait recovery preserves one live attempt without cancellation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const calls = [];
  let discovery = 0;
  let waits = 0;
  let dispatchRequest;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      calls.push("discover");
      discovery += 1;
      return discovery === 1
        ? absentDiscovery()
        : workingProjection(dispatchRequest);
    },
    async dispatch(request) {
      calls.push("dispatch");
      dispatchRequest = request;
      return workingProjection(request);
    },
    async wait() {
      calls.push("wait");
      waits += 1;
      if (waits === 1) return stillWorkingProjection();
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
    async cancel() {
      calls.push("cancel");
      assert.fail("bounded wait recovery must not cancel live work");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => waits === 1);

  const unresolved = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(unresolved.delegate_attempts.map(({ status }) => status), [
    "reserved",
  ]);
  assert.deepEqual(unresolved.quarantined_delegate_outputs, []);
  assert.deepEqual(unresolved.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  const attemptId = unresolved.delegate_attempts[0].attempt_id;
  runtime.command(unresolved.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.delegate_attempts.length, 1);
  assert.equal(completed.delegate_attempts[0].attempt_id, attemptId);
  assert.equal(calls.filter((operation) => operation === "dispatch").length, 1);
  assert.equal(calls.includes("cancel"), false);
});

test("a hung delegate crossing its active deadline keeps ownership and exposes only cancel", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let wallValueMs = 1_700_000_000_000;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({ wallValueMs, bootId: "boot-a" });
      },
    },
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let discoveryCount = 0;
  let waitStarted;
  const waitEntered = new Promise((resolve) => { waitStarted = resolve; });
  const cancellations = [];
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      discoveryCount += 1;
      return discoveryCount === 1
        ? absentDiscovery()
        : workingProjection({
            agent_id: "agent:delegate-review",
            caller_key: request.caller_key,
          });
    },
    async dispatch(request) {
      return workingProjection(request);
    },
    async wait() {
      waitStarted();
      return new Promise(() => {});
    },
    async cancel(request) {
      cancellations.push(request);
      return cancelledTurnProjection(request.turn_id);
    },
  });
  const proposal = delegateCardProposal(description, { maxAttempts: 2 });
  const delegateCard = proposal.graph.cards.find(({ id }) => id === "delegate-review");
  delegateCard.limits.max_active_seconds = 1;
  const claim = { kind: "test-resource", id: "delegate-hung" };
  delegateCard.resource_claims.push(claim);
  proposal.explicit_facts.resource_claims.push(claim);
  proposal.explicit_facts.limits.max_resources = 1;
  proposal.explicit_facts.limits.max_elapsed_seconds = 30;
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs,
    bootId: "boot-a",
  });
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await waitEntered;

  wallValueMs += 2_000;
  const expired = runtime.query({ run_id: launch.run_id });
  assert.equal(expired.execution_time.status, "exhausted");
  assert.equal(expired.execution_time.active_elapsed_seconds.upper >= 2, true);
  assert.deepEqual(expired.legal_actions.map(({ type }) => type), ["cancel"]);
  assert.equal(expired.effects[0].invocation_started, true);
  assert.equal(expired.resource_dispositions[0].disposition, "held");
  const originalOwnership = expired.run_ownership;
  const originalCallerKey = expired.delegate_attempts[0].caller_key;

  const cancellationReceipt = runtime.command(expired.legal_actions[0]);
  assert.equal(cancellationReceipt.accepted, true, JSON.stringify(cancellationReceipt));
  await until(() => cancellations.length === 1);
  const cancelled = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(cancellations, [{
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:delegate-review",
  }]);
  assert.deepEqual(cancelled.run_ownership, originalOwnership);
  assert.equal(cancelled.delegate_attempts[0].caller_key, originalCallerKey);
  assert.equal(cancelled.legal_actions.some(({ type }) =>
    ["delegate_execute", "operation_execute"].includes(type)), false);
});

for (const status of ["needs_input", "cancelled"]) {
  test(`${status} delegate result is quarantined as a terminal attempt`, async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${status}`),
    });
    t.after(() => authority.close());
    const description = await compatibleDescription();
    const runtime = delegateRuntime(authority, {
      async wait() {
        const projection = completedTurnProjection({
          callerKey: runtime.query({ run_id: launch.run_id })
            .delegate_attempts[0].caller_key,
          description,
        });
        projection.status = status;
        projection.turn.status = status === "needs_input" ? "working" : status;
        delete projection.turn.result;
        return projection;
      },
    });
    const prepared = runtime.prepare(delegateCardProposal(description));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");

    const quarantined = runtime.query({ run_id: launch.run_id });
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.quarantine_reason, "terminal_output_not_completed");
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.terminal_disposition.status, "retired");
    assert.deepEqual(quarantined.legal_actions.map(({ type }) => type), [
      "terminal_disposition",
    ]);
  });
}

test("a working quarantined turn is cancelled before retry handoff", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-retry-cancel"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  const cancellations = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts.at(-1).caller_key,
        description,
      });
      if (attempt === 1) {
        projection.status = "needs_input";
        projection.turn.status = "working";
        delete projection.turn.result;
      }
      return projection;
    },
    async cancel(request) {
      cancellations.push(request);
      return cancelledTurnProjection(request.turn_id);
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  const retryable = runtime.query({ run_id: launch.run_id });
  const disposition = retryable.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition;
  assert.deepEqual(cancellations, [{
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:delegate-review",
  }]);
  assert.equal(disposition.durable_holder, "drovr.registry");
  assert.equal(disposition.turn_disposition.status, "cancelled");
  assert.deepEqual(retryable.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);

  runtime.command(retryable.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.equal(attempt, 2);
});

test("an observed capability block gates delegate execution", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  let discoveries = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      discoveries += 1;
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts.at(-1).caller_key,
        description,
        output: attempt === 1 ? "rejected output" : "accepted output",
      });
    },
  });
  const prepared = runtime.prepare(capabilityBlockedDelegateProposal(
    description,
    { maxAttempts: 2 },
  ));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const checkpoint = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "checkpoint_decision");
  runtime.command(checkpoint);
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(blocked.legal_actions.map(({ type }) => type), [
    "capability_grant",
  ]);
  assert.equal(discoveries, 0);
  runtime.command(blocked.legal_actions[0]);
  const ready = runtime.query({ run_id: launch.run_id });
  assert.equal(ready.cards.find(({ id }) => id === "delegate-review").status,
    "ready");
  assert.deepEqual(ready.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);
  runtime.command(ready.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const retryable = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(retryable.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);
  assert.equal(retryable.blocks[0].schema, "flow.delegate-card-block/v1");
  runtime.command(retryable.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
});

test("late delegate output stays correlated and quarantined before a bounded retry", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      const callerKey = runtime.query({ run_id: launch.run_id })
        .delegate_attempts.at(-1).caller_key;
      const projection = completedTurnProjection({ callerKey, description });
      if (attempt === 1) {
        projection.status = "interrupted";
        projection.turn.status = "interrupted";
        projection.turn.late_result = {
          turn_id: projection.turn.id,
          disposition: "quarantined",
          proof_classification: "exact_transcript_correlation",
          text: projection.turn.result.text,
        };
        delete projection.turn.result;
        projection.turn.settlement_proof.classification =
          "interruption_unconfirmed";
        projection.turn.settlement_proof.ordered_inputs[0].delivery_proof =
          "unproven";
      }
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.equal(blocked.phase, "active");
  assert.equal(blocked.progress, "blocked");
  assert.equal(blocked.delegate_attempts[0].evidence, null);
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.quarantine_reason, "late_output");
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.correlated_output, "accepted output");
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition.durable_holder, "drovr.registry");
  runtime.command(blocked.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(completed.delegate_attempts.map(({ status }) => status), [
    "quarantined",
    "accepted",
  ]);
  assert.equal(completed.delegate_attempts[1].attempt_id,
    `${launch.run_id}:delegate-review:attempt:2`);
  assert.equal(completed.quarantined_delegate_outputs.length, 1);
});

test("accepted Drovr output cannot schedule cards or advance RunAuthority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      return workingProjection(request);
    },
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
      projection.flow_events = [{ type: "run_declined" }];
      projection.scheduled_cards = [{ id: "drovr-invented-card" }];
      projection.legal_next_actions = ["advance_run"];
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "succeeded");
  assert.deepEqual(projection.cards.map(({ id }) => id), [
    "confirm-plan",
    "delegate-review",
  ]);
  assert.equal(projection.delegate_attempts[0].status, "accepted");
  assert.deepEqual(projection.legal_actions, []);
});

test("incompatible Drovr lifecycle claims remain quarantined", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-boundary"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
      projection.turn.settlement_proof.description_digest =
        `sha256:${"f".repeat(64)}`;
      projection.flow_events = [{ type: "run_succeeded" }];
      projection.scheduled_cards = [{ id: "drovr-invented-card" }];
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "active");
  assert.deepEqual(projection.cards.map(({ id }) => id), [
    "confirm-plan",
    "delegate-review",
  ]);
  assert.equal(projection.blocks[0].quarantine_reason,
    "incompatible_settlement_proof");
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "terminal_disposition",
  ]);
  runtime.command(projection.legal_actions[0]);
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "declined");
});

test("required feature snapshot preserves integrity and availability codes", async () => {
  const description = await compatibleDescription();
  const card = delegateCardProposal(description).graph.cards[1];
  const port = {
    contract: "flow.delegated-agent-port/v1",
    ...completePortOperations(),
    async dispatch() {},
    async discover() {},
    async wait() {},
  };
  const validators = new Map([[DELEGATE_OUTPUT_VALIDATOR, {
    validate() { return true; },
  }]]);
  const integrity = snapshotRequiredDrovrFeatures({
    loadBytes: () => Buffer.from("drifted contract"),
  });
  const unavailable = snapshotRequiredDrovrFeatures({
    loadBytes() { throw new Error("offline"); },
  });
  const malformed = snapshotRequiredDrovrFeatures({
    loadBytes: () => ({ not: "bytes" }),
  });

  assert.equal(delegateCompatibilityIssue(
    card, port, validators, integrity,
  ), "required_feature_contract_integrity_failed");
  assert.equal(delegateCompatibilityIssue(
    card, port, validators, unavailable,
  ), "required_feature_contract_unavailable");
  assert.equal(delegateCompatibilityIssue(
    card, port, validators, malformed,
  ), "required_feature_contract_unavailable");
});

test("settled output becomes evidence only after independent validation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
  }, () => false);
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "active");
  assert.equal(projection.delegate_attempts[0].validated_output, null);
  assert.equal(projection.delegate_attempts[0].evidence, null);
  assert.equal(projection.quarantined_delegate_outputs[0]
    .quarantine_record.quarantine_reason, "independent_validation_failed");
  const validatorReceipt = projection.quarantined_delegate_outputs[0]
    .quarantine_record.validator_receipts[0];
  assert.equal(validatorReceipt.contract, DELEGATE_OUTPUT_VALIDATOR);
  assert.equal(validatorReceipt.accepted, false);
  assert.equal(validatorReceipt.evidence_safety_accepted, true);
  assert.ok(validatorReceipt.evidence_safety_receipt);
  assert.ok(validatorReceipt.evidence_safety_binding);
});

test("missing Drovr features block launch with typed compatibility", async (t) => {
  const description = await compatibleDescription();
  description.feature_advertisement.features[0].availability = "unavailable";
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = delegateRuntime(authority, {
    async discover() {
      assert.fail("incompatible delegation must not execute");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "incompatible_feature_advertisement");
  assert.equal(rejected.authority_watermark_domain, "host");
});

test("weakened required Drovr guarantees block launch", async (t) => {
  const description = await compatibleDescription();
  description.feature_advertisement.features[0].guarantees.pop();
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = delegateRuntime(authority, {});
  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.code, "incompatible_feature_advertisement");
});

test("incomplete DelegatedAgentPort blocks launch without degraded execution", async (t) => {
  const description = await compatibleDescription();
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      async discover() {},
      async dispatch() {},
      async wait() {},
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate: () => true,
        evidenceSafety: validateDelegateEvidenceSafety,
      },
    },
  });

  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "delegated_agent_port_unavailable");
});

test("missing or unordered delivered input is quarantined", async (t) => {
  const description = await compatibleDescription();
  for (const inputs of [[], [{
    sequence: 2,
    caller_key: "unexpected",
    payload_sha256: digestForTest("unexpected"),
    delivery: { status: "submitted" },
  }]]) {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${inputs.length}`),
    });
    t.after(() => authority.close());
    const runtime = delegateRuntime(authority, {
      async wait() {
        const projection = completedTurnProjection({
          callerKey: runtime.query({ run_id: launch.run_id })
            .delegate_attempts[0].caller_key,
          description,
        });
        projection.turn.inputs = inputs;
        return projection;
      },
    });
    const prepared = runtime.prepare(delegateCardProposal(description));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");
    const quarantined = runtime.query({ run_id: launch.run_id });
    assert.equal(quarantined.delegate_attempts[0].evidence, null);
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.quarantine_reason, "incompatible_ordered_inputs");
  }
});

test("a pre-approved independent fallback binds only the exact retry attempt", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-fallback"),
  });
  t.after(() => authority.close());
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };
  const attempts = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      attempts.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = attempts.at(-1);
      const description = attempts.length === 1 ? primary : fallback;
      const projection = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        output: attempts.length === 1 ? "rejected output" : "accepted output",
      });
      return projection;
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  const retry = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "delegate_execute",
  );
  runtime.command(retry);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(attempts[0].agent_id, "agent:delegate-review");
  assert.equal(attempts[1].agent_id, "agent:delegate-review-fallback");
  assert.deepEqual(projection.delegate_attempts.map(({ route_binding }) =>
    route_binding.description_digest), [
    primary.description_digest,
    fallback.description_digest,
  ]);
});

test("prepare rejects fallback that widens the accepted authority envelope", async () => {
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "workspace-write",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "fallback_capability_widening",
  );
});

test("prepare rejects fallback that is not independent of the failed route", async () => {
  const primary = await compatibleDescription();
  const fallback = await compatibleDescription();
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "fallback_not_independent",
  );
});

test("ordered steering caller identities are bound into settlement evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-steering"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "correctness",
      prompt: "prioritize correctness",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "tests",
      prompt: "then inspect test coverage",
    },
  ];
  proposal.graph.cards[1].inputs.steering = steering;
  const calls = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      calls.push(["dispatch", request]);
      return workingProjection(request);
    },
    async send(request) {
      calls.push(["send", request]);
      return workingProjection({
        agent_id: "agent:delegate-review",
        caller_key: calls[0][1].caller_key,
      });
    },
    async wait() {
      calls.push(["wait"]);
      return completedTurnProjection({
        callerKey: calls[0][1].caller_key,
        description,
        steering,
      });
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const attemptId = `${launch.run_id}:delegate-review:attempt:1`;
  assert.deepEqual(calls.map(([operation]) => operation), [
    "dispatch", "send", "send", "wait",
  ]);
  assert.deepEqual(calls.slice(1, 3).map(([, request]) => request.input_key), [
    `${attemptId}:steering:correctness`,
    `${attemptId}:steering:tests`,
  ]);
  const evidence = runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].evidence;
  assert.deepEqual(evidence.settlement_proof.ordered_inputs.map(
    ({ caller_key: callerKey }) => callerKey,
  ), [
    `${attemptId}:input:1`,
    `${attemptId}:steering:correctness`,
    `${attemptId}:steering:tests`,
  ]);
});

test("omitted or reordered steering input remains quarantined", async (t) => {
  const description = await compatibleDescription();
  const steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "correctness",
      prompt: "check correctness",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "tests",
      prompt: "check tests",
    },
  ];
  for (const mode of ["omitted", "reordered"]) {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${mode}`),
    });
    t.after(() => authority.close());
    const proposal = delegateCardProposal(description);
    proposal.graph.cards[1].inputs.steering = steering;
    let callerKey;
    const runtime = delegateRuntime(authority, {
      async dispatch(request) {
        callerKey = request.caller_key;
        return workingProjection(request);
      },
      async send() {
        return workingProjection({
          agent_id: "agent:delegate-review",
          caller_key: callerKey,
        });
      },
      async wait() {
        const projection = completedTurnProjection({
          callerKey,
          description,
          steering,
        });
        projection.turn.inputs = mode === "omitted"
          ? projection.turn.inputs.slice(0, -1)
          : [
            projection.turn.inputs[0],
            projection.turn.inputs[2],
            projection.turn.inputs[1],
          ];
        return projection;
      },
    });
    const prepared = runtime.prepare(proposal);
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");

    assert.equal(runtime.query({ run_id: launch.run_id })
      .quarantined_delegate_outputs[0].quarantine_record.quarantine_reason,
    "incompatible_ordered_inputs");
  }
});

test("prepare rejects ambiguous steering caller identities", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  proposal.graph.cards[1].inputs.steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "focus",
      prompt: "first",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "focus",
      prompt: "second",
    },
  ];

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_delegate_steering",
  );
});

test("declared cards reuse one exact managed agent until terminal retirement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-reuse"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  delete second.inputs.fallback;
  second.inputs.prompt = "follow up on the accepted review";
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  const dispatches = [];
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = dispatches.at(-1);
      return completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        prompt: request.prompt,
      });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  const afterFirst = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 0);
  assert.equal(afterFirst.delegate_attempts[0].evidence
    .terminal_disposition.durable_holder, `flow.run:${launch.run_id}`);
  runtime.command(afterFirst.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(dispatches.map(({ agent_id: agentId }) => agentId), [
    "agent:delegate-review",
    "agent:delegate-review",
  ]);
  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].attempt_id,
    `${launch.run_id}:delegate-followup:attempt:1`);
});

test("cancelling between managed cards retires the held agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  proposal.requested_authority.commands.push("cancel");
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      if (!callerKey) return absentDiscovery();
      return completedTurnProjection({ callerKey, description });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  const betweenCards = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 0);
  runtime.command(betweenCards.legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await until(() => retirements.length === 1);
  const cancelled = runtime.query({ run_id: launch.run_id });
  const cancellation = cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  );

  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancellation.receipt.provider_receipt
    .terminal_disposition.status, "retired");
  assert.equal(retirements[0].agent_id, "agent:delegate-review");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("cancelling a proven-absent held managed turn delegates cleanup", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-absent-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  proposal.requested_authority.commands.push("cancel");
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  )?.status === "succeeded");
  const cancelled = runtime.query({ run_id: launch.run_id });
  const disposition = cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).receipt.provider_receipt.terminal_disposition;

  assert.equal(retirements.length, 0);
  assert.equal(disposition.resource.type, "drovr_agent_unresolved");
  assert.deepEqual(disposition.planning_identity, {
    type: "flow_route",
    agent_id: first.route.agent_id,
  });
  assert.equal(cancelled.phase, "cancelled");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("declining between managed cards retires the held agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-declined-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const decisionCheckpoint = structuredClone(proposal.graph.cards[0]);
  decisionCheckpoint.id = "confirm-followup";
  decisionCheckpoint.dependencies = [first.id];
  decisionCheckpoint.inputs = { prompt: "Confirm the managed follow-up" };
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id, decisionCheckpoint.id];
  proposal.graph.cards.push(decisionCheckpoint, second);
  proposal.explicit_facts.limits.max_cards = 4;
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      if (!callerKey) return absentDiscovery();
      return completedTurnProjection({ callerKey, description });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === decisionCheckpoint.id).status ===
      "waiting_checkpoint");
  const awaitingDecision = runtime.query({ run_id: launch.run_id });
  runtime.command(awaitingDecision.legal_actions.find((action) =>
    action.type === "checkpoint_decision" &&
      action.checkpoint_id === decisionCheckpoint.id &&
      action.decision === "decline"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "declined");
  const declined = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].agent_id, "agent:delegate-review");
  assert.equal(retirements[0].attempt_id,
    `${launch.run_id}:delegate-review:attempt:1`);
  assert.deepEqual(declined.legal_actions, []);
});

test("terminal disposition retires an agent held by the declining run", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-disposed-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  const rejected = structuredClone(first);
  rejected.id = "delegate-rejected";
  rejected.dependencies = [proposal.graph.cards[0].id];
  rejected.inputs.prompt = "produce a rejected result";
  delete rejected.inputs.managed_agent;
  delete rejected.inputs.fallback;
  rejected.route.agent_id = "agent:delegate-rejected";
  proposal.graph.cards.push(second, rejected);
  proposal.explicit_facts.limits.max_cards = 4;
  const dispatches = [];
  const completed = new Map();
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      return completed.get(request.caller_key) ?? absentDiscovery();
    },
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = dispatches.at(-1);
      const projection = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        output: request.agent_id === "agent:delegate-rejected"
          ? "rejected output"
          : "accepted output",
        prompt: request.prompt,
        turnId: `turn:${request.agent_id}`,
      });
      completed.set(request.caller_key, projection);
      return projection;
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    (action) => action.type === "delegate_execute" &&
      action.card_id === first.id));
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    (action) => action.type === "delegate_execute" &&
      action.card_id === rejected.id));
  await until(() => runtime.query({ run_id: launch.run_id }).legal_actions.some(
    ({ type }) => type === "terminal_disposition"));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "terminal_disposition"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "declined");

  assert.equal(retirements.filter(
    ({ agent_id: agentId }) => agentId === "agent:delegate-review",
  ).length, 1);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).legal_actions, []);
});

test("prepare rejects ambient managed-agent reuse", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const second = structuredClone(proposal.graph.cards[1]);
  second.id = "delegate-followup";
  second.dependencies = ["delegate-review"];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "ambient_managed_agent_reuse",
  );
});

test("prepare rejects fallback inside an immutable managed-agent binding", async () => {
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  const first = proposal.graph.cards[1];
  first.inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  delete second.inputs.fallback;
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_managed_agent_binding",
  );
});

test("prepare rejects revision supersession inside a managed-agent binding", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "replace_managed_terminal",
  };
  const block = {
    schema: "flow.card-block/v1",
    id: "delegate-followup:revision",
    type: "plan_revision_required",
    trigger,
    required_capabilities: [],
    revision_template_ids: ["replace-managed-terminal"],
  };
  proposal.requested_authority.commands.push("revision_decision");
  proposal.explicit_facts.operation_contracts.push(
    "flow.adapter/card-block-observation/v1",
  );
  proposal.explicit_facts.validator_contracts.push(
    "flow.validator/card-block-observation/v1",
  );
  proposal.explicit_facts.block_observations.push(observeCardBlock({
    card_id: second.id,
    block,
  }));
  Object.assign(proposal.explicit_facts.limits, {
    max_revisions: 1,
    max_cards_per_revision: 0,
  });
  proposal.revision_templates = [{
    schema: "flow.plan-revision-template/v1",
    id: "replace-managed-terminal",
    trigger,
    limits: { max_applications: 1 },
    changes: {
      add_cards: [],
      add_edges: [],
      supersede_cards: [second.id],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  }];

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "managed_agent_binding_revision",
  );
});

test("prepare rejects missing delegate authority digests", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  delete proposal.graph.cards[1].inputs.description.comparison_keys
    .effective_authority;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_delegate_binding",
  );

  const fallbackPrimary = await compatibleDescription();
  const fallbackDescription = structuredClone(fallbackPrimary);
  fallbackDescription.launch.harness = "claude";
  const fallbackProposal = delegateCardProposal(fallbackPrimary, {
    maxAttempts: 2,
  });
  fallbackProposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallbackDescription,
    route: {
      agent_id: "agent:delegate-fallback",
      description_digest: fallbackDescription.description_digest,
      launch_comparison_key: fallbackDescription.comparison_keys.launch,
      configuration_watermark: fallbackDescription.watermark.content_sha256,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: fallbackPrimary.description_digest,
    },
  };
  delete fallbackDescription.comparison_keys.effective_authority;

  assert.throws(
    () => createFlowRuntime().prepare(fallbackProposal),
    (error) => error.reason === "invalid_delegate_fallback",
  );
});

test("a wrong discovered agent receives no steering input", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-wrong-steering"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  proposal.graph.cards[1].inputs.steering = [{
    schema: "flow.delegate-steering-input/v1",
    caller_id: "security",
    prompt: "inspect sensitive context",
  }];
  let sends = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      return workingProjection({
        agent_id: "agent:unexpected",
        caller_key: request.caller_key,
      });
    },
    async send() {
      sends += 1;
      assert.fail("steering must not be sent to a mismatched agent");
    },
  }, undefined, { resourcePort: nonWorkspaceResourcePort() });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects[0]
    .status === "reconciling");

  assert.equal(sends, 0);
});

test("an adopted turn validates its initial payload before steering", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-adopted-input"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  proposal.graph.cards[1].inputs.steering = [{
    schema: "flow.delegate-steering-input/v1",
    caller_id: "security",
    prompt: "inspect the exact security boundary",
  }];
  let sends = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      const projection = completedTurnProjection({
        callerKey: request.caller_key,
        description,
        prompt: "tampered initial payload",
      });
      projection.operation = "discover";
      projection.status = "working";
      projection.turn.status = "working";
      return projection;
    },
    async send() {
      sends += 1;
      return workingProjection({ agent_id: "agent:delegate-review" });
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects[0]
    .status === "reconciling");

  const effect = runtime.query({ run_id: launch.run_id }).effects[0];
  assert.equal(sends, 0);
  assert.equal(
    effect.last_observation.provider_observation.code,
    "incompatible_initial_input",
  );
});

test("an adopted exact recorded input proceeds to wait reconciliation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-adopted-recorded"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let waits = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      const projection = completedTurnProjection({
        callerKey: request.caller_key,
        description,
      });
      projection.operation = "discover";
      projection.status = "working";
      projection.turn.status = "working";
      delete projection.turn.result;
      delete projection.turn.settlement_proof;
      projection.turn.inputs[0].delivery.status = "recorded";
      return projection;
    },
    async wait(request) {
      waits += 1;
      assert.equal(request.turn_id, "turn:delegate-review");
      return stillWorkingProjection();
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects[0]
    .status === "reconciling");

  const effect = runtime.query({ run_id: launch.run_id }).effects[0];
  assert.equal(waits, 1);
  assert.equal(effect.last_observation.provider_observation.status,
    "still_running");
});

test("a result from the wrong routed agent remains quarantined", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-agent-mismatch"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait() {
      return completedTurnProjection({
        agentId: "agent:wrong",
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
  }, undefined, { resourcePort: nonWorkspaceResourcePort() });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  assert.equal(runtime.query({ run_id: launch.run_id })
    .quarantined_delegate_outputs[0].quarantine_record.quarantine_reason,
  "incompatible_dispatch_identity");
});

test("ambiguous dispatch remains reconciling without activating fallback", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-ambiguous"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let dispatches = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "reconciling",
        watermark: absentDiscovery().watermark,
        delegation: null,
        turn: null,
        legal_next_actions: ["reconcile_exact_dispatch"],
      };
    },
    async dispatch() {
      dispatches += 1;
      assert.fail("ambiguous discovery cannot authorize dispatch or fallback");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0]?.status === "reconciling");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(dispatches, 0);
  assert.equal(projection.delegate_attempts.length, 1);
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("cancellation closes the exact live delegate and quarantines its result", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cancel-delegate"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let callerKey;
  let finishWait;
  const cancellations = [];
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      if (callerKey === undefined) return absentDiscovery();
      return workingProjection({
        agent_id: "agent:delegate-review",
        caller_key: request.caller_key,
      });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return new Promise((resolve) => {
        finishWait = resolve;
      });
    },
    async cancel(request) {
      cancellations.push(request);
      const projection = completedTurnProjection({ callerKey, description });
      projection.status = "cancelled";
      projection.turn.status = "cancelled";
      delete projection.turn.result;
      finishWait(projection);
      return cancelledTurnProjection(request.turn_id);
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => typeof finishWait === "function");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "late_quarantined");

  const cancelled = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(cancellations, [{
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:delegate-review",
  }]);
  assert.equal(retirements.length, 1);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate",
  ).disposition, "quarantined");
  assert.equal(cancelled.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition.status, "retired");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("cancelled delegate settlement recovers after same-boot process loss", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cancel-recovery"),
  });
  const description = await compatibleDescription();
  let discoveries = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      discoveries += 1;
      if (discoveries === 1) return absentDiscovery();
      throw new Error("process exited after cancellation intent commit");
    },
    async wait() {
      return stillWorkingProjection();
    },
  });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "reconciling");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => discoveries === 2);
  authority.close();

  let callerKey;
  let cancelled = false;
  let retirements = 0;
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = delegateRuntime(recoveredAuthority, {
    async discover(request) {
      callerKey = request.caller_key;
      const projection = completedTurnProjection({ callerKey, description });
      projection.operation = "discover";
      projection.status = cancelled ? "cancelled" : "working";
      projection.turn.status = cancelled ? "cancelled" : "working";
      delete projection.turn.result;
      return projection;
    },
    async cancel(request) {
      cancelled = true;
      return cancelledTurnProjection(request.turn_id);
    },
    async retire(request) {
      retirements += 1;
      return completePortOperations().retire(request);
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "late_quarantined");

  const awaitingSettlement = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(awaitingSettlement.phase, "cancelled");
  assert.equal(awaitingSettlement.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).receipt.provider_receipt.terminal_disposition.durable_holder,
  "drovr.registry");
  assert.equal(retirements, 1);
  assert.deepEqual(awaitingSettlement.legal_actions, []);
});

test("cancelled settlement rejects a discovered turn from the wrong agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-wrong-cancel"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let discoveries = 0;
  let retirements = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      discoveries += 1;
      if (discoveries === 1) return absentDiscovery();
      const projection = completedTurnProjection({
        agentId: "agent:unexpected",
        callerKey: request.caller_key,
        description,
      });
      projection.operation = "discover";
      projection.status = "cancelled";
      projection.turn.status = "cancelled";
      delete projection.turn.result;
      return projection;
    },
    async wait() {
      return stillWorkingProjection();
    },
    async retire(request) {
      retirements += 1;
      return completePortOperations().retire(request);
    },
  }, undefined, { resourcePort: nonWorkspaceResourcePort() });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate",
  )?.status === "reconciling");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  )?.status === "reconciling");

  const cancelled = runtime.query({ run_id: launch.run_id });
  assert.equal(retirements, 0);
  assert.equal(cancelled.legal_actions.length, 1);
  assert.equal(cancelled.legal_actions[0].effect_id, cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).effect_id);
});

async function compatibleDescription() {
  return supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
}

function absentDiscovery() {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
}

function workingProjection(request) {
  const turn = {
    id: "turn:delegate-review",
    status: "working",
    ...(request?.caller_key === undefined ? {} : {
      caller: { dispatch_key: request.caller_key },
    }),
    ...(request?.description === undefined ? {} : {
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: request.description.comparison_keys.launch,
        configuration_watermark: request.description.watermark.content_sha256,
        description_digest: request.description.description_digest,
      },
    }),
    ...(request?.input_key === undefined || request?.payload_sha256 === undefined
      ? {}
      : {
          inputs: [{
            sequence: 1,
            caller_key: request.input_key,
            payload_sha256: request.payload_sha256,
            delivery: { status: "submitted" },
          }],
        }),
  };
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: absentDiscovery().watermark,
    delegation: {
      agent_id: request.agent_id,
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn,
    legal_next_actions: ["wait_bounded"],
  };
}

function stillWorkingProjection() {
  return {
    ...workingProjection({ agent_id: "agent:delegate-review" }),
    operation: "wait",
    status: "still_running",
  };
}

function cancelledTurnProjection(turnId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "cancel",
    status: "cancelled",
    watermark: {
      schema: "drovr.turn-authority-watermark/v1",
      authority: "drovr.registry",
      turn_id: turnId,
      record_sha256: digestForTest(turnId),
    },
    delegation: {
      agent_id: "agent:delegate-review",
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: { id: turnId, status: "cancelled" },
    legal_next_actions: [],
  };
}

function delegateRuntime(
  authority,
  portOverrides,
  validate = (output) => output === "accepted output",
  {
    evidenceSafety = validateDelegateEvidenceSafety,
    resourcePort = null,
  } = {},
) {
  return createFlowRuntime({
    runAuthority: authority,
    delegatedAgentResourcePort: resourcePort,
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      ...completePortOperations(),
      async discover() {
        return absentDiscovery();
      },
      async dispatch(request) {
        return workingProjection(request);
      },
      async wait() {
        throw new Error("wait was not configured");
      },
      ...portOverrides,
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate,
        evidenceSafety,
      },
    },
  });
}

function nonWorkspaceResourcePort() {
  return {
    contract: "flow.delegated-agent-resource-port/v1",
    async ensure() {
      assert.fail("non-workspace intents must not ensure a resource");
    },
    async retire() {
      assert.fail("non-workspace identity mismatch must not retire a resource");
    },
  };
}

function completePortOperations(calls = []) {
  return {
    async describe() {},
    async send() {},
    async observe() {},
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      calls.push(["retire", request]);
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: digestForTest(request.agent_id),
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: "task:delegate-review",
          group_id: "group:flow",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
  };
}

function digestForTest(value) {
  return `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function approveAndExecute(runtime, runId) {
  const waiting = runtime.query({ run_id: runId });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const ready = runtime.query({ run_id: runId });
  return runtime.command(ready.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}
