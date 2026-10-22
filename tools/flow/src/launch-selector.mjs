import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveAuthorityRoot } from "./authority-root.mjs";

const RELEASE_MANIFEST_SCHEMA = "flow.release-manifest/v1";
const DARK_OPT_IN_SCHEMA = "flow.dark-opt-in/v1";
const SUPPORTED_IMPLEMENTATION = "flow-runtime/v1";

/**
 * A launch request can be rejected by policy without turning a deliberate
 * disabled scope into an untyped transport failure. The Error shape keeps
 * existing callers that use promise rejection while exposing a stable public
 * result for callers that need to classify the outcome.
 */
export class LaunchSelectionError extends Error {
  constructor({ code, outcome, reason, route = null, legalActions = [] }) {
    super(reason);
    this.name = "LaunchSelectionError";
    this.schema = "flow.launch-rejection/v1";
    this.operation = "launch";
    this.code = code;
    this.outcome = outcome;
    this.reason = reason;
    this.route = route;
    this.legal_actions = legalActions;
    this.rejection = Object.freeze({
      schema: this.schema,
      operation: this.operation,
      code: this.code,
      outcome: this.outcome,
      reason: this.reason,
      route: this.route,
      legal_actions: this.legal_actions,
    });
  }
}

export async function resolveLaunchPolicy({
  policyPath,
  releaseManifestPath,
  requestedImplementation,
  darkOptIn,
  route,
  homeDirectory,
  stateDirectory,
}) {
  const policyBytes = await readFile(policyPath);
  const policy = parsePolicy(policyBytes);

  const implementation = requestedImplementation ?? policy.default_implementation;
  const selected = policy.implementations?.[implementation];
  if (!selected) {
    throw new LaunchSelectionError({
      code: "unknown_implementation",
      outcome: "unsupported",
      reason: `unknown flow implementation: ${implementation}`,
    });
  }

  const policyWatermark = `sha256:${createHash("sha256")
    .update(policyBytes)
    .digest("hex")}`;
  const baseSelection = {
    schema: "flow.launch-selection/v1",
    policy_generation: policy.generation,
    policy_watermark: policyWatermark,
    implementation,
    authority_root_spec: selected.authority_root,
    authority_root: resolveAuthorityRoot(selected.authority_root, {
      homeDirectory,
      stateDirectory,
    }),
  };

  if (implementation !== SUPPORTED_IMPLEMENTATION || !darkOptIn) {
    if (!selected.launch_enabled) {
      const kind = implementation === SUPPORTED_IMPLEMENTATION
        ? "replacement"
        : implementation;
      throw new LaunchSelectionError({
        code: implementation === SUPPORTED_IMPLEMENTATION
          ? "replacement_launch_disabled"
          : "implementation_launch_disabled",
        outcome: "disabled",
        reason: `${kind} launch is disabled`,
      });
    }
    return baseSelection;
  }

  const manifestPath = releaseManifestPath ??
    join(dirname(policyPath), "release-manifest.v1.json");
  const manifestBytes = await readFile(manifestPath);
  return resolveQualifiedSelection({
    policy,
    policyBytes,
    selected,
    implementation,
    manifest: JSON.parse(manifestBytes),
    manifestBytes,
    manifestName: basename(manifestPath),
    darkOptIn,
    route,
    homeDirectory,
    stateDirectory,
  });
}

/**
 * Synchronous public replacement gate used by the config/flow runtime.  The
 * runtime's public prepare/launch methods are deliberately synchronous at the
 * boundary, so this helper performs the same manifest, opt-in, and route
 * validation as resolveLaunchPolicy without creating a second policy format.
 */
export function resolvePublicLaunchPolicy({
  policyPath,
  releaseManifestPath,
  darkOptIn,
  route,
  homeDirectory,
  stateDirectory,
}) {
  const policyBytes = readFileSync(policyPath);
  const policy = parsePolicy(policyBytes);
  const implementation = SUPPORTED_IMPLEMENTATION;
  const selected = policy.implementations?.[implementation];
  if (!selected || selected.launch_enabled === true) {
    throw new LaunchSelectionError({
      code: "invalid_public_policy",
      outcome: "unsupported",
      reason: "public replacement policy is not a dark opt-in release",
    });
  }
  if (!darkOptIn) {
    throw new LaunchSelectionError({
      code: "dark_opt_in_required",
      outcome: "disabled",
      reason: "public replacement routes require explicit dark opt-in",
      route: null,
      legalActions: [],
    });
  }
  const manifestPath = releaseManifestPath ??
    join(dirname(policyPath), "release-manifest.v1.json");
  const manifestBytes = readFileSync(manifestPath);
  return resolveQualifiedSelection({
    policy,
    policyBytes,
    selected,
    implementation,
    manifest: JSON.parse(manifestBytes),
    manifestBytes,
    manifestName: basename(manifestPath),
    darkOptIn,
    route,
    homeDirectory,
    stateDirectory,
  });
}

/**
 * Classify a public prepare/launch value into the finite capability routes.
 * Unknown values intentionally remain unknown so the release gate rejects
 * them as unsupported instead of allowing an unlisted operation through.
 */
export function classifyPublicRoute(value) {
  const prepared = value?.prepared;
  if (isPlainRecord(prepared)) return classifyPreparedRoute(prepared);
  if (value?.schema === "flow.feature-preparation-request/v1") {
    return { flow: "feature", mode: value.mode ?? "unknown" };
  }
  if (value?.schema === "flow.predefined-flow-selection/v1") {
    return classifyDefinitionRoute(value.definition, value.inputs);
  }
  return { flow: "unknown", mode: "unknown" };
}

function parsePolicy(policyBytes) {
  const policy = JSON.parse(policyBytes);
  if (policy.schema !== "flow.launch-policy/v1") {
    throw new Error(`unsupported launch policy: ${policy.schema ?? "missing"}`);
  }
  return policy;
}

function resolveQualifiedSelection({
  policy,
  policyBytes,
  selected,
  implementation,
  manifest,
  manifestBytes,
  manifestName,
  darkOptIn,
  route,
  homeDirectory,
  stateDirectory,
}) {
  const policyWatermark = `sha256:${createHash("sha256")
    .update(policyBytes)
    .digest("hex")}`;
  const baseSelection = {
    schema: "flow.launch-selection/v1",
    policy_generation: policy.generation,
    policy_watermark: policyWatermark,
    implementation,
    authority_root_spec: selected.authority_root,
    authority_root: resolveAuthorityRoot(selected.authority_root, {
      homeDirectory,
      stateDirectory,
    }),
  };
  const manifestDigest = `sha256:${createHash("sha256")
    .update(manifestBytes)
    .digest("hex")}`;
  if (selected.dark_opt_in?.enabled !== true ||
      selected.dark_opt_in.manifest !== manifestName ||
      selected.dark_opt_in.scope !== "dark_sacrificial" ||
      selected.dark_opt_in.manifest_sha256 !== manifestDigest.slice(7)) {
    throw new LaunchSelectionError({
      code: "dark_opt_in_unqualified",
      outcome: "disabled",
      reason: "dark opt-in is not bound to the qualified capability manifest",
    });
  }
  validateReleaseManifest(manifest);
  validateDarkOptIn({ darkOptIn, manifest });
  const selectedRoute = validateRoute(route);
  const supportedRoute = manifest.supported_routes.find((candidate) =>
    sameRoute(candidate, selectedRoute));
  if (!supportedRoute) {
    const disabledRoute = manifest.disabled_routes.find((candidate) =>
      sameRoute(candidate, selectedRoute));
    const outcome = disabledRoute?.outcome ?? "unsupported";
    throw new LaunchSelectionError({
      code: outcome === "disabled" ? "route_disabled" : "route_unsupported",
      outcome,
      reason: outcome === "disabled"
        ? `dark sacrificial route is disabled: ${routeLabel(selectedRoute)}`
        : `dark sacrificial route is unsupported: ${routeLabel(selectedRoute)}`,
      route: selectedRoute,
      legalActions: supportedRoutes(manifest),
    });
  }
  return {
    ...baseSelection,
    release_id: manifest.release_id,
    scope: manifest.scope,
    not_authorized_before_issue: manifest.not_authorized_before_issue,
    route: selectedRoute,
    normal_use_authorized: manifest.normal_use_authorized,
    remote_mutations_authorized: manifest.remote_mutations_authorized,
    release_manifest: {
      schema: manifest.schema,
      release_id: manifest.release_id,
      digest: manifestDigest,
    },
    capability_manifest: projectCapabilityManifest(manifest, manifestDigest),
  };
}

function classifyPreparedRoute(prepared) {
  if (prepared.kind !== "predefined") {
    return { flow: "unknown", mode: "unknown" };
  }
  return classifyDefinitionRoute(prepared.definition?.id, prepared.selection?.inputs);
}

function classifyDefinitionRoute(definition, inputs = {}) {
  if (definition === "feature/v1") {
    return { flow: "feature", mode: inputs?.mode ?? "unknown" };
  }
  if (definition === "review/v1") {
    const targetSchema = inputs?.target?.schema;
    return {
      flow: "review",
      mode: targetSchema === "flow.review-local-candidate/v1" ? "local"
        : targetSchema === "flow.review-github-pull-request/v1" ? "github"
          : "unknown",
    };
  }
  if (definition === "spike/v1") {
    return { flow: "spike", mode: inputs?.depth ?? inputs?.mode ?? "quick" };
  }
  if (definition === "epic/v1") return { flow: "epic", mode: "default" };
  return { flow: "unknown", mode: "unknown" };
}

export function validateReleaseManifest(manifest) {
  if (!manifest || manifest.schema !== RELEASE_MANIFEST_SCHEMA ||
      !Number.isInteger(manifest.version) || manifest.version !== 1 ||
      typeof manifest.release_id !== "string" || !manifest.release_id ||
      manifest.implementation !== SUPPORTED_IMPLEMENTATION ||
      manifest.scope !== "dark_sacrificial" ||
      manifest.not_authorized_before_issue !== 50 ||
      manifest.normal_use_authorized !== false ||
      manifest.remote_mutations_authorized !== false ||
      !Array.isArray(manifest.supported_routes) ||
      !Array.isArray(manifest.disabled_routes)) {
    throw new LaunchSelectionError({
      code: "invalid_release_manifest",
      outcome: "unsupported",
      reason: "release capability manifest is invalid",
    });
  }
  if (manifest.scope_expansion !== "new_manifest_and_evidence_required" ||
      !Array.isArray(manifest.dark_opt_in?.routes) ||
      manifest.dark_opt_in.schema !== DARK_OPT_IN_SCHEMA ||
      manifest.dark_opt_in.release_id !== manifest.release_id ||
      manifest.dark_opt_in.purpose !== "sacrificial_qualification" ||
      manifest.dark_opt_in.routes.some((route) =>
        !isPlainRecord(route) || Object.keys(route).length !== 2 ||
        typeof route.flow !== "string" || typeof route.mode !== "string") ||
      !sameRouteSet(manifest.dark_opt_in.routes, manifest.supported_routes)) {
    throw new LaunchSelectionError({
      code: "invalid_release_manifest",
      outcome: "unsupported",
      reason: "release capability manifest dark opt-in routes are invalid",
    });
  }
  const supported = manifest.supported_routes.map(validateManifestRoute);
  const disabled = manifest.disabled_routes.map((route) => {
    const normalized = validateManifestRoute(route);
    if (!["disabled", "unsupported"].includes(route.outcome)) {
      throw new LaunchSelectionError({
        code: "invalid_release_manifest",
        outcome: "unsupported",
        reason: "release capability manifest contains an invalid route outcome",
      });
    }
    return normalized;
  });
  if (new Set(supported.map(routeKey)).size !== supported.length ||
      new Set(disabled.map(routeKey)).size !== disabled.length ||
      supported.some((route) => disabled.some((candidate) =>
        sameRoute(candidate, route)))) {
    throw new LaunchSelectionError({
      code: "invalid_release_manifest",
      outcome: "unsupported",
      reason: "release capability manifest routes overlap or repeat",
    });
  }
  return manifest;
}

export function projectCapabilityManifest(manifest, manifestDigest) {
  validateReleaseManifest(manifest);
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestDigest ?? "")) {
    throw new TypeError("capability manifest projection requires a digest");
  }
  return {
    schema: "flow.capability-manifest/v1",
    version: manifest.version,
    release_id: manifest.release_id,
    implementation: manifest.implementation,
    scope: manifest.scope,
    not_authorized_before_issue: manifest.not_authorized_before_issue,
    normal_use_authorized: manifest.normal_use_authorized,
    remote_mutations_authorized: manifest.remote_mutations_authorized,
    supported_routes: manifest.supported_routes.map(({ flow, mode }) => ({
      flow,
      mode,
    })),
    disabled_routes: manifest.disabled_routes.map(({ flow, mode, outcome }) => ({
      flow,
      mode,
      outcome,
    })),
    digest: manifestDigest,
  };
}

function validateDarkOptIn({ darkOptIn, manifest }) {
  if (!isPlainRecord(darkOptIn) ||
      darkOptIn.schema !== DARK_OPT_IN_SCHEMA ||
      darkOptIn.release_id !== manifest.release_id ||
      darkOptIn.purpose !== "sacrificial_qualification" ||
      (darkOptIn.routes !== undefined &&
        (!Array.isArray(darkOptIn.routes) ||
          !sameRouteSet(darkOptIn.routes, manifest.supported_routes)))) {
    throw new LaunchSelectionError({
      code: "invalid_dark_opt_in",
      outcome: "unsupported",
      reason: "dark opt-in does not match the qualified release manifest",
    });
  }
}

function validateRoute(route) {
  if (!isPlainRecord(route) || typeof route.flow !== "string" ||
      typeof route.mode !== "string" ||
      Object.keys(route).some((key) => !["flow", "mode"].includes(key))) {
    throw new LaunchSelectionError({
      code: "invalid_route",
      outcome: "unsupported",
      reason: "dark sacrificial launch requires one exact flow and mode route",
      route: null,
    });
  }
  return { flow: route.flow, mode: route.mode };
}

function validateManifestRoute(route) {
  if (!isPlainRecord(route) || typeof route.flow !== "string" ||
      typeof route.mode !== "string" || !route.flow || !route.mode) {
    throw new LaunchSelectionError({
      code: "invalid_release_manifest",
      outcome: "unsupported",
      reason: "release capability manifest contains an invalid route",
    });
  }
  return { flow: route.flow, mode: route.mode };
}

function supportedRoutes(manifest) {
  return manifest.supported_routes.map(({ flow, mode }) => ({ flow, mode }));
}

function sameRouteSet(first, second) {
  const firstKeys = first.map(routeKey).sort();
  const secondKeys = second.map(routeKey).sort();
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key, index) => key === secondKeys[index]);
}

function sameRoute(first, second) {
  return first?.flow === second?.flow && first?.mode === second?.mode;
}

function routeKey(route) {
  return `${route?.flow ?? ""}:${route?.mode ?? ""}`;
}

function routeLabel(route) {
  return `${route.flow}/${route.mode}`;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}
