import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalize, freezeCanonical } from "./canonical.mjs";

export const FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST =
  "sha256:837aca5ff5debd64e355dbc6ea0e19504a53fe85cc411adecbe0e643585b0896";
export const FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_URL = new URL(
  "../../../config/flow/contracts/drovr-required-features.v1.json",
  import.meta.url,
);

export class RequiredDrovrFeatureContractError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = "RequiredDrovrFeatureContractError";
    this.code = code;
  }
}

export function loadRequiredDrovrFeatures({
  loadBytes = () => readFileSync(FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_URL),
} = {}) {
  let bytes;
  try {
    bytes = loadBytes();
  } catch (cause) {
    throw new RequiredDrovrFeatureContractError(
      "Flow-required Drovr feature contract is unavailable",
      { code: "required_feature_contract_unavailable", cause },
    );
  }
  if (!requiredFeatureContractIsPinned(bytes)) {
    throw new RequiredDrovrFeatureContractError(
      "Flow-required Drovr feature contract is not pinned",
      { code: "required_feature_contract_integrity_failed" },
    );
  }
  try {
    return requiredFeaturesFrom(bytes);
  } catch (cause) {
    throw new RequiredDrovrFeatureContractError(
      "invalid Flow-required Drovr feature contract",
      { code: "required_feature_contract_invalid", cause },
    );
  }
}

export function requiredFeatureContractIsPinned(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` ===
    FLOW_REQUIRED_DROVR_FEATURE_CONTRACT_DIGEST;
}

export function requiredFeaturesFrom(bytes) {
  const contract = JSON.parse(bytes.toString("utf8"));
  if (contract.schema !== "flow.drovr-required-features/v1" ||
      !Array.isArray(contract.features)) {
    throw new Error("invalid Flow-required Drovr feature contract");
  }
  return freezeCanonical(contract.features.map((required) => ({
    ...required,
    availability: "supported",
  })));
}

export function featureConformanceFindings(description, requiredFeatures) {
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
    if (!sameCanonicalValue(matches[0], {
      ...required,
      availability: matches[0].availability,
    })) {
      findings.push({ feature_id: required.id, reason: "weakened" });
      continue;
    }
    if (matches[0].availability !== "supported") {
      findings.push({
        feature_id: required.id,
        reason: matches[0].availability === "unavailable"
          ? "unavailable"
          : "contradictory",
      });
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
