import { accepted, callProjectClient, followProjectSession, input, manualRunInspection, ownerStart, preparePreview, requirePublic, requireRun, submitDecision, submitPrepared } from "./project-session.mjs";
export { callProjectClient } from "./project-session.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { quoteShell } from "../scripts/feature-client-files.mjs";
import { discoverProjectRuns, failRun, loadRetainedPreview, readRunJson } from "./project-run-state.mjs";
import { renderRunPreview, renderRunResult, runDecisionActions, summarizeProjectRun, terminalText } from "./project-run-view.mjs";

export const RUN_USAGE = `Usage:
  flow-supervised run [--repository PATH] [--request FILE] [--json]
  flow-supervised run [same selection] --confirm sha256:DIGEST [--no-follow] [--json]
  flow-supervised run [same selection] --attach RUN_ID [--action sha256:DIGEST] [--json]
  flow-supervised run [same selection] --cancel RUN_ID [--json]

Run uses the exact initialized client and authority. Choose --request when several
retained requests exist. Preview starts/reuses the selected owner and may recover
previously accepted work; the new task launches only after explicit confirmation.
--confirm accepts the retained prepared task without preparing it again.
--refresh explicitly replaces an unlaunched preview; old evidence is retained.
Ctrl-C detaches this frontend; durable work continues. Use --attach to resume.
--cancel submits the fresh legal cancellation command, then observes settlement.
--action selects the exact digest of a currently offered checkpoint/recovery choice.
--no-follow returns after submission/attachment. --follow-seconds 1..3600 bounds
observation only (default 1800); it never changes the run's execution budget.
`;

export function parseRunArguments(args) {
  const options = {};
  const flags = new Set(["--json", "--no-follow", "--refresh", "--help", "-h"]);
  const values = new Set(["--repository", "--request", "--confirm", "--attach", "--cancel", "--action", "--follow-seconds"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (Object.hasOwn(options, flag) || !flags.has(flag) && !values.has(flag)) failRun(`Unknown or repeated run option: ${flag}`);
    options[flag] = flags.has(flag) ? true : args[++index];
    if (!options[flag] || typeof options[flag] === "string" && options[flag].startsWith("--")) failRun(`Missing value for ${flag}`);
  }
  if ([options["--confirm"], options["--attach"], options["--cancel"]].filter(Boolean).length > 1 || options["--refresh"] && (options["--confirm"] || options["--attach"] || options["--cancel"])) failRun("Choose preview/refresh, confirm, attach, or cancel separately.");
  if (options["--action"] && !options["--attach"]) failRun("Use --action with the exact --attach RUN_ID.");
  for (const flag of ["--confirm", "--action"]) if (options[flag] && !/^sha256:[a-f0-9]{64}$/u.test(options[flag])) failRun(`Use the exact ${flag} sha256 digest from the displayed preview/action.`);
  for (const flag of ["--attach", "--cancel"]) if (options[flag] && !/^run:[a-f0-9]{64}$/u.test(options[flag])) failRun(`Use the exact ${flag} RUN_ID returned by launch.`);
  const followSeconds = Number(options["--follow-seconds"] ?? 1800);
  if (!Number.isInteger(followSeconds) || followSeconds < 1 || followSeconds > 3600) failRun("Use --follow-seconds from 1 through 3600.");
  return options;
}

export async function runProject(args, { env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, callClient = callProjectClient } = {}) {
  let prompts, interrupted = false, selection, currentRun, intendedRunId;
  const onInterrupt = () => { interrupted = true; prompts?.close(); };
  process.on("SIGINT", onInterrupt);
  try {
    const options = parseRunArguments(args);
    if (options["--help"] || options["-h"]) { stdout.write(RUN_USAGE); return 0; }
    const interactive = Boolean(stdin.isTTY && stdout.isTTY && !options["--json"]);
    const emit = value => stdout.write(options["--json"] ? JSON.stringify(value) + "\n" : value.schema === "flow.project-run-owner/v1" ? `${terminalText(value.recovery_disclosure)}\n` : "");
    const directCall = (selected, command) => callClient(selected, command, { env });
    let allowStoppedStartup = true, compatibilityStarted = false;
    const call = async (selected, command) => {
      let result;
      try { result = await directCall(selected, command); }
      catch (error) {
        if (command[0] !== "query" || error.code !== "transport_unavailable" || !allowStoppedStartup) throw error;
        result = { schema: "flow.rejection/v1", code: "transport_unavailable" };
      }
      if (command[0] === "query" && result?.code === "transport_unavailable" && allowStoppedStartup && !compatibilityStarted) {
        const status = await directCall(selected, ["status", "--json"]);
        if (status?.state !== "stopped") return result;
        compatibilityStarted = true;
        await ownerStart(selected, directCall, emit);
        return directCall(selected, command);
      }
      return result;
    };
    const choices = discoverProjectRuns({ repository: options["--repository"], request: options["--request"], env, cwd });
    if (interactive) prompts = createInterface({ input: stdin, output: stdout });
    if (choices.length === 1) [selection] = choices;
    else {
      if (!interactive) failRun("Several initialized requests exist. Select --request FILE:", "selection_required", 2, choices.map(choice => choice.request));
      stdout.write("Choose the exact initialized task:\n" + choices.map((choice, index) => `  ${index + 1}. ${terminalText(choice.preparation.brief.summary)} (${terminalText(choice.request)}) [runtime ${terminalText(choice.runtime_root)}]`).join("\n") + "\n");
      const index = Number(await prompts.question("Task number: ")) - 1;
      if (!Number.isInteger(index) || !choices[index]) failRun("Choose one displayed task number; nothing was started.");
      selection = choices[index];
    }
    let runId = options["--attach"] ?? options["--cancel"];
    if (runId) {
      const retained = loadRetainedPreview(selection);
      if (!retained || retained.preview.run_id !== runId) failRun("This request does not own that retained run. Choose its original --request; no owner was started.", "run_request_mismatch", 1, manualRunInspection(selection, runId));
      intendedRunId = runId;
      currentRun = requireRun(await call(selection, input("query", { run_id: runId })), runId);
      if (currentRun.bundle_digest !== retained.preview.bundle_digest) failRun("Public run bundle differs from the retained preparation. Preserve all evidence.", "run_request_mismatch", 1);
      await ownerStart(selection, call, emit);
      if (options["--cancel"]) {
        const fresh = requireRun(await call(selection, input("query", { run_id: runId })), runId);
        const cancel = runDecisionActions(fresh).find(action => action.type === "cancel");
        if (!cancel && fresh.phase !== "cancelled") failRun("Cancellation is not currently offered. Reattach to inspect the current phase and legal recovery actions.", "cancel_unavailable", 1);
        if (cancel) await submitDecision(selection, runId, cancel.digest, call);
      } else if (options["--action"]) await submitDecision(selection, runId, options["--action"], call);
    } else {
      const retained = options["--confirm"] ? loadRetainedPreview(selection) : await preparePreview(selection, { refresh: options["--refresh"], call, emit });
      if (!retained) failRun("No retained preview exists. Run without --confirm first.", "preview_required", 1);
      intendedRunId = retained.preview.run_id;
      if (!options["--confirm"]) {
        if (options["--json"]) emit(retained.preview); else stdout.write(renderRunPreview(retained.preview));
        if (!interactive) { if (!options["--json"]) stdout.write(`Confirm with flow-supervised run --request ${quoteShell(selection.request)} --confirm ${retained.preview.confirmation_digest}\n`); return 0; }
        const answer = (await prompts.question("Launch this exact supervised task? [y/N] ")).trim().toLowerCase();
        if (!["y", "yes"].includes(answer)) { stdout.write("No new task launched. The selected owner may remain available.\n"); return 0; }
      }
      if (interrupted) return 130;
      currentRun = await submitPrepared(selection, retained, options["--confirm"] ?? retained.preview.confirmation_digest, { call, emit });
      runId = currentRun.run_id;
    }
    allowStoppedStartup = false;
    return await followProjectSession(selection, runId, { options, call, emit, interactive, prompts, stdout,
      isInterrupted: () => interrupted, renderResult: renderRunResult,
      finish: async (run, context) => {
        let candidate = null;
        if (run.review_candidate_reference?.candidate_id) {
          const result = await call(selection, input("query", { contract: "work.review/v1", subject_id: run.review_candidate_reference.candidate_id }));
          if (accepted(result)) candidate = result;
        }
        const status = context.status === "completed" ? candidate?.status === "sealed" ? "succeeded" : "blocked" : context.status;
        return summarizeProjectRun(run, { ...context, status, candidate });
      } });
  } catch (error) {
    if (interrupted || error.code === "ERR_USE_AFTER_CLOSE") {
      stderr.write(`Detached. Durable work has not been cancelled.${selection && intendedRunId ? ` Reattach with flow-supervised run --repository ${quoteShell(selection.repository)} --request ${quoteShell(selection.request)} --attach ${quoteShell(intendedRunId)}.` : " No new confirmation was granted."}\n`);
      return interrupted ? 130 : 1;
    }
    stderr.write(`${terminalText(error.message)}\n`);
    for (const hint of error.hints ?? []) stderr.write(terminalText(hint) + "\n");
    if (selection && intendedRunId) stderr.write(terminalText(`Retain the exact prepared/launch evidence. Reattach with flow-supervised run --repository ${quoteShell(selection.repository)} --request ${quoteShell(selection.request)} --attach ${quoteShell(intendedRunId)}`) + "\n");
    return error.exit ?? 1;
  } finally { prompts?.close(); process.removeListener("SIGINT", onInterrupt); }
}
