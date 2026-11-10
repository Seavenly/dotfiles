import { collectProjectUsage } from "./project-usage-state.mjs";
import { terminalText } from "./project-run-view.mjs";

export const USAGE_HELP = `Usage: flow-supervised usage --run RUN_ID [--repository PATH] [--client DIRECTORY] [--json]

Read exact recorded attempt usage and admitted child runs. No owner start,
recovery, version probe, provider call or state write. Stopped inspection is
historical. Missing metrics remain unknown; CLI list estimates are not billing.
Exit 0: complete inspection (individual metrics/cost may be unknown).
Exit 1: unavailable, conflicting or truncated evidence; 2: invalid selection.
`;
export function renderProjectUsage(report) {
  const lines = ["Flow recorded usage", `Project: ${report.repository ?? "unavailable"}`, `Run: ${report.root_run_id}`, `Observation: ${report.observation}; collected ${report.observed_at}`, `Inspection: ${report.complete ? "complete" : "incomplete"}`];
  if (report.observation === "inspect_only") lines.push("Historical inspect-only evidence; no owner started. Usage does not prove success, retirement, approval or workspace reuse.");
  for (const attempt of report.attempts) {
    lines.push("", `${attempt.card_id}: ${attempt.status}`, `  Attempt: ${attempt.attempt_id}`, `  ${attempt.harness ?? "provider unknown"}; requested model ${attempt.model.requested ?? "unknown"}; reported model ${attempt.model.reported ?? "unknown"}; CLI ${attempt.cli_version ?? "unknown"}`);
    for (const [name, value] of Object.entries(attempt.metrics)) lines.push(`  ${name}: ${value ?? "unknown"}`);
    if (attempt.token_semantics) lines.push(`  Token meaning: ${attempt.token_semantics}`);
    if (attempt.turn_semantics) lines.push(`  Turn meaning: ${attempt.turn_semantics}`);
    lines.push(`  CLI estimate: ${attempt.cost.usd === null ? "unknown" : `$${attempt.cost.usd} (${attempt.cost.basis})`}`);
    for (const code of attempt.diagnostics) lines.push(`  Unavailable: ${code}`);
  }
  lines.push("", `Distinct attempts: ${report.attempts.length}; adopted/replayed duplicates omitted: ${report.deduplicated_attempts}`, `Known CLI list-cost subtotal: ${report.cost.known_list_cost_usd === null ? "unknown" : `$${report.cost.known_list_cost_usd}`}; unknown-cost attempts: ${report.cost.unknown_attempts}`, "Actual billing: unknown. Pricing date/rate-table version: unknown; no external price lookup.");
  for (const item of report.diagnostics) lines.push(`Unavailable: ${item.run_id} ${item.code}`);
  return lines.map(terminalText).join("\n") + "\n";
}
export async function runProjectUsage(args, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  const options = {};
  try {
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (["--help", "-h", "--json"].includes(key)) { if (options[key]) throw new Error(`Duplicate ${key}`); options[key] = true; continue; }
      if (!["--run", "--repository", "--client"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--") || options[key]) throw new Error(`Invalid usage option ${key}. Use usage --help.`);
      options[key] = args[++index];
    }
    if (options["--help"] || options["-h"]) { stdout.write(USAGE_HELP); return 0; }
    const report = await collectProjectUsage({ run: options["--run"], repository: options["--repository"], client: options["--client"] }, { env, cwd, ...dependencies });
    stdout.write(options["--json"] ? JSON.stringify(report) + "\n" : renderProjectUsage(report)); return report.complete ? 0 : 1;
  } catch (error) { stderr.write(terminalText(error.message) + "\n"); return error.exit ?? 2; }
}
