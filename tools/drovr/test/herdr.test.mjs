import assert from "node:assert/strict";
import test from "node:test";

import { HerdrClient } from "../src/herdr.mjs";

test("Claude prompt delivery submits a staged multiline paste", async () => {
  const calls = [];
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
      "prompt",
      "managed-agent",
      "first line\nsecond line",
    ],
    ["--session", "delegates", "agent", "list"],
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

test("agent wait returns Herdr's atomic settled agent observation", async () => {
  const calls = [];
  const client = new HerdrClient({
    session: "delegates",
    async run(_file, args) {
      calls.push(args);
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
