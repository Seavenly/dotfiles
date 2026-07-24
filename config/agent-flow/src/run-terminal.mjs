const TERMINAL_STATUSES = new Set(["done", "archived"]);

export function classifyRunTerminal({ cancellationAudit, tasks }) {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    cancellationAudit.issues.length > 0
  ) return "invalid";
  if (tasks.some(({ status }) => !TERMINAL_STATUSES.has(status))) {
    return "nonterminal";
  }
  if (tasks.some((task) =>
    task.status === "done" &&
    !hasTerminalCompletedAttempt(task)
  )) return "invalid";
  if (cancellationAudit.request !== null) return "cancelled";
  if (tasks.some(({ status }) => status === "archived")) return "invalid";
  return "completed";
}

export function hasTerminalCompletedAttempt({ runs }) {
  const terminal = Array.isArray(runs) ? runs.at(-1) : null;
  return terminal?.status === "done" && terminal.outcome === "completed";
}
