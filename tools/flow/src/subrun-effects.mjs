import { digest } from "./canonical.mjs";

export const SUBRUN_CONTRACT = "flow.subrun/create-and-observe/v1";
export const SUBRUN_RECEIPT_VALIDATOR = "flow.validator/subrun-receipt/v1";

export function deriveChildRunId({
  parent_run_id: parentRunId,
  card_identity: cardIdentity,
  revision_ordinal: revisionOrdinal,
}) {
  const identity = digest({
    schema: "flow.child-run-identity/v1",
    parent_run_id: parentRunId,
    card_identity: cardIdentity,
    revision_ordinal: revisionOrdinal,
  });
  return `run:child:${identity.slice("sha256:".length)}`;
}

export function createSubrunRegistration({ getRuntime, runAuthority }) {
  return Object.freeze({
    classification: "reconcilable",

    async invoke(intent) {
      const identity = subrunIdentity(intent);
      const launch = runAuthority.launchChild({
        ...identity,
        launch_request: intent.operation_input.child_launch_request,
      });
      if (launch?.accepted === false || launch?.schema === "flow.rejection/v1") {
        throw new Error(`child run launch rejected: ${launch?.code ?? "unknown"}`);
      }
      const terminal = await waitForTerminal(getRuntime(), launch.run_id);
      return subrunReceipt(intent, terminal);
    },

    observe(intent) {
      const childRunId = deriveChildRunId(subrunIdentity(intent));
      const child = getRuntime().query({ run_id: childRunId });
      if (child?.schema === "flow.rejection/v1") {
        const exactAbsence = child.code === "unknown_run" &&
          child.authority_watermark_domain === "host" &&
          typeof child.authority_watermark === "string";
        return observation(intent, exactAbsence ? "absent" : "indeterminate", {
          child_run_id: childRunId,
          authority_watermark: child.authority_watermark,
          proof: exactAbsence ? "run_index_absence" : "authority_unavailable",
          rejection_code: child.code,
        });
      }
      if (settledTerminal(child)) {
        return observation(intent, "present", childResult(child));
      }
      return observation(intent, "indeterminate", {
        child_run_id: childRunId,
        child_phase: child.phase,
        child_watermark: child.watermark,
        proof: "child_unsettled",
      });
    },

    requestCancellation(intent) {
      const childRunId = deriveChildRunId(subrunIdentity(intent));
      const child = getRuntime().query({ run_id: childRunId });
      const cancel = child?.legal_actions?.find(({ type }) => type === "cancel");
      if (!cancel) return null;
      return getRuntime().command(cancel);
    },

    async resume(intent) {
      const initialRecovery = getRuntime().query({ run_id: intent.run_id })
        .legal_actions.find(({ effect_id: effectId, type }) =>
          type === "recovery" && effectId === intent.effect_id);
      if (!initialRecovery ||
          getRuntime().command(initialRecovery)?.accepted !== true) return;
      const childRunId = deriveChildRunId(subrunIdentity(intent));
      const child = getRuntime().query({ run_id: childRunId });
      if (child?.schema === "flow.rejection/v1") return;
      const admission = runAuthority.recordSubrunAdmission?.(
        subrunIdentity(intent),
      );
      if (admission?.schema === "flow.rejection/v1") return;
      await waitForTerminal(getRuntime(), childRunId);
      const recovery = getRuntime().query({ run_id: intent.run_id })
        .legal_actions.find(({ effect_id: effectId, type }) =>
          type === "recovery" && effectId === intent.effect_id);
      if (recovery) getRuntime().command(recovery);
    },
  });
}

function subrunIdentity(intent) {
  return {
    parent_run_id: intent.run_id,
    card_id: intent.card_id,
    card_identity: intent.card_identity,
    revision_ordinal: intent.revision_ordinal,
  };
}

async function waitForTerminal(runtime, runId) {
  const watcher = runtime.watch({ run_id: runId })[Symbol.asyncIterator]();
  try {
    while (true) {
      const update = await watcher.next();
      if (update.done) throw new Error("child run watch ended before terminality");
      if (settledTerminal(update.value)) {
        return update.value;
      }
    }
  } finally {
    await watcher.return?.();
  }
}

function settledTerminal(projection) {
  if (!["succeeded", "declined", "cancelled"].includes(projection.phase)) {
    return false;
  }
  return projection.effects.every(({ status }) =>
    [
      "succeeded",
      "late_succeeded",
      "quarantined",
      "late_quarantined",
      "abandoned",
    ].includes(status));
}

function subrunReceipt(intent, child) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: childResult(child),
  };
}

function childResult(child) {
  return {
    child_run_id: child.run_id,
    child_phase: child.phase,
    child_watermark: child.watermark,
    child_attempts: child.attempts,
  };
}

function observation(intent, presence, providerObservation) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence,
    causation: presence === "present" ? {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    } : null,
    provider_observation: providerObservation,
  };
}
