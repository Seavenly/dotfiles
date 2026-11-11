import { researchSelection } from "./project-research-state.mjs";
import { execFile } from "node:child_process";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { createFlowClient } from "./client.mjs";
import { flowOwnerPaths, statusFlowOwner } from "./owner-process.mjs";
import { deriveOwnerRuntimeBinding, ownerRuntimeBindingEqual } from "./owner-runtime-binding.mjs";
import { loadRetainedPreview, locateProjectProfile, readRunJson, readValidatedProjectClient, readValidatedProjectRequest } from "./project-run-state.mjs";
import { readReviewRecord } from "./project-review-view.mjs";
import { reviewSelection } from "./project-review-state.mjs";

export const RUNS_LIMITS = Object.freeze({ clients: 32, attempts: 128, queries: 64, directory_entries: 128, file_bytes: 4 * 1024 * 1024, output_bytes: 1024 * 1024, elapsed_ms: 15000 });
const clientName = /^(?:verify|[a-f0-9]{64})(?:\.runtime-[a-f0-9]{64})?$/u;
const runId = /^run:[a-f0-9]{64}$/u;
const acceptedWarning = "Accepted launch intent is retained; admission must be observed independently.";
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Bounded reads only. Missing, broken and redirected paths remain different facts. */
export function projectRunReadScope(limits = RUNS_LIMITS, now = Date.now) {
  const deadline = now() + limits.elapsed_ms;
  const remaining = () => { const ms = deadline - now(); if (ms <= 0) throw failure("deadline", "Overview deadline reached; remaining work is unknown."); return ms; };
  function exists(path) {
    remaining();
    try { lstatSync(path); return true; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      let parent = dirname(path);
      for (;;) {
        remaining();
        try { const stat = lstatSync(parent); if (!stat.isDirectory() || realpathSync(parent) !== resolve(parent)) throw failure("unsafe_path", "Missing state has a broken or aliased ancestor."); return false; }
        catch (parentError) { if (parentError.code !== "ENOENT") throw parentError; parent = dirname(parent); }
      }
    }
  }
  function regular(path, maxBytes = limits.file_bytes) {
    remaining(); const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes || realpathSync(path) !== resolve(path)) throw failure("unsafe_file", "Use an original canonical regular file of at most 4 MiB.");
  }
  function directory(path) {
    remaining(); const stat = lstatSync(path);
    if (!stat.isDirectory() || realpathSync(path) !== resolve(path)) throw failure("unsafe_directory", "Use the original canonical private directory; aliases are unavailable.");
  }
  function entries(path, count = limits.directory_entries) {
    directory(path); const stream = opendirSync(path), names = [];
    try {
      for (;;) { remaining(); const entry = stream.readSync(); if (!entry) break; if (names.length >= count) throw failure("entry_limit", "Directory entry limit reached; this directory was not partially selected."); names.push(entry.name); }
    } finally { stream.closeSync(); }
    return names.sort();
  }
  const wait = async factory => {
    const ms = remaining(); let timer;
    try { return await Promise.race([factory(ms), new Promise((_, reject) => { timer = setTimeout(() => reject(failure("deadline", "Overview deadline reached; observation is unavailable.")), ms); })]); }
    finally { clearTimeout(timer); }
  };
  return { remaining, wait, exists, regular, directory, entries, json(path) { regular(path); const result = readRunJson(path); remaining(); return result; } };
}

function validateAccepted(selection, retained, io) {
  const path = join(selection.retained_directory, "accepted.json");
  if (!io.exists(path)) return false;
  const intent = io.json(path), preview = retained.preview;
  if (intent.run_id !== preview.run_id || intent.prepared_digest !== preview.prepared_digest ||
      typeof intent.launch_file !== "string" || !intent.launch_file.startsWith(join(selection.directory, "receipts") + "/") ||
      !intent.launch_file.endsWith("/launch-request.json")) throw failure("accepted_changed", "Retained accepted intent does not bind the original prepared task.");
  const launch = io.json(intent.launch_file);
  if (digest(launch) !== intent.launch_digest || digest(launch.prepared) !== preview.prepared_digest ||
      launch.confirmation?.confirmation_digest !== preview.confirmation_digest) throw failure("accepted_changed", "Retained exact launch bytes changed; admission is unknown.");
  return true;
}

function journal(selection, io, { archived = false } = {}) {
  const path = selection.retained_directory;
  if (!io.exists(path)) return { state: "not_prepared", selection };
  io.directory(path);
  if (archived) return { state: "archived", selection };
  if (!io.exists(join(path, "preview.json"))) return { state: "incomplete", selection, attention: ["Incomplete guided journal; no launch is inferred."] };
  const preview = io.json(join(path, "preview.json"));
  io.regular(join(path, "prepared.json"));
  const retained = loadRetainedPreview(selection);
  if (!runId.test(preview.run_id) || preview.run_id !== `run:${preview.bundle_digest.slice(7)}` ||
      preview.client !== selection.client || preview.request !== selection.request || preview.repository !== selection.repository ||
      preview.runtime_root !== selection.runtime_root || preview.authority_directory !== selection.authority_directory) throw failure("preview_changed", "Retained preview paths or run identity changed.");
  const accepted = validateAccepted(selection, retained, io);
  return { state: accepted ? "accepted_unknown" : "prepared", selection, retained, intended_run_id: preview.run_id,
    attention: accepted ? [acceptedWarning] : [] };
}

function selectionEnvironment(selection, env) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("FLOW_") && !key.startsWith("DOTFILES_"))), ...selection.pilot.environment };
}

/** The adapter exposes queries only; no lifecycle call is available to the inventory. */
export function projectRunsObserver({ env = process.env } = {}) {
  return {
    status: selection => statusFlowOwner({ env: selectionEnvironment(selection, env), cleanupStale: false }),
    async query(selection, request, { observation, timeoutMs }) {
      if (observation === "live") {
        return createFlowClient({ ...flowOwnerPaths({ env: selectionEnvironment(selection, env) }), timeoutMs, maxFrameBytes: RUNS_LIMITS.file_bytes }).query(request);
      }
      const response = await promisify(execFile)(selection.client, ["query", "--input", JSON.stringify(request), "--json"], { env: selectionEnvironment(selection, env), timeout: timeoutMs, maxBuffer: RUNS_LIMITS.file_bytes });
      return JSON.parse(response.stdout);
    },
  };
}

/** Collect original immutable clients and journals without creating any state. */
export async function collectProjectRuns(options = {}, { env = process.env, cwd = process.cwd(), observer = projectRunsObserver({ env }), now = Date.now, limits = RUNS_LIMITS } = {}) {
  const io = projectRunReadScope(limits, now), result = { schema: "flow.project-runs/v1", repository: null, status: "ok", complete: true, clients: [], authorities: [], attempts: [], diagnostics: [], limits };
  const diagnostic = (path, error) => { result.complete = false; result.diagnostics.push({ path, code: error.code ?? "unavailable", message: error.message }); };
  let location;
  try { location = locateProjectProfile({ repository: options.repository, env, cwd, timeoutMs: Math.min(10000, io.remaining()) }); result.repository = location.repository; }
  catch (error) { error.exit = 2; throw error; }
  const { profileRoot, profilePath } = location;
  try {
    if (!io.exists(profilePath)) {
      if (io.exists(profileRoot)) throw failure("incomplete_profile", "An incomplete project profile remains; preserve it rather than creating another authority.");
      result.status = "uninitialized"; return result;
    }
    io.directory(profileRoot);
    const original = io.json(profilePath);
    if (original.identity?.schema !== "flow.local-client/v1" || original.identity.repository !== result.repository) throw failure("profile_changed", "Project profile repository identity changed.");
    const selected = options.client && resolve(cwd, options.client);
    let matched = false;
    clientsLoop: for (const name of io.entries(join(profileRoot, "clients"), limits.clients)) {
      const directory = join(profileRoot, "clients", name);
      if (selected && directory !== selected) continue;
      matched = true;
      try {
        if (!clientName.test(name)) throw failure("unknown_client", "Unknown retained client identity; it was not executed.");
        io.directory(directory); io.directory(join(profileRoot, "authority"));
        for (const file of ["pilot.json", "trusted-owner.mjs", "flow"]) io.regular(join(directory, file));
        const client = readValidatedProjectClient({ repository: result.repository, profileRoot, original, directory });
        const entry = { directory, client: client.client, runtime_root: client.runtime_root, authority_directory: client.authority_directory, validation: "valid", selection: client };
        result.clients.push(entry);
        for (const requestName of io.entries(join(directory, "requests"))) {
          if (result.attempts.length >= limits.attempts) { diagnostic(directory, failure("attempt_limit", "Attempt limit reached; remaining retained work is unknown.")); break clientsLoop; }
          const request = join(directory, "requests", requestName, "prepare-request.json");
          try {
            io.json(request); const selection = readValidatedProjectRequest(client, request);
            result.attempts.push({ kind: "feature", ...journal(selection, io) });
            for (const archive of io.entries(dirname(request)).filter(name => name.startsWith("guided-run.retained-"))) {
              if (result.attempts.length >= limits.attempts) throw failure("attempt_limit", "Attempt limit reached.");
              result.attempts.push({ kind: "feature", ...journal({ ...selection, retained_directory: join(dirname(request), archive) }, io, { archived: true }) });
            }
          } catch (error) { diagnostic(request, error); if (error.code === "attempt_limit") break clientsLoop; result.attempts.push({ kind: "feature", state: "unavailable", selection: { ...client, request }, attention: [error.message] }); }
        }
        const reviews = join(directory, "receipts/guided-review");
        if (io.exists(reviews)) for (const name of io.entries(reviews)) {
          const path = join(reviews, name);
          try {
            if (result.attempts.length >= limits.attempts) throw failure("attempt_limit", "Attempt limit reached.");
            if (!/^[a-f0-9]{64}$/u.test(name)) throw failure("unknown_review", "Unknown retained review intent.");
            const intent = io.json(join(path, "intent.json"));
            const selection = reviewSelection(client, intent.producer_run_id, intent.target, intent.policy);
            if (selection.intent_directory !== path || digest(intent) !== selection.selection_digest) throw failure("review_changed", "Review intent no longer binds the original client/producer/target.");
            result.attempts.push({ kind: "review", ...journal(selection, io) });
            for (const archive of io.entries(path).filter(name => name.startsWith("session.retained-"))) {
              if (result.attempts.length >= limits.attempts) throw failure("attempt_limit", "Attempt limit reached.");
              result.attempts.push({ kind: "review", ...journal({ ...selection, retained_directory: join(path, archive) }, io, { archived: true }) });
            }
          } catch (error) { diagnostic(path, error); if (error.code === "attempt_limit") break clientsLoop; result.attempts.push({ kind: "review", state: "unavailable", selection: { ...client, retained_directory: path }, attention: [error.message] }); }
        }
        const researchRoot = join(directory, "receipts/guided-research");
        if (io.exists(researchRoot)) for (const name of io.entries(researchRoot)) {
          const path = join(researchRoot, name);
          try {
            if (result.attempts.length >= limits.attempts) throw failure("attempt_limit", "Attempt limit reached.");
            if (!/^[a-f0-9]{64}$/u.test(name)) throw failure("unknown_research", "Unknown retained research intent.");
            const intent = io.json(join(path, "intent.json"));
            const selection = researchSelection(client, intent.packet, intent.source_provenance, intent.policy);
            io.remaining();
            if (selection.intent_directory !== path || digest(intent) !== selection.selection_digest) throw failure("research_changed", "Research intent no longer binds the original client/source packet.");
            result.attempts.push({ kind: "research", ...journal(selection, io) });
            for (const archive of io.entries(path).filter(name => name.startsWith("session.retained-"))) {
              if (result.attempts.length >= limits.attempts) throw failure("attempt_limit", "Attempt limit reached.");
              result.attempts.push({ kind: "research", ...journal({ ...selection, retained_directory: join(path, archive) }, io, { archived: true }) });
            }
          } catch (error) { diagnostic(path, error); if (error.code === "attempt_limit") break clientsLoop; result.attempts.push({ kind: "research", state: "unavailable", selection: { ...client, retained_directory: path }, attention: [error.message] }); }
        }
      } catch (error) { diagnostic(directory, error); if (!result.clients.some(client => client.directory === directory)) result.clients.push({ directory, validation: "unavailable", reason: error.message }); }
    }
    if (selected && !matched) throw Object.assign(failure("unknown_client", "Select an exact original --client DIRECTORY from this project's retained clients."), { exit: 2 });
  } catch (error) { if (error.exit === 2) throw error; diagnostic(profilePath, error); }
  await inspectAuthorities(result, io, observer, diagnostic, env);
  await observeReviewFacts(result, io, diagnostic);
  result.status = result.complete ? result.attempts.some(attempt => attempt.attention?.length) ? "attention" : "ok" : "unavailable";
  return result;
}

/** Original-client owner binding and query-only access, shared by read-only reports. */
export async function observeProjectAuthority(clients, { io, observer, env, budget, row = { authority_directory: clients[0].authority_directory, observation: "unavailable", owner_state: "unknown", run_ids: [] } }) {
  const authority = row.authority_directory;
      const paths = flowOwnerPaths({ env: selectionEnvironment(clients[0], env) });
      for (const path of [paths.endpointPath, paths.operatorErrorPath]) if (path && io.exists(path)) io.regular(path);
      const status = await io.wait(timeoutMs => observer.status(clients[0], { timeoutMs })); io.remaining(); row.owner_state = status.state;
      let selected;
      if (status.state === "running") {
        selected = clients.find(client => ownerRuntimeBindingEqual(deriveOwnerRuntimeBinding({ env: selectionEnvironment(client, env) }), status.runtime_binding));
        if (!selected) throw failure("owner_binding_mismatch", "The running owner does not match a verified selected client/runtime binding.");
        row.observation = "live";
      } else if (status.state === "stopped") {
        const identities = new Set(clients.map(client => digest({ runtime_root: client.runtime_root, pilot_digest: client.pilot_digest })));
        if (identities.size !== 1) throw failure("stopped_client_ambiguous", "Several stopped client bindings share this authority. Select --client DIRECTORY for exact inspect-only history.");
        selected = clients[0];
        if (!io.exists(join(authority, "authority.sqlite"))) { row.observation = "retained"; row.owner_state = "stopped"; return { row, selection: selected, query: null }; }
        io.regular(join(authority, "authority.sqlite"), Number.MAX_SAFE_INTEGER); row.observation = "inspect_only";
      } else throw failure("owner_unavailable", `Owner is ${status.state}; no startup or cleanup was attempted.`);
      row.client = selected.client; row.runtime_root = selected.runtime_root;
      const cache = new Map();
      const query = async request => {
        const key = digest(request); if (cache.has(key)) return cache.get(key);
        if (++budget.queries > budget.limit) throw failure("query_limit", "Public query limit reached; remaining work is unknown.");
        const value = await io.wait(timeoutMs => observer.query(selected, request, { observation: row.observation, timeoutMs })); io.remaining();
        if (value?.schema === "flow.rejection/v1") throw failure(value.code, `Read-only inspection refused: ${value.code}`);
        cache.set(key, value); return value;
      };
  return { row, selection: selected, query };
}

async function inspectAuthorities(result, io, observer, diagnostic, env) {
  const groups = new Map();
  for (const client of result.clients.filter(client => client.selection)) {
    const key = client.authority_directory;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(client.selection);
  }
  const budget = { queries: 0, limit: result.limits.queries };
  for (const [authority, clients] of groups) {
    const row = { authority_directory: authority, observation: "unavailable", owner_state: "unknown", run_ids: [] }; result.authorities.push(row);
    try {
      const observed = await observeProjectAuthority(clients, { io, observer, env, budget, row });
      if (!observed.query) continue;
      const { query, selection: selected } = observed;
      const index = await query({});
      if (index.schema !== "flow.run-index-projection/v1" || !Array.isArray(index.runs) || !["compatible", "uninitialized"].includes(index.authority_schema?.status)) throw failure("invalid_index", "The selected authority did not return a compatible known run index.");
      if (index.runs.length > result.limits.attempts) throw failure("attempt_limit", "Authority run index exceeds the overview limit; work remains unknown.");
      row.watermark = index.watermark ?? null;
      for (const id of [...index.runs].sort()) {
        if (!runId.test(id)) throw failure("invalid_run_id", "Authority returned an invalid run identity.");
        const run = await query({ run_id: id });
        if (run.schema !== "flow.run-projection/v1" || run.run_id !== id) throw failure("invalid_projection", "Public run projection did not bind the exact requested run.");
        row.run_ids.push(id);
        const attempts = result.attempts.filter(attempt => attempt.selection.authority_directory === authority && attempt.intended_run_id === id && attempt.retained?.preview.bundle_digest === run.bundle_digest);
        if (attempts.length) for (const attempt of attempts) {
          if (attempt.state === "accepted_unknown") attempt.attention = (attempt.attention ?? []).filter(reason => reason !== acceptedWarning);
          attempt.state = "admitted"; attempt.run = run; attempt.observation = row.observation; attempt.query = query; }
        else if (result.attempts.length < result.limits.attempts) result.attempts.push({ kind: run.active_plan?.cards?.some(card => card.inputs?.task_inputs?.flow === "spike/v2") ? "research" : "manual", state: "admitted", selection: selected, run, observation: row.observation, query, attention: ["No matching validated guided receipt; use the original client's inspection commands."] });
        else throw failure("attempt_limit", "Attempt limit reached; some authority work was not displayed.");
      }
      for (const attempt of result.attempts.filter(attempt => attempt.selection.authority_directory === authority)) attempt.observation ??= row.observation;
    } catch (error) { row.observation = "unavailable"; row.reason = error.message; diagnostic(authority, error); }
  }
}


async function observeReviewFacts(result, io, diagnostic) {
  const observed = result.attempts.filter(attempt => attempt.run);
  // Candidate facts must be available before correlating reviews, independent of row order.
  for (const attempt of observed) {
    const reference = attempt.run.review_candidate_reference;
    if (!reference?.candidate_id) continue;
    try {
      const candidate = await attempt.query({ schema: "flow.query/v1", query: "review", subject_id: reference.candidate_id });
      if (candidate.schema !== "work.review-candidate-projection/v1" || candidate.subject_id !== reference.candidate_id ||
          candidate.candidate_fingerprint !== reference.candidate_fingerprint) throw failure("candidate_changed", "Candidate projection does not match the exact producer reference.");
      attempt.candidate = candidate;
    } catch (error) { diagnostic(attempt.run.run_id, error); (attempt.attention ??= []).push(error.message); }
  }
  for (const attempt of observed) {
    const { run, query } = attempt;
    try {
      io.remaining();
      const card = run.active_plan?.cards?.find(card => card.executor?.contract === "flow.operation/review-record/v1");
      const effect = run.effects?.find(effect => effect.operation_contract === "flow.operation/review-record/v1");
      if (!card && !effect && attempt.kind !== "review") continue;
      const raw = card?.inputs?.target;
      const target = attempt.selection.target ?? (raw && { candidate_id: raw.candidate?.candidate_id, candidate_fingerprint: raw.candidate_fingerprint,
        lifecycle_generation: raw.lifecycle_generation, candidate_authority_watermark: raw.candidate_authority_watermark });
      if (!target) throw failure("review_target_unavailable", "Review target is not available from this exact retained intent or public card.");
      const selection = { ...attempt.selection, target };
      if (selection.producer_run_id) {
        const producer = await query({ run_id: selection.producer_run_id });
        if (producer.schema !== "flow.run-projection/v1" || producer.run_id !== selection.producer_run_id || producer.phase !== "succeeded" ||
            producer.review_candidate_reference?.candidate_id !== target.candidate_id || producer.review_candidate_reference?.candidate_fingerprint !== target.candidate_fingerprint) throw failure("producer_changed", "Review intent does not match the public completed producer/candidate.");
        if (attempt.retained) {
          const request = io.json(selection.request);
          if (request.inputs?.preparation_facts?.source_run?.run_id !== selection.producer_run_id) throw failure("producer_changed", "Retained review request does not bind the original producer.");
        }
      }
      const found = await readReviewRecord(run, selection, async (_selection, args) => {
        const request = JSON.parse(args[2]);
        return query(request.contract === "work.review/v1" ? { schema: "flow.query/v1", query: "review", subject_id: request.subject_id } : request);
      });
      if (found) attempt.record = found.record;
      let producers = observed.filter(row => row.run.review_candidate_reference?.candidate_id === target.candidate_id && row.run.review_candidate_reference?.candidate_fingerprint === target.candidate_fingerprint &&
        row.candidate?.generation === target.lifecycle_generation && digest(row.candidate?.watermark) === digest(target.candidate_authority_watermark) &&
        (!selection.producer_run_id || row.run.run_id === selection.producer_run_id));
      if (!selection.producer_run_id && producers.length > 1) { (attempt.attention ??= []).push("Several producers reference this candidate; no producer association is guessed."); producers = []; }
      if (selection.producer_run_id) attempt.producer_run_id = selection.producer_run_id;
      else if (producers.length === 1) attempt.producer_run_id = producers[0].run.run_id;
      if (producers.length === 1) attempt.summary = `Review: ${producers[0].selection.preparation?.brief?.summary ?? "retained candidate"}`;
      for (const producer of producers) {
        producer.separate_review_run_ids ??= [];
        if (!producer.separate_review_run_ids.includes(run.run_id)) producer.separate_review_run_ids.push(run.run_id);
      }
    } catch (error) { diagnostic(attempt.selection.retained_directory ?? run.run_id, error); (attempt.attention ??= []).push(error.message); }
  }
}
