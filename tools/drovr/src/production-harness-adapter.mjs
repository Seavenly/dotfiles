import { homedir } from "node:os";
import { join } from "node:path";

import {
  captureClaudeTranscriptCursor,
  captureClaudeTranscriptInventory,
  extractClaudeTurn,
  locateClaudeTranscript,
  resolveClaudeInventoryCursor,
  validateClaudeTranscript,
} from "./claude-transcript.mjs";
import {
  prepareClaudeLaunch,
  validateClaudeLaunchSpecification,
} from "./claude.mjs";
import { validateCodexLaunchSpecification } from "./codex.mjs";
import {
  assertQualifiedCompatibility,
  collectProductionCompatibility,
  PRODUCTION_ADAPTER_ID,
  qualifyCompatibility,
} from "./compatibility.mjs";
import {
  captureTranscriptCursor,
  captureTranscriptInventory,
  extractCodexTurn,
  locateCodexTranscript,
  resolveInventoryCursor,
  validateCodexTranscript,
} from "./codex-transcript.mjs";
import { DrovrError } from "./errors.mjs";
import { HerdrClient } from "./herdr.mjs";
import { identityEvidence } from "./semantic-evidence.mjs";
import {
  bindStagedInputToken,
  stagedInputTextToken,
} from "./staged-input-receipt.mjs";
import { turnAwaitsPostDeliverySettlement } from "./turn-record.mjs";

const AGENT_OBSERVATION_SCHEMA = "drovr.semantic-agent-observation/v1";
const TURN_EVIDENCE_SCHEMA = "drovr.semantic-turn-evidence/v1";
const STAGED_INPUT_EVIDENCE_SCHEMA = "drovr.semantic-staged-input/v1";
const STARTUP_STABILITY_MS = 2_000;
const STARTUP_STABILITY_ATTEMPTS = 60;
const MAX_STAGED_INPUT_STABILITY_MS = 120_000;

export function createProductionSemanticHarness({
  session,
  harness = "codex",
  env = process.env,
  run,
  herdr,
  delay,
  stabilityIntervalMs = configuredStabilityInterval(env),
  monotonicNow,
  clock = monotonicNow ?? (() => performance.now()),
  wallClock = Date.now,
  compatibility,
  expectedCompatibility,
  expectedCompatibilityEvidenceDigest,
  expectedCompatibilityBindings = [],
  compatibilityBindingFailure,
  requireCompatibilityBinding = false,
  requireCompatibility = false,
} = {}) {
  const client =
    herdr ??
    new HerdrClient({
      session,
      env,
      run,
      ...(delay ? { delay } : {}),
  });
  const native = productionNativeAdapter(harness, env);
  let qualifiedCompatibility = compatibility;
  const qualifiedByHarness = new Map(
    compatibility ? [[harness, compatibility]] : [],
  );
  const compatibilityRequired =
    requireCompatibility || requireCompatibilityBinding;

  async function ensureCompatibility() {
    if (!compatibilityRequired) return qualifiedCompatibility;
    if (compatibilityBindingFailure) {
      throw compatibilityBindingError(compatibilityBindingFailure);
    }
    const bindings = expectedCompatibilityBindings.length > 0
      ? expectedCompatibilityBindings
      : expectedCompatibilityEvidenceDigest
        ? [{
            harness,
            evidence_digest: expectedCompatibilityEvidenceDigest,
          }]
        : [];
    if (requireCompatibilityBinding && bindings.length === 0) {
      throw compatibilityBindingError({
        expected: null,
        observed: null,
        reason: "missing",
      });
    }
    const primaryExpected = bindings.find(
      ({ harness: bindingHarness }) => bindingHarness === harness,
    )?.evidence_digest;
    qualifiedCompatibility = await qualifiedCompatibilityFor(
      harness,
      qualifiedCompatibility,
      expectedCompatibility,
      primaryExpected,
    );
    for (const binding of bindings) {
      const observed = binding.harness === harness
        ? qualifiedCompatibility
        : await qualifiedCompatibilityFor(binding.harness);
      if (observed.evidence_digest !== binding.evidence_digest) {
        throw compatibilityBindingError({
          expected: binding.evidence_digest,
          observed: observed.evidence_digest,
          compatibility: observed,
          reason: "changed",
        });
      }
    }
    return qualifiedCompatibility;
  }

  async function qualifiedCompatibilityFor(
    targetHarness,
    supplied,
    expected,
    expectedEvidenceDigest,
  ) {
    let candidate = qualifiedByHarness.get(targetHarness) ?? supplied;
    if (!candidate) {
      candidate = await collectProductionCompatibility({
        harness: targetHarness,
        env,
        run,
        expected,
      });
    }
    candidate = qualifyCompatibility(candidate, {
      expected,
      harness: targetHarness,
      adapter: PRODUCTION_ADAPTER_ID,
    });
    try {
      assertQualifiedCompatibility(candidate);
    } catch (error) {
      throw new DrovrError(
        `Drovr compatibility is ${candidate?.reason ?? "unqualified"}`,
        {
          code: 0,
          outcome: "compatibility_blocked",
          details: { compatibility: candidate },
        },
      );
    }
    if (
      expectedEvidenceDigest &&
      candidate.evidence_digest !== expectedEvidenceDigest
    ) {
      throw compatibilityBindingError({
        expected: expectedEvidenceDigest,
        observed: candidate.evidence_digest,
        compatibility: candidate,
        reason: "changed",
      });
    }
    qualifiedByHarness.set(targetHarness, candidate);
    return candidate;
  }

  const adapter = {
    schema: "drovr.semantic-harness/v1",
    implementation: "production-herdr",
    capabilities: {
      topology: {
        observePane: typeof client.paneRecord === "function",
        observePaneProcess: typeof client.paneProcessInfo === "function",
        observeTab: typeof client.tabRecord === "function",
        observeWorkspace: typeof client.workspaceRecord === "function",
      },
      stagedInput: typeof client.inspectStagedInput === "function",
      compatibility: compatibilityRequired ? "required" : "optional",
    },

    async ensureRuntime() {
      await ensureCompatibility();
      await client.ensureSession?.();
      return { outcome: "ensured" };
    },

    async observeRuntime() {
      try {
        const running = await client.sessionRunning?.();
        return {
          outcome: running ? "running" : "absent",
          evidence: running ? "present" : "absent",
        };
      } catch (error) {
        return { outcome: "uncertain", evidence: "uncertain", error };
      }
    },

    async validateLaunch({ specification } = {}) {
      const launchCompatibility = await ensureCompatibility();
      await native.validate(specification, { env, run });
      return {
        outcome: "validated",
        evidence: "present",
        ...(launchCompatibility ? { compatibility: launchCompatibility } : {}),
      };
    },

    async observeAgent(agent) {
      try {
        const observed = await client.agentRecord(agent.herdr.name);
        return agentObservation(agent, observed);
      } catch (error) {
        return agentObservation(agent, undefined, error);
      }
    },

    async observeAgents(agents) {
      try {
        const observed = client.agentRecords
          ? await client.agentRecords()
          : await Promise.all(
              agents.map((agent) => client.agentRecord(agent.herdr.name)),
            );
        const byName = new Map(
          observed
            .filter((candidate) => candidate?.name)
            .map((candidate) => [candidate.name, candidate]),
        );
        if (observed.length === agents.length) {
          for (const [index, candidate] of observed.entries()) {
            if (candidate?.name || !agents[index]?.herdr?.name) continue;
            byName.set(agents[index].herdr.name, candidate);
          }
        }
        const records = agents.map((agent) =>
          agentObservation(agent, byName.get(agent.herdr.name)),
        );
        const nativeOwners = new Map();
        for (const candidate of observed.filter(Boolean)) {
          const nativeSession = candidate.agent_session?.value;
          if (nativeSession) {
            const owners = nativeOwners.get(nativeSession) ?? [];
            owners.push(candidate);
            nativeOwners.set(nativeSession, owners);
          }
        }
        return records.map((record, index) => {
          const nativeSession = agents[index].native_session ??
            record.identity?.native_session;
          const owners = nativeSession
            ? nativeOwners.get(nativeSession) ?? []
            : [];
          if (
            owners.length > 1 ||
            (owners.length > 0 && record.evidence === "absent")
          ) {
            return {
              ...record,
              evidence: "changed",
              reason: "duplicate_native_session",
            };
          }
          return record;
        });
      } catch (error) {
        return agents.map((agent) => agentObservation(agent, undefined, error));
      }
    },

    async waitForAgent(agent, { timeoutMs } = {}) {
      try {
        const observed = await waitForNativeAgent(client, agent, timeoutMs);
        if (observed?.drovr_status === "still_running") {
          return {
            ...agentObservation(agent, observed),
            outcome: "still_running",
          };
        }
        if (observed?.drovr_status === "agent_lost") {
          return {
            ...agentObservation(agent, null),
            outcome: "agent_lost",
          };
        }
        return {
          ...agentObservation(agent, observed),
          outcome: "observed",
        };
      } catch (error) {
        return {
          ...agentObservation(agent, undefined, error),
          outcome: "uncertain",
        };
      }
    },

    async startAgent({ agent, launchRuntime, registryDirectory } = {}) {
      await ensureCompatibility();
      const launch = launchRuntime ?? (await native.prepareLaunch?.(
        registryDirectory,
        agent,
      ));
      await native.startAgent(client, {
        name: agent.herdr.name,
        paneId: agent.herdr.pane_id,
        label: agent.label,
        specification: agent.launch,
        ...launch,
      });
      return waitUntilSettled(agent, client, delay, clock, 120_000);
    },

    async resumeAgent({ agent, launchRuntime, registryDirectory } = {}) {
      await ensureCompatibility();
      const launch = launchRuntime ?? (await native.prepareLaunch?.(
        registryDirectory,
        agent,
      ));
      await native.resumeAgent(client, {
        name: agent.herdr.name,
        paneId: agent.herdr.pane_id,
        label: agent.label ?? agent.key,
        specification: agent.launch,
        nativeSession: agent.native_session,
        ...launch,
      });
      return { outcome: "resumed", evidence: "present" };
    },

    async prepareTurn({ agent, task, now, inventoryBeforeDelivery = false }) {
      const capturedAt = now?.() ?? new Date().toISOString();
      let cursor;
      if (agent.native_session && !inventoryBeforeDelivery) {
        const transcriptPath = await native.locate(
          native.root,
          agent.native_session,
        );
        cursor = await native.captureCursor(transcriptPath);
      } else {
        cursor = await native.captureInventory(
          native.root,
          task.cwd,
          capturedAt,
        );
      }
      return {
        cursor,
        identity: registeredIdentity(agent),
      };
    },

    async deliverTurn({ agent, prompt, observed } = {}) {
      await ensureCompatibility();
      const before = observed ?? (await this.observeAgent(agent));
      assertDeliverableAgent(agent, before);
      try {
        await client.prompt(agent.herdr.name, prompt, {
          harness,
          nativeSession: agent.native_session ?? before.identity?.native_session,
          ...(typeof before.identity?.pane === "string"
            ? { paneId: before.identity.pane }
            : {}),
          observedBeforeDelivery: before.native,
        });
        return {
          outcome: "submitted",
          evidence: "present",
          identity: before.identity,
          transition_token: before.transition_token,
        };
      } catch (error) {
        throw semanticDeliveryError(error, before);
      }
    },

    async waitForTurn({
      agent,
      turn,
      timeoutMs,
      delay: waitDelay,
      afterBlock,
      refreshTurn,
      refreshBlock,
    } = {}) {
      const timeout = timeoutMs;
      const pause = waitDelay ?? delay ?? defaultDelay;
      const startedAt = clock();
      const correlationGraceMs = 5_000;
      let correlationDeadline;
      let correlationStage;

      if (afterBlock && !afterBlock.working_observed) {
        return waitForBlockResume({
          client,
          agent,
          afterBlock,
          timeout,
          startedAt,
          pause,
          clock,
          harness,
          refreshBlock,
        });
      }

      let last;
      for (;;) {
        const currentTurn = refreshTurn ? await refreshTurn() : turn;
        const observedInputCount = currentTurn.inputs.length;
        const remaining =
          timeout === undefined
            ? undefined
            : Math.max(0, timeout - (clock() - startedAt));
        if (remaining === 0) {
          return {
            schema: TURN_EVIDENCE_SCHEMA,
            outcome: "still_running",
            evidence: last?.evidence ?? "uncertain",
            observation: last,
          };
        }
        const raw = await waitForNativeAgent(client, agent, remaining);
        if (raw?.drovr_status === "agent_lost" || !raw) {
          return turnEvidence("agent_lost", agentObservation(agent, null), {
            error: "managed agent was lost while waiting for native settlement",
          });
        }
        if (raw.drovr_status === "still_running") {
          return {
            schema: TURN_EVIDENCE_SCHEMA,
            outcome: "still_running",
            evidence: "present",
            observation: agentObservation(agent, raw),
          };
        }
        const previous = last;
        const observed = agentObservation(agent, raw);
        last = observed;
        if (observed.evidence === "absent") {
          return turnEvidence("agent_lost", observed, {
            error: "managed agent was lost while waiting for native settlement",
          });
        }
        if (observed.evidence === "changed") {
          return turnEvidence("uncertain", observed, {
            error: nativeIdentityError(harness, observed),
          });
        }
        if (observed.evidence === "uncertain") {
          return turnEvidence("uncertain", observed, {
            error: nativeIdentityError(harness, observed),
          });
        }
        if (!agent.native_session && !observed.identity.native_session) {
          if (remaining !== undefined && remaining <= 25) {
            return turnEvidence("uncertain", observed, {
              error: `Herdr did not report the ${harnessLabel(harness)} native session identity`,
            });
          }
          await pause(Math.min(25, remaining ?? 25));
          continue;
        }

        if (observed.state === "blocked") {
          const excerpt = await client.agentExcerpt(agent.herdr.name, {
            nativeSession: agent.native_session,
          });
          return turnEvidence("needs_input", observed, { excerpt });
        }
        if (observed.state === "working") {
          const waited = await this.waitForAgent(agent, { timeoutMs: remaining });
          if (waited.outcome === "still_running") {
            return {
              schema: TURN_EVIDENCE_SCHEMA,
              outcome: "still_running",
              evidence: "present",
              observation: waited,
            };
          }
          last = waited;
          if (waited.evidence !== "present") {
            return turnEvidence(
              waited.outcome === "agent_lost" ? "agent_lost" : "uncertain",
              waited,
              {
                error:
                  waited.outcome === "agent_lost"
                    ? "managed agent was lost while waiting for native settlement"
                    : nativeIdentityError(harness, waited),
              },
            );
          }
          if (waited.state === "working") continue;
          if (waited.state === "blocked") {
            const excerpt = await client.agentExcerpt(agent.herdr.name, {
              nativeSession: agent.native_session,
            });
            return turnEvidence("needs_input", waited, { excerpt });
          }
        }

        if (["idle", "done"].includes(last.state)) {
          if (
            previous &&
            previous.transition_token !== last.transition_token &&
            last.transition_token !== null
          ) {
            correlationDeadline = clock() + correlationGraceMs;
          }
          const latestTurn = refreshTurn ? await refreshTurn() : currentTurn;
          if (latestTurn.inputs.length !== observedInputCount) {
            await pause(Math.min(25, remaining ?? 25));
            continue;
          }
          const deliveryObservationExpired =
            wallClock() >=
            deliverySettlementDeadline(latestTurn, last.transition_token);
          const correlated = await correlateTurn({
            native,
            agent,
            turn: latestTurn,
            observed: last,
            deliveryObservationExpired,
          });
          if (correlated.outcome === "correlation_pending") {
            if (!deliveryObservationExpired) {
              const stage = correlated.correlation_stage ?? "transcript";
              if (stage !== correlationStage) {
                correlationStage = stage;
                correlationDeadline = clock() + correlationGraceMs;
              }
            }
            if (
              !deliveryObservationExpired &&
              correlationDeadline !== undefined &&
              clock() < correlationDeadline
            ) {
              await pause(Math.min(25, remaining ?? 25));
              continue;
            }
            return {
              ...correlated,
              outcome: "uncertain",
              evidence: observed.evidence,
              error:
                correlated.error ??
                "submitted input was not observed after the transcript cursor",
            };
          } else {
            return correlated;
          }
        }
        if (remaining !== undefined && remaining <= 25) {
          return {
            schema: TURN_EVIDENCE_SCHEMA,
            outcome: "still_running",
            evidence: "present",
            observation: last,
          };
        }
        await pause(Math.min(25, remaining ?? 25));
      }
    },

    async getLateResult({ agent, turn, alternateInputs = [] } = {}) {
      let cursor = turn.transcript_cursor;
      try {
        if (cursor?.transcript_root) {
          const path = await native.locate(
            cursor.transcript_root,
            agent.native_session,
          );
          cursor = await native.resolveInventory(
            cursor,
            path,
            agent.native_session,
          );
        }
        const candidates = [
          turn.inputs.map(({ text }) => text),
          ...alternateInputs,
        ];
        for (const inputs of candidates) {
          try {
            const result = await native.extract(cursor, inputs);
            return { result, transcript_cursor: cursor };
          } catch {
            // An alternate recovery input is accepted only when it is supplied
            // by the durable caller as an exact known-staged combination.
          }
        }
      } catch {
        // A late projection is best effort and never changes durable state.
      }
      return null;
    },

    async interruptTurn({
      agent,
      timeoutMs,
      skipIfAlreadyRequested = false,
      timeoutOutcome = "interrupted",
    } = {}) {
      await ensureCompatibility();
      const before = await this.observeAgent(agent);
      if (before.evidence !== "present") {
        return turnEvidence(
          before.evidence === "absent" ? "agent_lost" : "uncertain",
          before,
          { error: nativeIdentityError(harness, before) },
        );
      }
      if (["idle", "done"].includes(before.state)) {
        return turnEvidence("already_settled", before);
      }
      if (!skipIfAlreadyRequested) {
        try {
          await client.interruptAgent(agent.herdr.name, {
            ...(typeof before.identity?.native_session === "string"
              ? { nativeSession: before.identity.native_session }
              : {}),
            ...(before.identity?.pane
              ? { paneId: before.identity.pane }
              : {}),
          });
        } catch (error) {
          return turnEvidence("uncertain", before, {
            error: `native interruption could not be delivered: ${error.message}`,
          });
        }
      }
      const after = await this.waitForAgent(agent, {
        timeoutMs: timeoutMs ?? 120_000,
      });
      if (
        after.evidence === "present" &&
        ["idle", "done"].includes(after.state)
      ) {
        return turnEvidence("cancelled", after);
      }
      return turnEvidence(
        after.outcome === "still_running" ? timeoutOutcome : "uncertain",
        after,
        {
          error:
            after.outcome === "still_running"
              ? "native interruption settlement could not be confirmed"
              : nativeIdentityError(harness, after),
        },
      );
    },

    async inspectStagedInput({ agent } = {}) {
      if (harness !== "claude") {
        return {
          schema: STAGED_INPUT_EVIDENCE_SCHEMA,
          outcome: "ready",
          evidence: "absent",
          snapshot: null,
          identity: registeredIdentity(agent),
        };
      }
      if (typeof client.inspectStagedInput !== "function") {
        return {
          schema: STAGED_INPUT_EVIDENCE_SCHEMA,
          outcome: "ready",
          evidence: "absent",
          snapshot: null,
          identity: registeredIdentity(agent),
        };
      }
      const observed = await this.observeAgent(agent);
      if (observed.evidence !== "present") {
        return {
          schema: STAGED_INPUT_EVIDENCE_SCHEMA,
          outcome: "recovery_blocked",
          evidence: observed.evidence,
          identity: observed.identity,
          expected_identity: observed.expected_identity,
        };
      }
      const snapshot = await client.inspectStagedInput(agent.herdr.name, {
        harness,
      });
      const nativeToken = snapshot
        ? stagedInputTextToken(snapshot.display_text)
        : null;
      const token = snapshot && snapshot.token === nativeToken
        ? bindStagedInputToken(nativeToken, observed.transition_token)
        : null;
      const reason = snapshot && snapshot.token !== nativeToken
        ? "staged snapshot token does not match its visible text"
        : snapshot && !token
          ? "staged snapshot lacks an exact native transition token"
          : null;
      return {
        schema: STAGED_INPUT_EVIDENCE_SCHEMA,
        outcome: snapshot ? "staged_input" : "ready",
        evidence: snapshot ? "present" : "absent",
        snapshot: snapshot
          ? {
              token,
              display_text: snapshot.display_text,
            }
          : null,
        identity: observed.identity,
        transition_token: observed.transition_token,
        ...(reason ? { reason } : {}),
      };
    },

    async recoverStagedInput({ agent, action, token } = {}) {
      await ensureCompatibility();
      const inspected = await this.inspectStagedInput({ agent });
      if (inspected.evidence !== "present" || !inspected.snapshot) {
        return {
          ...inspected,
          outcome: "recovery_blocked",
        };
      }
      if (!Number.isSafeInteger(inspected.transition_token)) {
        return {
          ...inspected,
          outcome: "recovery_blocked",
          reason: "staged snapshot lacks an exact native transition token",
        };
      }
      if (typeof inspected.snapshot.token !== "string") {
        return {
          ...inspected,
          outcome: "recovery_blocked",
          reason:
            inspected.reason ??
            "staged snapshot lacks an exact recovery authorization token",
        };
      }
      if (inspected.snapshot.token !== token) {
        return {
          ...inspected,
          outcome: "recovery_blocked",
          evidence: "changed",
          reason: "staged snapshot token changed",
        };
      }
      try {
        const native = await client.recoverStagedInput(agent.herdr.name, {
          action,
          harness,
          token: stagedInputTextToken(inspected.snapshot.display_text),
          transitionToken: inspected.transition_token,
          nativeSession: agent.native_session ?? inspected.identity?.native_session,
          ...(typeof inspected.identity?.pane === "string"
            ? { paneId: inspected.identity.pane }
            : {}),
        });
        if (action === "submit") {
          const submitted = await this.observeAgent(agent);
          if (
            submitted.evidence === "present" &&
            ["working", "blocked", "idle", "done"].includes(submitted.state)
          ) {
            return {
              schema: STAGED_INPUT_EVIDENCE_SCHEMA,
              outcome: "submitted",
              evidence: "present",
              identity: submitted.identity,
              transition_token: submitted.transition_token,
              stability: { interval_ms: 0, observations: 1 },
              native,
            };
          }
          return {
            schema: STAGED_INPUT_EVIDENCE_SCHEMA,
            outcome: "uncertain",
            evidence: submitted.evidence,
            identity: submitted.identity,
            error: "staged input submission did not preserve managed identity",
          };
        }
        const observations = [];
        const started = wallClock();
        for (;;) {
          const observation = await this.inspectStagedInput({ agent });
          observations.push(observation);
          if (observation.snapshot) {
            return {
              schema: STAGED_INPUT_EVIDENCE_SCHEMA,
              outcome: "clear_contradicted",
              evidence:
                observation.evidence === "present"
                  ? "changed"
                  : observation.evidence,
              snapshot: observation.snapshot,
              identity: observation.identity,
              stability: {
                interval_ms: wallClock() - started,
                observations: observations.length,
              },
              transition_token: observation.transition_token,
              contradiction: "staged_snapshot_reappeared",
            };
          }
          if (observation.evidence !== "absent") {
            return {
              schema: STAGED_INPUT_EVIDENCE_SCHEMA,
              outcome: "clear_unstable",
              evidence: observation.evidence,
              identity: observation.identity,
              stability: {
                interval_ms: wallClock() - started,
                observations: observations.length,
              },
              transition_token: observation.transition_token,
              reason: "managed identity changed during staged-input clearing",
            };
          }
          const elapsed = wallClock() - started;
          if (elapsed >= stabilityIntervalMs) {
            const finalObservation = await this.observeAgent(agent);
            if (finalObservation.evidence !== "present") {
              return {
                schema: STAGED_INPUT_EVIDENCE_SCHEMA,
                outcome: "clear_unstable",
                evidence: finalObservation.evidence,
                identity: finalObservation.identity,
                stability: {
                  interval_ms: elapsed,
                  observations: observations.length,
                },
                transition_token: finalObservation.transition_token,
              };
            }
            return {
              schema: STAGED_INPUT_EVIDENCE_SCHEMA,
              outcome: "cleared",
              evidence: "present",
              identity: finalObservation.identity,
              stability: {
                interval_ms: elapsed,
                observations: observations.length,
              },
              transition_token: finalObservation.transition_token,
              native,
            };
          }
          await (delay ?? defaultDelay)(
            Math.min(250, Math.max(1, stabilityIntervalMs - elapsed)),
          );
        }
      } catch (error) {
        return {
          schema: STAGED_INPUT_EVIDENCE_SCHEMA,
          outcome: error.outcome ?? "uncertain",
          evidence: error.outcome === "recovery_blocked" ? "changed" : "uncertain",
          identity: inspected.identity,
          error: error.message,
        };
      }
    },

    async stageUnknownInput({ agent, text } = {}) {
      await ensureCompatibility();
      const before = await this.inspectStagedInput({ agent });
      if (before.outcome !== "ready") {
        return {
          ...before,
          outcome: "recovery_blocked",
          reason:
            before.reason ??
            "managed identity could not be proven before staging unknown input",
        };
      }
      if (
        harness === "claude" &&
        !Number.isSafeInteger(before.transition_token)
      ) {
        return {
          ...before,
          outcome: "recovery_blocked",
          reason:
            "staged input lacks an exact native transition token before staging unknown input",
        };
      }
      await client.sendPaneText(agent.herdr.pane_id, text, {
        agentName: agent.herdr.name,
        ...(typeof before.identity?.native_session === "string"
          ? { nativeSession: before.identity.native_session }
          : {}),
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const after = await this.inspectStagedInput({ agent });
        if (after.outcome === "recovery_blocked") {
          return {
            ...after,
            outcome: "recovery_blocked",
            reason: after.evidence === "absent"
              ? "managed identity became absent while staging unknown input"
              : "managed identity changed while staging unknown input",
          };
        }
        if (after.evidence === "uncertain" || after.evidence === "changed") {
          return {
            ...after,
            outcome: "recovery_blocked",
            reason: "managed identity changed while staging unknown input",
          };
        }
        if (after.evidence === "absent") {
          await (delay ?? defaultDelay)(25);
          continue;
        }
        if (!after.snapshot) {
          return {
            ...after,
            outcome: "recovery_blocked",
            evidence: "uncertain",
            reason: "staged input evidence was incomplete",
          };
        }
        if (after.snapshot.display_text !== text) {
          return {
            ...after,
            outcome: "recovery_blocked",
            evidence: "changed",
            reason: "staged input differs from the authorized text",
          };
        }
        if (
          after.outcome === "staged_input" &&
          after.snapshot?.display_text === text
        ) {
          return {
            ...after,
            outcome: "staged_input",
            ownership: "unknown",
          };
        }
        await (delay ?? defaultDelay)(25);
      }
      throw new DrovrError(
        "Herdr did not expose the exact staged unknown input",
        { code: 4, outcome: "adapter_failure" },
      );
    },

    async validateRecovery({ agent, task } = {}) {
      try {
        const transcript = await native.locate(
          native.root,
          agent.native_session,
        );
        await native.validateTranscript(
          transcript,
          agent.native_session,
          task.cwd,
        );
        return {
          outcome: "validated",
          evidence: "present",
          identity: registeredIdentity(agent),
        };
      } catch (error) {
        return {
          outcome: "recovery_blocked",
          evidence: "uncertain",
          reason: "missing_transcript",
          error: error.message,
        };
      }
    },

    async attach({ agent, takeover = false } = {}) {
      await ensureCompatibility();
      const exitCode = await client.attach(agent.herdr.name, { takeover });
      return {
        outcome: exitCode === 0 ? "attached" : "attach_failed",
        evidence: exitCode === 0 ? "present" : "uncertain",
        exit_code: exitCode ?? 4,
      };
    },

    topology: {
      observePane: async (paneId) =>
        normalizePane(await client.paneRecord?.(paneId)),
      observePaneProcess: async (paneId) =>
        normalizePaneProcess(await client.paneProcessInfo?.(paneId)),
      observeTab: async (tabId) =>
        normalizeTab(await client.tabRecord?.(tabId)),
      observeWorkspace: async (workspaceId) =>
        normalizeWorkspace(await client.workspaceRecord?.(workspaceId)),
      observeLayout: async (paneId) =>
        normalizeLayout(await client.paneLayout?.(paneId)),
      createWorkspace: async ({ cwd, label }) => {
        await ensureCompatibility();
        if (typeof client.createWorkspace !== "function") return undefined;
        const result = await client.createWorkspace({ cwd, label });
        return {
          workspaceId: result.workspaceId,
          rootPaneId: result.paneId,
          tabId: result.tabId,
        };
      },
      createTaskTab: async ({ workspaceId, cwd, label }) => {
        await ensureCompatibility();
        if (typeof client.createTab !== "function") return undefined;
        const result = await client.createTab({ workspaceId, cwd, label });
        return { tabId: result.tabId, rootPaneId: result.paneId };
      },
      splitTaskPane: async ({ paneId, direction, ratio, cwd }) => {
        await ensureCompatibility();
        return client.splitPane?.({ paneId, direction, ratio, cwd });
      },
      renameTask: async (tabId, label) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() => client.renameTab?.(tabId, label));
      },
      renameGroup: async (workspaceId, label) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() =>
          client.renameWorkspace?.(workspaceId, label),
        );
      },
      renameAgentPane: async (paneId, label) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() => client.renamePane?.(paneId, label));
      },
      closePane: async (paneId) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() => client.closePane?.(paneId));
      },
      closeTaskTab: async (tabId) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() => client.closeTab?.(tabId));
      },
      closeGroupWorkspace: async (workspaceId) => {
        await ensureCompatibility();
        return acknowledgeTopologyMutation(() => client.closeWorkspace?.(workspaceId));
      },
      sendUnknownInput: async ({ agent, text } = {}) => {
        await ensureCompatibility();
        const before = await adapter.observeAgent(agent);
        if (before.evidence !== "present") {
          throw new DrovrError(
            `managed agent ${agent?.id ?? "unknown"} identity is ${before.evidence}`,
            {
              code: 0,
              outcome: before.evidence === "absent"
                ? "agent_lost"
                : "recovery_blocked",
              details: { observation: before },
            },
          );
        }
        return acknowledgeTopologyMutation(() => client.sendPaneText(
          agent.herdr.pane_id,
          text,
          {
            agentName: agent.herdr.name,
            ...(typeof before.identity?.native_session === "string"
              ? { nativeSession: before.identity.native_session }
              : {}),
          },
        ));
      },
    },
  };
  return adapter;
}

function compatibilityBindingError({
  expected,
  observed,
  compatibility = null,
  reason,
}) {
  return new DrovrError(
    reason === "missing"
      ? "agent has no exact qualified runtime compatibility binding"
      : "agent runtime compatibility differs from its launch binding",
    {
      code: 0,
      outcome: "compatibility_blocked",
      details: {
        expected,
        observed,
        reason,
        compatibility,
        legal_actions: ["refresh_compatibility", "retire_stale_launch"],
      },
    },
  );
}

function agentObservation(agent, observed, error) {
  const expected = registeredIdentity(agent);
  if (error) {
    return {
      schema: AGENT_OBSERVATION_SCHEMA,
      evidence: "uncertain",
      expected_identity: expected,
      identity: null,
      state: "unknown",
      error,
    };
  }
  if (!observed) {
    return {
      schema: AGENT_OBSERVATION_SCHEMA,
      evidence: "absent",
      expected_identity: expected,
      identity: null,
      state: "absent",
      transition_token: null,
    };
  }
  const identity = observedIdentity(agent, observed);
  const identityResult = identityEvidence(expected, identity);
  return {
    schema: AGENT_OBSERVATION_SCHEMA,
    evidence: identityResult.evidence,
    expected_identity: expected,
    identity,
    state: observed.agent_status ?? "unknown",
    transition_token: observed.state_change_seq ?? null,
    native: observed,
    ...(identityResult.reason ? { reason: identityResult.reason } : {}),
    ...(identityResult.pane_changed ? { pane_changed: true } : {}),
  };
}

function registeredIdentity(agent) {
  return {
    managed_agent: agent.herdr?.name ?? null,
    pane: agent.herdr?.pane_id ?? null,
    native_session: agent.native_session ?? null,
  };
}

function observedIdentity(agent, observed) {
  return {
    managed_agent: observed.name ?? agent.herdr?.name ?? null,
    pane: observed.pane_id ?? null,
    native_session: observed.agent_session?.value ?? null,
  };
}

function normalizePane(pane) {
  if (!pane) return pane;
  return {
    paneId: pane.pane_id ?? pane.paneId,
    tabId: pane.tab_id ?? pane.tabId,
    workspaceId: pane.workspace_id ?? pane.workspaceId,
  };
}

function normalizePaneProcess(processInfo) {
  if (!processInfo) return processInfo;
  return {
    shellPid: processInfo.shell_pid ?? processInfo.shellPid,
    foregroundProcesses: Array.isArray(processInfo.foreground_processes)
      ? processInfo.foreground_processes.map(({ pid }) => ({ pid }))
      : processInfo.foregroundProcesses,
  };
}

function normalizeTab(tab) {
  if (!tab) return tab;
  return {
    tabId: tab.tab_id ?? tab.tabId,
    workspaceId: tab.workspace_id ?? tab.workspaceId,
    rootPaneId: tab.root_pane_id ?? tab.rootPaneId,
  };
}

function normalizeWorkspace(workspace) {
  if (!workspace) return workspace;
  return {
    workspaceId: workspace.workspace_id ?? workspace.workspaceId,
    rootPaneId: workspace.root_pane_id ?? workspace.rootPaneId,
  };
}

function normalizeLayout(layout) {
  if (!layout) return layout;
  return {
    panes: Array.isArray(layout.panes)
      ? layout.panes.map((pane) => ({
          paneId: pane.pane_id ?? pane.paneId,
          geometry: {
            width: pane.rect?.width ?? pane.geometry?.width,
            height: pane.rect?.height ?? pane.geometry?.height,
          },
        }))
      : [],
  };
}

async function acknowledgeTopologyMutation(operation) {
  await operation();
  return { outcome: "completed", evidence: "present" };
}

function assertDeliverableAgent(agent, observation) {
  if (observation.evidence === "present") return;
  const outcome = observation.evidence === "absent" ? "agent_lost" : "recovery_blocked";
  throw new DrovrError(
    `managed agent ${agent.id} identity is ${observation.evidence}`,
    { code: 0, outcome, details: { observation } },
  );
}

function semanticDeliveryError(error, before) {
  if (error.outcome) throw error;
  const wrapped = new DrovrError(error.message, {
    code: error.code ?? 4,
    outcome: "uncertain",
    details: { ...error.details, observation: before },
  });
  wrapped.adapterFailure = error;
  throw wrapped;
}

async function correlateTurn({
  native,
  agent,
  turn,
  observed,
  deliveryObservationExpired = false,
}) {
  let cursor = turn.transcript_cursor;
  try {
    if (cursor?.transcript_root) {
      const path = await native.locate(
        cursor.transcript_root,
        agent.native_session ?? observed.identity.native_session,
      );
      cursor = await native.resolveInventory(
        cursor,
        path,
        agent.native_session ?? observed.identity.native_session,
      );
    }
    const result = await native.extract(
      cursor,
      turn.inputs.map(({ text }) => text),
    );
    return {
      schema: TURN_EVIDENCE_SCHEMA,
      outcome: "completed",
      evidence: "present",
      observation: observed,
      transcript_cursor: cursor,
      result,
    };
  } catch (error) {
    if (deliveryObservationExpired && error.details?.correlation_pending) {
      return {
        schema: TURN_EVIDENCE_SCHEMA,
        outcome: "uncertain",
        evidence: observed.evidence,
        observation: observed,
        transcript_cursor: cursor,
        error:
          error.message ??
          "submitted input was not observed after the transcript cursor",
        correlation_stage: error.details?.correlation_stage,
      };
    }
    return {
      schema: TURN_EVIDENCE_SCHEMA,
      outcome: error.details?.correlation_pending
        ? "correlation_pending"
        : error.outcome ?? "uncertain",
      evidence: error.details?.correlation_pending ? "present" : "uncertain",
      observation: observed,
      transcript_cursor: cursor,
      error: error.message,
      correlation_stage: error.details?.correlation_stage,
      late_result_recovery: error.details?.correlation_pending
        ? "exact_transcript_correlation"
        : undefined,
    };
  }
}

async function waitForNativeAgent(client, agent, timeoutMs) {
  if (typeof client.waitForAgent === "function") {
    return client.waitForAgent(agent.herdr.name, timeoutMs);
  }
  if (typeof client.agentRecord === "function") {
    return client.agentRecord(agent.herdr.name);
  }
  throw new DrovrError(
    `Herdr cannot observe managed agent ${agent.herdr.name}`,
    { code: 4, outcome: "adapter_failure" },
  );
}

async function waitForBlockResume({
  client,
  agent,
  afterBlock,
  timeout,
  startedAt,
  pause,
  clock,
  harness,
  refreshBlock,
}) {
  for (;;) {
    const remaining =
      timeout === undefined
        ? undefined
        : Math.max(0, timeout - (clock() - startedAt));
    if (remaining === 0) {
      return {
        schema: TURN_EVIDENCE_SCHEMA,
        outcome: "still_running",
        evidence: "present",
      };
    }
    const raw =
      typeof client.agentRecord === "function"
        ? await client.agentRecord(agent.herdr.name)
        : await waitForNativeAgent(client, agent, remaining);
    if (raw?.drovr_status === "agent_lost" || !raw) {
      return turnEvidence("agent_lost", agentObservation(agent, null), {
        error: "managed agent was lost while waiting for native settlement",
      });
    }
    if (raw.drovr_status === "still_running") {
      return {
        schema: TURN_EVIDENCE_SCHEMA,
        outcome: "still_running",
        evidence: "present",
        observation: agentObservation(agent, raw),
      };
    }
    const observed = agentObservation(agent, raw);
    if (observed.evidence !== "present") {
      return turnEvidence(
        observed.evidence === "absent" ? "agent_lost" : "uncertain",
        observed,
        { error: nativeIdentityError(harness, observed) },
      );
    }
    const currentBlock = refreshBlock ? await refreshBlock() : null;
    if (currentBlock?.id && currentBlock.id !== afterBlock.id) {
      return turnEvidence("block_changed", observed, {
        block: currentBlock,
      });
    }
    if (currentBlock?.working_observed_at) {
      return turnEvidence("working_observed", observed, {
        working_observation:
          currentBlock.working_observation ?? "durable_working_observation",
      });
    }
    if (observed.state === "working") {
      return turnEvidence("working_observed", observed, {
        working_observation: "herdr_working_status",
      });
    }
    const stateChanged =
      Number.isSafeInteger(afterBlock.transition_token) &&
      Number.isSafeInteger(observed.transition_token) &&
      observed.transition_token > afterBlock.transition_token;
    if (["idle", "done"].includes(observed.state) && stateChanged) {
      return turnEvidence("working_observed", observed, {
        working_observation: "herdr_state_changed_before_settlement",
      });
    }
    if (observed.state === "blocked" && stateChanged) {
      const excerpt = await client.agentExcerpt(agent.herdr.name, {
        nativeSession: agent.native_session,
      });
      return turnEvidence("needs_input", observed, { excerpt });
    }
    await pause(Math.min(25, remaining ?? 25));
  }
}

function deliverySettlementDeadline(turn, transitionToken) {
  if (!turnAwaitsPostDeliverySettlement(turn, transitionToken)) {
    return Infinity;
  }
  const submittedAt = Date.parse(
    turn.inputs[0]?.submitted_at ?? turn.created_at,
  );
  return Number.isFinite(submittedAt) ? submittedAt + 5_000 : Infinity;
}

function turnEvidence(outcome, observation, details = {}) {
  return {
    schema: TURN_EVIDENCE_SCHEMA,
    outcome,
    evidence: observation?.evidence ?? "uncertain",
    observation,
    ...details,
  };
}

function nativeIdentityError(harness, observation) {
  if (observation?.evidence === "absent") {
    return "managed native agent was absent during the operation";
  }
  if (observation?.evidence === "changed") {
    if (observation.reason === "unbound pane changed") {
      return "managed pane identity changed during the operation";
    }
    return `Herdr reported a different ${harnessLabel(harness)} native session identity`;
  }
  if (!observation?.expected_identity?.native_session) {
    return `Herdr did not report the ${harnessLabel(harness)} native session identity`;
  }
  if (
    observation?.evidence === "uncertain" &&
    observation.expected_identity?.native_session &&
    !observation.identity?.native_session
  ) {
    return `Herdr did not report the ${harnessLabel(harness)} native session identity`;
  }
  return observation?.error?.message ?? "native identity could not be proven";
}

function harnessLabel(harness) {
  return harness === "claude" ? "Claude" : "Codex";
}

async function waitUntilSettled(agent, client, delayFn, clock, timeoutMs) {
  const pause = delayFn ?? defaultDelay;
  const deadline = clock() + timeoutMs;
  for (let attempt = 0; attempt < STARTUP_STABILITY_ATTEMPTS; attempt += 1) {
    const observed = await waitForAgentRegistration(
      client,
      agent,
      pause,
      clock,
      deadline,
    );
    let settled = observed;
    if (observed?.agent_status === "working") {
      const remaining = deadline - clock();
      if (remaining <= 0) break;
      settled = await waitForNativeAgent(
        client,
        agent,
        Math.max(1, Math.floor(remaining)),
      );
    }
    if (!settled || !["idle", "done"].includes(settled.agent_status)) {
      throw new DrovrError(
        `Herdr managed agent ${agent.herdr.name} did not finish starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await pause(Math.min(STARTUP_STABILITY_MS, remaining));
    if (clock() >= deadline) break;
    const confirmed = await client.agentRecord(agent.herdr.name);
    if (confirmed?.agent_status === "working") continue;
    if (!confirmed || !["idle", "done"].includes(confirmed.agent_status)) {
      throw new DrovrError(
        `Herdr managed agent ${agent.herdr.name} did not remain settled after starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const firstSession = settled.agent_session?.value;
    const confirmedSession = confirmed.agent_session?.value;
    if (firstSession && !confirmedSession) {
      throw new DrovrError(
        `Herdr managed agent ${agent.herdr.name} lost native session identity while starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    if (firstSession && firstSession !== confirmedSession) {
      throw new DrovrError(
        `Herdr managed agent ${agent.herdr.name} changed native session while starting`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const result = agentObservation(agent, confirmed);
    if (result.evidence !== "present") {
      throw new DrovrError(
        `Herdr managed agent ${agent.herdr.name} identity changed while starting`,
        {
          code: 4,
          outcome: "adapter_failure",
          details: { observation: result },
        },
      );
    }
    return result;
  }
  throw new DrovrError(
    `managed agent ${agent.herdr.name} did not stabilize while starting`,
    { code: 4, outcome: "adapter_failure" },
  );
}

async function waitForAgentRegistration(client, agent, pause, clock, deadline) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await client.agentRecord(agent.herdr.name);
    if (observed) return observed;
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await pause(Math.min(50, remaining));
  }
  throw new DrovrError(
    `Herdr did not register managed agent ${agent.herdr.name}`,
    { code: 4, outcome: "adapter_failure" },
  );
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function configuredStabilityInterval(env) {
  const configured = Number.parseInt(
    env.DROVR_STAGED_INPUT_STABILITY_INTERVAL_MS ?? "",
    10,
  );
  return Number.isSafeInteger(configured) && configured >= 0
    ? Math.min(configured, MAX_STAGED_INPUT_STABILITY_MS)
    : 30_000;
}

function productionNativeAdapter(harness, env = process.env) {
  const home = env.HOME ?? homedir();
  if (harness === "claude") {
    return {
      label: "Claude",
      root: join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"),
      locate: locateClaudeTranscript,
      validateTranscript: validateClaudeTranscript,
      captureCursor: captureClaudeTranscriptCursor,
      captureInventory: captureClaudeTranscriptInventory,
      resolveInventory: resolveClaudeInventoryCursor,
      extract: extractClaudeTurn,
      inventoryBeforeDelivery: true,
      prepareLaunch: prepareClaudeLaunch,
      startAgent: (herdr, options) => herdr.startClaudeAgent(options),
      resumeAgent: (herdr, options) => herdr.resumeClaudeAgent(options),
      validate: validateClaudeLaunchSpecification,
    };
  }
  return {
    label: "Codex",
    root: join(env.CODEX_HOME ?? join(home, ".codex"), "sessions"),
    locate: locateCodexTranscript,
    validateTranscript: validateCodexTranscript,
    captureCursor: captureTranscriptCursor,
    captureInventory: captureTranscriptInventory,
    resolveInventory: resolveInventoryCursor,
    extract: extractCodexTurn,
    prepareLaunch: async () => ({}),
    startAgent: (herdr, options) => herdr.startCodexAgent(options),
    resumeAgent: (herdr, options) => herdr.resumeCodexAgent(options),
    validate: validateCodexLaunchSpecification,
  };
}
