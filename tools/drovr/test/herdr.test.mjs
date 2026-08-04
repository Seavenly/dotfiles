import assert from "node:assert/strict";
import test from "node:test";

import { HerdrClient } from "../src/herdr.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "../src/limits.mjs";
import { stagedInputTextToken } from "../src/staged-input-receipt.mjs";

test("Herdr observations use the advertised command bound", async () => {
  const observedTimeouts = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args, options) {
      observedTimeouts.push(options.timeout);
      if (args.includes("session")) {
        return JSON.stringify({ sessions: [] });
      }
      return JSON.stringify({ result: { agents: [] } });
    },
  });

  await client.sessionRunning();
  await client.agentRecords();

  assert.deepEqual(observedTimeouts, [
    HERDR_OBSERVATION_TIMEOUT_MS,
    HERDR_OBSERVATION_TIMEOUT_MS,
  ]);
});

test("Herdr mutations do not inherit the observation bound", async () => {
  let observedTimeout;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, _args, options) {
      observedTimeout = options.timeout;
      return "";
    },
  });

  await client.interruptAgent("managed-agent");

  assert.equal(observedTimeout, undefined);
});

test("guarded interruption rejects a remapped native target before sending keys", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-1",
              agent_session: { value: "native-after" },
            }],
          },
        });
      }
      throw new Error("interrupt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.interruptAgent("managed-agent", {
      nativeSession: "native-before",
      paneId: "pane-1",
    }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(calls.some((args) => args.includes("send-keys")), false);
});

test("guarded prompt rejects a changed native session before delivery", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "working",
              agent_session: { value: "native-after" },
            }],
          },
        });
      }
      throw new Error("prompt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.prompt("managed-agent", "QUALIFY-IDENTITY-GUARD", {
      nativeSession: "native-before",
    }),
    (error) => {
      assert.equal(error.outcome, "recovery_blocked");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("prompt")), false);
});

test("guarded prompt reports uncertainty when native session is unavailable", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "working",
            }],
          },
        });
      }
      throw new Error("prompt should not be delivered");
    },
  });

  await assert.rejects(
    () => client.prompt("managed-agent", "QUALIFY-IDENTITY-UNKNOWN", {
      nativeSession: "native-before",
    }),
    (error) => {
      assert.equal(error.outcome, "uncertain");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("prompt")), false);
});

test("guarded pane excerpts reject a changed native session before reading", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "blocked",
              agent_session: { value: "caller-session" },
            }],
          },
        });
      }
      throw new Error("mismatched pane should not be read");
    },
  });

  await assert.rejects(
    () => client.agentExcerpt("managed-agent", { nativeSession: "managed-session" }),
    (error) => {
      assert.equal(error.outcome, "recovery_blocked");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("read")), false);
});

test("guarded pane excerpts report uncertainty when native session is unavailable", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "blocked",
            }],
          },
        });
      }
      throw new Error("unavailable identity should not permit a pane read");
    },
  });

  await assert.rejects(
    () => client.agentExcerpt("managed-agent", { nativeSession: "native-before" }),
    (error) => {
      assert.equal(error.outcome, "uncertain");
      return true;
    },
  );
  assert.equal(calls.some((args) => args.includes("read")), false);
});

test("literal staged input targets the exact managed pane without a submit key", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      return JSON.stringify({ result: { status: "sent" } });
    },
  });

  await client.sendPaneText("pane-agent-1", "QUALIFY-UNKNOWN-STAGED");

  assert.deepEqual(calls, [[
    "--session",
    "delegates",
    "pane",
    "send-text",
    "pane-agent-1",
    "QUALIFY-UNKNOWN-STAGED",
  ]]);
});

test("guarded staged input rejects a remapped pane before sending text", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              pane_id: "pane-after",
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      throw new Error("staged text should not be sent");
    },
  });

  await assert.rejects(
    () => client.sendPaneText("pane-before", "QUALIFY-UNKNOWN-STAGED", {
      agentName: "managed-agent",
      nativeSession: "native-1",
    }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(calls.some((args) => args.includes("send-text")), false);
});

test("Herdr waits preserve their caller-selected bound", async () => {
  const observedTimeouts = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args, options) {
      observedTimeouts.push(options.timeout);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{ name: "managed-agent", agent_status: "working" }],
          },
        });
      }
      return JSON.stringify({
        result: {
          agent: { name: "managed-agent", agent_status: "idle" },
        },
      });
    },
  });

  await client.waitForAgent("managed-agent", 300_000);

  assert.deepEqual(observedTimeouts, [
    HERDR_OBSERVATION_TIMEOUT_MS,
    undefined,
  ]);
});

function stagedClaudePromptFixture({ calls } = {}) {
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      calls?.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: enterSent ? "working" : "idle",
                state_change_seq: enterSent ? 13 : 12,
              },
            ],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });
  return { client, enterSent: () => enterSent };
}

test("Claude prompt delivery submits a staged long single-line paste", async () => {
  const fixture = stagedClaudePromptFixture();

  await fixture.client.prompt("managed-agent", "x".repeat(1600), {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(fixture.enterSent(), true);
});

test("Claude prompt delivery accepts a fast short completion without staged text", async () => {
  let polls = 0;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        polls += 1;
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "done",
              state_change_seq: 13,
            }],
          },
        });
      }
      if (args.includes("read")) return "";
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: { status: "accepted" } });
    },
  });

  await client.prompt("managed-agent", "Reply yes", {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(polls, 2);
  assert.equal(enterSent, false);
});

test("Claude prompt delivery submits literal text when it appears with completion", async () => {
  const prompt = "Reply with the exact word: APPROVED.";
  let promptSent = false;
  let polls = 0;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        polls += 1;
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: enterSent
                ? "working"
                : polls >= 3
                  ? "done"
                  : "idle",
              state_change_seq: enterSent ? 14 : polls >= 3 ? 13 : 12,
            }],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent && polls >= 3
          ? `────────\n❯ ${prompt}\n────────`
          : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: { status: "accepted" } });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
  assert.equal(polls, 5);
});

test("Claude prompt delivery rejects a staged long single-line paste without an attachment token", async () => {
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 12,
              },
            ],
          },
        });
      }
      if (args.includes("read")) return "";
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "x".repeat(1600), {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        agent_session: { value: "native-1" },
        pane_id: "pane-1",
        state_change_seq: 12,
      },
    }),
    {
      code: 4,
      message: "Herdr did not expose Claude's staged attachment for managed-agent",
      outcome: "adapter_failure",
    },
  );
});

test("Claude prompt delivery submits a visible literal staged prompt", async () => {
  const prompt = "Review the completed implementation and report actionable findings only.";
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: enterSent ? "working" : "idle",
                state_change_seq: enterSent ? 13 : 12,
              },
            ],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent
          ? "────────\n❯ Review the completed implementation\n  and report actionable findings only.\n────────"
          : "────────\n❯\n────────";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
});

test("Claude prompt delivery refuses to append over staged prompt text", async () => {
  let promptCalls = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("read")) {
        return "────────\n❯ Existing staged work\n────────";
      }
      if (args.includes("prompt")) promptCalls += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "New work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        agent_session: { value: "native-1" },
        pane_id: "pane-1",
        state_change_seq: 12,
      },
    }),
    {
      code: 4,
      outcome: "adapter_failure",
    },
  );
  assert.equal(promptCalls, 0);
});

test("Claude staged input recovery submits only the exact inspected prompt", async () => {
  let submitted = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: submitted ? "working" : "idle",
                state_change_seq: submitted ? 13 : 12,
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) submitted = true;
      return JSON.stringify({ result: {} });
    },
  });

  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });
  assert.equal(staged.display_text, "Exact staged work");

  await client.recoverStagedInput("managed-agent", {
    harness: "claude",
    action: "submit",
    token: staged.token,
    transitionToken: 12,
  });

  assert.equal(submitted, true);
});

test("Claude staged recovery checks identity immediately before the final snapshot inspection", async () => {
  let submitted = false;
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        calls.push("read");
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        calls.push("list");
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                pane_id: "pane-1",
                agent_status: submitted ? "working" : "idle",
                state_change_seq: submitted ? 13 : 12,
                agent_session: { value: "native-1" },
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) {
        calls.push("send-keys");
        submitted = true;
      }
      return JSON.stringify({ result: {} });
    },
  });

  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });
  calls.length = 0;

  await client.recoverStagedInput("managed-agent", {
    harness: "claude",
    action: "submit",
    nativeSession: "native-1",
    paneId: "pane-1",
    token: staged.token,
    transitionToken: 12,
  });

  const sendIndex = calls.indexOf("send-keys");
  assert.deepEqual(calls.slice(0, sendIndex), ["list", "read"]);
  assert.equal(calls[sendIndex - 1], "read");
});

test("Claude failed submission returns an exact Drovr-owned staged-input receipt", async () => {
  let promptSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return promptSent
          ? "────────\n❯ Exact Drovr work\n────────"
          : "────────\n❯\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 12,
              },
            ],
          },
        });
      }
      if (args.includes("prompt")) promptSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "Exact Drovr work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        agent_session: { value: "native-1" },
        pane_id: "pane-1",
        state_change_seq: 12,
      },
    }),
    (error) => {
      assert.equal(error.outcome, "adapter_failure");
      assert.equal(error.details.staged_input.ownership, "drovr");
      assert.equal(error.details.staged_input.display_text, "Exact Drovr work");
      assert.equal(error.details.staged_input.agent_name, "managed-agent");
      assert.equal(error.details.staged_input.pane_id, "pane-1");
      assert.equal(error.details.staged_input.native_session, "native-1");
      assert.equal(
        error.details.staged_input.state_change_seq_before_delivery,
        12,
      );
      assert.match(error.details.staged_input.token, /^[a-f0-9]{64}$/u);
      return true;
    },
  );
});

test("Claude delivery never claims a prompt box with appended operator text", async () => {
  let promptSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return promptSent
          ? "────────\n❯ Exact Drovr work plus operator text\n────────"
          : "────────\n❯\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 12,
              },
            ],
          },
        });
      }
      if (args.includes("prompt")) promptSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    client.prompt("managed-agent", "Exact Drovr work", {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        state_change_seq: 12,
      },
    }),
    (error) => {
      assert.equal(error.outcome, "adapter_failure");
      assert.equal(error.details, undefined);
      return true;
    },
  );
});

test("Claude staged input recovery clears only the exact inspected prompt", async () => {
  let cleared = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("read")) {
        return cleared
          ? "────────\n❯\n────────"
          : "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: cleared ? 13 : 12,
                agent_session: { value: "native-1" },
              },
            ],
          },
        });
      }
      if (args.includes("send-keys")) {
        assert.deepEqual(args.slice(-2), ["esc", "esc"]);
        cleared = true;
      }
      return JSON.stringify({ result: {} });
    },
  });
  const staged = await client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });

  await client.recoverStagedInput("managed-agent", {
    action: "clear",
    harness: "claude",
    nativeSession: "native-1",
    token: staged.token,
    transitionToken: 12,
  });

  assert.equal(cleared, true);
  assert.equal(
    await client.inspectStagedInput("managed-agent", { harness: "claude" }),
    null,
  );
});

test("Claude staged input recovery rejects a stale native transition before sending keys", async () => {
  let sendKeys = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "idle",
              state_change_seq: 2,
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("send-keys")) sendKeys += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    () =>
      client.recoverStagedInput("managed-agent", {
        action: "clear",
        harness: "claude",
        nativeSession: "native-1",
        token: stagedInputTextToken("Exact staged work"),
        transitionToken: 1,
      }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(sendKeys, 0);
});

test("Claude staged input recovery requires an exact native transition token", async () => {
  let sendKeys = 0;
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: "idle",
              state_change_seq: 2,
              agent_session: { value: "native-1" },
            }],
          },
        });
      }
      if (args.includes("read")) {
        return "────────\n❯ Exact staged work\n────────";
      }
      if (args.includes("send-keys")) sendKeys += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    () =>
      client.recoverStagedInput("managed-agent", {
        action: "clear",
        harness: "claude",
        nativeSession: "native-1",
        token: stagedInputTextToken("Exact staged work"),
      }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(sendKeys, 0);
});

test("Claude prompt delivery lets a long single-line literal convert before submitting", async () => {
  const prompt = "x".repeat(1200);
  let delaySteps = 0;
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      if (promptSent) delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: enterSent ? "working" : "idle",
                state_change_seq: enterSent ? 14 : 13,
              },
            ],
          },
        });
      }
      if (args.includes("read")) {
        if (!promptSent) return "";
        return delaySteps >= 3 ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
  assert.ok(delaySteps >= 3);
});

test("Claude long single-line delivery does not treat an early settled observation as submission", async () => {
  const prompt = "x".repeat(1600);
  let delaySteps = 0;
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: enterSent ? "working" : "done",
              state_change_seq: enterSent ? 14 : 13,
            }],
          },
        });
      }
      if (args.includes("read")) {
        return promptSent && delaySteps >= 2 ? "[Pasted text #1 +1 lines]" : "";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", prompt, {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
  assert.ok(delaySteps >= 2);
});

test("Claude long single-line delivery rejects after exhausted polls without an attachment", async () => {
  const prompt = "x".repeat(1600);
  let enterSent = false;
  let delaySteps = 0;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {
      delaySteps += 1;
    },
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [{
              name: "managed-agent",
              agent_status: enterSent ? "working" : "done",
              state_change_seq: enterSent ? 14 : 13,
            }],
          },
        });
      }
      if (args.includes("read")) return "";
      if (args.includes("send-keys")) enterSent = true;
      return JSON.stringify({ result: {} });
    },
  });

  await assert.rejects(
    () => client.prompt("managed-agent", prompt, {
      harness: "claude",
      observedBeforeDelivery: {
        agent_status: "idle",
        state_change_seq: 12,
      },
    }),
    /did not expose Claude's staged attachment/u,
  );
  assert.equal(enterSent, false);
  assert.equal(delaySteps, 100);
});

test("Claude prompt delivery does not send another Enter after work starts", async () => {
  let extraEnters = 0;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "working",
                state_change_seq: 13,
              },
            ],
          },
        });
      }
      if (args.includes("read")) return "";
      if (args.includes("send-keys")) extraEnters += 1;
      return JSON.stringify({ result: {} });
    },
  });

  await client.prompt("managed-agent", "first line\nsecond line", {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(extraEnters, 0);
});

test("agent wait returns Herdr's atomic settled agent observation", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "working",
                state_change_seq: 9,
              },
            ],
          },
        });
      }
      return JSON.stringify({
        id: "cli:agent:wait",
        result: {
          type: "agent_info",
          agent: {
            name: "managed-agent",
            agent_status: "blocked",
            state_change_seq: 10,
            agent_session: { value: "native-session-1" },
          },
        },
      });
    },
  });

  const observed = await client.waitForAgent("managed-agent", 5000);

  assert.deepEqual(observed, {
    name: "managed-agent",
    agent_status: "blocked",
    state_change_seq: 10,
    agent_session: { value: "native-session-1" },
  });
  assert.deepEqual(calls, [
    ["--session", "delegates", "agent", "list"],
    [
      "--session",
      "delegates",
      "agent",
      "wait",
      "managed-agent",
      "--timeout",
      "5000",
    ],
  ]);
});

test("agent wait returns an already settled observation without blocking", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("list")) {
        return JSON.stringify({
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                state_change_seq: 13,
              },
            ],
          },
        });
      }
      throw new Error("blocking agent wait must not run");
    },
  });

  const observed = await client.waitForAgent("managed-agent", 5000);

  assert.equal(observed.agent_status, "idle");
  assert.deepEqual(calls, [
    ["--session", "delegates", "agent", "list"],
  ]);
});

test("native recovery resumes the registered Codex and Claude sessions", async () => {
  for (const [harness, resume, expected] of [
    ["codex", "resumeCodexAgent", ["resume", "native-session-1"]],
    ["claude", "resumeClaudeAgent", ["--resume", "native-session-1"]],
  ]) {
    const calls = [];
    const client = new HerdrClient({
      session: "delegates",
      async run(_file, args) {
        calls.push(args);
        if (args.includes("process-info")) {
          return JSON.stringify({
            result: {
              process_info: {
                shell_pid: 10,
                foreground_processes: [{ pid: 10, name: "zsh" }],
              },
            },
          });
        }
        return JSON.stringify({ result: {} });
      },
    });
    const specification = {
      harness,
      model: harness === "codex" ? "gpt-5.6-luna" : "haiku",
      effort: "low",
      instructions: "",
      native:
        harness === "codex"
          ? { sandbox: "read-only", approval: "never", search: false }
          : { permission_mode: "dontAsk" },
    };

    await client[resume]({
      name: `managed-${harness}`,
      paneId: `pane-${harness}`,
      label: harness,
      specification,
      nativeSession: "native-session-1",
    });

    const start = calls.find(
      (args) => args.includes("agent") && args.includes("start"),
    );
    const separator = start.indexOf("--");
    const nativeArguments = start.slice(separator + 1);
    assert.equal(start[start.indexOf("--kind") + 1], harness);
    const resumeIndex = nativeArguments.indexOf(expected[0]);
    assert.notEqual(resumeIndex, -1);
    assert.deepEqual(
      nativeArguments.slice(resumeIndex, resumeIndex + expected.length),
      expected,
    );
    if (harness === "codex") assert.equal(resumeIndex, 0);
  }
});

test("pane placement uses Herdr layout and split commands with exact resources", async () => {
  const calls = [];
  const layout = {
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    zoomed: false,
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "pane-1",
    panes: [
      {
        pane_id: "pane-1",
        focused: true,
        rect: { x: 0, y: 0, width: 120, height: 40 },
      },
    ],
    splits: [],
  };
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
      if (args.includes("layout")) {
        return JSON.stringify({ result: { type: "pane_layout", layout } });
      }
      return JSON.stringify({
        result: {
          type: "pane_created",
          pane: { pane_id: "pane-2", tab_id: "tab-1" },
        },
      });
    },
  });

  assert.deepEqual(await client.paneLayout("pane-1"), layout);
  assert.equal(
    await client.splitPane({
      paneId: "pane-1",
      direction: "right",
      ratio: 0.5,
      cwd: "/work",
    }),
    "pane-2",
  );
  assert.deepEqual(calls, [
    ["--session", "delegates", "pane", "layout", "--pane", "pane-1"],
    [
      "--session",
      "delegates",
      "pane",
      "split",
      "--pane",
      "pane-1",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      "/work",
      "--no-focus",
    ],
  ]);
});
