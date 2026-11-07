import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { quoteShell } from "../scripts/feature-client-files.mjs";

export class ProjectRunError extends Error {
  constructor(message, code = "selection_required", exit = 2) { super(message); this.code = code; this.exit = exit; }
}
export const failRun = (message, code, exit) => { throw new ProjectRunError(message, code, exit); };

export function readRunJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) failRun(`Use a regular JSON file of at most 4 MiB: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function retainRunJson(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function flushRetainedRunFile(path) {
  if (!lstatSync(path).isFile()) failRun("Expected a regular retained launch request.", "launch_identity_changed", 1);
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Discover immutable local clients without starting their owner or executing them. */
export function discoverProjectRuns({ repository, request, env = process.env, cwd = process.cwd() } = {}) {
  let root;
  try {
    const selected = realpathSync(resolve(cwd, repository ?? "."));
    root = realpathSync(execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", selected, "rev-parse", "--show-toplevel"], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8", timeout: 10000, maxBuffer: 8192,
    }).trim());
  } catch { failRun("Run inside an initialized Git project, or select --repository PATH. Start with flow-supervised init."); }
  const stateHome = env.FLOW_LOCAL_CLIENT_STATE_HOME ?? env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local/state");
  const profileRoot = join(stateHome, "flow-local", digest(root).slice(7, 31));
  if (!existsSync(join(profileRoot, "profile.json"))) failRun("This project has no retained local setup in the selected state directory. Run flow-supervised init first.");
  const original = readRunJson(join(profileRoot, "profile.json"));
  if (realpathSync(profileRoot) !== resolve(profileRoot)) failRun("Select the original canonical local state directory; profile aliases cannot select another authority.");
  if (original.identity?.schema !== "flow.local-client/v1" || original.identity.repository !== root) failRun("Local profile repository identity changed; retain its state and inspect the existing setup.");
  const requested = request && resolve(cwd, request);
  const selections = [];
  for (const name of readdirSync(join(profileRoot, "clients")).sort()) {
    if (!/^(?:verify|[a-f0-9]{64})(?:\.runtime-[a-f0-9]{64})?$/u.test(name)) failRun("Unknown retained client identity; inspect the local profile before running.");
    const directory = join(profileRoot, "clients", name);
    const pilot = readRunJson(join(directory, "pilot.json"));
    const identity = pilot.local_client;
    const { runtime_root: _originalRuntime, ...pins } = original.identity;
    const { runtime_root: _selectedRuntime, ...selectedPins } = identity ?? {};
    const authority = join(profileRoot, "authority");
    const client = join(directory, "flow");
    if (realpathSync(directory) !== resolve(directory) || realpathSync(authority) !== resolve(authority)) failRun("Client or authority paths must retain their original canonical private layout.");
    if (!identity || digest(pins) !== digest(selectedPins) || pilot.directory !== directory ||
        pilot.runtime_root !== identity.runtime_root || pilot.environment?.FLOW_AUTHORITY_DIRECTORY !== authority ||
        pilot.environment?.FLOW_REPOSITORY_ROOT !== root || pilot.environment?.FLOW_OWNER_RUNTIME_MODULE !== join(directory, "trusted-owner.mjs") ||
        pilot.environment?.FLOW_EXECUTION_TRUST !== "supervised-native-cli" || pilot.node !== identity.node ||
        digestBytes(join(directory, "trusted-owner.mjs")) !== pilot.owner_module_sha256) failRun("Retained client identity or authority binding changed; use its original setup.");
    const expectedClient = `#!/bin/sh\nset -eu\n${Object.entries(pilot.environment).map(([key, value]) => `export ${key}=${quoteShell(value)}`).join("\n")}\nexec ${quoteShell(pilot.node)} ${quoteShell(join(pilot.runtime_root, "config/flow/src/cli.mjs"))} "$@"\n`;
    if (!lstatSync(client).isFile() || readFileSync(client, "utf8") !== expectedClient) failRun("Generated client bytes changed; retain the original client rather than executing an unknown command.");
    for (const entry of readdirSync(join(directory, "requests")).sort()) {
      const path = join(directory, "requests", entry, "prepare-request.json");
      if (realpathSync(path) !== resolve(path)) failRun("Retained request path aliases are unsupported; use the original canonical initialized request.");
      if (requested && path !== requested) continue;
      const preparation = readRunJson(path);
      if (preparation.schema !== "flow.feature-preparation-request/v1" || preparation.repository !== root ||
          digest(preparation.execution_trust) !== digest(pilot.execution_trust)) failRun("Retained request does not match its initialized project/client.");
      const binding = { repository: root, profile: realpathSync(join(profileRoot, "profile.json")), directory: realpathSync(directory), client: realpathSync(client), request: realpathSync(path),
        authority_directory: authority, runtime_root: pilot.runtime_root, node: pilot.node,
        client_digest: digestBytes(client), pilot_digest: digest(pilot), request_digest: digest(preparation) };
      selections.push({ ...binding, selection_digest: digest(binding), preparation, pilot,
        retained_directory: join(dirname(path), "guided-run") });
    }
  }
  if (!selections.length) failRun(requested ? "The selected request is not a retained request for this project. Use the exact path returned by init." : "No initialized feature request was found. Run flow-supervised init.");
  return selections;
}

function digestBytes(path) {
  if (!lstatSync(path).isFile()) failRun(`Expected a regular retained file: ${path}`);
  // canonical digest() hashes JSON values; file identities hash their original bytes.
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A process-lifetime submission mutex, not a lifecycle store or authority. */
export function lockProjectSubmission(selection) {
  const directory = dirname(selection.retained_directory);
  const db = new DatabaseSync(join(directory, "guided-submit.lock.sqlite"));
  try { db.exec("BEGIN EXCLUSIVE"); }
  catch { db.close(); failRun("Another frontend is preparing or submitting this exact request. Attach to its retained run or retry when it finishes.", "submission_busy", 1); }
  return () => { db.close(); };
}

export function loadRetainedPreview(selection) {
  const path = join(selection.retained_directory, "preview.json");
  if (!existsSync(path)) {
    if (existsSync(selection.retained_directory)) failRun("An incomplete owned preview remains. Use --refresh to retain it and prepare a new unlaunched preview; no launch is inferred.", "incomplete_preview", 1);
    return null;
  }
  const preview = readRunJson(path);
  if (preview.schema !== "flow.project-run-preview/v1" || preview.selection_digest !== selection.selection_digest) failRun("The selected request/client changed after preview. Retain old evidence and use --refresh for a new unlaunched preview.", "selection_changed", 1);
  if (preview.prepared_file !== join(selection.retained_directory, "prepared.json")) failRun("Retained preparation path changed.", "prepared_changed", 1);
  const prepared = readRunJson(preview.prepared_file);
  if (preview.prepared_file !== join(selection.retained_directory, "prepared.json") ||
      prepared.bundle_digest !== preview.bundle_digest || prepared.confirmation_digest !== preview.confirmation_digest ||
      digest(prepared.confirmation) !== prepared.confirmation_digest || digest(prepared.graph) !== prepared.plan_fingerprint ||
      digest(prepared) !== preview.prepared_digest) failRun("Retained preparation changed. Do not launch; inspect the retained files.", "prepared_changed", 1);
  return { preview, prepared };
}

export function retainProjectPreview(selection, prepared, inspection, ownerStarted) {
  if (prepared.schema !== "flow.prepared-run/v1" || !/^sha256:[a-f0-9]{64}$/u.test(prepared.bundle_digest ?? "") ||
      prepared.confirmation_digest !== digest(prepared.confirmation) || digest(prepared.graph) !== prepared.plan_fingerprint) failRun("Public preparation did not return a valid immutable prepared run.", "invalid_preparation", 1);
  if (!existsSync(selection.retained_directory)) mkdirSync(selection.retained_directory, { mode: 0o700 });
  const preparedFile = join(selection.retained_directory, "prepared.json");
  if (!existsSync(preparedFile)) retainRunJson(preparedFile, prepared);
  else if (digest(readRunJson(preparedFile)) !== digest(prepared)) failRun("Retained preparation changed before preview.", "prepared_changed", 1);
  const preview = { schema: "flow.project-run-preview/v1", status: "confirmation_required", request: selection.request,
    client: selection.client, runtime_root: selection.runtime_root, repository: selection.repository,
    authority_directory: selection.authority_directory, selection_digest: selection.selection_digest,
    prepared_file: preparedFile, prepared_digest: digest(prepared), confirmation_digest: prepared.confirmation_digest,
    bundle_digest: prepared.bundle_digest, run_id: `run:${prepared.bundle_digest.slice(7)}`, inspection,
    owner_started: ownerStarted,
    recovery_disclosure: "Starting or reusing the selected owner can recover previously accepted work. This new prepared task requires its own explicit launch confirmation.",
  };
  retainRunJson(join(selection.retained_directory, "preview.json"), preview);
  return { preview, prepared };
}

export function retireUnlaunchedPreview(selection, { rejectedBeforeAdmission = false } = {}) {
  if (existsSync(join(selection.retained_directory, "accepted.json")) && !rejectedBeforeAdmission) failRun("This request already has accepted launch intent. Attach to its exact run; never refresh uncertain accepted work.", "already_accepted", 1);
  renameSync(selection.retained_directory, selection.retained_directory + `.retained-${Date.now()}-${process.pid}`);
}
