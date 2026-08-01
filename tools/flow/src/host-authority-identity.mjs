import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { freezeCanonical } from "./canonical.mjs";

export function createHostAuthorityIdentityAdapter({
  platform = process.platform,
  readLinuxBootIdentity = () => readFileSync(
    "/proc/sys/kernel/random/boot_id",
    "utf8",
  ).trim(),
  readMacBootIdentity = () => execFileSync(
    "/usr/sbin/sysctl",
    ["-n", "kern.boottime"],
    { encoding: "utf8" },
  ).trim(),
  createProcessIdentity = () => `process:${process.pid}:${randomUUID()}`,
} = {}) {
  const bootIdentity = platform === "linux"
    ? readLinuxBootIdentity()
    : platform === "darwin"
      ? readMacBootIdentity()
      : null;
  if (typeof bootIdentity !== "string" || bootIdentity.length === 0) {
    throw new Error(`cannot observe a boot identity on ${platform}`);
  }
  const processIdentity = createProcessIdentity();
  if (typeof processIdentity !== "string" || processIdentity.length === 0) {
    throw new Error("cannot create a process identity");
  }

  return Object.freeze({
    observe() {
      return freezeCanonical({
        schema: "flow.host-authority-identity/v1",
        boot_id: `${platform}:${bootIdentity}`,
        process_identity: processIdentity,
      });
    },
  });
}
