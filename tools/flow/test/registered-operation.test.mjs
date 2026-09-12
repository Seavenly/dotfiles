import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { observeCardBlock } from "../src/card-block-observation-adapter.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { decideLifecycle } from "../src/lifecycle-kernel.mjs";
import { compileDynamicPlan } from "../src/plan-compiler.mjs";
import { elapsedTimeBounds } from "../src/reboot-facts.mjs";
import { applyExecutionTimeObservation } from "../src/run-projection.mjs";
import { createDurableRunAuthority as createDurableAuthority } from
  "../src/run-authority.mjs";
import {
  normalizeEffectObservation,
  RETRY_DELAY_OBSERVATION_SCHEMA,
  validateEffectObservation,
} from "../src/operation-effects.mjs";
import {
  hasPositiveProviderEvidence,
  sanitizeProviderReceiptValue,
} from "../src/provider-receipt-sanitizers.mjs";
import {
  DELEGATE_RECEIPT_SCHEMA_FIELDS,
} from "../src/provider-receipt-policies/delegate-drovr.mjs";
import {
  REVIEW_RECEIPT_SCHEMA_FIELDS,
} from "../src/provider-receipt-policies/review-github.mjs";
import { foldRun } from "../src/run-projection.mjs";
import { confirmedLaunchRequest } from "../test-support/dynamic-checkpoint.mjs";
import {
  createFixedTimeDurableRunAuthority as createDurableRunAuthority,
} from "../test-support/fixed-host-identity.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";
import { executionTimeFacts } from "../test-support/time-facts.mjs";

test("domain receipt policies compose through the generic default-deny boundary", () => {
  assert.equal(
    DELEGATE_RECEIPT_SCHEMA_FIELDS.get("flow.delegate-evidence/v1")
      .has("route_binding"),
    true,
  );
  assert.equal(
    REVIEW_RECEIPT_SCHEMA_FIELDS.get("flow.github-review-receipt/v1")
      .has("provider_review"),
    true,
  );
  const sanitized = sanitizeProviderReceiptValue({
    schema: "flow.delegate-evidence/v1",
    attempt_id: "attempt:1",
    card_id: "delegate-review",
    turn_id: "turn:1",
    route_binding: {
      agent_id: "agent:review",
      description_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    validator_receipts: [{
      contract: "flow.validator/review/v1",
      accepted: true,
      opaque: "legacy-policy-secret",
    }],
    opaque: "unknown-policy-secret",
  });
  assert.deepEqual(sanitized.route_binding, {
    agent_id: "agent:review",
    description_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(sanitized.validator_receipts, [{
    contract: "flow.validator/review/v1",
    accepted: true,
  }]);
  assert.equal(Object.hasOwn(sanitized, "opaque"), false);
});

test("positive provider evidence rejects empty, non-positive, and non-finite values", () => {
  for (const value of [false, 0, -1, Number.NaN, Number.POSITIVE_INFINITY,
    "", [], {}]) {
    assert.equal(hasPositiveProviderEvidence(value), false, String(value));
  }
  for (const value of [true, 1, "accepted", ["accepted"], { record: "accepted" }]) {
    assert.equal(hasPositiveProviderEvidence(value), true, String(value));
  }
});

test("historical effect receipts use the composed domain policy during folding", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-policy-fold-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-policy-fold"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      return new Promise(() => {});
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const command = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions.find(
      ({ type }) => type === "operation_execute",
    ),
  );
  const intent = command.effect_intents[0];
  const run = {
    run_id: launch.run_id,
    prepared,
    events: [
      {
        type: "run_launched",
        run_ownership: {
          schema: "flow.run-ownership/v1",
          scope: "top_level",
          parent_run_id: null,
        },
      },
      { type: "effect_intent_recorded", intent },
      {
        type: "effect_receipt_recorded",
        effect_id: intent.effect_id,
        receipt: {
          schema: "flow.effect-receipt/v1",
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
          outcome: "succeeded",
          provider_receipt: {
            schema: "flow.delegate-evidence/v1",
            attempt_id: intent.attempt_id,
            card_id: intent.card_id,
            turn_id: "turn:legacy",
            route_binding: {
              agent_id: "agent:legacy",
              configuration_watermark: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            validator_receipts: [{
              contract: "flow.validator/legacy/v1",
              accepted: true,
            }],
            validated_output: "accepted",
            opaque: "legacy-history-secret",
          },
        },
      },
    ],
  };
  const folded = foldRun(run);
  const providerReceipt = folded.effects[0].receipt.provider_receipt;
  assert.equal(providerReceipt.schema, "flow.delegate-evidence/v1");
  assert.equal(providerReceipt.route_binding.agent_id, "agent:legacy");
  assert.equal(providerReceipt.validator_receipts[0].accepted, true);
  assert.equal(Object.hasOwn(providerReceipt, "opaque"), false);

  const redactedRun = structuredClone(run);
  redactedRun.events[2].receipt.provider_receipt = {
    schema: "flow.github-review-receipt/v1",
    api_key: "sk_live_historical-secret",
  };
  const redacted = foldRun(redactedRun);
  assert.equal(redacted.effects[0].receipt.outcome, "succeeded");
  assert.equal(redacted.effects[0].receipt.effect_id, intent.effect_id);
  assert.equal(redacted.effects[0].receipt.provider_receipt.schema,
    "flow.provider-receipt-redacted/v1");
  assert.equal(JSON.stringify(redacted).includes("historical-secret"), false);
  assert.deepEqual(redacted, foldRun(redactedRun));
});

test("receipt-shaped observations retain present and absent evidence across settlement", async (t) => {
  const runCase = async (presence) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-receipt-observation-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${presence}`),
    });
    t.after(() => authority.close());
    const runtime = operationRuntime(authority, {
      classification: "reconcilable",
      observe() {},
      invoke() {},
    });
    const proposal = registeredOperationProposal({
      classification: "reconcilable",
      checkpointBound: false,
    });
    proposal.requested_authority.commands.push("cancel");
    const prepared = runtime.prepare(proposal);
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    const execution = authority.query(launch.run_id).legal_actions.find(
      ({ type }) => type === "operation_execute",
    );
    const commandReceipt = authority.command(execution);
    const intent = commandReceipt.effect_intents[0];
    const providerObservation = presence === "present"
      ? {
          schema: "flow.github-review-receipt/v1",
          found: true,
          review_id: "review:exact",
          state: "pending",
          submitted: false,
        }
      : {
          schema: "flow.github-review-receipt/v1",
          found: false,
          complete: true,
          proof: "exact_absence",
        };
    if (presence === "absent") {
      const cancel = authority.query(launch.run_id).legal_actions.find(
        ({ type }) => type === "cancel",
      );
      assert.equal(authority.command(cancel).accepted, true);
    }
    const observation = {
      schema: "flow.effect-observation/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      presence,
      causation: presence === "present"
        ? { effect_id: intent.effect_id, idempotency_key: intent.idempotency_key }
        : null,
      provider_observation: providerObservation,
    };
    const recorded = await authority.recordEffectObservation(intent, observation);
    assert.equal(recorded.presence, presence);
    const receipt = await authority.invokeEffect(intent, {
      reconciliation: presence === "present" ? "adopt_present" : "settle_absent",
    });
    assert.equal(receipt.provider_receipt.schema,
      "flow.github-review-receipt/v1");
    assert.equal(receipt.provider_receipt.found, presence === "present");
    const first = authority.query(launch.run_id);
    const second = authority.query(launch.run_id);
    assert.deepEqual(second.effects[0].receipt, first.effects[0].receipt);
    assert.equal(first.effects[0].receipt.outcome,
      presence === "present" ? "succeeded" : "not_created");
  };
  await runCase("present");
  await runCase("absent");
});

test("a registered caller-idempotent operation executes from committed intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invokedIntent;
  let projectionAtInvocation;
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invokedIntent = intent;
          projectionAtInvocation = runtime.query({ run_id: intent.run_id });
          return operationReceipt(intent);
        },
      },
    },
  });
  const proposal = registeredOperationProposal();
  proposal.explicit_facts.resource_claims.push({
    kind: "test-record",
    id: "unrelated",
  });
  proposal.explicit_facts.limits.max_resources = 2;
  const prepared = runtime.prepare(proposal);
  assert.equal(
    prepared.confirmation.execution_time_accounting.schema,
    "flow.execution-time-accounting/v1",
  );
  assert.deepEqual(
    prepared.confirmation.execution_time_accounting.wall_elapsed,
    {
      includes: [
        "accepted_baseline_to_current_observation",
        "human_checkpoint_wait",
        "passive_retained_wait",
      ],
      same_boot_source: "suspend_excluding_monotonic",
      cross_boot_source: "wall_clock",
    },
  );
  assert.deepEqual(
    prepared.confirmation.execution_time_accounting.active_execution,
    {
      definition: "sum_of_admitted_invocation_intervals",
      excludes: ["human_checkpoint_wait", "passive_retained_wait"],
    },
  );
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(waiting.cards, [
    { id: "confirm-plan", executor_kind: "checkpoint", status: "waiting_checkpoint" },
    { id: "record-outcome", executor_kind: "operation", status: "pending" },
  ]);
  const commandReceipt = runtime.command(
    waiting.legal_actions.find(({ decision }) => decision === "approve"),
  );
  assert.equal(commandReceipt.accepted, true);
  assert.equal(commandReceipt.effect_intents.length, 1);
  assert.equal(runtime.query({ run_id: launch.run_id }).watermark,
    commandReceipt.authority_watermark);

  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(invokedIntent.effect_id, commandReceipt.effect_intents[0].effect_id);
  assert.equal(projectionAtInvocation.effects[0].invocation_started, true);
  assert.equal(projectionAtInvocation.effects[0].status, "unresolved");
  assert.equal(projectionAtInvocation.phase, "active");
  assert.equal(invokedIntent.idempotency_key,
    commandReceipt.effect_intents[0].idempotency_key);
  assert.equal(invokedIntent.attempt_id, `${launch.run_id}:record-outcome:attempt:1`);
  assert.deepEqual(invokedIntent.route_binding, {
    adapter: "conformance-recorder",
  });
  assert.deepEqual(invokedIntent.resource_claims, [{
    kind: "test-record",
    id: "outcome",
  }]);
  assert.equal(completed.phase, "succeeded");
  assert.equal(completed.cards[1].status, "completed");
  assert.equal(completed.effects[0].status, "succeeded");
  assert.deepEqual(completed.legal_actions, []);
});

test("a throwing registered operation publishes a durable sanitized execution observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invokedIntent;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invokedIntent = intent;
      const error = new Error(
        "provider secret=super-secret /private/incident/path",
      );
      error.code = "provider_unavailable";
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  const commandReceipt = runtime.command(execution);

  await until(() => invokedIntent !== undefined);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const observation = projection.effects[0].last_observation;
  const diagnostic = observation.provider_observation;

  assert.equal(observation.presence, "indeterminate");
  assert.equal(diagnostic.schema,
    "flow.registered-operation-execution-observation/v1");
  assert.equal(diagnostic.status, "provider_unavailable");
  assert.deepEqual({
    run_id: diagnostic.run_id,
    card_id: diagnostic.card_id,
    attempt_id: diagnostic.attempt_id,
    effect_id: diagnostic.effect_id,
    idempotency_key: diagnostic.idempotency_key,
  }, {
    run_id: launch.run_id,
    card_id: "record-outcome",
    attempt_id: invokedIntent.attempt_id,
    effect_id: commandReceipt.effect_intents[0].effect_id,
    idempotency_key: commandReceipt.effect_intents[0].idempotency_key,
  });
  assert.equal(diagnostic.diagnostic.redacted, true);
  assert.equal(diagnostic.diagnostic.code, "provider_unavailable");
  assert.equal(JSON.stringify(projection).includes("super-secret"), false);
  assert.equal(JSON.stringify(projection).includes("/private/incident/path"), false);
});

test("a frozen registered-operation error still publishes its sanitized observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error(
        "frozen secret=super-secret /private/frozen/path",
      );
      error.code = "provider_unavailable";
      Object.freeze(error);
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.diagnostic.code, "provider_unavailable");
  assert.equal(JSON.stringify(projection).includes("super-secret"), false);
  assert.equal(JSON.stringify(projection).includes("/private/frozen/path"), false);
});

test("an unknown registered-operation error code is reduced to operation failure", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("unknown-code secret=canary-secret");
      error.code = "canary_secret_lowercase_token";
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "operation_failure");
  assert.equal(diagnostic.diagnostic.code, "operation_failure");
  assert.equal(JSON.stringify(projection).includes("canary_secret_lowercase_token"), false);
  assert.equal(JSON.stringify(projection).includes("canary-secret"), false);
});

test("an adapter-unavailable failure is not reported as provider outage", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("adapter secret /private/adapter-path");
      error.code = "adapter_unavailable";
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "operation_failure");
  assert.equal(diagnostic.diagnostic.code, "operation_failure");
  assert.equal(JSON.stringify(projection).includes("provider_unavailable"), false);
  assert.equal(JSON.stringify(projection).includes("adapter secret"), false);
  assert.equal(JSON.stringify(projection).includes("/private/adapter-path"), false);
});

test("registered operation observations are sanitized before public projection", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocations = 0;
  const runtime = operationRuntime(authority, {
    classification: "reconcilable",
    invoke(intent) {
      invocations += 1;
      if (invocations === 1) throw new Error("first attempt failed");
      return operationReceipt(intent);
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: {
          found: false,
          secret: "provider-secret",
          path: "/private/provider-path",
        },
      };
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    classification: "reconcilable",
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation?.provider_observation?.status ===
    "uncertain_external_outcome");

  const recovery = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "recovery",
  );
  runtime.command(recovery);
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const projection = runtime.query({ run_id: launch.run_id });
  const providerObservation = projection.effects[0].last_observation
    .provider_observation;

  assert.equal(providerObservation.found, false);
  assert.equal(Object.hasOwn(providerObservation, "secret"), false);
  assert.equal(Object.hasOwn(providerObservation, "path"), false);
});

test("a provider sanitizer cannot overwrite the typed execution observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("provider detail is not public");
      error.provider_observation = { secret: "provider-secret" };
      throw error;
    },
    sanitizeProviderObservation() {
      return {
        schema: "flow.attacker-observation/v1",
        run_id: "attacker-run",
        card_id: "attacker-card",
        attempt_id: "attacker-attempt",
        effect_id: "attacker-effect",
        idempotency_key: "attacker-key",
        status: "succeeded",
        diagnostic: { code: "accepted", redacted: false },
        secret: "provider-secret",
      };
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);

  const effect = runtime.query({ run_id: launch.run_id }).effects[0];
  const observation = effect.last_observation.provider_observation;
  assert.equal(observation.schema,
    "flow.registered-operation-execution-observation/v1");
  assert.equal(observation.run_id, launch.run_id);
  assert.equal(observation.card_id, "record-outcome");
  assert.match(observation.attempt_id, /:record-outcome:attempt:1$/u);
  assert.equal(observation.effect_id, effect.effect_id);
  assert.equal(observation.idempotency_key, effect.idempotency_key);
  assert.equal(observation.status, "uncertain_external_outcome");
  assert.equal(observation.diagnostic.code, "uncertain_external_outcome");
  assert.equal(observation.diagnostic.redacted, true);
  assert.equal(Object.hasOwn(observation.provider_detail, "secret"), false);
  assert.equal(JSON.stringify(observation).includes("attacker-run"), false);
});

test("the authority observation seam sanitizes raw provider details", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invokedIntent;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invokedIntent = intent;
      return new Promise(() => {});
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => invokedIntent !== undefined);

  await authority.recordEffectObservation(invokedIntent, {
    schema: "flow.effect-observation/v1",
    effect_id: invokedIntent.effect_id,
    idempotency_key: invokedIntent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: {
      schema: "flow.provider-observation/v1",
      status: "operation_failure",
      secret: "authority-secret",
      path: "/private/authority-path",
      stack: "Error: authority-secret",
    },
  });

  const projection = runtime.query({ run_id: launch.run_id });
  const providerObservation = projection.effects[0].last_observation
    .provider_observation;
  assert.equal(providerObservation.schema, "flow.provider-observation/v1");
  assert.equal(providerObservation.status, "operation_failure");
  assert.equal(JSON.stringify(projection).includes("authority-secret"), false);
  assert.equal(JSON.stringify(projection).includes("/private/authority-path"), false);
  assert.equal(JSON.stringify(projection).includes("Error: authority-secret"), false);
});

test("successful registered receipts retain their versioned shape without provider secrets", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return operationReceipt(intent, {
        schema: "flow.provider-receipt/v1",
        record: "accepted",
        detail: "secret=receipt-secret",
        secret: "receipt-secret",
        path: "/private/receipt-path",
        stack: "Error: receipt-secret",
      });
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  const receipt = runtime.query({ run_id: launch.run_id }).effects[0].receipt;
  assert.equal(receipt.provider_receipt.schema,
    "flow.provider-receipt/v1");
  assert.equal(receipt.provider_receipt.record, "accepted");
  assert.equal(Object.hasOwn(receipt.provider_receipt, "secret"), false);
  assert.equal(Object.hasOwn(receipt.provider_receipt, "path"), false);
  assert.equal(Object.hasOwn(receipt.provider_receipt, "stack"), false);
  assert.equal(JSON.stringify(receipt).includes("secret=receipt-secret"), false);
});

test("registered receipt envelopes discard arbitrary and nested secret material", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return {
        schema: "flow.effect-receipt/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        outcome: "succeeded",
        api_key: "top-api-key-canary",
        authorization: "Bearer top-authorization-canary",
        cookie: "top-cookie-canary",
        private_material: "top-private-canary",
        innocuous: "top-secret-material-canary",
        provider_receipt: {
          schema: "flow.provider-receipt/v1",
          record: "accepted",
          api_key: "nested-api-key-canary",
          authorization: "Bearer nested-authorization-canary",
          cookie: "nested-cookie-canary",
          private_material: "nested-private-canary",
          innocuous: "nested-secret-material-canary",
          detail: "token=sk_live_nested_detail_canary",
          metadata: {
            value: "sk_live_receipt_opaque_canary",
            innocuous: "nested-opaque-material-canary",
          },
        },
      };
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  const serialized = JSON.stringify(runtime.query({ run_id: launch.run_id }));
  for (const canary of [
    "top-api-key-canary",
    "top-authorization-canary",
    "top-cookie-canary",
    "top-private-canary",
    "top-secret-material-canary",
    "nested-api-key-canary",
    "nested-authorization-canary",
    "nested-cookie-canary",
    "nested-private-canary",
    "nested-secret-material-canary",
    "token=sk_live_nested_detail_canary",
    "sk_live_receipt_opaque_canary",
    "nested-opaque-material-canary",
  ]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
  const receipt = runtime.query({ run_id: launch.run_id }).effects[0].receipt;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "effect_id",
    "idempotency_key",
    "outcome",
    "provider_receipt",
    "schema",
  ]);
  assert.deepEqual(receipt.provider_receipt, {
    schema: "flow.provider-receipt/v1",
    record: "accepted",
  });
});

test("registered success requires non-empty positive provider evidence", async (t) => {
  for (const [label, providerReceipt] of [
    ["null", null],
    ["empty", {}],
    ["unknown-only", { opaque: "provider-secret-canary" }],
    ["array emptied by sanitization", ["sk_live_array_receipt_canary"]],
  ]) {
    await t.test(label, async (testContext) => {
      const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
      testContext.after(() => rm(authorityDirectory, { recursive: true, force: true }));
      const authority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${label}`),
      });
      testContext.after(() => authority.close());
      const runtime = operationRuntime(authority, {
        classification: "caller_idempotent",
        invoke(intent) {
          return operationReceipt(intent, providerReceipt);
        },
      });
      const prepared = runtime.prepare(registeredOperationProposal({
        checkpointBound: false,
      }));
      const launch = runtime.launch(confirmedLaunchRequest(prepared));
      runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
        ({ type }) => type === "operation_execute",
      ));
      await until(() => {
        const current = runtime.query({ run_id: launch.run_id });
        return current.phase === "succeeded" ||
          current.effects[0].last_observation !== null;
      });
      const projection = runtime.query({ run_id: launch.run_id });
      const diagnostic = projection.effects[0].last_observation
        .provider_observation;

      assert.equal(projection.effects[0].receipt, null);
      assert.equal(projection.effects[0].status, "unresolved");
      assert.equal(diagnostic.status, "invalid_output");
      assert.ok([
        "invalid_effect_receipt",
        "invalid_provider_receipt",
      ].includes(diagnostic.diagnostic.code));
      assert.equal(JSON.stringify(projection).includes("provider-secret-canary"), false);
    });
  }
});

test("central receipt sanitization constrains custom provider hooks", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-custom-sanitizer"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    sanitizeProviderReceipt() {
      return {
        schema: "flow.provider-receipt/v1",
        record: "accepted",
        opaque_custom_key: "opaque-custom-canary",
        metadata: { value: "sk_live_custom_receipt_canary" },
      };
    },
    invoke(intent) {
      return operationReceipt(intent, { record: "accepted" });
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const projection = runtime.query({ run_id: launch.run_id });
  const serialized = JSON.stringify(projection);

  assert.equal(serialized.includes("opaque-custom-canary"), false);
  assert.equal(serialized.includes("sk_live_custom_receipt_canary"), false);
  assert.deepEqual(projection.effects[0].receipt.provider_receipt, {
    schema: "flow.provider-receipt/v1",
    record: "accepted",
  });
});

test("RunAuthority receipt admission drops untrusted envelope fields", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let intercepted;
  const runtimeAuthority = {
    ...authority,
    invokeEffect: async (intent, adapter) => {
      intercepted = { intent, adapter };
    },
  };
  const runtime = operationRuntime(runtimeAuthority, {
    classification: "caller_idempotent",
    invoke() {
      throw new Error("intercepted dispatch should not invoke registration");
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const watcher = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  await watcher.next();
  const intentUpdate = watcher.next();
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await intentUpdate;
  await until(() => intercepted !== undefined);
  const receiptUpdate = watcher.next();
  await authority.invokeEffect(intercepted.intent, {
    async invoke(intent) {
      return {
        schema: "flow.effect-receipt/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        outcome: "succeeded",
        unknown: "direct-unknown-canary",
        provider_receipt: {
          schema: "flow.provider-receipt/v1",
          record: "accepted",
          metadata: {
            value: "sk_live_direct_opaque_canary",
            innocuous: "direct-opaque-material-canary",
          },
          authorization: "Bearer direct-authorization-canary",
        },
      };
    },
  });
  const watched = (await withTimeout(receiptUpdate, 1_000)).value;
  await watcher.return();
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const serialized = JSON.stringify(runtime.query({ run_id: launch.run_id }));
  assert.equal(watched.phase, "succeeded");
  assert.equal(JSON.stringify(watched).includes("direct-unknown-canary"), false);
  assert.equal(JSON.stringify(watched).includes("direct-secret-material-canary"), false);
  assert.equal(JSON.stringify(watched).includes("sk_live_direct_opaque_canary"), false);
  assert.equal(JSON.stringify(watched).includes("direct-opaque-material-canary"), false);
  assert.equal(JSON.stringify(watched).includes("direct-authorization-canary"), false);
  assert.equal(serialized.includes("direct-unknown-canary"), false);
  assert.equal(serialized.includes("direct-secret-material-canary"), false);
  assert.equal(serialized.includes("sk_live_direct_opaque_canary"), false);
  assert.equal(serialized.includes("direct-opaque-material-canary"), false);
  assert.equal(serialized.includes("direct-authorization-canary"), false);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).effects[0].receipt
    .provider_receipt, {
      schema: "flow.provider-receipt/v1",
      record: "accepted",
    });
});

test("an invalid registered-operation output publishes a typed invalid-output observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      return {
        schema: "flow.invalid-effect-receipt/v1",
        provider_receipt: { secret: "invalid-output-secret" },
      };
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "invalid_output");
  assert.equal(diagnostic.diagnostic.code, "invalid_effect_receipt");
  assert.equal(JSON.stringify(projection).includes("invalid-output-secret"), false);
  assert.equal(projection.effects[0].status, "unresolved");
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("an untyped registered-operation failure publishes a redacted operation-failure observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      throw new Error("adapter stack /secret/operation-input");
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "operation_failure");
  assert.equal(diagnostic.diagnostic.code, "operation_failure");
  assert.equal(diagnostic.diagnostic.redacted, true);
  assert.equal(JSON.stringify(projection).includes("adapter stack"), false);
  assert.equal(JSON.stringify(projection).includes("/secret/operation-input"), false);
  assert.equal(projection.effects[0].status, "unresolved");
});

test("an untyped reconcilable failure is uncertain after dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke() {
      throw new Error("post-dispatch result was lost secret=uncertain-secret");
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    classification: "reconcilable",
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;
  assert.equal(diagnostic.status, "uncertain_external_outcome");
  assert.equal(diagnostic.diagnostic.code, "uncertain_external_outcome");
  assert.equal(projection.effects[0].status, "reconciling");
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  assert.equal(JSON.stringify(projection).includes("uncertain-secret"), false);
});

test("a still-running registered operation remains unresolved with an actionable observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("still running in /secret/turn");
      error.execution_status = "still_running";
      throw error;
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const projection = runtime.query({ run_id: launch.run_id });
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "still_running");
  assert.equal(diagnostic.diagnostic.code, "still_running");
  assert.equal(JSON.stringify(projection).includes("still running in"), false);
  assert.equal(JSON.stringify(projection).includes("/secret/turn"), false);
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("an uncertain external operation outcome never masquerades as absence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke() {
      const error = new Error("receipt lost with secret=uncertain-secret");
      error.provider_observation = {
        schema: "flow.provider-observation/v1",
        provider_id: "remote-provider",
        secret: "uncertain-secret",
      };
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));

  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation?.provider_observation?.status ===
      "uncertain_external_outcome");
  const projection = runtime.query({ run_id: launch.run_id });
  const effect = projection.effects[0];
  const diagnostic = effect.last_observation.provider_observation;

  assert.equal(effect.status, "reconciling");
  assert.equal(effect.last_observation.presence, "indeterminate");
  assert.equal(diagnostic.diagnostic.code, "uncertain_external_outcome");
  assert.equal(JSON.stringify(projection).includes("uncertain-secret"), false);
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("watch publishes a sanitized registered-operation execution observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("watch-secret /private/watch/path");
      error.code = "provider_unavailable";
      throw error;
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const watcher = runtime.watch({ run_id: launch.run_id })
    [Symbol.asyncIterator]();
  const initial = (await watcher.next()).value;
  const execution = initial.legal_actions.find(({ type }) =>
    type === "operation_execute");
  const intentUpdate = watcher.next();

  const commandReceipt = runtime.command(execution);
  const committed = (await withTimeout(intentUpdate, 1_000)).value;
  assert.equal(committed.effects[0].last_observation, null);
  const observationUpdate = await withTimeout(watcher.next(), 1_000);
  const projection = observationUpdate.value;
  const diagnostic = projection.effects[0].last_observation.provider_observation;

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.effect_id, commandReceipt.effect_intents[0].effect_id);
  assert.equal(diagnostic.attempt_id,
    commandReceipt.effect_intents[0].attempt_id);
  assert.equal(JSON.stringify(projection).includes("watch-secret"), false);
  assert.equal(JSON.stringify(projection).includes("/private/watch/path"), false);
  await watcher.return();
});

test("same-boot replacement retains the execution observation while recovering the exact intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let firstIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      firstIntent = intent;
      const error = new Error("first-process-secret /private/first/path");
      error.code = "provider_unavailable";
      throw error;
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "operation_execute"));
  await until(() => firstRuntime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const failed = firstRuntime.query({ run_id: launch.run_id });
  const failedDiagnostic = failed.effects[0].last_observation
    .provider_observation;
  assert.equal(failedDiagnostic.status, "provider_unavailable");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  let recoveredIntent;
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      recoveredIntent = intent;
      return operationReceipt(intent, { record: "recovered" });
    },
  });

  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const completed = recoveredRuntime.query({ run_id: launch.run_id });
  const diagnostic = completed.effects[0].last_observation
    .provider_observation;
  assert.equal(recoveredIntent.effect_id, firstIntent.effect_id);
  assert.equal(recoveredIntent.idempotency_key, firstIntent.idempotency_key);
  assert.equal(recoveredIntent.attempt_id, firstIntent.attempt_id);
  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.run_id, launch.run_id);
  assert.equal(diagnostic.card_id, "record-outcome");
  assert.equal(diagnostic.effect_id, firstIntent.effect_id);
  assert.equal(JSON.stringify(completed).includes("first-process-secret"), false);
  assert.equal(JSON.stringify(completed).includes("/private/first/path"), false);
});

test("repeated recovery cannot exceed the durable operation attempt cap", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("retryable provider outage");
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => invocationCount === 1);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const firstFailure = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(firstFailure.effects[0].retry, {
    schema: "flow.operation-retry-projection/v1",
    max_attempts: 2,
    consumed_attempts: 1,
    remaining_attempts: 1,
    status: "ready",
    not_before: null,
  });

  runtime.command(firstFailure.legal_actions.find(({ type }) =>
    type === "recovery"));
  await until(() => invocationCount === 2);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.consumed_attempts === 2);
  const exhausted = runtime.query({ run_id: launch.run_id });

  assert.equal(exhausted.effects[0].retry.status, "exhausted");
  assert.equal(exhausted.effects[0].retry.remaining_attempts, 0);
  assert.deepEqual(exhausted.legal_actions, []);
  assert.equal(exhausted.phase, "active");
  assert.equal(exhausted.resource_dispositions[0].disposition, "held");
  assert.equal(invocationCount, 2);
});

test("a confirmed single-attempt operation cap is never widened", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("single-attempt provider outage");
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 1));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => invocationCount === 1);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "exhausted");

  const exhausted = runtime.query({ run_id: launch.run_id });
  assert.equal(exhausted.effects[0].retry.max_attempts, 1);
  assert.equal(exhausted.effects[0].retry.consumed_attempts, 1);
  assert.equal(exhausted.effects[0].retry.remaining_attempts, 0);
  assert.deepEqual(exhausted.legal_actions, []);
  assert.equal(exhausted.resource_dispositions[0].disposition, "held");
  assert.equal(invocationCount, 1);
});

test("same-boot replacement preserves exhausted operation accounting", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => firstAuthority.close());
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("owner restart provider outage");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "operation_execute"));
  await until(() => invocationCount === 1);
  await until(() => firstRuntime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("second owner restart provider outage");
    },
  });

  await until(() => invocationCount === 2);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].retry?.consumed_attempts === 2);
  const exhausted = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(exhausted.effects[0].retry.status, "exhausted");
  assert.equal(exhausted.legal_actions.some(({ type }) => type === "recovery"), false);
  assert.equal(invocationCount, 2);
});

test("a bounded provider retry delay withholds recovery until injected time is due", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let nowMs = 1_000;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    retryTimeAdapter: {
      observe() {
        return {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: nowMs,
          uncertainty_ms: 0,
          clock_source_id: "wall:test-retry",
        };
      },
    },
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  let operationIntent;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      const error = new Error("provider outage with bounded delay");
      error.code = "provider_unavailable";
      error.retry_after_ms = 500;
      if (invocationCount === 1) throw error;
      operationIntent = intent;
      return operationReceipt(intent);
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  runtime.command(execution);
  await until(() => invocationCount === 1);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "waiting");
  const waiting = runtime.query({ run_id: launch.run_id });
  assert.equal(waiting.effects[0].retry.not_before.value_ms, 1_500);
  assert.equal(waiting.legal_actions.some(({ type }) => type === "recovery"), false);

  nowMs = 1_499;
  assert.equal(runtime.query({ run_id: launch.run_id }).legal_actions.some(
    ({ type }) => type === "recovery",
  ), false);
  nowMs = 1_500;
  const due = runtime.query({ run_id: launch.run_id });
  assert.equal(due.effects[0].retry.status, "ready");
  runtime.command(due.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 2);
  assert.equal(operationIntent.effect_id, waiting.effects[0].effect_id);
});

test("operator recovery rebinds a transient unavailable retry delay", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let retryNow = null;
  let invocationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-retry-rebind"),
    retryTimeAdapter: {
      observe() {
        return retryNow === null ? null : {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: retryNow,
          uncertainty_ms: 0,
          clock_source_id: "wall:retry-rebind",
        };
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      if (invocationCount === 1) {
        const error = new Error("retry clock temporarily unavailable");
        error.code = "provider_unavailable";
        error.retry_after_ms = 500;
        throw error;
      }
      return operationReceipt(intent, { record: "rebound" });
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "blocked");
  const blocked = runtime.query({ run_id: launch.run_id });
  assert.equal(blocked.effects[0].retry.reason, "retry_time_unavailable");
  assert.equal(blocked.effects[0].retry.retry_after_ms, 500);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));

  retryNow = 1_000;
  const rebind = runtime.query({ run_id: launch.run_id });
  runtime.command(rebind.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "waiting");
  const waiting = runtime.query({ run_id: launch.run_id });
  assert.equal(waiting.effects[0].retry.not_before.value_ms, 1_500);
  assert.equal(waiting.effects[0].retry.not_before.clock_source_id,
    "wall:retry-rebind");
  assert.equal(invocationCount, 1);
  retryNow = 1_499;
  assert.equal(runtime.query({ run_id: launch.run_id }).legal_actions.some(
    ({ type }) => type === "recovery"), false);
  retryNow = 1_500;
  const due = runtime.query({ run_id: launch.run_id });
  runtime.command(due.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 2);
});

test("operator recovery rebinds a repeat-safe retry across clock sources", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let clockSourceId = "wall:retry-a";
  let nowMs = 1_000;
  let invocationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cross-clock"),
    retryTimeAdapter: {
      observe() {
        return {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: nowMs,
          uncertainty_ms: 0,
          clock_source_id: clockSourceId,
        };
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      if (invocationCount === 1) {
        const error = new Error("cross-clock retry");
        error.code = "provider_unavailable";
        error.retry_after_ms = 500;
        throw error;
      }
      return operationReceipt(intent, { record: "cross-clock-rebound" });
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "waiting");
  clockSourceId = "wall:retry-b";
  const rebound = runtime.query({ run_id: launch.run_id });
  assert.ok(rebound.legal_actions.some(({ type }) => type === "recovery"));
  runtime.command(rebound.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.not_before?.clock_source_id === "wall:retry-b");
  assert.equal(invocationCount, 1);
  nowMs = 1_500;
  const due = runtime.query({ run_id: launch.run_id });
  runtime.command(due.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 2);
});

test("an invalid provider retry delay blocks recovery without exposing the delay", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    retryTimeAdapter: {
      observe() {
        return {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: 1_000,
          uncertainty_ms: 0,
          clock_source_id: "wall:test-retry",
        };
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke() {
      const error = new Error("invalid retry delay secret=delay-secret");
      error.code = "provider_unavailable";
      error.retry_after_ms = Number.MAX_SAFE_INTEGER;
      throw error;
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.equal(blocked.effects[0].retry.status, "blocked");
  assert.equal(blocked.effects[0].retry.reason, "invalid_retry_delay");
  assert.equal(blocked.legal_actions.some(({ type }) => type === "recovery"), false);
  assert.equal(JSON.stringify(blocked).includes("delay-secret"), false);
  assert.equal(JSON.stringify(blocked).includes(String(Number.MAX_SAFE_INTEGER)), false);
});

test("a bounded observation retry delay withholds reconcilable reinvocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let nowMs = 1_000;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    retryTimeAdapter: {
      observe() {
        return {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: nowMs,
          uncertainty_ms: 0,
          clock_source_id: "wall:test-retry",
        };
      },
    },
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  let observationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "reconcilable",
    invoke(intent) {
      invocationCount += 1;
      if (invocationCount === 1) {
        const error = new Error("initial provider outage");
        error.code = "provider_unavailable";
        throw error;
      }
      return operationReceipt(intent);
    },
    observe(intent) {
      observationCount += 1;
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: {
          schema: "flow.provider-observation/v1",
          status: "provider_unavailable",
          ...(observationCount === 1 ? {
            retry: {
              schema: RETRY_DELAY_OBSERVATION_SCHEMA,
              status: "bounded",
              delay_ms: 500,
            },
          } : {}),
        },
      };
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    classification: "reconcilable",
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => invocationCount === 1);
  const recovery = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "recovery",
  );
  runtime.command(recovery);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "waiting");
  assert.equal(invocationCount, 1);
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0]
    .retry.not_before.value_ms, 1_500);
  assert.equal(runtime.query({ run_id: launch.run_id }).legal_actions.some(
    ({ type }) => type === "recovery",
  ), false);

  nowMs = 1_500;
  const due = runtime.query({ run_id: launch.run_id });
  runtime.command(due.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 2);
  assert.equal(observationCount, 2);
});

test("a cross-clock retry delay is rebound by fresh reconciliation evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let clockSourceId = "wall:retry-a";
  let invocationCount = 0;
  let observationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    retryTimeAdapter: {
      observe() {
        return {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: 1_000,
          uncertainty_ms: 0,
          clock_source_id: clockSourceId,
        };
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "reconcilable",
    invoke(intent) {
      invocationCount += 1;
      if (invocationCount === 1) {
        const error = new Error("initial provider outage");
        error.code = "provider_unavailable";
        error.retry_after_ms = 500;
        throw error;
      }
      return operationReceipt(intent, { record: "rebound" });
    },
    observe(intent) {
      observationCount += 1;
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: {
          schema: "flow.provider-observation/v1",
          found: false,
        },
      };
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({
    classification: "reconcilable",
    checkpointBound: false,
  }, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].retry?.status === "waiting");
  clockSourceId = "wall:retry-b";
  const stale = runtime.query({ run_id: launch.run_id });
  assert.equal(stale.legal_actions.some(({ type }) => type === "recovery"), true);
  runtime.command(stale.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 2);
  assert.equal(observationCount, 1);
});

test("same-boot elapsed expiry fences a stale operation command before dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let wallValueMs = 1_700_000_000_000;
  let invocationCount = 0;
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
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 1;
  const prepared = runtime.prepare(proposal);
  wallValueMs += 2_000;
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(
    runtime.query({ run_id: launch.run_id }).execution_time.wall_elapsed_seconds.lower,
    0,
  );
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  wallValueMs += 2_000;
  const rejection = runtime.command(execution);

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "execution_deadline_exhausted");
  assert.equal(invocationCount, 0);
  const expired = runtime.query({ run_id: launch.run_id });
  assert.equal(expired.execution_time.status, "exhausted");
  assert.equal(expired.execution_time.reason, "wall_deadline_exhausted");
  assert.equal(expired.legal_actions.some(({ type }) =>
    type === "operation_execute"), false);
  assert.equal(expired.legal_actions.every(({ type }) =>
    ["cancel", "recovery", "terminal_disposition"].includes(type)), true);
});

test("final admission fence does not consume an attempt after time expires", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let expired = false;
  let timeCalls = 0;
  let invocationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    timeObservationAdapter: {
      observe() {
        timeCalls += 1;
        if (timeCalls >= 12) expired = true;
        return executionTimeFacts({
          wallValueMs: expired ? 1_700_000_002_000 : 1_700_000_000_000,
          bootId: "boot-a",
        });
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 1;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  runtime.command(execution);
  await until(() => runtime.query({ run_id: launch.run_id })
    .execution_time.status === "exhausted");
  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 0);
  assert.equal(projection.effects[0].invocation_started, false);
  assert.equal(projection.effects[0].receipt, null);
  assert.equal(projection.attempts[0].status, "active");
});

test("before-effect time invalidation fences before invocation start", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let invalidated = false;
  let invocationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-before-effect"),
    beforeEffect() {
      invalidated = true;
    },
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({
          wallValueMs: invalidated
            ? 1_700_000_002_000
            : 1_700_000_000_000,
          bootId: "boot-a",
        });
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 1;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));

  await until(() => runtime.query({ run_id: launch.run_id })
    .execution_time.status === "exhausted");
  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 0);
  assert.equal(projection.effects[0].invocation_started, false);
  assert.equal(projection.effects[0].receipt, null);
  assert.equal(projection.attempts[0].status, "active");
  assert.deepEqual(projection.execution_time.active_elapsed_seconds, {
    lower: 0,
    upper: 0,
  });
});

test("launch persists the exact execution facts used for bounded admission", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const baselineMs = 1_700_000_000_000;
  let observations = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    timeObservationAdapter: {
      observe() {
        observations += 1;
        return executionTimeFacts({
          wallValueMs: observations === 1 ? baselineMs : baselineMs + 5_000,
          bootId: "boot-a",
        });
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs: baselineMs,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 3;
  const prepared = runtime.prepare(proposal);

  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(launch.created, true, JSON.stringify(launch));
  assert.equal(observations >= 2, true);
  assert.equal(runtime.query({ run_id: launch.run_id }).execution_time.status,
    "exhausted");
});

test("bounded launch rejects when fresh execution time is unavailable", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 30;
  const prepared = runtime.prepare(proposal);

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "execution_time_unavailable");
});

test("decision-affecting execution time uncertainty fences new admission", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let wallValueMs = 1_700_000_000_000;
  let uncertain = false;
  let invocationCount = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({
          wallValueMs,
          bootId: "boot-a",
          monotonicUncertaintyNs: uncertain ? "2000000000" : "0",
        });
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 1;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  wallValueMs += 1_000;
  uncertain = true;
  const rejection = runtime.command(execution);

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "execution_deadline_uncertain");
  assert.equal(invocationCount, 0);
  const uncertainProjection = runtime.query({ run_id: launch.run_id });
  assert.equal(uncertainProjection.execution_time.status, "uncertain");
  assert.equal(uncertainProjection.execution_time.reason,
    "wall_deadline_uncertain");
  assert.equal(uncertainProjection.legal_actions.every(({ type }) =>
    ["cancel", "recovery", "terminal_disposition"].includes(type)), true);
});

test("active attempt expiry keeps a hung operation unresolved without recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let wallValueMs = 1_700_000_000_000;
  let invokedIntent;
  let settle;
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
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invokedIntent = intent;
      return new Promise((resolve) => { settle = resolve; });
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.graph.cards[0].limits.max_active_seconds = 1;
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 30;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => invokedIntent !== undefined);

  wallValueMs += 2_000;
  const expired = runtime.query({ run_id: launch.run_id });
  assert.equal(expired.execution_time.status, "exhausted");
  assert.equal(expired.execution_time.active_elapsed_seconds.upper >= 2, true);
  assert.equal(expired.legal_actions.some(({ type }) => type === "recovery"), false);
  assert.equal(expired.resource_dispositions[0].disposition, "held");

  settle(operationReceipt(invokedIntent));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
});

test("active deadline uncertainty names the per-attempt deadline", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let wallValueMs = 1_700_000_000_000;
  let monotonicUncertaintyNs = "0";
  let invokedIntent;
  let settle;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({
          wallValueMs,
          bootId: "boot-a",
          monotonicUncertaintyNs,
        });
      },
    },
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invokedIntent = intent;
      return new Promise((resolve) => { settle = resolve; });
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.graph.cards[0].limits.max_active_seconds = 1;
  proposal.explicit_facts.time_facts = executionTimeFacts({
    wallValueMs,
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 30;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => invokedIntent !== undefined);

  wallValueMs += 1_000;
  monotonicUncertaintyNs = "2000000000";
  const uncertain = runtime.query({ run_id: launch.run_id });

  assert.equal(uncertain.execution_time.status, "uncertain");
  assert.equal(uncertain.execution_time.reason, "attempt_deadline_uncertain");
  settle(operationReceipt(invokedIntent));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
});

test("missing active interval facts retain the active-time uncertainty reason", () => {
  const facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  const result = applyExecutionTimeObservation(
    {
      time_facts: facts,
      elapsed_seconds: 0,
      limits: { max_elapsed_seconds: 30 },
      effect_intents: [{
        effect_id: "effect:missing-active-facts",
        max_active_seconds: 1,
      }],
      effects: [],
    },
    [],
    { facts },
    [{
      type: "effect_invocation_started",
      effect_id: "effect:missing-active-facts",
    }],
  );

  assert.equal(result.executionTime.status, "uncertain");
  assert.equal(result.executionTime.reason, "active_time_uncertain");
});

test("a settled receipt without settlement time facts remains uncertain", () => {
  const facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  const result = applyExecutionTimeObservation(
    {
      time_facts: facts,
      elapsed_seconds: 0,
      limits: { max_elapsed_seconds: 30 },
      effect_intents: [{
        effect_id: "effect:missing-settlement-facts",
        max_active_seconds: 2,
      }],
      effects: [],
    },
    [],
    { facts: executionTimeFacts({
      wallValueMs: 1_700_000_005_000,
      bootId: "boot-a",
    }) },
    [
      {
        type: "effect_invocation_started",
        effect_id: "effect:missing-settlement-facts",
        time_facts: facts,
      },
      {
        type: "effect_receipt_recorded",
        effect_id: "effect:missing-settlement-facts",
      },
    ],
  );

  assert.equal(result.executionTime.status, "uncertain");
  assert.equal(result.executionTime.reason, "active_time_uncertain");
});

test("cancellation time facts close active execution before passive wait", () => {
  const baseline = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  const cancellation = executionTimeFacts({
    wallValueMs: 1_700_000_001_000,
    bootId: "boot-a",
  });
  const result = applyExecutionTimeObservation(
    {
      time_facts: baseline,
      elapsed_seconds: 0,
      limits: { max_elapsed_seconds: 30 },
      effect_intents: [{
        effect_id: "effect:cancelled-active-interval",
        max_active_seconds: 2,
      }],
      effects: [],
    },
    [],
    { facts: executionTimeFacts({
      wallValueMs: 1_700_000_010_000,
      bootId: "boot-a",
    }) },
    [
      {
        type: "effect_invocation_started",
        effect_id: "effect:cancelled-active-interval",
        time_facts: baseline,
      },
      { type: "run_cancelled", time_facts: cancellation },
    ],
  );

  assert.equal(result.executionTime.status, "within");
  assert.deepEqual(result.executionTime.active_elapsed_seconds, {
    lower: 1,
    upper: 1,
  });
});

test("unobserved execution time blocks admission and keeps only safe actions", () => {
  const facts = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  const effect = {
    effect_id: "effect:unobserved-time",
    effect_kind: "operation",
    classification: "caller_idempotent",
  };
  const result = applyExecutionTimeObservation(
    {
      time_facts: [],
      elapsed_seconds: 0,
      limits: { max_elapsed_seconds: 30 },
      effect_intents: [effect],
      effects: [effect],
    },
    [
      { type: "operation_execute", effect_id: effect.effect_id },
      { type: "recovery", effect_id: effect.effect_id },
      { type: "cancel" },
    ],
    { facts },
    [],
  );

  assert.equal(result.executionTime.status, "unobserved");
  assert.equal(result.executionTime.reason, "baseline_unavailable");
  assert.deepEqual(result.legalActions, [{ type: "cancel" }]);
});

test("unobserved execution time rejects admission with its typed reason", () => {
  const runId = "run:unobserved-time";
  const watermark = `sha256:${"a".repeat(64)}`;
  const rejection = decideLifecycle(
    {
      run_id: runId,
      watermark,
      phase: "active",
      admission: "admitted",
      execution_time: { status: "unobserved" },
    },
    {
      schema: "flow.command/v1",
      run_id: runId,
      expected_watermark: watermark,
      type: "operation_execute",
    },
  );

  assert.equal(rejection.code, "execution_time_unavailable");
});

test("a clock rollback fails closed instead of clamping elapsed time", () => {
  const baseline = executionTimeFacts({
    wallValueMs: 1_700_000_000_000,
    bootId: "boot-a",
  });
  const rolledBack = executionTimeFacts({
    wallValueMs: 1_699_999_999_000,
    bootId: "boot-a",
  });

  assert.equal(elapsedTimeBounds(baseline, rolledBack), null);
});

test("elapsed bounds reject raw rollback even with a positive baseline", () => {
  const baseline = executionTimeFacts({
    wallValueMs: 1_700_000_010_000,
    bootId: "boot-a",
  });
  const rolledBack = executionTimeFacts({
    wallValueMs: 1_700_000_009_000,
    bootId: "boot-a",
  });

  assert.equal(elapsedTimeBounds(baseline, rolledBack, 30), null);
});

test("safe effect classes execute without an unrelated human checkpoint", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  assert.equal(runtime.command(execution).accepted, true);
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 1);
});

test("caller-idempotent operations may form an explicitly authorized chain", () => {
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal({ checkpointBound: false });
  const first = proposal.graph.cards[0];
  proposal.graph.cards.push({
    ...structuredClone(first),
    id: "record-summary",
    dependencies: [first.id],
    inputs: { value: "summarized" },
  });
  proposal.explicit_facts.limits.max_cards = 2;

  const prepared = runtime.prepare(proposal);
  assert.deepEqual(
    prepared.graph.cards.find(({ id }) => id === "record-summary").dependencies,
    ["record-outcome"],
  );

  const unauthorized = registeredOperationProposal();
  const checkpointBound = unauthorized.graph.cards.find(({ id }) =>
    id === "record-outcome");
  unauthorized.graph.cards.push({
    ...structuredClone(checkpointBound),
    id: "record-summary",
    dependencies: [checkpointBound.id],
    inputs: { value: "summarized" },
  });
  unauthorized.explicit_facts.limits.max_cards = 3;
  assert.throws(
    () => runtime.prepare(unauthorized),
    /direct operation execution authority is incomplete: record-summary/,
  );
});

test("same-boot replacement automatically repeats the exact caller-idempotent intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const attemptedKeys = [];
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.push(intent.idempotency_key);
      throw new Error("receipt lost after provider mutation");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({}, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  const waiting = firstRuntime.query({ run_id: launch.run_id });
  firstRuntime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => attemptedKeys.length === 1);
  const unresolved = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(unresolved.effects[0].status, "unresolved");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.push(intent.idempotency_key);
      return operationReceipt(intent, { record: "adopted" });
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const recovered = recoveredRuntime.query({ run_id: launch.run_id });
  assert.deepEqual(attemptedKeys, [attemptedKeys[0], attemptedKeys[0]]);
  assert.equal(recovered.effects[0].effect_id, unresolved.effects[0].effect_id);
  assert.equal(recovered.effects[0].attempt_id, unresolved.effects[0].attempt_id);
});

test("another Interface over the current authority does not synthesize runtime loss", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const registration = {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("provider result unavailable");
    },
  };
  const runtime = operationRuntime(authority, registration);
  const prepared = runtime.prepare(registeredOperationProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => invocationCount === 1);
  await new Promise((resolve) => setImmediate(resolve));

  operationRuntime(authority, registration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(invocationCount, 1);
});

test("same-boot replacement recovers every outstanding run intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const attemptedKeys = new Map();
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.set(intent.run_id, [intent.idempotency_key]);
      throw new Error("provider result unavailable");
    },
  });
  const launches = ["first", "second"].map((value) => {
    const proposal = operationProposalWithMaxAttempts({}, 2);
    proposal.graph.cards[1].inputs.value = value;
    const prepared = firstRuntime.prepare(proposal);
    const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
    firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
      .legal_actions.find(({ decision }) => decision === "approve"));
    return launch;
  });
  await until(() => attemptedKeys.size === launches.length);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.get(intent.run_id).push(intent.idempotency_key);
      return operationReceipt(intent);
    },
  });

  await until(() => launches.every(({ run_id: runId }) =>
    recoveredRuntime.query({ run_id: runId }).phase === "succeeded"));
  for (const { run_id: runId } of launches) {
    const [initialKey, recoveredKey] = attemptedKeys.get(runId);
    assert.equal(recoveredKey, initialKey);
  }
});

test("an incompatible active run does not block another run's recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const otherContract = "flow.operation/conformance-other/v1";
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const failingRegistration = {
    classification: "caller_idempotent",
    invoke() { throw new Error("provider result unavailable"); },
  };
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: failingRegistration,
      [otherContract]: failingRegistration,
    },
  });
  const proposals = [
    operationProposalWithMaxAttempts({}, 2),
    operationProposalWithMaxAttempts({}, 2),
  ];
  proposals[1].graph.cards[1].executor.contract = otherContract;
  proposals[1].requested_authority.mutations = [otherContract];
  proposals[1].explicit_facts.operation_contracts = proposals[1]
    .explicit_facts.operation_contracts.map((contract) =>
      contract === TEST_OPERATION_CONTRACT ? otherContract : contract);
  const launches = proposals.map((proposal) => {
    const prepared = firstRuntime.prepare(proposal);
    const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
    firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
      .legal_actions.find(({ decision }) => decision === "approve"));
    return launch;
  });
  await until(() => launches.every(({ run_id: runId }) =>
    firstRuntime.query({ run_id: runId }).effects.length === 1));
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });

  await until(() => recoveredRuntime.query({
    run_id: launches[0].run_id,
  }).phase === "succeeded");
  assert.equal(recoveredRuntime.query({
    run_id: launches[1].run_id,
  }).effects[0].status, "unresolved");
});

test("same-boot replacement automatically repeats the exact read-only intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const observedKeys = [];
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "read_only",
    invoke(intent) {
      observedKeys.push(intent.idempotency_key);
      throw new Error("observation response lost");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({
    classification: "read_only",
  }, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => observedKeys.length === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "read_only",
    invoke(intent) {
      observedKeys.push(intent.idempotency_key);
      return operationReceipt(intent, { record: "current-observation" });
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.deepEqual(observedKeys, [observedKeys[0], observedKeys[0]]);
});

test("same-boot replacement automatically adopts exact positive causation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let providerMutations = 0;
  let originalIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke(intent) {
      providerMutations += 1;
      originalIntent = intent;
      throw new Error("receipt lost after provider mutation");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => providerMutations === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    invoke() {
      providerMutations += 1;
      assert.fail("a positively observed effect must not be invoked again");
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "present",
        causation: {
          effect_id: originalIntent.effect_id,
          idempotency_key: originalIntent.idempotency_key,
        },
        provider_observation: { record: "accepted" },
      };
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const reconciled = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(providerMutations, 1);
  assert.equal(reconciled.effects[0].receipt.provider_receipt.record, "accepted");
});

test("schema-only reconciliation evidence cannot settle an effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke() {
      throw new Error("receipt lost before observation");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => firstRuntime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  let observations = 0;
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    observe(intent) {
      observations += 1;
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "present",
        causation: {
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
        },
        provider_observation: {
          schema: "flow.registered-operation-provider-observation/v1",
        },
      };
    },
    invoke() {
      assert.fail("schema-only presence must not authorize invocation");
    },
  });

  await until(() => observations > 0);
  const projection = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "active");
  assert.equal(projection.effects[0].receipt, null);
  assert.equal(projection.effects[0].status, "reconciling");
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("allowlisted null and empty receipt values cannot settle success", async (t) => {
  for (const [label, providerReceipt] of [
    ["null-record", { schema: "flow.provider-receipt/v1", record: null }],
    ["empty-status", { schema: "flow.provider-receipt/v1", status: "" }],
    ["false-complete", { schema: "flow.provider-receipt/v1", complete: false }],
    ["empty-array", { schema: "flow.provider-receipt/v1", artifacts: [] }],
  ]) {
    await t.test(label, async (testContext) => {
      const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
      testContext.after(() => rm(authorityDirectory, { recursive: true, force: true }));
      const authority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${label}`),
      });
      testContext.after(() => authority.close());
      const runtime = operationRuntime(authority, {
        classification: "caller_idempotent",
        invoke(intent) {
          return operationReceipt(intent, providerReceipt);
        },
      });
      const prepared = runtime.prepare(registeredOperationProposal({
        checkpointBound: false,
      }));
      const launch = runtime.launch(confirmedLaunchRequest(prepared));
      runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
        ({ type }) => type === "operation_execute",
      ));
      await until(() => {
        const current = runtime.query({ run_id: launch.run_id });
        return current.phase === "succeeded" ||
          current.effects[0].last_observation !== null;
      });
      const projection = runtime.query({ run_id: launch.run_id });
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects[0].receipt, null);
      assert.equal(projection.effects[0].status, "unresolved");
      assert.equal(projection.effects[0].last_observation.provider_observation.status,
        "invalid_output");
    });
  }
});

test("delegate receipt content keeps precise ordinary words and exact proof identity", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return operationReceipt(intent, {
        schema: "flow.delegate-evidence/v1",
        card_id: "delegate-card",
        validated_output: "tokenizer",
        route_binding: {
          agent_id: "agent-1",
          launch_comparison_key: "launch-key",
          configuration_watermark: "sha256:config",
          description_digest: "sha256:description",
        },
        settlement_proof: {
          schema: "drovr.turn-settlement-proof/v1",
          classification: "exact_transcript_correlation",
          description_digest: "sha256:description",
          launch_comparison_key: "launch-key",
          configuration_watermark: "sha256:config",
          ordered_inputs: [{
            sequence: 1,
            caller_key: "caller-1",
            payload_sha256: "sha256:payload",
            delivery_proof: "exact_transcript_correlation",
          }],
          record_sha256: "sha256:record",
        },
        drovr_watermark: {
          schema: "drovr.turn-watermark/v1",
          content_sha256: "sha256:content",
          sequence: 4,
        },
      });
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const receipt = runtime.query({ run_id: launch.run_id }).effects[0].receipt
    .provider_receipt;
  assert.equal(receipt.validated_output, "tokenizer");
  assert.deepEqual(receipt.route_binding, {
    agent_id: "agent-1",
    launch_comparison_key: "launch-key",
    configuration_watermark: "sha256:config",
    description_digest: "sha256:description",
  });
  assert.deepEqual(receipt.settlement_proof.ordered_inputs, [{
    sequence: 1,
    caller_key: "caller-1",
    payload_sha256: "sha256:payload",
    delivery_proof: "exact_transcript_correlation",
  }]);
  assert.equal(receipt.settlement_proof.record_sha256, "sha256:record");
  assert.deepEqual(receipt.drovr_watermark, {
    schema: "drovr.turn-watermark/v1",
    content_sha256: "sha256:content",
    sequence: 4,
  });
});

test("same-boot replacement invokes reconcilable work only after proven absence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let initialIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke(intent) {
      initialIntent = intent;
      throw new Error("process stopped before invocation was observed");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({
    classification: "reconcilable",
  }, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => initialIntent !== undefined);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const order = [];
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    observe(intent) {
      order.push("observe");
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: { found: false },
      };
    },
    invoke(intent) {
      order.push("invoke");
      assert.equal(intent.effect_id, initialIntent.effect_id);
      assert.equal(intent.idempotency_key, initialIntent.idempotency_key);
      return operationReceipt(intent);
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.deepEqual(order, ["observe", "invoke"]);
});

test("same-boot replacement keeps uncertain absence reconciling", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke() {
      invocationCount += 1;
      throw new Error("receipt lost");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: null,
      };
    },
    invoke() {
      invocationCount += 1;
      assert.fail("absence without evidence must not authorize invocation");
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);

  const unresolved = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 1);
  assert.equal(unresolved.effects[0].last_observation.presence, "indeterminate");
  assert.equal(unresolved.effects[0].status, "reconciling");
  assert.deepEqual(unresolved.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  assert.equal(unresolved.legal_actions[0].effect_id,
    unresolved.effects[0].effect_id);
  assert.equal(unresolved.legal_actions[0].expected_watermark,
    unresolved.watermark);
});

test("operator recovery repeats the exact intent after automatic uncertainty", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let originalIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke(intent) {
      originalIntent = intent;
      throw new Error("receipt lost after provider mutation");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => originalIntent !== undefined);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  let observationCount = 0;
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    invoke() { assert.fail("present effect must be adopted"); },
    observe(intent) {
      observationCount += 1;
      if (observationCount === 1) {
        return {
          schema: "flow.effect-observation/v1",
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
          presence: "absent",
          causation: null,
          provider_observation: null,
        };
      }
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "present",
        causation: {
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
        },
        provider_observation: { record: "accepted" },
      };
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].status === "reconciling");
  const reconciling = recoveredRuntime.query({ run_id: launch.run_id });
  const recovery = reconciling.legal_actions.find(
    ({ type }) => type === "recovery",
  );

  assert.equal(recoveredRuntime.command(recovery).accepted, true);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const completed = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(completed.effects[0].effect_id, originalIntent.effect_id);
  assert.equal(completed.effects[0].idempotency_key,
    originalIntent.idempotency_key);
  assert.equal(completed.effects[0].attempt_id, originalIntent.attempt_id);
});

test("same-boot replacement never retries a checkpoint-bound one-shot effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "one_shot_uncertain",
    observe: indeterminateObservation,
    invoke() {
      invocationCount += 1;
      throw new Error("one-shot result is uncertain");
    },
  });
  const proposal = registeredOperationProposal({
    classification: "one_shot_uncertain",
  });
  const unbound = structuredClone(proposal);
  delete unbound.graph.cards[0].inputs.operation_card_id;
  assert.throws(
    () => firstRuntime.prepare(unbound),
    /one-shot operation requires one exact operation-bound checkpoint/,
  );
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "one_shot_uncertain",
    invoke() {
      invocationCount += 1;
      assert.fail("one-shot effect must never be retried automatically");
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: { found: false },
      };
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].status === "uncertain");
  const uncertain = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 1);
  assert.equal(uncertain.phase, "active");
  assert.equal(uncertain.effects[0].last_observation.presence, "absent");
  assert.deepEqual(uncertain.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  assert.equal(uncertain.legal_actions[0].expected_watermark,
    uncertain.watermark);
});

test("same-boot replacement adopts exact one-shot presence without reinvocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let originalIntent;
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "one_shot_uncertain",
    observe: indeterminateObservation,
    invoke(intent) {
      originalIntent = intent;
      invocationCount += 1;
      throw new Error("receipt lost after one-shot effect");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "one_shot_uncertain",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "one_shot_uncertain",
    invoke() {
      invocationCount += 1;
      assert.fail("present one-shot effect must be adopted, not invoked");
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "present",
        causation: {
          effect_id: originalIntent.effect_id,
          idempotency_key: originalIntent.idempotency_key,
        },
        provider_observation: { provider_id: "accepted-once" },
      };
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.equal(invocationCount, 1);
  assert.equal(recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].receipt.provider_receipt.provider_id, "accepted-once");
});

test("recovery rejects an incompatible replacement registry before mutation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("provider result unavailable");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({}, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  let observed = false;
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "one_shot_uncertain",
    invoke() { assert.fail("incompatible registry must not dispatch"); },
    observe() {
      observed = true;
      return null;
    },
  });
  const before = recoveredRuntime.query({ run_id: launch.run_id });
  const rejection = recoveredRuntime.command(before.legal_actions.find(
    ({ type }) => type === "recovery",
  ));

  assert.equal(rejection.code, "invalid_effect_classification");
  assert.equal(observed, false);
  assert.equal(recoveredRuntime.query({ run_id: launch.run_id }).watermark,
    before.watermark);
});

test("an incompatible Interface cannot consume same-boot automatic recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke() {
      invocationCount += 1;
      throw new Error("provider result unavailable");
    },
  });
  const prepared = firstRuntime.prepare(operationProposalWithMaxAttempts({}, 2));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  createFlowRuntime({ runAuthority: recoveredAuthority });
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });

  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.equal(invocationCount, 2);
});

test("execution rejects an incompatible replacement registry before intent", async (t) => {
  for (const { checkpointBound, expectedCode } of [
    { checkpointBound: true, expectedCode: "unregistered_operation_contract" },
    { checkpointBound: false, expectedCode: "incomplete_operation_registration" },
  ]) {
    await t.test(expectedCode, async (t) => {
      const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
      t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
      const firstAuthority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
      });
      const classification = checkpointBound
        ? "one_shot_uncertain"
        : "caller_idempotent";
      const firstRuntime = operationRuntime(firstAuthority, {
        classification,
        invoke(intent) { return operationReceipt(intent); },
        ...(checkpointBound ? { observe: indeterminateObservation } : {}),
      });
      const prepared = firstRuntime.prepare(registeredOperationProposal({
        checkpointBound,
        classification,
      }));
      const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
      firstAuthority.close();

      const recoveredAuthority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
      });
      t.after(() => recoveredAuthority.close());
      const recoveredRuntime = checkpointBound
        ? createFlowRuntime({ runAuthority: recoveredAuthority })
        : operationRuntime(recoveredAuthority, {
            classification: "caller_idempotent",
          });
      const before = recoveredRuntime.query({ run_id: launch.run_id });
      const command = before.legal_actions.find(({ type }) => type ===
        (checkpointBound ? "checkpoint_decision" : "operation_execute"));

      const rejection = recoveredRuntime.command(command);

      assert.equal(rejection.code, expectedCode);
      const after = recoveredRuntime.query({ run_id: launch.run_id });
      assert.equal(after.watermark, before.watermark);
      assert.deepEqual(after.effects, []);
    });
  }
});

test("a checkpoint-bound operation rejects additional dependencies", () => {
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "other-confirmation",
    inputs: {},
  });
  proposal.graph.cards.find(({ id }) => id === "record-outcome")
    .dependencies.push("other-confirmation");
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => runtime.prepare(proposal),
    /checkpoint-bound operation requires one exact dependency/,
  );
});

test("prepare rejects operation resource claims absent from prepared facts", () => {
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.explicit_facts.resource_claims = [];

  assert.throws(
    () => runtime.prepare(proposal),
    /operation resource claim is outside the prepared facts/,
  );
});

test("a negative provider receipt leaves the exact effect unresolved", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return {
        ...operationReceipt(intent),
        outcome: "absent",
      };
    },
  });
  const prepared = runtime.prepare(operationProposalWithMaxAttempts({}, 2));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => invocationCount === 1);
  const unresolved = runtime.query({ run_id: launch.run_id });

  assert.equal(unresolved.effects[0].status, "unresolved");
  assert.deepEqual(unresolved.effects[0].receipt, null);
  assert.equal(unresolved.legal_actions.filter(
    ({ type }) => type === "recovery",
  ).length, 1);
});

test("a crash before intent commit authorizes no operation effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    beforeIntentCommit() {
      throw new Error("injected crash before intent commit");
    },
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "read_only",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    classification: "read_only",
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  assert.throws(
    () => runtime.command(waiting.legal_actions.find(
      ({ decision }) => decision === "approve",
    )),
    /injected crash before intent commit/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invocationCount, 0);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).effects, []);
});

test("operation settlement does not terminate a graph with pending work", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "final-confirmation",
    inputs: {},
    dependencies: ["record-outcome"],
  });
  proposal.explicit_facts.limits.max_cards = 3;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-plan" && decision === "approve",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0]?.status === "succeeded");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "active");
  assert.equal(projection.cards.find(({ id }) => id === "final-confirmation").status,
    "waiting_checkpoint");
  assert.equal(projection.legal_actions.some(({ checkpoint_id: checkpointId }) =>
    checkpointId === "final-confirmation"), true);
});

test("an unresolved effect serializes checkpoint decisions", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let settle;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return new Promise((resolve) => {
        settle = () => resolve(operationReceipt(intent));
      });
    },
  });
  const proposal = registeredOperationProposal();
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "other-confirmation",
    inputs: {},
  });
  proposal.explicit_facts.limits.max_cards = 3;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-plan" && decision === "approve",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);
  const executing = runtime.query({ run_id: launch.run_id });

  assert.equal(executing.legal_actions.some(({ type }) =>
    type === "checkpoint_decision"), false);
  const rejection = runtime.command({
    schema: "flow.command/v1",
    type: "checkpoint_decision",
    run_id: launch.run_id,
    checkpoint_id: "other-confirmation",
    decision: "approve",
    expected_watermark: executing.watermark,
  });
  assert.equal(rejection.code, "effect_settlement_required");
  assert.equal(runtime.query({ run_id: launch.run_id }).watermark,
    executing.watermark);
  assert.equal(runtime.query().admission.active_runs, 1);

  settle();
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].status === "succeeded");
  const approval = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "other-confirmation" && decision === "approve",
  );
  assert.equal(runtime.command(approval).accepted, true);
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "succeeded");
  assert.equal(runtime.query().admission.active_runs, 0);
});

test("a settled operation permits a terminal revision while an unresolved effect does not", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let settle;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return new Promise((resolve) => {
        settle = () => resolve(operationReceipt(intent));
      });
    },
  });
  const proposal = registeredOperationProposal();
  const revisionCard = {
    ...structuredClone(proposal.graph.cards[0]),
    id: "revise-scope",
    inputs: {},
  };
  proposal.graph.cards.push(revisionCard);
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "scope_revision_required",
  };
  const block = {
    schema: "flow.card-block/v1",
    id: "revise-scope:block",
    type: "plan_revision_required",
    trigger,
    required_capabilities: [],
    revision_template_ids: ["replace-revise-scope"],
  };
  proposal.requested_authority.commands.push("revision_decision");
  proposal.explicit_facts.operation_contracts.push(
    "flow.adapter/card-block-observation/v1",
  );
  proposal.explicit_facts.validator_contracts.push(
    "flow.validator/card-block-observation/v1",
  );
  proposal.explicit_facts.block_observations.push(structuredClone(
    observeCardBlock({ card_id: revisionCard.id, block }),
  ));
  Object.assign(proposal.explicit_facts.limits, {
    max_cards: 3,
    max_revisions: 1,
    max_cards_per_revision: 1,
  });
  proposal.revision_templates = [{
    schema: "flow.plan-revision-template/v1",
    id: "replace-revise-scope",
    trigger,
    limits: { max_applications: 1 },
    changes: {
      add_cards: [],
      add_edges: [],
      supersede_cards: [revisionCard.id],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  }];
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-plan" && decision === "approve",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);

  const executing = runtime.query({ run_id: launch.run_id });
  assert.equal(executing.legal_actions.some(
    ({ type }) => type === "revision_decision",
  ), false);
  const rejection = runtime.command({
    schema: "flow.command/v1",
    type: "revision_decision",
    run_id: launch.run_id,
    template_id: "replace-revise-scope",
    base_plan_fingerprint: executing.plan_fingerprint,
    trigger,
    changes: prepared.revision_templates[0].changes,
    decision: "accept",
    expected_watermark: executing.watermark,
  });
  assert.equal(rejection.code, "effect_settlement_required");
  assert.equal(runtime.query({ run_id: launch.run_id }).watermark,
    executing.watermark);
  settle();
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0].status === "succeeded");
  const revision = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "accept",
  );
  assert.equal(runtime.command(revision).accepted, true);
  const terminal = runtime.query({ run_id: launch.run_id });
  assert.equal(terminal.phase, "succeeded");
  assert.deepEqual(terminal.cards, [
    { id: "confirm-plan", executor_kind: "checkpoint", status: "completed" },
    { id: "record-outcome", executor_kind: "operation", status: "completed" },
    { id: "revise-scope", executor_kind: "checkpoint", status: "superseded" },
  ]);
  assert.equal(terminal.effects[0].status, "succeeded");
  assert.deepEqual(terminal.legal_actions, []);
  assert.equal(runtime.query().admission.active_runs, 0);
});

test("launch rejects an operation whose adapter is not registered", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const preparingRuntime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const prepared = preparingRuntime.prepare(registeredOperationProposal());
  const unregisteredRuntime = createFlowRuntime({ runAuthority: authority });

  const rejection = unregisteredRuntime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "unregistered_operation_contract");
  assert.deepEqual(unregisteredRuntime.query().runs, []);
});

test("launch rejects an operation whose adapter classification changed", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const prepared = operationRuntime(authority, {
    classification: "one_shot_uncertain",
    invoke(intent) { return operationReceipt(intent); },
    observe() {},
  }).prepare(registeredOperationProposal({
    classification: "one_shot_uncertain",
  }));
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.code, "invalid_effect_classification");
  assert.deepEqual(runtime.query().runs, []);
});

test("launch rejects an incomplete operation adapter", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const prepared = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  }).prepare(registeredOperationProposal());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
  });

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.code, "incomplete_operation_registration");
  assert.deepEqual(runtime.query().runs, []);
});

test("operation registrations snapshot bound methods", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  class Registration {
    #calls = 0;
    classification = "caller_idempotent";

    invoke(intent) {
      this.#calls += 1;
      return operationReceipt(intent);
    }

    calls() {
      return this.#calls;
    }
  }
  const registration = new Registration();
  const runtime = operationRuntime(authority, registration);
  const prepared = runtime.prepare(registeredOperationProposal());
  registration.classification = "one_shot_uncertain";
  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  assert.equal(registration.calls(), 1);
});

test("effect observation normalization round-trips exact canonical records", () => {
  const intent = {
    effect_id: "effect:test",
    idempotency_key: "effect:test:v1",
  };
  const causation = {
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
  };
  const observations = [
    {
      schema: "flow.effect-observation/v1",
      ...intent,
      presence: "present",
      causation,
      provider_observation: { found: true },
      ignored: true,
    },
    {
      schema: "flow.effect-observation/v1",
      ...intent,
      presence: "absent",
      causation: null,
      provider_observation: { found: false },
    },
    {
      schema: "flow.effect-observation/v1",
      ...intent,
      presence: "indeterminate",
      causation: { stale: true },
      provider_observation: { error: "timeout" },
    },
    {
      schema: "flow.effect-observation/v1",
      ...intent,
      presence: "present",
      causation,
      provider_observation: { invalid: undefined },
    },
  ];

  for (const observation of observations) {
    const normalized = normalizeEffectObservation(observation, intent);
    assert.deepEqual(Object.keys(normalized).sort(), [
      "causation",
      "effect_id",
      "idempotency_key",
      "presence",
      "provider_observation",
      "schema",
    ]);
    assert.equal(
      validateEffectObservation(normalized, intent),
      normalized.presence,
    );
  }
  const diagnostic = normalizeEffectObservation(observations[2], intent);
  const present = normalizeEffectObservation({
    ...observations[0],
    causation: { ...causation, provider_ref: "external" },
  }, intent);
  assert.equal(present.presence, "present");
  assert.deepEqual(present.causation, causation);
  assert.equal(diagnostic.causation, null);
  assert.deepEqual(diagnostic.provider_observation, { error: "timeout" });
  assert.equal(normalizeEffectObservation(observations[3], intent).presence,
    "indeterminate");
});

test("the public runtime rejects a null operation registry", () => {
  assert.throws(
    () => createFlowRuntime({ registeredOperations: null }),
    /registeredOperations must be an object or Map/,
  );
});

test("prepare rejects an operation whose adapter is not registered", () => {
  const runtime = createFlowRuntime({ registeredOperations: {} });

  assert.throws(
    () => runtime.prepare(registeredOperationProposal()),
    /operation contract is not registered/,
  );
});

test("prepare rejects incomplete operation adapter registrations", () => {
  for (const registration of [
    { classification: "caller_idempotent" },
    { classification: "reconcilable", invoke() {} },
  ]) {
    const runtime = operationRuntime(createNoopAuthority(), registration);
    assert.throws(
      () => runtime.prepare(registeredOperationProposal({
        classification: registration.classification,
      })),
      /operation adapter registration is incomplete/,
    );
  }
});

test("prepare rejects a declared provider receipt validator missing from the adapter", () => {
  const validatorContract = "flow.validator/conformance-provider-receipt/v1";
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.graph.cards[0].inputs.provider_receipt_validator = validatorContract;
  proposal.explicit_facts.validator_contracts.push(validatorContract);

  assert.throws(
    () => runtime.prepare(proposal),
    /provider receipt validator registration is incomplete/,
  );
});

test("launch rejects a prepared card whose validator does not match the registered adapter", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const declaredContract = "flow.validator/conformance-provider-receipt/v1";
  const registeredContract = "flow.validator/other-provider-receipt/v1";
  const runtime = createFlowRuntime({
    runAuthority: authority,
    planCompiler(proposal) {
      return compileDynamicPlan(proposal, { registeredOperations: null });
    },
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        provider_receipt_validator: registeredContract,
        validateReceipt() { return true; },
        invoke(intent) { return operationReceipt(intent); },
      },
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.graph.cards[0].inputs.provider_receipt_validator = declaredContract;
  proposal.explicit_facts.validator_contracts.push(declaredContract);
  const prepared = runtime.prepare(proposal);
  const rejection = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(rejection.code, "incomplete_provider_receipt_validator");
  assert.equal(rejection.authority_watermark_domain, "host");
});

test("a registered provider receipt validator blocks false evidence before success", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const validatorContract = "flow.validator/conformance-provider-receipt/v1";
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    provider_receipt_validator: validatorContract,
    validateReceipt(receipt, intent) {
      assert.equal(receipt.record, "forged");
      assert.equal(intent.operation_contract, TEST_OPERATION_CONTRACT);
      return false;
    },
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent, { record: "forged" });
    },
  });
  const proposal = operationProposalWithMaxAttempts({
    checkpointBound: false,
  }, 2);
  proposal.graph.cards[0].inputs.provider_receipt_validator = validatorContract;
  proposal.explicit_facts.validator_contracts.push(validatorContract);
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  assert.ok(execution);
  assert.equal(runtime.command(execution).accepted, true);
  await until(() => invocationCount === 1);
  const unresolved = runtime.query({ run_id: launch.run_id });
  assert.equal(unresolved.effects[0].status, "unresolved");
  assert.equal(unresolved.effects[0].receipt, null);
  assert.deepEqual(unresolved.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("operation launch requires durable effect authority", () => {
  const registration = {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  };
  const runtime = operationRuntime(createNoopAuthority(), registration);
  const prepared = runtime.prepare(registeredOperationProposal());

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.code, "durable_authority_required");
});

test("watch publishes intent commitment and receipt settlement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let settle;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return new Promise((resolve) => {
        settle = () => resolve(operationReceipt(intent));
      });
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const watcher = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  const waiting = (await watcher.next()).value;
  const intentUpdate = watcher.next();
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const executing = (await intentUpdate).value;
  assert.equal(executing.effects[0].status, "unresolved");

  let receiptUpdate = watcher.next();
  settle();
  let completed = await withTimeout(receiptUpdate, 1_000);
  while (completed.value.effects[0].status !== "succeeded") {
    receiptUpdate = watcher.next();
    completed = await withTimeout(receiptUpdate, 1_000);
  }
  assert.equal(completed.value.effects[0].status, "succeeded");
  assert.equal(completed.value.phase, "succeeded");
  await watcher.return();
});

function fixedHostIdentity(bootId, processIdentity) {
  return {
    observe() {
      return {
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      };
    },
  };
}

function operationRuntime(runAuthority, registration) {
  return createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: registration,
    },
  });
}

function operationProposalWithMaxAttempts(options, maxAttempts) {
  const proposal = registeredOperationProposal(options);
  proposal.graph.cards.find(({ executor }) => executor.kind === "operation")
    .limits.max_attempts = maxAttempts;
  return proposal;
}

function createNoopAuthority() {
  return {
    launch() {},
    command() {},
    query() {
      return { watermark: `sha256:${"0".repeat(64)}` };
    },
    watch() {},
  };
}

function indeterminateObservation(intent) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: null,
  };
}

async function until(condition) {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

function withTimeout(promise, milliseconds) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("timed out waiting for watch update")),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}
