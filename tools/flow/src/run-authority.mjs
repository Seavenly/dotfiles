import { isDeepStrictEqual } from "node:util";

import { digest, freezeCanonical } from "./canonical.mjs";
import { decideLifecycle } from "./lifecycle-kernel.mjs";
import { foldRun, projectRun, runWatermark } from "./run-projection.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

export function createInMemoryRunAuthority() {
  const runs = new Map();
  const bundleRuns = new Map();
  const authorityEvents = [];
  const watchers = new Map();

  return Object.freeze({
    launch({ prepared, confirmation, closed_facts: closedFacts }) {
      assertPreparedBundle(prepared);
      const expectedConfirmation = freezeCanonical({
        schema: "flow.dynamic-plan-confirmation/v1",
        bundle_digest: prepared.bundle_digest,
        graph: prepared.graph,
        requested_authority: prepared.requested_authority,
        explicit_facts: prepared.explicit_facts,
      });
      if (!isDeepStrictEqual(prepared.confirmation, expectedConfirmation)) {
        throw new Error("prepared confirmation is not bound to the bundle");
      }
      if (!isDeepStrictEqual(confirmation, expectedConfirmation)) {
        throw new Error("launch confirmation differs from the prepared bundle");
      }
      if (!isDeepStrictEqual(closedFacts, prepared.explicit_facts)) {
        throw new Error("closed identity facts differ from the prepared bundle");
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
      if (!run) throw new Error(`unknown flow run: ${command?.run_id}`);
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
        if (!run) throw new Error(`unknown flow run: ${runId}`);
        return projectRun(foldRun(run));
      }
      return {
        schema: "flow.run-index-projection/v1",
        watermark: authorityWatermark(authorityEvents),
        runs: [...runs.keys()].sort(),
      };
    },

    watch(runId) {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown flow run: ${runId}`);
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
  if (prepared?.schema !== "flow.prepared-run/v1" ||
      prepared.kind !== "dynamic") {
    throw new Error("launch requires a prepared dynamic bundle");
  }
  if (prepared.plan_fingerprint !== digest(prepared.graph)) {
    throw new Error("prepared plan fingerprint mismatch");
  }
  const bundleDigest = digest({
    schema: "flow.prepared-bundle/v1",
    kind: prepared.kind,
    graph: prepared.graph,
    plan_fingerprint: prepared.plan_fingerprint,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
  });
  if (prepared.bundle_digest !== bundleDigest) {
    throw new Error("prepared bundle digest mismatch");
  }
}

function launchReceipt(run, created) {
  return freezeCanonical({
    schema: "flow.launch-receipt/v1",
    run_id: run.run_id,
    bundle_digest: run.prepared.bundle_digest,
    plan_fingerprint: run.prepared.plan_fingerprint,
    authority_watermark: run.launch_watermark,
    created,
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
