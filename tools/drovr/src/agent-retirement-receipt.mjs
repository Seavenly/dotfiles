export const AGENT_RETIREMENT_RECEIPT_SCHEMA =
  "drovr.agent-retirement-receipt/v1";

export function createAgentRetirementReceipt({
  agent,
  observation,
  paneId,
  paneBefore,
  runtimeEvidence,
  proof,
  interruptedTurns,
  recordedAt,
}) {
  return {
    schema: AGENT_RETIREMENT_RECEIPT_SCHEMA,
    agent_id: agent.id,
    recorded_at: recordedAt,
    proof,
    observation: {
      evidence: observation.evidence,
      expected_identity: observation.expected_identity ?? {
        managed_agent: agent.herdr?.name ?? null,
        pane: agent.herdr?.pane_id ?? null,
        native_session: agent.native_session ?? null,
      },
      observed_identity: observation.identity ?? null,
      state: observation.state ?? null,
      runtime: runtimeEvidence
        ? {
            evidence: runtimeEvidence.evidence,
            ...(runtimeEvidence.reason
              ? { reason: runtimeEvidence.reason }
              : {}),
          }
        : null,
    },
    pane: {
      pane_id: paneId,
      before: paneBefore
        ? { evidence: "present", topology_binding: "matched" }
        : null,
      after: { evidence: "absent" },
    },
    interrupted_turns: interruptedTurns.map(({ id, status }) => ({
      id,
      status,
    })),
  };
}
