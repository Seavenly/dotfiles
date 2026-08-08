import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { serializeInlineArtifact } from "./inline-artifact.mjs";
import { validateContract } from "./schema-validator.mjs";

// This is the authority boundary for worker output. Validation envelopes are
// durable results of this function, never trusted inputs to it.
export async function validateCompletedAttempt({
  adapter,
  taskId,
  stage,
  attempt,
  requirePassed = false,
  expectedRunAuthority = null,
  now = () => new Date(),
  signal = undefined,
}) {
  const authority = await adapter.getTaskAuthority({ taskId, signal });
  assertTaskAuthority(authority, taskId, stage);
  assertExpectedRunAuthority(authority, expectedRunAuthority);
  const { manifest, manifestBytes, graph } = await loadAuthority(
    authority.runManifestPath,
    authority.runManifestSha256,
    signal,
  );
  if (manifest.identity.run_id !== authority.runId) {
    throw new Error("run manifest identity does not match task authority");
  }
  const completed = await adapter.getCompletedAttempt({
    taskId,
    attempt,
    signal,
  });
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
  const measurementRequired =
    expectedStage.semantic_measurement || requirePassed;
  validateMeasurement(
    handoff,
    handoffResult,
    measurementRequired,
    requirePassed,
    errors,
  );

  const { approvedRealRoots, validationRealRoot } =
    await loadAuthorityDirectories(manifest, signal);
  const artifacts = handoffResult.valid
    ? await validateArtifacts(
        handoff.artifacts,
        manifest.approved_artifact_roots,
        approvedRealRoots,
        validationRealRoot,
        taskId,
        attempt,
        errors,
        signal,
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
      attempt,
    },
    semantic: {
      required: measurementRequired,
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

function assertExpectedRunAuthority(authority, expected) {
  if (expected === null) return;
  if (
    authority.runId !== expected.runId ||
    authority.runManifestPath !== expected.runManifestPath ||
    authority.runManifestSha256 !== expected.runManifestSha256
  ) {
    throw new Error(
      "producer task authority does not match validation gate run authority",
    );
  }
}

async function loadAuthority(
  runManifestPath,
  expectedRunManifestSha256,
  signal,
) {
  const manifestBytes = await readFile(runManifestPath, { signal });
  if (sha256(manifestBytes) !== expectedRunManifestSha256) {
    throw new Error("run manifest digest does not match the sealed gate spec");
  }
  const manifest = JSON.parse(manifestBytes);
  if (!(await validateContract(manifest)).valid) {
    throw new Error("cannot validate an attempt against an invalid run manifest");
  }

  const graphBytes = await readFile(manifest.graph.sealed_path, { signal });
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
      (handoff.attempt !== undefined && handoff.attempt !== attempt))
  ) {
    errors.push({
      code: "identity_mismatch",
      message: "handoff identity does not match the completed attempt",
    });
  }
}

function validateMeasurement(
  handoff,
  result,
  measurementRequired,
  requirePassed,
  errors,
) {
  if (
    result.valid &&
    measurementRequired &&
    typeof handoff.passed !== "boolean"
  ) {
    errors.push({
      code: "missing_measurement",
      message: "handoff must record passed when a measurement is required",
    });
    return;
  }
  if (result.valid && requirePassed && handoff.passed === false) {
    errors.push({
      code: "semantic_failure",
      message: "handoff must pass before downstream work can be released",
    });
  }
}

async function loadAuthorityDirectories(manifest, signal) {
  throwIfAborted(signal);
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
  throwIfAborted(signal);
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
  signal,
) {
  const artifacts = [];
  for (const [index, artifact] of declaredArtifacts.entries()) {
    throwIfAborted(signal);
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
        signal,
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
  signal,
) {
  if (Object.hasOwn(artifact, "inline")) {
    const artifactBytes = serializeInlineArtifact(artifact.inline);
    const digest = sha256(artifactBytes);
    const validatedPath = await snapshotArtifact(
      artifactBytes,
      digest,
      validationDirectory,
      taskId,
      attempt,
      index,
      signal,
    );
    return {
      source_path: validatedPath,
      path: validatedPath,
      expected_sha256: digest,
      actual_sha256: digest,
      valid: true,
    };
  }

  const lexicallyContained = approvedRoots.some((root) =>
    pathIsWithin(root, artifact.path),
  );
  let artifactRealPath = null;
  if (lexicallyContained) {
    try {
      artifactRealPath = await realpath(artifact.path);
    } catch {
      throwIfAborted(signal);
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

  throwIfAborted(signal);
  let artifactStat;
  try {
    artifactStat = await lstat(artifactRealPath);
  } catch {
    throwIfAborted(signal);
    errors.push({
      code: "artifact_unreadable",
      message: `${artifact.path} could not be read`,
    });
    return artifactEvidence(artifact, null, null, false);
  }
  if (!artifactStat.isFile()) {
    errors.push({
      code: "artifact_unreadable",
      message: `${artifact.path} is not a regular file`,
    });
    return artifactEvidence(artifact, null, null, false);
  }

  let artifactBytes = null;
  let actualSha256 = null;
  try {
    artifactBytes = await readFile(artifactRealPath, { signal });
    actualSha256 = sha256(artifactBytes);
  } catch {
    throwIfAborted(signal);
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
        signal,
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
  signal,
) {
  throwIfAborted(signal);
  const directory = join(
    validationDirectory,
    sha256(taskId).slice(0, 16),
    String(attempt),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${index}-${digest}.artifact`);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o400, signal });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      sha256(await readFile(path, { signal })) !== digest
    ) {
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}
