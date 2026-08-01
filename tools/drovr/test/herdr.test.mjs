import assert from "node:assert/strict";
import test from "node:test";

import { HerdrClient } from "../src/herdr.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "../src/limits.mjs";

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

test("Claude prompt delivery submits a staged multiline paste", async () => {
  const calls = [];
  let promptSent = false;
  let enterSent = false;
  const client = new HerdrClient({
    session: "delegates",
    delay: async () => {},
    async run(_file, args) {
      calls.push(args);
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

  await client.prompt("managed-agent", "first line\nsecond line", {
    harness: "claude",
    observedBeforeDelivery: {
      agent_status: "idle",
      state_change_seq: 12,
    },
  });

  assert.equal(enterSent, true);
  assert.deepEqual(calls, [
    [
      "--session",
      "delegates",
      "agent",
      "read",
      "managed-agent",
      "--source",
      "visible",
      "--format",
      "text",
    ],
    [
      "--session",
      "delegates",
      "agent",
      "prompt",
      "managed-agent",
      "first line\nsecond line",
    ],
    ["--session", "delegates", "agent", "list"],
    [
      "--session",
      "delegates",
      "agent",
      "read",
      "managed-agent",
      "--source",
      "visible",
      "--format",
      "text",
    ],
    [
      "--session",
      "delegates",
      "agent",
      "send-keys",
      "managed-agent",
      "enter",
    ],
    ["--session", "delegates", "agent", "list"],
  ]);
});

test("Claude prompt delivery waits for delayed attachment conversion despite an idle state change", async () => {
  let delaySteps = 0;
  let promptSent = false;
  let submissionStarted = false;
  let enterAttempts = 0;
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
                agent_status: submissionStarted ? "working" : "idle",
                state_change_seq: submissionStarted ? 14 : 13,
              },
            ],
          },
        });
      }
      if (args.includes("read")) {
        if (!promptSent) return "[Pasted text #1 +1 lines]";
        return delaySteps >= 3
          ? "[Pasted text #1 +1 lines]\n[Pasted text #2 +1 lines]"
          : "[Pasted text #1 +1 lines]\nfirst line\nsecond line";
      }
      if (args.includes("prompt")) promptSent = true;
      if (args.includes("send-keys")) {
        enterAttempts += 1;
        if (delaySteps >= 3) submissionStarted = true;
      }
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

  assert.equal(submissionStarted, true);
  assert.equal(enterAttempts, 1);
  assert.equal(delaySteps, 3);
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
