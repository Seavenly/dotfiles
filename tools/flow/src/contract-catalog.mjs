import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { authorityRootsAreDisjoint } from "./authority-root.mjs";
import {
  FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST,
} from "./drovr-delegated-agent-port.mjs";
import { isExactSequence } from "./validation.mjs";

const REQUIRED_FEATURE_CONTRACT = "flow.drovr-required-features/v1";
const REQUIRED_FEATURE_CONTRACT_FILENAME = "drovr-required-features.v1.json";

const FLOW_RUNTIME_OPERATIONS = [
  "prepare",
  "launch",
  "command",
  "query",
  "watch",
];
const REJECTION_FIELDS = [
  "schema",
  "operation",
  "code",
  "reason",
  "command_type",
  "run_id",
  "bundle_digest",
  "authority_watermark",
  "authority_watermark_domain",
  "legal_actions",
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
const AUTHORITY_PERSISTENCE = {
  contract: "flow.sqlite-authority-store/v1",
  journal_mode: "wal",
  synchronous: "full",
  foreign_keys: true,
  append_only_streams: true,
  transactional_folds: true,
  schema_transition: {
    current_version: 2,
    transition_contract: "flow.authority-schema-transition/v1",
    boundary_contract: "flow.authority-schema-transition-boundary/v1",
    compatibility_projection: "flow.authority-schema-compatibility/v1",
    action_contract: "flow.command/v1",
    release: {
      schema: "flow.runtime-release/v1",
      id: "flow-runtime-authority-schema/v2",
      catalog_version: 8,
    },
  },
  mutation_lock: "sqlite_os_advisory_lock",
  takeover: "operating_system_lock_release_only",
  authority_epoch: {
    monotonic: true,
    boot_bound: true,
    effect_recheck: true,
  },
};

export async function loadContractCatalog({
  catalogPath,
  featureContractPath,
  homeDirectory,
  stateDirectory,
}) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schema !== "flow.contract-catalog/v1") {
    throw new Error(`unsupported contract catalog: ${catalog.schema ?? "missing"}`);
  }
  if (!isExactSequence(catalog.flow_runtime?.operations, FLOW_RUNTIME_OPERATIONS)) {
    throw new Error("contract catalog must expose exactly the five FlowRuntime operations");
  }
  const rejection = catalog.flow_runtime.rejection_contract;
  if (rejection?.contract !== "flow.rejection/v1" ||
      !isExactSequence(rejection.fields, REJECTION_FIELDS) ||
      rejection.watermark_domains?.host !==
        "host_run_index_admission_and_authority_schema" ||
      rejection.watermark_domains?.run !==
        "run_lifecycle_stream_authority_epoch_and_authority_schema" ||
      Object.keys(rejection.watermark_domains ?? {}).length !== 2) {
    throw new Error("contract catalog rejection contract is incomplete");
  }
  if (!Array.isArray(catalog.contracts)) {
    throw new Error("contract catalog contracts must be an explicit array");
  }
  if (!isDeepStrictEqual(catalog.authority_persistence, AUTHORITY_PERSISTENCE)) {
    throw new Error("contract catalog authority persistence is incomplete");
  }
  if (!registeredQueriesArePublished(catalog)) {
    throw new Error("registered query contracts must be published");
  }
  let publishedFeatureContract;
  let publishedFeatureContractBytes;
  try {
    publishedFeatureContractBytes = await readFile(
      featureContractPath ?? resolve(
        dirname(catalogPath),
        REQUIRED_FEATURE_CONTRACT_FILENAME,
      ),
    );
    publishedFeatureContract = JSON.parse(publishedFeatureContractBytes);
  } catch {
    throw new Error(
      "contract catalog Drovr feature baseline is incomplete or weakened",
    );
  }
  if (!delegatedAgentPortIsPublished(
    catalog,
    publishedFeatureContract,
    publishedFeatureContractBytes,
  )) {
    throw new Error(
      "contract catalog Drovr feature baseline is incomplete or weakened",
    );
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

function delegatedAgentPortIsPublished(
  catalog,
  publishedFeatureContract,
  publishedFeatureContractBytes,
) {
  const port = catalog.delegated_agent_port;
  const contracts = catalog.contracts;
  return port?.contract === "flow.delegated-agent-port/v1" &&
    port.authority === "non_authoritative" &&
    port.adapter === "drovr/v1" &&
    port.description_request ===
      "flow.delegated-agent-description-request/v1" &&
    port.description_projection ===
      "flow.delegated-agent-description-projection/v1" &&
    port.lifecycle_projection ===
      "flow.delegated-agent-lifecycle-projection/v1" &&
    isDeepStrictEqual(port.operations, {
      dispatch: "flow.delegated-agent-dispatch-request/v1",
      discover: "flow.delegated-agent-discover-request/v1",
      send: "flow.delegated-agent-send-request/v1",
      observe: "flow.delegated-agent-observe-request/v1",
      wait: "flow.delegated-agent-wait-request/v1",
      cancel: "flow.delegated-agent-cancel-request/v1",
      reconcile: "flow.delegated-agent-reconcile-request/v1",
    }) &&
    port.drovr_description === "drovr.delegated-agent-description/v1" &&
    port.required_features?.contract === REQUIRED_FEATURE_CONTRACT &&
    Object.keys(port.required_features).length === 2 &&
    port.required_features?.content_sha256 ===
      FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST &&
    `sha256:${createHash("sha256")
      .update(publishedFeatureContractBytes)
      .digest("hex")}` === FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST &&
    publishedFeatureContract.schema === REQUIRED_FEATURE_CONTRACT &&
    Array.isArray(publishedFeatureContract.features) &&
    [
      port.contract,
      port.description_request,
      port.description_projection,
      port.lifecycle_projection,
      ...Object.values(port.operations),
      port.drovr_description,
      publishedFeatureContract.schema,
      ...publishedFeatureContract.features.map(({ contract }) => contract),
    ].every((contract) => contracts.includes(contract));
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

function registeredQueriesArePublished(catalog) {
  const registrations = catalog.flow_runtime?.operation_contracts?.query?.registered;
  if (
    typeof registrations !== "object" ||
    registrations === null ||
    Array.isArray(registrations) ||
    Object.keys(registrations).length === 0 ||
    !Array.isArray(catalog.projections)
  ) {
    return false;
  }
  return Object.entries(registrations).every(([name, registration]) =>
    catalog.projections.includes(name) &&
    [registration?.request, registration?.projection, registration?.rejection]
      .every((contract) => catalog.contracts.includes(contract))
  );
}
