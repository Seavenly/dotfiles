import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import {
  loadConfiguration,
  resolveLaunchSpecification,
} from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "./limits.mjs";

export const DROVR_ADVERTISED_FEATURES = deepFreeze([
  feature("exact_launch_description", "supported", [
    "resolves_complete_launch_binding",
    "does_not_create_or_mutate_delegated_resources",
    "binds_configuration_watermark",
  ], "configuration_catalog"),
  feature("caller_idempotent_dispatch", "unavailable", [
    "same_caller_key_and_payload_adopts_one_logical_turn",
    "caller_key_payload_conflict_fails_closed",
  ]),
  feature("caller_idempotent_discovery", "unavailable", [
    "discovers_exact_caller_owned_resource_before_dispatch",
    "unproven_absence_does_not_authorize_replacement",
  ]),
  feature("caller_keyed_ordered_input", "unavailable", [
    "each_input_has_stable_caller_identity",
    "settlement_requires_all_inputs_in_order",
  ]),
  feature("bounded_observation", "supported", [
    "observation_is_read_only",
    "observation_returns_after_a_declared_bound",
  ]),
  feature("bounded_wait", "supported", [
    "timeout_is_non_destructive",
    "timeout_preserves_logical_turn_identity",
  ]),
  feature("transcript_correlation", "supported", [
    "result_follows_every_recorded_input",
    "unrecorded_input_is_a_correlation_boundary",
  ]),
  feature("cancellation", "supported", [
    "cancellation_requires_observed_settlement",
    "uncertain_cancellation_never_claims_success",
  ]),
  feature("reconciliation", "supported", [
    "recovery_uses_persisted_launch_binding",
    "missing_receipt_does_not_prove_absence",
  ]),
  feature("terminal_proof_classification", "unavailable", [
    "terminal_result_names_its_proof_class",
    "uncertain_is_distinct_from_completed",
  ]),
  feature("late_result_correlation", "supported", [
    "late_output_retains_original_turn_identity",
    "late_output_does_not_replace_accepted_result",
  ]),
  feature("launch_binding_settlement_proof", "unavailable", [
    "settlement_binds_exact_launch_comparison_key",
    "catalog_drift_cannot_refresh_active_binding",
  ]),
  feature("opaque_caller_ownership_metadata", "unavailable", [
    "metadata_round_trips_without_interpretation",
    "metadata_is_bound_by_description_identity",
  ]),
  feature("feature_advertisement", "supported", [
    "advertisement_is_complete_and_versioned",
    "advertisement_is_bound_by_configuration_watermark",
  ], "configuration_catalog"),
]);

export const DROVR_ADVERTISED_FEATURE_IDS = deepFreeze(
  DROVR_ADVERTISED_FEATURES.map(({ id }) => id),
);

const SCHEMAS = deepFreeze({
  request: "drovr.delegated-agent-description-request/v1",
  description: "drovr.delegated-agent-description/v1",
  launch: "drovr.launch-description/v1",
  effective_authority: "drovr.effective-authority/v1",
  capacity: "drovr.capacity/v1",
  credential_reference: "drovr.credential-reference/v1",
  feature_advertisement: "drovr.feature-advertisement/v1",
  caller_metadata: "opaque-json/v1",
});

const CAPACITY = deepFreeze({
  schema: SCHEMAS.capacity,
  admission_owner: "caller",
  observation_timeout_ms: HERDR_OBSERVATION_TIMEOUT_MS,
  concurrent_logical_turns_per_agent: 1,
  managed_agents_per_task: {
    hard_limit: null,
    normal_limit: 4,
    five_or_more_supported: true,
  },
});

const AUTHORITY_DIMENSIONS = deepFreeze({
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

export async function describeDelegatedAgent(request, dependencies = {}) {
  validateRequest(request);
  const configuration = await loadConfiguration({
    env: dependencies.env ?? process.env,
  });
  const resolved = resolveLaunchSpecification(configuration, request.launch);
  const launch = deepFreeze({
    schema: SCHEMAS.launch,
    ...resolved,
    catalog_fingerprints: logicalFingerprints(
      configuration.directory,
      resolved.catalog_fingerprints,
    ),
  });
  const effectiveAuthority = deepFreeze({
    schema: SCHEMAS.effective_authority,
    capability: launch.capability,
    dimensions: AUTHORITY_DIMENSIONS[launch.capability],
  });
  const credentialReference = deepFreeze({
    schema: SCHEMAS.credential_reference,
    identity: `ambient/${launch.harness}`,
    secret_material_included: false,
  });
  const featureAdvertisement = deepFreeze({
    schema: SCHEMAS.feature_advertisement,
    features: DROVR_ADVERTISED_FEATURES,
  });
  const catalogAuthority = {
    schemas: SCHEMAS,
    capacity: CAPACITY,
    authority_dimensions: AUTHORITY_DIMENSIONS,
    credential_references: ["ambient/claude", "ambient/codex"],
    feature_advertisement: featureAdvertisement,
    fingerprints: logicalFingerprints(
      configuration.directory,
      configuration.fingerprints,
    ),
  };
  const watermark = deepFreeze({
    schema: "drovr.authority-watermark/v1",
    authority: "drovr.configuration-catalog",
    content_sha256: digest(catalogAuthority),
  });
  const callerMetadata = canonicalize(request.caller_metadata);
  const comparisonKeys = deepFreeze({
    launch: digest(launch),
    effective_authority: digest(effectiveAuthority),
    credential_reference: digest(credentialReference),
    configuration_catalog: watermark.content_sha256,
  });
  const identity = {
    schema: SCHEMAS.description,
    schemas: SCHEMAS,
    watermark,
    launch,
    effective_authority: effectiveAuthority,
    capacity: CAPACITY,
    credential_reference: credentialReference,
    feature_advertisement: featureAdvertisement,
    caller_metadata: callerMetadata,
    comparison_keys: comparisonKeys,
  };

  return deepFreeze({
    ...identity,
    description_digest: digest(identity),
    legal_actions: ["dispatch_exact_launch", "refresh_description"],
  });
}

function feature(
  id,
  availability,
  guarantees,
  authority = "delegated_runtime",
) {
  return {
    id,
    contract: `drovr.feature/${id.replaceAll("_", "-")}/v1`,
    authority,
    availability,
    guarantees,
  };
}

function validateRequest(request) {
  if (
    request?.schema !== SCHEMAS.request ||
    !isRecord(request.launch) ||
    !Object.hasOwn(request, "caller_metadata") ||
    Object.keys(request).some(
      (key) => !["schema", "launch", "caller_metadata"].includes(key),
    )
  ) {
    throw new DrovrError("invalid delegated-agent description request", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  canonicalize(request.launch);
  canonicalize(request.caller_metadata);
}

function logicalFingerprints(directory, fingerprints) {
  return Object.entries(fingerprints)
    .map(([path, sha256]) => {
      const subject = relative(directory, path).split(sep).join("/");
      if (!subject || subject === ".." || subject.startsWith("../")) {
        throw new DrovrError("configuration fingerprint escaped its catalog", {
          code: 5,
          outcome: "corrupt_configuration",
        });
      }
      return { subject, sha256: `sha256:${sha256}` };
    })
    .sort((left, right) => compare(left.subject, right.subject));
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function canonicalize(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new DrovrError("description values must be lossless JSON", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (
      Reflect.ownKeys(value).length !== value.length + 1 ||
      value.some((_, index) => !Object.hasOwn(value, index))
    ) {
      throw new DrovrError("description values must be lossless JSON", {
        code: 2,
        outcome: "invalid_arguments",
      });
    }
    result = value.map((item) => canonicalize(item, ancestors));
  } else {
    if (
      !isRecord(value) ||
      Reflect.ownKeys(value).length !== Object.keys(value).length
    ) {
      throw new DrovrError("description values must be lossless JSON", {
        code: 2,
        outcome: "invalid_arguments",
      });
    }
    result = Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, canonicalize(value[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
