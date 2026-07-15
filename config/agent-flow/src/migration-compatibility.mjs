import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { validateContract } from "./schema-validator.mjs";

export function deriveResumeCompatibility({
  candidate,
  manifest,
  profileIdentity,
  revision,
}) {
  const changes = [];
  if (manifest.implementation.revision !== revision) {
    changes.push(change(
      "implementation",
      "agent-flow",
      digest(manifest.implementation.revision),
      digest(revision),
    ));
  }
  const contractNames = new Set([
    ...manifest.implementation.compatible_contracts,
    ...candidate.compatibleContracts,
  ]);
  for (const name of [...contractNames].sort()) {
    const priorPresent = manifest.implementation.compatible_contracts
      .includes(name);
    const nextPresent = candidate.compatibleContracts.includes(name);
    if (priorPresent === nextPresent) continue;
    changes.push(change(
      "contract",
      name,
      priorPresent ? digest(name) : absentDigest(),
      nextPresent ? digest(name) : absentDigest(),
    ));
  }
  const profileNames = new Set([
    ...manifest.profiles.required,
    ...profileIdentity.required,
  ]);
  for (const name of [...profileNames].sort()) {
    const prior = manifest.profiles.fingerprints[name] ?? absentDigest();
    const next = profileIdentity.fingerprints[name] ?? absentDigest();
    if (prior === next) continue;
    changes.push(change("profile", name, prior, next));
  }
  if (
    manifest.profiles.profile_set_fingerprint !==
      profileIdentity.profile_set_fingerprint &&
    !changes.some(({ kind }) => kind === "profile")
  ) {
    changes.push(change(
      "profile",
      "profile-set",
      manifest.profiles.profile_set_fingerprint,
      profileIdentity.profile_set_fingerprint,
    ));
  }
  if (manifest.graph.sha256 !== candidate.graphIdentity.sha256) {
    changes.push(change(
      "graph",
      manifest.graph.name,
      manifest.graph.sha256,
      candidate.graphIdentity.sha256,
    ));
  }
  const priorInputs = new Map(
    manifest.inputs.map((input) => [`${input.kind}\0${input.name}`, input]),
  );
  const nextInputs = new Map(
    candidate.inputs.map((input) => [`${input.kind}\0${input.name}`, input]),
  );
  const inputKeys = [...new Set([
    ...priorInputs.keys(),
    ...nextInputs.keys(),
  ])].sort();
  for (const key of inputKeys) {
    const priorInput = priorInputs.get(key);
    const nextInput = nextInputs.get(key);
    const prior = priorInput?.sha256 ?? absentDigest();
    const next = nextInput?.sha256 ?? absentDigest();
    if (prior === next) continue;
    const input = priorInput ?? nextInput;
    changes.push(change(
      migrationInputKind(input.kind),
      migrationInputName(input),
      prior,
      next,
    ));
  }
  return {
    changes,
    contentChanged: manifest.implementation.content_set_fingerprint !==
      candidate.contentSetFingerprint,
    from: compatibilityIdentity(manifest),
    to: {
      ...compatibilityIdentity(manifest),
      implementation_revision: revision,
      profile_set_fingerprint: profileIdentity.profile_set_fingerprint,
      content_set_fingerprint: candidate.contentSetFingerprint,
    },
  };
}

export async function requireMigrationApproval({
  changes,
  from,
  runDirectory,
  runId,
  to,
}) {
  const migrationsDirectory = join(runDirectory, "migrations");
  let entries;
  try {
    entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("existing run requires an approved migration receipt");
    }
    throw error;
  }
  const matching = [];
  for (const entry of entries) {
    const receiptPath = join(migrationsDirectory, entry.name);
    const receipt = parseJson(await readFile(receiptPath));
    if (receipt?.schema !== "agent-flow.migration-receipt/v1") continue;
    const validation = await validateContract(receipt);
    if (!validation.valid) {
      throw new Error(`migration receipt ${entry.name} is invalid`);
    }
    if (
      receipt.run_id !== runId ||
      entry.name !== `${receipt.receipt_id}.json`
    ) {
      throw new Error(
        `migration receipt ${entry.name} does not match its run or path`,
      );
    }
    await validateEvidence(receipt.approval.evidence_path, migrationsDirectory);
    if (
      sameIdentity(receipt.from, from) &&
      sameIdentity(receipt.to, to) &&
      sameChanges(receipt.changes, changes)
    ) matching.push(receipt);
  }
  if (matching.length !== 1) {
    throw new Error(
      matching.length === 0
        ? "existing run requires a migration receipt explaining every " +
          "compatibility change"
        : "existing run has ambiguous migration approval",
    );
  }
  return matching[0];
}

async function validateEvidence(evidencePath, migrationsDirectory) {
  const [directory, evidence] = await Promise.all([
    realpath(migrationsDirectory),
    realpath(evidencePath),
  ]);
  if (!pathIsWithin(directory, evidence) || !(await stat(evidence)).isFile()) {
    throw new Error(
      "migration approval evidence must be a regular file beneath migrations",
    );
  }
}

function pathIsWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function sameChanges(left, right) {
  const canonical = (changes) => [...changes]
    .map(({ kind, name, prior_sha256: prior, next_sha256: next }) =>
      JSON.stringify([kind, name, prior, next])
    )
    .sort();
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameIdentity(left, right) {
  return [
    "contract_version",
    "implementation_revision",
    "profile_set_fingerprint",
    "content_set_fingerprint",
  ].every((field) => left[field] === right[field]);
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function compatibilityIdentity(manifest) {
  return {
    contract_version: manifest.contract_version,
    implementation_revision: manifest.implementation.revision,
    profile_set_fingerprint: manifest.profiles.profile_set_fingerprint,
    content_set_fingerprint: manifest.implementation.content_set_fingerprint,
  };
}

function migrationInputKind(kind) {
  return ["gate", "skill", "role-contract"].includes(kind) ? kind : "input";
}

function migrationInputName({ kind, name }) {
  return ["gate", "skill", "role-contract"].includes(kind)
    ? name
    : `${kind}/${name}`;
}

function change(kind, name, prior, next) {
  return {
    kind,
    name,
    prior_sha256: prior,
    next_sha256: next,
  };
}

function absentDigest() {
  return digest("agent-flow:absent");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
