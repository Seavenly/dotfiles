import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";
import { discoverProjectRuns, failRun, flushRetainedRunFile, loadRetainedPreview, lockProjectSubmission, readRunJson, retainProjectPreview, retainRunJson, retireUnlaunchedPreview } from "./project-run-state.mjs";
import { projectRunProgress, renderRunPreview, renderRunProgress, renderRunResult, runDecisionActions, summarizeProjectRun, terminalText } from "./project-run-view.mjs";

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

/** Calls only the exact generated client; no shell strings or authority-file edits. */
export async function callProjectClient(selection, args, { env = process.env } = {}) {
  try {
    const result = await promisify(execFile)(selection.client, args, { env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    for (const text of [error.stderr, error.stdout]) {
      try { const result = JSON.parse(text); if (result.schema === "flow.rejection/v1") return result; } catch { /* Keep typed transport uncertainty when no public result exists. */ }
    }
    failRun(`The selected client did not return a public response. Retain its evidence and attach to the exact run; no replacement task was prepared. ${error.code ?? "transport unavailable"}`, "transport_unavailable", 1);
  }
}

const input = (operation, request) => [operation, "--input", JSON.stringify(request), "--json"];
const accepted = value => value?.schema !== "flow.rejection/v1";
function requirePublic(value, label) {
  if (!accepted(value)) failRun(`${label} refused: ${value.code}${value.reason ? ` (${value.reason})` : ""}. Inspect retained evidence and refresh only an unlaunched preparation.`, value.code, 1);
  return value;
}
function requireRun(value, runId) {
  if (value?.schema !== "flow.run-projection/v1" || value.run_id !== runId) failRun(`The exact run is unavailable: ${value?.code ?? "invalid projection"}. Keep its launch evidence; do not launch a replacement.`, value?.code ?? "run_unavailable", 1);
  return value;
}
const runIdFor = prepared => `run:${prepared.bundle_digest.slice(7)}`;
const noReceipt = effect => !effect.receipt && !["not_created", "abandoned"].includes(effect.status);
const beforeAdmissionCodes = new Set(["closed_facts_changed", "facts_changed", "source_run_changed", "workspace_fingerprint_changed", "feature_git_identity_drift", "feature_test_check_drift", "project_check_input_drift"]);
function manualRunInspection(selection, runId) {
  const client = quoteShell(selection.client), request = quoteShell(JSON.stringify({ run_id: runId }));
  return ["This retained run has no matching guided receipt for the selected request. Preserve its original client and history; inspect it with:",
    `${client} status --json`, `${client} query --input ${request} --json`, `${client} watch --input ${request} --json`,
    `If its owner is stopped, ${client} start --json starts that exact owner and may recover previously accepted work.`];
}

async function ownerStart(selection, call, emit) {
  const before = requirePublic(await call(selection, ["status", "--json"]), "Owner status");
  if (!["running", "stopped"].includes(before.state)) failRun(`Selected owner is ${before.state}; inspect its public status before continuing.`, "owner_unavailable", 1);
  emit({ schema: "flow.project-run-owner/v1", state: before.state,
    recovery_disclosure: "Starting/reusing this exact owner may recover previously authorized work. A new task still requires exact launch confirmation." });
  // Public start is also the runtime/module/check identity fence for a running
  // owner. Status alone cannot establish compatible reuse on a shared authority.
  const result = requirePublic(await call(selection, ["start", "--json"]), "Owner start/reuse");
  if (result.state !== "running") failRun(`Selected owner did not become running (${result.state}).`, "owner_unavailable", 1);
  return before.state === "stopped" && result.started !== false;
}

async function preparePreview(selection, { refresh, call, emit }) {
  const unlock = lockProjectSubmission(selection);
  try {
    let retained;
    try { retained = loadRetainedPreview(selection); }
    catch (error) {
      if (!refresh || error.code !== "incomplete_preview") throw error;
      // No preview/accepted marker exists; no launch was possible through this frontend.
      // The authority index below must still be inspectable and contain no unresolved work.
      retireUnlaunchedPreview(selection);
      retained = null;
    }
    if (retained && !refresh) return retained;
    if (retained && refresh) {
      const known = await call(selection, input("query", { run_id: retained.preview.run_id }));
      if (known?.schema === "flow.run-projection/v1") failRun(`This exact bundle already owns ${known.run_id}. Attach to it instead of refreshing.`, "already_launched", 1);
      if (known?.code !== "unknown_run") failRun("Cannot prove the preview is unlaunched. Preserve it and inspect the selected authority.", "launch_outcome_unknown", 1);
      const rejectionPath = join(selection.retained_directory, "rejected-before-admission.json");
      const rejection = existsSync(rejectionPath) ? readRunJson(rejectionPath) : null;
      const rejectedBeforeAdmission = rejection?.schema === "flow.rejection/v1" && rejection.operation === "launch" &&
        beforeAdmissionCodes.has(rejection.code) && rejection.bundle_digest === retained.preview.bundle_digest;
      retireUnlaunchedPreview(selection, { rejectedBeforeAdmission });
      retained = null;
    }
    const index = requirePublic(await call(selection, input("query", {})), "Read-only run index");
    if (index.schema !== "flow.run-index-projection/v1" || !Array.isArray(index.runs) || !["compatible", "uninitialized"].includes(index.authority_schema?.status)) failRun("Selected authority did not return a compatible known run index.", "authority_unavailable", 1);
    const existing = [];
    for (const id of index.runs) {
      const run = requireRun(await call(selection, input("query", { run_id: id })), id);
      if (run.phase === "active" || run.effects?.some(noReceipt)) existing.push(id);
    }
    if (existing.length) failRun(`Existing work needs inspection before a new task: ${existing.join(", ")}.`, "existing_work", 1, manualRunInspection(selection, existing[0]));
    const ownerStarted = await ownerStart(selection, call, emit);
    const prepared = requirePublic(await call(selection, ["prepare", "--input-file", selection.request, "--json"]), "Preparation");
    mkdirSync(selection.retained_directory, { mode: 0o700 });
    const preparedFile = join(selection.retained_directory, "prepared.json");
    retainRunJson(preparedFile, prepared);
    const inspection = requirePublic(await call(selection, ["local", "inspect-prepared", preparedFile]), "Prepared inspection");
    return retainProjectPreview(selection, prepared, inspection, ownerStarted);
  } finally { unlock(); }
}

async function submitPrepared(selection, retained, confirmation, { call, emit }) {
  const unlock = lockProjectSubmission(selection);
  try {
    const current = loadRetainedPreview(selection);
    if (!current || current.preview.confirmation_digest !== confirmation || digest(current.prepared) !== digest(retained.prepared)) failRun("Confirmation does not match the retained exact task. Inspect the preview again.", "confirmation_changed", 1);
    const runId = runIdFor(current.prepared);
    const known = await call(selection, input("query", { run_id: runId }));
    if (known?.schema === "flow.run-projection/v1") {
      await ownerStart(selection, call, emit);
      return requireRun(known, runId);
    }
    if (known?.code !== "unknown_run") failRun("The exact launch outcome cannot be inspected. Keep the prepared task and attach; do not refresh it.", "launch_outcome_unknown", 1);
    await ownerStart(selection, call, emit);
    const intentFile = join(selection.retained_directory, "accepted.json");
    let launchPath;
    if (existsSync(intentFile)) {
      const intent = readRunJson(intentFile);
      if (intent.run_id !== runId || intent.prepared_digest !== digest(current.prepared)) failRun("Saved launch intent changed; preserve it for inspection.", "launch_identity_changed", 1);
      launchPath = intent.launch_file;
      if (digest(readRunJson(launchPath)) !== intent.launch_digest) failRun("Saved exact launch bytes changed; no replacement will be sent.", "launch_identity_changed", 1);
    } else {
      const acceptedTask = requirePublic(await call(selection, ["local", "accept-prepared", selection.directory, current.preview.prepared_file]), "Prepared acceptance");
      launchPath = acceptedTask.request;
      if (typeof launchPath !== "string" || !launchPath.startsWith(join(selection.directory, "receipts") + "/") || basename(launchPath) !== "launch-request.json") failRun("Public acceptance returned an unexpected launch path.", "launch_identity_changed", 1);
      const launch = readRunJson(launchPath);
      if (digest(launch.prepared) !== digest(current.prepared) || launch.confirmation?.confirmation_digest !== confirmation) failRun("Public acceptance changed the selected prepared identity.", "launch_identity_changed", 1);
      flushRetainedRunFile(launchPath);
      retainRunJson(intentFile, { run_id: runId, prepared_digest: digest(current.prepared), launch_file: launchPath, launch_digest: digest(launch) });
    }
    const exactLaunch = readRunJson(launchPath);
    if (digest(exactLaunch.prepared) !== digest(current.prepared) || exactLaunch.confirmation?.confirmation_digest !== confirmation) failRun("Saved launch does not contain the exact confirmed prepared task. No command was sent.", "launch_identity_changed", 1);
    let receipt;
    try { receipt = await call(selection, ["launch", "--input-file", launchPath, "--json"]); }
    catch (error) {
      const adopted = await call(selection, input("query", { run_id: runId }));
      if (adopted?.schema === "flow.run-projection/v1") return requireRun(adopted, runId);
      throw error;
    }
    const receiptPath = join(selection.retained_directory, `launch-response-${Date.now()}-${process.pid}.json`);
    retainRunJson(receiptPath, receipt);
    if (receipt?.schema === "flow.rejection/v1" && receipt.operation === "launch" && beforeAdmissionCodes.has(receipt.code) &&
        receipt.bundle_digest === current.preview.bundle_digest && !existsSync(join(selection.retained_directory, "rejected-before-admission.json"))) retainRunJson(join(selection.retained_directory, "rejected-before-admission.json"), receipt);
    requirePublic(receipt, "Launch");
    if (receipt.run_id !== runId) failRun("Public launch returned a different run identity. Preserve all evidence.", "launch_identity_changed", 1);
    return requireRun(await call(selection, input("query", { run_id: runId })), runId);
  } finally { unlock(); }
}

async function submitDecision(selection, runId, selectedDigest, call) {
  await ownerStart(selection, call, () => {});
  const fresh = requireRun(await call(selection, input("query", { run_id: runId })), runId);
  const action = runDecisionActions(fresh).find(candidate => candidate.digest === selectedDigest);
  if (!action) failRun("That decision is no longer offered at the current authority watermark. Reattach and inspect the fresh choices; no command was submitted.", "stale_decision", 1);
  const path = join(selection.retained_directory, `decision-${action.digest.slice(7)}.json`);
  if (!existsSync(path)) retainRunJson(path, action.command);
  else if (digest(readRunJson(path)) !== action.digest) failRun("Retained decision bytes changed; no command was submitted.", "decision_changed", 1);
  return requirePublic(await call(selection, ["command", "--input-file", path, "--json"]), "Decision");
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
    const deadline = Date.now() + Number(options["--follow-seconds"] ?? 1800) * 1000;
    let previous, lastProjectionFile;
    for (;;) {
      currentRun = requireRun(await call(selection, input("query", { run_id: runId })), runId);
      const progress = projectRunProgress(currentRun);
      if (digest(progress) !== previous) {
        if (!existsSync(selection.retained_directory)) mkdirSync(selection.retained_directory, { mode: 0o700 });
        const projectionFile = join(selection.retained_directory, `projection-${currentRun.sequence}-${digest(currentRun).slice(7, 19)}.json`);
        lastProjectionFile = projectionFile;
        if (!existsSync(projectionFile)) retainRunJson(projectionFile, currentRun);
        progress.projection_file = projectionFile;
        if (options["--json"]) emit(progress); else stdout.write(renderRunProgress(progress));
        previous = digest(projectRunProgress(currentRun));
      }
      const unresolved = (currentRun.effects ?? []).filter(noReceipt);
      const terminal = ["succeeded", "cancelled", "declined", "failed"].includes(currentRun.phase);
      const blocked = currentRun.progress === "blocked" || (currentRun.effects ?? []).some(effect => ["blocked", "exhausted"].includes(effect.retry?.status));
      const decisions = runDecisionActions(currentRun).filter(action => action.type !== "cancel");
      let detachedChoice = false;
      if (interactive && decisions.length && (blocked || terminal || !unresolved.length)) {
        stdout.write("Current authority choices (none is automatic):\n" + decisions.map((action, index) => `  ${index + 1}. ${terminalText(action.label)} [${action.digest}]`).join("\n") + "\n");
        const answer = await prompts.question("Choice number, or Enter to detach: ");
        if (answer.trim()) {
          const action = decisions[Number(answer) - 1];
          if (!action) failRun("Choose a displayed authority action; no decision was submitted.");
          stdout.write(JSON.stringify(action.command, null, 2) + "\n");
          if (["y", "yes"].includes((await prompts.question("Submit this exact decision? [y/N] ")).trim().toLowerCase())) { await submitDecision(selection, runId, action.digest, call); previous = null; continue; }
        }
        detachedChoice = true;
      }
      const owner = requirePublic(await call(selection, ["status", "--json"]), "Owner status");
      const ownerLost = owner.state !== "running";
      if (interrupted || detachedChoice || ownerLost || Date.now() >= deadline || options["--no-follow"] || terminal && !unresolved.length || blocked) {
        let candidate = null;
        if (currentRun.review_candidate_reference?.candidate_id) {
          const result = await call(selection, input("query", { contract: "work.review/v1", subject_id: currentRun.review_candidate_reference.candidate_id }));
          if (accepted(result)) candidate = result;
        }
        const status = ownerLost ? "owner_unavailable" : interrupted || detachedChoice || Date.now() >= deadline || options["--no-follow"] ? "detached" : blocked || unresolved.length ? "blocked"
          : currentRun.phase === "succeeded" && candidate?.status === "sealed" ? "succeeded"
            : currentRun.phase === "cancelled" ? "cancelled" : "blocked";
        const result = summarizeProjectRun(currentRun, { selection, candidate, status, projectionFile: lastProjectionFile });
        retainRunJson(join(selection.retained_directory, `result-${Date.now()}-${process.pid}.json`), result);
        if (options["--json"]) emit(result); else stdout.write(renderRunResult(result));
        return interrupted ? 130 : ["succeeded", "detached"].includes(status) ? 0 : 1;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
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
