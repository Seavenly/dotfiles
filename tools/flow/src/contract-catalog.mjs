import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { authorityRootsAreDisjoint } from "./authority-root.mjs";
import { isExactSequence } from "./validation.mjs";

const FLOW_RUNTIME_OPERATIONS = [
  "prepare",
  "launch",
  "command",
  "query",
  "watch",
];
const LEGACY_IMPORT_VALIDATIONS = [
  "digest",
  "schema",
  "provenance",
  "redaction",
  "classification",
  "retention",
  "allowed_use",
];
const ALLOWED_LEGACY_SUBJECTS = ["artifact_bytes"];
const FORBIDDEN_LEGACY_AUTHORITY = [
  "lifecycle_state",
  "grants",
  "checkpoints",
  "approval",
  "review_currency",
  "integration_eligibility",
  "effect_causation",
  "completion",
];

export async function loadContractCatalog({ catalogPath, homeDirectory, stateDirectory }) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schema !== "flow.contract-catalog/v1") {
    throw new Error(`unsupported contract catalog: ${catalog.schema ?? "missing"}`);
  }
  if (!isExactSequence(catalog.flow_runtime?.operations, FLOW_RUNTIME_OPERATIONS)) {
    throw new Error("contract catalog must expose exactly the five FlowRuntime operations");
  }
  if (!Array.isArray(catalog.contracts)) {
    throw new Error("contract catalog contracts must be an explicit array");
  }
  const roots = Object.values(catalog.authority_roots ?? {});
  if (roots.length === 0 || !authorityRootsAreDisjoint(roots, {
    homeDirectory,
    stateDirectory,
  })) {
    throw new Error("contract catalog authority roots must be disjoint");
  }
  if (!Array.isArray(catalog.legacy_import?.adapters) ||
      !isExactSequence(
        catalog.legacy_import.required_validations,
        LEGACY_IMPORT_VALIDATIONS,
      ) || !isExactSequence(
        catalog.legacy_import.allowed_subjects,
        ALLOWED_LEGACY_SUBJECTS,
      ) || !isExactSequence(
        catalog.legacy_import.forbidden_authority,
        FORBIDDEN_LEGACY_AUTHORITY,
      )) {
    throw new Error("contract catalog legacy import policy is incomplete");
  }
  for (const adapter of catalog.legacy_import.adapters) {
    if (!isValidLegacyImportAdapter(catalog, adapter)) {
      throw new Error("contract catalog legacy import adapter is invalid");
    }
  }
  return catalog;
}

export function authorizeLegacyImport(catalog, {
  adapter,
  validationReceipt,
  subjects,
  subjectBytes,
}) {
  const registered = catalog.legacy_import?.adapters ?? [];
  if (registered.length === 0) {
    throw new Error("no legacy import adapter is registered");
  }
  if (registered.some((registration) =>
    !isValidLegacyImportAdapter(catalog, registration))) {
    throw new Error("legacy import adapter must name a catalog contract");
  }
  const registration = registered.find(({ contract }) => contract === adapter);
  if (!registration) {
    throw new Error(`legacy import adapter is not registered: ${adapter}`);
  }
  if (validationReceipt?.contract !== registration.validation_contract ||
      validationReceipt?.adapter_contract !== adapter ||
      typeof validationReceipt?.outcomes !== "object" ||
      validationReceipt.outcomes === null ||
      !/^sha256:[0-9a-f]{64}$/.test(validationReceipt.subject_digest ?? "") ||
      typeof validationReceipt.issued_at !== "string" ||
      Number.isNaN(Date.parse(validationReceipt.issued_at)) ||
      !(subjectBytes instanceof Uint8Array)) {
    throw new Error("legacy import validation receipt is invalid");
  }
  const subjectDigest = `sha256:${createHash("sha256").update(subjectBytes).digest("hex")}`;
  if (validationReceipt.subject_digest !== subjectDigest) {
    throw new Error("legacy import validation receipt does not match the subject bytes");
  }
  for (const validation of catalog.legacy_import.required_validations ?? []) {
    if (validationReceipt.outcomes[validation] !== "passed") {
      throw new Error(`legacy import validation is not passing: ${validation}`);
    }
  }
  if (!Array.isArray(subjects)) {
    throw new Error("legacy import subjects must be explicit");
  }
  if (subjects.length === 0) {
    throw new Error("legacy import subjects must be non-empty");
  }
  const requestedSubjects = subjects;
  const unsupportedSubject = requestedSubjects.find(
    (subject) => !registration.allowed_subjects.includes(subject),
  );
  if (unsupportedSubject) {
    throw new Error(`legacy import subject is not allowed: ${unsupportedSubject}`);
  }
  return {
    adapter,
    validation_contract: registration.validation_contract,
    subject_digest: subjectDigest,
    authorized: true,
    subjects: requestedSubjects,
  };
}

function isValidLegacyImportAdapter(catalog, adapter) {
  return typeof adapter?.contract === "string" &&
    catalog.contracts.includes(adapter.contract) &&
    typeof adapter.validation_contract === "string" &&
    catalog.contracts.includes(adapter.validation_contract) &&
    Array.isArray(adapter.allowed_subjects) && adapter.allowed_subjects.length > 0 &&
    adapter.allowed_subjects.every((subject) =>
      typeof subject === "string" &&
      catalog.legacy_import.allowed_subjects.includes(subject) &&
      !catalog.legacy_import.forbidden_authority.includes(subject));
}
