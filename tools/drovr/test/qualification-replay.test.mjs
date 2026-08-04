import assert from "node:assert/strict";
import test from "node:test";

import { loadTraceFixtures } from "../src/qualification-traces.mjs";
import { runTraceFixture } from "../src/qualification-replay.mjs";

test("every trace fixture replays through semantic Drovr harness methods", async () => {
  const fixtures = await loadTraceFixtures();
  for (const fixture of fixtures) {
    const result = await runTraceFixture(fixture);
    assert.equal(result.status, "pass", fixture.id);
  }
});

test("replaying one fixture twice produces byte-identical public outcomes", async () => {
  const fixture = (await loadTraceFixtures()).find(
    ({ id }) => id === "delayed_transcript_settlement",
  );
  const first = await runTraceFixture(fixture);
  const second = await runTraceFixture(fixture);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("transient staged-input reappearance is a discriminating contradiction after stability", async () => {
  const fixture = (await loadTraceFixtures()).find(
    ({ id }) => id === "claude_staged_input_transient_clear_reappears",
  );
  const result = await runTraceFixture(fixture);
  assert.equal(result.result, "clear_contradicted");
  assert.deepEqual(result.observations.at(-1), {
    action: "assert_reappeared_after_clear",
    status: "clear_contradicted",
    at_ms: 25,
    stability_interval_ms: 30,
  });
  assert.deepEqual(
    result.mutation_proofs.map(({ operation }) => operation),
    ["agent.prompt", "agent.send-keys", "agent.start", "agent.resume"],
  );
});

test("stable staged-input clear remains cleared after its stability interval", async () => {
  const fixture = (await loadTraceFixtures()).find(
    ({ id }) => id === "claude_unknown_staged_input_clear_and_reuse",
  );
  const result = await runTraceFixture(fixture);
  assert.equal(result.result, "cleared");
  assert.equal(result.observations.at(-1).status, "cleared");
});

test("delayed staged-input reappearance after stable clear stays unknown without repair", async () => {
  const fixture = (await loadTraceFixtures()).find(
    ({ id }) => id === "claude_staged_input_delayed_reappearance_after_clear",
  );
  assert.ok(fixture, "post-stability reappearance fixture is required");

  const result = await runTraceFixture(fixture);

  assert.equal(result.result, "cleared");
  assert.deepEqual(result.observations.at(-2), {
    action: "assert_delayed_reappearance_after_clear",
    status: "cleared",
    at_ms: 55,
    stability_interval_ms: 30,
  });
  assert.deepEqual(result.observations.at(-1), {
    action: "expect_error",
    outcome: "recovery_blocked",
  });
  assert.deepEqual(
    result.mutation_proofs.filter(({ operation }) =>
      ["agent.prompt", "agent.send-keys", "agent.start", "agent.resume"].includes(operation),
    ),
    [
      {
        operation: "agent.prompt",
        description: "Do not submit reappeared unknown staged input.",
        unchanged: "not_observed",
        basis: "no follow-up semantic mutation was attempted through the replay interface",
      },
      {
        operation: "agent.send-keys",
        description: "Do not send keys for reappeared unknown staged input.",
        unchanged: "not_observed",
        basis: "no follow-up semantic mutation was attempted through the replay interface",
      },
      {
        operation: "agent.start",
        description: "Do not replace the managed agent after reappearance.",
        unchanged: "not_observed",
        basis: "no follow-up semantic mutation was attempted through the replay interface",
      },
      {
        operation: "agent.resume",
        description: "Do not repair the native process implicitly.",
        unchanged: "not_observed",
        basis: "no follow-up semantic mutation was attempted through the replay interface",
      },
    ],
  );
});

test("delayed reappearance rejects an injected post-clear mutation event", async () => {
  const fixture = structuredClone(
    (await loadTraceFixtures()).find(
      ({ id }) => id === "claude_staged_input_delayed_reappearance_after_clear",
    ),
  );
  fixture.steps = fixture.steps.filter(
    ({ action }) => action !== "assert_no_followup_mutation",
  );
  fixture.trace.events.push({
    sequence: fixture.trace.events.length + 1,
    at_ms: 55,
    kind: "command_result",
    operation: "agent.prompt",
    payload: {
      envelope: {
        schema: "herdr.command/v1",
        result: { status: "sent" },
      },
    },
  });

  await assert.rejects(() => runTraceFixture(fixture), /unconsumed/u);
});

test("mutated identity, timing, and staged-token fixtures fail closed", async () => {
  const fixtures = await loadTraceFixtures();
  const mutations = [
    {
      id: "native_session_changes_before_steering",
      mutate(fixture) {
        fixture.trace.events[0].payload.envelope.result.agents[0].agent_session.value =
          "codex-session-altered";
      },
    },
    {
      id: "delayed_transcript_settlement",
      mutate(fixture) {
        [fixture.trace.events[2], fixture.trace.events[3]] = [
          fixture.trace.events[3],
          fixture.trace.events[2],
        ];
        fixture.trace.events.forEach((event, index) => {
          event.sequence = index + 1;
        });
      },
    },
    {
      id: "staged_input_snapshot_token_conflict",
      mutate(fixture) {
        fixture.trace.events[0].payload.text =
          "────────\n❯ QUALIFY-STAGED-TOKEN-ALTERED\n────────";
      },
    },
    {
      id: "claude_staged_input_delayed_reappearance_after_clear",
      mutate(fixture) {
        fixture.trace.events[10].payload.text =
          "────────\n❯ QUALIFY-DELAYED-REAPPEARANCE-ALTERED\n────────";
      },
    },
  ];

  for (const { id, mutate } of mutations) {
    const fixture = structuredClone(fixtures.find((candidate) => candidate.id === id));
    mutate(fixture);
    await assert.rejects(() => runTraceFixture(fixture), id);
  }
});
