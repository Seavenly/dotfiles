import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createFlowRuntime as createCoreFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import {
  createDrovrDelegatedAgentPort,
} from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";
import { contentDigest } from "./canonical-json.mjs";
import {
  FilesystemLegacyCompatibilityAdapter,
} from "./legacy-compatibility-adapter.mjs";
import {
  stopAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import { createRejection } from "../../../tools/flow/src/rejection.mjs";
import {
  closeOwnedFlowRuntime,
  createProductionRunAuthority,
  productionAuthorityDirectory,
  releaseProductionRunAuthority,
  rememberRuntimeAuthority,
  flowRuntimeMutationAuthority,
  statusFlowRuntime,
} from "./production-runtime.mjs";
import {
  createProductionComposition,
  ProductionPreparationError,
} from "./production-composition.mjs";
import {
  classifyPublicRoute,
  LaunchSelectionError,
  resolvePublicLaunchPolicy,
} from "../../../tools/flow/src/launch-selector.mjs";
import {
  publicQualificationIsAvailable,
} from "../../../tools/flow/src/transition-projection.mjs";
import {
  qualificationRepositoryRootFor,
} from "./owner-runtime-binding.mjs";

const RUNNER_CAPACITY_LIMIT = 64;
const FLOW_CONFIG_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_CAPACITY_ENV = Object.freeze({
  delegateCapacity: "FLOW_RUNNER_DELEGATE_CAPACITY",
  operationCapacity: "FLOW_RUNNER_OPERATION_CAPACITY",
});

export function createFlowRuntime({
  env = process.env,
  delegatedAgentPort = null,
  delegateOutputValidators = {},
  registeredOperations = {},
  registeredAuthorities = {},
  predefinedDefinitions = {},
  legacyAdapter = null,
  legacyRoots = undefined,
  runAuthority = undefined,
  authorityDirectory = undefined,
  authorityOptions = {},
  autonomous = undefined,
  runnerOptions = undefined,
  runnerErrorSink = undefined,
} = {}) {
  if (runnerErrorSink !== undefined && typeof runnerErrorSink !== "function") {
    throw new TypeError("production FlowRuntime runnerErrorSink must be a function");
  }
  const resolvedRunnerOptions = normalizeProductionRunnerOptions({
    env,
    runnerOptions,
  });
  const coreRunnerOptions = runnerErrorSink === undefined
    ? resolvedRunnerOptions
    : { ...resolvedRunnerOptions, onError: runnerErrorSink };
  const resolvedAuthorityDirectory = authorityDirectory ??
    productionAuthorityDirectory(env);
  const adapter = legacyAdapter ?? new FilesystemLegacyCompatibilityAdapter({
    legacyRoots: legacyRoots === undefined
      ? defaultLegacyRoots(env)
      : legacyRoots,
  });
  const delegationPort = delegatedAgentPort ?? createDrovrDelegatedAgentPort({
    dependencies: { env },
  });
  const composition = createProductionComposition({
    delegatedAgentPort: delegationPort,
    env,
    authorityDirectory: resolvedAuthorityDirectory,
    // Default compatibility roots are ambient legacy state. Only caller
    // supplied roots are eligible for an isolated production backup.
    legacyRoots: legacyRoots === undefined ? {} : legacyRoots,
    authorityOptions,
    registeredOperations,
    registeredAuthorities,
    predefinedDefinitions,
    delegateOutputValidators,
  });
  const ownsAuthority = runAuthority === undefined;
  let authority = null;
  let coreRuntime = null;
  let authorityLeaseAcquired = false;
  try {
    authority = ownsAuthority
      ? createProductionRunAuthority({
          env,
          authorityDirectory: resolvedAuthorityDirectory,
          authorityOptions: composition.authorityOptions,
          authorityOptionsIdentitySource: productionAuthorityOptionsIdentity({
            env,
            authorityOptions,
          }),
        })
      : runAuthority;
    authorityLeaseAcquired = ownsAuthority;
    // Core runtime construction performs synchronous same-boot recovery. Bind
    // production registrations before that sweep so provider-backed recovery
    // can use the exact durable authority rather than being dropped as an
    // unbound operation failure.
    composition.bindAuthority?.(authority);
    coreRuntime = createCoreFlowRuntime({
      runAuthority: authority,
      delegatedAgentPort: delegationPort,
      delegateOutputValidators: composition.validators,
      registeredOperations: composition.operations,
      predefinedDefinitions: composition.definitions,
      registeredAuthorities: composition.authorities,
      autonomous: autonomous ?? ownsAuthority,
      runnerOptions: coreRunnerOptions,
      registeredQueries: {
        async autonomous_runner_status(request) {
          assertAutonomousRunnerStatusQuery(request);
          const status = statusFlowRuntime(runtime);
          if (status === null) {
            throw new FlowQueryRejected(
              "autonomous FlowRuntime runner is unavailable",
              { code: "runner_unavailable" },
            );
          }
          return status;
        },
        async delegated_agent_description(request) {
          assertDelegatedAgentDescriptionQuery(request);
          return delegationPort.describe({
            schema: "flow.delegated-agent-description-request/v1",
            launch: request.launch,
            caller_metadata: request.caller_metadata,
          });
        },
        async legacy_compatibility_inventory(request) {
          assertLegacyInventoryQuery(request);
          let observation;
          try {
            observation = await adapter.observe();
          } catch (error) {
            if (error instanceof FlowQueryRejected) throw error;
            throw new FlowQueryRejected(
              "legacy compatibility inventory is unavailable",
              { code: "inventory_unavailable" },
            );
          }
          const inventory = {
            active_ownership: observation.active_ownership,
            artifacts: observation.artifacts,
            evidence_summary: evidenceSummary(observation),
            reviews: observation.reviews,
            runs: observation.runs,
            sources: observation.sources,
            stacks: observation.stacks,
            transcript_pointers: observation.transcript_pointers,
            unresolved_effects: observation.unresolved_effects,
          };
          const hasEvidenceGaps = ["missing", "uncertain", "unreadable"]
            .some((status) => inventory.evidence_summary[status] > 0);
          return {
            schema: "flow.legacy-compatibility-inventory/v1",
            watermark: {
              authority: "retained-legacy-authority",
              contract: "flow.legacy-compatibility-inventory/v1",
              content_sha256: contentDigest(inventory),
            },
            inventory,
            legal_next_actions: [
              ...(hasEvidenceGaps ? ["inspect_legacy_evidence"] : []),
              "record_digest_in_transition_ledger",
              "reinventory",
            ],
          };
        },
      },
    });
    const runtime = Object.freeze({
      prepare(proposal) {
        const gate = publicReplacementGate({
          operation: "prepare",
          request: proposal,
          composition,
          authority,
          env,
        });
        if (gate?.schema === "flow.rejection/v1") return gate;
        const publicProposal = withoutDarkOptIn(proposal);
        if (!composition.isPreparationRequest(proposal)) {
          return coreRuntime.prepare(publicProposal);
        }
        return composition.prepare(publicProposal, (selection) =>
          coreRuntime.prepare(selection)).catch((error) => {
          if (!(error instanceof ProductionPreparationError)) throw error;
          const compatibility = error.compatibility;
          return createRejection({
            operation: "prepare",
            code: compatibility?.code ?? error.code,
            outcome: "unsupported",
            reason: error.message,
            authorityWatermark: safeAuthorityWatermark(authority),
            authorityWatermarkDomain: "host",
            legalActions: compatibility?.legal_actions ?? [],
            findings: compatibility?.findings,
          });
        });
      },
      launch(request) {
        const gate = publicReplacementGate({
          operation: "launch",
          request,
          composition,
          authority,
          env,
        });
        if (gate?.schema === "flow.rejection/v1") return gate;
        const publicRequest = withoutDarkOptIn(request);
        const adopted = typeof authority?.adoptExactLaunch === "function"
          ? authority.adoptExactLaunch(publicRequest)
          : null;
        if (adopted !== null && adopted !== undefined) return adopted;
        let launchPreparation = null;
        try {
          launchPreparation = composition.beforeLaunch?.(publicRequest, authority) ?? null;
        } catch (error) {
          return createRejection({
            operation: "launch",
            code: error?.code ?? "production_launch_setup_failed",
            reason: error?.message ?? "production launch setup failed",
            bundleDigest: publicRequest?.prepared?.bundle_digest ?? null,
            authorityWatermark: authority?.query?.()?.watermark ?? null,
            authorityWatermarkDomain: "host",
          });
        }
        if (launchPreparation?.schema === "flow.rejection/v1") {
          return launchPreparation;
        }
        try {
          const receipt = coreRuntime.launch(publicRequest);
          if (receipt?.schema === "flow.rejection/v1") {
            launchPreparation?.rollback?.();
          }
          return receipt;
        } catch (error) {
          launchPreparation?.rollback?.();
          throw error;
        }
      },
      command(command) {
        return coreRuntime.command(command);
      },
      query(request) {
        return coreRuntime.query(request);
      },
      watch(request) {
        return coreRuntime.watch(request);
      },
    });
    rememberRuntimeAuthority(runtime, authority, {
      owned: ownsAuthority,
      coreRuntime,
    });
    authorityLeaseAcquired = false;
    return runtime;
  } catch (error) {
    if (coreRuntime !== null) stopAutonomousFlowRuntime(coreRuntime);
    if (authorityLeaseAcquired) releaseProductionRunAuthority(authority);
    throw error;
  }
}

export function closeFlowRuntime(runtime) {
  stopAutonomousFlowRuntime(runtime);
  return closeOwnedFlowRuntime(runtime);
}

export {
  flowRuntimeMutationAuthority,
  statusFlowRuntime,
};

export class FlowQueryRejected extends Error {
  constructor(message, { code }) {
    super(message);
    this.name = "FlowQueryRejected";
    this.code = code;
  }
}

function publicReplacementGate({
  operation,
  request,
  composition,
  authority,
  env,
}) {
  const route = classifyPublicRoute(request);
  const configDirectory = env.FLOW_CONFIG_DIRECTORY ?? FLOW_CONFIG_DIRECTORY;
  let selection;
  try {
    selection = resolvePublicLaunchPolicy({
      policyPath: env.FLOW_LAUNCH_POLICY_PATH ??
        join(configDirectory, "launch-policy.v1.json"),
      releaseManifestPath: env.FLOW_RELEASE_MANIFEST_PATH ??
        join(configDirectory, "release-manifest.v1.json"),
      darkOptIn: request?.dark_opt_in,
      route,
      homeDirectory: env.HOME ?? homedir(),
      stateDirectory: env.XDG_STATE_HOME ??
        join(env.HOME ?? homedir(), ".local", "state"),
    });
  } catch (error) {
    if (error instanceof LaunchSelectionError) {
      return createRejection({
        operation,
        code: error.code,
        outcome: error.outcome,
        reason: error.reason,
        authorityWatermark: safeAuthorityWatermark(authority),
        authorityWatermarkDomain: "host",
        legalActions: error.legal_actions,
      });
    }
    return createRejection({
      operation,
      code: "public_release_unavailable",
      outcome: "unsupported",
      reason: error?.message ?? "public replacement release is unavailable",
      authorityWatermark: safeAuthorityWatermark(authority),
      authorityWatermarkDomain: "host",
    });
  }

  let availability;
  try {
    availability = composition.publicRouteAvailability?.(route, request) ?? {
      available: false,
      missing: ["public_route_availability"],
    };
  } catch (error) {
    return createRejection({
      operation,
      code: "route_unavailable",
      outcome: "unsupported",
      reason: error?.message ?? "public route availability is unavailable",
      authorityWatermark: safeAuthorityWatermark(authority),
      authorityWatermarkDomain: "host",
    });
  }
  if (availability.available !== true) {
    return createRejection({
      operation,
      code: "route_unavailable",
      outcome: "unsupported",
      reason: `production route adapter is unavailable: ${
        (availability.missing ?? []).join(",") || "unknown"}`,
      authorityWatermark: safeAuthorityWatermark(authority),
      authorityWatermarkDomain: "host",
      legalActions: selection.capability_manifest?.supported_routes ?? [],
    });
  }

  let qualificationAvailable = false;
  try {
    const qualificationRepositoryRoot = qualificationRepositoryRootFor({
      env,
      configDirectory,
    });
    qualificationAvailable = publicQualificationIsAvailable({
      configDirectory,
      // The governed release bytes live beside the configured Flow authority,
      // while FLOW_REPOSITORY_ROOT is an explicit disposable repository
      // boundary for production backup/restore. Qualification must remain
      // bound to the configured launcher tree even when the public runtime is
      // isolated against a different repository.
      repositoryRoot: qualificationRepositoryRoot,
      selection,
      homeDirectory: env.HOME ?? homedir(),
      stateDirectory: env.XDG_STATE_HOME ??
        join(env.HOME ?? homedir(), ".local", "state"),
    });
  } catch {
    qualificationAvailable = false;
  }
  if (!qualificationAvailable) {
    return createRejection({
      operation,
      code: "qualification_withheld",
      outcome: "disabled",
      reason: "public release qualification is withheld or invalid",
      authorityWatermark: safeAuthorityWatermark(authority),
      authorityWatermarkDomain: "host",
      legalActions: [],
    });
  }
  return selection;
}

function withoutDarkOptIn(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, "dark_opt_in")) return value;
  const { dark_opt_in: _darkOptIn, ...withoutOptIn } = value;
  return withoutOptIn;
}

function safeAuthorityWatermark(authority) {
  try {
    return authority?.query?.()?.watermark ?? null;
  } catch {
    return null;
  }
}

function assertLegacyInventoryQuery(request) {
  if (
    request?.schema !== "flow.query/v1" ||
    request.query !== "legacy_compatibility_inventory" ||
    Object.keys(request).length !== 2
  ) {
    throw new FlowQueryRejected("unsupported FlowRuntime query", {
      code: "unsupported_query",
    });
  }
}

function assertDelegatedAgentDescriptionQuery(request) {
  if (
    request?.schema !== "flow.query/v1" ||
    request.query !== "delegated_agent_description" ||
    request.launch === null ||
    typeof request.launch !== "object" ||
    Array.isArray(request.launch) ||
    !Object.hasOwn(request, "caller_metadata") ||
    Object.keys(request).some(
      (key) => !["schema", "query", "launch", "caller_metadata"].includes(key),
    )
  ) {
    throw new FlowQueryRejected("invalid delegated-agent description query", {
      code: "invalid_query",
    });
  }
}

function assertAutonomousRunnerStatusQuery(request) {
  if (
    request?.schema !== "flow.query/v1" ||
    request.query !== "autonomous_runner_status" ||
    Object.keys(request).length !== 2
  ) {
    throw new FlowQueryRejected("unsupported FlowRuntime query", {
      code: "unsupported_query",
    });
  }
}

export function normalizeProductionRunnerOptions({
  env = process.env,
  runnerOptions = undefined,
} = {}) {
  if (runnerOptions !== undefined &&
      (runnerOptions === null || typeof runnerOptions !== "object" ||
       Array.isArray(runnerOptions))) {
    throw new TypeError("production FlowRuntime runnerOptions must be an object");
  }
  const supplied = runnerOptions ?? {};
  const unknown = Object.keys(supplied).filter((key) =>
    !Object.hasOwn(RUNNER_CAPACITY_ENV, key) && supplied[key] !== undefined);
  if (unknown.length > 0) {
    throw new TypeError(
      `unsupported production runner option: ${unknown[0]}`,
    );
  }
  const options = {};
  for (const [key, variable] of Object.entries(RUNNER_CAPACITY_ENV)) {
    const value = supplied[key] !== undefined
      ? supplied[key]
      : env?.[variable];
    if (value === undefined) continue;
    options[key] = positiveRunnerCapacity(value, key, variable);
  }
  return Object.freeze(options);
}

function positiveRunnerCapacity(value, key, variable) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 ||
      parsed > RUNNER_CAPACITY_LIMIT) {
    throw new TypeError(
      `${key} from ${variable} must be an integer between 1 and ${RUNNER_CAPACITY_LIMIT}`,
    );
  }
  return parsed;
}

function defaultLegacyRoots(env) {
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return {
    claudeRuns: join(home, ".agent-teams", "runs"),
    hermesRuns: join(stateHome, "agent-flow", "runs"),
  };
}

function productionAuthorityOptionsIdentity({ env, authorityOptions }) {
  if (env.FLOW_BACKUP_DIRECTORY === undefined ||
      authorityOptions.backupRestoreDirectory !== undefined) {
    return authorityOptions;
  }
  return {
    ...authorityOptions,
    backupRestoreDirectory: env.FLOW_BACKUP_DIRECTORY,
    ...(env.FLOW_REPOSITORY_ROOT === undefined ||
        authorityOptions.backupRestoreRepositoryRoot !== undefined ? {} : {
          backupRestoreRepositoryRoot: env.FLOW_REPOSITORY_ROOT,
        }),
  };
}

function evidenceSummary(observation) {
  const summary = { missing: 0, uncertain: 0, unreadable: 0, verified: 0 };
  for (const [name, values] of Object.entries(observation)) {
    if (name.startsWith("pending_")) continue;
    for (const item of values) summary[item.evidence_status] += 1;
  }
  return summary;
}
