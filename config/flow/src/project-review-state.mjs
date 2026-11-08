import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { discoverProjectRuns, failRun, loadRetainedPreview, readRunJson, retainRunJson } from "./project-run-state.mjs";

/** Different briefs on one immutable client are not different review targets. */
export function discoverReviewClients({ repository, client, env, cwd = process.cwd() }) {
  const clients = new Map();
  for (const selection of discoverProjectRuns({ repository, env, cwd })) {
    if (client && selection.directory !== resolve(cwd, client)) continue;
    if (!clients.has(selection.directory)) clients.set(selection.directory, selection);
  }
  if (!clients.size) failRun("Select an original initialized --client DIRECTORY for this project; no unknown client will be executed.");
  return [...clients.values()];
}

export function reviewPolicy(options) {
  const seconds = Number(options["--timeout-seconds"] ?? 600);
  const revisions = Number(options["--max-revisions"] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600 ||
      !Number.isSafeInteger(revisions) || revisions < 0 || revisions > 4) failRun("Use --timeout-seconds 1..3600 and --max-revisions 0..4. These are overall prepared-run limits, not per-role timers.");
  return { max_elapsed_seconds: seconds, max_revisions: revisions };
}

function selectionIdentity(client, producerId, target, policy) {
  return { schema: "flow.project-review-intent/v1", repository: client.repository,
    profile: client.profile, directory: client.directory, client: client.client,
    authority_directory: client.authority_directory, runtime_root: client.runtime_root,
    node: client.node, client_digest: client.client_digest, pilot_digest: client.pilot_digest,
    producer_run_id: producerId, target, policy };
}

// Inspect existing ancestors before recursive mkdir, including broken symlinks.
// Refusal must not create even an empty directory outside the retained client.
function assertCanonicalReviewPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current)) failRun("Retained review paths must remain in their original canonical client directory; aliases are unsupported.", "review_intent_changed", 1);
    if (dirname(current) === current) break;
  }
}

export function reviewSelection(client, producerId, target, policy, { create = false } = {}) {
  const identity = selectionIdentity(client, producerId, target, policy);
  const key = digest(identity).slice(7);
  const intentDirectory = join(client.directory, "receipts", "guided-review", key);
  const intentPath = join(intentDirectory, "intent.json");
  assertCanonicalReviewPath(intentDirectory);
  if (create) {
    mkdirSync(intentDirectory, { recursive: true, mode: 0o700 });
    if (existsSync(intentPath)) {
      if (digest(readRunJson(intentPath)) !== digest(identity)) failRun("Retained review intent changed; preserve its evidence.", "review_intent_changed", 1);
    } else retainRunJson(intentPath, identity);
  }
  return { ...client, ...identity, selection_digest: digest(identity),
    request: join(intentDirectory, "session", "prepare-request.json"),
    retained_directory: join(intentDirectory, "session"), intent_directory: intentDirectory,
    preview_schema: "flow.project-review-preview/v1", frontend_command: "review" };
}

/** Attachment never allocates an intent, starts an owner, or derives fresh facts. */
export function findReviewAttachment(clients, runId, producerId) {
  const found = [];
  for (const client of clients) {
    const root = join(client.directory, "receipts", "guided-review");
    if (!existsSync(root)) continue;
    if (realpathSync(root) !== resolve(root)) failRun("Retained review directory aliases are unsupported.", "review_intent_changed", 1);
    for (const name of readdirSync(root).sort()) {
      if (!/^[a-f0-9]{64}$/u.test(name)) failRun("Unknown retained review intent; inspect the original client.", "review_intent_changed", 1);
      const intent = readRunJson(join(root, name, "intent.json"));
      if (producerId && intent.producer_run_id !== producerId) continue;
      const selection = reviewSelection(client, intent.producer_run_id, intent.target, intent.policy);
      if (dirname(selection.retained_directory) !== join(root, name) || digest(intent) !== selection.selection_digest) failRun("Retained review/client binding changed.", "review_intent_changed", 1);
      const path = join(selection.retained_directory, "preview.json");
      if (!existsSync(path)) continue;
      const preview = readRunJson(path);
      if (preview.run_id !== runId) continue;
      const retained = loadRetainedPreview(selection);
      found.push({ selection, retained });
    }
  }
  if (found.length !== 1) failRun("Select the exact original --client DIRECTORY and retained review RUN_ID. No matching unique guided review was found; no owner was started.", "review_attachment_required", 1);
  return found[0];
}

/** Confirmation selects already-retained bytes, never fresh facts or another bundle. */
export function findReviewConfirmation(clients, confirmation, producerId, policy) {
  const found = [];
  for (const client of clients) {
    const root = join(client.directory, "receipts", "guided-review");
    if (!existsSync(root)) continue;
    if (realpathSync(root) !== resolve(root)) failRun("Retained review directory aliases are unsupported.", "review_intent_changed", 1);
    for (const name of readdirSync(root).sort()) {
      if (!/^[a-f0-9]{64}$/u.test(name)) failRun("Unknown retained review intent.", "review_intent_changed", 1);
      const intent = readRunJson(join(root, name, "intent.json"));
      if (producerId && intent.producer_run_id !== producerId || digest(intent.policy) !== digest(policy)) continue;
      const selection = reviewSelection(client, intent.producer_run_id, intent.target, intent.policy);
      if (dirname(selection.retained_directory) !== join(root, name) || digest(intent) !== selection.selection_digest) failRun("Retained review/client binding changed.", "review_intent_changed", 1);
      if (!existsSync(join(selection.retained_directory, "preview.json"))) continue;
      const retained = loadRetainedPreview(selection);
      if (retained.preview.confirmation_digest === confirmation) found.push({ selection, retained });
    }
  }
  if (found.length !== 1) failRun("No unique retained preview matches that exact confirmation and selected policy. Preview first; no fresh task was prepared.", "confirmation_changed", 1);
  return found[0];
}
