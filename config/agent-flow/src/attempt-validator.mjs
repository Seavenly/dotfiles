import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { validateContract } from "./schema-validator.mjs";

// This is the authority boundary for worker output. Validation envelopes are
// durable results of this function, never trusted inputs to it.
export async function validateCompletedAttempt({
  adapter,
  taskId,
  stage,
  attempt,
  now = () => new Date(),
}) {
  const authority = await adapter.getTaskAuthority({ taskId });
  assertTaskAuthority(authority, taskId, stage);
  const { manifest, manifestBytes, graph } = await loadAuthority(
    authority.runManifestPath,
    authority.runManifestSha256,
  );
  if (manifest.identity.run_id !== authority.runId) {
    throw new Error("run manifest identity does not match task authority");
  }
  const completed = await adapter.getCompletedAttempt({ taskId, attempt });
  assertExpectedAttempt(completed, taskId, attempt);

  const sourceMetadata = completed.metadata ?? null;
  const handoff = sourceMetadata?.handoff ?? null;
  const handoffResult = await validateContract(handoff);
  const errors = handoffResult.valid
    ? []
    : [
        {
          code: "invalid_handoff",
          message: "completed attempt metadata does not contain a valid handoff",
        },
      ];
  const expectedStage = graph.stages.find(({ key }) => key === stage);
  if (!expectedStage) {
    throw new Error(`stage ${stage} is not declared by the sealed graph`);
  }
  validateIdentity(handoff, handoffResult, manifest, stage, attempt, errors);
  validateMeasurement(handoff, handoffResult, expectedStage, errors);

  const { approvedRealRoots, validationRealRoot } =
    await loadAuthorityDirectories(manifest);
  const artifacts = handoffResult.valid
    ? await validateArtifacts(
        handoff.artifacts,
        manifest.approved_artifact_roots,
        approvedRealRoots,
        validationRealRoot,
        taskId,
        attempt,
        errors,
      )
    : [];

  return {
    schema: "agent-flow.validation/v1",
    run_id: manifest.identity.run_id,
    stage,
    task_id: taskId,
    attempt,
    validated_at: now().toISOString(),
    source_metadata_sha256: sha256(JSON.stringify(sourceMetadata)),
    provenance: {
      run_manifest_path: authority.runManifestPath,
      run_manifest_sha256: sha256(manifestBytes),
      hermes_attempt_id: completed.attemptId,
    },
    valid: errors.length === 0,
    identity: {
      handoff_schema: "agent-flow.handoff/v1",
      run_id: handoffResult.valid ? handoff.run_id : manifest.identity.run_id,
      stage: handoffResult.valid ? handoff.stage : stage,
      attempt: handoffResult.valid ? handoff.attempt : attempt,
    },
    semantic: {
      required: expectedStage.semantic_measurement,
      passed:
        handoffResult.valid && typeof handoff.passed === "boolean"
          ? handoff.passed
          : null,
    },
    approved_artifact_roots: manifest.approved_artifact_roots,
    validated_artifact_root: validationRealRoot,
    artifacts,
    errors,
  };
}

function assertTaskAuthority(authority, taskId, stage) {
  if (
    authority?.taskId !== taskId ||
    authority.stage !== stage ||
    typeof authority.runId !== "string" ||
    typeof authority.runManifestPath !== "string" ||
    !/^[0-9a-f]{64}$/.test(authority.runManifestSha256)
  ) {
    throw new Error("Hermes adapter did not return launcher-pinned task authority");
  }
}

async function loadAuthority(runManifestPath, expectedRunManifestSha256) {
  const manifestBytes = await readFile(runManifestPath);
  if (sha256(manifestBytes) !== expectedRunManifestSha256) {
    throw new Error("run manifest digest does not match the sealed gate spec");
  }
  const manifest = JSON.parse(manifestBytes);
  if (!(await validateContract(manifest)).valid) {
    throw new Error("cannot validate an attempt against an invalid run manifest");
  }

  const graphBytes = await readFile(manifest.graph.sealed_path);
  if (sha256(graphBytes) !== manifest.graph.sha256) {
    throw new Error("sealed graph digest does not match the run manifest");
  }
  const graph = JSON.parse(graphBytes);
  const graphResult = await validateContract(graph);
  if (
    !graphResult.valid ||
    graph.name !== manifest.graph.name ||
    graph.version !== manifest.graph.version ||
    graph.flow !== manifest.graph.flow
  ) {
    throw new Error("sealed graph identity does not match the run manifest");
  }
  return { manifest, manifestBytes, graph };
}

function assertExpectedAttempt(completed, taskId, attempt) {
  if (
    completed?.state !== "completed" ||
    completed.taskId !== taskId ||
    completed.attempt !== attempt ||
    typeof completed.attemptId !== "string" ||
    completed.attemptId.length === 0
  ) {
    throw new Error("Hermes adapter did not return the expected completed attempt");
  }
}

function validateIdentity(handoff, result, manifest, stage, attempt, errors) {
  if (
    result.valid &&
    (handoff.run_id !== manifest.identity.run_id ||
      handoff.flow !== manifest.identity.flow ||
      handoff.stage !== stage ||
      handoff.attempt !== attempt)
  ) {
    errors.push({
      code: "identity_mismatch",
      message: "handoff identity does not match the completed attempt",
    });
  }
}

function validateMeasurement(handoff, result, expectedStage, errors) {
  if (
    result.valid &&
    expectedStage.semantic_measurement &&
    typeof handoff.passed !== "boolean"
  ) {
    errors.push({
      code: "missing_measurement",
      message: "semantic stage handoff must record passed",
    });
  }
}

async function loadAuthorityDirectories(manifest) {
  const runRealPath = await realpath(manifest.identity.run_directory);
  const approvedRealRoots = await Promise.all(
    manifest.approved_artifact_roots.map((root) => realpath(root)),
  );
  if (approvedRealRoots.some((root) => !pathIsWithin(runRealPath, root))) {
    throw new Error("approved artifact root resolves outside the run directory");
  }
  await mkdir(manifest.identity.validation_directory, {
    recursive: true,
    mode: 0o700,
  });
  const validationRealRoot = await realpath(
    manifest.identity.validation_directory,
  );
  if (!pathIsWithin(runRealPath, validationRealRoot)) {
    throw new Error("validation directory resolves outside the run directory");
  }
  return { approvedRealRoots, validationRealRoot };
}

async function validateArtifacts(
  declaredArtifacts,
  approvedRoots,
  approvedRealRoots,
  validationDirectory,
  taskId,
  attempt,
  errors,
) {
  const artifacts = [];
  for (const [index, artifact] of declaredArtifacts.entries()) {
    artifacts.push(
      await validateArtifact(
        artifact,
        approvedRoots,
        approvedRealRoots,
        validationDirectory,
        taskId,
        attempt,
        index,
        errors,
      ),
    );
  }
  return artifacts;
}

async function validateArtifact(
  artifact,
  approvedRoots,
  approvedRealRoots,
  validationDirectory,
  taskId,
  attempt,
  index,
  errors,
) {
  const lexicallyContained = approvedRoots.some((root) =>
    pathIsWithin(root, artifact.path),
  );
  let artifactRealPath = null;
  if (lexicallyContained) {
    try {
      artifactRealPath = await realpath(artifact.path);
    } catch {
      errors.push({
        code: "artifact_unreadable",
        message: `${artifact.path} could not be read`,
      });
    }
  }
  const contained =
    artifactRealPath !== null &&
    approvedRealRoots.some((root) => pathIsWithin(root, artifactRealPath));
  if (!lexicallyContained || (artifactRealPath !== null && !contained)) {
    errors.push({
      code: "artifact_outside_root",
      message: `${artifact.path} is outside the approved artifact roots`,
    });
  }
  if (!contained) {
    return artifactEvidence(artifact, null, null, false);
  }

  let artifactBytes = null;
  let actualSha256 = null;
  try {
    artifactBytes = await readFile(artifactRealPath);
    actualSha256 = sha256(artifactBytes);
  } catch {
    errors.push({
      code: "artifact_unreadable",
      message: `${artifact.path} could not be read`,
    });
  }
  const valid = actualSha256 === artifact.sha256;
  if (actualSha256 !== null && !valid) {
    errors.push({
      code: "artifact_hash_mismatch",
      message: `${artifact.path} does not match its recorded digest`,
    });
  }
  const validatedPath = valid
    ? await snapshotArtifact(
        artifactBytes,
        actualSha256,
        validationDirectory,
        taskId,
        attempt,
        index,
      )
    : null;
  return artifactEvidence(artifact, validatedPath, actualSha256, valid);
}

async function snapshotArtifact(
  bytes,
  digest,
  validationDirectory,
  taskId,
  attempt,
  index,
) {
  const directory = join(
    validationDirectory,
    sha256(taskId).slice(0, 16),
    String(attempt),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${index}-${digest}.artifact`);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (error.code !== "EEXIST" || sha256(await readFile(path)) !== digest) {
      throw error;
    }
  }
  return path;
}

function artifactEvidence(artifact, path, actualSha256, valid) {
  return {
    source_path: artifact.path,
    path,
    expected_sha256: artifact.sha256,
    actual_sha256: actualSha256,
    valid,
  };
}

function pathIsWithin(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate))
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
