const CANCELLATION_PATTERN =
  /<!-- agent-flow-cancellation\n(?<document>\{[^\n]+\})\n-->/;

export function formatCancellationComment(request) {
  return [
    "Cancellation requested by agent-flow.",
    `Reason: ${request.reason}`,
    "",
    "<!-- agent-flow-cancellation",
    JSON.stringify(request),
    "-->",
  ].join("\n");
}

export function parseCancellationAudit(comments, runId) {
  const requests = [];
  const issues = [];
  for (const { author, body } of comments ?? []) {
    if (author !== "agent-flow") continue;
    if (!body?.includes("<!-- agent-flow-cancellation")) continue;
    const document = body?.match(CANCELLATION_PATTERN)?.groups?.document;
    if (!document) {
      issues.push("root has a malformed agent-flow cancellation marker");
      continue;
    }
    try {
      const request = JSON.parse(document);
      if (
        request?.run_id === runId &&
        typeof request.reason === "string" &&
        request.reason.length > 0 &&
        typeof request.requested_at === "string" &&
        Number.isFinite(Date.parse(request.requested_at))
      ) {
        requests.push(request);
      } else {
        issues.push("root has an invalid agent-flow cancellation marker");
      }
    } catch {
      issues.push("root has a malformed agent-flow cancellation marker");
    }
  }
  if (requests.length > 1) {
    issues.push("root has multiple agent-flow cancellation requests");
  }
  return { issues, request: requests[0] ?? null };
}
