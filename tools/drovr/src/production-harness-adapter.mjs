import { homedir } from "node:os";
import { join } from "node:path";

import { digestCanonical } from "./canonical-json.mjs";
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
import { MANAGED_RUNTIME_BINDING_FIELDS } from "./managed-runtime-identity.mjs";
import { identityEvidence } from "./semantic-evidence.mjs";
import {
  bindStagedInputToken,
  stagedInputTextToken,
} from "./staged-input-receipt.mjs";
import { turnAwaitsPostDeliverySettlement } from "./turn-record.mjs";
import { observationErrorReason } from "./observation-reason.mjs";

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
  expectedManagedRuntimeIdentity,
  compatibilityBindingFailure,
  requireCompatibilityBinding = false,
  requireCompatibility = false,
  requireManagedRuntimeIdentity = false,
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
    const primaryManagedRuntime = bindings.find(
      ({ harness: bindingHarness }) => bindingHarness === harness,
    )?.managed_runtime_identity ?? expectedManagedRuntimeIdentity;
    if (
      requireManagedRuntimeIdentity &&
      bindings.length > 0 &&
      !primaryManagedRuntime
    ) {
      throw compatibilityBindingError({
        expected: null,
        observed: null,
        reason: "missing",
      });
    }
    qualifiedCompatibility = await qualifiedCompatibilityFor(
      harness,
      qualifiedCompatibility,
      expectedCompatibility,
      primaryExpected,
      primaryManagedRuntime,
    );
    for (const binding of bindings) {
      const observed = binding.harness === harness
        ? qualifiedCompatibility
        : await qualifiedCompatibilityFor(
            binding.harness,
            undefined,
            undefined,
            binding.evidence_digest,
            binding.managed_runtime_identity,
          );
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
    expectedRuntimeIdentity,
  ) {
    let candidate;
    let runtimeIdentityForQualification = expectedRuntimeIdentity;
    if (expectedRuntimeIdentity) {
      let managedIdentity;
      let managedIdentityIsRecoveryPreflight = false;
      try {
        managedIdentity = await client.observeManagedRuntime?.({
          agentName: expectedRuntimeIdentity.managed_agent,
          expectedIdentity: expectedRuntimeIdentity,
          harness: targetHarness,
          model: expectedRuntimeIdentity.model,
          effort: expectedRuntimeIdentity.effort,
          requireNativeSession: managedRuntimeIsSettled(expectedRuntimeIdentity),
        });
      } catch (error) {
        const managedAgent = await client.agentRecord?.(
          expectedRuntimeIdentity.managed_agent,
        );
        if (!managedAgent && error.details?.reason === "missing") {
          try {
            managedIdentity = await client.probeManagedExecutable({
              paneId: expectedRuntimeIdentity.pane_id,
              harness: targetHarness,
            });
            managedIdentity = {
              ...managedIdentity,
              caller_path_digest: managedIdentity.caller_path_digest ??
                digestCanonical(String(env.PATH ?? "")),
            };
            assertRecoveryExecutableBinding(
              expectedRuntimeIdentity,
              managedIdentity,
            );
            managedIdentityIsRecoveryPreflight = true;
          } catch (probeError) {
            if (probeError.outcome === "compatibility_blocked") throw probeError;
            throw new DrovrError(
              `managed ${targetHarness} runtime identity could not be revalidated`,
              {
                code: 0,
                outcome: "compatibility_blocked",
                details: {
                  reason: error.details?.reason ?? "changed",
                  expected: expectedRuntimeIdentity,
                  observed: null,
                  error: probeError.message,
                  legal_actions: ["refresh_compatibility", "retire_stale_launch"],
                },
              },
            );
          }
        } else {
          throw new DrovrError(
            `managed ${targetHarness} runtime identity could not be revalidated`,
            {
              code: 0,
              outcome: "compatibility_blocked",
              details: {
                reason: error.details?.reason ?? "changed",
                expected: expectedRuntimeIdentity,
                observed: null,
                legal_actions: ["refresh_compatibility", "retire_stale_launch"],
              },
            },
          );
        }
      }
      candidate = await collectProductionCompatibility({
        harness: targetHarness,
        env,
        run,
        expected,
        managedIdentity,
        ...(managedIdentityIsRecoveryPreflight
          ? {}
          : { expectedManagedIdentity: expectedRuntimeIdentity }),
        requireManagedIdentity:
          !managedIdentityIsRecoveryPreflight &&
          managedRuntimeIsSettled(managedIdentity),
      });
      if (managedIdentityIsRecoveryPreflight) {
        runtimeIdentityForQualification = undefined;
      }
    } else {
      candidate = qualifiedByHarness.get(targetHarness) ?? supplied;
      if (!candidate) {
        candidate = await collectProductionCompatibility({
          harness: targetHarness,
          env,
          run,
          expected,
        });
      }
    }
    candidate = qualifyCompatibility(candidate, {
      expected,
      harness: targetHarness,
      adapter: PRODUCTION_ADAPTER_ID,
      expectedManagedIdentity: runtimeIdentityForQualification,
      requireManagedIdentity: managedRuntimeIsSettled(
        candidate?.managed_pane_identity,
      ),
    });
    try {
      assertQualifiedCompatibility(candidate);
    } catch (error) {
      throw new DrovrError(
        `Drovr compatibility is ${candidate?.reason ?? "unqualified"}`,
        {
          code: 0,
          outcome: "compatibility_blocked",
          details: {
            compatibility: candidate,
            reason: candidate?.reason ?? "unqualified",
            mismatches: candidate?.mismatches ?? [],
          },
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

  async function qualifyManagedExecutableForLaunch({
    paneId,
    agentName,
    specification,
    expectedFacts,
    expectedIdentity,
  }) {
    if (typeof client.probeManagedExecutable !== "function") {
      throw compatibilityBindingError({
        expected: null,
        observed: null,
        reason: "missing",
      });
    }
    try {
      const managedExecutable = await client.probeManagedExecutable({
        paneId,
        harness,
      });
      managedExecutable.managed_agent = agentName;
      managedExecutable.model = specification?.model ?? null;
      managedExecutable.effort = specification?.effort ?? null;
      managedExecutable.caller_path_digest = digestCanonical(
        String(env.PATH ?? ""),
      );
      if (expectedIdentity) {
        assertRecoveryExecutableBinding(expectedIdentity, managedExecutable);
      }
      let compatibility = await collectProductionCompatibility({
        harness,
        env,
        run,
        expected: expectedFacts,
        managedIdentity: managedExecutable,
        requireManagedIdentity: false,
      });
      compatibility = qualifyCompatibility(compatibility, {
        expected: expectedFacts,
        harness,
        adapter: PRODUCTION_ADAPTER_ID,
      });
      assertQualifiedCompatibility(compatibility);
      return { managedExecutable, compatibility };
    } catch (error) {
      if (error.outcome === "compatibility_blocked") throw error;
      throw new DrovrError(
        `managed ${harness} executable identity could not be qualified before launch`,
        {
          code: 0,
          outcome: "compatibility_blocked",
          details: {
            reason: error.details?.reason ?? "missing",
            error: error.message,
            legal_actions: ["refresh_compatibility", "run_drovr_doctor"],
          },
        },
      );
    }
  }

  async function observeUnboundManagedRuntime(agent) {
    const baseline = await ensureCompatibility();
    const boundIdentity = agent.launch_binding?.managed_runtime_identity;
    const preflight = boundIdentity
      ? {
          managedExecutable: {
            ...structuredClone(boundIdentity),
            managed_agent: agent.herdr.name,
            model: agent.launch.model,
            effort: agent.launch.effort,
          },
          compatibility: baseline,
        }
      : await qualifyManagedExecutableForLaunch({
          paneId: agent.herdr.pane_id,
          agentName: agent.herdr.name,
          specification: agent.launch,
          expectedFacts: baseline?.facts,
        });
      const identity = await client.captureManagedRuntimeIdentity({
        agentName: agent.herdr.name,
        paneId: agent.herdr.pane_id,
        harness,
        executable: preflight.managedExecutable,
        model: agent.launch.model,
        effort: agent.launch.effort,
        requireNativeSession: false,
      });
    assertRecoveryExecutableBinding(
      preflight.managedExecutable,
      identity,
      { includeRuntime: true },
    );
    const compatibility = await collectProductionCompatibility({
      harness,
      env,
      run,
      expected: preflight.compatibility.facts,
      managedIdentity: identity,
      requireManagedIdentity: managedRuntimeIsSettled(identity),
    });
    const qualified = qualifyCompatibility(compatibility, {
      expected: preflight.compatibility.facts,
      harness,
      adapter: PRODUCTION_ADAPTER_ID,
      requireManagedIdentity: managedRuntimeIsSettled(identity),
    });
    assertQualifiedCompatibility(qualified);
    return { compatibility: qualified, identity };
  }

  async function qualifySettledManagedRuntime(agent, observation) {
    if (
      !compatibilityRequired ||
      !observation?.identity?.native_session
    ) {
      return observation;
    }
    const expectedIdentity = agent.launch_binding?.managed_runtime_identity ??
      expectedManagedRuntimeIdentity;
    if (!expectedIdentity) {
      throw compatibilityBindingError({
        expected: null,
        observed: observation.identity,
        reason: "missing",
      });
    }
    const baseline = await ensureCompatibility();
    const identity = await client.captureManagedRuntimeIdentity({
      agentName: agent.herdr.name,
      paneId: agent.herdr.pane_id,
      harness,
      executable: expectedIdentity,
      model: agent.launch.model,
      effort: agent.launch.effort,
      requireNativeSession: true,
    });
    assertRecoveryExecutableBinding(expectedIdentity, identity, {
      includeRuntime: true,
    });
    const compatibility = await collectProductionCompatibility({
      harness,
      env,
      run,
      expected: baseline.facts,
      managedIdentity: identity,
      requireManagedIdentity: true,
    });
    const qualified = qualifyCompatibility(compatibility, {
      expected: baseline.facts,
      expectedManagedIdentity: expectedIdentity,
      harness,
      adapter: PRODUCTION_ADAPTER_ID,
      requireManagedIdentity: true,
    });
    assertQualifiedCompatibility(qualified);
    return {
      ...observation,
      compatibility: qualified,
      managed_runtime_identity: identity,
    };
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

    async ensureRuntime({ ensureSession = true } = {}) {
      const runtimeCompatibility = await ensureCompatibility();
      if (ensureSession) await client.ensureSession?.();
      return {
        outcome: ensureSession ? "ensured" : "qualified",
        ...(runtimeCompatibility
          ? { compatibility: runtimeCompatibility }
          : {}),
      };
    },

    async observeRuntime() {
      try {
        const running = await client.sessionRunning?.();
        return {
          outcome: running ? "running" : "absent",
          evidence: running ? "present" : "absent",
        };
      } catch (error) {
        return {
          outcome: "uncertain",
          evidence: "uncertain",
          reason: observationErrorReason(error),
          error,
        };
      }
    },

    async validateLaunch({ specification, paneId, agentName } = {}) {
      const launchCompatibility = await ensureCompatibility();
      await native.validate(specification, { env, run });
      if (compatibilityRequired && paneId && agentName) {
        const preflight = await qualifyManagedExecutableForLaunch({
          paneId,
          agentName,
          specification,
          expectedFacts: launchCompatibility?.facts,
        });
        return {
          outcome: "validated",
          evidence: "present",
          compatibility: preflight.compatibility,
        };
      }
      return {
        outcome: "validated",
        evidence: "present",
        ...(launchCompatibility ? { compatibility: launchCompatibility } : {}),
      };
    },

    async observeAgent(agent) {
      try {
        const observed = await client.agentRecord(agent.herdr.name);
        const basicObservation = agentObservation(agent, observed);
        if (
          !compatibilityRequired ||
          agent.native_session ||
          basicObservation.evidence !== "present"
        ) {
          return basicObservation;
        }
        const runtimeBinding = await observeUnboundManagedRuntime(agent);
        return {
          ...basicObservation,
          compatibility: runtimeBinding.compatibility,
          managed_runtime_identity: runtimeBinding.identity,
        };
      } catch (error) {
        return agentObservation(agent, undefined, error);
      }
    },

    async observeAgents(agents) {
      try {
        const usesBulkObservation = typeof client.agentRecords === "function";
        const observed = usesBulkObservation
          ? await client.agentRecords()
          : await Promise.all(
              agents.map((agent) => client.agentRecord(agent.herdr.name)),
            );
        const byName = new Map();
        const ambiguousNames = new Set();
        for (const candidate of observed) {
          if (!candidate?.name) continue;
          const existing = byName.get(candidate.name);
          if (!existing) {
            byName.set(candidate.name, candidate);
          } else if (!sameNativeProjection(existing, candidate)) {
            ambiguousNames.add(candidate.name);
          }
        }
        if (usesBulkObservation) {
          // Older Herdr protocols may expose an agent kind without the
          // managed name. Associate anonymous bulk observations only through
          // an exact native session, independently of response ordering;
          // positional association could bind an unrelated live agent to a
          // lost one.
          for (const candidate of observed) {
            if (candidate?.name) continue;
            const nativeSession = candidate?.agent_session?.value;
            if (!nativeSession) continue;
            const matches = agents.filter((candidateAgent) =>
              candidateAgent.native_session === nativeSession &&
              candidateAgent.herdr?.name
            );
            if (matches.length !== 1) continue;
            const [agent] = matches;
            if (!byName.has(agent.herdr.name)) {
              byName.set(agent.herdr.name, candidate);
            }
          }
        } else if (observed.length === agents.length) {
          for (const [index, candidate] of observed.entries()) {
            if (
              candidate?.name ||
              !candidate ||
              !agents[index]?.herdr?.name
            ) continue;
            // An injected targeted adapter has already selected this
            // observation for the requested agent, even when an older
            // response omits its name.
            byName.set(agents[index].herdr.name, candidate);
          }
        }
        const records = agents.map((agent) => {
          const record = agentObservation(
            agent,
            byName.get(agent.herdr.name),
          );
          return ambiguousNames.has(agent.herdr.name)
            ? {
                ...record,
                evidence: "changed",
                reason: "duplicate_native_session",
              }
            : record;
        });
        const registeredOwners = new Map();
        for (const agent of agents) {
          const nativeSession = agent.native_session;
          if (!nativeSession) continue;
          const owners = registeredOwners.get(nativeSession) ?? [];
          owners.push(agent);
          registeredOwners.set(nativeSession, owners);
        }
        const nativeOwners = new Map();
        for (const candidate of observed.filter(Boolean)) {
          const nativeSession = candidate.agent_session?.value;
          if (nativeSession) {
            const owners = nativeOwners.get(nativeSession) ?? [];
            // Herdr can expose the same pane through both its managed-name
            // and generic agent projections. Count that projection once, but
            // keep distinct panes sharing a session ambiguous. Missing pane
            // identity stays conservative and is never deduplicated.
            if (!owners.some((owner) => sameNativeProjection(owner, candidate))) {
              owners.push(candidate);
            }
            nativeOwners.set(nativeSession, owners);
          }
        }
        return records.map((record, index) => {
          const nativeSession = agents[index].native_session ??
            record.identity?.native_session;
          const owners = nativeSession
            ? nativeOwners.get(nativeSession) ?? []
            : [];
          const claimants = nativeSession
            ? registeredOwners.get(nativeSession) ?? []
            : [];
          const foreignClaimant = claimants.some(
            (owner) => owner.id !== agents[index].id,
          );
          if (
            foreignClaimant ||
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
      let managedExecutable;
      let preflightCompatibility;
      const launchIdentity = agent.launch_binding?.managed_runtime_identity;
      const runtimeSettled = managedRuntimeIsSettled(launchIdentity) &&
        agent.native_session === launchIdentity.native_session;
      if (compatibilityRequired && !runtimeSettled) {
        const preflight = await qualifyManagedExecutableForLaunch({
          paneId: agent.herdr.pane_id,
          agentName: agent.herdr.name,
          specification: agent.launch,
          expectedFacts: qualifiedCompatibility?.facts,
          expectedIdentity: launchIdentity,
        });
        managedExecutable = preflight.managedExecutable;
        preflightCompatibility = preflight.compatibility;
      }
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
      const settled = await waitUntilSettled(agent, client, delay, clock, 120_000);
      if (!managedExecutable) return settled;
      let runtimeIdentity;
      try {
        runtimeIdentity = await client.captureManagedRuntimeIdentity({
          agentName: agent.herdr.name,
          paneId: agent.herdr.pane_id,
          harness,
          executable: managedExecutable,
          model: agent.launch.model,
          effort: agent.launch.effort,
          requireNativeSession: false,
        });
        assertRecoveryExecutableBinding(managedExecutable, runtimeIdentity, {
          includeRuntime: true,
        });
        const compatibilityAfterLaunch = await collectProductionCompatibility({
          harness,
          env,
          run,
          expected: preflightCompatibility.facts,
          managedIdentity: runtimeIdentity,
          requireManagedIdentity: managedRuntimeIsSettled(runtimeIdentity),
        });
        const qualifiedAfterLaunch = qualifyCompatibility(compatibilityAfterLaunch, {
          expected: preflightCompatibility.facts,
          harness,
          adapter: PRODUCTION_ADAPTER_ID,
          requireManagedIdentity: managedRuntimeIsSettled(runtimeIdentity),
        });
        assertQualifiedCompatibility(qualifiedAfterLaunch);
        return {
          ...settled,
          compatibility: qualifiedAfterLaunch,
          managed_runtime_identity: runtimeIdentity,
        };
      } catch (error) {
        if (error.outcome === "compatibility_blocked") throw error;
        throw new DrovrError(
          `managed ${harness} runtime identity could not be bound after launch`,
          {
            code: 0,
            outcome: "compatibility_blocked",
            details: {
              reason: "missing",
              error: error.message,
              legal_actions: ["refresh_compatibility", "retire_stale_launch"],
            },
          },
        );
      }
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
      const runtimeBinding = expectedCompatibilityBindings.find(
        ({ harness: bindingHarness }) => bindingHarness === harness,
      )?.managed_runtime_identity ?? expectedManagedRuntimeIdentity;
      if (!runtimeBinding) {
        return { outcome: "resumed", evidence: "present" };
      }
      try {
        const settled = await waitUntilSettled(
          agent,
          client,
          delay,
          clock,
          120_000,
        );
        const runtimeIdentity = await client.captureManagedRuntimeIdentity({
          agentName: agent.herdr.name,
          paneId: agent.herdr.pane_id,
          harness,
          executable: runtimeBinding,
          model: agent.launch.model,
          effort: agent.launch.effort,
        });
        assertRecoveryExecutableBinding(runtimeBinding, runtimeIdentity, {
          includeRuntime: true,
        });
        if (runtimeIdentity.native_session !== agent.native_session) {
          throw compatibilityBindingError({
            expected: agent.native_session,
            observed: runtimeIdentity.native_session,
            reason: "changed",
          });
        }
        const compatibilityAfterRecovery = await collectProductionCompatibility({
          harness,
          env,
          run,
          expected: qualifiedCompatibility?.facts,
          managedIdentity: runtimeIdentity,
          requireManagedIdentity: true,
        });
        const qualifiedAfterRecovery = qualifyCompatibility(
          compatibilityAfterRecovery,
          {
            expected: qualifiedCompatibility?.facts,
            harness,
            adapter: PRODUCTION_ADAPTER_ID,
            requireManagedIdentity: true,
          },
        );
        assertQualifiedCompatibility(qualifiedAfterRecovery);
        return {
          ...settled,
          compatibility: qualifiedAfterRecovery,
          managed_runtime_identity: runtimeIdentity,
        };
      } catch (error) {
        if (error.outcome === "compatibility_blocked") throw error;
        throw new DrovrError(
          `managed ${harness} runtime identity could not be rebound after recovery`,
          {
            code: 0,
            outcome: "compatibility_blocked",
            details: {
              reason: "missing",
              error: error.message,
              legal_actions: ["refresh_compatibility", "retire_stale_launch"],
            },
          },
        );
      }
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
        let observed = agentObservation(agent, raw);
        if (
          observed.evidence === "present" &&
          observed.identity.native_session &&
          ["blocked", "idle", "done"].includes(observed.state)
        ) {
          try {
            observed = await qualifySettledManagedRuntime(agent, observed);
          } catch (error) {
            return turnEvidence(
              "uncertain",
              {
                ...observed,
                evidence: "uncertain",
                error: {
                  message: error.message,
                  outcome: error.outcome,
                  details: error.details,
                },
              },
              { error: error.message },
            );
          }
        }
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
          let settledWait = waited;
          if (
            settledWait.evidence === "present" &&
            settledWait.identity?.native_session &&
            ["blocked", "idle", "done"].includes(settledWait.state)
          ) {
            try {
              settledWait = await qualifySettledManagedRuntime(
                agent,
                settledWait,
              );
            } catch (error) {
              return turnEvidence(
                "uncertain",
                {
                  ...settledWait,
                  evidence: "uncertain",
                  error: {
                    message: error.message,
                    outcome: error.outcome,
                    details: error.details,
                  },
                },
                { error: error.message },
              );
            }
          }
          last = settledWait;
          if (settledWait.evidence !== "present") {
            return turnEvidence(
              settledWait.outcome === "agent_lost" ? "agent_lost" : "uncertain",
              settledWait,
              {
                error:
                  settledWait.outcome === "agent_lost"
                    ? "managed agent was lost while waiting for native settlement"
                    : nativeIdentityError(harness, settledWait),
              },
            );
          }
          if (settledWait.state === "working") continue;
          if (settledWait.state === "blocked") {
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
      let lastMismatchedSnapshot;
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
          lastMismatchedSnapshot = after;
          await (delay ?? defaultDelay)(25);
          continue;
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
      if (lastMismatchedSnapshot) {
        return {
          ...lastMismatchedSnapshot,
          outcome: "recovery_blocked",
          evidence: "changed",
          reason: "staged input differs from the authorized text",
        };
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
  mismatches = [],
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
        ...(mismatches.length > 0 ? { mismatches } : {}),
        legal_actions: ["refresh_compatibility", "retire_stale_launch"],
      },
    },
  );
}

function assertRecoveryExecutableBinding(
  expected,
  observed,
  { includeRuntime = false } = {},
) {
  const fields = [...MANAGED_RUNTIME_BINDING_FIELDS];
  if (includeRuntime) {
    for (const field of [
      "managed_agent",
      "native_session",
      "process",
      "model",
      "effort",
    ]) {
      if (expected?.[field] !== undefined && expected?.[field] !== null) {
        fields.push(field);
      }
    }
  }
  const mismatches = fields
    .filter((field) => !sameJsonValue(expected?.[field], observed?.[field]))
    .map((field) => ({
      field: `managed_pane_identity.${field}`,
      expected: expected?.[field],
      observed: observed?.[field],
      reason: "changed",
    }));
  if (mismatches.length === 0) return;
  throw compatibilityBindingError({
    expected,
    observed,
    reason: "changed",
    mismatches,
  });
}

function managedRuntimeIsSettled(identity) {
  return Boolean(
    typeof identity?.native_session === "string" &&
      identity.native_session.length > 0 &&
      Number.isSafeInteger(identity.process?.pid),
  );
}

function sameJsonValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return digestCanonical(left) === digestCanonical(right);
}

function sameNativeProjection(left, right) {
  return Boolean(
    left?.pane_id &&
    right?.pane_id &&
    left.pane_id === right.pane_id &&
    left.agent_session?.value &&
    right.agent_session?.value &&
    left.agent_session.value === right.agent_session.value
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
      reason: observationErrorReason(error),
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
