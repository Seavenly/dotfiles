import { digest, freezeCanonical } from "./canonical.mjs";

const TIMELINE_KINDS = new Map([
  ["run_launched", "lifecycle"],
  ["run_declined", "lifecycle"],
  ["run_succeeded", "lifecycle"],
  ["run_cancelled", "lifecycle"],
  ["checkpoint_decided", "checkpoint"],
  ["card_blocked", "readiness"],
  ["capability_granted", "capability"],
  ["plan_revised", "revision"],
  ["plan_revision_declined", "revision"],
  ["effect_intent_recorded", "effect"],
  ["effect_intent_adopted", "effect"],
  ["effect_invocation_started", "effect"],
  ["effect_recovery_requested", "effect"],
  ["effect_observation_recorded", "effect"],
  ["effect_receipt_recorded", "effect"],
  ["operation_completed", "attempt"],
  ["delegate_completed", "attempt"],
  ["delegate_output_quarantined", "attempt"],
  ["terminal_disposition_decided", "attempt"],
  ["run_admitted_after_reboot", "lifecycle"],
  ["resource_handoff_published", "handoff"],
  ["resource_handoff_bound", "handoff"],
]);

export function buildRunViews({ authorityEventStreamDigest, events, fold } = {}) {
  if (fold?.schema !== "flow.run-fold/v1") {
    throw new TypeError("run views require an authoritative fold");
  }
  assertMatchingAuthorityEvents(fold, events, authorityEventStreamDigest);
  const common = {
    run_id: fold.run_id,
    authority_watermark: fold.watermark,
    ...(fold.reboot_revalidation === undefined ? {} : {
      reboot_revalidation: fold.reboot_revalidation,
    }),
  };
  const admission = fold.admission ??
    (fold.phase === "active" ? "admitted" : "released");
  const routes = {
    cards: fold.active_plan.cards.map(({ id, route }) => ({
      card_id: id,
      route,
    })),
    attempts: fold.effects.map(({ attempt_id: attemptId, route_binding: route }) => ({
      attempt_id: attemptId,
      route,
    })),
  };
  const checkpointDecisions = new Map(events
    .filter(({ type }) => type === "checkpoint_decided")
    .map(({ checkpoint_id: checkpointId, decision }) => [
      checkpointId,
      decision,
    ]));
  const checkpoints = fold.cards
    .filter(({ executor_kind: kind }) => kind === "checkpoint")
    .map(({ id, status }) => ({
      card_id: id,
      decision: checkpointDecisions.get(id) ?? null,
      status,
    }));
  const capability = {
    bindings: fold.capability_bindings,
    effective: fold.capabilities,
    envelopes: fold.capability_envelopes,
    grants: fold.grants,
  };
  const resources = {
    claims: fold.resource_claims,
    dispositions: fold.resource_dispositions,
  };
  const handoffs = {
    bindings: fold.resource_handoff_bindings,
    published: fold.handoffs,
  };
  const revision = {
    current: fold.current_revision,
    history: fold.revisions,
  };
  const operator = {
    schema: "flow.operator-projection/v1",
    ...common,
    phase: fold.phase,
    admission,
    revision,
    readiness: fold.cards,
    attempts: fold.attempts,
    routes,
    capability,
    checkpoints,
    effects: fold.effects,
    resources,
    handoffs,
    legal_actions: fold.legal_actions,
  };
  const statuses = [...new Set(fold.cards.map(({ status }) => status))];

  return freezeCanonical({
    graph: {
      schema: "flow.graph-projection/v1",
      ...common,
      phase: fold.phase,
      revision,
      nodes: fold.cards,
      edges: fold.active_plan.cards.flatMap(({ id, dependencies }) =>
        dependencies.map((dependency) => ({ from: dependency, to: id }))),
      legal_actions: fold.legal_actions,
    },
    kanban: {
      schema: "flow.kanban-projection/v1",
      ...common,
      phase: fold.phase,
      admission,
      revision,
      columns: statuses.map((status) => ({
        status,
        card_ids: fold.cards
          .filter((card) => card.status === status)
          .map(({ id }) => id),
      })),
      legal_actions: fold.legal_actions,
    },
    operator,
    timeline: {
      schema: "flow.timeline-projection/v1",
      ...common,
      phase: fold.phase,
      entries: events.map((event, index) => publicTimelineEntry(
        event,
        index + 1,
        fold.run_id,
      )),
      legal_actions: fold.legal_actions,
    },
    trust: {
      schema: "flow.trust-projection/v1",
      ...common,
      authority_boundaries: {
        flow_lifecycle: "RunAuthority",
        work_domains: "bounded_subject_authority_only",
        effect_coordinator: "mechanism_only",
        delegated_runtime: "mechanism_only",
        adapters: "mechanism_only",
        projections: "non_authoritative",
      },
      phase: fold.phase,
      admission,
      routes,
      capability,
      effects: fold.effects,
      resources,
      handoffs,
      legal_actions: fold.legal_actions,
    },
  });
}

function assertMatchingAuthorityEvents(fold, events, authorityEventStreamDigest) {
  if (!Array.isArray(events) || events.length !== fold.sequence ||
      events[0]?.type !== "run_launched") {
    throw new TypeError("run views require the complete authority event stream");
  }
  const eventStreamDigest = digest({
    schema: "flow.run-authority-stream/v1",
    run_id: fold.run_id,
    events,
  });
  if (eventStreamDigest !== authorityEventStreamDigest) {
    throw new TypeError("run view events do not match the authoritative fold");
  }
  const terminalEvent = {
    cancelled: "run_cancelled",
    declined: "run_declined",
    succeeded: "run_succeeded",
  }[fold.phase];
  const terminalEvents = events.filter(({ type }) => [
    "run_cancelled",
    "run_declined",
    "run_succeeded",
  ].includes(type));
  if (terminalEvent === undefined
    ? terminalEvents.length !== 0
    : terminalEvents.length !== 1 || terminalEvents[0].type !== terminalEvent) {
    throw new TypeError("run view events do not match the authoritative lifecycle");
  }
  const factsMatch = [
    ["plan_revised", fold.revisions.length],
    ["capability_granted", fold.grants.length],
    ["resource_handoff_published", fold.handoffs.length],
  ].every(([type, count]) =>
    events.filter((event) => event.type === type).length === count);
  if (!factsMatch) {
    throw new TypeError("run view events do not match the authoritative fold");
  }
}

function publicTimelineEntry(event, sequence, runId) {
  const kind = TIMELINE_KINDS.get(event.type) ?? "authority_change";
  const subjectId = kind === "attempt"
    ? event.attempt_id ?? event.card_id ?? runId
    : kind === "effect"
      ? event.effect_id ?? event.intent?.effect_id ?? runId
      : event.checkpoint_id ?? event.card_id ?? event.handoff_id ??
        event.grant_id ?? event.template_id ?? runId;
  return { sequence, kind, subject_id: subjectId };
}
