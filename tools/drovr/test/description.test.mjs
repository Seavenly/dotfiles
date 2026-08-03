import assert from "node:assert/strict";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { digestCanonical } from "../src/canonical-json.mjs";
import {
  DROVR_ADVERTISED_FEATURE_IDS,
  describeDelegatedAgent,
} from "../src/description.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("description resolves an exact watermarked launch without creating delegated state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-description-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stateHome = join(scratch, "state");
  const callerMetadata = {
    flow_run: "run:example",
    ownership: { card: "implementation", attempt: 2 },
  };

  const description = await describeDelegatedAgent(
    {
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        capability: "read-only",
      },
      caller_metadata: callerMetadata,
    },
    {
      env: {
        ...process.env,
        DROVR_CONFIG_DIR: join(repositoryRoot, "config", "drovr"),
        XDG_STATE_HOME: stateHome,
      },
    },
  );

  assert.equal(description.schema, "drovr.delegated-agent-description/v1");
  assert.deepEqual(description.schemas, {
    request: "drovr.delegated-agent-description-request/v1",
    description: "drovr.delegated-agent-description/v1",
    launch: "drovr.launch-description/v1",
    effective_authority: "drovr.effective-authority/v1",
    capacity: "drovr.capacity/v1",
    credential_reference: "drovr.credential-reference/v1",
    feature_advertisement: "drovr.feature-advertisement/v1",
    caller_metadata: "opaque-json/v1",
  });
  assert.match(description.watermark.content_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(description.watermark.authority, "drovr.configuration-catalog");
  assert.match(description.description_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(description.launch, {
    schema: "drovr.launch-description/v1",
    harness: "codex",
    role: "reviewer",
    model: "gpt-5.6-sol",
    effort: "high",
    capability: "read-only",
    instructions: [
      "Review the requested change against its documented requirements and repository",
      "standards. Prioritize correctness, safety, and maintainability. Report concrete",
      "findings with file locations and explain the user-visible consequence.",
      "",
      "Use repository inspection and read-only validation commands to gather evidence.",
    ].join("\n"),
    native: {
      sandbox: "read-only",
      approval: "never",
      search: false,
    },
    catalog_fingerprints: [
      {
        subject: "capabilities/read-only.toml",
        sha256: "sha256:66e19a81477af4b28221c923a0028d21fbc944068f4c3b86a716410bd1b538a6",
      },
      {
        subject: "config.toml",
        sha256: "sha256:057ee08c3b3c7e4b0021fc7ed82d2ab2d88a8570942dcaf8e7ec36a9fd249407",
      },
      {
        subject: "roles/reviewer/codex.md",
        sha256: "sha256:7c03d1c50862f4fcfc71ce87e7ad7d043a5d15efc1b372f01a681756c984bebb",
      },
      {
        subject: "roles/reviewer/instructions.md",
        sha256: "sha256:7e2f5a48aee3b6ae4eb503acee8b1137c70cff48a94fd7ac345862dd9d74ee4e",
      },
      {
        subject: "roles/reviewer/role.toml",
        sha256: "sha256:158c3a4e1fda51f6febd3b47c1303d728eaf24aa9a156696e78de6e5f28a6831",
      },
    ],
  });
  assert.deepEqual(description.effective_authority, {
    schema: "drovr.effective-authority/v1",
    capability: "read-only",
    dimensions: {
      approvals: "never",
      filesystem: "read_only",
      network: "disabled",
    },
  });
  assert.deepEqual(description.capacity, {
    schema: "drovr.capacity/v1",
    admission_owner: "caller",
    observation_timeout_ms: 30_000,
    concurrent_logical_turns_per_agent: 1,
    managed_agents_per_task: {
      hard_limit: null,
      normal_limit: 4,
      five_or_more_supported: true,
    },
  });
  assert.deepEqual(description.credential_reference, {
    schema: "drovr.credential-reference/v1",
    identity: "ambient/codex",
    secret_material_included: false,
  });
  assert.deepEqual(description.caller_metadata, callerMetadata);
  assert.deepEqual(
    description.feature_advertisement.features.map(({ id }) => id),
    DROVR_ADVERTISED_FEATURE_IDS,
  );
  assert.deepEqual(
    description.feature_advertisement.features
      .filter(({ availability }) => availability === "unavailable")
      .map(({ id }) => id),
    [],
  );
  for (const value of Object.values(description.comparison_keys)) {
    assert.match(value, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(description.legal_actions, [
    "dispatch_exact_launch",
    "refresh_description",
  ]);
  await assert.rejects(stat(join(stateHome, "drovr")), { code: "ENOENT" });
});

test("identical catalogs and inputs produce identical identity-bearing descriptions", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-description-copy-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedConfig = join(scratch, "relocated", "drovr");
  await cp(join(repositoryRoot, "config", "drovr"), copiedConfig, {
    recursive: true,
  });
  const request = {
    schema: "drovr.delegated-agent-description-request/v1",
    launch: { harness: "claude", capability: "workspace-write" },
    caller_metadata: { opaque: ["preserved", { sequence: 1 }] },
  };

  const original = await describeDelegatedAgent(request, {
    env: {
      ...process.env,
      DROVR_CONFIG_DIR: join(repositoryRoot, "config", "drovr"),
    },
  });
  const relocated = await describeDelegatedAgent(structuredClone(request), {
    env: { ...process.env, DROVR_CONFIG_DIR: copiedConfig },
  });

  assert.deepEqual(relocated, original);
});

test("description binds exact compatibility facts when qualification is required", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-description-compatibility-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const run = async (command, args) => {
    if (command === "herdr" && args[0] === "--version") return "herdr 0.7.5";
    if (command === "herdr") return "codex: current (v6)\nclaude: current (v7)";
    if (command === "codex" && args[0] === "--version") return "codex-cli 0.145.0";
    throw new Error(`unexpected runtime probe: ${command}`);
  };
  const description = await describeDelegatedAgent(
    {
      schema: "drovr.delegated-agent-description-request/v1",
      launch: { harness: "codex", capability: "read-only" },
      caller_metadata: { run_id: "compatibility" },
    },
    {
      env: {
        ...process.env,
        DROVR_CONFIG_DIR: join(repositoryRoot, "config", "drovr"),
        XDG_STATE_HOME: join(scratch, "state"),
      },
      run,
      requireCompatibility: true,
    },
  );

  assert.equal(description.compatibility.status, "qualified");
  assert.equal(description.compatibility.facts.integration, "herdr-codex/v6");
  assert.equal(
    description.comparison_keys.compatibility,
    digestCanonical(description.compatibility),
  );
  assert.equal(description.schemas.compatibility, "drovr.compatibility/v1");
  assert.match(description.watermark.content_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("description returns a typed compatibility block for an unqualified runtime", async () => {
  await assert.rejects(
    () => describeDelegatedAgent(
      {
        schema: "drovr.delegated-agent-description-request/v1",
        launch: { harness: "codex", capability: "read-only" },
        caller_metadata: {},
      },
      {
        env: {
          ...process.env,
          DROVR_CONFIG_DIR: join(repositoryRoot, "config", "drovr"),
        },
        requireCompatibility: true,
        run: async () => {
          throw new Error("runtime probe unavailable");
        },
      },
    ),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.compatibility?.legal_actions.includes("run_drovr_doctor"),
  );
});
