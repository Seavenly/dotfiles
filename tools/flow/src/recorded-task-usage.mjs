import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { digest } from "./canonical.mjs";

export const RECORDED_USAGE_LIMITS = Object.freeze({ json_bytes: 4 * 1024 * 1024, stream_bytes: 4 * 1024 * 1024, events: 20000 });
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const issue = code => Object.assign(new Error(code), { code });
const safeName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) && !/^(?:sk-|gh[pousr]_|github_pat_)/iu.test(value) ? value : null;
const counters = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "turns"];
const emptyMetrics = () => Object.fromEntries(counters.map(key => [key, null]));

/** Numeric metadata only. This is not a native output or lifecycle validator. */
export function parseRecordedUsage(stdout, { harness, nativeSession = null, limits = RECORDED_USAGE_LIMITS } = {}) {
  if (!Buffer.isBuffer(stdout)) stdout = Buffer.from(stdout);
  if (stdout.length > limits.stream_bytes || !stdout.length || stdout.at(-1) !== 10) throw issue("usage_stream_incomplete");
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); } catch { throw issue("usage_stream_encoding"); }
  const lines = text.split("\n").filter(line => line.trim());
  if (lines.length > limits.events) throw issue("usage_event_limit");
  const events = lines.map((line, index) => { let value; try { value = JSON.parse(line); } catch { throw issue("usage_event_malformed"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw issue("usage_event_malformed"); return { value, index }; });
  const metrics = emptyMetrics(), diagnostics = [], fields = {};
  const integer = (key, value, path) => {
    if (value === undefined || value === null) return;
    if (!Number.isSafeInteger(value) || value < 0) { diagnostics.push(`invalid_${key}`); return; }
    metrics[key] = value; fields[key] = path;
  };
  const terminalType = harness === "codex" ? "turn.completed" : harness === "claude" ? "result" : null;
  if (!terminalType) throw issue("usage_harness_unsupported");
  const terminal = events.filter(({ value }) => value.type === terminalType);
  if (terminal.length !== 1) throw issue(terminal.length ? "usage_terminal_ambiguous" : "usage_terminal_missing");
  const { value: event, index } = terminal[0];
  const sessionEvents = events.filter(({ value }) => harness === "codex" ? value.type === "thread.started" : value.type === "system" && value.subtype === "init");
  if (sessionEvents.length !== 1) throw issue("usage_session_ambiguous");
  const session = harness === "codex" ? sessionEvents[0].value.thread_id : sessionEvents[0].value.session_id;
  if (typeof session !== "string" || !session || session.length > 256 || nativeSession !== null && session !== nativeSession || harness === "claude" && event.session_id !== session) throw issue("usage_session_conflict");
  const usage = event.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw issue("usage_metrics_missing");
  let cost = { usd: null, basis: "unknown", raw_field: null }, reportedModel = null, reportedProvider = null;
  if (harness === "codex") {
    integer("input_tokens", usage.input_tokens, "turn.completed.usage.input_tokens");
    integer("cached_input_tokens", usage.cached_input_tokens, "turn.completed.usage.cached_input_tokens");
    integer("cache_write_input_tokens", usage.cache_write_input_tokens, "turn.completed.usage.cache_write_input_tokens");
    integer("output_tokens", usage.output_tokens, "turn.completed.usage.output_tokens");
    integer("reasoning_output_tokens", usage.reasoning_output_tokens, "turn.completed.usage.reasoning_output_tokens");
    metrics.turns = 1; fields.turns = "turn.completed event count";
    if (metrics.cached_input_tokens !== null && metrics.input_tokens !== null && metrics.cached_input_tokens > metrics.input_tokens) { metrics.cached_input_tokens = null; diagnostics.push("invalid_cached_input_subset"); }
    reportedModel = safeName(event.model);
  } else {
    integer("input_tokens", usage.input_tokens, "result.usage.input_tokens");
    integer("cached_input_tokens", usage.cache_read_input_tokens, "result.usage.cache_read_input_tokens");
    integer("cache_write_input_tokens", usage.cache_creation_input_tokens, "result.usage.cache_creation_input_tokens");
    integer("output_tokens", usage.output_tokens, "result.usage.output_tokens");
    integer("reasoning_output_tokens", usage.output_tokens_details?.thinking_tokens, "result.usage.output_tokens_details.thinking_tokens");
    integer("turns", event.num_turns, "result.num_turns");
    const models = event.modelUsage && typeof event.modelUsage === "object" && !Array.isArray(event.modelUsage) ? Object.keys(event.modelUsage) : [];
    if (models.length === 1) {
      reportedModel = safeName(models[0]);
      const provider = event.modelUsage[models[0]]?.provider;
      if (["firstParty", "bedrock", "vertex", "foundry"].includes(provider)) reportedProvider = provider;
    }
    if (event.total_cost_usd !== undefined && event.total_cost_usd !== null) {
      if (typeof event.total_cost_usd !== "number" || !Number.isFinite(event.total_cost_usd) || event.total_cost_usd < 0) diagnostics.push("invalid_reported_cost");
      else cost = { usd: event.total_cost_usd, basis: models.length && models.every(model => event.modelUsage[model]?.costBasis === "list") ? "cli_reported_list_estimate" : "cli_reported_estimate", raw_field: "result.total_cost_usd" };
    }
    // Model-level costs corroborate the cumulative final result, never add to it.
    if (cost.usd !== null && models.length && models.every(model => event.modelUsage[model]?.costUSD !== undefined)) {
      const values = models.map(model => event.modelUsage[model].costUSD);
      const sum = values.reduce((total, value) => total + value, 0);
      if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0) || !Number.isFinite(sum) || Math.abs(sum - cost.usd) > Math.max(1e-12, Math.abs(cost.usd) * 1e-9)) {
        cost = { usd: null, basis: "unknown", raw_field: null }; diagnostics.push("usage_cost_source_conflict");
      }
    }
  }
  if (metrics.reasoning_output_tokens !== null && metrics.output_tokens !== null && metrics.reasoning_output_tokens > metrics.output_tokens) { metrics.reasoning_output_tokens = null; diagnostics.push("invalid_reasoning_subset"); }
  if (metrics.input_tokens === null && metrics.output_tokens === null) diagnostics.push("usage_token_counts_unknown");
  return { metrics, model_reported: reportedModel, provider_reported: reportedProvider, cost,
    token_semantics: harness === "codex" ? "codex_input_includes_cached_input; reasoning_is_output_subset; do_not_add_subsets" : "claude_input_excludes_cache_read_and_creation; reasoning_is_output_subset; final_result_cumulative_once",
    turn_semantics: harness === "codex" ? "completed_native_turn_events" : "cli_result_num_turns",
    provenance: { event_type: terminalType, event_index: index, metric_fields: fields }, diagnostics };
}

function readCanonical(path, maxBytes, remaining) {
  remaining();
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maxBytes || realpathSync(path) !== resolve(path)) throw issue("usage_artifact_unsafe");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw issue("usage_artifact_changed");
    const buffer = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    const data = buffer.subarray(0, size), after = fstatSync(fd);
    if (data.length > maxBytes || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw issue("usage_artifact_changed");
    remaining(); return data;
  } finally { closeSync(fd); }
}

/** Read one exact projected delegate's retained bytes. Never constructs a task port. */
export function readRecordedTaskUsage({ authorityDirectory, runId, effect, limits = RECORDED_USAGE_LIMITS, remaining = () => {} }) {
  const row = { run_id: runId, card_id: effect.card_id, effect_id: effect.effect_id, attempt_id: effect.attempt_id, task_id: null,
    descriptor_digest: null, harness: null, provider_reported: null, model: { requested: null, reported: null }, cli_version: null,
    authority_status: effect.status, status: "unavailable", metrics: emptyMetrics(), token_semantics: null, turn_semantics: null,
    cost: { usd: null, basis: "unknown", raw_field: null }, provenance: null, diagnostics: [] };
  try {
    if (effect.effect_kind !== "delegate" || typeof effect.attempt_id !== "string" || typeof effect.card_id !== "string" || typeof effect.effect_id !== "string" || effect.run_id !== undefined && effect.run_id !== runId) throw issue("usage_attempt_identity_conflict");
    const taskId = `task:${hash(Buffer.from(effect.attempt_id)).slice(7)}`;
    row.task_id = taskId;
    const directory = join(authorityDirectory, "direct-tasks", taskId.slice(5));
    const rootInfo = lstatSync(directory);
    if (!rootInfo.isDirectory() || realpathSync(directory) !== resolve(directory)) throw issue("usage_task_directory_unsafe");
    const bytes = name => readCanonical(join(directory, name), name.endsWith(".bin") ? limits.stream_bytes : limits.json_bytes, remaining);
    const json = name => JSON.parse(bytes(name).toString("utf8"));
    const descriptor = json("descriptor.json"), { descriptor_digest: expected, ...identity } = descriptor;
    if (descriptor.schema !== "flow.task-invocation/v1" || digest(identity) !== expected || descriptor.task_id !== taskId || descriptor.caller_key !== effect.attempt_id || descriptor.run_id !== runId || descriptor.card_id !== effect.card_id || descriptor.attempt_id !== effect.attempt_id || descriptor.effect_id !== effect.effect_id || hash(bytes("input.bin")) !== descriptor.input_sha256 || bytes("output-schema.json").toString("utf8") !== descriptor.output_schema_bytes || digest(descriptor.output_contract) !== descriptor.output_contract_digest) throw issue("usage_descriptor_conflict");
    if (descriptor.native_output_schema_bytes !== undefined && (bytes("native-output-schema.json").toString("utf8") !== descriptor.native_output_schema_bytes || hash(Buffer.from(descriptor.native_output_schema_bytes)) !== descriptor.native_output_schema_sha256)) throw issue("usage_descriptor_conflict");
    const worker = json("worker.json"), receipt = json("receipt.json"), stdout = bytes("stdout.bin"), stderr = bytes("stderr.bin");
    if (worker.schema !== "flow.task-process/v1" || worker.descriptor_digest !== expected || worker.containment !== descriptor.process_containment || receipt.schema !== "flow.task-terminal-receipt/v1" || receipt.descriptor_digest !== expected || receipt.input_sha256 !== descriptor.input_sha256 || receipt.stdout_sha256 !== hash(stdout) || receipt.stderr_sha256 !== hash(stderr) || digest(worker.identity) !== digest(receipt.worker_identity) || digest(worker.child) !== digest(receipt.child_identity)) throw issue("usage_terminal_receipt_conflict");
    const projected = effect.receipt?.provider_receipt;
    const proof = projected?.settlement_proof;
    if (projected?.turn_id !== taskId || projected.attempt_id !== undefined && projected.attempt_id !== effect.attempt_id || projected.card_id !== undefined && projected.card_id !== effect.card_id) throw issue("usage_public_task_conflict");
    const terminalDigest = digest(receipt), disposition = projected.terminal_disposition;
    if (disposition?.resource?.id !== taskId || disposition?.resource?.type !== "direct_task" || disposition.terminal_receipt_digest !== terminalDigest) throw issue("usage_public_receipt_conflict");
    if (proof) {
      const { record_sha256: recorded, ...proofIdentity } = proof;
      if (digest(proofIdentity) !== recorded || proof.descriptor_digest !== expected || proof.input_sha256 !== descriptor.input_sha256 || proof.output_contract_digest !== descriptor.output_contract_digest || proof.stdout_sha256 !== receipt.stdout_sha256 || proof.terminal_receipt_digest !== terminalDigest) throw issue("usage_public_proof_conflict");
    }
    const harness = descriptor.description?.backend?.harness;
    row.descriptor_digest = expected; row.harness = ["codex", "claude"].includes(harness) ? harness : null;
    row.model.requested = safeName(descriptor.description?.launch?.model);
    const version = descriptor.description?.backend?.executable?.version;
    row.cli_version = typeof version === "string" && /^(?:codex-cli \d+\.\d+\.\d+|\d+\.\d+\.\d+ \(Claude Code\))$/u.test(version) ? version : null;
    const parsed = parseRecordedUsage(stdout, { harness, nativeSession: proof?.native_session ?? null, limits });
    Object.assign(row, { metrics: parsed.metrics, provider_reported: parsed.provider_reported, token_semantics: parsed.token_semantics, turn_semantics: parsed.turn_semantics, cost: parsed.cost,
      provenance: { ...parsed.provenance, stdout_sha256: receipt.stdout_sha256, terminal_receipt_digest: terminalDigest } });
    row.model.reported = parsed.model_reported; row.diagnostics.push(...parsed.diagnostics);
    row.status = row.diagnostics.length || receipt.cancelled || receipt.exit_code !== 0 || !proof ? "partial" : "reported";
    if (receipt.cancelled || receipt.exit_code !== 0) row.diagnostics.push("usage_from_non_successful_terminal");
    return row;
  } catch (error) {
    row.diagnostics.push(typeof error.code === "string" && /^[a-z_]+$/u.test(error.code) ? error.code : error.code === "ENOENT" ? "usage_artifact_missing" : "usage_evidence_unavailable");
    return row;
  }
}
