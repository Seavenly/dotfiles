import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  getArtifactAuthority,
  getResourceHandoffAuthority,
  getWorkspaceAuthority,
} from "../src/work-authority.mjs";
import {
  confirmedLaunchRequest,
} from "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

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
    registration_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: "workspace-register:producer",
      command_digest: digestValue(workspaceRegistration()),
    },
    legal_actions: [],
  });

  const bytes = Buffer.from("retained review candidate\n");
  const artifactDigest = sha256(bytes);
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
    pins: [{ holder: "run", id: "run:producer" }],
    byte_availability: "available",
    registration_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: `artifact-record:${artifactDigest}`,
      command_digest: digestValue(artifactRegistration(bytes, artifactDigest)),
    },
    legal_actions: [],
  });
  assert.equal(workspaceAuthority.command(workspaceRegistration()).created, false);
  assert.equal(artifactAuthority.command(artifactRegistration(bytes, artifactDigest)).created,
    false);
  const conflict = workspaceRegistration();
  conflict.registration.disposition = "conflicting";
  assert.equal(workspaceAuthority.command(conflict).code, "idempotency_conflict");
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
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest, launch.run_id));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
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
    const stalePrepared = runtime.prepare(staleProposal);
    const staleRun = runtime.launch(confirmedLaunchRequest(stalePrepared));
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
  }
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
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest, launch.run_id));

  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.length === 1);
  await new Promise((resolve) => setImmediate(resolve));

  const run = runtime.query({ run_id: launch.run_id });
  assert.equal(run.phase, "active");
  assert.equal(run.effects[0].status, "unresolved");
  assert.deepEqual(run.handoffs, []);
  assert.equal(workspaceAuthority.query({
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  }).generation, 1);
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
  const candidateGit = observedGitFacts(producerWorkspace, "refs/heads/producer");
  git(producerWorkspace, ["push", "origin", "producer"]);
  const gitRetentionAdapter = createGitRetentionAdapter({
    resolveRepository(repositoryId) {
      assert.equal(repositoryId, "example/repository");
      return repository;
    },
  });
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
  git(producerWorkspace, ["reset", "--hard", candidateGit.commit_sha]);
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
    },
  });
  const wrongPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    `sha256:${"0".repeat(64)}`,
  ));
  assert.equal(consumerRuntime.launch(confirmedLaunchRequest(wrongPrepared)).code,
    "invalid_resource_handoff_binding");
  const disallowedPrepared = consumerRuntime.prepare(consumerOperationProposal(
    handoffId,
    retained.handoff_digest,
    "unapproved_mutation",
  ));
  assert.equal(
    consumerRuntime.launch(confirmedLaunchRequest(disallowedPrepared)).code,
    "invalid_resource_handoff_binding",
  );

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
  assert.deepEqual(pinned.consumer_pins.map(({ run_id: runId, operations }) => ({
    run_id: runId,
    operations,
  })), [{ run_id: consumer.run_id, operations: ["workspace_mutation"] }]);
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
  assert.notEqual(settledHandoff.watermark, pinned.watermark);
  git(repository, ["update-ref", "-d", retained.git_retention.retention_ref]);
  assert.equal(consumerHandoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: handoffId,
  }).git_availability, "missing");
});

function workspaceRegistration(canonicalPath = "/tmp/producer-worktree", {
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
      disposition: "producer_owned",
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
    allowed_consumer_operations: ["workspace_mutation"],
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
) {
  const proposal = registeredOperationProposal({ checkpointBound: false });
  const claim = {
    kind: "resource_handoff",
    id: handoffId,
    digest: handoffDigest,
    operations: [operation],
  };
  proposal.graph.cards[0].inputs = {
    resource_handoff: {
      handoff_id: handoffId,
      handoff_digest: handoffDigest,
      operation,
    },
  };
  proposal.graph.cards[0].resource_claims.push(claim);
  proposal.explicit_facts.resource_claims.push(claim);
  proposal.explicit_facts.limits.max_resources = 2;
  return proposal;
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

function deterministicGitWorkspaceObservationAdapter({ promotion = false } = {}) {
  let observationCount = 0;
  return {
    observe() {
      observationCount += 1;
      return {
        schema: "work.git-observation/v1",
        git: promotion && observationCount > 1
          ? promotedGitFacts()
          : exactGitFacts(),
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
    ref: "refs/heads/ticket/example",
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
