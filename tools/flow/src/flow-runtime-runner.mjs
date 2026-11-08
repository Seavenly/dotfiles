import { digest } from "./canonical.mjs";
import { effectClassPolicy } from "./operation-effects.mjs";
import { SUBRUN_CONTRACT } from "./subrun-effects.mjs";

const TERMINAL_EFFECT_STATUSES = new Set([
  "abandoned",
  "late_quarantined",
  "late_succeeded",
  "not_created",
  "quarantined",
  "succeeded",
]);
const EXECUTION_COMMANDS = new Set([
  "delegate_execute",
  "operation_execute",
  "subrun_execute",
]);
const MAX_REPORTED_ERRORS = 16;
const KNOWN_ERROR_CODES = Object.freeze({
  lifecycle: new Set([
    "authority_directory",
    "authority_directory_mode",
    "authority_directory_owner",
    "authority_directory_path",
    "authority_directory_symlink",
    "endpoint_directory",
    "endpoint_directory_mode",
    "endpoint_directory_owner",
    "endpoint_directory_path",
    "endpoint_directory_symlink",
    "endpoint_path_mismatch",
    "invalid_endpoint_record",
    "mutation_authority_unavailable",
    "operator_error_sink_invalid",
    "owner_already_running",
    "owner_did_not_stop",
    "owner_exited_during_start",
    "owner_identity_unavailable",
    "owner_invalid_endpoint",
    "owner_start_failed",
    "owner_start_timeout",
    "owner_stopped",
    "owner_unavailable",
    "runtime_factory_unavailable",
    "socket_directory",
    "socket_directory_mismatch",
    "socket_directory_mode",
    "socket_directory_not_directory",
    "socket_directory_owner",
    "socket_directory_path",
    "socket_directory_symlink",
    "socket_path_occupied",
    "socket_path_symlink",
    "socket_runtime_directory_mode",
    "socket_runtime_directory_owner",
    "socket_runtime_directory_path",
    "socket_runtime_directory_symlink",
  ]),
  runner: new Set([
    "artifact_bytes_conflict",
    "authority_integrity_failure",
    "authority_schema_incompatible",
    "authority_schema_transition_required",
    "durable_authority_required",
    "forbidden_latest_resource_selection",
    "host_reconciliation_required",
    "invalid_command",
    "invalid_effect_receipt",
    "invalid_operation_input",
    "invalid_provider_receipt",
    "operation_failure",
    "runner_error",
    "stale_authority_schema_transition",
    "subrun_admission_unproven",
    "subrun_not_actionable",
    "unknown_run",
    "unsupported_host_command",
  ]),
  transport: new Set([
    "connect_timeout",
    "frame_too_large",
    "invalid_json",
    "invalid_request",
    "invalid_response",
    "invalid_watch_result",
    "multiple_requests_per_connection",
    "multiple_responses",
    "owner_unavailable",
    "response_correlation_mismatch",
    "response_timeout",
    "socket_directory_invalid",
    "socket_directory_mode",
    "socket_directory_not_directory",
    "socket_directory_owner",
    "socket_directory_symlink",
    "socket_directory_traversal",
    "socket_path_invalid",
    "socket_path_occupied",
    "socket_path_symlink",
    "transport_disconnected",
    "transport_error",
    "unserializable_response",
  ]),
});

// Internal-only marker used to distinguish runner-owned observation from a
// caller's awaited public watch. Symbols cannot cross the public JSON
// transport or become part of a prepared request.
export const FLOW_RUNTIME_BACKGROUND_WATCH = Symbol(
  "flow.runtime.background-watch",
);

/**
 * Run the authority-derived work of a FlowRuntime without exposing a
 * scheduler to callers.  The runner is deliberately a mechanism adapter:
 * every command is copied from a current authority projection and is
 * admitted by RunAuthority before an effect can be dispatched.
 */
export function createFlowRuntimeRunner({
  runtime,
  runAuthority,
  delegateCapacity = 1,
  operationCapacity = 1,
  onError = () => {},
} = {}) {
  assertPositiveCapacity(delegateCapacity, "delegateCapacity");
  assertPositiveCapacity(operationCapacity, "operationCapacity");
  if (!runtime || typeof runtime.query !== "function" ||
      typeof runtime.command !== "function" ||
      typeof runtime.watch !== "function") {
    throw new TypeError("FlowRuntime runner requires query, command, and watch");
  }
  if (!runAuthority || typeof runAuthority.query !== "function") {
    throw new TypeError("FlowRuntime runner requires RunAuthority");
  }
  if (typeof onError !== "function") {
    throw new TypeError("FlowRuntime runner onError must be a function");
  }

  let started = false;
  let stopped = false;
  let hostWatcher = null;
  const runWatchers = new Map();
  const terminalRunIds = new Set();
  let pumpScheduled = false;
  let pumping = false;
  let pumpAgain = false;
  const pending = new Map();
  // A command accepted by this runner may briefly be absent from the durable
  // projection while its provider dispatch is still settling. Keep that
  // identity local so a watch update cannot turn the same live dispatch into
  // an autonomous recovery request. A newly constructed runner starts with
  // an empty set, which deliberately preserves restart recovery.
  const liveDispatches = new Set();
  let errorCount = 0;
  let reportedErrorCount = 0;
  let suppressedErrorCount = 0;
  let lastError = null;
  let controller;

  controller = Object.freeze({
    start() {
      if (stopped) throw new Error("FlowRuntime runner is stopped");
      if (started) return controller;
      started = true;
      try {
        hostWatcher = runtime.watch({
          host: true,
          [FLOW_RUNTIME_BACKGROUND_WATCH]: true,
        });
        void consumeHostWatch(hostWatcher);
      } catch (error) {
        report(error);
      }
      requestPump();
      return controller;
    },

    stop() {
      if (stopped) return controller;
      stopped = true;
      started = false;
      const watcher = hostWatcher;
      hostWatcher = null;
      closeWatcher(watcher);
      for (const [runId, record] of runWatchers) {
        closeRunWatcher(runId, record);
      }
      pending.clear();
      liveDispatches.clear();
      return controller;
    },

    wake() {
      requestPump();
      return controller;
    },

    status() {
      const projections = currentRunProjections();
      const capacity = countCapacity(projections);
      const runStatus = countRuns(projections);
      return {
        schema: "flow.runtime-runner-status/v1",
        state: stopped ? "stopped" : started ? "running" : "idle",
        runs: runStatus,
        delegates: {
          active: capacity.delegates,
          capacity: delegateCapacity,
          available: Math.max(0, delegateCapacity - capacity.delegates),
        },
        operations: {
          active: capacity.operations,
          capacity: operationCapacity,
          available: Math.max(0, operationCapacity - capacity.operations),
        },
        pending_commands: pending.size,
        errors: {
          count: errorCount,
          reported: reportedErrorCount,
          suppressed: suppressedErrorCount,
          last: lastError,
        },
      };
    },
  });

  return controller;

  async function consumeHostWatch(watcher) {
    try {
      const iterator = watcher?.[Symbol.asyncIterator]?.() ?? watcher;
      if (!iterator || typeof iterator.next !== "function") {
        throw new TypeError("FlowRuntime host watch is not async iterable");
      }
      while (started) {
        const update = await iterator.next();
        if (update.done) break;
        syncRunWatchers(update.value);
        requestPump();
      }
    } catch (error) {
      if (started) report(error);
    }
  }

  function requestPump() {
    if (!started) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      if (!started || pumping) return;
      pumping = true;
      void runPump()
        .catch(report)
        .finally(() => {
          pumping = false;
          if (pumpAgain) {
            pumpAgain = false;
            requestPump();
          }
        });
    });
  }

  async function runPump() {
    const projections = currentRunProjections();
    const capacity = countCapacity(projections);
    for (const projection of projections) {
      if (!started) return;
      if (!isAdmitted(projection)) continue;

      const recoveries = projection.legal_actions
        .filter((action) => isAutomaticRecovery(projection, action))
        .sort(compareActions);
      let recoveryIssued = false;
      for (const action of recoveries) {
        if (isPending(projection, action) || isLiveDispatch(projection, action)) {
          continue;
        }
        if (issue(projection, action, "recovery")) recoveryIssued = true;
      }
      // A run's lifecycle kernel serializes completion-changing commands
      // behind an unresolved effect. Do not issue a stale execution command
      // after admitting recovery for this projection.
      if (recoveryIssued) continue;

      const action = projection.legal_actions
        .filter((candidate) => EXECUTION_COMMANDS.has(candidate.type))
        .sort(compareActions)
        .find((candidate) => {
          if (isPending(projection, candidate)) return false;
          if (candidate.type === "delegate_execute") {
            return capacity.delegates < delegateCapacity;
          }
          if (candidate.type === "operation_execute") {
            return capacity.operations < operationCapacity;
          }
          // A subrun is an authority observation over a child run, not an
          // operation slot. Counting it against operation capacity can
          // deadlock a child operation behind its observing parent.
          return true;
      });
      if (!action) continue;
      if (issue(projection, action, action.type)) {
        if (action.type === "delegate_execute") capacity.delegates += 1;
        if (action.type === "operation_execute") capacity.operations += 1;
      }
    }
  }

  function currentRunProjections() {
    let host;
    try {
      host = runAuthority.query();
    } catch (error) {
      report(error);
      return [];
    }
    if (host?.schema !== "flow.run-index-projection/v1" ||
        !Array.isArray(host.runs)) return [];
    const projections = [];
    for (const runId of [...host.runs].sort()) {
      try {
        const projection = runtime.query({ run_id: runId });
        if (projection?.schema === "flow.run-projection/v1") {
          projections.push(projection);
          if (isTerminalProjection(projection)) terminalRunIds.add(runId);
        }
      } catch (error) {
        report(error);
      }
    }
    syncRunWatchers(host, projections);
    prunePending(projections, new Set(host.runs));
    return projections;
  }

  function syncRunWatchers(host, projections = []) {
    if (!started || host?.schema !== "flow.run-index-projection/v1" ||
        !Array.isArray(host.runs)) return;
    const indexedRunIds = new Set(host.runs.filter((runId) =>
      typeof runId === "string" && runId.length > 0));
    for (const runId of terminalRunIds) {
      if (!indexedRunIds.has(runId)) terminalRunIds.delete(runId);
    }
    for (const [runId, record] of runWatchers) {
      if (!indexedRunIds.has(runId)) closeRunWatcher(runId, record);
    }
    const knownProjections = new Map(projections.map((projection) => [
      projection.run_id,
      projection,
    ]));
    for (const runId of [...indexedRunIds].sort()) {
      if (terminalRunIds.has(runId)) continue;
      const projection = knownProjections.get(runId) ?? readRunProjection(runId);
      if (isTerminalProjection(projection)) {
        terminalRunIds.add(runId);
        continue;
      }
      if (runWatchers.has(runId)) continue;
      subscribeRunWatcher(runId);
    }
  }

  function readRunProjection(runId) {
    try {
      return runtime.query({ run_id: runId });
    } catch (error) {
      report(error);
      return null;
    }
  }

  function subscribeRunWatcher(runId) {
    let watcher;
    try {
      watcher = runtime.watch({
        run_id: runId,
        [FLOW_RUNTIME_BACKGROUND_WATCH]: true,
      });
      const iterator = watcher?.[Symbol.asyncIterator]?.() ?? watcher;
      if (!iterator || typeof iterator.next !== "function") {
        throw new TypeError(`FlowRuntime run watch is not async iterable: ${runId}`);
      }
      const record = { watcher, iterator };
      runWatchers.set(runId, record);
      void consumeRunWatch(runId, record);
    } catch (error) {
      closeWatcher(watcher);
      report(error);
    }
  }

  async function consumeRunWatch(runId, record) {
    try {
      while (started && runWatchers.get(runId) === record) {
        const update = await record.iterator.next();
        if (update.done) break;
        requestPump();
        if (isTerminalProjection(update.value)) {
          terminalRunIds.add(runId);
          closeRunWatcher(runId, record);
        }
      }
    } catch (error) {
      if (started) report(error);
    } finally {
      if (runWatchers.get(runId) === record) runWatchers.delete(runId);
    }
  }

  function closeRunWatcher(runId, record) {
    if (runWatchers.get(runId) !== record) return;
    runWatchers.delete(runId);
    closeWatcher(record.watcher);
  }

  function closeWatcher(watcher) {
    if (!watcher || typeof watcher.return !== "function") return;
    void Promise.resolve(watcher.return()).catch((error) => {
      if (started) report(error);
    });
  }

  function issue(projection, action, kind) {
    const key = actionKey(action);
    if (pending.has(key)) return false;
    let receipt;
    try {
      receipt = runtime.command(action);
    } catch (error) {
      report(error);
      return false;
    }
    if (receipt?.accepted !== true) {
      report(commandRejectedError(receipt, action));
      return false;
    }
    const effectIds = new Set(issuedEffectIds(
      receipt,
      action,
      projection.run_id,
    ));
    if (action.effect_id !== undefined && action.effect_id !== null) {
      effectIds.add(action.effect_id);
    }
    pending.set(key, {
      runId: projection.run_id,
      effectIds: [...effectIds],
      kind,
    });
    for (const effectId of effectIds) {
      liveDispatches.add(effectKey(projection.run_id, effectId));
    }
    return true;
  }

  function isPending(projection, action) {
    return pending.has(actionKey(action));
  }

  function prunePending(projections, indexedRunIds = null) {
    const byRun = new Map(projections.map((projection) => [
      projection.run_id,
      projection,
    ]));
    for (const [key, entry] of pending) {
      const projection = byRun.get(entry.runId);
      if (!projection) {
        // A run removed from the durable host index cannot produce another
        // legal action. Drop its local fence so a long-lived runner does not
        // retain identities for completed/removed runs indefinitely. Keep an
        // indexed-but-unreadable run fenced because its outcome is unknown.
        if (indexedRunIds !== null && !indexedRunIds.has(entry.runId)) {
          pending.delete(key);
          removeLiveDispatches(entry);
        }
        continue;
      }
      const effectIds = Array.isArray(entry.effectIds)
        ? entry.effectIds
        : entry.effectId === null || entry.effectId === undefined
          ? []
          : [entry.effectId];
      if (effectIds.length === 0) {
        if (!projection.legal_actions.some((action) => actionKey(action) === key)) {
          pending.delete(key);
        }
        continue;
      }

      let waitingForDurableState = false;
      for (const effectId of effectIds) {
        const effect = projection.effects.find(({ effect_id: currentId }) =>
          currentId === effectId);
        if (!effect) {
          waitingForDurableState = true;
          continue;
        }
        if (effectHasReceiptOrTerminalStatus(effect) ||
            hasNonIndeterminateObservation(effect)) {
          liveDispatches.delete(effectKey(entry.runId, effectId));
          continue;
        }
        if (effect.last_observation?.presence === "indeterminate") {
          // The command is durably represented, so it is no longer pending.
          // Transfer recovery to the effect-class policy used after a
          // reconstructed runner starts. One-shot uncertainty remains an
          // explicit stop there. The local key must not survive this handoff:
          // isLiveDispatch deliberately does not fence durable indeterminacy,
          // and retaining it would leak an ineffective identity.
          liveDispatches.delete(effectKey(entry.runId, effectId));
          continue;
        }
        waitingForDurableState = true;
      }
      if (!waitingForDurableState) pending.delete(key);
    }
  }

  function isLiveDispatch(projection, action) {
    if (action.effect_id === undefined || action.effect_id === null ||
        !liveDispatches.has(effectKey(projection.run_id, action.effect_id))) {
      return false;
    }
    const effect = projection.effects?.find(({ effect_id: effectId }) =>
      effectId === action.effect_id);
    if (!effect) return true;
    if (effectHasReceiptOrTerminalStatus(effect) ||
        hasNonIndeterminateObservation(effect)) return false;
    // Once durable indeterminate evidence exists, the effect-class recovery
    // policy is authoritative for both an existing and reconstructed runner.
    return effect.last_observation?.presence !== "indeterminate";
  }

  function removeLiveDispatches(entry) {
    const effectIds = Array.isArray(entry.effectIds)
      ? entry.effectIds
      : entry.effectId === null || entry.effectId === undefined
        ? []
        : [entry.effectId];
    for (const effectId of effectIds) {
      liveDispatches.delete(effectKey(entry.runId, effectId));
    }
  }

  function countCapacity(projections) {
    let delegates = 0;
    let operations = 0;
    for (const projection of projections) {
      if (projection.phase !== "active") continue;
      for (const effect of projection.effects ?? []) {
        if (effect.receipt !== null ||
            TERMINAL_EFFECT_STATUSES.has(effect.status)) continue;
        if (effect.effect_kind === "delegate") delegates += 1;
        else if (effect.operation_contract !== SUBRUN_CONTRACT &&
            effect.effect_kind !== "delegate_cancellation") operations += 1;
      }
    }
    return { delegates, operations };
  }

  function countRuns(projections) {
    const active = projections.filter(({ phase }) => phase === "active");
    const executing = active.filter((projection) =>
      (projection.effects ?? []).some(isActiveEffect));
    const suspended = active.filter(({ admission }) =>
      admission === "suspended_after_reboot" ||
      admission === "suspended_host_reconciliation");
    return {
      active: active.length,
      executing: executing.length,
      waiting: active.length - executing.length,
      suspended: suspended.length,
      retained: projections.filter(({ phase }) => phase !== "active").length,
    };
  }

  function report(error) {
    errorCount += 1;
    lastError = errorSummary(error);
    if (reportedErrorCount >= MAX_REPORTED_ERRORS) {
      suppressedErrorCount += 1;
      return;
    }
    reportedErrorCount += 1;
    try {
      onError(error);
    } catch {
      // Error reporting cannot become a second scheduler failure.
    }
  }
}

function isActiveEffect(effect) {
  return effect?.receipt === null &&
    !TERMINAL_EFFECT_STATUSES.has(effect.status);
}

function effectHasReceiptOrTerminalStatus(effect) {
  return effect?.receipt !== null && effect?.receipt !== undefined ||
    TERMINAL_EFFECT_STATUSES.has(effect?.status);
}

function hasNonIndeterminateObservation(effect) {
  return effect?.last_observation !== null &&
    effect?.last_observation !== undefined &&
    effect.last_observation?.presence !== "indeterminate";
}

function isTerminalProjection(projection) {
  return projection?.schema === "flow.run-projection/v1" &&
    projection.phase !== "active";
}

function commandRejectedError(receipt, action) {
  const error = new Error(
    receipt?.code ?? "autonomous command was not accepted",
  );
  if (typeof receipt?.code === "string") error.code = receipt.code;
  error.action = action;
  return error;
}

function errorSummary(error) {
  return summarizeFlowRuntimeError(error);
}

/**
 * Return a bounded diagnostic that is safe to project through the public
 * status contract. Provider errors can contain credentials or request
 * payloads, so only a constrained machine code crosses this boundary and the
 * human message is intentionally generic.
 */
export function summarizeFlowRuntimeError(error, kind = "runner") {
  const category = Object.hasOwn(KNOWN_ERROR_CODES, kind) ? kind : "runner";
  const fallback = category === "transport" ? "transport_error" :
    category === "lifecycle" ? "owner_start_failed" : "runner_error";
  const code = KNOWN_ERROR_CODES[category].has(error?.code)
    ? error.code
    : fallback;
  return {
    name: "Error",
    message: category === "transport" ? "Flow transport error" :
      "Autonomous runner error",
    code,
  };
}

function isAdmitted(projection) {
  return ["active", "cancelled"].includes(projection.phase) &&
    projection.admission !== "suspended_after_reboot" &&
    projection.admission !== "suspended_host_reconciliation";
}

function isAutomaticRecovery(projection, action) {
  if (action.type !== "recovery") return false;
  const effect = projection.effects?.find(({ effect_id: effectId }) =>
    effectId === action.effect_id);
  if (!effect) return false;
  // Durable indeterminacy is an explicit operator stop for every effect
  // class. Automatic retry would turn an unresolved provider outcome into a
  // hot loop, even when the class is normally safe to repeat.
  if (effect.last_observation?.presence === "indeterminate") return false;
  if (effect.effect_kind === "delegate_cancellation") return true;
  const policy = effectClassPolicy(effect.classification);
  if (policy === null || effect.classification === "one_shot_uncertain") {
    return false;
  }
  return true;
}

function compareActions(left, right) {
  try {
    return digest(left).localeCompare(digest(right));
  } catch {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  }
}

function actionKey(action) {
  return digest({
    run_id: action.run_id,
    type: action.type,
    card_id: action.card_id ?? null,
    effect_id: action.effect_id ?? null,
  });
}

function effectKey(runId, effectId) {
  return digest({ run_id: runId, effect_id: effectId });
}

function issuedEffectIds(receipt, action, runId) {
  if (!EXECUTION_COMMANDS.has(action?.type) ||
      !Array.isArray(receipt?.effect_intents)) return [];
  return [...new Set(receipt.effect_intents
    .filter((intent) => intent?.run_id === runId &&
      intent.card_id === action.card_id &&
      typeof intent.effect_id === "string" && intent.effect_id.length > 0)
    .map(({ effect_id: effectId }) => effectId))];
}

function assertPositiveCapacity(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
