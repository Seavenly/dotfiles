import { createHash } from "node:crypto";

import { canonicalizeJson } from "./canonical-json.mjs";
import {
  assertQualifiedCompatibility,
  compatibilityFromTrace,
} from "./compatibility.mjs";
import {
  SEMANTIC_HARNESS_INTERFACE,
  SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS,
  createSemanticHarness,
} from "./harness-interface.mjs";
import { identityEvidence } from "./semantic-evidence.mjs";
import {
  bindStagedInputToken,
  stagedInputTextToken,
} from "./staged-input-receipt.mjs";
import { correlateTranscriptRecords } from "./transcript.mjs";
import { traceRequest, validateTrace } from "./trace.mjs";

export class ReplayError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReplayError";
    this.details = details;
  }
}

export function createReplayHarness(
  trace,
  {
    harness = "codex",
    session = "replay",
    expectedCompatibility,
    requireCompatibility = false,
  } = {},
) {
  validateTrace(trace);
  const timeline = new ReplayTimeline(trace);
  const clock = new ReplayClock(timeline);
  const transcript = createReplayTranscriptAdapter(timeline, clock, harness);
  const compatibility = compatibilityFromTrace(trace, {
    harness,
    expected: expectedCompatibility,
  });
  const adapter = createReplaySemanticAdapter({
    timeline,
    clock,
    harness,
    session,
    transcript,
    compatibility,
    requireCompatibility,
  });
  const semantic = createSemanticHarness({ adapter });
  return {
    harness: semantic,
    adapter,
    clock,
    transcript,
    compatibility,
    remainingEvents: () => timeline.remainingEvents(),
    consumedEvents: () => timeline.consumedEvents(),
  };
}

export class ReplayClock {
  constructor(timeline, startMs = 0) {
    this.timeline = timeline;
    this.currentMs = startMs;
  }

  now() {
    return this.currentMs;
  }

  async delay(requestedMs) {
    const event = this.timeline.consumeDelay(requestedMs, this.currentMs);
    this.currentMs = Math.max(
      this.currentMs,
      event.at_ms,
      this.currentMs + event.payload.duration_ms,
    );
  }
}

function createReplaySemanticAdapter({
  timeline,
  clock,
  harness,
  session,
  transcript,
  compatibility,
  requireCompatibility,
}) {
  let cachedStagedEvidence;
  let cachedStagedEvidenceFresh = false;
  let stagedInspectionIdentityFresh = false;
  const adapter = {
    schema: SEMANTIC_HARNESS_INTERFACE,
    implementation: "trace-replay",
    capabilities: {
      compatibility: "required",
      topology: Object.fromEntries(
        SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS.map((operation) => [
          operation,
          false,
        ]),
      ),
      stagedInput: harness === "claude",
    },

    async ensureRuntime({ ensureSession = true } = {}) {
      // Replay has no native session to create. Accept the option so replay
      // preserves the semantic contract of production qualification-only
      // checks without pretending to mutate a runtime.
      void ensureSession;
      assertQualifiedCompatibility(compatibility);
      return {
        outcome: "uncertain",
        evidence: "uncertain",
        session,
        reason: "replay does not establish a native runtime",
      };
    },

    async observeRuntime() {
      if (timeline.peek()?.operation !== "session.list") {
        return {
          outcome: "uncertain",
          evidence: "uncertain",
          session,
          reason: "replay did not provide runtime observation evidence",
        };
      }
      const event = consumeCommand("session.list", {
        resource: "session",
        action: "list",
        target: null,
      });
      const result = event.payload.envelope?.result ?? event.payload.result ?? {};
      const running = result.sessions?.some(
        ({ name, running: isRunning }) => name === session && isRunning,
      );
      return {
        outcome: running ? "running" : "absent",
        evidence: running ? "present" : "absent",
        session,
      };
    },

    async validateLaunch({ specification } = {}) {
      assertQualifiedCompatibility(compatibility);
      if (
        !specification ||
        typeof specification !== "object" ||
        specification.harness !== harness
      ) {
        const error = new ReplayError(
          `replay launch specification does not match ${harness}`,
        );
        error.code = 2;
        error.outcome = "invalid_arguments";
        throw error;
      }
      if (!validReplayLaunchSpecification(specification, harness)) {
        const error = new ReplayError(
          `replay launch specification for ${harness} is incomplete`,
        );
        error.code = 0;
        error.outcome = "unsupported_configuration";
        throw error;
      }
      return {
        outcome: "validated",
        evidence: "present",
        compatibility,
      };
    },

    async observeAgent(agent) {
      return observeAgentFromTrace(agent);
    },

    async observeAgents(agents = []) {
      const event = consumeAgentEvent("agent.list", {
        resource: "agent",
        action: "list",
        target: null,
      });
      const observed = agents.map((agent) =>
        semanticAgentObservation(agent, findAgent(event, agentName(agent))),
      );
      return observed;
    },

    async waitForAgent(agent) {
      let observation;
      if (timeline.peek()?.operation === "agent.list") {
        const event = consumeAgentEvent("agent.list", {
          resource: "agent",
          action: "list",
          target: null,
        });
        observation = semanticAgentObservation(
          agent,
          findAgent(event, agentName(agent)),
        );
      }
      if (observation && observation.state !== "working") {
        return { ...observation, outcome: "observed" };
      }
      if (timeline.peek()?.operation !== "agent.wait") {
        return {
          schema: "drovr.semantic-agent-observation/v1",
          outcome: "uncertain",
          evidence: "uncertain",
          expected_identity: registeredIdentity(agent),
          identity: null,
          state: "unknown",
          error: "replay did not provide an agent wait observation",
        };
      }
      const event = consumeAgentEvent("agent.wait", {
        resource: "agent",
        action: "wait",
        target: agentName(agent),
      });
      return {
        ...semanticAgentObservation(agent, findAgent(event, agentName(agent))),
        outcome: "observed",
      };
    },

    async startAgent({ agent } = {}) {
      assertReplayMutationCompatibility();
      consumeCommand("agent.start", requestFor("start", agent));
      return observeAgentFromTrace(agent);
    },

    async resumeAgent({ agent } = {}) {
      assertReplayMutationCompatibility();
      consumeCommand("agent.resume", requestFor("resume", agent));
      return { outcome: "resumed", evidence: "present" };
    },

    async prepareTurn({ agent } = {}) {
      return {
        cursor: await transcript.captureCursor(),
        identity: registeredIdentity(agent),
      };
    },

    async deliverTurn({ agent, prompt, observed } = {}) {
      assertReplayMutationCompatibility();
      const before = observed ?? (await observeAgentFromTrace(agent));
      assertDeliverableAgent(agent, before);
      const event = harness === "claude"
        ? await deliverClaudeTurn(agent, prompt, before)
        : consumeCommand(
            "agent.prompt",
            requestFor("prompt", agent, prompt),
          );
      return {
        outcome: "submitted",
        evidence: "present",
        identity: before.identity,
        transition_token: before.transition_token,
        native: event.payload?.envelope?.result ?? event.payload?.result ?? {},
      };
    },

    async waitForTurn({ agent, turn, timeoutMs } = {}) {
      const startedAt = clock.now();
      let last;
      for (;;) {
        const remaining = timeoutMs === undefined
          ? undefined
          : Math.max(0, timeoutMs - (clock.now() - startedAt));
        if (remaining === 0) {
          return {
            schema: "drovr.semantic-turn-evidence/v1",
            outcome: "still_running",
            evidence: last?.evidence ?? "uncertain",
            observation: last,
          };
        }
        const next = timeline.peek();
        if (!next) {
          return turnEvidence("still_running", last);
        }
        if (next.kind === "delay") {
          await clock.delay(next.payload.duration_ms);
          continue;
        }
        if (next.kind === "transcript_event") {
          if (
            last?.evidence !== "present" ||
            !["idle", "done"].includes(last.state)
          ) {
            return turnEvidence("uncertain", last, {
              error:
                "replay cannot correlate a turn without settled identity evidence",
            });
          }
          const correlated = await correlateReplayTurn({
            transcript,
            agent,
            turn,
            observed: last,
          });
          if (correlated.outcome === "completed") return correlated;
          if (timeline.peek()?.kind === "delay") continue;
          return correlated;
        }
        if (!["agent.list", "agent.wait"].includes(next.operation)) {
          return turnEvidence("uncertain", last, {
            error: `replay cannot settle turn before ${next.operation}`,
          });
        }
        const event = consumeAgentEvent(next.operation, {
          resource: "agent",
          action: next.operation === "agent.wait" ? "wait" : "list",
          target: next.operation === "agent.wait" ? agentName(agent) : null,
        });
        last = semanticAgentObservation(
          agent,
          findAgent(event, agentName(agent)),
        );
        if (last.evidence !== "present") {
          return turnEvidence(
            last.evidence === "absent" ? "agent_lost" : "uncertain",
            last,
          );
        }
        if (last.state === "blocked") {
          const excerpt = consumeCommand(
            "agent.read.recent-unwrapped",
            requestFor("excerpt", agent),
          );
          return turnEvidence("needs_input", last, {
            excerpt: excerpt.payload.text ?? excerpt.payload.envelope?.result,
          });
        }
        if (["idle", "done"].includes(last.state)) {
          const correlated = await correlateReplayTurn({
            transcript,
            agent,
            turn,
            observed: last,
          });
          if (correlated.outcome === "completed") return correlated;
          if (timeline.peek()?.kind === "delay") continue;
          return correlated;
        }
      }
    },

    async getLateResult({ agent, turn, alternateInputs = [] } = {}) {
      const inputs = [
        turn?.inputs?.map(({ text }) => text) ?? [],
        ...alternateInputs,
      ];
      for (const candidate of inputs) {
        try {
          return {
            result: await transcript.extract(
              turn.transcript_cursor,
              candidate,
            ),
            transcript_cursor: turn.transcript_cursor,
          };
        } catch {
          // Late-result recovery is read-only and accepts only exact caller
          // supplied input combinations.
        }
      }
      return null;
    },

    async interruptTurn({ agent, observed, deferSettlementObservation = false } = {}) {
      assertReplayMutationCompatibility();
      // A caller-supplied observation may be stale. Every replayed gesture
      // must consume the exact identity proof captured immediately before the
      // native send-keys event.
      const guardEvent = consumeAgentEvent("agent.list", {
        resource: "agent",
        action: "list",
        target: null,
      });
      const before = semanticAgentObservation(
        agent,
        findAgent(guardEvent, agentName(agent)),
      );
      if (before.evidence !== "present") {
        return turnEvidence(
          before.evidence === "absent" ? "agent_lost" : "uncertain",
          before,
        );
      }
      if (["idle", "done"].includes(before.state)) {
        return turnEvidence("already_settled", before);
      }
      consumeCommand("agent.send-keys", requestFor("interrupt", agent));
      if (deferSettlementObservation) {
        return turnEvidence("interrupted", before, {
          settlement: "observation_pending",
        });
      }
      const after = await observeAgentFromTrace(agent);
      return after.evidence === "present" && ["idle", "done"].includes(after.state)
        ? turnEvidence("cancelled", after)
        : turnEvidence("uncertain", after);
    },

    async inspectStagedInput({ agent } = {}) {
      if (harness !== "claude") {
        return stagedEvidence(agent, "ready", "absent", null);
      }
      if (
        timeline.peek()?.operation !== "agent.read.visible" &&
        cachedStagedEvidence?.snapshot &&
        cachedStagedEvidenceFresh
      ) {
        // Recovery may have consumed the latest pane snapshot while proving a
        // contradiction. Reusing that exact fresh evidence is safe; a later
        // agent observation invalidates it below.
        stagedInspectionIdentityFresh = false;
        return cachedStagedEvidence;
      }
      if (timeline.peek()?.operation !== "agent.read.visible" && cachedStagedEvidence) {
        stagedInspectionIdentityFresh = false;
        return {
          ...cachedStagedEvidence,
          outcome: "recovery_blocked",
          evidence: "uncertain",
          snapshot: null,
          reason: "replay did not provide a fresh staged-input snapshot",
        };
      }
      const snapshotEvent = consumePaneSnapshot(agent);
      const snapshot = claudePromptBoxSnapshot(snapshotEvent.payload.text);
      let observed = lastObservedIdentity(agent);
      stagedInspectionIdentityFresh = false;
      if (timeline.peek()?.operation === "agent.list") {
        observed = await observeAgentFromTrace(agent);
        stagedInspectionIdentityFresh = true;
      }
      if (observed && observed.evidence !== "present") {
        cachedStagedEvidence = {
          ...stagedEvidence(agent, "recovery_blocked", observed.evidence, snapshot),
          identity: observed.identity,
          expected_identity: observed.expected_identity,
        };
        cachedStagedEvidenceFresh = Boolean(snapshot);
        return cachedStagedEvidence;
      }
      cachedStagedEvidence = stagedEvidence(
        agent,
        snapshot ? "staged_input" : "ready",
        snapshot ? "present" : "absent",
        snapshot,
        observed,
      );
      cachedStagedEvidenceFresh = Boolean(snapshot);
      return cachedStagedEvidence;
    },

    async recoverStagedInput({ agent, action, token, stabilityIntervalMs = 30_000 } = {}) {
      assertReplayMutationCompatibility();
      const before = await inspectStagedForRecovery(agent);
      if (before.evidence !== "present" || !before.snapshot) {
        throw recoveryBlocked(before);
      }
      if (!Number.isSafeInteger(before.transition_token)) {
        throw recoveryBlocked({
          ...before,
          reason: "staged snapshot lacks an exact native transition token",
        });
      }
      if (before.snapshot.token !== token) {
        const blocked = {
          ...before,
          evidence: "changed",
          reason: "staged snapshot token changed",
        };
        cachedStagedEvidence = blocked;
        cachedStagedEvidenceFresh = true;
        throw recoveryBlocked(blocked);
      }
      if (action !== "clear" && action !== "submit") {
        throw recoveryBlocked({ ...before, reason: "unsupported recovery action" });
      }
      const guarded = stagedInspectionIdentityFresh
        ? before
        : await observeAgentFromTrace(agent);
      stagedInspectionIdentityFresh = false;
      if (
        guarded.evidence !== "present" ||
        !sameManagedTarget(before.identity, guarded.identity)
      ) {
        throw recoveryBlocked({
          ...guarded,
          reason: "managed identity changed before staged-input recovery",
        });
      }
      consumeCommand("agent.send-keys", requestFor(action, agent, token));
      const afterIdentity = await observeAgentFromTrace(agent);
      if (afterIdentity.evidence !== "present") {
        throw recoveryBlocked(afterIdentity);
      }
      if (action === "submit") {
        cachedStagedEvidence = {
          ...stagedEvidence(agent, "submitted", "present", null, afterIdentity),
          stability: { interval_ms: 0, observations: 1 },
        };
        cachedStagedEvidenceFresh = false;
        return cachedStagedEvidence;
      }
      const immediate = consumePaneSnapshot(agent);
      const immediateSnapshot = claudePromptBoxSnapshot(immediate.payload.text);
      if (immediateSnapshot) {
        cachedStagedEvidence = {
          ...stagedEvidence(
            agent,
            "clear_contradicted",
            "changed",
            immediateSnapshot,
            afterIdentity,
          ),
          contradiction: "staged_snapshot_reappeared",
          stability: { interval_ms: 0, observations: 1 },
        };
        return cachedStagedEvidence;
      }
      let elapsed = 0;
      let observations = 1;
      while (elapsed < stabilityIntervalMs && timeline.peek()?.kind === "delay") {
        const duration = timeline.peek().payload.duration_ms;
        await clock.delay(duration);
        let intervalIdentity = afterIdentity;
        if (timeline.peek()?.operation === "agent.list") {
          intervalIdentity = await observeAgentFromTrace(agent);
          if (
            intervalIdentity.evidence !== "present" ||
            !sameManagedTarget(afterIdentity.identity, intervalIdentity.identity)
          ) {
            cachedStagedEvidence = {
              ...stagedEvidence(
                agent,
                "clear_unstable",
                intervalIdentity.evidence,
                null,
                intervalIdentity,
              ),
              stability: { interval_ms: elapsed, observations: observations + 1 },
              reason: "managed identity changed during staged-input clearing",
            };
            cachedStagedEvidenceFresh = false;
            return cachedStagedEvidence;
          }
        }
        if (timeline.peek()?.operation !== "agent.read.visible") {
          cachedStagedEvidence = {
            ...stagedEvidence(
              agent,
              "clear_unstable",
              "uncertain",
              null,
              intervalIdentity,
            ),
            stability: { interval_ms: elapsed, observations },
            reason: "replay did not provide a staged-input snapshot during stability",
          };
          cachedStagedEvidenceFresh = false;
          return cachedStagedEvidence;
        }
        elapsed += duration;
        const nextSnapshot = consumePaneSnapshot(agent);
        observations += 1;
        const reappeared = claudePromptBoxSnapshot(nextSnapshot.payload.text);
        if (reappeared) {
          cachedStagedEvidence = {
            ...stagedEvidence(
              agent,
              "clear_contradicted",
              "changed",
              reappeared,
              afterIdentity,
            ),
            contradiction: "staged_snapshot_reappeared",
            stability: { interval_ms: elapsed, observations },
          };
          cachedStagedEvidenceFresh = true;
          return cachedStagedEvidence;
        }
      }
      if (elapsed < stabilityIntervalMs) {
        cachedStagedEvidence = {
          ...stagedEvidence(agent, "clear_unstable", "uncertain", null, afterIdentity),
          stability: { interval_ms: elapsed, observations },
        };
        cachedStagedEvidenceFresh = false;
        return cachedStagedEvidence;
      }
      cachedStagedEvidence = {
        ...stagedEvidence(agent, "cleared", "present", null, afterIdentity),
        stability: { interval_ms: elapsed, observations },
      };
      cachedStagedEvidenceFresh = false;
      return cachedStagedEvidence;
    },

    async stageUnknownInput() {
      assertReplayMutationCompatibility();
      throw new Error("replay does not authorize unknown staged input");
    },

    async validateRecovery({ agent } = {}) {
      if (timeline.peek()?.operation !== "transcript.validate") {
        return {
          outcome: "recovery_blocked",
          evidence: "uncertain",
          identity: registeredIdentity(agent),
          reason: "replay did not provide transcript validation evidence",
        };
      }
      const event = consumeCommand("transcript.validate", {
        resource: "transcript",
        action: "validate",
        target: agent?.native_session ?? null,
      });
      const result = event.payload.envelope?.result ?? event.payload.result ?? {};
      if (result.status !== "validated" && result.valid !== true) {
        return {
          outcome: "recovery_blocked",
          evidence: "uncertain",
          identity: registeredIdentity(agent),
          reason: result.reason ?? "replay transcript validation did not succeed",
        };
      }
      return {
        outcome: "validated",
        evidence: "present",
        identity: registeredIdentity(agent),
      };
    },

    async attach({ agent } = {}) {
      assertReplayMutationCompatibility();
      if (timeline.peek()?.operation !== "agent.attach") {
        return {
          outcome: "uncertain",
          evidence: "uncertain",
          exit_code: 4,
          reason: "replay did not provide attachment evidence",
        };
      }
      const event = consumeCommand("agent.attach", {
        resource: "agent",
        action: "attach",
        target: agentName(agent),
      });
      const result = event.payload.envelope?.result ?? event.payload.result ?? {};
      const exitCode = result.exit_code ?? result.code ?? 4;
      return {
        outcome: exitCode === 0 ? "attached" : "attach_failed",
        evidence: exitCode === 0 ? "present" : "uncertain",
        exit_code: exitCode,
      };
    },

    topology: Object.fromEntries(
      SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS.map((operation) => [
        operation,
        async () => {
          if (requireCompatibility) assertReplayMutationCompatibility();
          return {
            outcome: "unavailable",
            evidence: "absent",
            reason: "topology is not represented by this trace",
          };
        },
      ]),
    ),
  };

  function assertReplayMutationCompatibility() {
    assertQualifiedCompatibility(compatibility);
  }

  function consumeAgentEvent(operation, request) {
    if (operation === "agent.list") {
      cachedStagedEvidenceFresh = false;
      stagedInspectionIdentityFresh = false;
    }
    const event = consumeEvent(operation, request);
    if (event.kind === "error") throw replayErrorFromEvent(event, operation);
    return event;
  }

  function consumeCommand(operation, request) {
    const event = consumeEvent(operation, request);
    if (event.kind === "error") throw replayErrorFromEvent(event, operation);
    return event;
  }

  function consumeEvent(operation, request) {
    try {
      return timeline.consumeOperation(operation, request, clock.now());
    } catch (error) {
      throw replayOperationError(error, operation);
    }
  }

  function consumePaneSnapshot(agent) {
    return consumeEvent("agent.read.visible", {
      resource: "agent",
      action: "read",
      target: agentName(agent),
      source: "visible",
    });
  }

  function observeAgentFromTrace(agent) {
    const event = consumeAgentEvent("agent.list", {
      resource: "agent",
      action: "list",
      target: null,
    });
    return semanticAgentObservation(agent, findAgent(event, agentName(agent)));
  }

  async function deliverClaudeTurn(agent, prompt, before) {
    const visibleBefore = consumePaneSnapshot(agent);
    if (claudePromptBoxSnapshot(visibleBefore.payload.text)) {
      const error = new Error(
        `Claude already has staged prompt text for ${agentName(agent)}`,
      );
      error.code = 4;
      error.outcome = "adapter_failure";
      throw error;
    }
    const promptEvent = consumeCommand(
      "agent.prompt",
      requestFor("prompt", agent, prompt),
    );
    let latest = before;
    let staged = false;
    for (;;) {
      const next = timeline.peek();
      if (!next) {
        const error = new Error(
          `replay did not confirm Claude prompt submission for ${agentName(agent)}`,
        );
        error.code = 4;
        error.outcome = "adapter_failure";
        throw error;
      }
      if (next.kind === "delay") {
        await clock.delay(next.payload.duration_ms);
        continue;
      }
      if (next.operation === "agent.list") {
        const event = consumeAgentEvent("agent.list", {
          resource: "agent",
          action: "list",
          target: null,
        });
        latest = semanticAgentObservation(
          agent,
          findAgent(event, agentName(agent)),
        );
        if (latest.evidence !== "present") {
          const error = new Error("Claude native identity changed during delivery");
          error.code = 0;
          error.outcome = "recovery_blocked";
          error.details = { observation: latest };
          throw error;
        }
        if (["working", "blocked"].includes(latest.state)) {
          return promptEvent;
        }
        continue;
      }
      if (next.operation === "agent.read.visible") {
        const visible = consumePaneSnapshot(agent);
        staged ||= Boolean(claudePromptBoxSnapshot(visible.payload.text)) ||
          /\[Pasted text #/u.test(String(visible.payload.text));
        continue;
      }
      if (next.operation === "agent.send-keys") {
        if (!staged) {
          const error = new Error("Claude staged input was not proven before submit");
          error.code = 4;
          error.outcome = "adapter_failure";
          throw error;
        }
        consumeCommand("agent.send-keys", requestFor("submit", agent));
        continue;
      }
      const error = new Error(
        `replay encountered ${next.operation} before Claude prompt submission`,
      );
      error.code = 4;
      error.outcome = "adapter_failure";
      throw error;
    }
  }

  function lastObservedIdentity(agent) {
    const consumed = timeline.consumedEvents();
    for (let index = consumed.length - 1; index >= 0; index -= 1) {
      const event = consumed[index];
      if (event.operation !== "agent.list") continue;
      return semanticAgentObservation(agent, findAgent(event, agentName(agent)));
    }
    return null;
  }

  async function inspectStagedForRecovery(agent) {
    const inspected = await adapter.inspectStagedInput({ agent });
    if (inspected.snapshot) return inspected;
    return inspected;
  }

  function requestFor(action, agent, value) {
    const target = agentName(agent);
    if (action === "prompt") {
      return {
        resource: "agent",
        action: "prompt",
        target,
        input: sentinelInput(value),
      };
    }
    if (action === "excerpt") {
      return {
        resource: "agent",
        action: "read",
        target,
        source: "recent-unwrapped",
      };
    }
    return {
      resource: "agent",
      action: action === "interrupt" || action === "clear" || action === "submit"
        ? "send-keys"
        : action,
      target,
      ...(keyInput(action) ? { input: sentinelInput(keyInput(action)) } : {}),
    };
  }

  function keyInput(action) {
    return {
      interrupt: "ctrl+c",
      clear: "esc esc",
      submit: "enter",
    }[action];
  }

  return adapter;
}

async function correlateReplayTurn({ transcript, agent, turn, observed }) {
  const cursor = turn?.transcript_cursor ?? await transcript.captureCursor();
  const inputs = turn?.inputs?.map(({ text }) => text) ?? [];
  try {
    const result = await transcript.extract(cursor, inputs);
    return {
      schema: "drovr.semantic-turn-evidence/v1",
      outcome: "completed",
      evidence: "present",
      observation: observed,
      transcript_cursor: cursor,
      result,
    };
  } catch (error) {
    return {
      schema: "drovr.semantic-turn-evidence/v1",
      outcome: error.details?.correlation_pending ? "correlation_pending" : "uncertain",
      evidence: observed?.evidence ?? "uncertain",
      observation: observed,
      transcript_cursor: cursor,
      error: error.message,
      correlation_stage: error.details?.correlation_stage,
    };
  }
}

function replayErrorFromEvent(event, operation) {
  const detail = event.payload.error;
  const failure = new ReplayError(detail.message, {
    operation,
    sequence: event.sequence,
  });
  failure.stderr = JSON.stringify({
    schema: "herdr.error/v1",
    error: detail,
  });
  const error = new Error(`replay ${operation} failed: ${detail.message}`);
  error.code = detail.code ?? 4;
  error.outcome = detail.outcome ?? "adapter_failure";
  error.adapterFailure = failure;
  error.details = detail.details;
  return error;
}

function replayOperationError(error, operation) {
  if (error?.adapterFailure) return error;
  const wrapped = new Error(`replay ${operation} failed: ${error.message}`);
  wrapped.code = 4;
  wrapped.outcome = "adapter_failure";
  wrapped.adapterFailure = error;
  wrapped.details = error.details;
  return wrapped;
}

function assertDeliverableAgent(agent, observation) {
  if (observation?.evidence === "present") return;
  const error = new Error(
    `managed agent ${agentName(agent)} identity is ${observation?.evidence ?? "uncertain"}`,
  );
  error.code = 0;
  error.outcome = observation?.evidence === "absent"
    ? "agent_lost"
    : "recovery_blocked";
  error.details = { observation };
  throw error;
}

function recoveryBlocked(observation) {
  const error = new Error(
    observation?.reason ?? "staged-input recovery could not prove exact ownership",
  );
  error.code = 0;
  error.outcome = "recovery_blocked";
  error.details = { observation };
  return error;
}

function semanticAgentObservation(agent, observed, error) {
  const expected = registeredIdentity(agent);
  if (error) {
    return {
      schema: "drovr.semantic-agent-observation/v1",
      evidence: "uncertain",
      expected_identity: expected,
      identity: null,
      state: "unknown",
      error,
    };
  }
  if (!observed) {
    return {
      schema: "drovr.semantic-agent-observation/v1",
      evidence: "absent",
      expected_identity: expected,
      identity: null,
      state: "absent",
      transition_token: null,
    };
  }
  const identity = {
    managed_agent: observed.name ?? agentName(agent),
    pane: observed.pane_id ?? null,
    native_session: observed.agent_session?.value ?? null,
  };
  const result = identityEvidence(expected, identity);
  return {
    schema: "drovr.semantic-agent-observation/v1",
    evidence: result.evidence,
    expected_identity: expected,
    identity,
    state: observed.agent_status ?? "unknown",
    transition_token: observed.state_change_seq ?? null,
    native: observed,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.pane_changed ? { pane_changed: true } : {}),
  };
}

function registeredIdentity(agent) {
  return {
    managed_agent: agent?.herdr?.name ?? agent?.name ?? null,
    pane: agent?.herdr?.pane_id ?? agent?.pane_id ?? null,
    native_session: agent?.native_session ?? null,
  };
}

function validReplayLaunchSpecification(specification, harness) {
  return (
    typeof specification.model === "string" &&
    specification.model.length > 0 &&
    ["low", "medium", "high", "xhigh"].includes(specification.effort) &&
    [
      "read-only",
      "on-approve",
      "workspace-write",
      "auto",
      "unrestricted",
    ].includes(specification.capability) &&
    typeof specification.instructions === "string" &&
    isRecord(specification.native) &&
    isRecord(specification.catalog_fingerprints) &&
    (harness === "claude" || harness === "codex")
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameManagedTarget(left, right) {
  if (!left || !right) return false;
  if (left.managed_agent !== right.managed_agent) return false;
  if (left.pane !== right.pane) return false;
  return !left.native_session || left.native_session === right.native_session;
}

function agentName(agent) {
  return typeof agent === "string"
    ? agent
    : agent?.herdr?.name ?? agent?.name ?? null;
}

function findAgent(event, name) {
  const result = event.payload.envelope?.result ?? event.payload.result ?? {};
  const candidates = Array.isArray(result.agents)
    ? result.agents
    : result.agent
      ? [result.agent]
      : [];
  return candidates.find((candidate) => candidate?.name === name) ??
    (candidates.length === 1 ? candidates[0] : undefined);
}

function turnEvidence(outcome, observation, details = {}) {
  return {
    schema: "drovr.semantic-turn-evidence/v1",
    outcome,
    evidence: observation?.evidence ?? "uncertain",
    observation,
    ...details,
  };
}

function stagedEvidence(agent, outcome, evidence, snapshot, observed) {
  const semanticSnapshot = snapshot
    ? {
        token: observed
          ? bindStagedInputToken(snapshot.token, observed.transition_token)
          : null,
        display_text: snapshot.display_text,
      }
    : null;
  return {
    schema: "drovr.semantic-staged-input/v1",
    outcome,
    evidence,
    snapshot: semanticSnapshot
      ? {
          token: semanticSnapshot.token,
          display_text: semanticSnapshot.display_text,
        }
      : null,
    identity: observed?.identity ?? registeredIdentity(agent),
    ...(observed?.expected_identity
      ? { expected_identity: observed.expected_identity }
      : {}),
    ...(observed?.transition_token !== undefined
      ? { transition_token: observed.transition_token }
      : {}),
    ...(snapshot && !semanticSnapshot.token
      ? {
          reason: "staged snapshot lacks an exact native transition token",
        }
      : {}),
  };
}

function claudePromptBoxSnapshot(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const dividers = lines.flatMap((line, index) =>
    /^\s*[─━-]{3,}\s*$/u.test(line) ? [index] : [],
  );
  if (dividers.length < 2) return null;
  const region = lines.slice(dividers.at(-2) + 1, dividers.at(-1));
  const promptLine = region.findIndex((line) => /^\s*❯/u.test(line));
  if (promptLine < 0) return null;
  const displayText = [
    region[promptLine].replace(/^\s*❯[ \u00a0]?/u, ""),
    ...region.slice(promptLine + 1),
  ].join("\n").trimEnd();
  if (displayText.trim().length === 0) return null;
  return {
    token: stagedInputTextToken(displayText),
    display_text: displayText,
  };
}

function sentinelInput(value) {
  if (/^(?:QUALIFY|REPLAY|TRACE)-[A-Z0-9_-]+$/u.test(value)) {
    return { sentinel: value };
  }
  return {
    length: value.length,
    sha256: `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
}

function createReplayTranscriptAdapter(timeline, clock, harness) {
  const adapter = `replay-${harness}/v1`;
  return {
    adapter,
    root: `replay:${timeline.trace.scenario_id}`,
    locate: async () => `replay:${timeline.trace.scenario_id}`,
    validateTranscript: async () => true,
    captureCursor: async () => cursor(adapter, clock.now()),
    captureInventory: async () => cursor(adapter, clock.now()),
    resolveInventory: async () => cursor(adapter, clock.now()),
    extract: async (cursorValue, inputs) => {
      if (
        cursorValue?.adapter !== adapter ||
        cursorValue?.path !== "replay://trace"
      ) {
        throw new ReplayError("replay transcript cursor does not belong to this adapter");
      }
      const records = timeline.transcriptRecords(harness, clock.now());
      return correlateTranscriptRecords(records, inputs, {
        harness: harness === "claude" ? "Claude" : "Codex",
        userText: harness === "claude" ? claudeUserText : codexUserText,
        finalAssistantText:
          harness === "claude" ? claudeAssistantText : codexAssistantText,
      });
    },
  };
}

function cursor(adapter, atMs) {
  return {
    adapter,
    path: "replay://trace",
    offset: 0,
    anchor_start: 0,
    anchor_sha256: "",
    captured_at_ms: atMs,
  };
}

class ReplayTimeline {
  constructor(trace) {
    this.trace = trace;
    this.consumed = new Set();
  }

  consumeOperation(operation, args, now) {
    const event = this.nextUnconsumed(now);
    if (!event) {
      throw new ReplayError(`replay ended before ${operation}`, { operation });
    }
    if (event.kind === "transcript_event") {
      throw new ReplayError(
        `replay requires consuming transcript event ${event.sequence} before ${operation}`,
        { operation, expected: "transcript_event", sequence: event.sequence },
      );
    }
    if (event.kind === "delay") {
      throw new ReplayError(
        `replay requires advancing the clock before ${operation}`,
        { operation, expected: "delay", sequence: event.sequence },
      );
    }
    if (event.operation !== operation) {
      throw new ReplayError(
        `replay expected ${event.operation}, received ${operation}`,
        { expected: event.operation, received: operation, sequence: event.sequence },
      );
    }
    if (event.payload.request !== undefined) {
      const actualRequest = Array.isArray(args) ? traceRequest(args) : args;
      const expectedRequest = operation === "agent.read.visible" &&
          event.payload.request.input !== undefined &&
          actualRequest.input === undefined
        ? Object.fromEntries(
            Object.entries(event.payload.request).filter(
              ([key]) => key !== "input",
            ),
          )
        : event.payload.request;
      if (
        JSON.stringify(canonicalizeJson(expectedRequest)) !==
        JSON.stringify(canonicalizeJson(actualRequest))
      ) {
        throw new ReplayError(
          `replay request for ${operation} does not match the trace`,
          {
            operation,
            sequence: event.sequence,
            expected_request: expectedRequest,
            received_request: actualRequest,
          },
        );
      }
    }
    if (event.at_ms > now) {
      throw new ReplayError(
        `replay event ${event.sequence} is not available until ${event.at_ms}ms`,
        { operation, sequence: event.sequence, available_at_ms: event.at_ms },
      );
    }
    this.consumed.add(event.sequence);
    return event;
  }

  peek() {
    return this.nextUnconsumed();
  }

  consumeDelay(requestedMs, now) {
    const event = this.nextUnconsumed(now, { skipFutureTranscript: true });
    if (!event || event.kind !== "delay") {
      if (event?.kind === "transcript_event") {
        throw new ReplayError(
          `replay requires consuming transcript event ${event.sequence} before advancing time`,
          { expected: "transcript_event", sequence: event.sequence },
        );
      }
      throw new ReplayError("replay requested an unrecorded delay", {
        requested_ms: requestedMs,
        at_ms: now,
      });
    }
    if (event.at_ms < now) {
      throw new ReplayError("replay delay is earlier than the current clock", {
        sequence: event.sequence,
      });
    }
    if (requestedMs !== event.payload.duration_ms) {
      throw new ReplayError("replay delay duration does not match the trace", {
        requested_ms: requestedMs,
        recorded_ms: event.payload.duration_ms,
        sequence: event.sequence,
      });
    }
    this.consumed.add(event.sequence);
    return event;
  }

  transcriptRecords(harness, now) {
    const records = [];
    for (const event of this.trace.events) {
      if (this.consumed.has(event.sequence)) continue;
      if (event.kind !== "transcript_event") break;
      if (event.at_ms > now) break;
      if (event.payload.harness !== harness) break;
      this.consumed.add(event.sequence);
      records.push(event.payload.record);
    }
    return records;
  }

  remainingEvents() {
    return this.trace.events.filter(({ sequence }) => !this.consumed.has(sequence));
  }

  consumedEvents() {
    return this.trace.events.filter(({ sequence }) => this.consumed.has(sequence));
  }

  nextUnconsumed(now, { skipFutureTranscript = false } = {}) {
    for (const event of this.trace.events) {
      if (this.consumed.has(event.sequence)) continue;
      if (skipFutureTranscript && event.kind === "transcript_event" && event.at_ms > now) {
        continue;
      }
      return event;
    }
    return undefined;
  }
}

function codexUserText(record) {
  if (record?.type === "event_msg" && record.payload?.type === "user_message") {
    return typeof record.payload.message === "string" ? record.payload.message : null;
  }
  if (
    record?.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "user"
  ) {
    return textContent(record.payload.content, "input_text");
  }
  return null;
}

function claudeUserText(record) {
  if (record?.type !== "user" || record.message?.role !== "user") return null;
  return textContent(record.message.content, "text");
}

function codexAssistantText(record) {
  if (
    record?.type !== "response_item" ||
    record.payload?.type !== "message" ||
    record.payload?.role !== "assistant" ||
    (record.payload.phase ?? "final_answer") !== "final_answer"
  ) return null;
  return textContent(record.payload.content, "output_text");
}

function claudeAssistantText(record) {
  if (
    record?.type !== "assistant" ||
    record.message?.role !== "assistant" ||
    record.message.stop_reason !== "end_turn"
  ) return null;
  return textContent(record.message.content, "text");
}

function textContent(content, type) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((item) => item?.type === type && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
  return text.length > 0 ? text : null;
}
