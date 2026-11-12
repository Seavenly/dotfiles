import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";
import { failRun, flushRetainedRunFile, loadRetainedPreview, lockProjectSubmission, readRunJson, retainProjectPreview, retainRunJson, retireUnlaunchedPreview } from "./project-run-state.mjs";
import { projectRunBlocked, projectRunProgress, renderRunProgress, runDecisionActions, terminalText } from "./project-run-view.mjs";

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

export const input = (operation, request) => [operation, "--input", JSON.stringify(request), "--json"];
export const accepted = value => value?.schema !== "flow.rejection/v1";
export function requirePublic(value, label) {
  if (!accepted(value)) failRun(`${label} refused: ${value.code}${value.reason ? ` (${value.reason})` : ""}. Inspect retained evidence and refresh only an unlaunched preparation.`, value.code, 1);
  return value;
}
export function requireRun(value, runId) {
  if (value?.schema !== "flow.run-projection/v1" || value.run_id !== runId) failRun(`The exact run is unavailable: ${value?.code ?? "invalid projection"}. Keep its launch evidence; do not launch a replacement.`, value?.code ?? "run_unavailable", 1);
  return value;
}
const runIdFor = prepared => `run:${prepared.bundle_digest.slice(7)}`;
export const noReceipt = effect => !effect.receipt && !["not_created", "abandoned"].includes(effect.status);
const beforeAdmissionCodes = new Set(["closed_facts_changed", "facts_changed", "source_run_changed", "workspace_fingerprint_changed", "feature_git_identity_drift", "feature_test_check_drift", "project_check_input_drift"]);
// These typed launch rejections come from compareReviewPreparationFacts. They
// authorize refresh only with the same launch bundle and a fresh unknown_run.
const reviewBeforeAdmissionCodes = new Set(["candidate_changed", "workspace_changed", "run_authority_changed", "review_authority_changed", "workspace_authority_changed", "route_changed", "catalog_changed", "operation_changed", "validator_changed", "time_changed", "authority_changed"]);
const beforeAdmission = (selection, code) => beforeAdmissionCodes.has(code) ||
  selection.frontend_command === "research" && ["research_packet_changed", "research_route_changed"].includes(code) ||
  selection.frontend_command === "review" && reviewBeforeAdmissionCodes.has(code);
export function manualRunInspection(selection, runId) {
  const client = quoteShell(selection.client), request = quoteShell(JSON.stringify({ run_id: runId }));
  return ["This retained run has no matching guided receipt for the selected request. Preserve its original client and history; inspect it with:",
    `${client} status --json`, `${client} query --input ${request} --json`, `${client} watch --input ${request} --json`,
    `If its owner is stopped, ${client} start --json starts that exact owner and may recover previously accepted work.`];
}

export async function ownerStart(selection, call, emit) {
  const before = requirePublic(await call(selection, ["status", "--json"]), "Owner status");
  if (!["running", "stopped"].includes(before.state)) failRun(`Selected owner is ${before.state}; inspect its public status before continuing.`, "owner_unavailable", 1);
  const parallel = selection.execution?.parallel === 2;
  const requireCapacity = status => {
    if (parallel && !(status.runner?.delegates?.capacity >= 2)) failRun(
      `The selected owner has insufficient delegate capacity. After all original work settles, stop that exact owner with ${quoteShell(selection.client)} stop --json, then start it with ${quoteShell(selection.client)} start --delegate-capacity 2 --json. No running owner was reconfigured.`,
      "owner_delegate_capacity_insufficient", 1);
  };
  if (before.state === "running") requireCapacity(before);
  emit({ schema: "flow.project-run-owner/v1", state: before.state,
    recovery_disclosure: "Starting/reusing this exact owner may recover previously authorized work. A new task still requires exact launch confirmation." });
  // Public start is also the runtime/module/check identity fence for a running
  // owner. Status alone cannot establish compatible reuse on a shared authority.
  const result = requirePublic(await call(selection, parallel
    ? ["start", "--delegate-capacity", "2", "--json"] : ["start", "--json"]), "Owner start/reuse");
  if (result.state !== "running") failRun(`Selected owner did not become running (${result.state}).`, "owner_unavailable", 1);
  requireCapacity(result);
  return before.state === "stopped" && result.started !== false;
}

export async function preparePreview(selection, { refresh, call, emit, materializeRequest }) {
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
        beforeAdmission(selection, rejection.code) && rejection.bundle_digest === retained.preview.bundle_digest;
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
    const details = materializeRequest ? await materializeRequest(selection, { call }) : {};
    const prepared = requirePublic(await call(selection, ["prepare", "--input-file", selection.request, "--json"]), "Preparation");
    if (!existsSync(selection.retained_directory)) mkdirSync(selection.retained_directory, { mode: 0o700 });
    const preparedFile = join(selection.retained_directory, "prepared.json");
    retainRunJson(preparedFile, prepared);
    const inspection = requirePublic(await call(selection, ["local", "inspect-prepared", preparedFile]), "Prepared inspection");
    return retainProjectPreview(selection, prepared, inspection, ownerStarted, details);
  } finally { unlock(); }
}

export async function submitPrepared(selection, retained, confirmation, { call, emit, validateBeforeSend }) {
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
    if (validateBeforeSend) await validateBeforeSend();
    let receipt;
    try { receipt = await call(selection, ["launch", "--input-file", launchPath, "--json"]); }
    catch (error) {
      const adopted = await call(selection, input("query", { run_id: runId }));
      if (adopted?.schema === "flow.run-projection/v1") return requireRun(adopted, runId);
      throw error;
    }
    const receiptPath = join(selection.retained_directory, `launch-response-${Date.now()}-${process.pid}.json`);
    retainRunJson(receiptPath, receipt);
    if (receipt?.schema === "flow.rejection/v1" && receipt.operation === "launch" && beforeAdmission(selection, receipt.code) &&
        receipt.bundle_digest === current.preview.bundle_digest && !existsSync(join(selection.retained_directory, "rejected-before-admission.json"))) retainRunJson(join(selection.retained_directory, "rejected-before-admission.json"), receipt);
    requirePublic(receipt, "Launch");
    if (receipt.run_id !== runId) failRun("Public launch returned a different run identity. Preserve all evidence.", "launch_identity_changed", 1);
    return requireRun(await call(selection, input("query", { run_id: runId })), runId);
  } finally { unlock(); }
}

export async function submitDecision(selection, runId, selectedDigest, call) {
  await ownerStart(selection, call, () => {});
  const fresh = requireRun(await call(selection, input("query", { run_id: runId })), runId);
  const action = runDecisionActions(fresh).find(candidate => candidate.digest === selectedDigest);
  if (!action) failRun("That decision is no longer offered at the current authority watermark. Reattach and inspect the fresh choices; no command was submitted.", "stale_decision", 1);
  const path = join(selection.retained_directory, `decision-${action.digest.slice(7)}.json`);
  if (!existsSync(path)) retainRunJson(path, action.command);
  else if (digest(readRunJson(path)) !== action.digest) failRun("Retained decision bytes changed; no command was submitted.", "decision_changed", 1);
  return requirePublic(await call(selection, ["command", "--input-file", path, "--json"]), "Decision");
}

/** Observe only public projections; the owner remains the sole executor. */
export async function followProjectSession(selection, runId, { options, call, emit, interactive, prompts, stdout, isInterrupted, finish, renderResult }) {
  let currentRun;
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
      const blocked = projectRunBlocked(currentRun);
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
      if (isInterrupted() || detachedChoice || ownerLost || Date.now() >= deadline || options["--no-follow"] || terminal && !unresolved.length || blocked) {
        const status = ownerLost ? "owner_unavailable" : isInterrupted() || detachedChoice || Date.now() >= deadline || options["--no-follow"] ? "detached" : blocked || unresolved.length ? "blocked"
          : currentRun.phase === "succeeded" ? "completed" : currentRun.phase === "cancelled" ? "cancelled" : "blocked";
        const result = await finish(currentRun, { selection, status, projectionFile: lastProjectionFile, call });
        retainRunJson(join(selection.retained_directory, `result-${Date.now()}-${process.pid}.json`), result);
        if (options["--json"]) emit(result); else stdout.write(renderResult(result));
        return isInterrupted() ? 130 : ["succeeded", "detached"].includes(result.status) ? 0 : 1;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
