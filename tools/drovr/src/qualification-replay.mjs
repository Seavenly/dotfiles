import assert from "node:assert/strict";

import { createReplayHarness } from "./harness-replay.mjs";

export async function runTraceFixture(fixture) {
  const replay = createReplayHarness(fixture.trace, { harness: fixture.harness });
  const observations = [];
  let lastObservation;
  let lastInspection;
  let firstInspection;
  let lastStatus;
  let lastExtraction;
  let recoverySucceeded = false;
  const mutationAttempts = new Set();
  const mutationProofs = [];
  const assertions = [];

  for (const [index, step] of fixture.steps.entries()) {
    try {
      switch (step.action) {
        case "observe": {
          lastObservation = await replay.client.agentRecord(step.name);
          observations.push({ action: step.action, status: lastObservation?.agent_status ?? null });
          if (step.expect_status !== undefined) {
            assert.equal(lastObservation?.agent_status, step.expect_status);
          }
          if (step.expect_native_session) {
            assert.equal(lastObservation?.agent_session?.value, step.expect_native_session);
          }
          lastStatus = lastObservation?.agent_status ?? null;
          break;
        }
        case "prompt": {
          await replay.client.prompt(step.name, step.text, {
            harness: fixture.harness,
            observedBeforeDelivery:
              lastObservation ?? { agent_status: step.before_status ?? "working" },
          });
          observations.push({ action: step.action, status: "accepted" });
          break;
        }
        case "interrupt":
          await replay.client.interruptAgent(step.name);
          observations.push({ action: step.action, status: "interrupted" });
          break;
        case "delay":
          await replay.client.delay(step.milliseconds);
          observations.push({ action: step.action, at_ms: replay.clock.now() });
          break;
        case "extract": {
          const cursor = await replay.adapter.captureCursor();
          lastExtraction = await replay.adapter.extract(cursor, step.inputs);
          assert.equal(lastExtraction.text, step.expect_text);
          observations.push({ action: step.action, text: lastExtraction.text });
          break;
        }
        case "inspect":
          lastInspection = await replay.client.inspectStagedInput(step.name, {
            harness: fixture.harness,
          });
          firstInspection ??= lastInspection;
          assert.equal(lastInspection?.display_text, step.expect_text);
          observations.push({ action: step.action, text: lastInspection?.display_text ?? null });
          break;
        case "recover_clear": {
          mutationAttempts.add("agent.send-keys");
          const token = step.token_from === "last_inspection"
            ? lastInspection?.token
            : step.token;
          await replay.client.recoverStagedInput(step.name, {
            action: "clear",
            harness: fixture.harness,
            nativeSession: step.native_session,
            token,
          });
          recoverySucceeded = true;
          observations.push({ action: step.action, status: "cleared" });
          break;
        }
        case "expect_error": {
          let error;
          try {
            if (step.method === "recover_clear") {
              mutationAttempts.add("agent.send-keys");
              const token = step.token_from === "last_inspection"
                ? lastInspection?.token
                : step.token;
              await replay.client.recoverStagedInput(step.name, {
                action: "clear",
                harness: fixture.harness,
                nativeSession: step.native_session,
                token,
              });
            } else if (step.method === "guarded_excerpt") {
              mutationAttempts.add("agent.read.recent-unwrapped");
              await replay.client.agentExcerpt(step.name, {
                nativeSession: step.native_session,
              });
            } else {
              mutationAttempts.add("agent.prompt");
              await replay.client.prompt(step.name, step.text, {
                harness: fixture.harness,
                nativeSession: step.native_session,
                observedBeforeDelivery: lastObservation ?? {
                  agent_status: step.before_status ?? "working",
                },
              });
            }
          } catch (candidate) {
            error = candidate;
          }
          assert.ok(error, "expected replay error");
          assert.equal(error.outcome, step.outcome);
          observations.push({ action: step.action, outcome: error.outcome });
          break;
        }
        case "assert_context_isolated":
          for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) {
            assert.equal(replay.client.env[key], undefined, key);
          }
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
          lastObservation = await replay.client.agentRecord("managed-agent");
          lastStatus = lastObservation?.agent_status ?? null;
          assert.equal(lastStatus, step.status);
          break;
        case "assert_reappeared_after_clear":
          assert.equal(recoverySucceeded, true);
          assert.equal(lastInspection?.display_text, firstInspection?.display_text);
          assert.equal(lastInspection?.token, firstInspection?.token);
          const observedOutcome = clearDisposition({
            reappeared: lastInspection !== null,
            atMs: replay.clock.now(),
            stabilityIntervalMs: step.stability_interval_ms ?? 0,
          });
          if (step.expect_outcome !== undefined) {
            assert.equal(observedOutcome, step.expect_outcome);
          }
          lastStatus = observedOutcome;
          observations.push({
            action: step.action,
            status: lastStatus,
            at_ms: replay.clock.now(),
            stability_interval_ms: step.stability_interval_ms ?? null,
          });
          break;
        case "assert_clear_stable":
          assert.equal(recoverySucceeded, true);
          assert.equal(lastInspection, null);
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

  assert.equal(replay.remainingEvents().length, 0, "replay left evidence unconsumed");
  return {
    schema: "drovr.qualification-replay-result/v1",
    scenario_id: fixture.trace.scenario_id,
    status: "pass",
    clock_ms: replay.clock.now(),
    observations,
    assertions,
    mutation_proofs: mutationProofs,
    result: lastExtraction?.text ?? lastStatus ?? "completed",
  };
}

function clearDisposition({ reappeared, atMs, stabilityIntervalMs }) {
  if (reappeared) {
    return atMs < stabilityIntervalMs
      ? "clear_contradicted"
      : "clear_unstable";
  }
  return atMs >= stabilityIntervalMs ? "cleared" : "clear_unstable";
}
