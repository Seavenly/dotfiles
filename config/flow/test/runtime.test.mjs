import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  createDrovrDelegatedAgentPort,
} from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";
import { createDurableRunAuthority } from
  "../../../tools/flow/src/run-authority.mjs";
import { createInMemoryRunAuthority } from
  "../../../tools/flow/src/run-authority.mjs";
import { createFlowRuntime as createCoreFlowRuntime } from
  "../../../tools/flow/src/flow-runtime.mjs";
import {
  completedTurnProjection,
  DELEGATE_OUTPUT_VALIDATOR,
  delegateCardProposal,
} from "../../../tools/flow/test-support/delegate-card.mjs";
import {
  rebindDescriptionDigest,
  repositoryDrovrDependencies,
  supportedDescription,
} from "../../../tools/flow/test-support/delegated-agent-description.mjs";
import { confirmedLaunchRequest, dynamicCheckpointProposal } from
  "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import {
  fixedExecutionTimeAdapter,
  fixedHostIdentity,
} from "../../../tools/flow/test-support/fixed-host-identity.mjs";
import {
  closeFlowRuntime,
  createFlowRuntime,
  normalizeProductionRunnerOptions,
} from "../src/runtime.mjs";
import { validateDelegateEvidenceSafety } from
  "../../../tools/flow/src/evidence-safety.mjs";
import {
  productionRouteConformanceSessionBinding,
} from "../../../tools/flow/src/qualification-phase2-session.mjs";

const DARK_OPT_IN = {
  schema: "flow.dark-opt-in/v1",
  release_id: "flow-release-1.0-dark/v1",
  purpose: "sacrificial_qualification",
};
const FLOW_CONFIG_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

for (const status of ["failed", "blocked", "not_run"]) {
  test(`public prepare withholds dark opt-in when qualification is ${status}`, async (t) => {
    const { configDirectory, runtime } =
      await createRuntimeWithCopiedFlowConfig(t, `prepare-${status}`);
    const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const qualification = ledger.evidence.find(({ id }) =>
      id === "deterministic_qualification");
    qualification.status = status;
    if (status === "not_run") {
      qualification.path = null;
      qualification.sha256 = null;
    }
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const rejection = await runtime.prepare({
      schema: "flow.feature-preparation-request/v1",
      mode: "verify",
      dark_opt_in: DARK_OPT_IN,
    });

    assertQualificationWithheld(rejection, "prepare");
  });
}

test("public launch withholds dark opt-in when qualification has a defect", async (t) => {
  const { configDirectory, runtime } =
    await createRuntimeWithCopiedFlowConfig(t, "launch-defect");
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.defects.push("injected_qualification_defect");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = runtime.launch({
    prepared: {
      kind: "predefined",
      definition: { id: "feature/v1" },
      selection: { inputs: { mode: "verify" } },
    },
    dark_opt_in: DARK_OPT_IN,
  });

  assertQualificationWithheld(rejection, "launch");
});

test("public prepare withholds tampered transition evidence from its configured authority", async (t) => {
  const { configDirectory, runtime } =
    await createRuntimeWithCopiedFlowConfig(t, "prepare-tampered");
  const evidencePath = join(
    configDirectory,
    "evidence/release-qualification.v1.json",
  );
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.status = "withdrawn";
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, evidenceBytes);
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "deterministic_qualification").sha256 =
    createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
  });

  assertQualificationWithheld(rejection, "prepare");
});

for (const status of ["failed", "blocked", "not_run"]) {
  test(`public prepare withholds dark opt-in when production route qualification is ${status}`, async (t) => {
    const { configDirectory, runtime } =
      await createRuntimeWithCopiedFlowConfig(t, `phase2-prepare-${status}`);
    const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const phase2 = ledger.evidence.find(({ id }) =>
      id === "production_route_conformance");
    phase2.status = status;
    if (status === "not_run") {
      phase2.path = null;
      phase2.sha256 = null;
    } else {
      const evidencePath = join(configDirectory, phase2.path);
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      evidence.status = status;
      const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
      await writeFile(evidencePath, evidenceBytes);
      phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    }
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const rejection = await runtime.prepare({
      schema: "flow.feature-preparation-request/v1",
      mode: "verify",
      dark_opt_in: DARK_OPT_IN,
    });

    assertQualificationWithheld(rejection, "prepare");
  });
}

test("public launch requires passed phase-two production conformance", async (t) => {
  const { configDirectory, runtime } =
    await createRuntimeWithCopiedFlowConfig(t, "phase2-launch-blocked");
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  phase2.status = "blocked";
  const evidencePath = join(configDirectory, phase2.path);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.status = "blocked";
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBytes);
  phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = runtime.launch({
    prepared: {
      kind: "predefined",
      definition: { id: "feature/v1" },
      selection: { inputs: { mode: "verify" } },
    },
    dark_opt_in: DARK_OPT_IN,
  });

  assertQualificationWithheld(rejection, "launch");
});

test("phase-two recipe tampering with a refreshed evidence hash withholds public admission", async (t) => {
  const { configDirectory, runtime } =
    await createRuntimeWithCopiedFlowConfig(t, "phase2-recipe-tamper");
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  const evidencePath = join(configDirectory, phase2.path);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.recipe.commands[0].command += " --changed";
  evidence.recipe.digest = canonicalDigest(evidence.recipe.commands);
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBytes);
  phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
  });

  assertQualificationWithheld(rejection, "prepare");
});

test("ordinary request and environment inputs cannot activate phase-two generation", async (t) => {
  const marker = "b".repeat(64);
  const { configDirectory, runtime } =
    await createRuntimeWithCopiedFlowConfig(t, "phase2-generation-inputs", {
      environment: {
        FLOW_PRODUCTION_ROUTE_CONFORMANCE_SESSION: "1",
        FLOW_PRODUCTION_ROUTE_CONFORMANCE_MARKER: marker,
      },
    });
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase1 = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  const evidencePath = join(configDirectory, phase2.path);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.status = "running";
  evidence.phase1_evidence_sha256 = phase1.sha256;
  evidence.generation_id = "00000000-0000-4000-8000-000000000001";
  evidence.generation_binding_sha256 = createHash("sha256")
    .update(marker)
    .digest("hex");
  evidence.recipe = null;
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBytes);
  phase2.status = "not_run";
  phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
    qualification_phase2_session: {
      authority_directory: configDirectory,
      marker,
    },
  });

  assertQualificationWithheld(rejection, "prepare");
});

test("public module imports cannot mint phase-two generation authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-phase2-import-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repositoryRoot = join(scratch, "repository");
  await execFile("git", ["clone", "--quiet", "--no-local", REPOSITORY_ROOT,
    repositoryRoot]);
  const configDirectory = join(repositoryRoot, "config/flow");
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase1 = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  const evidencePath = join(configDirectory, phase2.path);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const marker = "c".repeat(64);
  evidence.status = "running";
  evidence.phase1_evidence_sha256 = phase1.sha256;
  evidence.generation_id = "00000000-0000-4000-8000-000000000002";
  evidence.generation_binding_sha256 =
    productionRouteConformanceSessionBinding({
      authorityDirectory: configDirectory,
      generationId: evidence.generation_id,
      marker,
    });
  evidence.recipe = null;
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBytes);
  phase2.status = "not_run";
  phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const sessionModule = await import(
    "../../../tools/flow/src/qualification-phase2-session.mjs"
  );
  const exportedMint = sessionModule.createProductionRouteConformanceSession;
  const forgedSession = typeof exportedMint === "function"
    ? exportedMint({ authorityDirectory: configDirectory, marker })
    : { authorityDirectory: configDirectory, marker };
  const runtime = createFlowRuntime({
    env: {
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
      FLOW_CONFIG_DIRECTORY: configDirectory,
      FLOW_REPOSITORY_ROOT: repositoryRoot,
    },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
    qualificationPhase2Session: forgedSession,
  });
  t.after(() => closeFlowRuntime(runtime));

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
  });

  assert.equal(exportedMint, undefined);
  assertQualificationWithheld(rejection, "prepare");
});

test("public admission withholds qualification captured on another host", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-foreign-host-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repositoryRoot = join(scratch, "repository");
  await execFile("git", ["clone", "--quiet", "--no-local", REPOSITORY_ROOT,
    repositoryRoot]);
  const configDirectory = join(repositoryRoot, "config/flow");
  const runtime = createFlowRuntime({
    env: {
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
      FLOW_CONFIG_DIRECTORY: configDirectory,
      FLOW_REPOSITORY_ROOT: repositoryRoot,
    },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase1 = ledger.evidence.find(({ id }) =>
    id === "deterministic_qualification");
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  const phase1Path = join(configDirectory, phase1.path);
  const phase1Evidence = JSON.parse(await readFile(phase1Path, "utf8"));
  phase1Evidence.environment.os = process.platform === "darwin" ? "linux" : "darwin";
  const phase1Bytes = Buffer.from(`${JSON.stringify(phase1Evidence, null, 2)}\n`);
  await writeFile(phase1Path, phase1Bytes);
  phase1.sha256 = createHash("sha256").update(phase1Bytes).digest("hex");

  const phase2Path = join(configDirectory, phase2.path);
  const phase2Evidence = JSON.parse(await readFile(phase2Path, "utf8"));
  phase2Evidence.environment.os = phase1Evidence.environment.os;
  phase2Evidence.phase1_evidence_sha256 = phase1.sha256;
  const phase2Bytes = Buffer.from(`${JSON.stringify(phase2Evidence, null, 2)}\n`);
  await writeFile(phase2Path, phase2Bytes);
  phase2.sha256 = createHash("sha256").update(phase2Bytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
  });

  assertQualificationWithheld(rejection, "prepare");
});

test("public preparation preserves blocked Drovr compatibility details", async (t) => {
  const delegatedAgentPort = {
    async describe() {
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "blocked",
        watermark: null,
        description: null,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: "compatibility_blocked",
          findings: [{ field: "model", reason: "changed" }],
        },
        legal_next_actions: ["refresh_compatibility", "run_drovr_doctor"],
      };
    },
  };
  const { scratch, runtime } = await createRuntimeWithCopiedFlowConfig(
    t,
    "blocked-drovr-compatibility",
    { delegatedAgentPort },
  );
  const repository = join(scratch, "candidate-repository");
  await initializeCleanTestRepository(repository);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:blocked-drovr",
      summary: "Check blocked Drovr admission",
      acceptance: ["the host preserves compatibility evidence"],
    },
    repository: { path: repository },
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "prepare");
  assert.equal(rejection.code, "compatibility_blocked");
  assert.equal(rejection.outcome, "unsupported");
  assert.deepEqual(rejection.findings, [{ field: "model", reason: "changed" }]);
  assert.deepEqual(rejection.legal_actions, [
    "refresh_compatibility",
    "run_drovr_doctor",
  ]);
});

test("public preparation normalizes real Drovr feature findings to the rejection contract", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-drovr-feature-findings-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const delegatedAgentPort = createDrovrDelegatedAgentPort({
    dependencies: repositoryDrovrDependencies(),
    async describeDrovr(request, dependencies) {
      const description = await supportedDescription(request, dependencies);
      description.feature_advertisement.features.shift();
      rebindDescriptionDigest(description);
      return description;
    },
  });
  const configDirectory = process.env.FLOW_CONFIG_DIRECTORY ??
    FLOW_CONFIG_DIRECTORY;
  const runtime = createFlowRuntime({
    env: {
      ...process.env,
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
      FLOW_CONFIG_DIRECTORY: configDirectory,
      FLOW_REPOSITORY_ROOT: process.env.FLOW_REPOSITORY_ROOT ?? REPOSITORY_ROOT,
    },
    delegatedAgentPort,
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const repository = join(scratch, "candidate-repository");
  await initializeCleanTestRepository(repository);

  const rejection = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:public-drovr-feature-findings",
      summary: "Reject an incompatible real Drovr feature advertisement",
      acceptance: ["the public boundary preserves typed feature findings"],
    },
    repository: { path: repository },
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "prepare");
  assert.equal(rejection.code, "incompatible_feature_advertisement");
  assert.equal(rejection.outcome, "unsupported");
  assert.deepEqual(rejection.findings, [{
    field: "feature_advertisement.exact_launch_description",
    reason: "missing",
  }]);
  assert.deepEqual(rejection.legal_actions, [
    "repair_delegated_runtime_contract",
    "refresh_delegated_runtime_description",
  ]);
  const rejectionSchema = JSON.parse(await readFile(
    join(FLOW_CONFIG_DIRECTORY, "schemas/flow.rejection.v1.schema.json"),
    "utf8",
  ));
  const rejectionAjv = new Ajv2020({ allErrors: true, strict: true });
  rejectionAjv.addSchema(JSON.parse(await readFile(
    join(FLOW_CONFIG_DIRECTORY, "schemas/flow.authority-fact.v1.schema.json"),
    "utf8",
  )));
  const validateRejection = rejectionAjv.compile(rejectionSchema);
  assert.equal(validateRejection(rejection), true,
    rejectionAjv.errorsText(validateRejection.errors));
});

test("public dynamic prepare requires explicit dark opt-in", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-dynamic-prepare-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const rejection = runtime.prepare(dynamicCheckpointProposal());

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "prepare");
  assert.equal(rejection.code, "dark_opt_in_required");
  assert.equal(rejection.outcome, "disabled");
});

test("public dynamic plans cannot classify a mixed feature and push graph as feature verify", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-dynamic-mixed-route-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const proposal = dynamicCheckpointProposal();
  const contracts = [
    ["verify", "flow.operation/feature-verify/v1"],
    ["push", "flow.operation/git-push/v1"],
  ];
  proposal.graph.cards = contracts.map(([id, contract]) => ({
    id,
    operation_contract: contract,
    executor: { kind: "operation", contract },
    dependencies: [],
    inputs: {},
    outputs: [],
    success_criteria: ["operation_completed"],
    validators: [],
    data_references: [],
    evidence_references: [],
    route: null,
    limits: {},
    resource_claims: [],
    recovery: "reconcile",
  }));

  const rejection = runtime.prepare({
    ...proposal,
    dark_opt_in: DARK_OPT_IN,
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "prepare");
  assert.equal(rejection.code, "route_unsupported");
  assert.equal(rejection.outcome, "unsupported");
});

test("public feature verify rejects an exact-definition graph with a registered push executor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-mixed-predefined-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    registeredOperations: {
      "flow.operation/git-push/v1": {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke() {
          throw new Error("a forbidden push operation must not run");
        },
      },
    },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const rejection = runtime.launch({
    prepared: {
      kind: "predefined",
      definition: { id: "feature/v1" },
      selection: { inputs: { mode: "verify" } },
      graph: {
        cards: [
          {
            id: "feature-verify",
            executor: {
              kind: "operation",
              contract: "flow.operation/feature-verify/v1",
              effect_classification: "caller_idempotent",
            },
          },
          {
            id: "remote-push",
            executor: {
              kind: "operation",
              contract: "flow.operation/git-push/v1",
              effect_classification: "caller_idempotent",
            },
          },
        ],
      },
    },
    dark_opt_in: DARK_OPT_IN,
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "launch");
  assert.equal(rejection.code, "route_unavailable");
  assert.equal(rejection.outcome, "unsupported");
  assert.match(rejection.reason, /flow\.operation\/git-push\/v1/u);
});

test("public dynamic prepare with opt-in is unsupported", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-dynamic-opt-in-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const rejection = runtime.prepare({
    ...dynamicCheckpointProposal(),
    dark_opt_in: DARK_OPT_IN,
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "prepare");
  assert.equal(rejection.code, "route_unsupported");
  assert.equal(rejection.outcome, "unsupported");
});

test("public launch with opt-in rejects a prepared dynamic plan", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-dynamic-launch-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const coreRuntime = createCoreFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  const prepared = coreRuntime.prepare(dynamicCheckpointProposal());
  assert.equal(prepared.schema, "flow.prepared-run/v1");

  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const rejection = runtime.launch({
    ...confirmedLaunchRequest(prepared),
    dark_opt_in: DARK_OPT_IN,
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, "launch");
  assert.equal(rejection.code, "route_unsupported");
  assert.equal(rejection.outcome, "unsupported");
});

test("public prepare requires explicit dark opt-in and classifies disabled scope", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-release-gate-prepare-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const missing = runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
  });
  assert.equal(missing.schema, "flow.rejection/v1");
  assert.equal(missing.operation, "prepare");
  assert.equal(missing.code, "dark_opt_in_required");
  assert.equal(missing.outcome, "disabled");

  const disabled = runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "test",
    dark_opt_in: DARK_OPT_IN,
  });
  assert.equal(disabled.schema, "flow.rejection/v1");
  assert.equal(disabled.code, "route_disabled");
  assert.equal(disabled.outcome, "disabled");
});

test("public launch cannot bypass disabled or unsupported release routes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-release-gate-launch-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  for (const [definition, inputs, code, outcome] of [
    ["feature/v1", { mode: "mixed" }, "route_disabled", "disabled"],
    ["spike/v1", {}, "route_disabled", "disabled"],
    ["review/v1", {
      target: { schema: "flow.review-github-pull-request/v1" },
    }, "route_unsupported", "unsupported"],
  ]) {
    const result = runtime.launch({
      prepared: {
        kind: "predefined",
        definition: { id: definition },
        selection: { inputs },
      },
      dark_opt_in: DARK_OPT_IN,
    });
    assert.equal(result.schema, "flow.rejection/v1");
    assert.equal(result.operation, "launch");
    assert.equal(result.code, code);
    assert.equal(result.outcome, outcome);
  }
});

test("public dark feature verify fails closed when its production operation is unavailable", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-release-gate-adapter-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    registeredOperations: {
      "flow.operation/feature-verify/v1": null,
    },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const result = runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
  });
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "route_unavailable");
  assert.equal(result.outcome, "unsupported");
});

test("public local review rejects forged extra operation and delegate cards before launch", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-review-forged-executor-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  for (const extraCard of [
    {
      id: "remote-push",
      executor: {
        kind: "operation",
        contract: "flow.operation/git-push/v1",
      },
    },
    {
      id: "unlisted-delegate",
      executor: {
        kind: "delegate",
        contract: "flow.delegated-agent-port/v1",
      },
    },
  ]) {
    const rejection = runtime.launch({
      prepared: {
        kind: "predefined",
        definition: {
          id: "review/v1",
          contract: "flow.definition/review/v1",
        },
        selection: {
          inputs: {
            target: { schema: "flow.review-local-candidate/v1" },
            lenses: ["security"],
          },
        },
        graph: {
          cards: [
            {
              id: "review-lens-security",
              executor: {
                kind: "delegate",
                contract: "flow.delegated-agent-port/v1",
              },
            },
            {
              id: "review-critic",
              executor: {
                kind: "delegate",
                contract: "flow.delegated-agent-port/v1",
              },
            },
            {
              id: "review-record",
              executor: {
                kind: "operation",
                contract: "flow.operation/review-record/v1",
              },
            },
            extraCard,
          ],
        },
      },
      dark_opt_in: DARK_OPT_IN,
    });

    assert.equal(rejection.schema, "flow.rejection/v1");
    assert.equal(rejection.operation, "launch");
    assert.equal(rejection.code, "route_unavailable");
    assert.equal(rejection.outcome, "unsupported");
    assert.match(rejection.reason, /unlisted_executor/u);
  }
});

test("public verify plans requiring unavailable setup or test operations are rejected before launch", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-verify-unavailable-setup-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const setup = {
    schema: "flow.feature-setup/v1",
    id: "setup:test",
    description: "test setup",
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
  const slices = [{
    schema: "flow.feature-slice/v1",
    id: "slice:test",
    mode: "test",
  }];

  const prepared = runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    mode: "verify",
    setup,
    slices,
    dark_opt_in: DARK_OPT_IN,
  });
  assert.equal(prepared.schema, "flow.rejection/v1");
  assert.equal(prepared.operation, "prepare");
  assert.equal(prepared.code, "route_unavailable");
  assert.equal(prepared.outcome, "unsupported");
  assert.match(prepared.reason, /feature-setup/u);
  assert.match(prepared.reason, /feature-test/u);

  const launch = runtime.launch({
    prepared: {
      schema: "flow.prepared-run/v1",
      kind: "predefined",
      definition: { id: "feature/v1" },
      selection: { inputs: { mode: "verify", setup, slices } },
      graph: {
        cards: [
          {
            id: "feature-setup",
            executor: {
              kind: "operation",
              contract: "flow.operation/feature-setup/v1",
            },
          },
          {
            id: "feature-test",
            executor: {
              kind: "operation",
              contract: "flow.operation/feature-test/v1",
            },
          },
        ],
      },
    },
    dark_opt_in: DARK_OPT_IN,
  });
  assert.equal(launch.schema, "flow.rejection/v1");
  assert.equal(launch.operation, "launch");
  assert.equal(launch.code, "route_unavailable");
  assert.equal(launch.outcome, "unsupported");
  assert.match(launch.reason, /feature-setup/u);
  assert.match(launch.reason, /feature-test/u);
});

const execFile = promisify(execFileCallback);

test("short-lived default runtime does not retain a polling handle", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-liveness-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtimeModule = new URL("../src/runtime.mjs", import.meta.url).href;
  const script = [
    `const { createFlowRuntime } = await import(${JSON.stringify(runtimeModule)});`,
    `createFlowRuntime({ env: ${JSON.stringify({
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
    })} });`,
  ].join("\n");

  await execFile(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 1_500,
  });
});

test("production runner capacity is bounded and exposed through a named query", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-runner-status-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: {
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
      FLOW_RUNNER_DELEGATE_CAPACITY: "3",
    },
    runnerOptions: { operationCapacity: 2 },
  });
  t.after(() => closeFlowRuntime(runtime));

  const status = await runtime.query({
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
  });
  assert.equal(status.schema, "flow.runtime-runner-status/v1");
  assert.equal(status.delegates.capacity, 3);
  assert.equal(status.operations.capacity, 2);

  for (const value of [0, -1, 65, "nope", 1.5]) {
    assert.throws(
      () => createFlowRuntime({
        env: {
          HOME: scratch,
          XDG_STATE_HOME: join(scratch, `invalid-${String(value)}`),
          FLOW_RUNNER_DELEGATE_CAPACITY: String(value),
        },
        autonomous: false,
      }),
      /delegateCapacity.*integer between 1 and 64/u,
    );
  }
});

test("production runner capacity defaults, overrides, and rejects invalid values", async (t) => {
  assert.deepEqual(normalizeProductionRunnerOptions({ env: {} }), {});
  assert.deepEqual(normalizeProductionRunnerOptions({
    env: {
      FLOW_RUNNER_DELEGATE_CAPACITY: "3",
      FLOW_RUNNER_OPERATION_CAPACITY: "4",
    },
    runnerOptions: { delegateCapacity: 5 },
  }), {
    delegateCapacity: 5,
    operationCapacity: 4,
  });

  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-runner-default-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
  });
  t.after(() => closeFlowRuntime(runtime));
  const status = await runtime.query({
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
  });
  assert.equal(status.delegates.capacity, 1);
  assert.equal(status.operations.capacity, 1);

  for (const [key, variable] of [
    ["delegateCapacity", "FLOW_RUNNER_DELEGATE_CAPACITY"],
    ["operationCapacity", "FLOW_RUNNER_OPERATION_CAPACITY"],
  ]) {
    for (const value of [0, 65, 1.5, "nope"]) {
      assert.throws(
        () => normalizeProductionRunnerOptions({
          env: { [variable]: typeof value === "string" ? value : String(value) },
        }),
        new RegExp(`${key}.*integer between 1 and 64`),
      );
    }
  }
});

test("awaited public authority watch keeps the process alive until it closes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-watch-liveness-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtimeModule = new URL("../src/runtime.mjs", import.meta.url).href;
  const authorityModule = new URL(
    "../../../tools/flow/src/run-authority.mjs",
    import.meta.url,
  ).href;
  const script = [
    `const { createFlowRuntime } = await import(${JSON.stringify(runtimeModule)});`,
    `const { createDurableRunAuthority } = await import(${JSON.stringify(authorityModule)});`,
    `const authority = createDurableRunAuthority({ authorityDirectory: ${JSON.stringify(join(scratch, "state"))} });`,
    `const runtime = createFlowRuntime({ runAuthority: authority, autonomous: false, delegatedAgentPort: { describe: async () => null } });`,
    `const watcher = runtime.watch({ host: true });`,
    `const initial = await watcher.next();`,
    `if (initial.done) throw new Error("authority watch closed before its initial projection");`,
    `const timer = setTimeout(() => authority.close(), 100);`,
    `timer.unref();`,
    `const closed = await watcher.next();`,
    `if (!closed.done) throw new Error("authority watch did not close");`,
  ].join("\n");

  await execFile(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 2_000,
  });
});

test("shared production runtimes retain one authority until the last close", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-authority-sharing-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const options = {
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  };
  const runtimeA = createFlowRuntime(options);
  const runtimeB = createFlowRuntime(options);

  assert.equal(closeFlowRuntime(runtimeA), true);
  assert.equal(closeFlowRuntime(runtimeA), false);
  assert.doesNotThrow(() => runtimeB.query());
  assert.equal(closeFlowRuntime(runtimeB), true);
  assert.throws(() => runtimeB.query(), /durable run authority is closed/u);
});

test("shared production authority rejects incompatible options while retained", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-authority-options-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const base = {
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  };
  const runtime = createFlowRuntime({
    ...base,
    authorityOptions: { declaredCapacity: 1 },
  });
  t.after(() => closeFlowRuntime(runtime));

  assert.throws(
    () => createFlowRuntime({
      ...base,
      authorityOptions: { declaredCapacity: 2 },
    }),
    (error) => error?.code === "authority_options_conflict",
  );
});

test("shared production authority rejects distinct caller-supplied adapters", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-authority-adapters-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const base = {
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  };
  const adapterFactories = {
    rebootObservationAdapter: () => ({ observe() {} }),
    gitWorkspaceObservationAdapter: () => ({ observe() {} }),
    gitRetentionAdapter: () => ({ observe() {}, retain() {} }),
  };

  for (const [key, createAdapter] of Object.entries(adapterFactories)) {
    const runtime = createFlowRuntime({
      ...base,
      authorityDirectory: join(scratch, key),
      authorityOptions: { [key]: createAdapter() },
    });
    t.after(() => closeFlowRuntime(runtime));
    assert.throws(
      () => createFlowRuntime({
        ...base,
        authorityDirectory: join(scratch, key),
        authorityOptions: { [key]: createAdapter() },
      }),
      (error) => error?.code === "authority_options_conflict",
    );
  }
});

test("failed production construction releases its authority lease", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-authority-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const base = {
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  };

  assert.throws(
    () => createFlowRuntime({
      ...base,
      registeredAuthorities: { invalid: {} },
    }),
    /registered authority/u,
  );

  const runtime = createFlowRuntime(base);
  t.after(() => closeFlowRuntime(runtime));
  assert.equal(closeFlowRuntime(runtime), true);
  assert.throws(() => runtime.query(), /durable run authority is closed/u);
});

test("failed production construction releases an additional shared lease", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-runtime-authority-shared-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const base = {
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: { describe: async () => null },
    autonomous: false,
  };
  const runtime = createFlowRuntime(base);
  t.after(() => closeFlowRuntime(runtime));

  assert.throws(
    () => createFlowRuntime({
      ...base,
      registeredAuthorities: { invalid: {} },
    }),
    /registered authority/u,
  );

  assert.equal(closeFlowRuntime(runtime), true);
  assert.throws(() => runtime.query(), /durable run authority is closed/u);
});

test("query exposes the DelegatedAgentPort description without creating a run", async () => {
  const projection = {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "compatible",
    watermark: {
      schema: "drovr.authority-watermark/v1",
      authority: "drovr.configuration-catalog",
      content_sha256: `sha256:${"1".repeat(64)}`,
    },
    description: { description_digest: `sha256:${"2".repeat(64)}` },
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: null,
      findings: [],
    },
    legal_next_actions: ["bind_exact_launch_description"],
  };
  const delegatedAgentPort = {
    async describe(request) {
      assert.deepEqual(request, {
        schema: "flow.delegated-agent-description-request/v1",
        launch: { harness: "codex", capability: "read-only" },
        caller_metadata: { run_id: "run:example", card_id: "review" },
      });
      return projection;
    },
  };
  const runtime = createFlowRuntime({ delegatedAgentPort });
  const before = runtime.query();

  assert.deepEqual(await runtime.query({
    schema: "flow.query/v1",
    query: "delegated_agent_description",
    launch: { harness: "codex", capability: "read-only" },
    caller_metadata: { run_id: "run:example", card_id: "review" },
  }), projection);
  assert.deepEqual(runtime.query(), before);
});

test("injected non-autonomous runtime rejects delegate effects without durable authority", async () => {
  const description = await delegateDescription();
  const runtime = createCoreFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    delegatedAgentPort: delegatePort(),
    delegateOutputValidators: delegateValidators(),
  });
  const prepared = runtime.prepare(delegateCardProposal(description));

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "durable_authority_required");
  assert.deepEqual(runtime.query().runs, []);
});

test("core runtime wires exact delegate execution through its composition root", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runtime-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-runtime"),
    timeObservationAdapter: fixedExecutionTimeAdapter({ bootId: "boot-a" }),
  });
  t.after(() => runAuthority.close());
  const description = await delegateDescription();
  let callerKey;
  const runtime = createCoreFlowRuntime({
    runAuthority,
    delegatedAgentPort: delegatePort({
      async dispatch(request) {
        callerKey = request.caller_key;
        return workingDelegateProjection(request);
      },
      async wait() {
        return completedTurnProjection({ callerKey, description });
      },
    }),
    delegateOutputValidators: delegateValidators(),
    autonomous: false,
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1");
  const checkpoint = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ decision }) => decision === "approve");
  assert.ok(checkpoint);
  runtime.command(checkpoint);
  const execute = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "delegate_execute");
  assert.ok(execute);

  runtime.command(execute);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(runAuthority.query(launch.run_id).phase, "succeeded");
  assert.equal(completed.delegate_attempts[0].status, "accepted");
  assert.equal(callerKey, `${launch.run_id}:delegate-review:attempt:1`);
});

for (const [label, mutate, expectedFinding] of [
  [
    "missing",
    (description) => description.feature_advertisement.features.shift(),
    { feature_id: "exact_launch_description", reason: "missing" },
  ],
  [
    "weakened",
    (description) => {
      description.feature_advertisement.features[0].guarantees.pop();
    },
    { feature_id: "exact_launch_description", reason: "weakened" },
  ],
  [
    "contradictory",
    (description) => {
      description.feature_advertisement.features[0].authority =
        "delegated_runtime";
    },
    { feature_id: "exact_launch_description", reason: "contradictory" },
  ],
]) {
  test(`query exposes ${label} Drovr conformance and recovery`, async () => {
    let repaired = false;
    const delegatedAgentPort = createDrovrDelegatedAgentPort({
      dependencies: repositoryDrovrDependencies(),
      async describeDrovr(request, dependencies) {
        const description = await supportedDescription(request, dependencies);
        if (!repaired) {
          mutate(description);
          rebindDescriptionDigest(description);
        }
        return description;
      },
    });
    const runtime = createFlowRuntime({ delegatedAgentPort });

    const blocked = await runtime.query(delegatedAgentQuery());

    assert.equal(blocked.status, "blocked");
    assert.equal(
      blocked.compatibility.code,
      "incompatible_feature_advertisement",
    );
    assert.deepEqual(blocked.compatibility.findings, [expectedFinding]);
    assert.deepEqual(blocked.legal_next_actions, [
      "repair_delegated_runtime_contract",
      "refresh_delegated_runtime_description",
    ]);

    repaired = true;
    const recovered = await runtime.query(delegatedAgentQuery());
    assert.equal(recovered.status, "compatible");
    assert.deepEqual(recovered.compatibility.findings, []);
  });
}

test("query exposes unavailable Drovr descriptions and recovery", async () => {
  let repaired = false;
  const delegatedAgentPort = createDrovrDelegatedAgentPort({
    dependencies: repositoryDrovrDependencies(),
    async describeDrovr(request, dependencies) {
      if (!repaired) throw new Error("configuration offline");
      return supportedDescription(request, dependencies);
    },
  });
  const runtime = createFlowRuntime({ delegatedAgentPort });

  const blocked = await runtime.query(delegatedAgentQuery());

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "description_unavailable");
  assert.deepEqual(blocked.legal_next_actions, [
    "retry_delegated_runtime_description",
  ]);

  repaired = true;
  const recovered = await runtime.query(delegatedAgentQuery());
  assert.equal(recovered.status, "compatible");
});

test("query inventories retained legacy runs with a stable content digest", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-inventory-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const claudeRun = join(claudeRuns, "claude-1");
  await mkdir(join(claudeRun, "out"), { recursive: true });
  await writeFile(join(claudeRun, "brief.md"), "# Accepted brief\n");
  await writeFile(join(claudeRun, "out", "report.md"), "result\n");
  const runDirectory = join(hermesRuns, "run-1");
  const artifactDirectory = join(runDirectory, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: {
      run_id: "run-1",
      flow: "feature",
      external_root: { system: "github", id: "seavenly/dotfiles#4" },
    },
  });
  await writeFile(join(artifactDirectory, "journal.md"), "verified notes\n");
  const materialization = join(runDirectory, "materialization.json");
  await writeJson(materialization, { retained_note: "first" });

  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns,
      hermesStacks: join(scratch, "agent-flow", "stacks"),
    },
  });
  const request = {
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  };
  const beforeQuery = await snapshotFiles(scratch);

  const first = await runtime.query(request);
  const second = await runtime.query(request);

  assert.equal(first.schema, "flow.legacy-compatibility-inventory/v1");
  assert.equal(first.watermark.content_sha256, second.watermark.content_sha256);
  assert.match(first.watermark.content_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.inventory.runs.map(({ id }) => id), [
    "claude-agent-teams:claude-1",
    "hermes-agent-flow:run-1",
  ]);
  assert.deepEqual(first.inventory.artifacts.map(({ path }) => path), [
    "claude-1/out/report.md",
    "run-1/artifacts/journal.md",
    "run-1/materialization.json",
  ]);
  assert.deepEqual(await snapshotFiles(scratch), beforeQuery);
  await writeJson(materialization, { retained_note: "changed" });
  const changed = await runtime.query(request);
  assert.notEqual(changed.watermark.content_sha256, first.watermark.content_sha256);
});

test("query distinguishes legacy evidence states and exposes every retained domain", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-evidence-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const stacks = join(scratch, "agent-flow", "stacks");
  const runDirectory = join(hermesRuns, "run-verified");
  const artifacts = join(runDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await mkdir(stacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: {
      run_id: "run-verified",
      flow: "feature",
      external_root: { system: "github", id: "seavenly/dotfiles#4" },
    },
  });
  const transcript = join(artifacts, "native-session.jsonl");
  await writeFile(transcript, "{\"type\":\"result\"}\n");
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: transcript,
  });
  await writeJson(join(runDirectory, "delivery-state.json"), {
    schema: "agent-flow.delivery-state/v1",
    applied_layers: [{
      retarget: { request_id: "retarget-1", status: "pending" },
    }],
    pending_completion_pr: { request_id: "completion-1" },
  });
  await writeFile(join(artifacts, "summary.md"), "summary\n");
  await writeJson(join(artifacts, "review.json"), {
    schema: "agent-flow.local-review/v1",
    run_id: "run-verified",
    artifacts: {
      review_summary: join(artifacts, "summary.md"),
      verification: join(artifacts, "missing-verification.json"),
    },
    review: { status: "approved", generation: 2 },
  });
  await writeJson(join(stacks, "stack.state.json"), {
    schema: "agent-flow.stack-state/v1",
    run_id: "stack-1",
    generation: 1,
    status: "publish_failed",
    error: "receipt unavailable",
  });
  const malformed = join(hermesRuns, "run-unreadable");
  await mkdir(malformed, { recursive: true });
  await writeFile(join(malformed, "run.json"), "not-json\n");
  const unknown = join(hermesRuns, "run-uncertain");
  await mkdir(unknown, { recursive: true });
  await writeJson(join(unknown, "run.json"), {
    schema: "agent-flow.run/v999",
    identity: { run_id: "run-uncertain" },
  });

  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-agent-teams"),
      hermesRuns,
      hermesStacks: stacks,
    },
  });
  const projection = await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  });

  assert.ok(projection.inventory.evidence_summary.verified > 0);
  assert.ok(projection.inventory.evidence_summary.missing > 0);
  assert.ok(projection.inventory.evidence_summary.unreadable > 0);
  assert.ok(projection.inventory.evidence_summary.uncertain > 0);
  assert.deepEqual(projection.inventory.reviews.map(({ id }) => id), [
    "hermes-agent-flow:run-verified:review",
  ]);
  assert.deepEqual(projection.inventory.stacks.map(({ id }) => id), [
    "hermes-agent-flow-stack:stack-1:generation-1",
  ]);
  assert.equal(
    projection.inventory.transcript_pointers
      .find(({ id }) => id.endsWith("materialization.json:transcript_path"))
      ?.evidence_status,
    "verified",
  );
  assert.equal(
    projection.inventory.transcript_pointers
      .filter(({ reason }) => reason === "retained_run_has_no_transcript_pointer")
      .length,
    2,
  );
  assert.deepEqual(projection.inventory.active_ownership, [{
    evidence_status: "uncertain",
    id: "github:seavenly/dotfiles#4",
    owner: "hermes-agent-flow:run-verified",
    reason: "terminal_state_not_recorded_in_retained_manifest",
    state: "uncertain",
  }]);
  assert.deepEqual(
    projection.inventory.unresolved_effects.map(({ kind }) => kind).sort(),
    ["completion_pr", "retarget", "stack_publication"],
  );
  assert.ok(projection.legal_next_actions.includes("inspect_legacy_evidence"));
  assert.ok(!projection.legal_next_actions.some((action) =>
    /import|migrate|repair/u.test(action)
  ));
});

test("query retains unreadable and uncertain review and stack evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-records-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const stacks = join(scratch, "agent-flow", "stacks");
  for (const [runId, review] of [
    ["broken-review", "not-json\n"],
    ["unknown-review", `${JSON.stringify({ schema: "agent-flow.local-review/v999" })}\n`],
  ]) {
    const runDirectory = join(hermesRuns, runId);
    await mkdir(join(runDirectory, "artifacts"), { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      schema: "agent-flow.run/v1",
      identity: { run_id: runId, flow: "feature", external_root: null },
    });
    await writeFile(join(runDirectory, "artifacts", "review.json"), review);
  }
  await mkdir(stacks, { recursive: true });
  await writeFile(join(stacks, "broken.state.json"), "not-json\n");
  await writeJson(join(stacks, "unknown.state.json"), {
    schema: "agent-flow.stack-state/v999",
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
      hermesStacks: stacks,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.reviews.map(({ evidence_status }) => evidence_status),
    ["unreadable", "uncertain"],
  );
  assert.deepEqual(
    projection.inventory.stacks.map(({ evidence_status }) => evidence_status),
    ["unreadable", "uncertain"],
  );
});

test("query exposes corrupt retained records instead of hiding evidence gaps", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-corrupt-record-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-corrupt");
  await mkdir(runDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-corrupt", flow: "delivery", external_root: null },
  });
  await writeFile(join(runDirectory, "delivery-state.json"), "not-json\n");
  await writeFile(join(runDirectory, "transition.receipt"), "retained receipt\n");

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-corrupt/delivery-state.json")
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "unreadable", reason: "invalid_json" }],
  );
  assert.ok(projection.inventory.evidence_summary.unreadable > 0);
  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-corrupt/transition.receipt")
      .map(({ evidence_status }) => evidence_status),
    ["verified"],
  );
  assert.ok(projection.legal_next_actions.includes("inspect_legacy_evidence"));
});

test("query uses locale-independent byte ordering for ledger stability", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-order-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  for (const run of ["run-a", "Run-b"]) {
    await mkdir(join(claudeRuns, run), { recursive: true });
    await writeFile(join(claudeRuns, run, "brief.md"), "# Brief\n");
  }

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.runs.map(({ id }) => id), [
    "claude-agent-teams:Run-b",
    "claude-agent-teams:run-a",
  ]);
});

test("query normalizes referenced artifacts without host paths or duplicates", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-paths-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-paths");
  const artifacts = join(runDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-paths", flow: "feature", external_root: null },
  });
  const summary = join(artifacts, "summary.md");
  await writeFile(summary, "summary\n");
  await writeJson(join(artifacts, "review.json"), {
    schema: "agent-flow.local-review/v1",
    artifacts: { review_summary: summary },
    review: { status: "review_ready", generation: 0 },
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.equal(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-paths/artifacts/summary.md").length,
    1,
  );
  assert.ok(projection.inventory.sources.every(({ path }) => path === undefined));
  assert.ok(projection.inventory.artifacts.every(({ path }) => !path.startsWith(scratch)));
});

test("query marks Claude transcript and ownership authority as uncertain", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-claude-authority-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const runDirectory = join(claudeRuns, "claude-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "brief.md"), [
    "---",
    "type: review",
    "---",
    "# Review brief",
    "",
  ].join("\n"));

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.active_ownership, [{
    evidence_status: "uncertain",
    id: "claude-agent-teams:claude-run:external-root",
    owner: "claude-agent-teams:claude-run",
    reason: "external_root_not_machine_readable_in_retained_brief",
    state: "uncertain",
  }]);
  assert.deepEqual(projection.inventory.transcript_pointers, [{
    evidence_status: "uncertain",
    id: "claude-agent-teams:claude-run:transcript",
    path: null,
    reason: "native_transcript_not_machine_linked_to_retained_run",
    run_id: "claude-agent-teams:claude-run",
    sha256: null,
  }]);
  assert.deepEqual(projection.inventory.reviews, [{
    evidence_status: "uncertain",
    generation: null,
    id: "claude-agent-teams:claude-run:review",
    path: "claude-run/brief.md",
    reason: "review_lifecycle_not_machine_readable_in_retained_brief",
    status: null,
  }]);
});

test("query reports unregistered operator stack paths as uncertain authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-stack-registry-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.sources.filter(({ id }) =>
      id === "hermes-agent-flow-stack-registry"
    ),
    [{
      entry_count: 0,
      evidence_status: "uncertain",
      id: "hermes-agent-flow-stack-registry",
      reason: "operator_supplied_stack_paths_are_not_registered",
    }],
  );
});

test("query preserves an uncertain transcript obligation for Hermes runs", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-hermes-transcript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-without-transcript");
  await mkdir(runDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-without-transcript", flow: "feature", external_root: null },
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.transcript_pointers, [{
    evidence_status: "uncertain",
    id: "hermes-agent-flow:run-without-transcript:transcript",
    path: null,
    reason: "retained_run_has_no_transcript_pointer",
    run_id: "hermes-agent-flow:run-without-transcript",
    sha256: null,
  }]);
});

test("query recovers when retained evidence is restored between observations", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const hermesStacks = join(scratch, "agent-flow", "configured-stacks");
  const runDirectory = join(hermesRuns, "run-recovery");
  const transcript = join(runDirectory, "artifacts", "native.jsonl");
  await mkdir(claudeRuns, { recursive: true });
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  await mkdir(hermesStacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-recovery", flow: "feature", external_root: null },
  });
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: transcript,
  });
  const runtime = createFlowRuntime({
    legacyRoots: { claudeRuns, hermesRuns, hermesStacks },
  });
  const request = { schema: "flow.query/v1", query: "legacy_compatibility_inventory" };

  const missing = await runtime.query(request);
  assert.equal(missing.inventory.transcript_pointers[0].evidence_status, "missing");
  await writeFile(transcript, '{"type":"result"}\n');
  const restored = await runtime.query(request);

  assert.equal(restored.inventory.transcript_pointers[0].evidence_status, "verified");
  assert.notEqual(restored.watermark.content_sha256, missing.watermark.content_sha256);
});

test("query keeps paths host-neutral while binding exact retained bytes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-host-stability-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  async function projectionAt(name) {
    const root = join(scratch, name);
    const hermesRuns = join(root, "state", "agent-flow", "runs");
    const runDirectory = join(hermesRuns, "run-stable");
    const artifacts = join(runDirectory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      schema: "agent-flow.run/v1",
      identity: { run_id: "run-stable", flow: "feature", external_root: null },
    });
    const summary = join(artifacts, "summary.md");
    await writeFile(summary, "same bytes\n");
    await writeJson(join(artifacts, "review.json"), {
      schema: "agent-flow.local-review/v1",
      artifacts: { review_summary: summary },
      review: { status: "review_ready", generation: 0 },
    });
    return createFlowRuntime({
      legacyRoots: {
        claudeRuns: join(root, "missing-claude-runs"),
        hermesRuns,
      },
    }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });
  }

  const first = await projectionAt("host-a");
  const second = await projectionAt("host-b");
  assert.deepEqual(
    first.inventory.artifacts.map(({ path }) => path),
    second.inventory.artifacts.map(({ path }) => path),
  );
  assert.notEqual(first.watermark.content_sha256, second.watermark.content_sha256);
});

test("query classifies symlinked and unreadable artifact evidence without following it", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-artifact-safety-"));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-safety");
  const artifacts = join(runDirectory, "artifacts");
  const locked = join(artifacts, "locked");
  t.after(async () => {
    await chmod(locked, 0o700).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });
  await mkdir(locked, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-safety", flow: "feature", external_root: null },
  });
  await writeFile(join(scratch, "outside.txt"), "must not be followed\n");
  await symlink(join(scratch, "outside.txt"), join(artifacts, "outside-link"));
  await writeFile(join(locked, "secret.txt"), "unreadable\n");
  await chmod(locked, 0o000);

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path.endsWith("outside-link"))
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  if (process.getuid?.() === 0) {
    t.diagnostic("root bypasses directory permission checks; EACCES assertion skipped");
  } else {
    assert.deepEqual(
      projection.inventory.artifacts
        .filter(({ path }) => path.endsWith("artifacts/locked"))
        .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
      [{ evidence_status: "unreadable", reason: "directory_unreadable" }],
    );
  }
});

test("query preserves non-file evidence outside artifact directories", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-run-entry-safety-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const hermesStacks = join(scratch, "agent-flow", "stacks");
  const runDirectory = join(hermesRuns, "run-entry-safety");
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  await mkdir(hermesStacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-entry-safety", flow: "feature", external_root: null },
  });
  await writeFile(join(scratch, "outside.txt"), "must not be followed\n");
  const outsideStackDirectory = join(scratch, "outside-stack-directory");
  await mkdir(outsideStackDirectory);
  const retainedLink = join(runDirectory, "retained-link");
  await symlink(join(scratch, "outside.txt"), retainedLink);
  await symlink(join(scratch, "outside.txt"), join(runDirectory, "artifacts", "review.json"));
  await symlink(join(scratch, "outside.txt"), join(runDirectory, "run-stack.json"));
  await symlink(join(scratch, "outside.txt"), join(hermesStacks, "configured-stack.json"));
  await symlink(outsideStackDirectory, join(hermesStacks, "previous"));
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: retainedLink,
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
      hermesStacks,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-entry-safety/retained-link")
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.transcript_pointers
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.reviews
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.stacks
      .map(({ evidence_status, path, reason }) => ({ evidence_status, path, reason })),
    [
      {
        evidence_status: "uncertain",
        path: "configured-stack.json",
        reason: "symbolic_link_not_followed",
      },
      {
        evidence_status: "uncertain",
        path: "previous",
        reason: "symbolic_link_not_followed",
      },
      {
        evidence_status: "uncertain",
        path: "run-entry-safety/run-stack.json",
        reason: "symbolic_link_not_followed",
      },
    ],
  );
});

test("source digest prunes only retained workspace directories", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-prune-depth-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-prune-depth");
  const nestedRepo = join(runDirectory, "artifacts", "repo");
  await mkdir(nestedRepo, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-prune-depth", flow: "feature", external_root: null },
  });
  const evidence = join(nestedRepo, "evidence.txt");
  await writeFile(evidence, "first\n");
  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  });
  const request = { schema: "flow.query/v1", query: "legacy_compatibility_inventory" };

  const first = await runtime.query(request);
  await writeFile(evidence, "changed\n");
  const changed = await runtime.query(request);
  const sourceDigest = (projection) => projection.inventory.sources
    .find(({ id }) => id === "hermes-agent-flow-runs").content_sha256;

  assert.notEqual(sourceDigest(first), sourceDigest(changed));
});

test("query rejects unsupported contracts and never repairs missing evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-read-only-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-1");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "run.json"), "not-json\n");
  const runtime = createFlowRuntime({
    autonomous: false,
    runAuthority: createInMemoryRunAuthority(),
    legacyRoots: {
      claudeRuns: join(scratch, "absent-claude-runs"),
      hermesRuns,
      hermesStacks: join(scratch, "absent-stacks"),
    },
  });
  const before = await snapshotFiles(scratch);

  const projection = await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  });

  assert.equal(projection.inventory.sources[0].evidence_status, "missing");
  assert.deepEqual(await snapshotFiles(scratch), before);
  assert.deepEqual(
    await runtime.query({ schema: "flow.query/v1", query: "repair_legacy" }),
    {
      schema: "flow.rejection/v1",
      operation: "query",
      code: "unsupported_query",
      reason: null,
      command_type: null,
      run_id: null,
      bundle_digest: null,
      authority_watermark: `sha256:${"0".repeat(64)}`,
      authority_watermark_domain: "host",
      legal_actions: [],
    },
  );
});

test("registered query failures use the shared typed rejection contract", async () => {
  const runtime = createFlowRuntime({
    autonomous: false,
    runAuthority: createInMemoryRunAuthority(),
    legacyAdapter: {
      async observe() {
        throw new Error("retained authority unavailable");
      },
    },
  });

  assert.deepEqual(Object.keys(runtime), [
    "prepare",
    "launch",
    "command",
    "query",
    "watch",
  ]);
  assert.deepEqual(await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  }), {
    schema: "flow.rejection/v1",
    operation: "query",
    code: "inventory_unavailable",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: `sha256:${"0".repeat(64)}`,
    authority_watermark_domain: "host",
    legal_actions: [],
  });
});

async function createRuntimeWithCopiedFlowConfig(
  t,
  label,
  {
    delegatedAgentPort = { describe: async () => null },
    environment = {},
  } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), `flow-public-config-${label}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const configDirectory = join(scratch, "flow");
  await cp(FLOW_CONFIG_DIRECTORY, configDirectory, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules"),
  });
  const runtime = createFlowRuntime({
    env: {
      ...environment,
      HOME: scratch,
      XDG_STATE_HOME: join(scratch, "state"),
      FLOW_CONFIG_DIRECTORY: configDirectory,
      FLOW_REPOSITORY_ROOT: REPOSITORY_ROOT,
    },
    delegatedAgentPort,
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  return { scratch, configDirectory, runtime };
}

async function initializeCleanTestRepository(repository) {
  await mkdir(repository, { recursive: true });
  await execFile("git", ["-C", repository, "init", "--quiet", "--initial-branch", "main"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "feature.txt"), "before\n");
  await execFile("git", ["-C", repository, "add", "feature.txt"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "initial"]);
}

function assertQualificationWithheld(rejection, operation) {
  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.operation, operation);
  assert.equal(rejection.code, "qualification_withheld");
  assert.equal(rejection.outcome, "disabled");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotFiles(root) {
  const snapshot = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    try {
      snapshot[name] = (await readFile(join(root, name))).toString("base64");
    } catch (error) {
      if (!["EISDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  return snapshot;
}

function delegatedAgentQuery() {
  return {
    schema: "flow.query/v1",
    query: "delegated_agent_description",
    launch: {
      harness: "codex",
      role: "reviewer",
      capability: "read-only",
    },
    caller_metadata: {
      run_id: "run:example",
      card_id: "review",
      attempt: 1,
    },
  };
}

async function delegateDescription() {
  return supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
}

function delegateValidators() {
  return {
    [DELEGATE_OUTPUT_VALIDATOR]: {
      validate(output) {
        return output === "accepted output";
      },
      evidenceSafety: validateDelegateEvidenceSafety,
    },
  };
}

function delegatePort(overrides = {}) {
  return {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "proven_absent",
        watermark: {
          schema: "drovr.registry-authority-watermark/v1",
          authority: "drovr.registry",
          turns_sha256: `sha256:${"0".repeat(64)}`,
        },
        delegation: null,
        turn: null,
        legal_next_actions: ["dispatch_exact_turn"],
      };
    },
    async dispatch(request) {
      return workingDelegateProjection(request);
    },
    async send() {},
    async observe() {},
    async wait() {},
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: `sha256:${"1".repeat(64)}`,
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: "task:delegate-review",
          group_id: "group:flow",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
    ...overrides,
  };
}

function workingDelegateProjection(request) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: `sha256:${"2".repeat(64)}`,
    },
    delegation: {
      agent_id: request.agent_id,
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: { id: "turn:delegate-review", status: "working" },
    legal_next_actions: ["wait_bounded"],
  };
}

async function until(assertion, timeoutMs = 2000) {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for Flow projection");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
