import { isDeepStrictEqual } from "node:util";

import { CanonicalValueError, digest, freezeCanonical } from "./canonical.mjs";
import { decideLifecycle } from "./lifecycle-kernel.mjs";
import {
  canonicalizeDynamicGraph,
  DynamicPlanValidationError,
  validateDynamicPlan,
} from "./plan-compiler.mjs";
import {
  createDynamicPlanConfirmation,
  createPreparedBundle,
} from "./prepared-contracts.mjs";
import { foldRun, projectRun, runWatermark } from "./run-projection.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;
const PREPARED_RUN_FIELDS = [
  "schema",
  "kind",
  "bundle_digest",
  "plan_fingerprint",
  "confirmation_digest",
  "graph",
  "requested_authority",
  "explicit_facts",
  "confirmation",
];

export function createInMemoryRunAuthority() {
  const runs = new Map();
  const bundleRuns = new Map();
  const authorityEvents = [];
  const watchers = new Map();

  return Object.freeze({
    launch(request = {}) {
      const {
        prepared,
        confirmation,
        closed_facts: closedFacts,
      } = request ?? {};
      try {
        assertPreparedBundle(prepared);
      } catch (error) {
        if (!(error instanceof LaunchValidationError)) throw error;
        return launchRejection(
          "invalid_prepared_bundle",
          prepared,
          authorityEvents,
          error.reason,
        );
      }
      try {
        assertConfirmationDecision(prepared, confirmation);
      } catch (error) {
        if (!(error instanceof LaunchValidationError)) throw error;
        return launchRejection(
          "invalid_confirmation",
          prepared,
          authorityEvents,
          error.reason,
        );
      }
      if (confirmation.decision === "decline") {
        return launchRejection("confirmation_declined", prepared, authorityEvents);
      }
      const expectedClosedFacts = freezeCanonical({
        schema: "flow.closed-fact-observation/v1",
        bundle_digest: prepared.bundle_digest,
        facts: prepared.explicit_facts,
      });
      if (!isDeepStrictEqual(closedFacts, expectedClosedFacts)) {
        return launchRejection("closed_facts_changed", prepared, authorityEvents);
      }

      const existingRunId = bundleRuns.get(prepared.bundle_digest);
      if (existingRunId) return launchReceipt(runs.get(existingRunId), false);

      const runId = `run:${prepared.bundle_digest.slice("sha256:".length)}`;
      const initialRun = {
        run_id: runId,
        prepared,
        events: [
          {
            type: "run_launched",
            bundle_digest: prepared.bundle_digest,
            plan_fingerprint: prepared.plan_fingerprint,
            confirmation_digest: prepared.confirmation_digest,
            closed_fact_observation_digest: digest(closedFacts),
          },
        ],
      };
      const run = freezeCanonical({
        ...initialRun,
        launch_watermark: runWatermark(initialRun),
      });
      runs.set(runId, run);
      bundleRuns.set(prepared.bundle_digest, runId);
      authorityEvents.push({
        type: "run_launched",
        run_id: runId,
        bundle_digest: prepared.bundle_digest,
      });
      return launchReceipt(run, true);
    },

    command(command) {
      const run = runs.get(command?.run_id);
      if (!run) {
        return unknownRunRejection(
          "command",
          command?.run_id,
          authorityEvents,
          command?.type,
        );
      }
      const fold = foldRun(run);
      const decision = decideLifecycle(fold, command);
      if (decision.schema === "flow.rejection/v1") {
        return freezeCanonical(decision);
      }

      const updatedRun = freezeCanonical({
        ...run,
        events: [...run.events, ...decision.events],
      });
      runs.set(run.run_id, updatedRun);
      const projection = projectRun(foldRun(updatedRun));
      for (const watcher of watchers.get(run.run_id) ?? []) {
        watcher.publish(projection);
      }
      return freezeCanonical({
        schema: "flow.command-receipt/v1",
        command_type: command.type,
        run_id: run.run_id,
        authority_watermark: projection.watermark,
        accepted: true,
      });
    },

    query(runId) {
      if (runId !== undefined) {
        const run = runs.get(runId);
        if (!run) return unknownRunRejection("query", runId, authorityEvents);
        return projectRun(foldRun(run));
      }
      return freezeCanonical({
        schema: "flow.run-index-projection/v1",
        watermark: authorityWatermark(authorityEvents),
        runs: [...runs.keys()].sort(),
      });
    },

    watch(runId) {
      const run = runs.get(runId);
      if (!run) {
        return createOneShotWatcher(
          unknownRunRejection("watch", runId, authorityEvents),
        );
      }
      const watcher = createProjectionWatcher(projectRun(foldRun(run)), () => {
        const runWatchers = watchers.get(runId);
        runWatchers?.delete(watcher);
        if (runWatchers?.size === 0) watchers.delete(runId);
      });
      const runWatchers = watchers.get(runId) ?? new Set();
      runWatchers.add(watcher);
      watchers.set(runId, runWatchers);
      return watcher;
    },
  });
}

function assertPreparedBundle(prepared) {
  if (!isExactRecord(prepared, PREPARED_RUN_FIELDS) ||
      prepared.schema !== "flow.prepared-run/v1" ||
      prepared.kind !== "dynamic") {
    invalidLaunch(
      "invalid_prepared_contract",
      "launch requires a prepared dynamic bundle",
    );
  }
  let graphDigest;
  try {
    graphDigest = digest(prepared.graph);
  } catch (error) {
    translateCanonicalError(error);
  }
  if (prepared.plan_fingerprint !== graphDigest) {
    invalidLaunch("plan_fingerprint_mismatch", "prepared plan fingerprint mismatch");
  }
  try {
    validateDynamicPlan({
      schema: "flow.dynamic-plan-proposal/v1",
      graph: prepared.graph,
      requested_authority: prepared.requested_authority,
      explicit_facts: prepared.explicit_facts,
    });
  } catch (error) {
    if (error instanceof DynamicPlanValidationError) {
      invalidLaunch(error.reason, error.message);
    }
    throw error;
  }
  if (!isDeepStrictEqual(prepared.graph, canonicalizeDynamicGraph(prepared.graph))) {
    invalidLaunch(
      "noncanonical_graph",
      "prepared graph must use the canonical card and dependency order",
    );
  }
  let bundleDigest;
  try {
    bundleDigest = digest(createPreparedBundle({
      kind: prepared.kind,
      graph: prepared.graph,
      planFingerprint: prepared.plan_fingerprint,
      requestedAuthority: prepared.requested_authority,
      explicitFacts: prepared.explicit_facts,
    }));
  } catch (error) {
    translateCanonicalError(error);
  }
  if (prepared.bundle_digest !== bundleDigest) {
    invalidLaunch("bundle_digest_mismatch", "prepared bundle digest mismatch");
  }
  const expectedConfirmation = createDynamicPlanConfirmation({
    bundleDigest: prepared.bundle_digest,
    graph: prepared.graph,
    requestedAuthority: prepared.requested_authority,
    explicitFacts: prepared.explicit_facts,
  });
  if (!isDeepStrictEqual(prepared.confirmation, expectedConfirmation) ||
      prepared.confirmation_digest !== digest(expectedConfirmation)) {
    invalidLaunch(
      "confirmation_binding_mismatch",
      "prepared confirmation is not bound to the bundle",
    );
  }
}

function isExactRecord(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function assertConfirmationDecision(prepared, confirmation) {
  if (!["accept", "decline"].includes(confirmation?.decision)) {
    invalidLaunch(
      "unsupported_confirmation_decision",
      "launch confirmation decision is invalid",
    );
  }
  const valid = ["accept", "decline"].some((decision) => isDeepStrictEqual(
    confirmation,
    freezeCanonical({
      schema: "flow.dynamic-plan-confirmation-decision/v1",
      decision,
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    }),
  ));
  if (!valid) {
    invalidLaunch(
      "confirmation_binding_mismatch",
      "launch confirmation decision is invalid",
    );
  }
}

class LaunchValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "LaunchValidationError";
    this.reason = reason;
  }
}

function invalidLaunch(reason, message) {
  throw new LaunchValidationError(reason, message);
}

function translateCanonicalError(error) {
  if (error instanceof CanonicalValueError) {
    invalidLaunch(error.reason, error.message);
  }
  throw error;
}

function launchReceipt(run, created) {
  return freezeCanonical({
    schema: "flow.launch-receipt/v1",
    run_id: run.run_id,
    bundle_digest: run.prepared.bundle_digest,
    plan_fingerprint: run.prepared.plan_fingerprint,
    launch_watermark: run.launch_watermark,
    authority_watermark: runWatermark(run),
    created,
  });
}

function unknownRunRejection(operation, runId, authorityEvents, commandType) {
  return freezeCanonical({
    schema: "flow.rejection/v1",
    operation,
    code: "unknown_run",
    reason: null,
    command_type: commandType ?? null,
    run_id: runId ?? null,
    bundle_digest: null,
    authority_watermark: authorityWatermark(authorityEvents),
    authority_watermark_domain: "host",
    legal_actions: [],
  });
}

function launchRejection(code, prepared, authorityEvents, reason = null) {
  return freezeCanonical({
    schema: "flow.rejection/v1",
    operation: "launch",
    code,
    reason,
    command_type: null,
    run_id: null,
    bundle_digest: prepared?.bundle_digest ?? null,
    authority_watermark: authorityWatermark(authorityEvents),
    authority_watermark_domain: "host",
    legal_actions: [],
  });
}

function createOneShotWatcher(result) {
  let emitted = false;
  return Object.freeze({
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (emitted) return Promise.resolve({ done: true, value: undefined });
      emitted = true;
      return Promise.resolve({ done: false, value: result });
    },
    return() {
      emitted = true;
      return Promise.resolve({ done: true, value: undefined });
    },
  });
}

function authorityWatermark(events) {
  if (events.length === 0) return EMPTY_WATERMARK;
  return digest({
    schema: "flow.host-run-authority-stream/v1",
    events,
  });
}

function createProjectionWatcher(initialProjection, close) {
  const queue = [initialProjection];
  const waiters = [];
  let closed = false;

  return {
    [Symbol.asyncIterator]() {
      return this;
    },

    next() {
      if (queue.length > 0) {
        return Promise.resolve({ done: false, value: queue.shift() });
      }
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => waiters.push(resolve));
    },

    return() {
      if (!closed) {
        closed = true;
        close();
        for (const resolve of waiters.splice(0)) {
          resolve({ done: true, value: undefined });
        }
      }
      return Promise.resolve({ done: true, value: undefined });
    },

    publish(projection) {
      if (closed) return;
      const resolve = waiters.shift();
      if (resolve) {
        resolve({ done: false, value: projection });
      } else {
        queue.push(projection);
      }
    },
  };
}
