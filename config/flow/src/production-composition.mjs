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
import {
  createReviewDefinition,
  REVIEW_LENSES,
  REVIEW_OPERATION_CONTRACTS,
} from "../../../tools/flow/src/review-flow.mjs";
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
  materializedEvidenceDigest,
  validateFeatureCriterionEvidence,
  validateFeatureCritiqueOutput,
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
  const definitions = mergeRegistrations({
    defaults: {
      "feature/v1": createFeatureDefinition({ independentCritique: true }),
      "review/v1": createReviewDefinition(),
    },
    overrides: predefinedDefinitions,
  });

  return Object.freeze({
    authorityOptions: productionAuthorityOptions,
    definitions,
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
    publicRouteAvailability(route, request) {
      if (route?.flow === "feature" && route?.mode === "verify") {
        const required = new Set([
          FEATURE_OPERATION_CONTRACTS.capture,
          FEATURE_OPERATION_CONTRACTS.verify,
          FEATURE_OPERATION_CONTRACTS.seal,
        ]);
        const featureOperations = new Set(
          Object.values(FEATURE_OPERATION_CONTRACTS),
        );
        const selectionInputs = publicFeatureSelectionInputs(request);
        if (selectionInputs?.setup !== undefined &&
            selectionInputs.setup !== null) {
          required.add(FEATURE_OPERATION_CONTRACTS.setup);
        }
        if (Array.isArray(selectionInputs?.slices) &&
            selectionInputs.slices.some(({ mode }) => mode === "test")) {
          required.add(FEATURE_OPERATION_CONTRACTS.test);
        }
        const preparedCards = request?.prepared?.graph?.cards ??
          request?.prepared?.plan?.graph?.cards ?? [];
        const unexpected = new Set();
        for (const card of preparedCards) {
          const executor = card?.executor;
          if (executor?.kind === "operation") {
            if (typeof executor.contract !== "string" ||
                !featureOperations.has(executor.contract)) {
              unexpected.add(executor.contract ?? "operation:unknown");
              continue;
            }
            required.add(card.executor.contract);
          } else if (executor?.kind === "delegate") {
            if (executor.contract !== "flow.delegated-agent-port/v1") {
              unexpected.add(executor.contract ?? "delegate:unknown");
            }
          } else {
            unexpected.add(executor?.contract ?? `${executor?.kind ?? "missing"}:unknown`);
          }
        }
        const featureDefinition = definitions["feature/v1"];
        const contracts = [...required];
        const missing = contracts.filter((contract) => {
          const registration = registeredOperation(operations, contract);
          return registration === undefined ||
            typeof registration.invoke !== "function" ||
            registration.availability === "unavailable" ||
            registration.available === false;
        });
        return {
          available: featureDefinition?.schema === "flow.predefined-definition/v1" &&
            featureDefinition?.contract === "flow.definition/feature/v1" &&
            missing.length === 0 && unexpected.size === 0,
          source: "production_feature_operations",
          contracts,
          missing: featureDefinition?.schema !== "flow.predefined-definition/v1" ||
              featureDefinition?.contract !== "flow.definition/feature/v1"
            ? ["flow.definition/feature/v1", ...missing,
              ...[...unexpected].map((contract) => `unlisted_executor:${contract}`)]
            : [...missing,
              ...[...unexpected].map((contract) => `unlisted_executor:${contract}`)],
        };
      }
      if (route?.flow === "review" && route?.mode === "local") {
        const reviewDefinition = definitions["review/v1"];
        const prepared = request?.prepared;
        const graphCards = prepared?.graph?.cards ??
          prepared?.plan?.graph?.cards;
        const unexpected = reviewGraphAvailabilityFindings({
          prepared,
          graphCards,
        });
        const missing = [];
        if (reviewDefinition?.schema !== "flow.predefined-definition/v1" ||
            reviewDefinition?.contract !== "flow.definition/review/v1") {
          missing.push("flow.definition/review/v1");
        }
        if (delegatedAgentPort.contract !== "flow.delegated-agent-port/v1" ||
            typeof delegatedAgentPort.describe !== "function") {
          missing.push("flow.delegated-agent-port/v1");
        }
        return {
          available: missing.length === 0 && unexpected.length === 0,
          source: "trusted_review_authority",
          contracts: [
            "flow.definition/review/v1",
            REVIEW_OPERATION_CONTRACTS.record,
            "flow.delegated-agent-port/v1",
          ],
          missing: [...missing, ...unexpected],
        };
      }
      return {
        available: false,
        source: "production_composition",
        contracts: [],
        missing: ["unlisted_public_route"],
      };
    },
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
        runAuthority: boundAuthority,
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

function reviewGraphAvailabilityFindings({ prepared, graphCards }) {
  if (prepared === undefined) return [];
  if (!Array.isArray(graphCards)) return ["review_graph_missing"];
  const lenses = prepared.selection?.inputs?.lenses;
  if (!Array.isArray(lenses) || lenses.length === 0 ||
      new Set(lenses).size !== lenses.length ||
      lenses.some((lens) => !REVIEW_LENSES.includes(lens))) {
    return ["review_selection_lenses_invalid"];
  }
  const expectedIds = new Set([
    "review-critic",
    "review-record",
    ...lenses.map((lens) => `review-lens-${lens}`),
  ]);
  const unexpected = new Set();
  const seen = new Set();
  for (const card of graphCards) {
    const id = card?.id;
    if (typeof id !== "string" || !expectedIds.has(id) || seen.has(id)) {
      unexpected.add(`unlisted_executor:${id ?? "card:unknown"}`);
      continue;
    }
    seen.add(id);
    const executor = card?.executor;
    const isRecordOperation = id === "review-record" &&
      executor?.kind === "operation" &&
      executor?.contract === REVIEW_OPERATION_CONTRACTS.record;
    const isReviewDelegate = id !== "review-record" &&
      executor?.kind === "delegate" &&
      executor?.contract === "flow.delegated-agent-port/v1";
    if (!isRecordOperation && !isReviewDelegate) {
      unexpected.add(`unlisted_executor:${executor?.contract ?? id}`);
    }
  }
  if (seen.size !== expectedIds.size) unexpected.add("review_graph_incomplete");
  return [...unexpected];
}

export class ProductionPreparationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProductionPreparationError";
    this.code = code;
    if (options.compatibility !== undefined) {
      this.compatibility = freezeCanonical(options.compatibility);
    }
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
  runAuthority = null,
}) {
  if (!isFeaturePreparationRequest(request)) {
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
  let liveWorkspace = currentWorkspaceProjection(
    runAuthority,
    workspaceSubjectId,
  );
  if (liveWorkspace !== null) {
    if (liveWorkspace.workspace?.canonical_path !== repositoryPath ||
        liveWorkspace.repository?.canonical_id !== repositoryId) {
      throw new ProductionPreparationError(
        "workspace_authority_conflict",
        "WorkspaceAuthority subject does not match the repository",
      );
    }
    if (liveWorkspace.disposition === "cleaned") {
      throw new ProductionPreparationError(
        "workspace_unavailable",
        "WorkspaceAuthority subject has been cleaned",
      );
    }
    if (!sameCanonicalValue(liveWorkspace.git, git)) {
      if (liveWorkspace.claims.length > 0) {
        throw new ProductionPreparationError(
          "workspace_already_claimed",
          "WorkspaceAuthority is claimed while repository Git facts changed",
        );
      }
      if (liveWorkspace.taint !== null) {
        throw new ProductionPreparationError(
          "workspace_tainted",
          "WorkspaceAuthority is tainted while repository Git facts changed",
        );
      }
      liveWorkspace = reobserveWorkspaceFacts({
        runAuthority,
        workspace: liveWorkspace,
        git,
        subjectId: workspaceSubjectId,
      });
    }
  }
  const workspaceGeneration = liveWorkspace?.generation ?? 1;
  const workspaceMutationEpoch = liveWorkspace?.mutation_epoch ?? 1;
  const workspace = freezeCanonical({
    schema: WORKSPACE_SCHEMA,
    subject_id: workspaceSubjectId,
    generation: workspaceGeneration,
    mutation_epoch: workspaceMutationEpoch,
    fingerprint: digest({ git }),
    git,
  });
  workspaceRepositories.set(workspaceSubjectId, {
    repository_id: repositoryId,
    path: repositoryPath,
    ref: git.ref,
  });

  const mode = request.mode;
  const routes = request.routes;
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

function currentWorkspaceProjection(runAuthority, subjectId) {
  if (runAuthority === null || typeof runAuthority !== "object") return null;
  let authority;
  try {
    authority = getWorkspaceAuthority({ runAuthority });
  } catch {
    return null;
  }
  let projection;
  try {
    projection = authority.query({
      contract: "work.workspace/v1",
      subject_id: subjectId,
    });
  } catch (error) {
    throw new ProductionPreparationError(
      "workspace_authority_unavailable",
      "WorkspaceAuthority could not provide the live workspace subject",
      { cause: error },
    );
  }
  if (projection?.schema === "work.rejection/v1" &&
      projection.code === "unknown_subject") return null;
  if (projection?.schema !== "work.workspace-projection/v1") {
    throw new ProductionPreparationError(
      "workspace_authority_unavailable",
      "WorkspaceAuthority returned an invalid workspace subject",
    );
  }
  return projection;
}

function reobserveWorkspaceFacts({
  runAuthority,
  workspace,
  git,
  subjectId,
}) {
  let authority;
  try {
    authority = getWorkspaceAuthority({ runAuthority });
  } catch (error) {
    throw new ProductionPreparationError(
      "workspace_authority_unavailable",
      "WorkspaceAuthority could not record the current Git facts",
      { cause: error },
    );
  }
  const command = {
    schema: "work.workspace-observation-command/v1",
    command_id: `workspace-observe:${subjectId}:${digest({ git })}`,
    type: "workspace_observe",
    contract: "work.workspace/v1",
    subject_id: subjectId,
    expected_watermark: workspace.watermark,
    expected_generation: workspace.generation,
    expected_mutation_epoch: workspace.mutation_epoch,
    expected_fingerprint: digest({ git: workspace.git }),
    git_observation: {
      schema: "work.git-observation/v1",
      git,
    },
  };
  const receipt = authority.command(command);
  if (receipt?.accepted !== true) {
    throw new ProductionPreparationError(
      receipt?.code ?? "workspace_observation_rejected",
      "WorkspaceAuthority rejected the current Git-facts observation",
    );
  }
  const refreshed = authority.query({
    contract: "work.workspace/v1",
    subject_id: subjectId,
  });
  if (refreshed?.schema !== "work.workspace-projection/v1" ||
      !sameCanonicalValue(refreshed.git, git) ||
      refreshed.generation !== workspace.generation + 1 ||
      refreshed.mutation_epoch !== workspace.mutation_epoch + 1 ||
      refreshed.claims.length !== 0 || refreshed.taint !== null) {
    throw new ProductionPreparationError(
      "workspace_observation_unavailable",
      "WorkspaceAuthority did not durably record the current Git facts",
    );
  }
  return refreshed;
}

function sameCanonicalValue(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function featureOperationRegistrations(productionOperations) {
  const unavailable = (extra = {}) => ({
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    availability: "unavailable",
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

function publicFeatureSelectionInputs(request) {
  const preparedInputs = request?.prepared?.selection?.inputs;
  if (preparedInputs !== null && typeof preparedInputs === "object" &&
      !Array.isArray(preparedInputs)) return preparedInputs;
  const selectionInputs = request?.selection?.inputs;
  if (selectionInputs !== null && typeof selectionInputs === "object" &&
      !Array.isArray(selectionInputs)) return selectionInputs;
  return request;
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
    schema: "flow.delegated-agent-description-request/v1",
    launch: { ...launch, capability: launch.capability ?? capability },
    caller_metadata: {
      flow: "feature/v1",
      role,
    },
  };
  const projection = await delegatedAgentPort.describe(request);
  const description = projection?.description;
  if (projection?.status !== "compatible" || !isRecord(description)) {
    const compatibility = isRecord(projection?.compatibility)
      ? projection.compatibility
      : {};
    const code = typeof compatibility.code === "string" &&
      compatibility.code.length > 0
      ? compatibility.code
      : "drovr_incompatible";
    throw new ProductionPreparationError(
      code,
      `Drovr ${role} route is unavailable or incompatible`,
      {
        compatibility: {
          code,
          findings: normalizeCompatibilityFindings(compatibility.findings),
          legal_actions: Array.isArray(projection?.legal_next_actions)
            ? projection.legal_next_actions
            : [],
        },
      },
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
      "incompatible_feature_advertisement",
      `Drovr ${role} route does not satisfy the shipped feature contract`,
      {
        compatibility: {
          code: "incompatible_feature_advertisement",
          findings: normalizeCompatibilityFindings(
            findings.length > 0
              ? findings
              : [{ field: "description", reason: "contradictory" }],
          ),
          legal_actions: Array.isArray(projection.legal_next_actions)
            ? projection.legal_next_actions
            : [],
        },
      },
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

function normalizeCompatibilityFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding) => {
    if (!isRecord(finding) || typeof finding.reason !== "string" ||
        finding.reason.length === 0) return [];
    if (typeof finding.field === "string" && finding.field.length > 0) {
      return [{ field: finding.field, reason: finding.reason }];
    }
    const featureId = typeof finding.feature_id === "string" &&
      finding.feature_id.length > 0
      ? finding.feature_id
      : "unknown";
    return [{
      field: `feature_advertisement.${featureId}`,
      reason: finding.reason,
    }];
  });
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

function isFeaturePreparationRequest(request) {
  if (!exactObject(request, [
    "schema",
    "brief",
    "repository",
    "mode",
    "routes",
    "verification",
    "limits",
  ], ["schema", "brief", "repository", "mode", "routes"])) {
    return false;
  }
  return request.schema === PREPARATION_SCHEMA &&
    validPreparationBrief(request.brief) &&
    validPreparationRepository(request.repository) &&
    request.mode === "verify" &&
    validPreparationRoutes(request.routes) &&
    (request.verification === undefined ||
      validPreparationVerification(request.verification)) &&
    (request.limits === undefined || validPreparationLimitsShape(request.limits));
}

function validPreparationBrief(brief) {
  return exactObject(brief, ["schema", "id", "summary", "acceptance"], [
    "schema",
    "id",
    "summary",
    "acceptance",
  ]) && brief.schema === BRIEF_SCHEMA &&
    nonEmptyString(brief.id) && nonEmptyString(brief.summary) &&
    Array.isArray(brief.acceptance) && brief.acceptance.length > 0 &&
    brief.acceptance.every(nonEmptyString);
}

function validPreparationRepository(repository) {
  if (nonEmptyString(repository)) return true;
  return exactObject(repository, ["path"], ["path"]) &&
    nonEmptyString(repository.path);
}

function validPreparationRoutes(routes) {
  return exactObject(routes, ["apply", "critique"], ["apply", "critique"]) &&
    validPreparationRoute(routes.apply) &&
    validPreparationRoute(routes.critique);
}

function validPreparationRoute(route) {
  if (!isRecord(route)) return false;
  if (Object.hasOwn(route, "launch")) {
    return exactObject(route, ["launch"], ["launch"]) &&
      validPreparationLaunch(route.launch);
  }
  return validPreparationLaunch(route);
}

function validPreparationLaunch(launch) {
  const allowed = ["harness", "role", "model", "effort", "capability"];
  if (!exactObject(launch, allowed)) return false;
  return (launch.harness === undefined || ["claude", "codex"].includes(launch.harness)) &&
    (launch.role === undefined || nonEmptyString(launch.role)) &&
    (launch.model === undefined || nonEmptyString(launch.model)) &&
    (launch.effort === undefined || ["low", "medium", "high", "xhigh"].includes(launch.effort)) &&
    (launch.capability === undefined || [
      "read-only",
      "on-approve",
      "workspace-write",
      "auto",
      "unrestricted",
    ].includes(launch.capability));
}

function validPreparationVerification(verification) {
  if (!exactObject(verification, ["baseline"])) return false;
  if (verification.baseline === undefined) return true;
  return exactObject(verification.baseline, ["assertion"]) &&
    (verification.baseline.assertion === undefined ||
      nonEmptyString(verification.baseline.assertion));
}

function validPreparationLimitsShape(limits) {
  if (!exactObject(limits, [
    "max_cards",
    "max_revisions",
    "max_cards_per_revision",
    "max_capabilities",
    "max_resources",
    "max_elapsed_seconds",
  ])) return false;
  return Object.values(limits).every((value) =>
    Number.isSafeInteger(value) && value >= 0);
}

function exactObject(value, allowed, required = []) {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
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
    if (![
      "feature-apply",
      "feature-critique",
    ].includes(context.card_id)) return true;
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (parsed?.schema !== "flow.delegate-evidence/v1") return false;
    const expectedCriteria = context.delegate_input?.task_inputs?.brief?.acceptance;
    if (context.card_id === "feature-apply") {
      return validateFeatureCriterionEvidence(
        parsed.feature_evidence,
        expectedCriteria,
      ) !== null;
    }
    const candidate = context.delegate_input?.authority_materialized_candidate;
    const predecessorEvidence = context.authority_materialized_evidence ??
      context.delegate_input?.authority_materialized_evidence;
    return validateFeatureCritiqueOutput(output, {
      taskInputs: context.delegate_input?.task_inputs,
      expectedCriteria,
      candidateDigest: isRecord(candidate) ? digest(candidate) : undefined,
      predecessorEvidenceDigest: materializedEvidenceDigest(predecessorEvidence),
      requireAuthorityBinding: true,
    }) !== null;
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
