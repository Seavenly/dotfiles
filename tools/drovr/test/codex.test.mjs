import assert from "node:assert/strict";
import test from "node:test";

import {
  codexAgentArguments,
  validateCodexLaunchSpecification,
} from "../src/codex.mjs";

const specification = {
  model: "gpt-5.6-luna",
  effort: "low",
  instructions: "Stay within the task.",
  native: {
    sandbox: "workspace-write",
    approval: "on-request",
    approvals_reviewer: "auto_review",
    network_access: false,
    search: true,
  },
};

test("Codex launch validation preflights the exact persisted arguments", async () => {
  let invocation;
  await validateCodexLaunchSpecification(specification, {
    env: { PATH: "/test/bin" },
    async run(command, args, options) {
      invocation = { command, args, options };
      return "Codex help";
    },
  });

  assert.deepEqual(invocation, {
    command: "codex",
    args: ["--strict-config", ...codexAgentArguments(specification), "--help"],
    options: { env: { PATH: "/test/bin" } },
  });
});

test("Codex launch validation rejects an unsatisfied persisted specification", async () => {
  await assert.rejects(
    () =>
      validateCodexLaunchSpecification(specification, {
        async run() {
          throw new Error("unknown configuration key");
        },
      }),
    {
      outcome: "unsupported_configuration",
      message: /cannot validate Codex/u,
    },
  );
});
