import { homedir } from "node:os";
import { join } from "node:path";

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
  releaseProductionRunAuthority,
  rememberRuntimeAuthority,
  statusFlowRuntime,
} from "./production-runtime.mjs";
import { createProductionComposition } from "./production-composition.mjs";

export function createFlowRuntime({
  env = process.env,
  delegatedAgentPort = null,
  delegateOutputValidators = {},
  registeredOperations = {},
  registeredAuthorities = {},
  predefinedDefinitions = {},
  legacyAdapter = null,
  legacyRoots = defaultLegacyRoots(env),
  runAuthority = undefined,
  authorityDirectory = undefined,
  authorityOptions = {},
  autonomous = undefined,
} = {}) {
  const adapter = legacyAdapter ?? new FilesystemLegacyCompatibilityAdapter({
    legacyRoots,
  });
  const delegationPort = delegatedAgentPort ?? createDrovrDelegatedAgentPort({
    dependencies: { env },
  });
  const composition = createProductionComposition({
    delegatedAgentPort: delegationPort,
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
          authorityDirectory,
          authorityOptions: composition.authorityOptions,
          authorityOptionsIdentitySource: authorityOptions,
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
      registeredQueries: {
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
        if (!composition.isPreparationRequest(proposal)) {
          return coreRuntime.prepare(proposal);
        }
        return composition.prepare(proposal, (selection) =>
          coreRuntime.prepare(selection));
      },
      launch(request) {
        let launchPreparation = null;
        try {
          launchPreparation = composition.beforeLaunch?.(request, authority) ?? null;
        } catch (error) {
          return createRejection({
            operation: "launch",
            code: error?.code ?? "production_launch_setup_failed",
            reason: error?.message ?? "production launch setup failed",
            bundleDigest: request?.prepared?.bundle_digest ?? null,
            authorityWatermark: authority?.query?.()?.watermark ?? null,
            authorityWatermarkDomain: "host",
          });
        }
        if (launchPreparation?.schema === "flow.rejection/v1") {
          return launchPreparation;
        }
        try {
          const receipt = coreRuntime.launch(request);
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

export { statusFlowRuntime };

export class FlowQueryRejected extends Error {
  constructor(message, { code }) {
    super(message);
    this.name = "FlowQueryRejected";
    this.code = code;
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

function defaultLegacyRoots(env) {
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return {
    claudeRuns: join(home, ".agent-teams", "runs"),
    hermesRuns: join(stateHome, "agent-flow", "runs"),
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
