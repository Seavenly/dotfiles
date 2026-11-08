import assert from "node:assert/strict";
import test from "node:test";

import {
  profileConfigurationFingerprint,
  profileSetFingerprint,
} from "../src/profile-fingerprint.mjs";

function inspection(overrides = {}) {
  return {
    tools: ["terminal", "process"],
    dispatchInGateway: false,
    autoDecompose: false,
    terminalBackend: "local",
    terminalHomeMode: "real",
    memoryEnabled: false,
    userProfileEnabled: false,
    concurrency: {
      maxInProgress: 6,
      maxInProgressPerProfile: 3,
      maxSpawn: 6,
    },
    ...overrides,
  };
}

function profileFingerprint(overrides = {}) {
  return profileConfigurationFingerprint({
    name: "builder",
    hermesVersion: "0.18.2",
    config: {
      model: { provider: "openai-codex", default: "builder-model" },
      kanban: { max_in_progress: 6 },
    },
    inspection: inspection(),
    ...overrides,
  });
}

test("profile fingerprints are canonical and configuration-sensitive", () => {
  const original = profileFingerprint();
  const reordered = profileFingerprint({
    config: {
      kanban: { max_in_progress: 6 },
      model: { default: "builder-model", provider: "openai-codex" },
    },
    inspection: inspection({ tools: ["process", "terminal"] }),
  });

  assert.equal(reordered, original);
  assert.notEqual(
    profileFingerprint({ hermesVersion: "0.18.3" }),
    original,
  );
  assert.notEqual(
    profileFingerprint({
      inspection: inspection({ tools: ["terminal"] }),
    }),
    original,
  );
  assert.notEqual(
    profileFingerprint({
      inspection: inspection({ autoDecompose: true }),
    }),
    original,
  );
});

test("profile-set fingerprints are independent of profile order", () => {
  const profiles = [
    { name: "builder", configurationFingerprint: profileFingerprint() },
    {
      name: "gate",
      configurationFingerprint: profileFingerprint({ name: "gate" }),
    },
  ];

  assert.equal(
    profileSetFingerprint(profiles),
    profileSetFingerprint(profiles.toReversed()),
  );
});
