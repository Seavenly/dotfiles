import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveLaunchPolicy } from "../src/launch-selector.mjs";

const policyPath = fileURLToPath(
  new URL("../../../config/flow/launch-policy.v1.json", import.meta.url),
);

test("repeated selection keeps the frozen legacy implementation as the default", async () => {
  const first = await resolveLaunchPolicy({ policyPath });
  const second = await resolveLaunchPolicy({ policyPath });

  assert.deepEqual(second, first);
  assert.equal(first.implementation, "legacy-claude/v1");
  assert.equal(first.authority_root, "~/.agent-teams");
  assert.match(first.policy_watermark, /^sha256:[0-9a-f]{64}$/);

  await assert.rejects(
    resolveLaunchPolicy({
      policyPath,
      requestedImplementation: "flow-runtime/v1",
    }),
    /replacement launch is disabled/,
  );
});
