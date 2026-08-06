import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindingFromDoctorAndDescriptions,
  configurationDigestFromDescriptions,
  evaluateSoak,
  interruptSoak,
  loadSoakPlan,
  runSoak,
  summarizeQualificationEvidence,
  validateSoakPlanAgainstCatalog,
  validateSoakPlan,
} from "../src/qualification-soak.mjs";
import { loadQualificationCatalog } from "../src/qualification-catalog.mjs";
import { digestCanonical } from "../src/canonical-json.mjs";
import {
  CLEANUP_LIMIT_MS,
  PROCESS_EXIT_GRACE_MS,
  runProcess,
} from "../src/qualification-process.mjs";
import { PUBLIC_QUALIFICATION_POLICY } from "../src/qualification-policy.mjs";
import { stateSequenceAntiReplayGap } from "../src/qualification-state-sequence.mjs";

const PLAN = {
  schema: "drovr.qualification-soak-plan/v1",
  version: 1,
  catalog_version: 1,
  minimum_consecutive_cycles: {
    codex: 10,
    claude: 3,
  },
  cycle_scenarios: {
    codex: ["codex_soak_reusable_review_cycle"],
    claude: ["claude_soak_multiline_reuse"],
  },
  required_coverage: [
    "multiline_or_long_input",
    "steering_or_follow_up",
    "cancellation_or_timeout",
    "staged_input_recovery",
    "cleanup",
  ],
  required_state_sequence_phases: [
    "before_staging",
    "after_staging",
    "after_clear",
    "post_clear",
    "after_process_reentry",
  ],
  required_assertion_groups: [
    [
      "same_managed_agent_across_turns",
      "same_agent_reuse_after_initial",
      "same_agent_reuse_after_clear",
      "same_agent_reuse_after_recovery",
    ],
    ["exact_native_session_identity"],
    ["caller_owned_workspace_preservation"],
    ["owned_group_closed"],
  ],
  required_binding_fields: [
    "drovr_commit",
    "source_clean",
    "herdr",
    "integrations",
    "claude",
    "codex",
    "models",
    "reasoning_effort",
    "configuration_digest",
    "catalog_version",
    "catalog_digest",
  ],
};

const BINDING = {
  drovr_commit: "commit-70",
  source_clean: true,
  herdr: "herdr 0.7.5",
  integrations: { claude: "herdr-claude/v7", codex: "herdr-codex/v6" },
  claude: "2.1.199 (Claude Code)",
  codex: "codex-cli 0.145.0",
  models: { claude: "haiku", codex: "gpt-5.6-luna" },
  reasoning_effort: { claude: "low", codex: "low" },
  configuration_digest: "sha256:configuration",
  catalog_version: 1,
  catalog_digest: "sha256:catalog",
};

const EXECUTION_POLICY = PUBLIC_QUALIFICATION_POLICY;

test("soak configuration binding preserves each harness watermark in one digest", () => {
  const descriptions = {
    codex: { result: { watermark: { content_sha256: "sha256:codex" } } },
    claude: { result: { watermark: { content_sha256: "sha256:claude" } } },
  };
  const digest = configurationDigestFromDescriptions(descriptions);
  assert.equal(
    digest,
    digestCanonical({ codex: "sha256:codex", claude: "sha256:claude" }),
  );
  assert.equal(
    bindingFromDoctorAndDescriptions({ descriptions }).configuration_digest,
    digest,
  );
  assert.equal(
    configurationDigestFromDescriptions({ codex: descriptions.codex }),
    null,
  );
});

test("state-sequence validation fails closed when required phases are omitted", () => {
  assert.equal(
    stateSequenceAntiReplayGap(
      {
        before_staging: 1,
        after_staging: 2,
        after_clear: 3,
      },
      ["before_staging", "after_staging", "after_clear"],
    ),
    "unobserved",
  );
});

test("soak plans reject state-sequence phase drift before evaluation", () => {
  const driftedPlan = {
    ...PLAN,
    required_coverage: PLAN.required_coverage.filter(
      (coverage) => coverage !== "staged_input_recovery",
    ),
    required_state_sequence_phases: PLAN.required_state_sequence_phases.slice(0, 3),
  };

  assert.throws(
    () => validateSoakPlan(driftedPlan),
    /required_state_sequence_phases must match/u,
  );
  assert.throws(
    () => evaluateSoak({ plan: driftedPlan, binding: BINDING }),
    /required_state_sequence_phases must match/u,
  );
});

function cycle(harness, number, coverage, overrides = {}) {
  return {
    harness,
    number,
    result: "pass",
    coverage,
    binding: BINDING,
    assertions: [
      { id: "same_agent_reuse_after_initial", disposition: "pass" },
      { id: "exact_native_session_identity", disposition: "pass" },
      { id: "caller_owned_workspace_preservation", disposition: "pass" },
      { id: "owned_group_closed", disposition: "pass" },
    ],
    cleanup: {
      status: "complete",
      unresolved_obligations: [],
    },
    manual_repair: false,
    execution_policy: EXECUTION_POLICY,
    ...(harness === "claude"
      ? { claude_reason: "The live Claude path proves editor-specific reuse." }
      : {}),
    ...overrides,
  };
}

function passingCycles() {
  return [
    ...Array.from({ length: 10 }, (_, index) =>
      cycle("codex", index + 1, [
        "multiline_or_long_input",
        "steering_or_follow_up",
        "cancellation_or_timeout",
        "cleanup",
      ]),
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      cycle("claude", index + 1, ["staged_input_recovery", "cleanup"], {
        state_sequence: {
          before_staging: 1,
          after_staging: 2,
          after_clear: 3,
          post_clear: 3,
          after_process_reentry: 3,
          anti_replay_gap: false,
        },
      }),
    ),
  ];
}

test("soak decision promotes only a fully bound 10/3 consecutive run", () => {
  validateSoakPlan(PLAN);
  const decision = evaluateSoak({
    plan: PLAN,
    binding: BINDING,
    cycles: passingCycles(),
  });

  assert.equal(decision.decision, "promote");
  assert.equal(decision.consecutive.codex.longest, 10);
  assert.equal(decision.consecutive.claude.longest, 3);
  assert.deepEqual(decision.coverage.missing, []);
  assert.deepEqual(decision.residual_limitations, []);
});

test("a failed cycle resets the consecutive count and remains in the decision evidence", () => {
  const cycles = passingCycles();
  cycles[4] = cycle("codex", 5, ["cleanup"], {
    result: "fail",
    assertions: [
      { id: "same_agent_reuse_after_initial", disposition: "fail" },
    ],
    failure: { code: "turn_uncertain" },
  });
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.equal(decision.consecutive.codex.longest, 5);
  assert.ok(
    decision.failures.some(
      ({ cycle: cycleNumber, message }) =>
        cycleNumber === 5 && /cycle|consecutive/u.test(message),
    ),
  );
});

test("a retained qualification lock is a valid explicit soak holder", () => {
  const evidence = {
    scenario_id: "claude_soak_multiline_reuse",
    assertions: [],
    result: { disposition: "pass" },
    cleanup_receipt: {
      resource_dispositions: [
        {
          kind: "qualification_workspace_lock",
          identity: "/tmp/qualification-workspace/.drovr-qualification-lock",
          disposition: "retained",
        },
      ],
      unresolved_obligations: [
        {
          code: "qualification_workspace_lock_retained",
          lock_path: "/tmp/qualification-workspace/.drovr-qualification-lock",
          action: "Verify no run is active, remove the lock, and retry.",
        },
      ],
    },
    execution_policy: EXECUTION_POLICY,
    limits: { measured: {} },
    versions: {},
    trust_preflight: null,
  };

  const cycle = summarizeQualificationEvidence(evidence, {
    harness: "claude",
    number: 1,
    binding: BINDING,
    coverage: ["cleanup"],
  });

  assert.equal(cycle.cleanup.status, "retained");
});

test("soak evaluation accepts a retained lock without a cleanup failure", () => {
  const cycles = passingCycles();
  cycles[0] = cycle("codex", 1, [
    "multiline_or_long_input",
    "steering_or_follow_up",
    "cancellation_or_timeout",
    "cleanup",
  ], {
    cleanup: {
      status: "retained",
      unresolved_obligations: [
        {
          code: "qualification_workspace_lock_retained",
          lock_path: "/tmp/qualification-workspace/.drovr-qualification-lock",
          action: "Verify no run is active, remove the lock, and retry.",
        },
      ],
    },
  });

  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "promote");
  assert.equal(
    decision.failures.some(
      ({ code, cycle: cycleNumber }) =>
        code === "cleanup_not_settled" && cycleNumber === 1,
    ),
    false,
  );
});

test("staged-input anti-replay gaps and binding drift fail closed", () => {
  const cycles = passingCycles();
  cycles[0] = cycle("codex", 1, [
    "multiline_or_long_input",
    "steering_or_follow_up",
    "cancellation_or_timeout",
    "cleanup",
  ], {
    state_sequence: {
      before_staging: 4,
      after_staging: 4,
      after_clear: 4,
      post_clear: 4,
      after_process_reentry: 4,
      anti_replay_gap: true,
    },
  });
  cycles[1].binding = { ...BINDING, herdr: "herdr 0.7.6" };
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.ok(decision.failures.some(({ code }) => code === "anti_replay_gap"));
  assert.ok(decision.failures.some(({ code }) => code === "binding_drift"));
});

test("anti-replay validation requires a fresh clear transition", () => {
  const cycles = passingCycles();
  cycles[0] = cycle("codex", 1, [
    "multiline_or_long_input",
    "steering_or_follow_up",
    "cancellation_or_timeout",
    "cleanup",
  ], {
    state_sequence: {
      before_staging: 1,
      after_staging: 2,
      after_clear: 2,
      post_clear: 2,
      after_process_reentry: 2,
      anti_replay_gap: false,
    },
  });
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.ok(decision.failures.some(({ code }) => code === "anti_replay_gap"));
});

test("anti-replay validation requires stable process re-entry", () => {
  const cycles = passingCycles();
  cycles[0] = cycle("codex", 1, ["staged_input_recovery", "cleanup"], {
    state_sequence: {
      before_staging: 1,
      after_staging: 2,
      after_clear: 3,
      post_clear: 3,
      after_process_reentry: 4,
      anti_replay_gap: false,
    },
  });
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.ok(decision.failures.some(({ code }) => code === "anti_replay_gap"));
});

test("incomplete state sequences remain explicitly unobserved", () => {
  const cycles = passingCycles();
  cycles[10].state_sequence = {
    before_staging: 1,
    after_staging: 2,
    after_clear: 3,
    post_clear: 3,
    after_process_reentry: null,
    anti_replay_gap: "unobserved",
  };
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.ok(
    decision.failures.some(({ code }) => code === "state_sequence_incomplete"),
  );
});

test("nested binding fields and invalid integration details fail closed", () => {
  const incompleteBinding = {
    ...BINDING,
    integrations: { claude: null, codex: "unavailable" },
  };
  const decision = evaluateSoak({
    plan: PLAN,
    binding: incompleteBinding,
    cycles: passingCycles(),
  });

  assert.equal(decision.decision, "unqualified");
  assert.ok(decision.failures.some(({ code }) => code === "binding_incomplete"));
  const binding = bindingFromDoctorAndDescriptions({
    doctor: {
      result: {
        checks: [
          { id: "claude-integration", detail: "unavailable" },
          { id: "codex-integration", detail: "current (v6)" },
        ],
      },
    },
  });
  assert.equal(binding.integrations.claude, null);
  assert.equal(binding.integrations.codex, "herdr-codex/v6");
});

test("version bindings require version-bearing identities", () => {
  const decision = evaluateSoak({
    plan: PLAN,
    binding: { ...BINDING, claude: "spawn claude ENOENT" },
    cycles: passingCycles(),
  });

  assert.equal(decision.decision, "unqualified");
  assert.ok(decision.failures.some(({ code }) => code === "binding_incomplete"));
});

test("follow-up work keeps harness-local cycle failures distinct", () => {
  const decision = evaluateSoak({
    plan: PLAN,
    binding: BINDING,
    cycles: [
      cycle("codex", 1, ["cleanup"], { result: "fail" }),
      cycle("claude", 1, ["cleanup"], { result: "fail" }),
    ],
  });
  const cycleFailures = decision.follow_up_work.filter(
    ({ code }) => code === "cycle_failed",
  );

  assert.deepEqual(
    cycleFailures.map(({ harness, cycle }) => ({ harness, cycle })),
    [
      { harness: "codex", cycle: 1 },
      { harness: "claude", cycle: 1 },
    ],
  );
});

test("manual repair and private mutation policy violations fail closed", () => {
  const cycles = passingCycles();
  cycles[0].execution_policy = {
    ...EXECUTION_POLICY,
    transcript_surgery: true,
  };
  const decision = evaluateSoak({ plan: PLAN, binding: BINDING, cycles });

  assert.equal(decision.decision, "unqualified");
  assert.ok(
    decision.failures.some(({ code }) => code === "execution_policy_not_proven"),
  );
});

test("an extra Claude cycle needs a named coverage reason", () => {
  const withoutReason = evaluateSoak({
    plan: PLAN,
    binding: BINDING,
    cycles: [
      ...passingCycles(),
      cycle("claude", 4, ["staged_input_recovery"]),
    ],
  });
  assert.equal(withoutReason.decision, "unqualified");
  assert.ok(
    withoutReason.failures.some(
      ({ code }) => code === "claude_extra_cycle_reason_missing",
    ),
  );

  const withReason = evaluateSoak({
    plan: PLAN,
    binding: BINDING,
    cycles: [
      ...passingCycles(),
      cycle("claude", 4, ["staged_input_recovery"], {
        state_sequence: {
          before_staging: 1,
          after_staging: 2,
          after_clear: 3,
          post_clear: 3,
          after_process_reentry: 3,
          anti_replay_gap: false,
        },
        additional_coverage_reason: "Recheck the live clear transition counter.",
      }),
    ],
  });
  assert.equal(withReason.decision, "promote");
  assert.ok(
    !withReason.failures.some(
      ({ code }) => code === "claude_extra_cycle_reason_missing",
    ),
  );
});

test("runSoak aggregates isolated cycle evidence into a durable promotion report", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-soak-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const plan = await loadSoakPlan();
  const catalog = await loadQualificationCatalog();
  validateSoakPlanAgainstCatalog(plan, catalog);
  const binding = {
    ...BINDING,
    drovr_source: "drovr source sha256:implementation",
    catalog_digest: digestCanonical(catalog),
  };
  const definitions = [];
  const report = await runSoak({
    plan,
    catalog,
    evidenceDirectory: scratch,
    binding,
    setupResult: {
      binding,
      invocations: [],
      verification: {},
    },
    verification: {
      deterministic: { status: "pass" },
      fault_matrix: { status: "pass" },
    },
    cycleRunner: async (definition) => {
      definitions.push(definition);
      return {
        status: "pass",
        evidence: fakeEvidence(definition, binding),
      };
    },
  });

  assert.equal(report.status, "promote", JSON.stringify(report.decision));
  assert.equal(report.cycles.length, 15);
  assert.equal(definitions.at(-2).scenarioId, "codex_live_lifecycle_recovery");
  assert.equal(
    definitions.at(-1).scenarioId,
    "claude_unknown_staged_input_clear_and_reuse",
  );
  assert.match(
    definitions.at(-1).additionalCoverageReason,
    /Codex and deterministic replay cannot/u,
  );
  assert.equal(report.decision.consecutive.codex.longest, 11);
  assert.equal(report.decision.consecutive.claude.longest, 4);
  assert.deepEqual(report.decision.coverage.missing, []);
  assert.deepEqual(report.unattempted_cycles, []);
  assert.equal(JSON.parse(await readFile(report.report_path)).status, "promote");
});

test("runSoak records interruption and unattempted cycles durably", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-soak-interrupted-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const plan = await loadSoakPlan();
  const catalog = await loadQualificationCatalog();
  const binding = {
    ...BINDING,
    drovr_source: "drovr source sha256:implementation",
    catalog_digest: digestCanonical(catalog),
  };
  const report = await runSoak({
    plan,
    catalog,
    evidenceDirectory: scratch,
    binding,
    setupResult: { binding, invocations: [], verification: {} },
    verification: {
      deterministic: { status: "pass" },
      fault_matrix: { status: "pass" },
    },
    cycleRunner: async (definition) => {
      if (definition.harness === "codex" && definition.number === 3) {
        interruptSoak();
      }
      return { status: "pass", evidence: fakeEvidence(definition, binding) };
    },
  });

  assert.equal(report.status, "unqualified");
  assert.equal(report.cycles.length, 3);
  assert.equal(report.verification.interrupted.status, "fail");
  assert.deepEqual(report.unattempted_cycles[0], {
    harness: "codex",
    number: 4,
    scenario_id: "codex_soak_reusable_review_cycle",
    status: "not_attempted",
  });
  assert.equal(report.cycles.length + report.unattempted_cycles.length, 15);
  assert.deepEqual(
    JSON.parse(await readFile(report.report_path)).unattempted_cycles,
    report.unattempted_cycles,
  );
});

test("runSoak retains a failure artifact when a child evidence receipt is incomplete", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-qualification-soak-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const plan = await loadSoakPlan();
  const catalog = await loadQualificationCatalog();
  const binding = {
    ...BINDING,
    drovr_source: "drovr source sha256:implementation",
    catalog_digest: digestCanonical(catalog),
  };
  const report = await runSoak({
    plan,
    catalog,
    evidenceDirectory: scratch,
    binding,
    setupResult: { binding, invocations: [], verification: {} },
    verification: {
      deterministic: { status: "pass" },
      fault_matrix: { status: "pass" },
    },
    cycleRunner: async (definition) => {
      const evidence = fakeEvidence(definition, binding);
      if (definition.harness === "codex" && definition.number === 1) {
        delete evidence.cleanup_receipt;
      }
      return { status: "pass", evidence };
    },
  });

  assert.equal(report.status, "unqualified");
  assert.ok(
    report.decision.failures.some(({ code }) => code === "cleanup_not_settled"),
  );
  const failurePath = report.cycles[0].evidence_path;
  assert.match(failurePath, /cycle-failure\.json$/u);
  assert.equal(
    JSON.parse(await readFile(failurePath)).schema,
    "drovr.qualification-cycle-failure/v1",
  );
});

test("runProcess force-terminates a child after the graceful window", async () => {
  const terminationGraceMs = 50;
  assert.ok(PROCESS_EXIT_GRACE_MS > CLEANUP_LIMIT_MS);
  const result = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
      terminationGraceMs,
    },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(result.elapsedMs >= terminationGraceMs - 10);
});

function fakeEvidence(definition, binding) {
  const assertions = [
    {
      id: definition.scenarioId === "codex_live_lifecycle_recovery"
        ? "same_agent_reuse_after_recovery"
        : definition.scenarioId === "claude_unknown_staged_input_clear_and_reuse"
          ? "same_agent_reuse_after_clear"
          : "same_agent_reuse_after_initial",
      disposition: "pass",
    },
    { id: "exact_native_session_identity", disposition: "pass" },
    { id: "caller_owned_workspace_preservation", disposition: "pass" },
    { id: "owned_group_closed", disposition: "pass" },
  ];
  return {
    schema: "drovr.qualification-evidence/v1",
    catalog_version: 1,
    catalog_digest: binding.catalog_digest,
    scenario_id: definition.scenarioId,
    versions: {
      drovr: binding.drovr_source,
      herdr: binding.herdr,
      integration: {
        codex: "current (v6)",
        claude: "current (v7)",
      },
      codex: binding.codex,
      claude: binding.claude,
      model: binding.models[definition.harness],
      reasoning_effort: binding.reasoning_effort[definition.harness],
    },
    trust_preflight: {
      schema: "drovr.qualification-trust/v1",
      status: "trusted",
      workspace: {
        path: "/tmp/qualification-workspace",
        identity: "sha256:qualification-workspace",
      },
      harnesses: {
        [definition.harness]: {
          status: "trusted",
          workspace: {
            path: "/tmp/qualification-workspace",
            identity: "sha256:qualification-workspace",
          },
        },
      },
      configuration: {
        created: false,
        origin: "pre_existing",
        cleanup: "not_created",
      },
      native_work_started: false,
      binding: "sha256:qualification-trust",
      reason: null,
    },
    limits: { measured: { turns: 2, retries: 0, elapsed_ms: 10 } },
    invocations: [],
    live_run_justification: definition.harness === "claude"
      ? "The live Claude editor path is required for this cycle."
      : "The Codex live path provides primary soak coverage.",
    assertions,
    result: { disposition: "pass" },
    execution_policy: {
      interface: "public_drovr_cli",
      manual_repair: false,
      registry_surgery: false,
      transcript_surgery: false,
      agent_replacement: false,
      raw_manual_keys: false,
      hidden_retry: false,
      caller_workspace_mutation: false,
    },
    cleanup_receipt: {
      schema: "drovr.qualification-cleanup-receipt/v1",
      scenario_id: definition.scenarioId,
      owned_resources: [],
      resource_dispositions: [],
      prohibited_mutations_observed: [],
      caller_owned_workspace: {
        path: "/tmp/caller",
        before: {},
        after: {},
      },
      unresolved_obligations: [],
      completed_at: "2026-08-05T00:00:00.000Z",
    },
    ...(definition.scenarioId === "claude_unknown_staged_input_clear_and_reuse"
      ? {
          state_sequence: {
            before_staging: 1,
            after_staging: 2,
            after_clear: 3,
            post_clear: 3,
            after_process_reentry: 3,
            anti_replay_gap: false,
          },
        }
      : {}),
  };
}
