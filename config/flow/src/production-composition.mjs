import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

import {
  digest,
  freezeCanonical,
} from "../../../tools/flow/src/canonical.mjs";
import {
  createFeatureDefinition,
  FEATURE_CAPTURE_RECEIPT_VALIDATOR,
  FEATURE_DELEGATE_OUTPUT_VALIDATOR,
  FEATURE_OPERATION_CONTRACTS,
  FEATURE_TEST_RECEIPT_VALIDATOR,
  FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
  validateFeatureCaptureReceipt,
  validateFeatureTestReceipt,
  validateFeatureVerificationReceipt,
} from "../../../tools/flow/src/feature-flow.mjs";
import { createReviewDefinition } from "../../../tools/flow/src/review-flow.mjs";
import { createHostAuthorityIdentityAdapter } from "../../../tools/flow/src/host-authority-identity.mjs";
import { createTopLevelRunOwnershipAdapter } from "../../../tools/flow/src/run-authority.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";
import {
  registeredOperation,
  sanitizeProviderEvidence,
  validateEffectObservation,
} from "../../../tools/flow/src/operation-effects.mjs";
import {
  createGitRetentionAdapter,
  createGitWorkspaceObservationAdapter,
} from "../../../tools/flow/src/git-retention-adapter.mjs";
import { flowGrantIdsForDrovrCapability } from "../../../tools/flow/src/delegate-capabilities.mjs";
import {
  loadRequiredDrovrFeatures,
  featureConformanceFindings,
} from "../../../tools/flow/src/required-drovr-features.mjs";
import { validateDelegateEvidenceSafety } from "../../../tools/flow/src/evidence-safety.mjs";
import {
  createProductionFeatureOperations,
  prepareProductionFeatureLaunch,
  validateFeatureCriterionEvidence,
} from "./production-feature-operations.mjs";

const PREPARATION_SCHEMA = "flow.feature-preparation-request/v1";
const BRIEF_SCHEMA = "flow.feature-brief/v1";
const WORKSPACE_SCHEMA = "flow.feature-workspace-binding/v1";
const DELEGATION_SCHEMA = "flow.feature-delegation-bindings/v1";
const VERIFICATION_SCHEMA = "flow.feature-verification-request/v1";
const BASELINE_SCHEMA = "flow.feature-safe-baseline/v1";
const AUTHORITY_SCHEMA = "flow.authority-observation/v1";
const REGISTERED_AUTHORITY_SCHEMA = "flow.registered-authority/v1";
const TIME_OBSERVATION_QUANTUM_MS = 1_000;
const TIME_OBSERVATION_QUANTUM_NS = 1_000_000_000n;
const TIME_OBSERVATION_UNCERTAINTY_MS = TIME_OBSERVATION_QUANTUM_MS - 1;
const TIME_OBSERVATION_UNCERTAINTY_NS =
  (TIME_OBSERVATION_QUANTUM_NS - 1n).toString();

/**
 * Compose the production registrations around the generic FlowRuntime.
 * Repository paths and mutable provider state remain private to this object;
 * only immutable observations cross the preparation seam.
 */
export function createProductionComposition({
  delegatedAgentPort,
  authorityOptions = {},
  registeredOperations = {},
  registeredAuthorities = {},
  predefinedDefinitions = {},
  delegateOutputValidators = {},
} = {}) {
  if (typeof delegatedAgentPort?.describe !== "function") {
    throw new TypeError("production FlowRuntime requires a Drovr description port");
  }

  const repositories = new Map();
  const workspaceRepositories = new Map();
  let boundAuthority = null;

  const hostIdentityAdapter = authorityOptions.hostIdentityAdapter ??
    createHostAuthorityIdentityAdapter();
  const gitWorkspaceObservationAdapter =
    authorityOptions.gitWorkspaceObservationAdapter ??
    createGitWorkspaceObservationAdapter();
  const gitRetentionAdapter = authorityOptions.gitRetentionAdapter ??
    createGitRetentionAdapter({
      resolveRepository(repositoryId) {
        const repository = repositories.get(repositoryId);
        if (repository === undefined) {
          throw new ProductionPreparationError(
            "repository_unavailable",
            `repository is not registered: ${repositoryId}`,
          );
        }
        return repository;
      },
    });
  const hostIdentity = hostIdentityAdapter.observe();
  const timeObservationAdapter = authorityOptions.timeObservationAdapter ??
    createTimeAdapter(hostIdentity);
  let operations;

  const productionAuthorityOptions = {
    ...authorityOptions,
    hostIdentityAdapter,
    gitWorkspaceObservationAdapter,
    gitRetentionAdapter,
    timeObservationAdapter,
    retryTimeAdapter: authorityOptions.retryTimeAdapter ?? timeObservationAdapter,
    rebootObservationAdapter: authorityOptions.rebootObservationAdapter ??
      createRebootObservationAdapter(timeObservationAdapter, () => operations),
    workEvidenceAdapter: authorityOptions.workEvidenceAdapter ??
      createWorkEvidenceAdapter(),
    runOwnershipAdapter: authorityOptions.runOwnershipAdapter ??
      createTopLevelRunOwnershipAdapter(),
  };
  const featureOperations = createProductionFeatureOperations({
    resolveWorkspace: resolveProductionWorkspace,
    gitWorkspaceObservationAdapter,
    gitRetentionAdapter,
  });
  operations = mergeRegistrations({
    defaults: featureOperationRegistrations(featureOperations.operations),
    overrides: registeredOperations,
  });

  return Object.freeze({
    authorityOptions: productionAuthorityOptions,
    definitions: mergeRegistrations({
      defaults: {
        "feature/v1": createFeatureDefinition(),
        "review/v1": createReviewDefinition(),
      },
      overrides: predefinedDefinitions,
    }),
    operations,
    authorities: mergeRegistrations({
      defaults: authorityRegistrations(),
      overrides: registeredAuthorities,
    }),
    validators: mergeRegistrations({
      defaults: {
        [FEATURE_DELEGATE_OUTPUT_VALIDATOR]: {
          validate: validateDelegateOutput,
          evidenceSafety: validateDelegateEvidenceSafety,
        },
      },
      overrides: delegateOutputValidators,
    }),
    isPreparationRequest(request) {
      return request?.schema === PREPARATION_SCHEMA ||
        request?.brief !== undefined && request?.repository !== undefined;
    },
    async prepare(request, compileSelection) {
      if (typeof compileSelection !== "function") {
        throw new TypeError("production preparation requires the core compiler");
      }
      const prepared = await buildPreparationSelection({
        request,
        delegatedAgentPort,
        gitWorkspaceObservationAdapter,
        hostIdentity,
        timeAdapter: timeObservationAdapter,
        repositories,
        workspaceRepositories,
      });
      return compileSelection(prepared.selection);
    },
    bindAuthority(authority) {
      boundAuthority = authority;
      featureOperations.bindAuthority(authority);
    },
    beforeLaunch(request, authority) {
      return prepareProductionFeatureLaunch({
        request,
        runAuthority: authority,
        workspaceRepositories,
        resolveWorkspace: resolveProductionWorkspace,
        gitWorkspaceObservationAdapter,
        operations,
      });
    },
  });

  function resolveProductionWorkspace(subjectId) {
    const registered = workspaceRepositories.get(subjectId);
    if (registered !== undefined) return registered;
    if (boundAuthority === null || typeof subjectId !== "string") return null;
    let projection;
    try {
      projection = getWorkspaceAuthority({ runAuthority: boundAuthority }).query({
        contract: "work.workspace/v1",
        subject_id: subjectId,
      });
    } catch {
      return null;
    }
    if (projection?.schema !== "work.workspace-projection/v1" ||
        projection.workspace?.canonical_id !== subjectId ||
        typeof projection.workspace?.canonical_path !== "string" ||
        typeof projection.repository?.canonical_id !== "string" ||
        typeof projection.git?.ref !== "string") {
      return null;
    }
    const repository = {
      repository_id: projection.repository.canonical_id,
      path: projection.workspace.canonical_path,
      ref: projection.git.ref,
    };
    workspaceRepositories.set(subjectId, repository);
    repositories.set(repository.repository_id, repository.path);
    return repository;
  }
}

export class ProductionPreparationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProductionPreparationError";
    this.code = code;
  }
}

async function buildPreparationSelection({
  request,
  delegatedAgentPort,
  gitWorkspaceObservationAdapter,
  hostIdentity,
  timeAdapter,
  repositories,
  workspaceRepositories,
}) {
  if (!isRecord(request) ||
      request.schema !== undefined && request.schema !== PREPARATION_SCHEMA) {
    throw new ProductionPreparationError(
      "invalid_preparation_request",
      "feature preparation requires flow.feature-preparation-request/v1",
    );
  }
  const brief = request.brief;
  if (!isRecord(brief) || brief.schema !== BRIEF_SCHEMA ||
      typeof brief.id !== "string" || brief.id.length === 0 ||
      typeof brief.summary !== "string" || brief.summary.length === 0 ||
      !Array.isArray(brief.acceptance) || brief.acceptance.length === 0 ||
      !brief.acceptance.every((criterion) =>
        typeof criterion === "string" && criterion.length > 0)) {
    throw new ProductionPreparationError(
      "invalid_brief",
      "feature preparation requires one accepted brief",
    );
  }
  const repositoryPath = canonicalRepositoryPath(repositoryPathOf(request.repository));
  const repositoryId = `repository:${digest(repositoryPath).slice("sha256:".length)}`;
  let git;
  try {
    git = observeGit(repositoryPath, gitWorkspaceObservationAdapter);
  } catch (error) {
    throw new ProductionPreparationError(
      "repository_git_unavailable",
      "the existing repository cannot provide exact clean Git facts",
      { cause: error },
    );
  }
  if (git.clean !== true) {
    throw new ProductionPreparationError(
      "repository_dirty",
      "feature preparation requires a clean Git repository",
    );
  }
  repositories.set(repositoryId, repositoryPath);
  const workspaceSubjectId = `workspace:${digest({
    repository_id: repositoryId,
    canonical_path: repositoryPath,
  }).slice("sha256:".length)}`;
  const workspace = freezeCanonical({
    schema: WORKSPACE_SCHEMA,
    subject_id: workspaceSubjectId,
    generation: 1,
    mutation_epoch: 1,
    fingerprint: digest({ git }),
    git,
  });
  workspaceRepositories.set(workspaceSubjectId, {
    repository_id: repositoryId,
    path: repositoryPath,
    ref: git.ref,
  });

  const mode = request.mode ?? "verify";
  if (mode !== "verify") {
    throw new ProductionPreparationError(
      "unsupported_preparation_mode",
      "production preparation currently supports verify mode only",
    );
  }
  const routes = request.routes ?? request.delegation;
  const apply = await describedRoute({
    delegatedAgentPort,
    input: routes?.apply,
    capability: "workspace-write",
    role: "apply",
    repositoryId,
    workspaceSubjectId,
  });
  const critique = await describedRoute({
    delegatedAgentPort,
    input: routes?.critique,
    capability: "read-only",
    role: "critique",
    repositoryId,
    workspaceSubjectId,
  });
  if (apply.description.description_digest ===
      critique.description.description_digest ||
      apply.route.launch_comparison_key === critique.route.launch_comparison_key) {
    throw new ProductionPreparationError(
      "non_independent_critique_route",
      "feature preparation requires an independent critique route",
    );
  }

  const delegation = {
    schema: DELEGATION_SCHEMA,
    apply,
    critique,
  };
  const verification = {
    schema: VERIFICATION_SCHEMA,
    baseline: {
      schema: BASELINE_SCHEMA,
      assertion: request.verification?.baseline?.assertion ??
        "the accepted feature changes the repository behavior",
      fingerprint: workspace.fingerprint,
    },
  };
  const routeBindings = [
    { card_id: "feature-apply", route: apply.route },
    { card_id: "feature-critique", route: critique.route },
  ];
  const operationContracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  const validatorContracts = [
    "flow.validator/operation-receipt/v1",
    FEATURE_DELEGATE_OUTPUT_VALIDATOR,
    FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    FEATURE_TEST_RECEIPT_VALIDATOR,
    FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
  ];
  const resourceClaims = [{
    kind: "workspace",
    id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
  }];
  const subjectGenerations = [{
    schema: "flow.subject-generation/v1",
    contract: "work.workspace/v1",
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    fingerprint: workspace.fingerprint,
  }];
  const limits = preparationLimits(request.limits);
  const explicitFacts = freezeCanonical({
    catalog_fingerprint: digest({
      definitions: ["feature/v1", "review/v1"],
      operation_contracts: operationContracts,
      validator_contracts: validatorContracts,
    }),
    route_snapshot: {
      watermark: digest(routeBindings),
      bindings: routeBindings,
    },
    capability_envelopes: routeCapabilities(apply, critique),
    operation_contracts: operationContracts,
    validator_contracts: validatorContracts,
    resource_claims: resourceClaims,
    block_observations: [],
    time_facts: timeAdapter.observe(),
    subject_generations: subjectGenerations,
    elapsed_seconds: 0,
    limits,
  });
  return {
    selection: {
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs: {
        brief,
        mode,
        workspace,
        verification,
        delegation,
      },
      explicit_facts: explicitFacts,
    },
  };
}

function featureOperationRegistrations(productionOperations) {
  const unavailable = (extra = {}) => ({
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    ...extra,
    invoke() {
      throw new ProductionPreparationError(
        "production_operation_unavailable",
        "the production operation is not available at preparation time",
      );
    },
  });
  return {
    [FEATURE_OPERATION_CONTRACTS.setup]: unavailable(),
    [FEATURE_OPERATION_CONTRACTS.test]: unavailable({
      provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
      validateReceipt: validateFeatureTestReceipt,
    }),
    [FEATURE_OPERATION_CONTRACTS.capture]: productionOperations[
      FEATURE_OPERATION_CONTRACTS.capture
    ],
    [FEATURE_OPERATION_CONTRACTS.verify]: productionOperations[
      FEATURE_OPERATION_CONTRACTS.verify
    ],
    [FEATURE_OPERATION_CONTRACTS.seal]: productionOperations[
      FEATURE_OPERATION_CONTRACTS.seal
    ],
  };
}

function authorityRegistrations() {
  const entries = [
    ["route:facts", "flow.route-authority/v1", "route_snapshot"],
    ["resource:facts", "flow.resource-authority/v1", "resource_claims"],
    ["contract:facts", "flow.contract-authority/v1", "contract_facts"],
    ["generation:facts", "flow.subject-generation/v1", "subject_generations"],
  ];
  return Object.fromEntries(entries.map(([id, contract, fact]) => [id, {
    schema: REGISTERED_AUTHORITY_SCHEMA,
    id,
    contract,
    provider_identity: {
      schema: REGISTERED_AUTHORITY_SCHEMA,
      id: `flow.production.${fact.replaceAll("_", "-")}`,
      version: "1",
    },
    observe(context = {}) {
      const facts = context.selection?.explicit_facts ??
        context.prepared?.explicit_facts ?? null;
      const value = authorityFactValue(facts, fact);
      return {
        schema: AUTHORITY_SCHEMA,
        status: value === undefined ? "unavailable" : "available",
        watermark: digest(value ?? { fact, status: "unavailable" }),
        observation_input: { fact },
      };
    },
  }]));
}

function authorityFactValue(facts, fact) {
  if (facts === null) return undefined;
  if (fact === "contract_facts") {
    return {
      operation_contracts: facts.operation_contracts,
      validator_contracts: facts.validator_contracts,
    };
  }
  return facts[fact];
}

async function describedRoute({
  delegatedAgentPort,
  input,
  capability,
  role,
}) {
  const launch = input?.launch ?? input;
  if (!isRecord(launch)) {
    throw new ProductionPreparationError(
      "invalid_route",
      `feature preparation requires a ${role} route launch`,
    );
  }
  const request = {
    schema: "drovr.delegated-agent-description-request/v1",
    launch: { ...launch, capability: launch.capability ?? capability },
    caller_metadata: {
      flow: "feature/v1",
      role,
    },
  };
  const projection = await delegatedAgentPort.describe(request);
  const description = projection?.description;
  if (projection?.status !== "compatible" || !isRecord(description)) {
    throw new ProductionPreparationError(
      "drovr_incompatible",
      `Drovr ${role} route is unavailable or incompatible`,
    );
  }
  let findings;
  try {
    findings = featureConformanceFindings(
      description,
      loadRequiredDrovrFeatures(),
    );
  } catch (error) {
    throw new ProductionPreparationError(
      "drovr_contract_unavailable",
      "the shipped Drovr feature contract is unavailable",
      { cause: error },
    );
  }
  if (findings.length > 0 ||
      description.schema !== "drovr.delegated-agent-description/v1" ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.comparison_keys?.effective_authority) ||
      !isDigest(description.watermark?.content_sha256)) {
    throw new ProductionPreparationError(
      "drovr_incompatible",
      `Drovr ${role} route does not satisfy the shipped feature contract`,
    );
  }
  const {
    description_digest: _projectionDigest,
    legal_actions: _projectionActions,
    ...descriptionIdentity
  } = description;
  const boundDescription = freezeCanonical({
    ...descriptionIdentity,
    description_digest: digest(descriptionIdentity),
  });
  const agentId = `agent:flow-feature-${role}-${description.comparison_keys.launch.slice(-16)}`;
  return {
    description: boundDescription,
    route: {
      agent_id: agentId,
      configuration_watermark: boundDescription.watermark.content_sha256,
      description_digest: boundDescription.description_digest,
      launch_comparison_key: boundDescription.comparison_keys.launch,
    },
    validators: [FEATURE_DELEGATE_OUTPUT_VALIDATOR],
  };
}

function routeCapabilities(apply, critique) {
  return [...new Set([
    flowGrantIdsForDrovrCapability(apply.description.launch.capability),
    flowGrantIdsForDrovrCapability(critique.description.launch.capability),
  ].flatMap((grants) => grants ?? []))].sort();
}

function preparationLimits(rawLimits) {
  const limits = {
    max_cards: 8,
    max_revisions: 0,
    max_cards_per_revision: 0,
    max_capabilities: 1,
    max_resources: 1,
    max_elapsed_seconds: 600,
    ...(isRecord(rawLimits) ? rawLimits : {}),
  };
  if (Object.values(limits).some((value) =>
    !Number.isSafeInteger(value) || value < 0) ||
      limits.max_cards < 5 || limits.max_resources < 1) {
    throw new ProductionPreparationError(
      "invalid_limits",
      "feature preparation limits cannot admit the shipped feature graph",
    );
  }
  return limits;
}

function observeGit(repositoryPath, adapter) {
  const ref = gitRef(repositoryPath);
  const observation = adapter.observe({
    workspace_path: repositoryPath,
    ref,
  });
  if (observation?.schema !== "work.git-observation/v1" ||
      !validGit(observation.git)) {
    throw new Error("Git workspace observation is invalid");
  }
  return observation.git;
}

function gitRef(repositoryPath) {
  try {
    return execFileSync(
      "git",
      ["-C", repositoryPath, "symbolic-ref", "--quiet", "HEAD"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "HEAD";
  }
}

function canonicalRepositoryPath(path) {
  try {
    if (!statSync(path).isDirectory()) throw new Error("repository is not a directory");
    return realpathSync(path);
  } catch (error) {
    throw new ProductionPreparationError(
      "repository_missing",
      "feature preparation repository path does not exist",
      { cause: error },
    );
  }
}

function repositoryPathOf(repository) {
  const path = typeof repository === "string" ? repository : repository?.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new ProductionPreparationError(
      "repository_missing",
      "feature preparation requires an existing repository path",
    );
  }
  return path;
}

function createTimeAdapter(hostIdentity) {
  // Boot identity changes across a restart, but the wall and monotonic
  // providers remain the same host clock sources. Keep their source identity
  // stable so reboot elapsed-time revalidation can intentionally switch from
  // monotonic to wall-clock bounds at the boot boundary.
  const clockSource = "flow:host";
  return Object.freeze({
    observe() {
      return freezeCanonical([
        {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: Math.floor(Date.now() / TIME_OBSERVATION_QUANTUM_MS) *
            TIME_OBSERVATION_QUANTUM_MS,
          uncertainty_ms: TIME_OBSERVATION_UNCERTAINTY_MS,
          clock_source_id: `wall:${clockSource}`,
        },
        {
          schema: "flow.time-fact/v1",
          kind: "suspend_excluding_monotonic",
          value_ns: (
            process.hrtime.bigint() / TIME_OBSERVATION_QUANTUM_NS *
            TIME_OBSERVATION_QUANTUM_NS
          ).toString(),
          uncertainty_ns: TIME_OBSERVATION_UNCERTAINTY_NS,
          clock_source_id: `mono:${clockSource}`,
        },
        {
          schema: "flow.time-fact/v1",
          kind: "boot",
          boot_id: hostIdentity.boot_id,
        },
        {
          schema: "flow.time-fact/v1",
          kind: "clock_source",
          identity: clockSource,
        },
      ]);
    },
  });
}

function createRebootObservationAdapter(timeAdapter, resolveOperations) {
  return Object.freeze({
    observe({ prepared, currentFacts, unresolvedEffects }) {
      const facts = prepared.explicit_facts;
      return {
        catalog_fingerprint: facts.catalog_fingerprint,
        route_snapshot: facts.route_snapshot,
        capability_envelopes: facts.capability_envelopes,
        operation_contracts: facts.operation_contracts,
        validator_contracts: facts.validator_contracts,
        resource_claims: currentFacts.resource_claims,
        limits: currentFacts.limits,
        elapsed_seconds: currentFacts.elapsed_seconds,
        time_facts: timeAdapter.observe(),
        subject_generations: facts.subject_generations,
        effect_rechecks: (unresolvedEffects ?? []).map((effect) => {
          const registration = registeredOperation(
            resolveOperations?.(),
            effect.operation_contract,
          );
          const observation = observeRegisteredEffect(effect, registration);
          return {
            schema: "flow.reboot-effect-recheck/v1",
            effect_id: effect.effect_id,
            idempotency_key: effect.idempotency_key,
            classification: effect.classification,
            operation_contract: effect.operation_contract,
            recovery: effect.classification === "reconcilable"
              ? "reconcile"
              : "repeat_exact",
            observed_status: effect.classification === "reconcilable"
              ? "reconciling"
              : "unresolved",
            observation,
          };
        }),
      };
    },
  });
}

function observeRegisteredEffect(intent, registration) {
  const observe = registration?.reconcile ?? registration?.observe;
  if (typeof observe !== "function") {
    return unavailableEffectObservation(intent, "registered_observer_missing");
  }
  try {
    const observation = observe.call(registration, intent);
    if (observation !== null &&
        typeof observation === "object" &&
        typeof observation.then === "function") {
      void Promise.resolve(observation).catch(() => {});
      return unavailableEffectObservation(intent, "registered_observer_async");
    }
    const sanitized = sanitizeRegisteredEffectObservation(
      observation,
      intent,
      registration,
    );
    return validateEffectObservation(sanitized, intent) === "indeterminate"
      ? unavailableEffectObservation(intent, "registered_observation_invalid")
      : sanitized;
  } catch {
    return unavailableEffectObservation(intent, "registered_observer_failed");
  }
}

function sanitizeRegisteredEffectObservation(observation, intent, registration) {
  if (observation?.schema !== "flow.effect-observation/v1") return null;
  let providerObservation = observation.provider_observation;
  if (typeof registration?.sanitizeProviderObservation === "function") {
    try {
      providerObservation = registration.sanitizeProviderObservation(
        providerObservation,
        intent,
      );
    } catch {
      return null;
    }
  }
  providerObservation = sanitizeProviderEvidence(providerObservation, intent);
  if (!isRecord(providerObservation)) return null;
  const presence = observation.presence;
  return {
    schema: "flow.effect-observation/v1",
    effect_id: observation.effect_id,
    idempotency_key: observation.idempotency_key,
    presence,
    causation: presence === "present"
      ? {
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
        }
      : null,
    provider_observation: providerObservation,
  };
}

function unavailableEffectObservation(intent, reason) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: {
      schema: "flow.provider-observation/v1",
      status: "unavailable",
      reason,
    },
  };
}

function createWorkEvidenceAdapter() {
  return Object.freeze({
    validate() {
      return freezeCanonical({
        schema: "work.taint-disposition-validation/v1",
        valid: false,
        subject_id: null,
        taint_evidence_digest: null,
        disposition: null,
        evidence_digest: null,
      });
    },
  });
}

function validateDelegateOutput(output, context = {}) {
  if (typeof output === "string") {
    if (output.trim().length === 0) return false;
    if (context.card_id !== "feature-apply") return true;
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    return parsed?.schema === "flow.delegate-evidence/v1" &&
      validateFeatureCriterionEvidence(
        parsed.feature_evidence,
        context.delegate_input?.task_inputs?.brief?.acceptance,
      ) !== null;
  }
  if (!isRecord(output)) return false;
  try {
    digest(output);
    return true;
  } catch {
    return false;
  }
}

function validGit(git) {
  return isRecord(git) &&
    Object.keys(git).sort().join(",") === "clean,commit_sha,ref,tree_sha" &&
    /^[0-9a-f]{40,64}$/u.test(git.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git.tree_sha ?? "") &&
    typeof git.ref === "string" && git.ref.length > 0 &&
    typeof git.clean === "boolean";
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRegistrations({ defaults, overrides }) {
  const result = { ...defaults };
  if (overrides === null || overrides === undefined) return result;
  const entries = overrides instanceof Map
    ? [...overrides.entries()]
    : Object.entries(overrides);
  for (const [key, value] of entries) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}
