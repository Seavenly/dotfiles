import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  describeDelegatedAgent,
} from "../../drovr/src/description.mjs";

import { canonicalize, digest, freezeCanonical } from "./canonical.mjs";

const PORT_CONTRACT = "flow.delegated-agent-port/v1";
const REQUEST_CONTRACT = "flow.delegated-agent-description-request/v1";
const PROJECTION_CONTRACT =
  "flow.delegated-agent-description-projection/v1";
const REQUIRED_FEATURE_CONTRACT_URL = new URL(
  "../../../config/flow/contracts/drovr-required-features.v1.json",
  import.meta.url,
);
const PROJECTION_SCHEMA_URL = new URL(
  "../../../config/flow/schemas/flow.delegated-agent-description-projection.v1.schema.json",
  import.meta.url,
);
export const FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST =
  "sha256:837aca5ff5debd64e355dbc6ea0e19504a53fe85cc411adecbe0e643585b0896";
const REQUIRED_AUTHORITY_DIMENSIONS = freezeCanonical({
  "read-only": {
    approvals: "never",
    filesystem: "read_only",
    network: "disabled",
  },
  "on-approve": {
    approvals: "human",
    filesystem: "read_only_until_approved",
    network: "approval_gated",
  },
  "workspace-write": {
    approvals: "human",
    filesystem: "workspace_write",
    network: "approval_gated",
  },
  auto: {
    approvals: "automatic_review",
    filesystem: "workspace_write",
    network: "native_search_only",
  },
  unrestricted: {
    approvals: "never",
    filesystem: "unrestricted",
    network: "unrestricted",
  },
});

export function createDrovrDelegatedAgentPort({
  describeDrovr = describeDelegatedAgent,
  dependencies = {},
  loadRequiredFeatureContractBytes = () =>
    readFile(REQUIRED_FEATURE_CONTRACT_URL),
  loadProjectionSchemaBytes = () => readFile(PROJECTION_SCHEMA_URL),
  loadDescriptionValidator = descriptionValidator,
} = {}) {
  return Object.freeze({
    contract: PORT_CONTRACT,

    async describe(request) {
      if (!validRequest(request)) {
        return blockedProjection({
          code: "invalid_description_request",
          legalNextActions: [],
        });
      }

      let requiredFeatures;
      let projectionSchemaBytes;
      try {
        const contractBytes = await loadRequiredFeatureContractBytes();
        if (!requiredFeatureContractIsPinned(contractBytes)) throw new Error();
        requiredFeatures = requiredFeaturesFrom(contractBytes);
        projectionSchemaBytes = await loadProjectionSchemaBytes();
      } catch {
        return blockedProjection({
          code: "delegated_agent_port_unavailable",
          legalNextActions: ["repair_delegated_agent_port"],
        });
      }

      let validateDescriptionStructure;
      try {
        validateDescriptionStructure = await loadDescriptionValidator(
          projectionSchemaBytes,
        );
      } catch {
        return blockedProjection({
          code: "delegated_agent_port_unavailable",
          legalNextActions: ["repair_delegated_agent_port"],
        });
      }

      let description;
      try {
        description = await describeDrovr({
          schema: "drovr.delegated-agent-description-request/v1",
          launch: structuredClone(request.launch),
          caller_metadata: structuredClone(request.caller_metadata),
        }, dependencies);
      } catch (error) {
        if (error?.outcome === "unsupported_configuration") {
          return blockedProjection({
            code: "invalid_description_request",
            legalNextActions: [],
          });
        }
        if (error?.outcome === "invalid_configuration") {
          return blockedProjection({
            code: "description_unavailable",
            legalNextActions: repairActions(),
          });
        }
        return blockedProjection({
          code: "description_unavailable",
          legalNextActions: ["retry_delegated_runtime_description"],
        });
      }

      let featureFindings;
      let contradiction;
      try {
        featureFindings = featureConformanceFindings(
          description,
          requiredFeatures,
        );
        contradiction = descriptionContradiction(
          description,
          request,
          validateDescriptionStructure,
        );
      } catch {
        return blockedProjection({
          code: "contradictory_description",
          findings: [{ field: "description", reason: "contradictory" }],
          legalNextActions: repairActions(),
        });
      }
      if (
        contradiction &&
        contradiction.field !== "feature_advertisement"
      ) {
        return blockedProjection({
          code: "contradictory_description",
          findings: [contradiction],
          legalNextActions: repairActions(),
        });
      }
      if (featureFindings.length > 0) {
        const exactUnavailableDescription =
          !contradiction &&
          featureFindings.every(({ reason }) => reason === "unavailable");
        return blockedProjection({
          code: "incompatible_feature_advertisement",
          description: exactUnavailableDescription ? description : null,
          findings: featureFindings,
          legalNextActions: repairActions(),
        });
      }

      if (contradiction) {
        return blockedProjection({
          code: "contradictory_description",
          findings: [contradiction],
          legalNextActions: repairActions(),
        });
      }

      return freezeCanonical({
        schema: PROJECTION_CONTRACT,
        status: "compatible",
        watermark: description.watermark,
        description,
        compatibility: {
          contract: PORT_CONTRACT,
          code: null,
          findings: [],
        },
        legal_next_actions: [
          "bind_exact_launch_description",
          "refresh_delegated_runtime_description",
        ],
      });
    },
  });
}

function featureConformanceFindings(description, requiredFeatures) {
  const advertised = description?.feature_advertisement?.features;
  if (!Array.isArray(advertised)) {
    return requiredFeatures.map(({ id }) => ({
      feature_id: id,
      reason: "missing",
    }));
  }
  const findings = [];
  const validAdvertisements = advertised.filter(isRecord);
  for (const _malformed of advertised.filter((value) => !isRecord(value))) {
    findings.push({ feature_id: null, reason: "contradictory" });
  }
  for (const required of requiredFeatures) {
    const matches = validAdvertisements.filter(({ id }) => id === required.id);
    if (matches.length === 0) {
      findings.push({ feature_id: required.id, reason: "missing" });
      continue;
    }
    if (matches.length > 1 || matches[0].authority !== required.authority) {
      findings.push({ feature_id: required.id, reason: "contradictory" });
      continue;
    }
    if (
      matches[0].availability !== "supported" &&
      matches[0].availability !== "unavailable"
    ) {
      findings.push({ feature_id: required.id, reason: "contradictory" });
      continue;
    }
    const expectedAdvertisement = {
      ...required,
      availability: matches[0].availability,
    };
    if (!sameCanonicalValue(matches[0], expectedAdvertisement)) {
      findings.push({ feature_id: required.id, reason: "weakened" });
      continue;
    }
    if (matches[0].availability !== "supported") {
      findings.push({ feature_id: required.id, reason: "unavailable" });
    }
  }
  for (const advertisedFeature of validAdvertisements) {
    if (!requiredFeatures.some(({ id }) => id === advertisedFeature.id)) {
      findings.push({
        feature_id: advertisedFeature.id ?? null,
        reason: "contradictory",
      });
    }
  }
  return findings;
}

function descriptionContradiction(
  description,
  request,
  validateDescriptionStructure,
) {
  const structureFinding = descriptionStructureContradiction(
    description,
    validateDescriptionStructure,
  );
  if (structureFinding) return structureFinding;
  if (
    description?.schema !== "drovr.delegated-agent-description/v1" ||
    !isDigest(description?.watermark?.content_sha256) ||
    description.watermark.authority !== "drovr.configuration-catalog"
  ) {
    return { field: "watermark", reason: "contradictory" };
  }
  for (const [field, requestedValue] of Object.entries(request.launch)) {
    if (!sameCanonicalValue(description.launch?.[field], requestedValue)) {
      return { field: `launch.${field}`, reason: "contradictory" };
    }
  }
  if (
    description.launch?.capability !==
    description.effective_authority?.capability
  ) {
    return {
      field: "effective_authority.capability",
      reason: "contradictory",
    };
  }
  if (!sameCanonicalValue(
    description.effective_authority.dimensions,
    REQUIRED_AUTHORITY_DIMENSIONS[description.launch.capability],
  )) {
    return {
      field: "effective_authority.dimensions",
      reason: "contradictory",
    };
  }
  if (
    description.credential_reference?.identity !==
    `ambient/${description.launch?.harness}` ||
    description.credential_reference.secret_material_included !== false
  ) {
    return { field: "credential_reference", reason: "contradictory" };
  }
  if (
    !sameCanonicalValue(
      description.caller_metadata,
      request.caller_metadata,
    )
  ) {
    return { field: "caller_metadata", reason: "contradictory" };
  }
  const comparisonKeys = description.comparison_keys;
  for (const [field, value] of [
    ["launch", description.launch],
    ["effective_authority", description.effective_authority],
    ["credential_reference", description.credential_reference],
  ]) {
    if (comparisonKeys?.[field] !== digest(value)) {
      return { field: `comparison_keys.${field}`, reason: "contradictory" };
    }
  }
  if (
    comparisonKeys.configuration_catalog !==
    description.watermark.content_sha256
  ) {
    return {
      field: "comparison_keys.configuration_catalog",
      reason: "contradictory",
    };
  }
  const { description_digest: actualDigest, legal_actions: _actions, ...identity } =
    description;
  if (actualDigest !== digest(identity)) {
    return { field: "description_digest", reason: "contradictory" };
  }
  return null;
}

function descriptionStructureContradiction(
  description,
  validateDescriptionStructure,
) {
  if (validateDescriptionStructure(description)) return null;
  const [error] = validateDescriptionStructure.errors;
  if (error.keyword === "required") {
    return contradiction(error.params.missingProperty);
  }
  const [field] = error.instancePath.split("/").filter(Boolean);
  return contradiction(field ?? "description");
}

function requiredFeatureContractIsPinned(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` ===
    FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST;
}

function requiredFeaturesFrom(bytes) {
  const contract = JSON.parse(bytes.toString("utf8"));
  if (
    contract.schema !== "flow.drovr-required-features/v1" ||
    !Array.isArray(contract.features)
  ) {
    throw new Error("invalid Flow-required Drovr feature contract");
  }
  return freezeCanonical(contract.features.map((required) => ({
    ...required,
    availability: "supported",
  })));
}

async function descriptionValidator(schemaBytes) {
  const projectionSchema = JSON.parse(schemaBytes.toString("utf8"));
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  return new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile({
    $schema: projectionSchema.$schema,
    ...projectionSchema.$defs.description,
    $defs: projectionSchema.$defs,
  });
}

function contradiction(field) {
  return { field, reason: "contradictory" };
}

function blockedProjection({
  code,
  description = null,
  findings = [],
  legalNextActions,
}) {
  return freezeCanonical({
    schema: PROJECTION_CONTRACT,
    status: "blocked",
    watermark: description?.watermark ?? null,
    description,
    compatibility: {
      contract: PORT_CONTRACT,
      code,
      findings,
    },
    legal_next_actions: legalNextActions,
  });
}

function repairActions() {
  return [
    "repair_delegated_runtime_contract",
    "refresh_delegated_runtime_description",
  ];
}

function validRequest(request) {
  const launch = request?.launch;
  if (
    request?.schema !== REQUEST_CONTRACT ||
    !isRecord(launch) ||
    !Object.hasOwn(request, "caller_metadata") ||
    Object.keys(request).some(
      (key) => !["schema", "launch", "caller_metadata"].includes(key),
    ) ||
    Object.keys(launch).some(
      (key) => ![
        "harness",
        "role",
        "model",
        "effort",
        "capability",
      ].includes(key),
    ) ||
    (Object.hasOwn(launch, "harness") &&
      !["claude", "codex"].includes(launch.harness)) ||
    (Object.hasOwn(launch, "role") && !nonEmptyString(launch.role)) ||
    (Object.hasOwn(launch, "model") && !nonEmptyString(launch.model)) ||
    (Object.hasOwn(launch, "effort") &&
      !["low", "medium", "high", "xhigh"].includes(launch.effort)) ||
    (Object.hasOwn(launch, "capability") &&
      ![
        "read-only",
        "on-approve",
        "workspace-write",
        "auto",
        "unrestricted",
      ].includes(launch.capability))
  ) {
    return false;
  }
  try {
    canonicalize(request.launch);
    canonicalize(request.caller_metadata);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameCanonicalValue(left, right) {
  try {
    return JSON.stringify(canonicalize(left)) ===
      JSON.stringify(canonicalize(right));
  } catch {
    return false;
  }
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
