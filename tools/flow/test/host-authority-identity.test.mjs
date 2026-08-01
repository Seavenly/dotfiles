import assert from "node:assert/strict";
import test from "node:test";

import { createHostAuthorityIdentityAdapter } from
  "../src/host-authority-identity.mjs";

test("host authority identity comes from the operating-system Adapter", () => {
  let bootReads = 0;
  const adapter = createHostAuthorityIdentityAdapter({
    platform: "linux",
    readLinuxBootIdentity() {
      bootReads += 1;
      return "kernel-boot-a";
    },
    createProcessIdentity: () => "process-a",
  });

  assert.deepEqual(adapter.observe(), {
    schema: "flow.host-authority-identity/v1",
    boot_id: "linux:kernel-boot-a",
    process_identity: "process-a",
  });
  assert.deepEqual(adapter.observe(), adapter.observe());
  assert.equal(bootReads, 1);
});

test("host authority identity fails closed on an unsupported platform", () => {
  assert.throws(
    () => createHostAuthorityIdentityAdapter({ platform: "unknown" }),
    /cannot observe a boot identity/,
  );
});
