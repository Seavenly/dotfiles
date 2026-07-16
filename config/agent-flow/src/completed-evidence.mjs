import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { loadSealedGate } from "./run-bundle-validator.mjs";
import { validateContract } from "./schema-validator.mjs";

export async function loadCompletedEvidence({
  adapter,
  evidencePath,
  manifest,
  materialization,
  requirePassed = false,
  stage,
  validationStage,
}) {
  const validation = JSON.parse(await readFile(evidencePath, "utf8"));
  if (!(await validateContract(validation)).valid || !validation.valid) {
    throw new Error(`invalid completed-attempt evidence for ${stage}`);
  }
  const validatorTaskId = requiredTask(materialization, validationStage);
  const producerTaskId = requiredTask(materialization, stage);
  const sealed = await loadSealedGate({ adapter, taskId: validatorTaskId });
  if (!sealed.valid) throw new Error(`${validationStage} lacks sealed validator authority`);
  const { gate, taskAuthority } = sealed;
  if (
    gate.kind !== "handoff-validation" ||
    gate.handoff_validation.producer_stage !== stage ||
    gate.outputs.length !== 1 || gate.outputs[0] !== evidencePath ||
    taskAuthority.producerTaskId !== producerTaskId
  ) throw new Error(`${validationStage} does not validate ${stage}`);
  const [validatorAttempt, producerAttempt] = await Promise.all([
    adapter.getTerminalCompletedAttempt({ taskId: validatorTaskId }),
    adapter.getTerminalCompletedAttempt({ taskId: producerTaskId }),
  ]);
  assertCompleted(validatorAttempt, validatorTaskId);
  assertCompleted(producerAttempt, producerTaskId);
  const handoff = producerAttempt.metadata?.handoff ?? null;
  if (!(await validateContract(handoff)).valid) {
    throw new Error(`${stage} terminal attempt lacks a valid handoff`);
  }
  if (
    validation.run_id !== manifest.identity.run_id || validation.stage !== stage ||
    validation.task_id !== producerTaskId || validation.attempt !== producerAttempt.attempt ||
    validation.provenance.hermes_attempt_id !== producerAttempt.attemptId ||
    validation.provenance.run_manifest_path !== taskAuthority.runManifestPath ||
    validation.provenance.run_manifest_sha256 !== taskAuthority.runManifestSha256 ||
    validation.source_metadata_sha256 !== sha256(JSON.stringify(producerAttempt.metadata ?? null)) ||
    handoff.run_id !== manifest.identity.run_id || handoff.flow !== manifest.identity.flow ||
    handoff.stage !== stage ||
    (handoff.attempt !== undefined && handoff.attempt !== producerAttempt.attempt) ||
    validation.semantic.passed !== (typeof handoff.passed === "boolean" ? handoff.passed : null) ||
    (requirePassed && handoff.passed !== true)
  ) throw new Error(`${stage} evidence does not match its terminal producer attempt`);
  const validationRoot = await realpath(manifest.identity.validation_directory);
  if (await realpath(validation.validated_artifact_root) !== validationRoot) {
    throw new Error(`${stage} evidence names another validation root`);
  }
  const declared = new Map(handoff.artifacts.map((artifact) => [artifact.path, artifact]));
  const artifacts = [];
  for (const artifact of validation.artifacts) {
    const snapshot = await realpath(artifact.path);
    if (!within(validationRoot, snapshot)) throw new Error(`${stage} snapshot escaped validation root`);
    const bytes = await readFile(snapshot);
    const digest = sha256(bytes);
    const source = declared.get(artifact.source_path);
    if (
      !artifact.valid || digest !== artifact.actual_sha256 ||
      artifact.expected_sha256 !== source?.sha256
    ) throw new Error(`${stage} snapshot does not match terminal handoff metadata`);
    artifacts.push({ bytes, sha256: digest, snapshot, sourcePath: artifact.source_path });
  }
  return { artifacts, handoff, validation };
}

export async function loadCompletedGateEvidence({
  adapter,
  gate,
  manifest,
  materialization,
  stage,
}) {
  if (gate.kind !== "command" || gate.stage !== stage) {
    throw new Error(`${stage} is not a sealed command gate`);
  }
  const taskId = requiredTask(materialization, stage);
  const attempt = await adapter.getTerminalCompletedAttempt({ taskId });
  assertCompleted(attempt, taskId);
  const handoff = attempt.metadata?.handoff ?? null;
  if (!(await validateContract(handoff)).valid) {
    throw new Error(`${stage} terminal attempt lacks a valid handoff`);
  }
  if (
    handoff.run_id !== manifest.identity.run_id ||
    handoff.flow !== manifest.identity.flow ||
    handoff.stage !== stage ||
    typeof handoff.passed !== "boolean" ||
    (handoff.attempt !== undefined && handoff.attempt !== attempt.attempt)
  ) {
    throw new Error(`${stage} handoff does not match its terminal gate attempt`);
  }
  const declared = handoff.artifacts.filter(({ path }) => typeof path === "string");
  if (
    declared.length !== gate.outputs.length ||
    new Set(declared.map(({ path }) => path)).size !== declared.length ||
    gate.outputs.some((path) => !declared.some((artifact) => artifact.path === path))
  ) {
    throw new Error(`${stage} handoff does not name the exact sealed gate outputs`);
  }
  const artifactRoot = await realpath(manifest.identity.artifact_directory);
  const artifacts = [];
  const commandResults = [];
  for (const [index, output] of gate.outputs.entries()) {
    const artifact = declared.find(({ path }) => path === output);
    const canonical = await realpath(output);
    if (!within(artifactRoot, canonical)) {
      throw new Error(`${stage} output escaped the approved artifact root`);
    }
    const bytes = await readFile(canonical);
    const digest = sha256(bytes);
    if (digest !== artifact.sha256) {
      throw new Error(`${stage} output changed after its terminal attempt`);
    }
    artifacts.push({ bytes, path: canonical, sha256: digest });
    if (index < gate.commands.length) {
      const result = JSON.parse(bytes);
      if (
        !(await validateContract(result)).valid ||
        result.run_id !== manifest.identity.run_id || result.stage !== stage ||
        result.gate_name !== gate.name || result.gate_version !== gate.version ||
        result.command_index !== index ||
        JSON.stringify(result.argv) !== JSON.stringify(gate.commands[index].argv) ||
        result.cwd !== gate.commands[index].cwd
      ) throw new Error(`${stage} command result ${index + 1} differs from the sealed gate`);
      commandResults.push(result);
    }
  }
  const passed = commandResults.length === gate.commands.length &&
    commandResults.every(({ exit_code, termination }) =>
      exit_code === 0 && termination === "exit"
    );
  if (handoff.passed !== passed) {
    throw new Error(`${stage} handoff passed flag differs from its command results`);
  }
  return { artifacts, attempt, commandResults, handoff, passed };
}

function requiredTask(materialization, stage) {
  const taskId = materialization.tasks?.[stage];
  if (typeof taskId !== "string") throw new Error(`materialization omits task ${stage}`);
  return taskId;
}
function assertCompleted(attempt, taskId) {
  if (
    attempt?.taskId !== taskId || attempt.state !== "completed" ||
    !Number.isInteger(attempt.attempt) || attempt.attempt < 1 ||
    typeof attempt.attemptId !== "string" || attempt.attemptId.length === 0
  ) throw new Error(`task ${taskId} lacks a terminal completed attempt`);
}
function within(root, path) {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith("../") && !isAbsolute(value));
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
