import assert from "node:assert/strict";

import { createReplayHarness } from "./harness-replay.mjs";

export async function runTraceFixture(fixture) {
  const replay = createReplayHarness(fixture.trace, {
    harness: fixture.harness,
    requireCompatibility: true,
  });
  const harness = replay.harness;
  const agent = replayAgent(fixture);
  const observations = [];
  let lastObservation;
  let lastInspection;
  let lastStatus;
  let lastExtraction;
  let recoveryResult;
  let recoveryMutationStart;
  let recoveryMutationEnd;
  const mutationAttempts = new Set();
  const mutationProofs = [];
  const assertions = [];

  for (const [index, step] of fixture.steps.entries()) {
    try {
      switch (step.action) {
        case "observe": {
          lastObservation = await harness.observeAgent(agent);
          observations.push({
            action: step.action,
            status: lastObservation?.state ?? null,
          });
          if (step.expect_status !== undefined) {
            assert.equal(lastObservation?.state, step.expect_status);
          }
          if (step.expect_native_session) {
            assert.equal(
              lastObservation?.identity?.native_session,
              step.expect_native_session,
            );
          }
          lastStatus = lastObservation?.state ?? null;
          break;
        }
        case "prompt": {
          const prompt = normalizeReplayInput(step.text);
          await harness.deliverTurn({
            agent,
            prompt,
            observed: lastObservation,
          });
          observations.push({ action: step.action, status: "accepted" });
          break;
        }
        case "interrupt": {
          mutationAttempts.add("agent.send-keys");
          const interrupted = await harness.interruptTurn({
            agent,
            observed: lastObservation,
            deferSettlementObservation: true,
          });
          assert.ok(["cancelled", "interrupted"].includes(interrupted.outcome));
          observations.push({ action: step.action, status: interrupted.outcome });
          break;
        }
        case "delay":
          if (replay.clock.now() < step.milliseconds) {
            await replay.clock.delay(step.milliseconds - replay.clock.now());
          }
          observations.push({ action: step.action, at_ms: replay.clock.now() });
          break;
        case "extract": {
          const prepared = await harness.prepareTurn({ agent, task: { cwd: "/replay" } });
          lastExtraction = await harness.getLateResult({
            agent,
            turn: {
              inputs: step.inputs.map((text) => ({ text })),
              transcript_cursor: prepared.cursor,
            },
          });
          assert.ok(lastExtraction?.result, "replay did not produce a semantic late result");
          assert.equal(lastExtraction.result.text, step.expect_text);
          observations.push({
            action: step.action,
            text: lastExtraction.result.text,
          });
          break;
        }
        case "inspect":
          lastInspection = await harness.inspectStagedInput({ agent });
          assert.equal(lastInspection?.snapshot?.display_text, step.expect_text);
          observations.push({
            action: step.action,
            text: lastInspection?.snapshot?.display_text ?? null,
          });
          break;
        case "recover_clear": {
          mutationAttempts.add("agent.send-keys");
          recoveryMutationStart = replay.consumedEvents().length;
          const token = step.token_from === "last_inspection"
            ? lastInspection?.snapshot?.token
            : step.token;
          recoveryResult = await harness.recoverStagedInput({
            agent,
            action: "clear",
            token,
            stabilityIntervalMs: stabilityIntervalAfter(fixture.steps, index),
          });
          recoveryMutationEnd = replay.consumedEvents().length;
          observations.push({
            action: step.action,
            status: recoveryResult.outcome,
          });
          break;
        }
        case "expect_error": {
          mutationAttempts.add(mutationFor(step));
          let error;
          try {
            if (step.method === "recover_clear") {
              const token = step.token_from === "last_inspection"
                ? lastInspection?.snapshot?.token
                : step.token;
              const result = await harness.recoverStagedInput({
                agent,
                action: "clear",
                token,
                stabilityIntervalMs: stabilityIntervalAfter(fixture.steps, index),
              });
              if (result.outcome !== "cleared") error = semanticResultError(result);
            } else if (step.method === "guarded_excerpt") {
              const result = await harness.waitForTurn({
                agent,
                turn: { inputs: [] },
              });
              if (result.outcome !== "needs_input") {
                error = semanticResultError({
                  ...result,
                  outcome: result.evidence === "changed"
                    ? "recovery_blocked"
                    : result.outcome,
                });
              }
            } else {
              await harness.deliverTurn({
                agent,
                prompt: normalizeReplayInput(step.text),
                observed: lastObservation ?? replayFallbackObservation(agent),
              });
            }
          } catch (candidate) {
            error = candidate;
          }
          assert.ok(error, "expected replay semantic error");
          assert.equal(error.outcome, step.outcome);
          observations.push({ action: step.action, outcome: error.outcome });
          break;
        }
        case "assert_context_isolated":
          assert.ok(
            replay.compatibility.facts?.features?.includes(
              "drovr.caller-context-isolation/v1",
            ),
          );
          break;
        case "assert_no_mutation":
          assert.ok(
            mutationAttempts.has(step.operation),
            `mutation assertion for ${step.operation} must follow a semantic attempt`,
          );
          assert.equal(
            replay.consumedEvents().some(({ operation }) => operation === step.operation),
            false,
          );
          mutationProofs.push({
            operation: step.operation,
            description: step.description,
            unchanged: true,
            basis: "semantic method attempted and no mutation event was consumed",
          });
          break;
        case "assert_last_status":
          lastObservation = await harness.observeAgent(agent);
          lastStatus = lastObservation?.state ?? null;
          assert.equal(lastStatus, step.status);
          break;
        case "assert_reappeared_after_clear":
          assert.ok(recoveryResult);
          assert.equal(recoveryResult.outcome, step.expect_outcome);
          assert.equal(lastInspection?.snapshot?.display_text, step.expect_text ?? lastInspection?.snapshot?.display_text);
          if (step.expect_token) {
            assert.equal(
              lastInspection?.snapshot?.token,
              normalizeExpectedToken(step.expect_token),
            );
          }
          if (step.expect_inspection_outcome) {
            assert.equal(lastInspection?.outcome, step.expect_inspection_outcome);
          }
          if (step.expect_inspection_evidence) {
            assert.equal(lastInspection?.evidence, step.expect_inspection_evidence);
          }
          lastStatus = recoveryResult.outcome;
          observations.push({
            action: step.action,
            status: lastStatus,
            at_ms: replay.clock.now(),
            stability_interval_ms: step.stability_interval_ms ?? null,
          });
          break;
        case "assert_no_followup_mutation":
          assert.ok(recoveryResult, "follow-up mutation assertion requires clear recovery");
          assert.notEqual(
            recoveryMutationStart,
            undefined,
            "follow-up mutation assertion requires a recorded clear boundary",
          );
          assert.notEqual(
            recoveryMutationEnd,
            undefined,
            "follow-up mutation assertion requires a recorded clear completion",
          );
          const mutationStart = step.operation === "agent.send-keys"
            ? recoveryMutationEnd
            : recoveryMutationStart;
          assert.equal(
            replay.consumedEvents()
              .slice(mutationStart)
              .some(({ operation }) => operation === step.operation),
            false,
          );
          mutationProofs.push({
            operation: step.operation,
            description: step.description,
            unchanged: true,
            basis: "clear recovery and post-clear observation consumed no mutation event",
          });
          break;
        case "assert_clear_stable":
          assert.equal(recoveryResult?.outcome, "cleared");
          assert.equal(lastInspection?.snapshot, null);
          assert.ok(
            replay.clock.now() >= (step.stability_interval_ms ?? 0),
            "stable clear must complete its stability interval",
          );
          lastStatus = "cleared";
          observations.push({
            action: step.action,
            status: lastStatus,
            at_ms: replay.clock.now(),
            stability_interval_ms: step.stability_interval_ms ?? null,
          });
          break;
        default:
          throw new Error(`unsupported replay step: ${step.action}`);
      }
      assertions.push({
        step: index + 1,
        action: step.action,
        disposition: "pass",
      });
    } catch (error) {
      error.message = `replay step ${index + 1} (${step.action}) failed: ${error.message}`;
      throw error;
    }
  }

  assert.equal(
    replay.remainingEvents().length,
    0,
    "replay left evidence unconsumed",
  );
  return {
    schema: "drovr.qualification-replay-result/v1",
    scenario_id: fixture.trace.scenario_id,
    status: "pass",
    clock_ms: replay.clock.now(),
    compatibility: replay.compatibility,
    observations,
    assertions,
    mutation_proofs: mutationProofs,
    result: lastExtraction?.result?.text ?? lastStatus ?? "completed",
  };
}

function replayAgent(fixture) {
  const first = fixture.trace.events
    .flatMap((event) => {
      const result = event.payload?.envelope?.result;
      return result?.agents ?? (result?.agent ? [result.agent] : []);
    })
    .find((candidate) => candidate?.name === "managed-agent");
  const requestedSession = fixture.steps.find(({ native_session }) => native_session)
    ?.native_session;
  return {
    id: "replay-agent",
    herdr: {
      name: "managed-agent",
      pane_id: first?.pane_id ?? "pane-1",
    },
    native_session: requestedSession ?? first?.agent_session?.value ?? null,
  };
}

function replayFallbackObservation(agent) {
  return {
    schema: "drovr.semantic-agent-observation/v1",
    evidence: "present",
    identity: {
      managed_agent: agent.herdr.name,
      pane: agent.herdr.pane_id,
      native_session: agent.native_session,
    },
    state: "working",
  };
}

function normalizeReplayInput(text) {
  return text.trimEnd();
}

function normalizeExpectedToken(token) {
  const digest = /^<token:sha256:([0-9a-f]{64})>$/u.exec(token)?.[1];
  return digest ?? token;
}

function stabilityIntervalAfter(steps, index) {
  return steps.slice(index + 1).find((step) =>
    step.action === "assert_reappeared_after_clear" ||
    step.action === "assert_clear_stable",
  )?.stability_interval_ms ?? 30_000;
}

function mutationFor(step) {
  if (step.method === "recover_clear") return "agent.send-keys";
  if (step.method === "guarded_excerpt") return "agent.read.recent-unwrapped";
  return "agent.prompt";
}

function semanticResultError(result) {
  const error = new Error(result.error ?? `semantic operation returned ${result.outcome}`);
  error.outcome = result.outcome;
  error.details = { result };
  return error;
}
