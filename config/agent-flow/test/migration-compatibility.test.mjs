import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { deriveResumeCompatibility } from "../src/migration-compatibility.mjs";

const PRIOR = "1".repeat(64);
const NEXT = "2".repeat(64);
const REVISION = "3".repeat(40);
const NEXT_REVISION = "4".repeat(40);

test("resume comparison derives every compatibility dimension", () => {
  const manifest = {
    contract_version: 1,
    implementation: {
      revision: REVISION,
      compatible_contracts: ["agent-flow.run/v1", "old.contract/v1"],
      content_set_fingerprint: PRIOR,
    },
    graph: { name: "local-review", sha256: PRIOR },
    inputs: [
      input("gate", "finalize.json", PRIOR),
      input("machine-input", "candidate.patch", PRIOR),
      input("role-contract", "critic", PRIOR),
      input("skill", "review-critic", PRIOR),
    ],
    profiles: {
      profile_set_fingerprint: PRIOR,
      required: ["critic", "gate"],
      fingerprints: { critic: PRIOR, gate: PRIOR },
    },
  };
  const candidate = {
    compatibleContracts: ["agent-flow.run/v1", "new.contract/v1"],
    contentSetFingerprint: NEXT,
    graphIdentity: { sha256: NEXT },
    inputs: [
      input("gate", "finalize.json", NEXT),
      input("machine-input", "candidate.patch", NEXT),
      input("role-contract", "critic", NEXT),
      input("skill", "review-critic", NEXT),
    ],
  };
  const profileIdentity = {
    profile_set_fingerprint: PRIOR,
    required: ["gate"],
    fingerprints: { gate: PRIOR },
  };

  const result = deriveResumeCompatibility({
    candidate,
    manifest,
    profileIdentity,
    revision: NEXT_REVISION,
  });

  assert.equal(result.contentChanged, true);
  assert.deepEqual(
    result.changes.map(({ kind, name }) => `${kind}:${name}`).sort(),
    [
      "contract:new.contract/v1",
      "contract:old.contract/v1",
      "gate:finalize.json",
      "graph:local-review",
      "implementation:agent-flow",
      "input:machine-input/candidate.patch",
      "profile:critic",
      "role-contract:critic",
      "skill:review-critic",
    ],
  );
  assert.deepEqual(
    result.changes.find(({ kind }) => kind === "profile"),
    {
      kind: "profile",
      name: "critic",
      prior_sha256: PRIOR,
      next_sha256: digest("agent-flow:absent"),
    },
  );
});

function input(kind, name, sha256) {
  return { kind, name, sha256 };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
