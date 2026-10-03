import { isDirectDescription, directDescriptionIssue } from "../../../tools/flow/src/execution-contract.mjs";
import { FEATURE_DIRECT_COMMIT_CONTRACT } from "../../../tools/flow/src/feature-flow.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  reviewCandidateProjectionIssue,
  REVIEW_OPERATION_CONTRACTS,
} from "../../../tools/flow/src/review-flow.mjs";
import {
  createAuthorityFact,
  SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
  prepareAuthorityBindings,
  snapshotRegisteredAuthorities,
} from "../../../tools/flow/src/authority-bindings.mjs";
import { createRejection } from "../../../tools/flow/src/rejection.mjs";
import { loadContractCatalog } from "../../../tools/flow/src/contract-catalog.mjs";
import {
  deriveReviewPreparationFacts,
  reviewExplicitFactsFromPreparationFacts,
  reviewOwnerProjectionDigest,
  workspaceRecoveryActions,
} from "../../../tools/flow/src/review-preparation-facts.mjs";
import { createHostAuthorityIdentityAdapter } from "../../../tools/flow/src/host-authority-identity.mjs";
import { createTopLevelRunOwnershipAdapter } from "../../../tools/flow/src/run-authority.mjs";
import {
  getReviewAuthority,
  getWorkspaceAuthority,
} from "../../../tools/flow/src/work-authority.mjs";
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
import {
  createProductionBackupRestoreAdapter,
} from "./production-backup-restore.mjs";

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
  env = process.env,
  authorityDirectory = undefined,
  legacyRoots = {},
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
  registerConfiguredRepositoryRoot(repositories, env.FLOW_REPOSITORY_ROOT);
  let boundAuthority = null;
  const reviewPreparationAuthorityRef = { current: null };

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
  const backupRestoreAdapter = authorityOptions.backupRestoreAdapter ??
    configuredBackupRestoreAdapter({
      env,
      authorityDirectory,
      authorityOptions,
      legacyRoots,
    });
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
    backupRestoreAdapter,
  };
  const featureOperations = createProductionFeatureOperations({
    resolveWorkspace: resolveProductionWorkspace,
    gitWorkspaceObservationAdapter,
    gitRetentionAdapter,
    authorityDirectory,
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
  const authorities = mergeRegistrations({
    defaults: authorityRegistrations(),
    overrides: registeredAuthorities,
  });
  const reviewPreparationProvider = createReviewPreparationProvider({
    authorities,
    delegatedAgentPort,
    timeObservationAdapter,
    runAuthority: () => reviewPreparationAuthorityRef.current,
    authorityOptions,
    env,
  });

  return Object.freeze({
    authorityOptions: productionAuthorityOptions,
    definitions,
    operations,
    authorities,
    reviewPreparationProvider,
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
          [...Object.values(FEATURE_OPERATION_CONTRACTS), FEATURE_DIRECT_COMMIT_CONTRACT],
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
      reviewPreparationAuthorityRef.current = authority;
      featureOperations.bindAuthority(authority);
    },
    resolveDelegatedWorkspaceClaim(claim, request = {}) {
      return resolveDelegatedWorkspaceClaim({
        claim,
        request,
        resolveWorkspace: resolveProductionWorkspace,
        runAuthority: boundAuthority,
      });
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

function registerConfiguredRepositoryRoot(repositories, repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.startsWith("/")) {
    return;
  }
  try {
    const repositoryPath = canonicalRepositoryPath(repositoryRoot);
    const repositoryId = `repository:${digest(repositoryPath).slice("sha256:".length)}`;
    repositories.set(repositoryId, repositoryPath);
  } catch {
    // Feature preparation reports the precise repository error when the path
    // is selected. A stale ambient path must not make unrelated queries fail
    // during composition construction.
  }
}

function createReviewPreparationProvider({
  authorities,
  delegatedAgentPort,
  timeObservationAdapter,
  runAuthority: readRunAuthority,
  authorityOptions,
  env,
}) {
  const ownerAdapter = authorityOptions.reviewPreparationFactsAdapter ?? null;
  const routeAdapter = authorityOptions.reviewRouteObservationAdapter ?? null;
  const catalogAdapter = authorityOptions.contractCatalogAdapter ?? null;

  return Object.freeze({
    async derive(request) {
      return deriveProductionReviewFacts({
        request,
        readRunAuthority,
        authorities,
        timeObservationAdapter,
        ownerAdapter,
        routeAdapter,
        catalogAdapter,
        delegatedAgentPort,
        env,
        allowAsync: true,
      });
    },
    revalidate({ facts, prepared, inputs }) {
      const request = {
        ...(inputs ?? prepared?.selection?.inputs ?? {}),
        candidate_id: facts?.candidate?.candidate_id,
        candidate_fingerprint: facts?.candidate?.candidate_fingerprint,
      };
      const result = deriveProductionReviewFacts({
        request,
        readRunAuthority,
        authorities,
        timeObservationAdapter,
        ownerAdapter,
        routeAdapter,
        catalogAdapter,
        delegatedAgentPort,
        env,
        allowAsync: false,
      });
      if (isPromiseLike(result)) {
        return result.then((fresh) => compareReviewPreparationFacts(
          facts,
          fresh,
        ));
      }
      return compareReviewPreparationFacts(facts, result);
    },
    materialize({ facts, proposal }) {
      return reviewExplicitFactsFromPreparationFacts(facts, {
        limits: proposal?.inputs?.limits,
      });
    },
  });
}

function compareReviewPreparationFacts(previous, result) {
  if (result?.accepted !== true) return result;
  const fresh = result.facts;
  if (sameCanonicalValue(previous.candidate, fresh.candidate) === false) {
    return ownerRevalidationRejection(fresh, "review", "candidate_changed", "candidate authority facts changed");
  }
  if (sameCanonicalValue(previous.source_run, fresh.source_run) === false) {
    return ownerRevalidationRejection(fresh, "run", "source_run_changed", "source run authority facts changed");
  }
  if (sameCanonicalValue(previous.workspace, fresh.workspace) === false) {
    return ownerRevalidationRejection(fresh, "workspace", "workspace_changed", "workspace authority facts changed");
  }
  for (const owner of ["run", "review", "workspace"]) {
    if (sameCanonicalValue(
      previous.owner_authorities?.[owner],
      fresh.owner_authorities?.[owner],
    ) === false) {
      return ownerRevalidationRejection(
        fresh,
        owner,
        `${owner}_authority_changed`,
        `${owner} authority facts changed`,
      );
    }
  }
  if (sameCanonicalValue(previous.route, fresh.route) === false) {
    return ownerRevalidationRejection(fresh, "review", "route_changed", "route authority facts changed");
  }
  if (sameCanonicalValue(previous.catalog, fresh.catalog) === false) {
    return ownerRevalidationRejection(fresh, "review", "catalog_changed", "contract catalog facts changed");
  }
  if (sameCanonicalValue(previous.operation, fresh.operation) === false) {
    return ownerRevalidationRejection(fresh, "run", "operation_changed", "operation authority facts changed");
  }
  if (sameCanonicalValue(previous.validator, fresh.validator) === false) {
    return ownerRevalidationRejection(fresh, "run", "validator_changed", "validator authority facts changed");
  }
  if (!compatibleReviewTimeFacts(previous.time_facts, fresh.time_facts)) {
    return ownerRevalidationRejection(fresh, "run", "time_changed", "time authority facts changed");
  }
  if (sameCanonicalValue(previous.authority_facts, fresh.authority_facts) === false ||
      !sameNonTimeWatermarks(previous.authority_watermarks, fresh.authority_watermarks)) {
    return ownerRevalidationRejection(fresh, "run", "authority_changed", "required authority facts changed");
  }
  // The current time observation is intentionally fresh and therefore may
  // advance between preparation and launch. All other facts remain bound to
  // the prepared envelope; the caller keeps that immutable envelope.
  return { accepted: true, facts: previous };
}

function ownerRevalidationRejection(facts, owner, code, reason) {
  const authorityFact = facts?.owner_authorities?.[owner];
  return {
    accepted: false,
    issue: {
      code,
      reason,
      authority_watermark: authorityFact?.watermark ?? null,
      authority_watermark_domain: authorityFact?.watermark_domain ?? "host",
      legal_actions: authorityFact?.legal_actions ?? [],
      authority_fact: authorityFact,
    },
  };
}

function compatibleReviewTimeFacts(previous, fresh) {
  const previousByKind = new Map((previous ?? []).map((fact) => [fact.kind, fact]));
  const freshByKind = new Map((fresh ?? []).map((fact) => [fact.kind, fact]));
  if (previousByKind.size !== freshByKind.size ||
      [...previousByKind.keys()].some((kind) => !freshByKind.has(kind))) {
    return false;
  }
  const previousWall = previousByKind.get("wall_clock");
  const freshWall = freshByKind.get("wall_clock");
  const previousMonotonic = previousByKind.get("suspend_excluding_monotonic");
  const freshMonotonic = freshByKind.get("suspend_excluding_monotonic");
  if (previousWall !== undefined && (
      freshWall.clock_source_id !== previousWall.clock_source_id ||
      freshWall.value_ms < previousWall.value_ms)) return false;
  if (previousMonotonic !== undefined) {
    try {
      if (freshMonotonic.clock_source_id !== previousMonotonic.clock_source_id ||
          BigInt(freshMonotonic.value_ns) < BigInt(previousMonotonic.value_ns)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  for (const kind of ["boot", "clock_source"]) {
    if (!sameCanonicalValue(previousByKind.get(kind), freshByKind.get(kind))) {
      return false;
    }
  }
  return true;
}

function sameNonTimeWatermarks(previous, fresh) {
  if (!isRecord(previous) || !isRecord(fresh)) return false;
  const withoutTime = (value) => {
    const { time: _time, ...rest } = value;
    return rest;
  };
  return sameCanonicalValue(withoutTime(previous), withoutTime(fresh));
}

async function deriveProductionReviewFacts({
  request,
  readRunAuthority,
  authorities,
  timeObservationAdapter,
  ownerAdapter,
  routeAdapter,
  catalogAdapter,
  delegatedAgentPort,
  env,
  allowAsync,
}) {
  const runAuthority = readRunAuthority?.();
  if (runAuthority === null || runAuthority === undefined) {
    return rejectedReviewPreparation("authority_unavailable",
      "RunAuthority is not bound to the production composition");
  }
  let productionCatalog;
  try {
    productionCatalog = await readProductionCatalog(env);
  } catch (error) {
    return rejectedReviewPreparation(
      "catalog_changed",
      "the canonical production contract catalog is unavailable or invalid",
      error,
    );
  }
  let owner;
  try {
    owner = await readReviewPreparationOwners({
      request,
      runAuthority,
      productionCatalog,
      ownerAdapter,
      routeAdapter,
      catalogAdapter,
      timeObservationAdapter,
      authorities,
      delegatedAgentPort,
      allowAsync,
    });
  } catch (error) {
    return rejectedReviewPreparation(
      error?.code ?? "authority_unavailable",
      error?.message ?? "review preparation authority is unavailable",
      error,
    );
  }
  if (owner?.accepted === false) return owner;
  const derived = deriveReviewPreparationFacts(owner);
  return derived;
}

function readReviewPreparationOwners({
  request,
  runAuthority,
  productionCatalog,
  ownerAdapter,
  routeAdapter,
  catalogAdapter,
  timeObservationAdapter,
  authorities,
  delegatedAgentPort,
  allowAsync,
}) {
  const candidateId = reviewPreparationCandidateId(request);
  if (candidateId === null) {
    return rejectedReviewPreparation(
      "candidate_missing",
      "review preparation requires one candidate reference",
    );
  }
  const requestedFingerprint = reviewPreparationCandidateFingerprint(request);
  if (requestedFingerprint === null) {
    return rejectedReviewPreparation(
      "candidate_fingerprint_missing",
      "review preparation requires the exact candidate fingerprint",
    );
  }
  let reviewAuthority;
  let workspaceAuthority;
  try {
    reviewAuthority = getReviewAuthority({ runAuthority });
    workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  } catch (error) {
    return rejectedReviewPreparation(
      "authority_unavailable",
      "ReviewAuthority and WorkspaceAuthority are unavailable",
      error,
    );
  }
  const candidateProjection = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: candidateId,
  });
  const candidateRejection = authorityReadRejection(candidateProjection);
  if (candidateRejection !== null) {
    return rejectedReviewPreparationFromAuthority(candidateRejection, {
      owner: "review",
      providerIdentity: productionCatalog.providerIdentities.review,
    });
  }
  const candidateOutcome = reviewCandidatePreparationOutcome({
    candidateProjection,
    candidateId,
    requestedFingerprint,
    providerIdentity: productionCatalog.providerIdentities.review,
  });
  if (candidateOutcome !== null) {
    return rejectedReviewPreparationFromAuthority(candidateOutcome, {
      owner: "review",
      providerIdentity: productionCatalog.providerIdentities.review,
    });
  }
  const candidateReference = candidateProjection?.candidate;
  const candidateFingerprint = candidateProjection?.candidate_fingerprint ??
    candidateReference?.candidate_fingerprint ?? null;
  if (candidateFingerprint !== requestedFingerprint) {
    return rejectedReviewPreparation(
      "candidate_fingerprint_mismatch",
      "review preparation candidate fingerprint does not match ReviewAuthority",
      ownerAuthorityError({
        owner: "review",
        projection: candidateProjection,
        providerIdentity: productionCatalog.providerIdentities.review,
      }),
    );
  }
  const reference = {
    candidate_id: candidateId,
    candidate_fingerprint: candidateFingerprint,
  };
  const sourceRunProjection = typeof runAuthority.queryByReviewCandidateReference ===
      "function"
    ? runAuthority.queryByReviewCandidateReference(reference)
    : rejectedReviewPreparation(
      "source_run_unavailable",
      "RunAuthority cannot resolve retained source runs by candidate reference",
      ownerAuthorityError({
        owner: "run",
        projection: runAuthority.query?.(),
        providerIdentity: productionCatalog.providerIdentities.run,
      }),
    );
  const sourceRunRejection = authorityReadRejection(sourceRunProjection);
  if (sourceRunRejection !== null) {
    return rejectedReviewPreparationFromAuthority(sourceRunRejection, {
      owner: "run",
      providerIdentity: productionCatalog.providerIdentities.run,
    });
  }
  const workspaceId = candidateReference?.workspace?.subject_id;
  const workspaceProjection = workspaceId === undefined
    ? null
    : workspaceAuthority.query({
        contract: "work.workspace/v1",
        subject_id: workspaceId,
      });
  const workspaceRejection = authorityReadRejection(workspaceProjection);
  if (workspaceRejection !== null) {
    return rejectedReviewPreparationFromAuthority(workspaceRejection, {
      owner: "workspace",
      providerIdentity: productionCatalog.providerIdentities.workspace,
    });
  }
  if (!isRecord(workspaceProjection) ||
      workspaceProjection.schema !== "work.workspace-projection/v1") {
    return rejectedReviewPreparation(
      "workspace_missing",
      "WorkspaceAuthority has no exact workspace projection for this candidate",
      ownerAuthorityError({
        owner: "workspace",
        projection: workspaceProjection,
        subjectId: workspaceId,
        providerIdentity: productionCatalog.providerIdentities.workspace,
      }),
    );
  }
  const normalizedWorkspaceProjection = workspaceProjectionForFacts(
    workspaceProjection,
    productionCatalog.providerIdentities.workspace,
  );
  const base = {
    request,
    runAuthority,
    candidateProjection,
    sourceRunProjection,
    workspaceProjection: normalizedWorkspaceProjection,
    ownerAuthorities: ownerAuthoritiesForProjections({
      candidateProjection,
      sourceRunProjection,
      workspaceProjection: normalizedWorkspaceProjection,
      providerIdentities: productionCatalog.providerIdentities,
    }),
    productionCatalog,
  };
  const observed = callOwnerObservation({
    ownerAdapter,
    routeAdapter,
    catalogAdapter,
    base,
    delegatedAgentPort,
    allowAsync,
  });
  if (isPromiseLike(observed)) {
    return observed.then((value) => completeReviewPreparationOwners({
      ...base,
      ...(value ?? {}),
    }, {
      authorities,
      timeObservationAdapter,
      productionCatalog,
    }));
  }
  return completeReviewPreparationOwners({
    ...base,
    ...(observed ?? {}),
  }, {
    authorities,
    timeObservationAdapter,
    productionCatalog,
  });
}

function completeReviewPreparationOwners(
  base,
  { authorities, timeObservationAdapter, productionCatalog },
) {
  if (base?.accepted === false) return base;
  if (base?.routeSnapshot?.accepted === false) return base.routeSnapshot;
  const routeSnapshot = normalizeReviewRouteSnapshot(
    base.routeSnapshot ?? base.route_snapshot ?? null,
    base.routeBindings ?? base.route_bindings,
  );
  if (routeSnapshot === null) {
    return rejectedReviewPreparation(
      "route_changed",
      "RouteAuthority cannot provide the exact review route snapshot",
    );
  }
  const operationContracts = [
    REVIEW_OPERATION_CONTRACTS.record,
  ];
  const validatorContracts = [
    "flow.validator/operation-receipt/v1",
    "flow.validator/review-result/v1",
  ];
  const workspace = base.workspaceProjection;
  const resourceClaims = workspace === null ? [] : [{
    kind: "workspace",
    id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
  }];
  const subjectGenerations = workspace === null ? [] : [{
    schema: "flow.subject-generation/v1",
    contract: "work.workspace/v1",
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    fingerprint: workspace.fingerprint,
  }];
  const timeFacts = timeObservationAdapter.observe();
  const catalog = productionCatalog.identity;
  if (base.catalog !== undefined &&
      !sameCanonicalValue(base.catalog, catalog)) {
    return rejectedReviewPreparation(
      "catalog_changed",
      "observed catalog identity does not match the strictly loaded production catalog",
      ownerAuthorityError({
        owner: "review",
        projection: base.candidateProjection,
        providerIdentity: productionCatalog.providerIdentities.review,
      }),
    );
  }
  const ownerFacts = {
    route_snapshot: routeSnapshot,
    resource_claims: resourceClaims,
    contract_facts: {
      operation_contracts: operationContracts,
      validator_contracts: validatorContracts,
    },
    subject_generations: subjectGenerations,
  };
  let authorityBindings;
  try {
    authorityBindings = prepareAuthorityBindings(
      SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
      authorities instanceof Map
        ? authorities
        : snapshotRegisteredAuthorities(authorities),
      {
        phase: "review_preparation",
        ownerFacts,
        candidateProjection: base.candidateProjection,
        sourceRunProjection: base.sourceRunProjection,
        workspaceProjection: base.workspaceProjection,
      },
    );
  } catch (error) {
    return rejectedReviewPreparation(
      error?.code ?? "authority_unavailable",
      error?.reason ?? "required authority observations are unavailable",
      error,
    );
  }
  return {
    candidateProjection: base.candidateProjection,
    sourceRunProjection: base.sourceRunProjection,
    workspaceProjection: base.workspaceProjection,
    authorityBindings,
    routeSnapshot,
    catalog,
    operationContracts,
    validatorContracts,
    timeFacts,
    ownerAuthorities: base.ownerAuthorities,
  };
}

function callOwnerObservation({
  ownerAdapter,
  routeAdapter,
  catalogAdapter,
  base,
  delegatedAgentPort,
  allowAsync,
}) {
  const observer = ownerAdapter?.observe ?? routeAdapter?.observe;
  const catalogObserver = catalogAdapter?.observe;
  const context = Object.freeze({
    request: base.request,
    candidateProjection: base.candidateProjection,
    sourceRunProjection: base.sourceRunProjection,
    workspaceProjection: base.workspaceProjection,
    runAuthority: base.runAuthority,
    delegatedAgentPort,
  });
  let observed = {};
  if (typeof observer === "function") {
    observed = observer.call(ownerAdapter?.observe ? ownerAdapter : routeAdapter, context);
  } else {
    observed = observeDefaultReviewRoutes({
      request: base.request,
      workspacePath: base.workspaceProjection.workspace?.canonical_path,
      delegatedAgentPort,
      allowAsync,
    });
  }
  if (isPromiseLike(observed)) {
    return observed.then((value) => mergeOwnerObservations(value, catalogObserver, context));
  }
  return mergeOwnerObservations(observed, catalogObserver, context);
}

function mergeOwnerObservations(observed, catalogObserver, context) {
  const rawValue = observed?.facts === undefined ? observed : observed.facts;
  if (observed?.accepted === false) return observed;
  const value = isRecord(rawValue)
    ? {
        ...(Object.hasOwn(rawValue, "routeSnapshot")
          ? { routeSnapshot: rawValue.routeSnapshot }
          : {}),
        ...(Object.hasOwn(rawValue, "route_snapshot")
          ? { route_snapshot: rawValue.route_snapshot }
          : {}),
        ...(Object.hasOwn(rawValue, "routeBindings")
          ? { routeBindings: rawValue.routeBindings }
          : {}),
        ...(Object.hasOwn(rawValue, "route_bindings")
          ? { route_bindings: rawValue.route_bindings }
          : {}),
      }
    : {};
  if (typeof catalogObserver !== "function") return value;
  const catalog = catalogObserver.call(context, context);
  if (isPromiseLike(catalog)) {
    return catalog.then((result) => ({ ...(value ?? {}), catalog: result }));
  }
  return { ...(value ?? {}), catalog };
}

function workspaceProjectionForFacts(projection, providerIdentity) {
  if (!isRecord(projection) ||
      projection.schema !== "work.workspace-projection/v1") return projection;
  const git = projection.git;
  let fingerprint = null;
  try {
    fingerprint = digest({ git });
  } catch {
    fingerprint = null;
  }
  const projectionDigest = reviewOwnerProjectionDigest("workspace", projection);
  const tainted = projection.taint !== null && projection.taint !== undefined;
  const ownerFact = createAuthorityFact({
    authorityId: "WorkspaceAuthority",
    authorityContract: "work.workspace/v1",
    providerIdentity,
    watermark: projection.watermark ?? null,
    watermarkDomain: "workspace",
    subjectId: projection.subject_id ?? null,
    disposition: projection.disposition ?? null,
    generation: projection.generation ?? null,
    facts: {
      fingerprint,
      git_commit_sha: git?.commit_sha ?? null,
      git_tree_sha: git?.tree_sha ?? null,
      git_ref: git?.ref ?? null,
      git_clean: git?.clean === true,
      mutation_epoch: projection.mutation_epoch ?? null,
      taint_status: tainted ? "tainted" : "clear",
      claims_digest: digest(projection.claims ?? []),
      projection_digest: projectionDigest,
    },
    legalActions: projection.legal_actions ?? [],
  });
  return {
    ...projection,
    disposition: projection.disposition ?? null,
    fingerprint,
    clean: git?.clean === true,
    dirty: git?.clean !== true,
    tainted,
    authority_fact: ownerFact,
    owner_projection_digest: projectionDigest,
    legal_actions: projection.legal_actions ?? [],
  };
}

function ownerAuthoritiesForProjections({
  candidateProjection,
  sourceRunProjection,
  workspaceProjection,
  providerIdentities,
}) {
  const candidate = candidateProjection.candidate;
  const workspace = candidate.workspace;
  const runProjectionDigest = reviewOwnerProjectionDigest(
    "run",
    sourceRunProjection,
  );
  const reviewProjectionDigest = digest(candidateProjection);
  const run = createAuthorityFact({
    authorityId: "RunAuthority",
    authorityContract: "flow.run-projection/v1",
    providerIdentity: providerIdentities.run,
    watermark: sourceRunProjection.watermark,
    watermarkDomain: "run",
    subjectId: sourceRunProjection.run_id,
    disposition: sourceRunProjection.phase,
    generation: sourceRunProjection.stream_generation ?? sourceRunProjection.sequence ?? 0,
    facts: {
      run_id: sourceRunProjection.run_id,
      phase: sourceRunProjection.phase,
      candidate_id: sourceRunProjection.review_candidate_reference.candidate_id,
      candidate_fingerprint: sourceRunProjection.review_candidate_reference.candidate_fingerprint,
      sequence: sourceRunProjection.sequence ?? null,
      current_revision: {
        ordinal: sourceRunProjection.current_revision?.ordinal ?? null,
        plan_fingerprint: sourceRunProjection.current_revision?.plan_fingerprint ?? null,
      },
      bundle_digest: sourceRunProjection.bundle_digest ?? null,
      projection_digest: runProjectionDigest,
    },
    legalActions: sourceRunProjection.legal_actions ?? [],
  });
  const review = createAuthorityFact({
    authorityId: "ReviewAuthority",
    authorityContract: "work.review/v1",
    providerIdentity: providerIdentities.review,
    watermark: candidateProjection.watermark,
    watermarkDomain: "review",
    subjectId: candidateProjection.subject_id,
    disposition: candidateProjection.status,
    generation: candidateProjection.generation,
    facts: {
      candidate_fingerprint: candidateProjection.candidate_fingerprint ?? null,
      workspace_subject_id: workspace?.subject_id ?? null,
      workspace_generation: workspace?.generation ?? null,
      workspace_fingerprint: workspace?.fingerprint ?? null,
      projection_digest: reviewProjectionDigest,
    },
    legalActions: candidateProjection.legal_actions ?? [],
  });
  return {
    run,
    review,
    workspace: workspaceProjection?.authority_fact,
  };
}

function ownerAuthorityError({ owner, projection, subjectId = null, providerIdentity }) {
  const identity = {
    run: {
      authorityId: "RunAuthority",
      contract: "flow.run-projection/v1",
      domain: "run",
      subjectId: projection?.run_id ?? subjectId,
      disposition: projection?.phase ?? null,
      generation: projection?.stream_generation ?? projection?.sequence ?? null,
    },
    review: {
      authorityId: "ReviewAuthority",
      contract: "work.review/v1",
      domain: "review",
      subjectId: projection?.subject_id ?? subjectId,
      disposition: projection?.status ?? null,
      generation: projection?.generation ?? null,
    },
    workspace: {
      authorityId: "WorkspaceAuthority",
      contract: "work.workspace/v1",
      domain: "workspace",
      subjectId: projection?.subject_id ?? subjectId,
      disposition: projection?.disposition ?? null,
      generation: projection?.generation ?? null,
    },
  }[owner];
  const rejection = authorityReadRejection(projection);
  const baseFact = isRecord(rejection?.authority_fact)
    ? rejection.authority_fact
    : {};
  let projectionDigest = null;
  try {
    projectionDigest = reviewOwnerProjectionDigest(owner, projection);
  } catch {
    // The owner fact still carries all validated metadata available on reject.
  }
  const ownerFacts = isRecord(baseFact.facts) ? baseFact.facts : {};
  const authorityFactLegalActions = Array.isArray(baseFact.legal_actions)
    ? baseFact.legal_actions
    : Array.isArray(rejection?.legal_actions)
      ? rejection.legal_actions
      : projection?.legal_actions ?? [];
  const legalActionSources = [
    baseFact.legal_actions,
    rejection?.legal_actions,
    projection?.legal_actions,
  ];
  const legalActions = legalActionSources.find((actions) =>
    Array.isArray(actions) && actions.length > 0) ??
    legalActionSources.find(Array.isArray) ?? [];
  const fact = createAuthorityFact({
    authorityId: baseFact.authority_id ?? identity.authorityId,
    authorityContract: baseFact.authority_contract ?? rejection?.contract ?? identity.contract,
    providerIdentity,
    watermark: baseFact.watermark ?? rejection?.authority_watermark ??
      projection?.watermark ?? null,
    watermarkDomain: identity.domain,
    subjectId: baseFact.subject_id ?? rejection?.subject_id ?? identity.subjectId,
    disposition: baseFact.disposition ?? identity.disposition,
    generation: baseFact.generation ?? identity.generation,
    facts: {
      ...ownerFacts,
      ...(ownerFacts.projection_digest !== undefined || projectionDigest === null
        ? {}
        : { projection_digest: projectionDigest }),
    },
    legalActions: authorityFactLegalActions,
  });
  const effectiveLegalActions = legalActions.length > 0
    ? legalActions
    : owner === "workspace"
      ? workspaceRecoveryActions({
          subject_id: fact.subject_id,
          watermark: fact.watermark,
          generation: fact.generation,
          mutation_epoch: fact.facts?.mutation_epoch ?? null,
          fingerprint: fact.facts?.fingerprint ?? null,
        })
      : [];
  return {
    authority_watermark: fact.watermark,
    authority_watermark_domain: identity.domain,
    legal_actions: effectiveLegalActions,
    authority_fact: fact,
  };
}

function reviewCandidatePreparationOutcome({
  candidateProjection,
  candidateId,
  requestedFingerprint,
  providerIdentity,
}) {
  if (!isRecord(candidateProjection) ||
      candidateProjection.schema !== "work.review-candidate-projection/v1" ||
      candidateProjection.candidate_fingerprint !== requestedFingerprint) {
    return null;
  }
  if (candidateProjection.status === "sealed" &&
      candidateProjection.subject_id === candidateId &&
      candidateProjection.candidate_fingerprint === requestedFingerprint) {
    return null;
  }
  const candidate = candidateProjection.candidate;
  if (!isRecord(candidate)) return null;
  const issue = reviewCandidateProjectionIssue({
    schema: "flow.review-local-candidate/v1",
    candidate,
    candidate_fingerprint: requestedFingerprint,
    candidate_authority_watermark: candidateProjection.watermark,
  }, candidateProjection);
  if (issue === null) return null;
  return createRejection({
    operation: "prepare",
    code: issue.code,
    reason: issue.reason,
    authorityWatermark: candidateProjection.watermark ?? null,
    authorityWatermarkDomain: "review",
    legalActions: Array.isArray(candidateProjection.legal_actions)
      ? candidateProjection.legal_actions
      : [],
    authorityFact: createAuthorityFact({
      authorityId: "ReviewAuthority",
      authorityContract: "work.review/v1",
      providerIdentity,
      watermark: candidateProjection.watermark ?? null,
      watermarkDomain: "review",
      subjectId: candidateProjection.subject_id ?? candidateId,
      disposition: candidateProjection.status ?? null,
      generation: candidateProjection.generation ?? null,
      facts: {
        candidate_fingerprint: candidateProjection.candidate_fingerprint,
        projection_digest: digest(candidateProjection),
      },
      legalActions: candidateProjection.legal_actions ?? [],
    }),
  });
}

function reviewPreparationCandidateId(request) {
  const candidates = [
    request?.candidate_id,
    request?.review_candidate_reference?.candidate_id,
    request?.inputs?.target?.candidate?.candidate_id,
    request?.selection?.inputs?.target?.candidate?.candidate_id,
    request?.prepared?.selection?.inputs?.target?.candidate?.candidate_id,
  ].filter((candidate) => candidate !== undefined);
  if (candidates.length === 0 ||
      candidates.some((candidate) =>
        typeof candidate !== "string" || candidate.length === 0) ||
      new Set(candidates).size !== 1) return null;
  return candidates[0];
}

function reviewPreparationCandidateFingerprint(request) {
  const candidates = [
    request?.candidate_fingerprint,
    request?.review_candidate_reference?.candidate_fingerprint,
    request?.inputs?.target?.candidate_fingerprint,
    request?.inputs?.preparation_selection?.target?.candidate_fingerprint,
    request?.selection?.target?.candidate_fingerprint,
  ].filter((candidate) => candidate !== undefined);
  if (candidates.length === 0 ||
      candidates.some((candidate) =>
        typeof candidate !== "string" || !/^sha256:[0-9a-f]{64}$/.test(candidate)) ||
      new Set(candidates).size !== 1) return null;
  return candidates[0];
}

async function readProductionCatalog(env = process.env) {
  const catalogPath = fileURLToPath(
    new URL("../contracts/catalog.v1.json", import.meta.url),
  );
  const homeDirectory = env.HOME ?? homedir();
  const stateDirectory = env.XDG_STATE_HOME ?? join(homeDirectory, ".local", "state");
  const catalog = await loadContractCatalog({
    catalogPath,
    featureContractPath: fileURLToPath(
      new URL("../contracts/drovr-required-features.v1.json", import.meta.url),
    ),
    homeDirectory,
    stateDirectory,
  });
  const identity = {
    id: `flow.contract-catalog/v1@${catalog.catalog_version}`,
    fingerprint: digest(catalog),
  };
  return {
    identity,
    providerIdentities: {
      run: catalog.flow_runtime.owner.provider_identity,
      review: catalog.work_domain_interfaces.review.provider_identity,
      workspace: catalog.work_domain_interfaces.workspace.provider_identity,
    },
  };
}

function reviewRouteSnapshotIdentity(bindings) {
  return {
    configuration_watermark: digest(bindings.map(({ card_id, route, description }) => ({
      card_id,
      route,
      description_digest: description?.description_digest,
    }))),
    comparison_key: digest(bindings.map(({ card_id, route }) => ({
      card_id,
      launch_comparison_key: route?.launch_comparison_key,
    }))),
  };
}

function normalizeReviewRouteSnapshot(routeSnapshot, routeBindings) {
  if (!isRecord(routeSnapshot)) return null;
  const bindings = routeBindings ?? routeSnapshot.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const normalizedBindings = bindings.map((binding) => ({
    card_id: binding.card_id,
    route: binding.route,
    description: binding.description,
  })).sort((left, right) => left.card_id.localeCompare(right.card_id));
  let configurationWatermark;
  let comparisonKey;
  try {
    ({
      configuration_watermark: configurationWatermark,
      comparison_key: comparisonKey,
    } = reviewRouteSnapshotIdentity(normalizedBindings));
  } catch {
    return null;
  }
  if (routeSnapshot.configuration_watermark !== configurationWatermark ||
      routeSnapshot.comparison_key !== comparisonKey) {
    return null;
  }
  return {
    route_id: routeSnapshot.route_id ?? "route:review",
    configuration_watermark: configurationWatermark,
    comparison_key: comparisonKey,
    bindings: normalizedBindings,
  };
}

function observeDefaultReviewRoutes({ request, workspacePath, delegatedAgentPort }) {
  const selection = reviewPreparationSelection(request);
  if (selection.accepted === false) return selection;
  const roles = [
    ...selection.lenses.map((lens) => ({
      cardId: `review-lens-${lens}`,
      role: `lens:${lens}`,
      choice: selection.routes.lenses[lens],
    })),
    { cardId: "review-critic", role: "critic", choice: selection.routes.critic },
  ];
  const observations = roles.map(({ cardId, role, choice }) =>
    observeReviewRoute({
      cardId,
      role,
      choice,
      workspacePath,
      delegatedAgentPort,
    }));
  if (observations.some(isPromiseLike)) {
    return Promise.all(observations).then((bindings) => ({
      routeSnapshot: routeSnapshotFromBindings(bindings),
    }));
  }
  return { routeSnapshot: routeSnapshotFromBindings(observations) };
}

function reviewPreparationSelection(request) {
  const selection = request?.selection ?? request?.review_selection ??
    request?.inputs?.preparation_selection ?? request?.preparation_selection;
  if (!isRecord(selection) ||
      selection.schema !== "flow.review-preparation-selection/v1" ||
      !Array.isArray(selection.lenses) || selection.lenses.length === 0 ||
      new Set(selection.lenses).size !== selection.lenses.length ||
      selection.lenses.some((lens) => !REVIEW_LENSES.includes(lens)) ||
      !isRecord(selection.routes) || !isRecord(selection.routes.lenses) ||
      !isRecord(selection.routes.critic)) {
    return rejectedReviewPreparation(
      "invalid_review_preparation_selection",
      "review preparation requires one exact lens and route selection",
    );
  }
  const lensKeys = Object.keys(selection.routes.lenses);
  if (lensKeys.some((lens) => !selection.lenses.includes(lens)) ||
      selection.lenses.some((lens) => !Object.hasOwn(selection.routes.lenses, lens))) {
    return rejectedReviewPreparation(
      "invalid_review_preparation_selection",
      "review preparation route selection must cover every selected lens",
    );
  }
  const target = selection.target;
  if (target !== undefined && (!isRecord(target) ||
      target.candidate_id !== reviewPreparationCandidateId(request) ||
      target.candidate_fingerprint !== reviewPreparationCandidateFingerprint(request))) {
    return rejectedReviewPreparation(
      "candidate_fingerprint_mismatch",
      "review preparation selection target is not the requested candidate",
    );
  }
  return {
    accepted: true,
    lenses: [...selection.lenses].sort(),
    routes: {
      lenses: Object.fromEntries([...selection.lenses].sort().map((lens) => [
        lens,
        selection.routes.lenses[lens],
      ])),
      critic: selection.routes.critic,
    },
  };
}

function observeReviewRoute({ cardId, role, choice, workspacePath, delegatedAgentPort }) {
  if (!isRecord(choice)) {
    return rejectedReviewPreparation(
      "invalid_review_route_selection",
      `review preparation route selection is missing for ${cardId}`,
    );
  }
  const suppliedDescription = isRecord(choice.description)
    ? choice.description
    : null;
  const launch = choice.launch ?? suppliedDescription?.launch;
  if (!isRecord(launch) || typeof delegatedAgentPort?.describe !== "function") {
    return rejectedReviewPreparation(
      "route_unavailable",
      `review preparation cannot observe the ${role} route`,
    );
  }
  const projection = delegatedAgentPort.describe({
    schema: "flow.delegated-agent-description-request/v1",
    launch: { ...launch, capability: launch.capability ?? "read-only" },
    caller_metadata: { flow: "review/v1", role },
    ...(delegatedAgentPort.backend === "direct"
      ? { workspace_path: workspacePath } : {}),
  });
  const bind = (observed) => {
    const description = observed?.description;
    if (observed?.status !== "compatible" || !validReviewDescription(description)) {
      return rejectedReviewPreparation(
        observed?.compatibility?.code ?? "route_unavailable",
        `Execution ${role} route is unavailable or incompatible`,
      );
    }
    const boundDescription = bindReviewDescription(description);
    if (suppliedDescription !== null &&
        !sameDescriptionIdentity(boundDescription, suppliedDescription)) {
      return rejectedReviewPreparation(
        "route_changed",
        `Execution ${role} route description changed before review preparation`,
      );
    }
    const defaultAgentId = `agent:flow-review-${role.replaceAll(":", "-")}-${
      description.comparison_keys.launch.slice(-16)}`;
    const suppliedRoute = isRecord(choice.route) ? choice.route : null;
    const route = suppliedRoute ?? {
      agent_id: defaultAgentId,
      configuration_watermark: description.watermark.content_sha256,
      description_digest: boundDescription.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    };
    if (!validReviewRoute(route) ||
        route.configuration_watermark !== description.watermark.content_sha256 ||
        route.description_digest !== boundDescription.description_digest ||
        route.launch_comparison_key !== description.comparison_keys.launch) {
      return rejectedReviewPreparation(
        "route_changed",
        `Execution ${role} route binding is not derived from its description`,
      );
    }
    return { card_id: cardId, route, description: boundDescription };
  };
  return isPromiseLike(projection) ? projection.then(bind) : bind(projection);
}

function routeSnapshotFromBindings(bindings) {
  if (bindings.some((binding) => binding?.accepted === false)) {
    return bindings.find((binding) => binding?.accepted === false);
  }
  const normalized = bindings.slice().sort((left, right) =>
    left.card_id.localeCompare(right.card_id));
  const agentIds = new Set();
  const launchKeys = new Set();
  for (const binding of normalized) {
    if (agentIds.has(binding.route.agent_id) ||
        launchKeys.has(binding.route.launch_comparison_key)) {
      return rejectedReviewPreparation(
        "non_independent_review_route",
        "review preparation requires independent selected route identities",
      );
    }
    agentIds.add(binding.route.agent_id);
    launchKeys.add(binding.route.launch_comparison_key);
  }
  return {
    route_id: "route:review",
    ...reviewRouteSnapshotIdentity(normalized),
    bindings: normalized,
  };
}

function validReviewDescription(description) {
  if (isDirectDescription(description)) {
    try { return directDescriptionIssue(description) === null; }
    catch { return false; }
  }
  if (!isRecord(description) ||
      description.schema !== "drovr.delegated-agent-description/v1" ||
      !isRecord(description.comparison_keys) ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys.launch) ||
      !isDigest(description.comparison_keys.effective_authority) ||
      !isDigest(description.watermark?.content_sha256)) return false;
  const { description_digest: _digest, legal_actions: _actions, ...identity } =
    description;
  return sameCanonicalValue(digest(identity), description.description_digest);
}

function bindReviewDescription(description) {
  const { description_digest: _digest, legal_actions: _actions, ...identity } =
    description;
  return freezeCanonical({ ...identity, description_digest: digest(identity) });
}

function sameDescriptionIdentity(left, right) {
  try {
    const strip = (description) => {
      const { description_digest: _digest, legal_actions: _actions, ...identity } =
        description;
      return identity;
    };
    return digest(strip(left)) === digest(strip(right));
  } catch {
    return false;
  }
}

function validReviewRoute(route) {
  return isRecord(route) &&
    Object.keys(route).length === 4 &&
    typeof route.agent_id === "string" && route.agent_id.length > 0 &&
    isDigest(route.configuration_watermark) &&
    isDigest(route.description_digest) &&
    isDigest(route.launch_comparison_key);
}

function rejectedReviewPreparation(code, reason, error = null) {
  const authorityRejection = authorityReadRejection(error);
  if (authorityRejection !== null) {
    return rejectedReviewPreparationFromAuthority(authorityRejection);
  }
  return {
    accepted: false,
    issue: {
      code,
      reason,
      ...(error?.authority_watermark === undefined ? {} : {
        authority_watermark: error.authority_watermark,
      }),
      ...(error?.authority_watermark_domain === undefined ? {} : {
        authority_watermark_domain: error.authority_watermark_domain,
      }),
      legal_actions: Array.isArray(error?.legal_actions)
        ? error.legal_actions
        : [],
      ...(error?.authority_fact === undefined ? {} : {
        authority_fact: error.authority_fact,
      }),
    },
  };
}

function rejectedReviewPreparationFromAuthority(rejection, {
  owner = rejection?.contract === "work.workspace/v1"
    ? "workspace"
    : rejection?.contract === "work.review/v1"
      ? "review"
      : "run",
  providerIdentity,
} = {}) {
  const preserved = ownerAuthorityError({
    owner,
    projection: rejection,
    providerIdentity,
  });
  const rawDomain = rejection?.authority_watermark_domain;
  return {
    accepted: false,
    rejection: createRejection({
      operation: rejection?.operation ?? "query",
      code: typeof rejection?.code === "string"
        ? rejection.code
        : "review_preparation_unavailable",
      reason: typeof rejection?.reason === "string" ? rejection.reason : null,
      authorityWatermark: preserved.authority_watermark,
      authorityWatermarkDomain: owner === "run" &&
        (rawDomain === "host" || rawDomain === "run")
        ? rawDomain
        : "host",
      legalActions: preserved.legal_actions,
      authorityFact: preserved.authority_fact,
    }),
  };
}

function authorityReadRejection(value) {
  if (!isRecord(value)) return null;
  return value.schema === "flow.rejection/v1" ||
      value.schema === "work.rejection/v1"
    ? value
    : null;
}

function isPromiseLike(value) {
  return value !== null && (typeof value === "object" ||
    typeof value === "function") && typeof value.then === "function";
}

function resolveDelegatedWorkspaceClaim({
  claim,
  request,
  resolveWorkspace,
  runAuthority,
}) {
  const repository = resolveWorkspace(claim?.subject_id);
  if (repository === null || repository === undefined) {
    throw new ProductionPreparationError(
      "workspace_claim_stale",
      "delegated workspace is not registered for the exact subject",
    );
  }
  let projection;
  try {
    projection = getWorkspaceAuthority({ runAuthority }).query({
      contract: "work.workspace/v1",
      subject_id: claim.subject_id,
    });
  } catch (error) {
    throw new ProductionPreparationError(
      "workspace_claim_uncertain",
      "WorkspaceAuthority could not prove the delegated workspace claim",
      { cause: error },
    );
  }
  if (projection?.schema !== "work.workspace-projection/v1" ||
      projection.subject_id !== claim.subject_id ||
      projection.generation !== claim.generation ||
      projection.mutation_epoch !== claim.mutation_epoch ||
      digest({ git: projection.git }) !== claim.fingerprint ||
      projection.workspace?.canonical_path !== repository.path ||
      projection.repository?.canonical_id !== repository.repository_id) {
    throw new ProductionPreparationError(
      "workspace_claim_stale",
      "WorkspaceAuthority projection does not match the delegated workspace claim",
    );
  }
  if (claim.access === "mutation") {
    const exactClaim = projection.claims?.find((candidate) =>
      candidate.holder === request.owner?.run_id &&
      candidate.operations?.includes(request.owner?.card_id));
    if (!exactClaim) {
      throw new ProductionPreparationError(
        "workspace_claim_conflict",
        "delegated mutation workspace is not held by the exact run and card",
      );
    }
  }
  return {
    subject_id: claim.subject_id,
    generation: claim.generation,
    mutation_epoch: claim.mutation_epoch,
    fingerprint: claim.fingerprint,
    canonical_path: repository.path,
    repository_id: repository.repository_id,
    ref: repository.ref,
  };
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

function configuredBackupRestoreAdapter({
  env,
  authorityDirectory,
  authorityOptions,
  legacyRoots,
}) {
  const backupDirectory = authorityOptions.backupRestoreDirectory ??
    env.FLOW_BACKUP_DIRECTORY;
  const repositoryRoot = authorityOptions.backupRestoreRepositoryRoot ??
    env.FLOW_REPOSITORY_ROOT;
  const drovrStatusRunner = authorityOptions.drovrStatusRunner ?? null;
  if (typeof backupDirectory !== "string" ||
      !backupDirectory.startsWith("/") ||
      typeof repositoryRoot !== "string" || !repositoryRoot.startsWith("/") ||
      typeof authorityDirectory !== "string" ||
      !authorityDirectory.startsWith("/") ||
      typeof env?.DROVR_CONFIG_DIR !== "string" ||
      !env.DROVR_CONFIG_DIR.startsWith("/") ||
      drovrStatusRunner !== null && typeof drovrStatusRunner !== "function" ||
      drovrStatusRunner === null &&
        (typeof env.XDG_STATE_HOME !== "string" ||
         !env.XDG_STATE_HOME.startsWith("/"))) {
    return null;
  }
  try {
    return createProductionBackupRestoreAdapter({
      authorityDirectory,
      backupDirectory,
      repositoryRoot,
      legacyRoots,
      env,
      drovrStatusRunner,
    });
  } catch {
    // Invalid or unsafe explicit provider configuration retains the generic
    // null-adapter's fail-closed public behavior.
    return null;
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
    workspacePath: repositoryPath,
    input: routes?.apply,
    capability: delegatedAgentPort.backend === "direct" ? "workspace-write-denied" : "workspace-write",
    role: "apply",
    repositoryId,
    workspaceSubjectId,
  });
  const critique = await describedRoute({
    delegatedAgentPort,
    workspacePath: repositoryPath,
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
  const operationContracts = [...Object.values(FEATURE_OPERATION_CONTRACTS), FEATURE_DIRECT_COMMIT_CONTRACT];
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
    [FEATURE_DIRECT_COMMIT_CONTRACT]: productionOperations[FEATURE_DIRECT_COMMIT_CONTRACT],
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
      const facts = context.ownerFacts ??
        preparationOwnerFacts(context.selection?.inputs?.preparation_facts ??
          context.prepared?.selection?.inputs?.preparation_facts) ??
        context.selection?.explicit_facts ??
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
    if (facts.contract_facts !== undefined) return facts.contract_facts;
    return {
      operation_contracts: facts.operation_contracts,
      validator_contracts: facts.validator_contracts,
    };
  }
  return facts[fact];
}

function preparationOwnerFacts(facts) {
  if (!isRecord(facts) || facts.schema !== "flow.review-preparation-facts/v1") {
    return null;
  }
  const workspace = facts.workspace;
  return {
    route_snapshot: facts.route,
    resource_claims: [{
      kind: "workspace",
      id: workspace.subject_id,
      generation: workspace.generation,
      mutation_epoch: workspace.mutation_epoch,
      fingerprint: workspace.fingerprint,
    }],
    contract_facts: {
      operation_contracts: facts.operation.contracts,
      validator_contracts: facts.validator.contracts,
    },
    subject_generations: [{
      schema: "flow.subject-generation/v1",
      contract: "work.workspace/v1",
      subject_id: workspace.subject_id,
      generation: workspace.generation,
      fingerprint: workspace.fingerprint,
    }],
  };
}

async function describedRoute({
  delegatedAgentPort,
  workspacePath,
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
    ...(delegatedAgentPort.backend === "direct" ? { workspace_path: workspacePath } : {}),
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
      `Execution ${role} route is unavailable or incompatible`,
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
    findings = isDirectDescription(description)
      ? (directDescriptionIssue(description) ? [{ field: "description", reason: "contradictory" }] : [])
      : featureConformanceFindings(description, loadRequiredDrovrFeatures());
  } catch (error) {
    throw new ProductionPreparationError(
      "drovr_contract_unavailable",
      "the shipped Drovr feature contract is unavailable",
      { cause: error },
    );
  }
  if (findings.length > 0 ||
      (!isDirectDescription(description) && description.schema !== "drovr.delegated-agent-description/v1") ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.comparison_keys?.effective_authority) ||
      !isDigest(description.watermark?.content_sha256)) {
    throw new ProductionPreparationError(
      "incompatible_feature_advertisement",
      `Execution ${role} route does not satisfy its advertised contract`,
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
      "workspace-write-denied",
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
