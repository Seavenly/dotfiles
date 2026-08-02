import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createGitRetentionAdapter,
  createGitWorkspaceObservationAdapter,
} from "../src/git-retention-adapter.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import {
  buildHumanAuthorityBinding,
  foldWorkStream,
  getArtifactAuthority,
  getResourceHandoffAuthority,
  getWorkspaceAuthority,
} from "../src/work-authority.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

const CLEANUP_OPERATION_CONTRACT = "flow.operation/resource-cleanup/v1";

test("obsolete handoff cleanup cannot release a newer workspace generation", () => {
  const generationTwoGit = promotedGitFacts();
  const generationThreeGit = {
    ...generationTwoGit,
    commit_sha: "5".repeat(40),
    tree_sha: "6".repeat(40),
  };
  const projection = foldWorkStream("workspace", "workspace:producer", [
    {
      payload: {
        type: "workspace_registered",
        registration: workspaceRegistration().registration,
        git_observation: { schema: "work.git-observation/v1", git: exactGitFacts() },
        registration_receipt: { registered: true },
      },
    },
    {
      payload: {
        type: "workspace_promoted",
        generation: 3,
        mutation_epoch: 9,
        git: generationThreeGit,
        git_observation: {
          schema: "work.git-observation/v1",
          git: generationThreeGit,
        },
        disposition: "producer_owned",
      },
    },
    {
      payload: {
        type: "workspace_handoff_retention_released",
        expected_generation: 2,
        expected_fingerprint: digestValue({ git: generationTwoGit }),
      },
    },
  ], `sha256:${"e".repeat(64)}`);

  assert.equal(projection.generation, 3);
  assert.equal(projection.disposition, "producer_owned");
});

test("WorkspaceAuthority and ArtifactAuthority register exact durable subjects", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "producer-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  assert.equal(workspaceAuthority.schema, "work.workspace-authority/v1");
  assert.equal(artifactAuthority.schema, "work.artifact-authority/v1");

  const unobserved = workspaceRegistration();
  unobserved.registration.git.commit_sha = "9".repeat(40);
  assert.equal(workspaceAuthority.command(unobserved).code,
    "workspace_git_facts_mismatch");

  const workspace = workspaceAuthority.command(workspaceRegistration());
  assert.equal(workspace.accepted, true);
  assert.equal(workspace.created, true);
  assert.deepEqual(workspaceAuthority.query({
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  }), {
    schema: "work.workspace-projection/v1",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    watermark: workspace.authority_watermark,
    generation: 1,
    registration_generation: 1,
    mutation_epoch: 7,
    repository: {
      canonical_id: "github.com/Seavenly/example",
    },
    workspace: {
      canonical_id: "workspace:producer",
      canonical_path: "/tmp/producer-worktree",
    },
    git: exactGitFacts(),
    git_observation: {
      schema: "work.git-observation/v1",
      git: exactGitFacts(),
    },
    disposition: "producer_owned",
    claims: [],
    taint: null,
    risk_acceptances: [],
    command_receipts: [],
    cleanup_receipt: null,
    registration_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: "workspace-register:producer",
      command_digest: digestValue(workspaceRegistration()),
    },
    legal_actions: [],
  });

  const bytes = Buffer.from("retained review candidate\n");
  const artifactDigest = sha256(bytes);
  const mismatchedBytes = artifactRegistration(bytes, artifactDigest);
  mismatchedBytes.bytes_base64 = Buffer.from("x".repeat(bytes.length)).toString("base64");
  assert.equal(artifactAuthority.command(mismatchedBytes).code,
    "artifact_bytes_mismatch");
  const artifact = artifactAuthority.command(artifactRegistration(bytes, artifactDigest));
  assert.equal(artifact.accepted, true);
  assert.equal(artifact.created, true);
  assert.deepEqual(artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  }), {
    schema: "work.artifact-projection/v1",
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
    watermark: artifact.authority_watermark,
    generation: 1,
    digest: artifactDigest,
    artifact_schema: "example.candidate/v1",
    size: bytes.length,
    provenance: {
      producer: { run_id: "run:producer", evidence: "sha256:producer" },
      validator: { contract: "example.validator/v1", receipt: "sha256:validator" },
    },
    classification: "internal",
    retention: "durable_handoff",
    status: "retained",
    pins: [{ holder: "run", id: "run:producer" }],
    byte_availability: "available",
    registration_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: `artifact-record:${artifactDigest}`,
      command_digest: digestValue(artifactRegistration(bytes, artifactDigest)),
    },
    collection_receipt: null,
    collection_effect_id: null,
    legal_actions: [],
  });
  assert.equal(workspaceAuthority.command(workspaceRegistration()).created, false);
  assert.equal(artifactAuthority.command(artifactRegistration(bytes, artifactDigest)).created,
    false);
  const conflict = workspaceRegistration();
  conflict.registration.disposition = "conflicting";
  assert.equal(workspaceAuthority.command(conflict).code, "idempotency_conflict");
  const stale = workspaceRegistration();
  stale.command_id = "workspace-register:stale";
  assert.equal(workspaceAuthority.command(stale).code, "stale_subject_generation");
  assert.equal(workspaceAuthority.command({
    schema: "work.workspace-register-command/v1",
    contract: "work.workspace/v1",
    type: "workspace_register",
    subject_id: "workspace:invalid",
  }).code, "invalid_workspace_registration");
  assert.equal(artifactAuthority.command({
    schema: "work.artifact-record-command/v1",
    contract: "work.artifact/v1",
    type: "artifact_record",
    subject_id: `sha256:${"0".repeat(64)}`,
  }).code, "invalid_artifact_record");

  const inspector = createDurableRunAuthority({
    access: "inspect",
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector-process"),
  });
  t.after(() => inspector.close());
  assert.equal(getArtifactAuthority({ runAuthority: inspector }).command(
    artifactRegistration(Buffer.from("inspect-only\n"), sha256(Buffer.from("inspect-only\n"))),
  ).code, "mutation_authority_unavailable");
});

test("WorkspaceAuthority fences concurrent writers by generation and fingerprint", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-fence-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "writer-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  workspaceAuthority.command(workspaceRegistration());
  const registered = workspaceAuthority.query(workspaceQuery());

  const claim = workspaceClaim({ expectedWatermark: registered.watermark });
  const accepted = workspaceAuthority.command(claim);
  assert.equal(accepted.accepted, true);
  const claimed = workspaceAuthority.query({
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  });
  assert.deepEqual(claimed.claims, [{
    claim_id: "claim:writer-a",
    holder: "run:writer-a",
    operations: ["workspace_mutation"],
  }]);
  const release = claimed.legal_actions.find(({ type }) =>
    type === "workspace_claim_release");
  assert.ok(release);
  assert.equal(workspaceAuthority.command({
    ...release,
    expected_watermark: `sha256:${"0".repeat(64)}`,
  }).code, "stale_authority_watermark");

  const concurrent = workspaceClaim({
    commandId: "workspace-claim:writer-b",
    claimId: "claim:writer-b",
    holder: "run:writer-b",
    expectedWatermark: claimed.watermark,
  });
  assert.equal(workspaceAuthority.command(concurrent).code,
    "workspace_already_claimed");
  assert.equal(workspaceAuthority.command(workspaceClaim({
    commandId: "workspace-claim:stale",
    expectedGeneration: 0,
    expectedWatermark: claimed.watermark,
  })).code, "stale_subject_generation");
  assert.equal(workspaceAuthority.command(workspaceClaim({
    commandId: "workspace-claim:changed",
    expectedFingerprint: `sha256:${"9".repeat(64)}`,
    expectedWatermark: claimed.watermark,
  })).code, "workspace_fingerprint_changed");
  assert.equal(workspaceAuthority.command(release).accepted, true);
  const released = workspaceAuthority.query(workspaceQuery());
  assert.equal(workspaceAuthority.command(claim).created, false);
  assert.deepEqual(workspaceAuthority.query(workspaceQuery()).claims, []);
  assert.equal(workspaceAuthority.command({
    ...concurrent,
    expected_watermark: released.watermark,
  }).accepted, true);

  const driftDirectory = await mkdtemp(join(tmpdir(), "flow-work-drift-"));
  t.after(() => rm(driftDirectory, { recursive: true, force: true }));
  let observations = 0;
  const driftAuthority = createDurableRunAuthority({
    authorityDirectory: driftDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: {
      observe() {
        observations += 1;
        return {
          schema: "work.git-observation/v1",
          git: observations === 1
            ? exactGitFacts()
            : { ...exactGitFacts(), commit_sha: "9".repeat(40) },
        };
      },
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "drift-process"),
  });
  t.after(() => driftAuthority.close());
  const driftWorkspace = getWorkspaceAuthority({ runAuthority: driftAuthority });
  driftWorkspace.command(workspaceRegistration());
  const driftProjection = driftWorkspace.query(workspaceQuery());
  assert.equal(driftWorkspace.command(workspaceClaim({
    commandId: "workspace-claim:drifted",
    expectedWatermark: driftProjection.watermark,
  })).code, "workspace_fingerprint_changed");
});

test("workspace taint survives reboot and only exact dispositions can clear it", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-taint-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const first = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "writer-process"),
  });
  const firstWorkspace = getWorkspaceAuthority({ runAuthority: first });
  firstWorkspace.command(workspaceRegistration());
  const beforeTaint = firstWorkspace.query(workspaceQuery());
  assert.equal(firstWorkspace.command(workspaceTaint(beforeTaint.watermark)).accepted,
    true);
  first.close();

  const rebooted = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-b", "recovery-process"),
    workEvidenceAdapter: deterministicWorkEvidenceAdapter(),
  });
  t.after(() => rebooted.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority: rebooted });
  const humanRuntime = createFlowRuntime({ runAuthority: rebooted });
  const tainted = workspaceAuthority.query(workspaceQuery());
  assert.equal(tainted.taint.status, "tainted");
  assert.equal(tainted.taint.reason, "effect_outcome_uncertain");
  assert.deepEqual(tainted.legal_actions.map(({ type }) => type), [
    "workspace_taint_disposition",
    "workspace_risk_acceptance",
  ]);
  assert.equal(workspaceAuthority.command(workspaceClaim({
    commandId: "workspace-claim:tainted",
    expectedWatermark: tainted.watermark,
  })).code, "workspace_tainted");

  assert.equal(workspaceAuthority.command(workspaceTaintDisposition(tainted, {
    disposition: "generic_clear",
  })).code, "invalid_taint_disposition");
  assert.equal(workspaceAuthority.command(workspaceTaintDisposition(tainted, {
    disposition: "destructive_reset",
  })).code, "fresh_human_authority_required");
  assert.equal(workspaceAuthority.command(workspaceRiskAcceptance(tainted)).code,
    "fresh_human_authority_required");
  const forgedRisk = workspaceRiskAcceptance(tainted);
  const forgedBinding = buildHumanAuthorityBinding(forgedRisk, "risk_acceptance");
  forgedRisk.human_authority = {
    schema: "work.human-authority/v1",
    ...forgedBinding,
    binding_digest: digestValue(forgedBinding),
    run_id: "run:caller-forged",
    checkpoint_id: "confirm-plan",
    run_watermark: `sha256:${"f".repeat(64)}`,
  };
  assert.equal(workspaceAuthority.command(forgedRisk).code,
    "fresh_human_authority_required");
  assert.equal(workspaceAuthority.command(workspaceTaintDisposition(tainted, {
    disposition: "evidence_backed_adoption",
    evidence: {
      schema: "work.taint-disposition-evidence/v1",
      kind: "exact_provider_adoption",
      digest: `sha256:${"c".repeat(64)}`,
    },
  })).code, "taint_disposition_evidence_required");

  const riskCommand = workspaceRiskAcceptance(tainted);
  riskCommand.human_authority = approveHumanAuthority(
    humanRuntime,
    riskCommand,
    "risk_acceptance",
  );
  const acceptedRisk = workspaceAuthority.command(riskCommand);
  assert.equal(acceptedRisk.accepted, true, JSON.stringify(acceptedRisk));
  const afterRiskAcceptance = workspaceAuthority.query(workspaceQuery());
  assert.equal(afterRiskAcceptance.taint.status, "tainted");
  assert.equal(afterRiskAcceptance.risk_acceptances.length, 1);

  const adopted = workspaceTaintDisposition(afterRiskAcceptance, {
    disposition: "evidence_backed_adoption",
    evidence: {
      schema: "work.taint-disposition-evidence/v1",
      kind: "exact_provider_adoption",
      digest: `sha256:${"a".repeat(64)}`,
    },
  });
  assert.equal(workspaceAuthority.command(adopted).accepted, true);
  const cleared = workspaceAuthority.query(workspaceQuery());
  assert.equal(cleared.taint, null);
  const replayedAdoption = workspaceAuthority.command(adopted);
  assert.equal(replayedAdoption.accepted, true);
  assert.equal(replayedAdoption.created, false);

  const secondTaint = workspaceTaint(cleared.watermark);
  secondTaint.command_id = "workspace-taint:second-uncertain-effect";
  assert.equal(workspaceAuthority.command(secondTaint).accepted, true);
  const taintedAgain = workspaceAuthority.query(workspaceQuery());
  const reset = workspaceTaintDisposition(taintedAgain, {
    disposition: "destructive_reset",
    evidence: {
      schema: "work.taint-disposition-evidence/v1",
      kind: "destructive_reset_receipt",
      digest: `sha256:${"b".repeat(64)}`,
    },
  });
  reset.replacement = {
    generation: taintedAgain.generation + 1,
    mutation_epoch: taintedAgain.mutation_epoch + 1,
    git: exactGitFacts(),
    disposition: "retired",
  };
  reset.human_authority = approveHumanAuthority(
    humanRuntime,
    reset,
    "destructive_reset",
  );
  assert.equal(workspaceAuthority.command(reset).accepted, true);
  const resetWorkspace = workspaceAuthority.query(workspaceQuery());
  assert.equal(resetWorkspace.taint, null);
  assert.equal(resetWorkspace.generation, 2);
  assert.equal(resetWorkspace.mutation_epoch, 8);
});

test("cleanup previews exact effects and refuse unsafe workspace and artifact state", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-cleanup-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "cleanup-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  workspaceAuthority.command(workspaceRegistration("/tmp/producer-worktree", {
    disposition: "retired",
  }));

  const eligible = workspaceAuthority.previewCleanup(workspaceQuery());
  assert.equal(eligible.schema, "work.workspace-cleanup-preview/v1");
  assert.equal(eligible.eligibility, "eligible");
  assert.deepEqual(eligible.effects, [{
    type: "remove_workspace",
    canonical_path: "/tmp/producer-worktree",
    repository_id: "github.com/Seavenly/example",
  }]);
  assert.deepEqual(eligible.legal_actions.map(({ type }) => type),
    ["workspace_cleanup"]);

  workspaceAuthority.command(workspaceClaim({
    expectedWatermark: workspaceAuthority.query(workspaceQuery()).watermark,
  }));
  const active = workspaceAuthority.previewCleanup(workspaceQuery());
  assert.equal(active.eligibility, "refused");
  assert.deepEqual(active.refusal_reasons, ["active_claim"]);
  assert.deepEqual(active.legal_actions, []);
  const claimedProjection = workspaceAuthority.query(workspaceQuery());
  const claimRelease = claimedProjection.legal_actions.find(({ type }) =>
    type === "workspace_claim_release");
  assert.equal(workspaceAuthority.command(claimRelease).accepted, true);
  const releasedProjection = workspaceAuthority.query(workspaceQuery());
  workspaceAuthority.command(workspaceTaint(releasedProjection.watermark));
  assert.ok(workspaceAuthority.previewCleanup(workspaceQuery()).refusal_reasons
    .includes("uncertain"));

  const bytes = Buffer.from("retained cleanup evidence\n");
  const artifactDigest = sha256(bytes);
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest));
  const retained = artifactAuthority.previewCollection({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  });
  assert.equal(retained.schema, "work.artifact-collection-preview/v1");
  assert.equal(retained.eligibility, "refused");
  assert.deepEqual(retained.refusal_reasons, ["pinned", "retained"]);
  assert.deepEqual(retained.effects, [{
    type: "remove_artifact_bytes",
    digest: artifactDigest,
    size: bytes.length,
  }]);
  assert.deepEqual(retained.legal_actions, []);

  const dirtyAuthorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-dirty-"));
  t.after(() => rm(dirtyAuthorityDirectory, { recursive: true, force: true }));
  const dirtyGit = { ...exactGitFacts(), clean: false };
  const dirtyRunAuthority = createDurableRunAuthority({
    authorityDirectory: dirtyAuthorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      gitFacts: dirtyGit,
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "dirty-process"),
  });
  t.after(() => dirtyRunAuthority.close());
  const dirtyWorkspaceAuthority = getWorkspaceAuthority({
    runAuthority: dirtyRunAuthority,
  });
  dirtyWorkspaceAuthority.command(workspaceRegistration("/tmp/producer-worktree", {
    disposition: "retired",
    git: dirtyGit,
  }));
  assert.deepEqual(
    dirtyWorkspaceAuthority.previewCleanup(workspaceQuery()).refusal_reasons,
    ["dirty"],
  );
});

test("FlowRuntime executes an exact eligible cleanup through its registered Adapter", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cleanup-operation-"));
  const workspacePath = join(authorityDirectory, "retired-workspace");
  await mkdir(workspacePath);
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "cleanup-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  workspaceAuthority.command(workspaceRegistration(workspacePath, {
    disposition: "retired",
  }));
  const preview = workspaceAuthority.previewCleanup(workspaceQuery());
  const action = preview.legal_actions[0];
  let invocations = 0;
  const runtime = createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [CLEANUP_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "reconcilable",
        async invoke(intent) {
          invocations += 1;
          if (invocations === 1) {
            throw new Error("cleanup result unavailable after admission");
          }
          await rm(workspacePath, { recursive: true });
          return operationReceipt(intent, {
            resource_cleanup: {
              schema: "flow.resource-cleanup-receipt/v1",
              request: intent.operation_input.resource_cleanup,
              outcome: "removed",
            },
          });
        },
        observe(intent) {
          return {
            schema: "flow.effect-observation/v1",
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            presence: "absent",
            causation: null,
            provider_observation: { found: false },
          };
        },
      },
    },
  });
  workspaceAuthority.command(workspaceClaim({
    expectedWatermark: workspaceAuthority.query(workspaceQuery()).watermark,
  }));
  const release = workspaceAuthority.query(workspaceQuery()).legal_actions
    .find(({ type }) => type === "workspace_claim_release");
  workspaceAuthority.command(release);
  const stalePrepared = runtime.prepare(cleanupOperationProposal(action));
  const staleLaunch = runtime.launch(confirmedLaunchRequest(stalePrepared));
  runtime.command(runtime.query({ run_id: staleLaunch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: staleLaunch.run_id }).effects.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invocations, 0);
  assert.equal(runtime.query({ run_id: staleLaunch.run_id }).effects[0].status,
    "unresolved");

  const freshAction = workspaceAuthority.previewCleanup(workspaceQuery())
    .legal_actions[0];
  const proposal = cleanupOperationProposal(freshAction);
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
  assert.equal(workspaceAuthority.query(workspaceQuery()).taint.reason,
    "resource_cleanup_in_flight");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "recovery"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0]
    .last_observation.presence, "absent");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  assert.equal(invocations, 2);
  await assert.rejects(access(workspacePath));
  const cleaned = workspaceAuthority.query(workspaceQuery());
  assert.equal(cleaned.disposition, "cleaned");
  assert.equal(cleaned.cleanup_receipt.request.preview_digest,
    freshAction.preview_digest);
});

test("producer promotion, pin transfer, handoff activation, and finalization commit atomically", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "producer-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  const handoffAuthority = getResourceHandoffAuthority({ runAuthority });
  const bytes = Buffer.from("immutable candidate bytes\n");
  const artifactDigest = sha256(bytes);
  const publication = handoffPublication(artifactDigest);
  const proposal = registeredOperationProposal({ checkpointBound: false });
  proposal.graph.cards[0].inputs = { publication };
  claimProducerWorkspace(proposal);
  let publicationInvocations = 0;
  const runtime = createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          publicationInvocations += 1;
          return publicationReceipt(intent);
        },
      },
    },
  });
  const oneShotRuntime = createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "one_shot_uncertain",
        invoke() {
          assert.fail("unsafe publication reached its Adapter");
        },
        observe() {
          return { presence: "indeterminate" };
        },
      },
    },
  });
  const oneShotProposal = registeredOperationProposal({
    classification: "one_shot_uncertain",
  });
  const oneShotOperation = oneShotProposal.graph.cards.find(
    ({ executor }) => executor.kind === "operation",
  );
  oneShotOperation.inputs = { publication };
  claimProducerWorkspace(oneShotProposal);
  assert.throws(
    () => oneShotRuntime.prepare(oneShotProposal),
    /one-shot operation cannot publish a resource handoff/u,
  );
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  workspaceAuthority.command(workspaceRegistration());
  acquireProducerWorkspace(workspaceAuthority, "run:competing-writer");
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest, launch.run_id));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publicationInvocations, 0);
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
  const competingRelease = workspaceAuthority.query(workspaceQuery()).legal_actions
    .find(({ type }) => type === "workspace_claim_release");
  workspaceAuthority.command(competingRelease);
  acquireProducerWorkspace(workspaceAuthority, launch.run_id);
  const recovery = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "recovery");
  runtime.command(recovery);
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.handoffs.length, 1);
  const [published] = completed.handoffs;
  const handoff = handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: published.handoff_id,
  });
  assert.equal(handoff.status, "active");
  assert.equal(handoff.producer.run_id, launch.run_id);
  assert.deepEqual(handoff.subject, {
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    generation: 2,
    fingerprint: digestValue({ git: promotedGitFacts() }),
  });
  assert.deepEqual(handoff.artifacts, [{
    digest: artifactDigest,
    generation: 1,
  }]);
  assert.deepEqual(handoff.consumer_operation_authority, [
    { operation: "read_then_update_workspace", access: "mutation" },
    { operation: "read_workspace", access: "read_only" },
    { operation: "workspace_mutation", access: "mutation" },
  ]);
  const handoffCleanup = handoffAuthority.previewCleanup({
    contract: "flow.resource-handoff/v1",
    subject_id: published.handoff_id,
  });
  assert.equal(handoffCleanup.schema, "flow.resource-handoff-cleanup-preview/v1");
  assert.equal(handoffCleanup.eligibility, "refused");
  assert.deepEqual(handoffCleanup.refusal_reasons, [
    "active_handoff",
    "cleanup_obligations",
    "retained",
  ]);
  assert.deepEqual(handoffCleanup.legal_actions, []);

  const workspace = workspaceAuthority.query({
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  });
  assert.equal(workspace.generation, 2);
  assert.equal(workspace.mutation_epoch, 8);
  assert.deepEqual(workspace.git, promotedGitFacts());
  assert.deepEqual(workspace.git_observation, {
    schema: "work.git-observation/v1",
    git: promotedGitFacts(),
  });
  assert.equal(workspace.disposition, "retained_for_handoff");
  const artifact = artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  });
  assert.deepEqual(artifact.pins, [{ holder: "handoff", id: published.handoff_id }]);
  for (const [label, publicationOverrides] of [
    ["stale generation", {
      expectedGeneration: 1,
      expectedMutationEpoch: 8,
      expectedGit: promotedGitFacts(),
      promotedGeneration: 3,
      promotedMutationEpoch: 9,
    }],
    ["changed fingerprint", {
      expectedGeneration: 2,
      expectedMutationEpoch: 8,
      expectedGit: exactGitFacts(),
      promotedGeneration: 3,
      promotedMutationEpoch: 9,
    }],
  ]) {
    const staleBytes = Buffer.from(`${label} candidate bytes\n`);
    const staleDigest = sha256(staleBytes);
    const staleProposal = registeredOperationProposal({ checkpointBound: false });
    staleProposal.graph.cards[0].inputs = {
      publication: handoffPublication(staleDigest, publicationOverrides),
    };
    claimProducerWorkspace(staleProposal);
    const stalePrepared = runtime.prepare(staleProposal);
    const staleRun = runtime.launch(confirmedLaunchRequest(stalePrepared));
    acquireProducerWorkspace(workspaceAuthority, staleRun.run_id);
    artifactAuthority.command(artifactRegistration(
      staleBytes,
      staleDigest,
      staleRun.run_id,
    ));
    runtime.command(runtime.query({ run_id: staleRun.run_id }).legal_actions[0]);
    await until(() => runtime.query({ run_id: staleRun.run_id }).effects.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    const rejected = runtime.query({ run_id: staleRun.run_id });
    assert.equal(rejected.phase, "active", label);
    assert.equal(rejected.effects[0].status, "unresolved", label);
    assert.deepEqual(rejected.handoffs, [], label);
    const releaseClaim = workspaceAuthority.query(workspaceQuery()).legal_actions
      .find(({ type }) => type === "workspace_claim_release");
    workspaceAuthority.command(releaseClaim);
  }
  assert.equal(publicationInvocations, 1);
  await rm(join(
    authorityDirectory,
    "artifacts",
    artifactDigest.slice("sha256:".length),
  ));
  const unavailable = handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: published.handoff_id,
  });
  assert.equal(unavailable.byte_availability, "missing");
  assert.deepEqual(unavailable.legal_actions, []);
});

test("a failure before handoff commit leaves every authority unpromoted", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    beforeHandoffCommit() {
      throw new Error("injected storage failure");
    },
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "producer-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  const bytes = Buffer.from("candidate awaiting atomic commit\n");
  const artifactDigest = sha256(bytes);
  const proposal = registeredOperationProposal({ checkpointBound: false });
  proposal.graph.cards[0].inputs = {
    publication: handoffPublication(artifactDigest),
  };
  claimProducerWorkspace(proposal);
  const runtime = createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          return publicationReceipt(intent);
        },
      },
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  workspaceAuthority.command(workspaceRegistration());
  acquireProducerWorkspace(workspaceAuthority, launch.run_id);
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest, launch.run_id));

  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);
  await new Promise((resolve) => setImmediate(resolve));

  const run = runtime.query({ run_id: launch.run_id });
  assert.equal(run.phase, "active");
  assert.equal(run.effects[0].status, "unresolved");
  assert.deepEqual(run.handoffs, []);
  const uncertainWorkspace = workspaceAuthority.query({
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  });
  assert.equal(uncertainWorkspace.generation, 1);
  assert.equal(uncertainWorkspace.taint.reason, "handoff_publication_in_flight");
  assert.equal(uncertainWorkspace.taint.source_effect_id,
    run.effects[0].effect_id);
  assert.deepEqual(artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  }).pins, [{ holder: "run", id: launch.run_id }]);
});

test("a later run pins and rechecks a retained handoff after the producer disappears", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-work-authority-"));
  const gitRoot = await mkdtemp(join(tmpdir(), "flow-git-retention-"));
  const repository = join(gitRoot, "repository.git");
  const producerWorkspace = join(gitRoot, "producer-worktree");
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  t.after(() => rm(gitRoot, { recursive: true, force: true }));
  git(gitRoot, ["init", "--bare", repository]);
  git(gitRoot, ["clone", repository, producerWorkspace]);
  git(producerWorkspace, ["config", "user.name", "Flow Test"]);
  git(producerWorkspace, ["config", "user.email", "flow@example.test"]);
  git(producerWorkspace, ["switch", "-c", "producer"]);
  git(producerWorkspace, ["commit", "--allow-empty", "-m", "initial"]);
  const initialGit = observedGitFacts(producerWorkspace, "refs/heads/producer");
  git(producerWorkspace, ["commit", "--allow-empty", "-m", "candidate"]);
  const candidateGit = {
    ...observedGitFacts(producerWorkspace, "refs/heads/producer"),
    ref: "HEAD",
  };
  git(producerWorkspace, ["push", "origin", "producer"]);
  const gitRetentionAdapter = createGitRetentionAdapter({
    resolveRepository(repositoryId) {
      assert.equal(repositoryId, "example/repository");
      return repository;
    },
  });
  assert.throws(() => gitRetentionAdapter.retain({
    repository_id: "example/repository",
    git: { ...candidateGit, commit_sha: "--verify" },
  }), /exact object identities/u);
  const producerAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter,
    gitWorkspaceObservationAdapter: createGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "producer-process"),
  });
  const producerWorkspaceAuthority = getWorkspaceAuthority({
    runAuthority: producerAuthority,
  });
  const producerArtifactAuthority = getArtifactAuthority({
    runAuthority: producerAuthority,
  });
  const bytes = Buffer.from("candidate retained beyond producer lifetime\n");
  const artifactDigest = sha256(bytes);
  const proposal = registeredOperationProposal({ checkpointBound: false });
  proposal.graph.cards[0].inputs = {
    publication: handoffPublication(artifactDigest, {
      expectedGit: initialGit,
      promotedGit: candidateGit,
    }),
  };
  claimProducerWorkspace(proposal);
  const producerRuntime = createFlowRuntime({
    runAuthority: producerAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          return operationReceipt(intent, {
            publication_digest: digestValue(intent.operation_input.publication),
            git_retention: gitRetentionAdapter.retain({
              repository_id: "example/repository",
              git: candidateGit,
            }),
          });
        },
      },
    },
  });
  const prepared = producerRuntime.prepare(proposal);
  const producer = producerRuntime.launch(confirmedLaunchRequest(prepared));
  git(producerWorkspace, ["reset", "--hard", initialGit.commit_sha]);
  producerWorkspaceAuthority.command(workspaceRegistration(producerWorkspace, {
    git: initialGit,
    repositoryId: "example/repository",
  }));
  acquireProducerWorkspace(producerWorkspaceAuthority, producer.run_id);
  git(producerWorkspace, ["switch", "--detach", candidateGit.commit_sha]);
  producerArtifactAuthority.command(
    artifactRegistration(bytes, artifactDigest, producer.run_id),
  );
  producerRuntime.command(
    producerRuntime.query({ run_id: producer.run_id }).legal_actions[0],
  );
  await until(() =>
    producerRuntime.query({ run_id: producer.run_id }).phase === "succeeded");
  const [{ handoff_id: handoffId }] = producerRuntime.query({
    run_id: producer.run_id,
  }).handoffs;

  producerAuthority.close();
  git(repository, ["update-ref", "-d", "refs/heads/producer"]);
  await rm(producerWorkspace, { recursive: true, force: true });

  const consumerAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter,
    gitWorkspaceObservationAdapter: createGitWorkspaceObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "consumer-process"),
    workEvidenceAdapter: deterministicWorkEvidenceAdapter(),
  });
  t.after(() => consumerAuthority.close());
  const consumerHandoffAuthority = getResourceHandoffAuthority({
    runAuthority: consumerAuthority,
  });
  const recoveredWorkspaceAuthority = getWorkspaceAuthority({
    runAuthority: consumerAuthority,
  });
  assert.equal(recoveredWorkspaceAuthority.command(workspaceRegistration(
    producerWorkspace,
    { git: initialGit, repositoryId: "example/repository" },
  )).created, false);
  const retained = consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  });
  assert.equal(retained.status, "active");
  assert.equal(retained.byte_availability, "available");
  assert.equal(retained.git_availability, "available");
  assert.equal(git(repository, ["cat-file", "-t", candidateGit.commit_sha]), "commit");

  let projectionAtMutation;
  let consumerInvocations = 0;
  const consumerRuntime = createFlowRuntime({
    runAuthority: consumerAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          consumerInvocations += 1;
          projectionAtMutation = consumerHandoffAuthority.query({
            contract: "flow.resource-handoff/v1",
            subject_id: handoffId,
          });
          assert.equal(
            projectionAtMutation.mutation_authorizations.at(-1).effect_id,
            intent.effect_id,
          );
          return operationReceipt(intent);
        },
      },
      [CLEANUP_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "reconcilable",
        invoke(intent) {
          const request = intent.operation_input.resource_cleanup;
          git(repository, ["update-ref", "-d", retained.git_retention.retention_ref]);
          return operationReceipt(intent, {
            resource_cleanup: {
              schema: "flow.resource-cleanup-receipt/v1",
              request,
              outcome: "removed",
            },
          });
        },
        observe() {
          return { presence: "absent" };
        },
      },
    },
  });
  const wrongPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    `sha256:${"0".repeat(64)}`,
  ));
  assert.equal(consumerRuntime.launch(confirmedLaunchRequest(wrongPrepared)).code,
    "invalid_resource_handoff_binding");
  const latestPrepared = consumerRuntime.prepare(consumerOperationProposal(
    "latest",
    retained.handoff_digest,
  ));
  assert.equal(consumerRuntime.launch(confirmedLaunchRequest(latestPrepared)).code,
    "forbidden_latest_resource_selection");
  const disallowedPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
    "unapproved_mutation",
  ));
  assert.equal(
    consumerRuntime.launch(confirmedLaunchRequest(disallowedPrepared)).code,
    "invalid_resource_handoff_binding",
  );

  const overbroadPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
    "read_workspace",
    ["read_workspace"],
    [],
  ));
  const overbroadConsumer = consumerRuntime.launch(
    confirmedLaunchRequest(overbroadPrepared),
  );
  assert.equal(overbroadConsumer.code, "invalid_resource_handoff_binding");
  assert.equal(consumerInvocations, 0);

  const cancelledProposal = consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
    "read_then_update_workspace",
  );
  cancelledProposal.graph.cards[0].inputs.cancellation_nonce = "uninvoked-writer";
  cancelledProposal.requested_authority.commands.push("cancel");
  const cancelledPrepared = consumerRuntime.prepare(cancelledProposal);
  const cancelledConsumer = consumerRuntime.launch(
    confirmedLaunchRequest(cancelledPrepared),
  );
  assert.equal(recoveredWorkspaceAuthority.query(workspaceQuery()).claims[0].holder,
    cancelledConsumer.run_id);
  consumerRuntime.command(consumerRuntime.query({
    run_id: cancelledConsumer.run_id,
  }).legal_actions.find(({ type }) => type === "cancel"));
  assert.equal(consumerRuntime.query({
    run_id: cancelledConsumer.run_id,
  }).phase, "cancelled");
  assert.deepEqual(recoveredWorkspaceAuthority.query(workspaceQuery()).claims, []);
  assert.equal(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).consumer_pins.some(({ run_id: runId }) =>
    runId === cancelledConsumer.run_id), false);

  const splitPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
    "read_then_update_workspace",
    ["read_then_update_workspace", "read_workspace"],
  ));
  const splitConsumer = consumerRuntime.launch(confirmedLaunchRequest(splitPrepared));
  assert.deepEqual(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).consumer_pins
    .filter(({ run_id: runId }) => runId === splitConsumer.run_id)
    .map(({ run_id: runId, operations }) => ({ run_id: runId, operations })), [{
    run_id: splitConsumer.run_id,
    operations: ["read_then_update_workspace", "read_workspace"],
  }]);
  const competingProposal = consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
  );
  competingProposal.graph.cards[0].inputs.competition_nonce = "second-writer";
  const competingPrepared = consumerRuntime.prepare(competingProposal);
  assert.equal(
    consumerRuntime.launch(confirmedLaunchRequest(competingPrepared)).code,
    "invalid_resource_handoff_binding",
  );
  assert.equal(recoveredWorkspaceAuthority.query(workspaceQuery()).claims[0].holder,
    splitConsumer.run_id);
  consumerRuntime.command(
    consumerRuntime.query({ run_id: splitConsumer.run_id }).legal_actions[0],
  );
  await until(() =>
    consumerRuntime.query({ run_id: splitConsumer.run_id }).phase === "succeeded");
  consumerInvocations = 0;
  projectionAtMutation = null;

  const consumerPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
  ));
  const consumer = consumerRuntime.launch(confirmedLaunchRequest(consumerPrepared));
  assert.equal(consumer.created, true);
  assert.equal(consumerRuntime.launch(confirmedLaunchRequest(consumerPrepared)).created,
    false);
  const pinned = consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  });
  assert.deepEqual(pinned.consumer_pins
    .filter(({ run_id: runId }) => runId === consumer.run_id)
    .map(({ run_id: runId, operations }) => ({ run_id: runId, operations })), [{
    run_id: consumer.run_id,
    operations: ["workspace_mutation"],
  }]);
  assert.equal(pinned.legal_actions.length, 1);
  git(repository, ["update-ref", "-d", retained.git_retention.retention_ref]);
  consumerRuntime.command(
    consumerRuntime.query({ run_id: consumer.run_id }).legal_actions[0],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consumerInvocations, 0);
  const interrupted = consumerRuntime.query({ run_id: consumer.run_id });
  assert.equal(interrupted.phase, "active");
  assert.equal(interrupted.effects[0].status, "unresolved");
  assert.equal(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).git_availability, "missing");
  git(repository, [
    "update-ref",
    retained.git_retention.retention_ref,
    candidateGit.commit_sha,
  ]);
  const recovery = consumerRuntime.query({ run_id: consumer.run_id }).legal_actions
    .find(({ type }) => type === "recovery");
  assert.ok(recovery);
  consumerRuntime.command(recovery);
  await until(() =>
    consumerRuntime.query({ run_id: consumer.run_id }).phase === "succeeded");
  assert.equal(consumerInvocations, 1);
  assert.equal(projectionAtMutation.mutation_authorizations.at(-1).operation,
    "workspace_mutation");
  const settledHandoff = consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  });
  assert.deepEqual(settledHandoff.legal_actions, []);
  assert.equal(settledHandoff.mutation_claim, null);
  assert.deepEqual(recoveredWorkspaceAuthority.query(workspaceQuery()).claims, []);
  assert.notEqual(settledHandoff.watermark, pinned.watermark);
  const retirement = {
    schema: "flow.resource-handoff-disposition-command/v1",
    command_id: `resource-handoff-retire:${handoffId}`,
    type: "resource_handoff_disposition",
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
    expected_watermark: settledHandoff.authority_watermark,
    disposition: "retired",
    evidence: {
      schema: "flow.resource-handoff-disposition-evidence/v1",
      kind: "cleanup_obligations_discharged",
      digest: `sha256:${"d".repeat(64)}`,
      cleanup_obligations: settledHandoff.cleanup_obligations,
    },
  };
  const retirementReceipt = consumerHandoffAuthority.command(retirement);
  assert.equal(retirementReceipt.accepted, true, JSON.stringify(retirementReceipt));
  const cleanupPreview = consumerHandoffAuthority.previewCleanup({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  });
  assert.equal(cleanupPreview.eligibility, "eligible");
  assert.deepEqual(cleanupPreview.legal_actions.map(({ type }) => type),
    ["resource_handoff_cleanup"]);
  const cleanupPrepared = consumerRuntime.prepare(
    cleanupOperationProposal(cleanupPreview.legal_actions[0]),
  );
  const cleanupRun = consumerRuntime.launch(confirmedLaunchRequest(cleanupPrepared));
  consumerRuntime.command(
    consumerRuntime.query({ run_id: cleanupRun.run_id }).legal_actions[0],
  );
  await until(() =>
    consumerRuntime.query({ run_id: cleanupRun.run_id }).phase === "succeeded");
  assert.equal(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).status, "cleaned");
  assert.deepEqual(consumerHandoffAuthority.previewCleanup({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).refusal_reasons, ["already_cleaned"]);
  assert.equal(recoveredWorkspaceAuthority.query(workspaceQuery()).disposition,
    "released");
  assert.equal(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).git_availability, "missing");
});

function workspaceRegistration(canonicalPath = "/tmp/producer-worktree", {
  disposition = "producer_owned",
  git: gitFacts = exactGitFacts(),
  repositoryId = "github.com/Seavenly/example",
} = {}) {
  return {
    schema: "work.workspace-register-command/v1",
    command_id: "workspace-register:producer",
    type: "workspace_register",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_generation: 0,
    registration: {
      repository: { canonical_id: repositoryId },
      workspace: {
        canonical_id: "workspace:producer",
        canonical_path: canonicalPath,
      },
      git: gitFacts,
      mutation_epoch: 7,
      disposition,
    },
  };
}

function artifactRegistration(bytes, digest, producerRunId = "run:producer") {
  return {
    schema: "work.artifact-record-command/v1",
    command_id: `artifact-record:${digest}`,
    type: "artifact_record",
    contract: "work.artifact/v1",
    subject_id: digest,
    expected_generation: 0,
    artifact: {
      digest,
      artifact_schema: "example.candidate/v1",
      size: bytes.length,
      provenance: {
        producer: { run_id: "run:producer", evidence: "sha256:producer" },
        validator: {
          contract: "example.validator/v1",
          receipt: "sha256:validator",
        },
      },
      classification: "internal",
      retention: "durable_handoff",
      pins: [{ holder: "run", id: producerRunId }],
    },
    bytes_base64: bytes.toString("base64"),
  };
}

function workspaceClaim({
  claimId = "claim:writer-a",
  commandId = "workspace-claim:writer-a",
  expectedFingerprint = digestValue({ git: exactGitFacts() }),
  expectedGeneration = 1,
  expectedWatermark,
  holder = "run:writer-a",
  operations = ["workspace_mutation"],
} = {}) {
  return {
    schema: "work.workspace-claim-command/v1",
    command_id: commandId,
    type: "workspace_claim",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_generation: expectedGeneration,
    expected_watermark: expectedWatermark,
    expected_fingerprint: expectedFingerprint,
    claim: {
      claim_id: claimId,
      holder,
      operations,
    },
  };
}

function workspaceQuery() {
  return {
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  };
}

function workspaceTaint(expectedWatermark) {
  return {
    schema: "work.workspace-taint-command/v1",
    command_id: "workspace-taint:uncertain-effect",
    type: "workspace_taint",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_watermark: expectedWatermark,
    taint: {
      reason: "effect_outcome_uncertain",
      evidence_digest: `sha256:${"8".repeat(64)}`,
    },
  };
}

function workspaceTaintDisposition(projection, {
  disposition,
  evidence = null,
  humanAuthority = null,
}) {
  return {
    schema: "work.workspace-taint-disposition-command/v1",
    command_id: `workspace-taint-disposition:${disposition}`,
    type: "workspace_taint_disposition",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_watermark: projection.watermark,
    disposition,
    evidence,
    human_authority: humanAuthority,
  };
}

function workspaceRiskAcceptance(projection, humanAuthority = null) {
  return {
    schema: "work.workspace-risk-acceptance-command/v1",
    command_id: "workspace-risk-acceptance:one",
    type: "workspace_risk_acceptance",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_watermark: projection.watermark,
    scope: ["inspect_only"],
    human_authority: humanAuthority,
  };
}

function approveHumanAuthority(runtime, command, action) {
  const binding = buildHumanAuthorityBinding(command, action);
  const proposal = dynamicCheckpointProposal();
  proposal.graph.cards[0].inputs.human_authority = binding;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const approval = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ decision }) => decision === "approve");
  runtime.command(approval);
  const approved = runtime.query({ run_id: launch.run_id });
  return {
    schema: "work.human-authority/v1",
    action,
    command_id: command.command_id,
    subject_id: command.subject_id,
    expected_watermark: command.expected_watermark,
    binding_digest: digestValue(binding),
    run_id: launch.run_id,
    checkpoint_id: "confirm-plan",
    run_watermark: approved.watermark,
  };
}

function deterministicWorkEvidenceAdapter() {
  const accepted = new Set([
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
    `sha256:${"d".repeat(64)}`,
  ]);
  return {
    validate({ workspace, handoff, command }) {
      if (handoff) return {
        schema: "flow.resource-handoff-disposition-validation/v1",
        valid: accepted.has(command.evidence?.digest),
        subject_id: handoff.subject_id,
        handoff_digest: handoff.handoff_digest,
        cleanup_obligations_digest: digestValue(handoff.cleanup_obligations),
        evidence_digest: command.evidence?.digest ?? null,
      };
      return {
        schema: "work.taint-disposition-validation/v1",
        valid: accepted.has(command.evidence?.digest),
        subject_id: workspace.subject_id,
        taint_evidence_digest: workspace.taint?.evidence_digest ?? null,
        disposition: command.disposition,
        evidence_digest: command.evidence?.digest ?? null,
      };
    },
  };
}

function handoffPublication(artifactDigest, {
  expectedGeneration = 1,
  expectedGit = exactGitFacts(),
  expectedMutationEpoch = 7,
  promotedGeneration = 2,
  promotedGit = promotedGitFacts(),
  promotedMutationEpoch = 8,
} = {}) {
  return {
    schema: "flow.resource-handoff-publication/v1",
    workspace: {
      subject_id: "workspace:producer",
      expected_generation: expectedGeneration,
      expected_mutation_epoch: expectedMutationEpoch,
      expected_git: expectedGit,
      promoted_generation: promotedGeneration,
      promoted_mutation_epoch: promotedMutationEpoch,
      promoted_git: promotedGit,
      disposition: "retained_for_handoff",
    },
    artifacts: [{ digest: artifactDigest, expected_generation: 1 }],
    subject: {
      contract: "work.workspace/v1",
      subject_id: "workspace:producer",
    },
    allowed_consumer_operations: [
      "read_then_update_workspace",
      "read_workspace",
      "workspace_mutation",
    ],
    consumer_operation_authority: [
      { operation: "read_then_update_workspace", access: "mutation" },
      { operation: "read_workspace", access: "read_only" },
      { operation: "workspace_mutation", access: "mutation" },
    ],
    authority_envelope: { capabilities: ["repository:write"] },
    retention: "durable_handoff",
    cleanup_obligations: ["retain_artifact_bytes"],
    intended_consumer: null,
  };
}

function consumerOperationProposal(
  handoffId,
  handoffDigest,
  operation = "workspace_mutation",
  claimedOperations = [operation],
  cardClaimedOperations = claimedOperations,
) {
  const proposal = registeredOperationProposal({ checkpointBound: false });
  const claims = claimedOperations.map((claimedOperation) => ({
    kind: "resource_handoff",
    id: handoffId,
    digest: handoffDigest,
    operations: [claimedOperation],
  }));
  proposal.graph.cards[0].inputs = {
    resource_handoff: {
      handoff_id: handoffId,
      handoff_digest: handoffDigest,
      operation,
    },
  };
  proposal.graph.cards[0].resource_claims.push(...claims.filter(({ operations }) =>
    cardClaimedOperations.includes(operations[0])));
  proposal.explicit_facts.resource_claims.push(...claims);
  proposal.explicit_facts.limits.max_resources = 1 + claims.length;
  return proposal;
}

function claimProducerWorkspace(proposal) {
  const claim = { kind: "workspace", id: "workspace:producer" };
  const producerCard = proposal.graph.cards.find((card) =>
    card.inputs?.publication !== undefined);
  producerCard.resource_claims.push(claim);
  proposal.explicit_facts.resource_claims.push(claim);
  proposal.explicit_facts.limits.max_resources += 1;
}

function cleanupOperationProposal(action) {
  const proposal = registeredOperationProposal({
    checkpointBound: false,
    classification: "reconcilable",
  });
  const operation = proposal.graph.cards[0];
  operation.executor.contract = CLEANUP_OPERATION_CONTRACT;
  operation.inputs = action.operation_input;
  operation.route = { adapter: "resource-cleanup" };
  proposal.requested_authority.mutations = [CLEANUP_OPERATION_CONTRACT];
  proposal.explicit_facts.operation_contracts = [CLEANUP_OPERATION_CONTRACT];
  return proposal;
}

function acquireProducerWorkspace(workspaceAuthority, runId) {
  const workspace = workspaceAuthority.query(workspaceQuery());
  return workspaceAuthority.command(workspaceClaim({
    claimId: `claim:${runId}`,
    commandId: `workspace-claim:${runId}`,
    expectedFingerprint: digestValue({ git: workspace.git }),
    expectedGeneration: workspace.generation,
    expectedWatermark: workspace.watermark,
    holder: runId,
    operations: ["handoff_publication"],
  }));
}

function publicationReceipt(intent) {
  return operationReceipt(intent, {
    publication_digest: digestValue(intent.operation_input.publication),
    git_retention: {
      schema: "flow.git-retention-receipt/v1",
      repository_id: "github.com/Seavenly/example",
      commit_sha: promotedGitFacts().commit_sha,
      tree_sha: promotedGitFacts().tree_sha,
      retention_ref: `refs/flow/retained/${promotedGitFacts().commit_sha}`,
    },
  });
}

function deterministicGitRetentionAdapter() {
  return {
    observe(receipt) {
      return {
        schema: "flow.git-retention-observation/v1",
        available: true,
        repository_id: receipt.repository_id,
        commit_sha: receipt.commit_sha,
        tree_sha: receipt.tree_sha,
        retention_ref: receipt.retention_ref,
      };
    },
  };
}

function deterministicGitWorkspaceObservationAdapter({
  gitFacts = exactGitFacts(),
  promotion = false,
} = {}) {
  return {
    observe({ ref } = {}) {
      return {
        schema: "work.git-observation/v1",
        git: promotion && ref === promotedGitFacts().ref
          ? promotedGitFacts()
          : gitFacts,
      };
    },
  };
}

function observedGitFacts(repository, ref) {
  return {
    commit_sha: git(repository, ["rev-parse", "HEAD"]),
    tree_sha: git(repository, ["rev-parse", "HEAD^{tree}"]),
    ref,
    clean: git(repository, ["status", "--porcelain"]) === "",
  };
}

function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function exactGitFacts() {
  return {
    commit_sha: "1".repeat(40),
    tree_sha: "2".repeat(40),
    ref: "refs/heads/ticket/promoted-example",
    clean: true,
  };
}

function promotedGitFacts() {
  return {
    commit_sha: "3".repeat(40),
    tree_sha: "4".repeat(40),
    ref: "refs/heads/ticket/example",
    clean: true,
  };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestValue(value) {
  return sha256(Buffer.from(JSON.stringify(canonical(value))));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) =>
      [key, canonical(value[key])]));
  }
  return value;
}

async function until(condition) {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

function fixedHostIdentity(bootId, processIdentity) {
  return {
    observe() {
      return {
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      };
    },
  };
}
