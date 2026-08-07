import assert from "node:assert/strict";
import test from "node:test";

import { digestCanonical } from "../src/canonical-json.mjs";
import {
  COMPATIBILITY_FEATURES,
  collectProductionCompatibility,
  qualifyCompatibility,
} from "../src/compatibility.mjs";
import { semanticHarnessFor } from "../src/harness-interface.mjs";
import { createProductionSemanticHarness } from "../src/production-harness-adapter.mjs";

function runtime({ integration = "codex: current (v6)" } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "herdr" && args[0] === "--version") return "herdr 0.7.5\n";
    if (command === "herdr" && args[0] === "integration") {
      return `${integration}\nclaude: current (v7)\n`;
    }
    if (command === "codex" && args[0] === "--version") {
      return "codex-cli 0.145.0\n";
    }
    if (command === "claude" && args[0] === "--version") {
      return "2.1.199 (Claude Code)\n";
    }
    if (command === "codex") {
      return "--model --sandbox --ask-for-approval --search\n";
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { calls, run };
}

function managedIdentity({
  harness = "codex",
  version = harness === "claude"
    ? "2.1.199 (Claude Code)"
    : "codex-cli 0.145.0",
  integration = harness === "claude" ? "herdr-claude/v7" : "herdr-codex/v6",
  canonicalPath = harness === "claude"
    ? "/opt/claude/bin/claude"
    : "/opt/codex/bin/codex",
  managedPathDigest = "sha256:" + "1".repeat(64),
  callerPathDigest = "sha256:" + "2".repeat(64),
  fileIdentity = { device: 1, inode: 2, size: 3, mtime_ms: 4 },
  nativeSession = "native-codex-1",
} = {}) {
  return {
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness,
    managed_agent: "managed-agent",
    pane_id: "pane-1",
    executable: {
      observed_path: canonicalPath,
      canonical_path: canonicalPath,
      version,
      file_identity: fileIdentity,
    },
    managed_path_digest: managedPathDigest,
    caller_path_digest: callerPathDigest,
    integration,
    native_session: nativeSession,
    process: {
      pid: 42,
      name: harness,
      argv0: canonicalPath,
      argv: [canonicalPath, "--sandbox", "read-only"],
      cmdline: `${canonicalPath} --sandbox read-only`,
      cwd: "/workspace",
    },
    model: harness === "claude" ? "haiku" : "gpt-5.6-sol",
    effort: harness === "claude" ? "low" : "high",
  };
}

test("production compatibility records exact executable, integration, and adapter facts", async () => {
  const { run } = runtime();
  const result = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });

  assert.equal(result.status, "qualified");
  assert.deepEqual(result.facts, {
    drovr: "drovr.semantic-harness/v1",
    herdr: "herdr 0.7.5",
    harness: "codex-cli 0.145.0",
    integration: "herdr-codex/v6",
    adapters: ["drovr.production-herdr/v1", "codex-jsonl/v1"],
    features: COMPATIBILITY_FEATURES,
  });
  assert.match(result.evidence_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.legal_actions, []);
  assert.equal(result.upstream_gaps[0].status, "upstream_gap");
});

test("production compatibility binds the managed pane identity and native session", async () => {
  const { run } = runtime();
  const result = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
    managedIdentity: managedIdentity(),
    requireManagedIdentity: true,
  });

  assert.equal(result.status, "qualified");
  assert.equal(result.managed_pane_identity.executable.canonical_path, "/opt/codex/bin/codex");
  assert.equal(result.managed_pane_identity.native_session, "native-codex-1");
  assert.match(result.managed_pane_evidence_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.evidence_digest, digestCanonical(result.facts));
});

test("production launch validation binds the managed executable before native startup", async () => {
  const runtimeFacts = runtime();
  let probes = 0;
  const preflightIdentity = {
    ...managedIdentity({ nativeSession: null }),
    process: null,
    model: null,
    effort: null,
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    env: { PATH: "/caller/bin:/usr/bin" },
    run: runtimeFacts.run,
    requireCompatibility: true,
    herdr: {
      async probeManagedExecutable() {
        probes += 1;
        return preflightIdentity;
      },
    },
  });

  const validation = await harness.validateLaunch({
    specification: {
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      native: {
        sandbox: "read-only",
        approval: "never",
        search: false,
      },
    },
    paneId: "pane-1",
    agentName: "managed-agent",
  });

  assert.equal(probes, 1);
  assert.equal(validation.compatibility.status, "qualified");
  assert.equal(
    validation.compatibility.managed_pane_identity.native_session,
    null,
  );
  assert.equal(
    validation.compatibility.managed_pane_identity.executable.canonical_path,
    "/opt/codex/bin/codex",
  );
});

test("production startup blocks when the post-launch identity differs from preflight", async () => {
  const runtimeFacts = runtime();
  const events = [];
  const preflightIdentity = {
    ...managedIdentity({ nativeSession: null }),
    process: null,
    model: null,
    effort: null,
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    env: { PATH: "/caller/bin:/usr/bin" },
    run: runtimeFacts.run,
    requireCompatibility: true,
    delay: async () => {},
    clock: () => 0,
    herdr: {
      async probeManagedExecutable() {
        events.push("probe");
        return structuredClone(preflightIdentity);
      },
      async startCodexAgent() {
        events.push("start");
      },
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async captureManagedRuntimeIdentity({ executable }) {
        events.push("capture");
        return {
          ...structuredClone(executable),
          integration: "herdr-codex/v7",
          native_session: "native-1",
          process: {
            pid: 42,
            name: "codex",
            argv0: "/opt/codex/bin/codex",
            argv: ["/opt/codex/bin/codex"],
            cmdline: "/opt/codex/bin/codex",
            cwd: "/workspace",
          },
        };
      },
    },
  });

  await assert.rejects(
    () => harness.startAgent({
      agent: {
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        launch: {
          harness: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.mismatches?.some(
        ({ field }) => field === "managed_pane_identity.integration",
      ),
  );
  assert.deepEqual(events, ["probe", "start", "capture"]);
});

test("fresh managed startup remains preflight-bound until native work begins", async () => {
  const runtimeFacts = runtime();
  const preflightIdentity = {
    ...managedIdentity({ nativeSession: null }),
    process: null,
    model: null,
    effort: null,
  };
  const startedIdentity = {
    ...structuredClone(preflightIdentity),
    process: {
      pid: 42,
      name: "codex",
      argv0: "/opt/codex/bin/codex",
      argv: ["/opt/codex/bin/codex"],
      cmdline: "/opt/codex/bin/codex",
      cwd: "/workspace",
    },
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    env: { PATH: "/caller/bin:/usr/bin" },
    run: runtimeFacts.run,
    requireCompatibility: true,
    delay: async () => {},
    clock: () => 0,
    herdr: {
      async probeManagedExecutable() {
        return structuredClone(preflightIdentity);
      },
      async startCodexAgent() {},
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
        };
      },
      async captureManagedRuntimeIdentity({ model, effort }) {
        return {
          ...structuredClone(startedIdentity),
          model,
          effort,
        };
      },
    },
  });

  const started = await harness.startAgent({
    agent: {
      herdr: { name: "managed-agent", pane_id: "pane-1" },
      launch: {
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    },
  });

  assert.equal(started.compatibility.status, "qualified");
  assert.equal(started.managed_runtime_identity.native_session, null);
  assert.equal(started.managed_runtime_identity.process.pid, 42);
});

test("fresh managed observation accepts an idle pane before native session registration", async () => {
  const runtimeFacts = runtime();
  const preflightIdentity = {
    ...managedIdentity({ nativeSession: null }),
    process: {
      pid: 42,
      name: "codex",
      argv0: "/opt/codex/bin/codex",
      argv: ["/opt/codex/bin/codex"],
      cmdline: "/opt/codex/bin/codex",
      cwd: "/workspace",
    },
    model: "gpt-5.6-sol",
    effort: "high",
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    env: { PATH: "/caller/bin:/usr/bin" },
    run: runtimeFacts.run,
    requireCompatibility: true,
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
        };
      },
      async probeManagedExecutable() {
        throw new Error("preflight probing must not interrupt a running agent");
      },
      async captureManagedRuntimeIdentity() {
        return structuredClone(preflightIdentity);
      },
    },
  });

  const observed = await harness.observeAgent({
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    launch_binding: {
      managed_runtime_identity: structuredClone(preflightIdentity),
    },
    launch: {
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    },
  });

  assert.equal(observed.evidence, "present");
  assert.equal(observed.identity.native_session, null);
  assert.equal(observed.compatibility.status, "qualified");
});

test("production compatibility blocks when the managed executable identity is unproven", async () => {
  const result = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    requireManagedIdentity: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "missing");
  assert.deepEqual(result.missing, [
    { fact: "managed_pane_identity", reason: "missing" },
  ]);
});

test("managed-pane version drift from the caller shell is a typed compatibility block", async () => {
  const result = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    managedIdentity: managedIdentity({ version: "codex-cli 0.146.1" }),
    requireManagedIdentity: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "caller_shell_mismatch");
  assert.equal(
    result.mismatches[0].field,
    "managed_pane_identity.executable.version",
  );
});

test("managed-pane executable, integration, path, file, and process binding changes are detected", async () => {
  const baseline = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    managedIdentity: managedIdentity(),
    requireManagedIdentity: true,
  });
  for (const changedIdentity of [
    managedIdentity({ canonicalPath: "/opt/codex/bin/replaced" }),
    managedIdentity({ integration: "herdr-codex/v7" }),
    managedIdentity({ managedPathDigest: "sha256:" + "3".repeat(64) }),
    managedIdentity({ fileIdentity: { device: 1, inode: 9, size: 3, mtime_ms: 4 } }),
    managedIdentity({ nativeSession: "native-codex-replaced" }),
  ]) {
    const changed = await collectProductionCompatibility({
      harness: "codex",
      run: runtime().run,
      env: {},
      managedIdentity: changedIdentity,
      expectedManagedIdentity: baseline.managed_pane_identity,
      requireManagedIdentity: true,
    });

    assert.equal(changed.status, "blocked");
    assert.equal(changed.reason, "changed");
    assert.match(changed.mismatches[0].field, /^managed_pane_identity(?:\.|$)/u);
  }
});

test("caller PATH drift does not change the managed runtime binding", async () => {
  const baseline = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    managedIdentity: managedIdentity(),
    requireManagedIdentity: true,
  });
  const changed = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    managedIdentity: managedIdentity({
      callerPathDigest: "sha256:" + "4".repeat(64),
    }),
    expectedManagedIdentity: baseline.managed_pane_identity,
    requireManagedIdentity: true,
  });

  assert.equal(changed.status, "qualified");
  assert.equal(
    changed.managed_pane_identity.caller_path_digest,
    "sha256:" + "4".repeat(64),
  );
  assert.equal(
    changed.managed_pane_identity.managed_path_digest,
    baseline.managed_pane_identity.managed_path_digest,
  );
});

test("production resume tolerates caller PATH drift after managed identity capture", async () => {
  const runtimeFacts = runtime();
  const expectedIdentity = managedIdentity();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
    managedIdentity: expectedIdentity,
    requireManagedIdentity: true,
  });
  const observedIdentity = {
    ...structuredClone(expectedIdentity),
    caller_path_digest: "sha256:" + "4".repeat(64),
  };
  let resumes = 0;
  const harness = createProductionSemanticHarness({
    harness: "codex",
    env: {},
    run: runtimeFacts.run,
    herdr: {
      async observeManagedRuntime() {
        return structuredClone(expectedIdentity);
      },
      async resumeCodexAgent() {
        resumes += 1;
      },
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-codex-1" },
        };
      },
      async captureManagedRuntimeIdentity() {
        return structuredClone(observedIdentity);
      },
    },
    compatibility,
    expectedCompatibilityEvidenceDigest: compatibility.evidence_digest,
    expectedManagedRuntimeIdentity: expectedIdentity,
    requireCompatibility: true,
    delay: async () => {},
    clock: () => 0,
  });

  const result = await harness.resumeAgent({
    agent: {
      herdr: { name: "managed-agent", pane_id: "pane-1" },
      native_session: "native-codex-1",
      launch: {
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    },
    launchRuntime: {},
  });

  assert.equal(resumes, 1);
  assert.equal(
    result.managed_runtime_identity.caller_path_digest,
    "sha256:" + "4".repeat(64),
  );
});

test("Claude binds the same managed executable identity contract", async () => {
  const result = await collectProductionCompatibility({
    harness: "claude",
    run: runtime().run,
    env: {},
    managedIdentity: managedIdentity({ harness: "claude" }),
    requireManagedIdentity: true,
  });

  assert.equal(result.status, "qualified");
  assert.equal(result.facts.harness, "2.1.199 (Claude Code)");
  assert.equal(result.managed_pane_identity.integration, "herdr-claude/v7");
  assert.equal(result.managed_pane_identity.process.name, "claude");
});

test("an unavailable or changed compatibility fact blocks production validation before native launch", async () => {
  const unavailable = runtime({ integration: "codex: not installed" });
  const blocked = await collectProductionCompatibility({
    harness: "codex",
    run: unavailable.run,
    env: {},
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "missing");
  assert.ok(blocked.legal_actions.includes("run_drovr_doctor"));

  const qualified = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
  });
  const changed = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    expected: {
      ...qualified,
      facts: { ...qualified.facts, herdr: "herdr 0.7.6" },
    },
  });
  assert.equal(changed.status, "blocked");
  assert.equal(changed.reason, "changed");
  assert.ok(changed.legal_actions.includes("retire_stale_launch"));

  const explicitlyUnqualified = qualifyCompatibility({
    status: "blocked",
    reason: "unqualified",
    facts: qualified.facts,
  }, { harness: "codex", adapter: "drovr.production-herdr/v1" });
  assert.equal(explicitlyUnqualified.status, "blocked");
  assert.equal(explicitlyUnqualified.reason, "unqualified");

  const harness = createProductionSemanticHarness({
    harness: "codex",
    requireCompatibility: true,
    run: unavailable.run,
    env: {},
    herdr: {
      async agentRecord() {
        throw new Error("native launch must not be reached");
      },
    },
  });
  await assert.rejects(
    () => harness.validateLaunch({ specification: { harness: "codex" } }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.compatibility?.status === "blocked",
  );
});

test("a harness integration mismatch remains unqualified", async () => {
  const { run } = runtime();
  const result = await collectProductionCompatibility({ harness: "codex", run, env: {} });
  const mismatched = qualifyCompatibility(
    { facts: { ...result.facts, integration: "herdr-claude/v7" } },
    { harness: "codex", adapter: "drovr.production-herdr/v1" },
  );
  assert.equal(mismatched.status, "blocked");
  assert.equal(mismatched.reason, "unqualified");
  assert.equal(mismatched.mismatches[0].field, "integration");
});

test("compatibility rejects malformed version and identity facts", async () => {
  const { run } = runtime();
  const qualified = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });
  const malformed = qualifyCompatibility({
    facts: {
      ...qualified.facts,
      herdr: "latest",
      adapters: [...qualified.facts.adapters, "forged-adapter/v1"],
      features: [...qualified.facts.features, "forged-feature/v1"],
    },
  }, { harness: "codex", adapter: "drovr.production-herdr/v1" });
  assert.equal(malformed.status, "blocked");
  assert.equal(malformed.reason, "unqualified");
  assert.ok(malformed.mismatches.some(({ field }) => field === "herdr"));
  assert.ok(malformed.mismatches.some(({ field }) => field === "adapters"));
  assert.ok(malformed.mismatches.some(({ field }) => field === "features"));
});

test("semantic production mutations require the registered compatibility digest", async () => {
  const { run } = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });
  let nativeObservations = 0;
  let nativePrompts = 0;
  const context = {
    group: { herdr: { session: "delegates" } },
    agent: {
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "0".repeat(64),
      },
    },
  };
  const harness = semanticHarnessFor(context, {
    env: {},
    run,
    herdr: {
      async agentRecord() {
        nativeObservations += 1;
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async prompt() {
        nativePrompts += 1;
      },
    },
    compatibility,
    requireCompatibilityBinding: true,
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.deliverTurn({
      agent: {
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        native_session: "native-1",
      },
      prompt: "must not be delivered",
    }),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.legal_actions?.includes("retire_stale_launch"),
  );
  assert.equal(nativeObservations, 0);
  assert.equal(nativePrompts, 0);
});

test("semantic production mutations revalidate the bound managed process before delivery", async () => {
  const runtimeFacts = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  const boundIdentity = managedIdentity();
  const changedIdentity = {
    ...boundIdentity,
    process: { ...boundIdentity.process, pid: 43 },
  };
  let prompts = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: {
      launch: { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
      launch_binding: {
        compatibility_evidence_digest: compatibility.evidence_digest,
        managed_runtime_identity: boundIdentity,
      },
    },
  }, {
    env: {},
    run: runtimeFacts.run,
    herdr: {
      async observeManagedRuntime() {
        return changedIdentity;
      },
      async agentRecord() {
        throw new Error("agent observation must not follow runtime drift");
      },
      async prompt() {
        prompts += 1;
      },
    },
    compatibility,
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.deliverTurn({
      agent: {
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        native_session: "native-codex-1",
      },
      prompt: "must not be delivered after process replacement",
    }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed",
  );
  assert.equal(prompts, 0);
});

test("real production bindings fail closed when managed runtime identity is absent", async () => {
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: {
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "1".repeat(64),
      },
    },
  }, {
    run: async () => {
      throw new Error("caller compatibility must not replace managed identity");
    },
    requireCompatibility: true,
    requireManagedRuntimeIdentity: true,
  });

  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing",
  );
});

test("a command-runner injection cannot bypass the compatibility binding gate", async () => {
  const runtimeFacts = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  runtimeFacts.calls.length = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: {
      status: "active",
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "0".repeat(64),
      },
    },
  }, {
    env: {},
    run: runtimeFacts.run,
    compatibility,
  });

  assert.equal(harness.capabilities.compatibility, "required");
  await assert.rejects(
    () => harness.deliverTurn({
      agent: {
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        native_session: "native-1",
      },
      prompt: "must not be delivered",
    }),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed",
  );
  assert.deepEqual(runtimeFacts.calls, []);
});

test("binding enforcement rejects conflicting same-harness active-agent bindings", async () => {
  let nativeCalls = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "1".repeat(64),
        },
      },
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "2".repeat(64),
        },
      },
    ],
  }, {
    env: {},
    run: async () => {
      nativeCalls += 1;
      throw new Error("native compatibility collection must not run");
    },
  });

  assert.equal(harness.capabilities.compatibility, "required");
  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.expected === "sha256:" + "1".repeat(64) &&
      error.details?.observed === "sha256:" + "2".repeat(64),
  );
  assert.equal(nativeCalls, 0);
});

test("binding enforcement permits distinct same-harness panes with shared executable identity", async () => {
  const runtimeFacts = runtime();
  const firstIdentity = managedIdentity();
  const secondIdentity = {
    ...structuredClone(firstIdentity),
    managed_agent: "managed-agent-2",
    pane_id: "pane-2",
    native_session: "native-codex-2",
    caller_path_digest: "sha256:" + "9".repeat(64),
    process: {
      ...firstIdentity.process,
      pid: 43,
      cwd: "/workspace-2",
    },
  };
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
    managedIdentity: firstIdentity,
    requireManagedIdentity: true,
  });
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: compatibility.evidence_digest,
          managed_runtime_identity: firstIdentity,
        },
      },
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: compatibility.evidence_digest,
          managed_runtime_identity: secondIdentity,
        },
      },
    ],
  }, {
    env: {},
    run: runtimeFacts.run,
    herdr: {
      async observeManagedRuntime() {
        return structuredClone(firstIdentity);
      },
      async ensureSession() {},
    },
    compatibility,
    requireCompatibility: true,
  });

  await harness.ensureRuntime();
});

test("binding enforcement rejects a missing same-harness identity regardless of order", async () => {
  const boundIdentity = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    harness: "codex",
    managed_agent: "managed-agent",
    pane_id: "pane-1",
    executable: { canonical_path: "/opt/codex/bin/codex" },
    managed_path_digest: "sha256:" + "1".repeat(64),
    integration: "herdr-codex/v6",
  };
  const binding = {
    compatibility_evidence_digest: "sha256:" + "c".repeat(64),
  };
  const boundAgent = {
    status: "active",
    launch: { harness: "codex" },
    launch_binding: {
      ...binding,
      managed_runtime_identity: boundIdentity,
    },
  };
  const legacyAgent = {
    status: "active",
    launch: { harness: "codex" },
    launch_binding: { ...binding },
  };

  for (const agents of [
    [boundAgent, legacyAgent],
    [legacyAgent, boundAgent],
  ]) {
    let revalidations = 0;
    const harness = semanticHarnessFor({
      group: { herdr: { session: "delegates" } },
      task: { id: "task-1" },
      agents,
    }, {
      env: {},
      herdr: {
        async observeManagedRuntime() {
          revalidations += 1;
          throw new Error("binding gate should reject before revalidation");
        },
      },
      requireCompatibility: true,
      requireCompatibilityBinding: true,
      requireManagedRuntimeIdentity: true,
    });

    await assert.rejects(
      () => harness.ensureRuntime(),
      (error) => error.outcome === "compatibility_blocked" &&
        error.details?.reason === "missing",
    );
    assert.equal(revalidations, 0);
  }
});

test("binding enforcement derives managed identity requirements by default", async () => {
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [{
      status: "active",
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "c".repeat(64),
      },
    }],
  }, { env: {} });

  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing",
  );
});

test("binding conflicts report projected shared identity digests", async () => {
  const firstIdentity = managedIdentity();
  const secondIdentity = managedIdentity({
    managedPathDigest: "sha256:" + "3".repeat(64),
  });
  const digest = "sha256:" + "c".repeat(64);
  const agents = [firstIdentity, secondIdentity].map((identity) => ({
    status: "active",
    launch: { harness: "codex" },
    launch_binding: {
      compatibility_evidence_digest: digest,
      managed_runtime_identity: identity,
    },
  }));
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents,
  }, {
    env: {},
    requireCompatibility: true,
    requireCompatibilityBinding: true,
    requireManagedRuntimeIdentity: true,
  });
  const shared = {
    executable: firstIdentity.executable,
    managed_path_digest: firstIdentity.managed_path_digest,
    integration: firstIdentity.integration,
  };
  const observedShared = {
    executable: secondIdentity.executable,
    managed_path_digest: secondIdentity.managed_path_digest,
    integration: secondIdentity.integration,
  };

  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.expected === digestCanonical(shared) &&
      error.details?.observed === digestCanonical(observedShared),
  );
});

test("binding enforcement qualifies mixed harnesses independently", async () => {
  const runtimeFacts = runtime();
  const codexCompatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  const claudeCompatibility = await collectProductionCompatibility({
    harness: "claude",
    run: runtimeFacts.run,
    env: {},
  });
  runtimeFacts.calls.length = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: codexCompatibility.evidence_digest,
        },
      },
      {
        status: "active",
        launch: { harness: "claude" },
        launch_binding: {
          compatibility_evidence_digest: claudeCompatibility.evidence_digest,
        },
      },
    ],
  }, {
    env: {},
    run: runtimeFacts.run,
    herdr: { async ensureSession() {} },
    compatibility: codexCompatibility,
    requireCompatibility: true,
  });

  await harness.ensureRuntime();
  assert.ok(
    runtimeFacts.calls.some(
      ([command, args]) => command === "claude" && args[0] === "--version",
    ),
  );
});

test("binding enforcement rejects a stale secondary harness in a mixed set", async () => {
  const runtimeFacts = runtime();
  const codexCompatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  const claudeCompatibility = await collectProductionCompatibility({
    harness: "claude",
    run: runtimeFacts.run,
    env: {},
  });
  const staleDigest = "sha256:" + "f".repeat(64);
  runtimeFacts.calls.length = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: codexCompatibility.evidence_digest,
        },
      },
      {
        status: "active",
        launch: { harness: "claude" },
        launch_binding: {
          compatibility_evidence_digest: staleDigest,
        },
      },
    ],
  }, {
    env: {},
    run: runtimeFacts.run,
    herdr: { async ensureSession() {} },
    compatibility: codexCompatibility,
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.expected === staleDigest &&
      error.details?.observed === claudeCompatibility.evidence_digest,
  );
  assert.ok(
    runtimeFacts.calls.some(
      ([command, args]) => command === "claude" && args[0] === "--version",
    ),
  );
});

test("binding enforcement rejects same-harness conflicts inside a mixed set", async () => {
  let nativeCalls = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    task: { id: "task-1" },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "1".repeat(64),
        },
      },
      {
        status: "active",
        launch: { harness: "claude" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "3".repeat(64),
        },
      },
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "2".repeat(64),
        },
      },
    ],
  }, {
    env: {},
    run: async () => {
      nativeCalls += 1;
      throw new Error("native compatibility collection must not run");
    },
  });

  await assert.rejects(
    () => harness.ensureRuntime(),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.expected === "sha256:" + "1".repeat(64) &&
      error.details?.observed === "sha256:" + "2".repeat(64),
  );
  assert.equal(nativeCalls, 0);
});

test("teardown can qualify the current runtime without the stale launch binding", async () => {
  const runtimeFacts = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  let closed = 0;
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: {
      status: "active",
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "0".repeat(64),
      },
    },
  }, {
    env: {},
    herdr: {
      async closePane() {
        closed += 1;
      },
    },
    compatibility,
    requireCompatibility: true,
    requireCompatibilityBinding: false,
  });

  await harness.topology.closePane("pane-1");
  assert.equal(closed, 1);
});

test("recovery binding follows the subject agent instead of active siblings", async () => {
  const runtimeFacts = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run: runtimeFacts.run,
    env: {},
  });
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: {
      status: "active",
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: compatibility.evidence_digest,
      },
    },
    agents: [
      {
        status: "active",
        launch: { harness: "codex" },
        launch_binding: {
          compatibility_evidence_digest: "sha256:" + "0".repeat(64),
        },
      },
    ],
  }, {
    env: {},
    herdr: { async ensureSession() {} },
    compatibility,
    requireCompatibility: true,
  });

  await harness.ensureRuntime();
});

test("semantic production mutations block agents with no compatibility digest", async () => {
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: { launch: { harness: "codex" }, launch_binding: {} },
  }, {
    env: {},
    run: async () => {
      throw new Error("compatibility collection must not run");
    },
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.interruptTurn({ agent: {} }),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing" &&
      error.details?.legal_actions?.includes("refresh_compatibility"),
  );
});
