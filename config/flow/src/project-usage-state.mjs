import { join, resolve } from "node:path";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { deriveChildRunId } from "../../../tools/flow/src/subrun-effects.mjs";
import { readRecordedTaskUsage } from "../../../tools/flow/src/recorded-task-usage.mjs";
import { locateProjectProfile, readValidatedProjectClient } from "./project-run-state.mjs";
import { observeProjectAuthority, projectRunReadScope, projectRunsObserver, RUNS_LIMITS } from "./project-runs-state.mjs";

export const USAGE_LIMITS = Object.freeze({ ...RUNS_LIMITS, runs: 32, attempts: 128 });
const validRun = id => typeof id === "string" && /^run:(?:child:)?[a-f0-9]{64}$/u.test(id);
const fail = (code, exit = 1) => { throw Object.assign(new Error(code), { code, exit }); };
const metricKeys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "turns"];

function selectedClients(options, { env, cwd, io }) {
  const location = locateProjectProfile({ repository: options.repository, env, cwd, timeoutMs: Math.min(10000, io.remaining()) });
  if (!io.exists(location.profilePath)) fail("This project has no retained setup. Run flow-supervised init first.", 2);
  io.directory(location.profileRoot); const original = io.json(location.profilePath);
  if (original.identity?.schema !== "flow.local-client/v1" || original.identity.repository !== location.repository) fail("usage_profile_identity_changed");
  const requested = options.client && resolve(cwd, options.client), clients = [];
  for (const name of io.entries(join(location.profileRoot, "clients"), USAGE_LIMITS.clients)) {
    const directory = join(location.profileRoot, "clients", name);
    if (requested && directory !== requested) continue;
    if (!/^(?:verify|[a-f0-9]{64})(?:\.runtime-[a-f0-9]{64})?$/u.test(name)) fail("usage_unknown_client_identity");
    io.directory(directory); io.directory(join(location.profileRoot, "authority"));
    for (const file of ["pilot.json", "trusted-owner.mjs", "flow"]) io.regular(join(directory, file));
    clients.push(readValidatedProjectClient({ repository: location.repository, profileRoot: location.profileRoot, original, directory }));
  }
  if (!clients.length) fail(requested ? "Select an exact retained --client DIRECTORY for this project." : "No retained project client is available; inspect the original setup.", 2);
  return { repository: location.repository, clients };
}

function totals(attempts) {
  const groups = new Map(); let knownCost = null, unknownCost = 0, costOverflow = false;
  for (const attempt of attempts) {
    if (attempt.cost.basis === "cli_reported_list_estimate" && attempt.cost.usd !== null) {
      if (!costOverflow) { const sum = (knownCost ?? 0) + attempt.cost.usd; if (Number.isFinite(sum)) knownCost = sum; else { knownCost = null; costOverflow = true; } }
    }
    else unknownCost++;
    const key = digest({ harness: attempt.harness, model: attempt.model, token_semantics: attempt.token_semantics, turn_semantics: attempt.turn_semantics });
    if (!groups.has(key)) groups.set(key, { harness: attempt.harness, model: attempt.model, token_semantics: attempt.token_semantics, turn_semantics: attempt.turn_semantics,
      attempts: 0, overflow_metrics: [], metrics: Object.fromEntries(metricKeys.map(name => [name, null])), unknown_metric_attempts: Object.fromEntries(metricKeys.map(name => [name, 0])) });
    const group = groups.get(key); group.attempts++;
    for (const name of metricKeys) {
      const value = attempt.metrics[name];
      if (value === null) group.unknown_metric_attempts[name]++;
      else if (!group.overflow_metrics.includes(name)) { const sum = (group.metrics[name] ?? 0) + value; if (Number.isSafeInteger(sum)) group.metrics[name] = sum; else { group.metrics[name] = null; group.overflow_metrics.push(name); } }
    }
  }
  return { provider_totals: [...groups.values()], cost: { known_list_cost_usd: knownCost, unknown_attempts: unknownCost, subtotal_complete: !costOverflow && unknownCost === 0 && attempts.length > 0, subtotal_overflow: costOverflow,
    basis: "CLI-reported list estimates only; not actual billing", billing: null, pricing_date: null, pricing_table_version: null } };
}

/** One requested run and reciprocal admitted descendants. Never inventories unrelated work. */
export async function collectProjectUsage(options, { env = process.env, cwd = process.cwd(), observer = projectRunsObserver({ env }), now = Date.now, limits = USAGE_LIMITS, readTask = readRecordedTaskUsage } = {}) {
  if (!validRun(options.run)) fail("Select --run with an exact run identity.", 2);
  const io = projectRunReadScope(limits, now), report = { schema: "flow.project-usage/v1", repository: null, root_run_id: options.run,
    client: null, runtime_root: null, observation: "unavailable", observed_at: new Date(now()).toISOString(), complete: true,
    runs: [], attempts: [], deduplicated_attempts: 0, provider_totals: [], cost: null, diagnostics: [], limits };
  const diagnostic = (code, run = options.run) => { report.complete = false; report.diagnostics.push({ code: /^[a-z_]+$/u.test(code ?? "") ? code : "usage_inspection_unavailable", run_id: run }); };
  try {
    const selected = selectedClients(options, { env, cwd, io }); report.repository = selected.repository;
    const { row, selection, query } = await observeProjectAuthority(selected.clients, { io, observer, env, budget: { queries: 0, limit: limits.queries } });
    report.client = selection.client; report.runtime_root = selection.runtime_root; report.observation = row.observation;
    if (!query) fail("usage_authority_unavailable");
    const pending = [{ id: options.run, parent: null }], visited = new Set(), seenTasks = new Map();
    while (pending.length) {
      io.remaining();
      if (visited.size >= limits.runs) { diagnostic("usage_lineage_limit"); break; }
      const { id, parent } = pending.shift();
      if (visited.has(id)) { diagnostic("usage_lineage_cycle", id); continue; } visited.add(id);
      let run;
      try {
        run = await query({ run_id: id });
        if (run.schema !== "flow.run-projection/v1" || run.run_id !== id || !Array.isArray(run.effects)) fail("usage_run_projection_conflict");
        if (parent && (run.parent?.parent_run_id !== parent.parent_run_id || run.parent?.card_id !== parent.card_id || run.parent?.card_identity !== parent.card_identity || run.parent?.revision_ordinal !== parent.revision_ordinal || deriveChildRunId(parent) !== id)) fail("usage_child_lineage_conflict");
      } catch (error) { diagnostic(error.code, id); continue; }
      report.runs.push({ run_id: id, parent_run_id: run.parent?.parent_run_id ?? null, phase: run.phase, observation: row.observation });
      const delegates = run.effects.filter(effect => effect.effect_kind === "delegate");
      for (const effect of delegates) {
        if (report.attempts.length >= limits.attempts) { diagnostic("usage_attempt_limit", id); break; }
        const key = `${selection.authority_directory}\0${effect.attempt_id}`;
        const binding = digest({ run_id: id, card_id: effect.card_id, effect_id: effect.effect_id, attempt_id: effect.attempt_id });
        if (seenTasks.has(key)) {
          if (seenTasks.get(key) !== binding) diagnostic("usage_duplicate_attempt_conflict", id);
          else report.deduplicated_attempts++;
          continue;
        }
        seenTasks.set(key, binding);
        const attempt = !effect.invocation_started && !effect.receipt ? { run_id: id, card_id: effect.card_id, effect_id: effect.effect_id, attempt_id: effect.attempt_id,
          task_id: null, descriptor_digest: null, harness: null, model: { requested: null, reported: null }, cli_version: null, authority_status: effect.status,
          status: ["not_created", "abandoned"].includes(effect.status) ? effect.status : ["unresolved", "reserved", "pending"].includes(effect.status) ? "pending" : "unavailable", metrics: Object.fromEntries(metricKeys.map(name => [name, null])), token_semantics: null, turn_semantics: null,
          cost: { usd: null, basis: "unknown", raw_field: null }, provenance: null, diagnostics: [] }
          : readTask({ authorityDirectory: selection.authority_directory, runId: id, effect, remaining: io.remaining });
        report.attempts.push(attempt);
        if (["partial", "unavailable", "unsupported"].includes(attempt.status)) diagnostic("usage_attempt_incomplete", id);
      }
      const links = run.subruns ?? [];
      if (!Array.isArray(links) || links.length > limits.runs) { diagnostic("usage_lineage_limit", id); continue; }
      for (const link of links) {
        if (link.status === "not_created") continue;
        if (link.parent_run_id !== id || !validRun(link.child_run_id) || typeof link.card_id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(link.card_identity ?? "") || !Number.isSafeInteger(link.revision_ordinal) || link.revision_ordinal < 0 || deriveChildRunId(link) !== link.child_run_id) { diagnostic("usage_child_lineage_conflict", id); continue; }
        if (link.status === "admission_pending" || link.child_watermark === null || link.child_watermark === undefined) { diagnostic("usage_child_admission_unknown", link.child_run_id); continue; }
        if (pending.length + visited.size >= limits.runs) { diagnostic("usage_lineage_limit", id); break; }
        pending.push({ id: link.child_run_id, parent: link });
      }
    }
  } catch (error) {
    if (error.exit === 2) throw error;
    report.observation = "unavailable"; diagnostic(error.code);
  }
  Object.assign(report, totals(report.attempts));
  if (report.cost.subtotal_overflow || report.provider_totals.some(group => group.overflow_metrics.length)) diagnostic("usage_total_overflow");
  report.attempt_count = report.attempts.length; report.omitted_attempts = 0; report.omitted_runs = 0;
  if (Buffer.byteLength(JSON.stringify(report)) > limits.output_bytes) diagnostic("usage_output_limit");
  while (Buffer.byteLength(JSON.stringify(report)) > limits.output_bytes && (report.attempts.length || report.runs.length || report.diagnostics.some(item => item.code !== "usage_output_limit"))) {
    if (report.attempts.length) { report.attempts.pop(); report.omitted_attempts++; Object.assign(report, totals(report.attempts)); report.cost.unknown_attempts += report.omitted_attempts; report.cost.subtotal_complete = false; }
    else if (report.runs.length) { report.runs.pop(); report.omitted_runs++; }
    else report.diagnostics.splice(report.diagnostics.findIndex(item => item.code !== "usage_output_limit"), 1);
  }
  if (Buffer.byteLength(JSON.stringify(report)) > limits.output_bytes) fail("usage_output_unrepresentable");
  return report;
}
