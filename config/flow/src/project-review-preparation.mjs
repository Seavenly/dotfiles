import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";
import { failRun, readRunJson, retainRunJson } from "./project-run-state.mjs";
import { input, requirePublic, requireRun } from "./project-session.mjs";
import { summarizeProjectRun } from "./project-run-view.mjs";

const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value ?? "");
export async function observeReviewCandidate(client, producerId, call) {
  const producer = requireRun(await call(client, input("query", { run_id: producerId })), producerId);
  if (producer.phase !== "succeeded" || !producer.review_candidate_reference?.candidate_id) failRun("Producer has no completed retained candidate. Finish or inspect that exact run first.", "producer_incomplete", 1);
  const candidate = requirePublic(await call(client, input("query", { contract: "work.review/v1", subject_id: producer.review_candidate_reference.candidate_id })), "Candidate inspection");
  if (candidate.schema !== "work.review-candidate-projection/v1" || candidate.status !== "sealed" ||
      candidate.subject_id !== producer.review_candidate_reference.candidate_id ||
      candidate.candidate?.candidate_id !== candidate.subject_id ||
      candidate.candidate_fingerprint !== candidate.candidate?.candidate_fingerprint ||
      producer.review_candidate_reference.candidate_fingerprint !== candidate.candidate_fingerprint) failRun("The exact producer candidate is stale, unavailable or not currently sealed. Inspect its public currency and workspace actions; review was not launched.", "candidate_unavailable", 1);
  return { producer, candidate, target: { candidate_id: candidate.subject_id,
    candidate_fingerprint: candidate.candidate_fingerprint, lifecycle_generation: candidate.generation,
    candidate_authority_watermark: candidate.watermark } };
}

export async function boundedCandidateDiff(repository, producer, candidate) {
  const commit = (producer.effects ?? []).find(effect => effect.operation_contract === "flow.operation/feature-direct-commit/v1" &&
    effect.receipt?.provider_receipt?.schema === "flow.git-candidate-commit-receipt/v1")?.receipt.provider_receipt;
  const git = candidate.candidate?.git;
  if (!commit || !sha(commit.old_commit_sha) || !sha(commit.commit_sha) || commit.commit_sha !== git?.commit_sha ||
      commit.tree_sha !== git.tree_sha || commit.ref !== git.ref) failRun("This candidate lacks the supported exact registered commit comparison. Use its original public inspection commands; no baseline is guessed.", "comparison_unavailable", 1);
  const base = commit.old_commit_sha, head = commit.commit_sha;
  const prefix = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-C", repository];
  const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1" };
  const execute = args => promisify(execFile)("/usr/bin/git", [...prefix, ...args], { env, timeout: 10000, maxBuffer: 128 * 1024 });
  try {
    const parent = (await execute(["rev-parse", `${head}^`])).stdout.trim();
    if (parent !== base) failRun("Registered comparison ancestry no longer matches its exact retained commit.", "comparison_unavailable", 1);
  } catch (error) { if (error.code === "comparison_unavailable") throw error; failRun("Exact retained comparison objects are unavailable; no workspace diff is substituted.", "comparison_unavailable", 1); }
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--"];
  let text, truncated = false;
  try { text = (await execute(args)).stdout; }
  catch (error) {
    if (error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") failRun("The exact candidate diff could not be read within its bounded preview.", "comparison_unavailable", 1);
    text = String(error.stdout ?? ""); truncated = true;
  }
  const lines = text.split("\n");
  if (lines.length > 100 || Buffer.byteLength(text) > 16384) truncated = true;
  text = Buffer.from(lines.slice(0, 100).join("\n")).subarray(0, 16384).toString("utf8");
  return { base_commit_sha: base, commit_sha: head, tree_sha: git.tree_sha, ref: git.ref,
    diff: text, truncated, preview_limits: { lines: 100, bytes: 16384, process_ms: 10000 },
    full_inspection_command: ["env", ...Object.entries(env).filter(([key]) => key !== "PATH").map(([key, value]) => `${key}=${quoteShell(value)}`), "/usr/bin/git", ...prefix.map(quoteShell), ...args.map(quoteShell)].join(" ") };
}

/** The existing public bridge owns every candidate/facts/route field. */
export async function materializeReviewRequest(selection, { call }) {
  const observed = await observeReviewCandidate(selection, selection.producer_run_id, call);
  if (digest(observed.target) !== digest(selection.target)) failRun("Candidate identity/currency changed after selection. Refresh an unlaunched review and confirm its new exact preparation.", "candidate_changed", 1);
  const comparison = await boundedCandidateDiff(selection.repository, observed.producer, observed.candidate);
  const bridge = requirePublic(await call(selection, ["local", "review-request", selection.directory, selection.producer_run_id]), "Public review request");
  if (bridge.status !== "request_only" || typeof bridge.directory !== "string" ||
      dirname(bridge.directory) !== join(selection.directory, "receipts") || !bridge.directory.startsWith(join(selection.directory, "receipts", "review-")) ||
      bridge.request !== join(bridge.directory, "prepare-request.json") || realpathSync(bridge.directory) !== resolve(bridge.directory)) failRun("Public review bridge returned an unexpected retained request.", "review_request_changed", 1);
  const original = readRunJson(bridge.request);
  const target = original.inputs?.target, facts = original.inputs?.preparation_facts;
  if (original.schema !== "flow.predefined-flow-selection/v1" || original.definition !== "review/v1" ||
      target?.schema !== "flow.review-local-candidate/v1" || target.candidate?.candidate_id !== selection.target.candidate_id ||
      target.candidate_fingerprint !== selection.target.candidate_fingerprint || target.lifecycle_generation !== selection.target.lifecycle_generation ||
      target.candidate_authority_watermark !== selection.target.candidate_authority_watermark || facts?.source_run?.run_id !== selection.producer_run_id ||
      digest(original.execution_trust) !== digest(selection.pilot.execution_trust)) failRun("Public review request does not bind the selected producer/candidate/client. Preserve it for inspection.", "review_request_changed", 1);
  const request = { ...original, inputs: { ...original.inputs, limits: { ...original.inputs.limits, ...selection.policy } } };
  mkdirSync(selection.retained_directory, { recursive: true, mode: 0o700 });
  if (existsSync(selection.request)) failRun("This exact review already retained a preparation request. Refresh only proven unlaunched work.", "review_request_changed", 1);
  retainRunJson(selection.request, request);
  retainRunJson(join(selection.retained_directory, "public-bridge.json"), { ...bridge, original_request_digest: digest(original), policy: selection.policy });
  return { producer_run_id: selection.producer_run_id, target: selection.target, comparison,
    inherited_checks: { ...summarizeProjectRun(observed.producer, { selection, status: "succeeded" }).checks, rerun: false },
    public_bridge: bridge.request };
}
