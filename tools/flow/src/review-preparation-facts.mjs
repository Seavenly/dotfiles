import { isDirectDescription, directDescriptionIssue } from "./execution-contract.mjs";
import {
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";
import {
  authorityFactFromIssue,
  authorityGeneration,
  authorityWatermark,
  createAuthorityFact,
  normalizeAuthorityBindings,
} from "./authority-bindings.mjs";
import { createRejection } from "./rejection.mjs";
import { validateTimeFacts as validateCanonicalTimeFacts } from "./reboot-facts.mjs";

export const REVIEW_PREPARATION_FACTS_SCHEMA =
  "flow.review-preparation-facts/v1";

const AUTHORITY_FACT_SCHEMA = "flow.authority-fact/v1";
const REGISTERED_AUTHORITY_SCHEMA = "flow.registered-authority/v1";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CATALOG_PATTERN = /^flow\.contract-catalog\/v1@[1-9][0-9]*$/;
const OPERATION_CONTRACT = "flow.operation/review-record/v1";
const REQUIRED_VALIDATORS = Object.freeze([
  "flow.validator/operation-receipt/v1",
  "flow.validator/review-result/v1",
]);
const TERMINAL_WORKSPACE_DISPOSITIONS = new Set([
  "cleaned",
  "released",
  "disposed",
]);
const AUTHORITY_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: "contract:facts",
    contract: "flow.contract-authority/v1",
    fact: "contract_facts",
  }),
  Object.freeze({
    id: "generation:facts",
    contract: "flow.subject-generation/v1",
    fact: "subject_generations",
  }),
  Object.freeze({
    id: "resource:facts",
    contract: "flow.resource-authority/v1",
    fact: "resource_claims",
  }),
  Object.freeze({
    id: "route:facts",
    contract: "flow.route-authority/v1",
    fact: "route_snapshot",
  }),
]);
const FACT_FIELDS = Object.freeze([
  "schema",
  "candidate",
  "source_run",
  "workspace",
  "route",
  "catalog",
  "operation",
  "validator",
  "time_facts",
  "authority_facts",
  "owner_authorities",
  "authority_watermarks",
  "facts_digest",
]);
const CANDIDATE_FIELDS = Object.freeze([
  "candidate_id",
  "candidate_fingerprint",
  "lifecycle_generation",
  "authority_watermark",
]);
const SOURCE_RUN_FIELDS = Object.freeze([
  "run_id",
  "phase",
  "candidate_id",
  "candidate_fingerprint",
  "authority_watermark",
]);
const WORKSPACE_FIELDS = Object.freeze([
  "subject_id",
  "generation",
  "mutation_epoch",
  "fingerprint",
  "authority_watermark",
]);
const ROUTE_FIELDS = Object.freeze([
  "route_id",
  "configuration_watermark",
  "comparison_key",
  "bindings",
]);
const ROUTE_BINDING_FIELDS = Object.freeze([
  "card_id",
  "route",
  "description",
]);
const ROUTE_FIELDS_FOR_PLAN = Object.freeze([
  "agent_id",
  "configuration_watermark",
  "description_digest",
  "launch_comparison_key",
]);
const CATALOG_FIELDS = Object.freeze(["id", "fingerprint"]);
const CONTRACT_FIELDS = Object.freeze(["contracts"]);
const WATERMARK_FIELDS = Object.freeze([
  "candidate",
  "source_run",
  "workspace",
  "route",
  "resource",
  "contract",
  "generation",
  "catalog",
  "operation",
  "validator",
  "time",
]);
const OWNER_AUTHORITY_FIELDS = Object.freeze(["run", "review", "workspace"]);
const OWNER_FACT_FIELDS = Object.freeze([
  "schema",
  "authority_id",
  "authority_contract",
  "provider_identity",
  "watermark",
  "watermark_domain",
  "subject_id",
  "disposition",
  "generation",
  "facts",
  "legal_actions",
]);
const OWNER_FACT_DATA_FIELDS = Object.freeze({
  run: Object.freeze([
    "run_id",
    "phase",
    "candidate_id",
    "candidate_fingerprint",
    "sequence",
    "current_revision",
    "bundle_digest",
    "projection_digest",
  ]),
  review: Object.freeze([
    "candidate_fingerprint",
    "workspace_subject_id",
    "workspace_generation",
    "workspace_fingerprint",
    "projection_digest",
  ]),
  workspace: Object.freeze([
    "fingerprint",
    "git_commit_sha",
    "git_tree_sha",
    "git_ref",
    "git_clean",
    "mutation_epoch",
    "taint_status",
    "claims_digest",
    "projection_digest",
  ]),
});

/**
 * Build the public facts needed to prepare review/local from authority-owned
 * projections. This module deliberately accepts observations and projections
 * as values; it never reads providers, operation intents, the filesystem, or
 * the clock. Callers must obtain each value from its owning authority before
 * invoking this pure constructor.
 */
export function deriveReviewPreparationFacts(input = {}) {
  const issue = deriveIssue(input);
  if (issue !== null) {
    return freezeCanonical({
      accepted: false,
      rejection: rejectionFromIssue(issue),
    });
  }

  const candidateProjection = input.candidateProjection;
  const sourceRunProjection = input.sourceRunProjection;
  const workspaceProjection = input.workspaceProjection;
  const bindings = normalizedBindings(input.authorityBindings);
  const authorityFacts = bindings.map(authorityFactFromBinding);
  const ownerAuthorities = freezeCanonical(input.ownerAuthorities);
  const candidate = candidateFacts(candidateProjection);
  const sourceRun = sourceRunFacts(sourceRunProjection, candidate);
  const workspace = workspaceFacts(workspaceProjection);
  const operationContracts = sortedUniqueStrings(input.operationContracts);
  const validatorContracts = sortedUniqueStrings(input.validatorContracts);
  const timeFacts = sortByDigest(input.timeFacts);
  const route = freezeCanonical({
    route_id: input.routeSnapshot.route_id,
    configuration_watermark: input.routeSnapshot.configuration_watermark,
    comparison_key: input.routeSnapshot.comparison_key,
    bindings: sortRouteBindings(input.routeSnapshot.bindings),
  });
  const catalog = freezeCanonical({
    id: input.catalog.id,
    fingerprint: input.catalog.fingerprint,
  });
  const authorityWatermarks = freezeCanonical({
    candidate: candidate.authority_watermark,
    source_run: sourceRun.authority_watermark,
    workspace: workspace.authority_watermark,
    route: authorityWatermarkFor(bindings, "route:facts"),
    resource: authorityWatermarkFor(bindings, "resource:facts"),
    contract: authorityWatermarkFor(bindings, "contract:facts"),
    generation: authorityWatermarkFor(bindings, "generation:facts"),
    catalog: catalog.fingerprint,
    operation: digest(operationContracts),
    validator: digest(validatorContracts),
    time: digest(timeFacts),
  });
  const identity = {
    schema: REVIEW_PREPARATION_FACTS_SCHEMA,
    candidate,
    source_run: sourceRun,
    workspace,
    route,
    catalog,
    operation: { contracts: operationContracts },
    validator: { contracts: validatorContracts },
    time_facts: timeFacts,
    authority_facts: authorityFacts,
    owner_authorities: ownerAuthorities,
    authority_watermarks: authorityWatermarks,
  };
  const facts = freezeCanonical({
    ...identity,
    facts_digest: digest(identity),
  });
  const validation = validateReviewPreparationFacts(facts);
  if (!validation.valid) {
    return freezeCanonical({
      accepted: false,
      rejection: rejectionFromIssue(validation.issues[0]),
    });
  }
  return freezeCanonical({ accepted: true, facts });
}

/**
 * Validate a previously materialized envelope without inspecting provider
 * state. The optional expected values let a later owner compare the envelope
 * with fresh authority projections without trusting the envelope itself.
 */
export function validateReviewPreparationFacts(facts, expected = {}) {
  const issues = [];
  if (!isExactRecord(facts, FACT_FIELDS) ||
      facts.schema !== REVIEW_PREPARATION_FACTS_SCHEMA) {
    issues.push(issue("facts_changed", "facts envelope shape is invalid"));
    return freezeCanonical({ valid: false, issues });
  }

  validateCandidate(facts.candidate, issues);
  validateSourceRun(facts.source_run, facts.candidate, issues);
  validateWorkspace(facts.workspace, issues);
  validateRoute(facts.route, issues);
  validateCatalog(facts.catalog, issues);
  validateContracts(facts.operation, [OPERATION_CONTRACT], "operation", issues);
  validateContracts(facts.validator, REQUIRED_VALIDATORS, "validator", issues);
  validateTimeFacts(facts.time_facts, issues);
  validateAuthorityFacts(facts.authority_facts, issues);
  validateOwnerAuthorities(facts.owner_authorities, issues, facts);
  validateWatermarks(facts.authority_watermarks, issues);

  const { facts_digest: factsDigest, ...identity } = facts;
  if (!isDigest(factsDigest) || factsDigest !== digest(identity)) {
    issues.push(issue("facts_changed", "facts envelope digest is invalid"));
  }
  compareExpected(facts, expected, issues);
  return freezeCanonical({ valid: issues.length === 0, issues });
}

export function reviewPreparationFactsDigest(facts) {
  if (!isPlainRecord(facts)) return null;
  const { facts_digest: _factsDigest, ...identity } = facts;
  try {
    return digest(identity);
  } catch {
    return null;
  }
}

/**
 * Digest an owner projection for review provenance. RunAuthority projections
 * include `execution_time`, a fresh observation that advances without a run
 * stream mutation; exclude only that volatile derived view while binding all
 * stream-owned projection fields.
 */
export function reviewOwnerProjectionDigest(owner, projection) {
  if (owner === "run" && isPlainRecord(projection) &&
      Object.hasOwn(projection, "execution_time")) {
    const { execution_time: _executionTime, ...streamProjection } = projection;
    return digest(streamProjection);
  }
  return digest(projection);
}

/**
 * Translate the closed review facts envelope into the legacy explicit-facts
 * shape consumed by the predefined plan compiler. The envelope remains the
 * authority-derived source of every identity-bearing fact; only bounded
 * review limits are policy input at this seam.
 */
export function reviewExplicitFactsFromPreparationFacts(
  facts,
  {
    limits = {},
    routeBindings = undefined,
    capabilityEnvelopes = [],
    resourceClaims = undefined,
    blockObservations = [],
    elapsedSeconds = 0,
  } = {},
) {
  const validation = validateReviewPreparationFacts(facts);
  if (!validation.valid) {
    throw new TypeError("review preparation facts are not a valid envelope");
  }
  const workspace = facts.workspace;
  const authorityResources = [{
    kind: "workspace",
    id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
  }];
  if (resourceClaims !== undefined &&
      digest(resourceClaims) !== digest(authorityResources)) {
    throw new TypeError("review preparation resource claims are not authority-bound");
  }
  if (!Array.isArray(capabilityEnvelopes) || capabilityEnvelopes.length !== 0 ||
      !Array.isArray(blockObservations) || blockObservations.length !== 0 ||
      elapsedSeconds !== 0) {
    throw new TypeError("review preparation caller facts are not authority-bound");
  }
  const resources = authorityResources;
  const route = facts.route;
  const routes = route.bindings;
  if (routes.length === 0 ||
      routeBindings !== undefined && digest(routeBindings) !== digest(routes)) {
    throw new TypeError("review preparation facts do not contain the exact selected routes");
  }
  const subjectGenerations = [{
    schema: "flow.subject-generation/v1",
    contract: "work.workspace/v1",
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    fingerprint: workspace.fingerprint,
  }];
  const defaultLimits = {
    max_cards: 32,
    max_revisions: 1,
    max_cards_per_revision: 32,
    max_capabilities: 0,
    max_resources: 1,
    max_elapsed_seconds: 600,
  };
  const mergedLimits = { ...defaultLimits, ...limits };
  if (Object.entries(mergedLimits).some(([key, value]) =>
    ![
      "max_cards",
      "max_revisions",
      "max_cards_per_revision",
      "max_capabilities",
      "max_resources",
      "max_elapsed_seconds",
    ].includes(key) || !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("review preparation limits are invalid");
  }
  const canonicalRoutes = [...routes].sort((left, right) =>
    digest(left).localeCompare(digest(right)));
  return freezeCanonical({
    catalog_fingerprint: facts.catalog.fingerprint,
    route_snapshot: {
      watermark: digest(canonicalRoutes),
      bindings: canonicalRoutes,
    },
    capability_envelopes: capabilityEnvelopes,
    operation_contracts: facts.operation.contracts,
    validator_contracts: facts.validator.contracts,
    resource_claims: resources,
    block_observations: blockObservations,
    time_facts: facts.time_facts,
    subject_generations: subjectGenerations,
    elapsed_seconds: elapsedSeconds,
    limits: mergedLimits,
  });
}

function deriveIssue(input) {
  const candidateProjection = input?.candidateProjection;
  if (!isPlainRecord(candidateProjection)) {
    return issue("candidate_missing", "candidate projection is missing");
  }
  if (candidateProjection.status !== "sealed") {
    return issue(
      candidateProjection.status === "stale"
        ? "candidate_stale"
        : "candidate_changed",
      "candidate projection is not a current sealed candidate",
      candidateProjection.watermark,
    );
  }
  const candidate = candidateProjection.candidate;
  if (!isPlainRecord(candidate) ||
      candidateProjection.subject_id !== candidate.candidate_id ||
      candidateProjection.candidate_fingerprint !== candidate.candidate_fingerprint) {
    return issue("candidate_foreign", "candidate projection identity does not match");
  }
  if (!isDigest(candidateProjection.watermark) ||
      !isDigest(candidateProjection.candidate_fingerprint)) {
    return issue("candidate_missing", "candidate authority identity is incomplete");
  }

  const ownerAuthorities = input.ownerAuthorities;
  if (!isPlainRecord(ownerAuthorities) ||
      !isExactRecord(ownerAuthorities, OWNER_AUTHORITY_FIELDS)) {
    return issue("authority_missing", "Run, Review, and Workspace owner facts are unavailable");
  }

  const sourceRun = input.sourceRunProjection;
  if (!isPlainRecord(sourceRun)) {
    return issue("source_run_missing", "source run projection is missing");
  }
  if (!nonEmpty(sourceRun.run_id) || sourceRun.phase !== "succeeded" ||
      !isDigest(sourceRun.watermark)) {
    return issue("source_run_changed", "source run is not a completed authority record");
  }
  if (!ownerFactMatchesProjection(ownerAuthorities.run, {
    authorityId: "RunAuthority",
    authorityContract: "flow.run-projection/v1",
    domain: "run",
    subjectId: sourceRun.run_id,
    disposition: sourceRun.phase,
    watermark: sourceRun.watermark,
    projection: sourceRun,
  })) {
    return issueFromAuthorityProjection(
      "authority_changed",
      "RunAuthority facts do not match its source run projection",
      ownerAuthorities.run,
    );
  }
  const sourceReference = sourceRun.review_candidate_reference;
  if (!isPlainRecord(sourceReference) ||
      sourceReference.candidate_id !== candidate.candidate_id ||
      sourceReference.candidate_fingerprint !== candidate.candidate_fingerprint) {
    return issue("source_run_foreign", "source run does not own this candidate");
  }
  if (!ownerFactMatchesProjection(ownerAuthorities.review, {
    authorityId: "ReviewAuthority",
    authorityContract: "work.review/v1",
    domain: "review",
    subjectId: candidateProjection.subject_id,
    disposition: candidateProjection.status,
    watermark: candidateProjection.watermark,
    projection: candidateProjection,
  })) {
    return issueFromAuthorityProjection(
      "authority_changed",
      "ReviewAuthority facts do not match its candidate projection",
      ownerAuthorities.review,
    );
  }

  const workspace = input.workspaceProjection;
  if (!isPlainRecord(workspace)) {
    return issue("workspace_missing", "workspace projection is missing");
  }
  if (!ownerFactMatchesProjection(ownerAuthorities.workspace, {
    authorityId: "WorkspaceAuthority",
    authorityContract: "work.workspace/v1",
    domain: "workspace",
    subjectId: workspace.subject_id,
    disposition: workspace.disposition,
    watermark: workspace.watermark,
    projection: workspace,
  })) {
    return issueFromAuthorityProjection(
      "workspace_changed",
      "WorkspaceAuthority facts do not match its projection",
      workspace,
    );
  }
  if (workspace.disposition !== "retained_for_handoff") {
    return issueFromAuthorityProjection(
      workspace.disposition === "cleaned"
        ? "workspace_disposed"
        : "workspace_not_reviewable",
      "workspace disposition is not retained for review handoff",
      workspace,
    );
  }
  if (workspace.clean !== true || workspace.dirty === true || workspace.tainted === true) {
    return issueFromAuthorityProjection(
      "workspace_dirty",
      "workspace is not clean for local review",
      workspace,
    );
  }
  if (!isDigest(workspace.watermark) ||
      !isDigest(workspace.fingerprint) ||
      !positiveInteger(workspace.generation) ||
      !positiveInteger(workspace.mutation_epoch) ||
      typeof workspace.subject_id !== "string" || workspace.subject_id.length === 0) {
    return issueFromAuthorityProjection(
      "workspace_changed",
      "workspace authority identity is incomplete",
      workspace,
    );
  }
  if (candidate.workspace?.subject_id !== workspace.subject_id ||
      candidate.workspace?.generation !== workspace.generation ||
      candidate.workspace?.fingerprint !== workspace.fingerprint) {
    return issueFromAuthorityProjection(
      "workspace_foreign",
      "candidate does not own the workspace observation",
      workspace,
    );
  }

  let bindings;
  try {
    bindings = normalizedBindings(input.authorityBindings);
  } catch {
    return issue("authority_missing", "required authority bindings are unavailable");
  }
  for (const requirement of AUTHORITY_REQUIREMENTS) {
    const binding = bindings.find(({ id }) => id === requirement.id);
    if (binding === undefined) {
      return issue("authority_missing", "required authority binding is missing");
    }
    if (binding.contract !== requirement.contract ||
        binding.observation_input.fact !== requirement.fact) {
      return issue(
        "authority_changed",
        "required authority binding changed",
        authorityWatermark(binding.observation),
        binding,
      );
    }
    const status = binding.observation.status;
    if (status !== "available" && status !== "present") {
      return issue(
        status === "unavailable"
          ? "authority_unavailable"
          : status === "stale"
            ? "authority_stale"
            : status === "missing"
              ? "authority_missing"
              : "authority_changed",
        "required authority observation is not admissible",
        authorityWatermark(binding.observation),
        binding,
      );
    }
  }
  if (!isPlainRecord(input.routeSnapshot) ||
      !nonEmpty(input.routeSnapshot.route_id) ||
      !isDigest(input.routeSnapshot.configuration_watermark) ||
      !isDigest(input.routeSnapshot.comparison_key) ||
      !validRouteBindings(input.routeSnapshot.bindings, input.routeSnapshot)) {
    return issue("route_changed", "review route identity is unavailable");
  }
  if (!isPlainRecord(input.catalog) ||
      !isCatalogId(input.catalog.id) ||
      !isDigest(input.catalog.fingerprint)) {
    return issue("catalog_changed", "contract catalog identity is unavailable");
  }
  if (!validContracts(input.operationContracts, [OPERATION_CONTRACT]) ||
      !validContracts(input.validatorContracts, REQUIRED_VALIDATORS)) {
    return issue("operation_changed", "review operation or validator contracts are incomplete");
  }
  if (!validTimeFacts(input.timeFacts)) {
    return issue("time_unavailable", "review time authority facts are unavailable");
  }
  if (input.expectedAuthorityBindings !== undefined) {
    const expected = normalizedBindings(input.expectedAuthorityBindings);
    if (digest(expected) !== digest(bindings)) {
      return issue("authority_changed", "required authority bindings changed");
    }
  }
  return null;
}

function candidateFacts(projection) {
  const candidate = projection.candidate;
  return freezeCanonical({
    candidate_id: candidate.candidate_id,
    candidate_fingerprint: candidate.candidate_fingerprint,
    lifecycle_generation: projection.lifecycle_generation ?? projection.generation,
    authority_watermark: projection.watermark,
  });
}

function sourceRunFacts(projection, candidate) {
  return freezeCanonical({
    run_id: projection.run_id,
    phase: projection.phase,
    candidate_id: candidate.candidate_id,
    candidate_fingerprint: candidate.candidate_fingerprint,
    authority_watermark: projection.watermark,
  });
}

function workspaceFacts(projection) {
  return freezeCanonical({
    subject_id: projection.subject_id,
    generation: projection.generation,
    mutation_epoch: projection.mutation_epoch,
    fingerprint: projection.fingerprint,
    authority_watermark: projection.watermark,
  });
}

function normalizedBindings(bindings) {
  return [...normalizeAuthorityBindings(bindings)].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function authorityFactFromBinding(binding) {
  return createAuthorityFact({
    authorityId: binding.id,
    authorityContract: binding.contract,
    providerIdentity: binding.provider_identity,
    watermark: authorityWatermark(binding.observation),
    generation: authorityGeneration(binding.observation),
    legalActions: binding.observation.legal_actions ?? [],
  });
}

function authorityWatermarkFor(bindings, id) {
  const binding = bindings.find((candidate) => candidate.id === id);
  const watermark = authorityWatermark(binding?.observation);
  if (watermark !== null) return watermark;
  const generation = authorityGeneration(binding?.observation);
  return generation === null ? null : digest({ id, generation });
}

function validateCandidate(candidate, issues) {
  if (!isExactRecord(candidate, CANDIDATE_FIELDS) ||
      !nonEmpty(candidate.candidate_id) ||
      !isDigest(candidate.candidate_fingerprint) ||
      !positiveInteger(candidate.lifecycle_generation) ||
      !isDigest(candidate.authority_watermark)) {
    issues.push(issue("candidate_changed", "candidate facts are invalid", candidate?.authority_watermark));
  }
}

function validateSourceRun(sourceRun, candidate, issues) {
  if (!isExactRecord(sourceRun, SOURCE_RUN_FIELDS) ||
      !nonEmpty(sourceRun.run_id) || sourceRun.phase !== "succeeded" ||
      sourceRun.candidate_id !== candidate?.candidate_id ||
      sourceRun.candidate_fingerprint !== candidate?.candidate_fingerprint ||
      !isDigest(sourceRun.authority_watermark)) {
    issues.push(issue("source_run_changed", "source run facts are invalid", sourceRun?.authority_watermark));
  }
}

function validateWorkspace(workspace, issues) {
  if (!isExactRecord(workspace, WORKSPACE_FIELDS) ||
      !nonEmpty(workspace.subject_id) ||
      !positiveInteger(workspace.generation) ||
      !positiveInteger(workspace.mutation_epoch) ||
      !isDigest(workspace.fingerprint) ||
      !isDigest(workspace.authority_watermark)) {
    issues.push(issue("workspace_changed", "workspace facts are invalid", workspace?.authority_watermark));
  }
}

function validateRoute(route, issues) {
  if (!isExactRecord(route, ROUTE_FIELDS) ||
      !nonEmpty(route.route_id) ||
      !isDigest(route.configuration_watermark) ||
      !isDigest(route.comparison_key) ||
      !validRouteBindings(route.bindings, route)) {
    issues.push(issue("route_changed", "route facts are invalid"));
  }
}

function validRouteBindings(bindings, route) {
  if (!Array.isArray(bindings) || bindings.length === 0) return false;
  const seen = new Set();
  const agentIds = new Set();
  const launchKeys = new Set();
  for (const binding of bindings) {
    if (!isExactRecord(binding, ROUTE_BINDING_FIELDS) ||
        typeof binding.card_id !== "string" || binding.card_id.length === 0 ||
        seen.has(binding.card_id) || !validPlanRoute(binding.route) ||
        !validRouteDescription(binding.description) ||
        binding.route.configuration_watermark !==
          binding.description.watermark.content_sha256 ||
        binding.route.description_digest !== binding.description.description_digest ||
        binding.route.launch_comparison_key !==
          binding.description.comparison_keys.launch) {
      return false;
    }
    if (agentIds.has(binding.route.agent_id) ||
        launchKeys.has(binding.route.launch_comparison_key)) return false;
    seen.add(binding.card_id);
    agentIds.add(binding.route.agent_id);
    launchKeys.add(binding.route.launch_comparison_key);
  }
  const ordered = sortRouteBindings(bindings);
  return digest(ordered) === digest(bindings) &&
    digest(ordered.map(({ card_id, route, description }) => ({
      card_id,
      route,
      description_digest: description.description_digest,
    }))) === route.configuration_watermark &&
    digest(ordered.map(({ card_id, route }) => ({
      card_id,
      launch_comparison_key: route.launch_comparison_key,
    }))) === route.comparison_key;
}

function validPlanRoute(route) {
  return isExactRecord(route, ROUTE_FIELDS_FOR_PLAN) &&
    typeof route.agent_id === "string" && route.agent_id.length > 0 &&
    isDigest(route.configuration_watermark) &&
    isDigest(route.description_digest) &&
    isDigest(route.launch_comparison_key);
}

function validRouteDescription(description) {
  if (isDirectDescription(description)) {
    try { return directDescriptionIssue(description) === null; }
    catch { return false; }
  }
  if (!isPlainRecord(description) ||
      description.schema !== "drovr.delegated-agent-description/v1" ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.comparison_keys?.effective_authority) ||
      !isDigest(description.watermark?.content_sha256)) {
    return false;
  }
  const { description_digest: _digest, legal_actions: _actions, ...identity } =
    description;
  try {
    return digest(identity) === description.description_digest;
  } catch {
    return false;
  }
}

function sortRouteBindings(bindings) {
  return [...(bindings ?? [])].sort((left, right) =>
    left.card_id < right.card_id ? -1 : left.card_id > right.card_id ? 1 : 0);
}

function validateCatalog(catalog, issues) {
  if (!isExactRecord(catalog, CATALOG_FIELDS) ||
      !isCatalogId(catalog.id) || !isDigest(catalog.fingerprint)) {
    issues.push(issue("catalog_changed", "catalog facts are invalid"));
  }
}

function validateContracts(value, required, label, issues) {
  if (!isExactRecord(value, CONTRACT_FIELDS) ||
      !validContracts(value.contracts, required, true)) {
    issues.push(issue(`${label}_changed`, `${label} contracts are invalid`));
  }
}

function validateTimeFacts(timeFacts, issues) {
  if (!validTimeFacts(timeFacts)) {
    issues.push(issue("time_unavailable", "time facts are invalid"));
  }
}

function validateAuthorityFacts(authorityFacts, issues) {
  if (!Array.isArray(authorityFacts) || authorityFacts.length !== AUTHORITY_REQUIREMENTS.length) {
    issues.push(issue("authority_changed", "authority facts are incomplete"));
    return;
  }
  const byId = new Map();
  for (const fact of authorityFacts) {
    if (!isExactRecord(fact, [
      "schema",
      "authority_id",
      "authority_contract",
      "provider_identity",
      "watermark",
      "generation",
      "legal_actions",
    ]) || fact.schema !== AUTHORITY_FACT_SCHEMA ||
        !nonEmpty(fact.authority_id) ||
        !nonEmpty(fact.authority_contract) ||
        !isProviderIdentity(fact.provider_identity) ||
        !isDigest(fact.watermark) && fact.watermark !== null ||
        fact.watermark === null && fact.generation === null ||
        fact.generation !== null &&
          (!Number.isSafeInteger(fact.generation) || fact.generation < 0) ||
        !Array.isArray(fact.legal_actions)) {
      issues.push(issue("authority_changed", "authority facts are invalid"));
      continue;
    }
    byId.set(fact.authority_id, fact);
  }
  for (const requirement of AUTHORITY_REQUIREMENTS) {
    const fact = byId.get(requirement.id);
    if (fact === undefined || fact.authority_contract !== requirement.contract) {
      issues.push(issue("authority_changed", "authority facts do not match the shipped contracts"));
    }
  }
}

function validateOwnerAuthorities(ownerAuthorities, issues, facts) {
  if (!isExactRecord(ownerAuthorities, OWNER_AUTHORITY_FIELDS)) {
    issues.push(issue("authority_changed", "owner authority facts are incomplete"));
    return;
  }
  const expected = {
    run: {
      authorityId: "RunAuthority",
      contract: "flow.run-projection/v1",
      providerId: "flow.production.run-authority",
      domain: "run",
      subjectId: facts.source_run?.run_id,
      disposition: facts.source_run?.phase,
      watermark: facts.source_run?.authority_watermark,
    },
    review: {
      authorityId: "ReviewAuthority",
      contract: "work.review/v1",
      providerId: "flow.production.review-authority",
      domain: "review",
      subjectId: facts.candidate?.candidate_id,
      disposition: "sealed",
      watermark: facts.candidate?.authority_watermark,
    },
    workspace: {
      authorityId: "WorkspaceAuthority",
      contract: "work.workspace/v1",
      providerId: "flow.production.workspace-authority",
      domain: "workspace",
      subjectId: facts.workspace?.subject_id,
      disposition: "retained_for_handoff",
      watermark: facts.workspace?.authority_watermark,
    },
  };
  for (const owner of OWNER_AUTHORITY_FIELDS) {
    const fact = ownerAuthorities[owner];
    const data = fact?.facts;
    if (!isExactRecord(fact, OWNER_FACT_FIELDS) ||
        fact.schema !== AUTHORITY_FACT_SCHEMA ||
        fact.authority_id !== expected[owner].authorityId ||
        fact.authority_contract !== expected[owner].contract ||
        !isProviderIdentity(fact.provider_identity) ||
        fact.provider_identity.id !== expected[owner].providerId ||
        fact.provider_identity.version !== "1" ||
        !isDigest(fact.watermark) ||
        fact.watermark !== expected[owner].watermark ||
        fact.watermark_domain !== expected[owner].domain ||
        !nonEmpty(fact.subject_id) ||
        fact.subject_id !== expected[owner].subjectId ||
        !nonEmpty(fact.disposition) ||
        fact.disposition !== expected[owner].disposition ||
        !Number.isSafeInteger(fact.generation) || fact.generation < 0 ||
        !Array.isArray(fact.legal_actions) ||
        !isExactRecord(data, OWNER_FACT_DATA_FIELDS[owner]) ||
        !validateOwnerAuthorityFacts(owner, data)) {
      issues.push(issueFromOwnerAuthorityFact(
        "authority_changed",
        `${owner} owner authority facts are invalid`,
        fact,
      ));
    }
  }
  const runFacts = ownerAuthorities.run?.facts;
  const reviewFacts = ownerAuthorities.review?.facts;
  const workspaceFacts = ownerAuthorities.workspace?.facts;
  if (runFacts?.run_id !== facts.source_run?.run_id ||
      runFacts?.candidate_id !== facts.candidate?.candidate_id ||
      runFacts?.candidate_fingerprint !== facts.candidate?.candidate_fingerprint) {
    issues.push(issueFromOwnerAuthorityFact(
      "authority_changed",
      "RunAuthority facts do not bind the prepared subjects",
      ownerAuthorities.run,
    ));
  }
  if (reviewFacts?.candidate_fingerprint !== facts.candidate?.candidate_fingerprint ||
      reviewFacts?.workspace_subject_id !== facts.workspace?.subject_id ||
      reviewFacts?.workspace_generation !== facts.workspace?.generation ||
      reviewFacts?.workspace_fingerprint !== facts.workspace?.fingerprint) {
    issues.push(issueFromOwnerAuthorityFact(
      "authority_changed",
      "ReviewAuthority facts do not bind the prepared subjects",
      ownerAuthorities.review,
    ));
  }
  if (workspaceFacts?.fingerprint !== facts.workspace?.fingerprint ||
      workspaceFacts?.mutation_epoch !== facts.workspace?.mutation_epoch) {
    issues.push(issueFromOwnerAuthorityFact(
      "authority_changed",
      "WorkspaceAuthority facts do not bind the prepared subjects",
      ownerAuthorities.workspace,
    ));
  }
}

function issueFromOwnerAuthorityFact(code, reason, fact) {
  return freezeCanonical({
    code,
    reason,
    authority_id: fact?.authority_id ?? null,
    authority_contract: fact?.authority_contract ?? null,
    provider_identity: fact?.provider_identity ?? null,
    authority_watermark: isDigest(fact?.watermark) ? fact.watermark : null,
    authority_watermark_domain: fact?.watermark_domain ?? null,
    authority_generation: Number.isSafeInteger(fact?.generation)
      ? fact.generation
      : null,
    legal_actions: Array.isArray(fact?.legal_actions) ? fact.legal_actions : [],
    ...(isPlainRecord(fact) ? { authority_fact: fact } : {}),
  });
}

function validateOwnerAuthorityFacts(owner, facts) {
  if (!isDigest(facts.projection_digest)) return false;
  if (owner === "run") {
    const currentRevision = facts.current_revision;
    return nonEmpty(facts.run_id) && facts.phase === "succeeded" &&
      nonEmpty(facts.candidate_id) && isDigest(facts.candidate_fingerprint) &&
      Number.isSafeInteger(facts.sequence) && facts.sequence >= 0 &&
      isExactRecord(currentRevision, ["ordinal", "plan_fingerprint"]) &&
      Number.isSafeInteger(currentRevision.ordinal) && currentRevision.ordinal >= 0 &&
      isDigest(currentRevision.plan_fingerprint) &&
      isDigest(facts.bundle_digest);
  }
  if (owner === "review") {
    return isDigest(facts.candidate_fingerprint) &&
      nonEmpty(facts.workspace_subject_id) &&
      Number.isSafeInteger(facts.workspace_generation) && facts.workspace_generation >= 1 &&
      isDigest(facts.workspace_fingerprint);
  }
  return isDigest(facts.fingerprint) &&
    typeof facts.git_commit_sha === "string" && /^[0-9a-f]{40,64}$/u.test(facts.git_commit_sha) &&
    typeof facts.git_tree_sha === "string" && /^[0-9a-f]{40,64}$/u.test(facts.git_tree_sha) &&
    nonEmpty(facts.git_ref) && facts.git_clean === true &&
    Number.isSafeInteger(facts.mutation_epoch) && facts.mutation_epoch >= 1 &&
    facts.taint_status === "clear" && isDigest(facts.claims_digest);
}

function ownerFactMatchesProjection(fact, {
  authorityId,
  authorityContract,
  domain,
  subjectId,
  disposition,
  watermark,
  projection,
}) {
  let projectionDigest = projection?.owner_projection_digest;
  if (projectionDigest === undefined) {
    try {
      projectionDigest = reviewOwnerProjectionDigest(
        authorityId === "RunAuthority" ? "run" :
          authorityId === "WorkspaceAuthority" ? "workspace" : "review",
        projection,
      );
    } catch {
      return false;
    }
  }
  return isPlainRecord(fact) &&
    fact.authority_id === authorityId &&
    fact.authority_contract === authorityContract &&
    fact.watermark_domain === domain &&
    fact.subject_id === subjectId &&
    fact.disposition === disposition &&
    fact.watermark === watermark &&
    isDigest(fact.facts?.projection_digest) &&
    fact.facts.projection_digest === projectionDigest;
}

function validateWatermarks(watermarks, issues) {
  if (!isExactRecord(watermarks, WATERMARK_FIELDS) ||
      WATERMARK_FIELDS.some((field) => !isDigest(watermarks[field]))) {
    issues.push(issue("authority_changed", "authority watermarks are invalid"));
  }
}

function compareExpected(facts, expected, issues) {
  if (!isPlainRecord(expected)) return;
  if (expected.candidate_fingerprint !== undefined &&
      facts.candidate.candidate_fingerprint !== expected.candidate_fingerprint) {
    issues.push(issue("candidate_foreign", "candidate facts do not match the expected candidate"));
  }
  if (expected.source_run_id !== undefined &&
      facts.source_run.run_id !== expected.source_run_id) {
    issues.push(issue("source_run_foreign", "source run facts do not match the expected run"));
  }
  if (expected.workspace_fingerprint !== undefined &&
      facts.workspace.fingerprint !== expected.workspace_fingerprint) {
    issues.push(issue("workspace_foreign", "workspace facts do not match the expected workspace"));
  }
}

function validContracts(value, required, canonical = false) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((contract) => typeof contract !== "string" || contract.length === 0)) {
    return false;
  }
  const sorted = [...new Set(value)].sort();
  return sorted.length === value.length &&
    (!canonical || digest(sorted) === digest(value)) &&
    required.every((contract) => value.includes(contract));
}

function validTimeFacts(value) {
  return Array.isArray(value) && value.length > 0 &&
    validateCanonicalTimeFacts(value);
}

function sortByDigest(values) {
  if (!Array.isArray(values)) return values;
  return [...values].sort((left, right) => digest(left).localeCompare(digest(right)));
}

function sortedUniqueStrings(values) {
  return [...new Set(values ?? [])].sort();
}

function rejectionFromIssue(value) {
  const issueValue = value ?? issue("facts_changed", "review facts are invalid");
  const authorityFact = issueValue.authority_fact ?? authorityFactFromIssue({
    authority_id: issueValue.authority_id ?? null,
    authority_contract: issueValue.authority_contract ?? null,
    authority_provider_identity: issueValue.provider_identity ?? null,
    authority_watermark: issueValue.authority_watermark ?? null,
    authority_generation: issueValue.authority_generation ?? null,
    legal_actions: issueValue.legal_actions ?? [],
  });
  return createRejection({
    operation: "prepare",
    code: issueValue.code,
    reason: issueValue.reason,
    authorityWatermark: authorityFact.watermark,
    authorityWatermarkDomain: ["host", "run"].includes(
      issueValue.authority_watermark_domain,
    ) ? issueValue.authority_watermark_domain : "host",
    legalActions: Array.isArray(issueValue.legal_actions)
      ? issueValue.legal_actions
      : authorityFact.legal_actions,
    authorityFact,
  });
}

function issue(
  code,
  reason,
  authorityWatermarkValue = null,
  binding = null,
) {
  return freezeCanonical({
    code,
    reason,
    authority_id: binding?.id ?? null,
    authority_contract: binding?.contract ?? null,
    provider_identity: binding?.provider_identity ?? null,
    authority_watermark: isDigest(authorityWatermarkValue)
      ? authorityWatermarkValue
      : authorityWatermark(binding?.observation) ?? null,
    authority_generation: authorityGeneration(binding?.observation),
    legal_actions: Array.isArray(binding?.observation?.legal_actions)
      ? binding.observation.legal_actions
      : [],
  });
}

function issueFromAuthorityProjection(code, reason, projection) {
  const fact = projection?.authority_fact;
  const terminalWorkspace = isTerminalWorkspaceDisposition(
    projection?.disposition,
  );
  const authorityFact = terminalWorkspace && fact !== undefined
    ? { ...fact, legal_actions: [] }
    : fact;
  const identity = fact ?? projection;
  return freezeCanonical({
    ...issue(code, reason, projection?.watermark),
    authority_id: identity?.authority_id ?? null,
    authority_contract: identity?.authority_contract ?? projection?.contract ?? null,
    provider_identity: identity?.provider_identity ??
      projection?.provider_identity ?? null,
    authority_generation: identity?.generation ?? projection?.generation ?? null,
    authority_watermark_domain: "workspace",
    legal_actions: terminalWorkspace
      ? []
      : Array.isArray(identity?.legal_actions) &&
      identity.legal_actions.length > 0
      ? identity.legal_actions
      : Array.isArray(projection?.legal_actions) && projection.legal_actions.length > 0
        ? projection.legal_actions
        : workspaceRecoveryActions(projection),
    ...(authorityFact === undefined ? {} : { authority_fact: authorityFact }),
  });
}

export function workspaceRecoveryActions(projection) {
  if (isTerminalWorkspaceDisposition(projection?.disposition)) return [];
  const subjectId = projection?.subject_id;
  const watermark = projection?.watermark;
  if (!nonEmpty(subjectId) || !isDigest(watermark)) return [];
  return [freezeCanonical({
    schema: "work.legal-next-action/v1",
    type: "workspace_reobservation_required",
    contract: "work.workspace/v1",
    command_schema: "work.workspace-observation-command/v1",
    subject_id: subjectId,
    expected_watermark: watermark,
    expected_generation: projection?.generation ?? null,
    expected_mutation_epoch: projection?.mutation_epoch ?? null,
    expected_fingerprint: isDigest(projection?.fingerprint)
      ? projection.fingerprint
      : null,
  })];
}

function isTerminalWorkspaceDisposition(disposition) {
  return TERMINAL_WORKSPACE_DISPOSITIONS.has(disposition);
}

function isExactRecord(value, fields) {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isCatalogId(value) {
  return typeof value === "string" && CATALOG_PATTERN.test(value);
}

function isProviderIdentity(value) {
  return isExactRecord(value, ["schema", "id", "version"]) &&
    value.schema === REGISTERED_AUTHORITY_SCHEMA &&
    nonEmpty(value.id) && nonEmpty(value.version);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}
