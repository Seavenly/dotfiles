import { collectProjectRuns } from "./project-runs-state.mjs";
import { projectRunsReport, renderProjectRuns } from "./project-runs-view.mjs";
import { terminalText } from "./project-run-view.mjs";

export const RUNS_USAGE = `Usage: flow-supervised runs [--repository PATH] [--client DIRECTORY] [--json]

Read retained project tasks, independent reviews and exact original next commands.
Lists all verified clients by default. --client filters an exact original client.
No owner start, recovery, refresh, confirmation, launch or lifecycle cleanup.
Stopped-owner inspection is historical, not proof of retirement or workspace reuse.
Exit 0: complete or uninitialized overview; 1: incomplete/unavailable; 2: invalid selection.
`;
export function parseRunsArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (["--json", "--help", "-h"].includes(key)) { if (options[key]) throw new Error(`Duplicate ${key}`); options[key] = true; continue; }
    if (!["--repository", "--client"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--") || options[key]) throw new Error(`Invalid runs option ${key}. Use runs --help.`);
    options[key] = args[++index];
  }
  return options;
}
export async function runProjectRuns(args, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  let options;
  try { options = parseRunsArguments(args); }
  catch (error) { stderr.write(terminalText(error.message) + "\n"); return 2; }
  if (options["--help"] || options["-h"]) { stdout.write(RUNS_USAGE); return 0; }
  try {
    const inventory = await collectProjectRuns({ repository: options["--repository"], client: options["--client"] }, { env, cwd, ...dependencies });
    const report = projectRunsReport(inventory);
    stdout.write(options["--json"] ? JSON.stringify(report) + "\n" : renderProjectRuns(report));
    return report.complete ? 0 : 1;
  } catch (error) { stderr.write(terminalText(error.message) + "\n"); return error.exit ?? 1; }
}
