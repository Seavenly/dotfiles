import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadContractCatalog } from "./contract-catalog.mjs";
import { resolveLaunchPolicy } from "./launch-selector.mjs";
import { isExactSequence } from "./validation.mjs";

const STATUSES = ["passed", "failed", "blocked", "not_run"];

export async function queryTransition({ configDirectory }) {
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const policyPath = join(configDirectory, "launch-policy.v1.json");
  const catalogPath = join(configDirectory, "contracts", "catalog.v1.json");
  const inventoryPath = join(configDirectory, "legacy-baselines.v1.json");
  const [
    ledgerBytes,
    policyBytes,
    inventoryBytes,
    catalogBytes,
    catalog,
    selection,
  ] =
    await Promise.all([
      readFile(ledgerPath),
      readFile(policyPath),
      readFile(inventoryPath),
      readFile(catalogPath),
      loadContractCatalog({ catalogPath }),
      resolveLaunchPolicy({ policyPath }),
    ]);
  const ledger = JSON.parse(ledgerBytes);
  const policy = JSON.parse(policyBytes);
  const inventory = JSON.parse(inventoryBytes);

  validateLedger(ledger);
  await validateEvidence(configDirectory, ledger.evidence);
  validateAuthorityConsistency({ catalog, inventory, ledger, policy, selection });

  const evidenceStatuses = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const evidence of ledger.evidence) evidenceStatuses[evidence.status] += 1;

  const legalActions = [];
  if (selection.implementation === "legacy-claude/v1") {
    legalActions.push("launch_default_legacy");
  }
  if (policy.implementations["legacy-agent-flow/v1"]?.launch_enabled) {
    legalActions.push("launch_explicit_legacy_agent_flow");
  }
  if (inventory.baselines.every(({ frozen }) => frozen === true)) {
    legalActions.push("inspect_frozen_baselines");
  }

  return {
    schema: "flow.transition-projection/v1",
    watermark: {
      sequence: ledger.sequence,
      ledger: digest(ledgerBytes),
      policy: selection.policy_watermark,
      catalog: digest(catalogBytes),
      legacy_inventory: digest(inventoryBytes),
    },
    release: ledger.release.id,
    environment: ledger.environment,
    selected_implementation: selection.implementation,
    evidence_statuses: evidenceStatuses,
    defects: ledger.defects,
    exceptions: ledger.exceptions,
    decision: ledger.decision,
    legal_actions: legalActions,
  };
}

function validateLedger(ledger) {
  if (ledger.schema !== "flow.transition-ledger/v1") {
    throw new Error(`unsupported transition ledger: ${ledger.schema ?? "missing"}`);
  }
  if (!isExactSequence(ledger.status_vocabulary, STATUSES)) {
    throw new Error("transition ledger status vocabulary is invalid");
  }
  if (!ledger.release?.id || !ledger.environment?.id ||
      !ledger.environment?.kind || !ledger.environment?.os ||
      !ledger.environment?.architecture || !Number.isInteger(ledger.sequence)) {
    throw new Error("transition ledger identity is incomplete");
  }
  if (!Array.isArray(ledger.defects) || !Array.isArray(ledger.exceptions)) {
    throw new Error("transition ledger defects and exceptions must be explicit arrays");
  }
  for (const evidence of ledger.evidence ?? []) {
    if (!STATUSES.includes(evidence.status) || !evidence.recorded_at) {
      throw new Error(`invalid transition evidence: ${evidence.id ?? "missing"}`);
    }
    const hasEvidence = evidence.path !== null || evidence.sha256 !== null;
    if (hasEvidence && (!evidence.path || !/^[0-9a-f]{64}$/.test(evidence.sha256))) {
      throw new Error(`transition evidence is incomplete: ${evidence.id}`);
    }
  }
}

async function validateEvidence(configDirectory, evidenceRecords) {
  const authorityRoot = await realpath(resolve(configDirectory));
  for (const evidence of evidenceRecords) {
    if (evidence.path === null) continue;
    const lexicalEvidencePath = resolve(authorityRoot, evidence.path);
    const relativeEvidencePath = relative(authorityRoot, lexicalEvidencePath);
    if (isOutsideAuthority(relativeEvidencePath)) {
      throw new Error(
        `transition evidence is outside the transition configuration root: ${evidence.id}`,
      );
    }
    const evidencePath = await realpath(lexicalEvidencePath);
    const relativeRealEvidencePath = relative(authorityRoot, evidencePath);
    if (isOutsideAuthority(relativeRealEvidencePath)) {
      throw new Error(
        `transition evidence resolves outside the transition configuration root: ${evidence.id}`,
      );
    }
    const bytes = await readFile(evidencePath);
    if (digest(bytes) !== `sha256:${evidence.sha256}`) {
      throw new Error(`transition evidence digest changed: ${evidence.id}`);
    }
  }
}

function isOutsideAuthority(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
}

function validateAuthorityConsistency({ catalog, inventory, ledger, policy, selection }) {
  if (inventory.schema !== "flow.legacy-baseline-inventory/v1") {
    throw new Error("legacy baseline inventory contract is invalid");
  }
  const baselines = new Map(
    inventory.baselines.map((baseline) => [baseline.implementation, baseline]),
  );
  for (const [implementation, rootName] of [
    ["legacy-claude/v1", "legacy_claude"],
    ["legacy-agent-flow/v1", "legacy_agent_flow"],
  ]) {
    const expectedRoot = catalog.authority_roots[rootName];
    if (baselines.get(implementation)?.authority_root !== expectedRoot ||
        policy.implementations[implementation]?.authority_root !== expectedRoot) {
      throw new Error(`authority root differs for ${implementation}`);
    }
  }
  if (policy.implementations["flow-runtime/v1"]?.authority_root !==
      catalog.authority_roots.replacement) {
    throw new Error("replacement authority root differs from the catalog");
  }
  if (selection.implementation !== policy.default_implementation ||
      selection.implementation !== inventory.baselines[0]?.implementation) {
    throw new Error("legacy default differs across transition authority");
  }
  if (ledger.decision?.selected_implementation !== selection.implementation ||
      ledger.decision?.replacement_launch_enabled !==
        policy.implementations["flow-runtime/v1"]?.launch_enabled) {
    throw new Error("transition decision contradicts the launch policy");
  }
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
