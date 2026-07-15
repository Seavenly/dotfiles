import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { validateContract } from "./schema-validator.mjs";

export async function validateSealedGate({
  adapter,
  taskId,
  requestedGateSpecPath = null,
}) {
  const {
    gate: _gate,
    manifest: _manifest,
    ...validation
  } = await loadSealedGate({
    adapter,
    taskId,
    requestedGateSpecPath,
  });
  return validation;
}

export async function loadSealedGate({
  adapter,
  taskId,
  requestedGateSpecPath = null,
}) {
  const authority = await adapter.getTaskAuthority({ taskId });
  if (
    authority?.taskId !== taskId ||
    typeof authority.runId !== "string" ||
    typeof authority.stage !== "string" ||
    typeof authority.runManifestPath !== "string" ||
    !/^[0-9a-f]{64}$/.test(authority.runManifestSha256) ||
    typeof authority.gateSpecPath !== "string" ||
    !/^[0-9a-f]{64}$/.test(authority.gateSpecSha256)
  ) {
    throw new Error("Hermes adapter did not return launcher-pinned task authority");
  }
  if (
    requestedGateSpecPath !== null &&
    requestedGateSpecPath !== authority.gateSpecPath
  ) {
    return sealedGateError("requested gate spec is not pinned to the task");
  }

  const manifestBytes = await readFile(authority.runManifestPath);
  if (sha256(manifestBytes) !== authority.runManifestSha256) {
    throw new Error("run manifest digest does not match task authority");
  }
  const manifest = JSON.parse(manifestBytes);
  if (!(await validateContract(manifest)).valid) {
    throw new Error("task authority names an invalid run manifest");
  }
  if (manifest.identity.run_id !== authority.runId) {
    throw new Error("run manifest identity does not match task authority");
  }

  const gateBytes = await readFile(authority.gateSpecPath);
  if (sha256(gateBytes) !== authority.gateSpecSha256) {
    return sealedGateError("must match the gate digest pinned to the task");
  }
  const gate = JSON.parse(gateBytes);
  const gateResult = await validateContract(gate);
  if (!gateResult.valid) return { ...gateResult, gate: null, manifest: null };
  if (gate.stage !== authority.stage) {
    return sealedGateError("must match the stage pinned to the task");
  }
  const sealedInput = manifest.inputs.find(
    ({ kind, sealed_path: sealedPath }) =>
      kind === "gate" && sealedPath === authority.gateSpecPath,
  );
  if (!sealedInput || sealedInput.sha256 !== sha256(gateBytes)) {
    return sealedGateError("must match a gate input sealed by the run manifest");
  }
  const validation = validateGateForRun(gate, manifest);
  return {
    ...validation,
    gate: validation.valid ? gate : null,
    manifest: validation.valid ? manifest : null,
  };
}

function sealedGateError(message) {
  return {
    valid: false,
    gate: null,
    manifest: null,
    errors: [
      {
        instancePath: "",
        keyword: "sealedGate",
        message,
      },
    ],
  };
}

export function validateGateForRun(gate, manifest) {
  const errors = [];
  if (gate.run_id !== manifest.identity.run_id) {
    errors.push({
      instancePath: "/run_id",
      keyword: "runIdentity",
      message: "must match the run manifest",
    });
  }
  for (const [index, root] of gate.read_roots.entries()) {
    if (
      manifest.approved_read_roots.some((approved) =>
        pathIsWithin(approved, root),
      )
    ) {
      continue;
    }
    errors.push({
      instancePath: `/read_roots/${index}`,
      keyword: "approvedReadRoot",
      message: "must be contained by a run-approved read root",
    });
  }
  if (
    !manifest.approved_artifact_roots.some((root) =>
      pathIsWithin(root, gate.write_root),
    )
  ) {
    errors.push({
      instancePath: "/write_root",
      keyword: "approvedWriteRoot",
      message: "must be contained by a run-approved artifact root",
    });
  }
  return { valid: errors.length === 0, errors };
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
