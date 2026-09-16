import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

import {
  closeFlowRuntime,
  createFlowRuntime,
} from "../src/runtime.mjs";
import {
  createProductionRouteConformanceSession,
} from "../../../tools/flow/src/qualification-phase2-session.mjs";
import {
  completedTurnProjection,
} from "../../../tools/flow/test-support/delegate-card.mjs";
import {
  repositoryDrovrDependencies,
  supportedDescription,
} from "../../../tools/flow/test-support/delegated-agent-description.mjs";
import { dynamicCheckpointProposal } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";

const execFile = promisify(execFileCallback);
const DARK_OPT_IN = {
  schema: "flow.dark-opt-in/v1",
  release_id: "flow-release-1.0-dark/v1",
  purpose: "sacrificial_qualification",
};

/**
 * Produce one exact candidate and automated review using the production
 * feature/handoff and ReviewAuthority paths. The caller can then close this
 * producer runtime and inspect or mutate the durable subjects through the
 * detached public owner transport.
 */
export async function seedPublicReview({
  authorityDirectory,
  env,
  repository,
} = {}) {
  const delegatedAgentPort = createPublicDelegatedAgentPort({ repository });
  const runtime = createFlowRuntime({
    env,
    authorityDirectory,
    delegatedAgentPort,
    autonomous: true,
    ...(env?.FLOW_PRODUCTION_ROUTE_CONFORMANCE_SESSION === "1" ? {
      qualificationPhase2Session: createProductionRouteConformanceSession({
        authorityDirectory: env.FLOW_CONFIG_DIRECTORY,
        marker: env.FLOW_PRODUCTION_ROUTE_CONFORMANCE_MARKER,
      }),
    } : {}),
  });
  try {
    const featurePrepared = await runtime.prepare(
      featurePreparationRequest(repository),
    );
    const featureLaunch = runtime.launch(
      confirmedPredefinedLaunchRequest(featurePrepared),
    );
    assertAcceptedLaunch(featureLaunch, "feature");
    const featureCompleted = await waitForTerminal(runtime, featureLaunch.run_id);
    if (featureCompleted.phase !== "succeeded") {
      throw new Error(`public feature seed failed: ${JSON.stringify(featureCompleted)}`);
    }
    const candidateId = featureCompleted.review_candidate_reference?.candidate_id;
    const candidateProjection = runtime.query({
      contract: "work.review/v1",
      subject_id: candidateId,
    });
    if (candidateProjection?.schema !== "work.review-candidate-projection/v1" ||
        candidateProjection.status !== "sealed") {
      throw new Error(`public feature seed produced no sealed candidate: ${JSON.stringify(candidateProjection)}`);
    }

    const reviewPrepared = await runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "review/v1",
      inputs: await reviewInputs(candidateProjection),
      explicit_facts: reviewFacts(candidateProjection),
      dark_opt_in: DARK_OPT_IN,
    });
    const reviewLaunch = runtime.launch(
      confirmedPredefinedLaunchRequest(reviewPrepared),
    );
    assertAcceptedLaunch(reviewLaunch, "review");
    const reviewCompleted = await waitForTerminal(runtime, reviewLaunch.run_id);
    if (reviewCompleted.phase !== "succeeded") {
      throw new Error(`public review seed failed: ${JSON.stringify(reviewCompleted)}`);
    }
    const reviewId = `review:${candidateProjection.candidate_fingerprint}:1`;
    const reviewProjection = runtime.query({
      contract: "work.review/v1",
      subject_id: reviewId,
    });
    if (reviewProjection?.schema !== "flow.review-projection/v1" ||
        reviewProjection.current !== true) {
      throw new Error(`public review seed produced no current review: ${JSON.stringify(reviewProjection)}`);
    }
    return {
      candidate: candidateProjection,
      feature: featureCompleted,
      review: reviewProjection,
      reviewRun: reviewCompleted,
    };
  } finally {
    closeFlowRuntime(runtime);
  }
}

export async function initializePublicReviewRepository(repository) {
  await execFile("git", ["-C", repository, "init", "--quiet", "--initial-branch", "main"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await execFile("git", ["-C", repository, "config", "commit.gpgsign", "false"]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
}

function featurePreparationRequest(repository) {
  return {
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:public-host-review",
      summary: "Produce one exact public-host review candidate",
      acceptance: ["the changed behavior is observable"],
    },
    repository: { path: repository },
    mode: "verify",
    dark_opt_in: DARK_OPT_IN,
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
    limits: { max_elapsed_seconds: 600 },
  };
}

async function reviewInputs(candidateProjection) {
  const target = {
    schema: "flow.review-local-candidate/v1",
    candidate: candidateProjection.candidate,
    candidate_fingerprint: candidateProjection.candidate_fingerprint,
    candidate_authority_watermark: candidateProjection.watermark,
    lifecycle_generation: 1,
  };
  const [security, critic] = await Promise.all([
    reviewDescription("codex", "gpt-5.6-sol", "security"),
    reviewDescription("claude", "haiku", "critic"),
  ]);
  return {
    schema: "flow.review-request/v1",
    target,
    lenses: ["security"],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: {
        security: {
          description: security,
          route: reviewRoute("agent:public-review-security", security),
        },
      },
      critic: {
        description: critic,
        route: reviewRoute("agent:public-review-critic", critic),
      },
    },
  };
}

function reviewFacts(candidateProjection) {
  const proposal = dynamicCheckpointProposal();
  const facts = proposal.explicit_facts;
  facts.operation_contracts.push("flow.operation/review-record/v1");
  facts.validator_contracts.push(
    "flow.validator/review-result/v1",
    "flow.validator/operation-receipt/v1",
  );
  facts.resource_claims.push({
    kind: "workspace",
    id: candidateProjection.workspace.subject_id,
    generation: candidateProjection.workspace.generation,
    mutation_epoch: candidateProjection.workspace.mutation_epoch,
    fingerprint: candidateProjection.workspace.fingerprint,
  });
  facts.limits = {
    ...facts.limits,
    max_cards: 4,
    max_resources: 1,
    max_elapsed_seconds: 600,
  };
  return facts;
}

function reviewDescription(harness, model, owner) {
  const launch = {
    harness,
    role: "reviewer",
    model,
    effort: "high",
    capability: "read-only",
  };
  return supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch,
    caller_metadata: { flow: "review/v1", owner },
  }, repositoryDrovrDependencies());
}

function reviewRoute(agentId, description) {
  return {
    agent_id: agentId,
    configuration_watermark: description.watermark.content_sha256,
    description_digest: description.description_digest,
    launch_comparison_key: description.comparison_keys.launch,
  };
}

function confirmedPredefinedLaunchRequest(prepared) {
  return {
    prepared,
    dark_opt_in: DARK_OPT_IN,
    confirmation: {
      schema: "flow.predefined-flow-confirmation-decision/v1",
      decision: "accept",
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    },
    closed_facts: {
      schema: "flow.closed-fact-observation/v1",
      bundle_digest: prepared.bundle_digest,
      facts: structuredClone(prepared.explicit_facts),
    },
  };
}

function assertAcceptedLaunch(launch, label) {
  if (launch?.schema !== "flow.launch-receipt/v1" ||
      typeof launch.run_id !== "string") {
    throw new Error(`public ${label} seed launch rejected: ${JSON.stringify(launch)}`);
  }
}

async function waitForTerminal(runtime, runId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let projection;
  while (Date.now() <= deadline) {
    projection = runtime.query({ run_id: runId });
    if (["succeeded", "failed", "cancelled"].includes(projection.phase)) {
      return projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for public seed run ${runId}: ${JSON.stringify(projection)}`);
}

function createPublicDelegatedAgentPort({ repository } = {}) {
  const turns = new Map();
  return {
    contract: "flow.delegated-agent-port/v1",
    async describe(request) {
      const description = await supportedDescription(
        { ...request, schema: "drovr.delegated-agent-description-request/v1" },
        repositoryDrovrDependencies(),
      );
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: description.watermark,
        description,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: null,
          findings: [],
        },
        legal_next_actions: ["bind_exact_launch_description"],
      };
    },
    async discover(request) {
      const existing = turns.get(request.caller_key);
      if (existing === undefined) {
        return absentDelegationProjection();
      }
      return workingDelegationProjection(existing);
    },
    async dispatch(request) {
      const turnId = `turn:${request.caller_key}`;
      if (request.description.launch.capability === "workspace-write") {
        await writeCandidate(repository);
      }
      const turn = { request, turnId };
      turns.set(request.caller_key, turn);
      return workingDelegationProjection(turn);
    },
    async wait(request) {
      const turn = [...turns.values()].find(({ turnId }) => turnId === request.turn_id);
      if (turn === undefined) throw new Error(`unknown public seed turn: ${request.turn_id}`);
      return completedTurnProjection({
        agentId: turn.request.agent_id,
        callerKey: turn.request.caller_key,
        description: turn.request.description,
        output: delegateOutput(turn.request.prompt),
        prompt: turn.request.prompt,
        turnId: turn.turnId,
      });
    },
    send() {
      throw new Error("public seed delegates do not accept steering");
    },
    observe() {
      return null;
    },
    cancel() {
      throw new Error("public seed delegates do not cancel");
    },
    reconcile() {
      return null;
    },
    async retire(request) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: digest(request.agent_id),
        },
        delegation: { agent_id: request.agent_id },
        turn: null,
        legal_next_actions: [],
      };
    },
  };
}

async function writeCandidate(repository) {
  await writeFile(join(repository, "feature.txt"), "after\n");
  await execFile("git", ["-C", repository, "add", "feature.txt"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "candidate"]);
}

function delegateOutput(prompt) {
  let envelope;
  try {
    envelope = JSON.parse(typeof prompt === "string" ? prompt : Buffer.from(prompt).toString("utf8"));
  } catch {
    envelope = null;
  }
  const taskInputs = envelope?.task_inputs ?? {};
  if (taskInputs.flow === "review/v1") {
    return JSON.stringify(freezeCanonical({
      schema: "flow.review-result/v1",
      posture: "no_findings",
      findings: [],
      evidence: { source: "public-review-seed" },
    }));
  }
  if (taskInputs.phase === "critique") {
    const criteria = taskInputs.brief?.acceptance ?? [];
    return JSON.stringify(freezeCanonical({
      schema: "flow.delegate-evidence/v1",
      observation: "independent",
      feature_critique: {
        schema: "flow.feature-critique-output/v1",
        candidate_digest: taskInputs.candidate_digest,
        predecessor_evidence_digest: taskInputs.predecessor_evidence_digest,
        task_inputs_digest: digest(taskInputs),
        criteria: criteria.map((criterion) => {
          const evidence = {
            kind: "git_file_equals",
            target: "feature.txt",
            expected: "after\n",
          };
          return {
            criterion,
            evidence,
            evidence_digest: digest({
              criterion,
              evidence,
              verdict: "passed",
            }),
            verdict: "passed",
          };
        }),
        findings: [],
      },
    }));
  }
  if (taskInputs.phase === "apply") {
    const criteria = taskInputs.brief?.acceptance ?? [];
    return JSON.stringify(freezeCanonical({
      schema: "flow.delegate-evidence/v1",
      observation: "workspace-write",
      feature_evidence: {
        schema: "flow.feature-criterion-evidence/v1",
        criteria: criteria.map((criterion) => ({
          criterion,
          kind: "git_file_equals",
          target: "feature.txt",
          expected: "after\n",
        })),
      },
    }));
  }
  return JSON.stringify(freezeCanonical({
    schema: "flow.delegate-evidence/v1",
    observation: taskInputs.phase ?? "public-review-seed",
  }));
}

function absentDelegationProjection() {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: `sha256:${"0".repeat(64)}`,
    },
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
}

function workingDelegationProjection(turn) {
  const { request, turnId } = turn;
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "working",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: digest(turnId),
    },
    delegation: {
      agent_id: request.agent_id,
      task_id: `task:${request.agent_id}`,
      group_id: "group:public-review-seed",
    },
    turn: {
      id: turnId,
      status: "working",
      caller: { dispatch_key: request.caller_key },
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: request.description.comparison_keys.launch,
        configuration_watermark: request.description.watermark.content_sha256,
        description_digest: request.description.description_digest,
      },
      inputs: [],
    },
    legal_next_actions: ["wait_bounded"],
  };
}
