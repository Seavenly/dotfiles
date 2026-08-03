import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalizeJson } from "./canonical-json.mjs";

export const TRACE_SCHEMA = "drovr.harness-trace/v1";
export const TRACE_VERSION = 1;

const EVENT_KINDS = new Set([
  "command_result",
  "agent_observation",
  "pane_snapshot",
  "transcript_event",
  "delay",
  "error",
]);
const SECRET_KEY = /(?:api[_-]?key|authorization|credential|password|secret|private[_-]?key)/iu;
const TOKEN_KEY = /(?:^|[_-])(?:access[_-]?)?token$/iu;
const TOKEN_DIGEST = /^<token:sha256:[0-9a-f]{64}>$/u;
const PATH_KEY = /(?:^|_|-)(?:cwd|path|root|file|directory|workspace|state_home|runtime_dir)$/iu;
const TEXT_KEY = /^(?:content|display_text|excerpt|message|prompt|raw|stderr|stdout|text)$/u;
const ABSOLUTE_PATH_GLOBAL = /(?<![\w.-])(?:\/(?:[^\s"'`\[\]()<>{},;]+\/)*[^\s"'`\[\]()<>{},;]+|[A-Z]:\\[^\s"'`\[\]()<>{},;]+)/giu;
const UNSAFE_ABSOLUTE_PATH_GLOBAL = /(?:^|[^\w.-])(?:\/{1,2}|[A-Z]:\\)[^\s"'`\[\]()<>{},;]+/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu;
const BEARER_GLOBAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*(?!\[REDACTED\])[^\s,;}]+/iu;
const SECRET_ASSIGNMENT_GLOBAL = /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*(?!\[REDACTED\])[^\s,;}]+/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/u;
const PRIVATE_KEY_GLOBAL = /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/gu;
const SAFE_STRUCTURED_TEXT = /^(?:(?:[-─\s❯])|\[Pasted text #\d+(?: [^\]\r\n]*)?\]|(?:QUALIFY|REPLAY|TRACE)-[A-Z0-9_-]+|\[REDACTED_TEXT sha256:[0-9a-f]{64}\]|\[REDACTED_PRIVATE_KEY\])+$/u;
const PASTED_TEXT = /\[Pasted text #\d+(?: [^\]\r\n]*)?\]/gu;
const PUBLIC_URL_SCHEMES = new Set(["http", "https", "ws", "wss"]);
const TRACE_LOCK_RETRY_MS = 5;
const TRACE_LOCK_STALE_MS = 30_000;

const TRACE_JOURNALS = new Map();

export function traceJournalFailurePath(path) {
  return `${path}.failure`;
}

export function traceOperation(args) {
  const sessionFlag = args.indexOf("--session");
  const relevant = sessionFlag >= 0 ? args.slice(sessionFlag + 2) : args;
  const [resource, action] = relevant;
  if (resource === "agent" && action === "read") {
    return relevant.includes("--source")
      ? `agent.read.${relevant[relevant.indexOf("--source") + 1]}`
      : "agent.read";
  }
  if (resource === "agent" && action === "send-keys") return "agent.send-keys";
  if (resource && action) return `${resource}.${action}`;
  return relevant.join(".");
}

export function traceRequest(args) {
  const sessionFlag = args.indexOf("--session");
  const relevant = sessionFlag >= 0 ? args.slice(sessionFlag + 2) : args;
  const target = relevant[2]?.startsWith("--") ? null : (relevant[2] ?? null);
  const request = {
    resource: relevant[0] ?? null,
    action: relevant[1] ?? null,
    target,
  };
  const sourceIndex = relevant.indexOf("--source");
  if (sourceIndex >= 0) request.source = relevant[sourceIndex + 1] ?? null;
  const input = relevant
    .slice(target === null ? 2 : 3)
    .filter((value) => !value.startsWith("--"));
  if (input.length > 0) request.input = traceInput(input.join(" "));
  for (const flag of ["--token", "--clear-unknown", "--submit"]) {
    const index = relevant.indexOf(flag);
    if (index >= 0 && relevant[index + 1] !== undefined) {
      request.token = redactToken(relevant[index + 1]);
      break;
    }
  }
  return request;
}

export class TraceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraceValidationError";
  }
}

export function captureTrace(rawTrace, options = {}) {
  const captured = redactValue(rawTrace, [], options);
  return validateTrace(captured);
}

export class TraceRecorder {
  constructor({ scenarioId, provenance, clock = () => Date.now(), startedAt = clock() }) {
    this.scenarioId = scenarioId;
    this.provenance = provenance;
    this.clock = clock;
    this.startedAt = startedAt;
    this.events = [];
  }

  record(event) {
    const captured = redactValue(
      {
        ...event,
        sequence: this.events.length + 1,
        at_ms: Math.max(0, this.clock() - this.startedAt),
      },
      [],
    );
    assertSafeValue(captured);
    this.events.push(captured);
    return captured;
  }

  trace() {
    return captureTrace({
      schema: TRACE_SCHEMA,
      version: TRACE_VERSION,
      scenario_id: this.scenarioId,
      provenance: this.provenance,
      events: this.events,
    });
  }

  async persist(path) {
    return writeTrace(path, this.trace());
  }
}

export function createTraceJournal(path, { startedAt = process.env.DROVR_TRACE_STARTED_AT } = {}) {
  const existing = TRACE_JOURNALS.get(path);
  if (existing) return existing;

  let queue = Promise.resolve();
  let sequence = 0;
  let previousAt = 0;
  let captureFailure;
  let failureRecorded = false;
  let startedAtMs = parseStartedAt(startedAt);
  let journalStateCache;
  const append = async (event) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
    await chmod(path, 0o600);
  };
  const failurePath = traceJournalFailurePath(path);
  const failureMarkerExists = async () => {
    try {
      await readFile(failurePath, "utf8");
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const writeFailureMarker = async () => {
    try {
      await writeFile(
        failurePath,
        JSON.stringify({
          schema: "drovr.trace-capture-failure/v1",
          code: "trace_capture_failed",
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      // The trace.capture event is the primary signal when the marker already
      // exists or the sidecar cannot be written.
    }
  };
  const updateJournalStateCache = async (event) => {
    const fileStats = await traceJournalStats(path);
    if (!fileStats) throw new Error("trace journal disappeared after append");
    journalStateCache = {
      sequence: event.sequence,
      previousAt: event.at_ms,
      ...fileStats,
    };
  };
  const appendFailure = async ({ skipJournal = false } = {}) => {
    if (failureRecorded) return;
    if (!skipJournal) {
      try {
        await withTraceJournalLock(path, async () => {
          if (await failureMarkerExists()) {
            failureRecorded = true;
            return;
          }
          const state = await readJournalStateIfChanged(path, journalStateCache);
          journalStateCache = state;
          sequence = state.sequence;
          previousAt = state.previousAt;
          startedAtMs ??= Date.now() - previousAt;
          const event = {
            kind: "error",
            operation: "trace.capture",
            sequence: sequence + 1,
            at_ms: traceAt(Date.now(), startedAtMs, previousAt),
            payload: {
              request: { resource: "trace", action: "capture", target: null },
              error: {
                code: "trace_capture_failed",
                outcome: "adapter_failure",
                message: "Trace capture failed before the event could be persisted.",
              },
            },
          };
          await append(event);
          await updateJournalStateCache(event);
          sequence = event.sequence;
          previousAt = event.at_ms;
          failureRecorded = true;
        });
      } catch {
        // The durable marker below is the cross-process failure signal. If the
        // journal directory itself is unavailable, the caller still keeps the
        // native operation's result independent from capture.
      }
    }
    await writeFailureMarker();
  };
  const journal = {
    record(event) {
      queue = queue.catch(() => undefined).then(async () => {
        if (captureFailure) return;
        let failure;
        try {
          await withTraceJournalLock(path, async () => {
            if (await failureMarkerExists()) {
              failure = new TraceValidationError(
                "trace capture previously failed in another process",
              );
              failureRecorded = true;
              return;
            }
            const state = await readJournalStateIfChanged(path, journalStateCache);
            journalStateCache = state;
            sequence = state.sequence;
            previousAt = state.previousAt;
            startedAtMs ??= Date.now() - previousAt;
            const captured = redactValue(
              {
                ...event,
                sequence: sequence + 1,
                at_ms: traceAt(Date.now(), startedAtMs, previousAt),
              },
              [],
            );
            assertSafeValue(captured);
            await append(captured);
            await updateJournalStateCache(captured);
            sequence = captured.sequence;
            previousAt = captured.at_ms;
          });
        } catch (error) {
          failure = error;
        }
        if (failure) {
          captureFailure = failure;
          await appendFailure({ skipJournal: failure?.code === "ETIMEDOUT" });
        }
      });
      return queue;
    },
    flush() {
      return queue;
    },
  };
  TRACE_JOURNALS.set(path, journal);
  return journal;
}

async function readJournalStateIfChanged(path, cachedState) {
  const fileStats = await traceJournalStats(path);
  if (!fileStats) {
    if (
      cachedState?.size === 0 &&
      cachedState?.mtimeMs === 0 &&
      cachedState?.ino === 0
    ) {
      return cachedState;
    }
    return emptyJournalState();
  }
  if (
    cachedState &&
    cachedState.size === fileStats.size &&
    cachedState.mtimeMs === fileStats.mtimeMs &&
    cachedState.ino === fileStats.ino
  ) {
    return cachedState;
  }
  return readJournalState(path, fileStats);
}

async function readJournalState(path, fileStats) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyJournalState();
    throw error;
  }
  let sequence = 0;
  let previousAt = 0;
  for (const [index, line] of source.split(/\r?\n/u).filter(Boolean).entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      fail(`trace journal line ${index + 1} is invalid JSON: ${error.message}`);
    }
    if (!isRecord(event)) fail(`trace journal line ${index + 1} is not an object`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== sequence + 1) {
      fail(`trace journal line ${index + 1} has an invalid sequence`);
    }
    if (!Number.isSafeInteger(event.at_ms) || event.at_ms < previousAt) {
      fail(`trace journal line ${index + 1} has invalid timing`);
    }
    sequence = event.sequence;
    previousAt = event.at_ms;
  }
  return { sequence, previousAt, ...fileStats };
}

async function traceJournalStats(path) {
  try {
    const fileStats = await stat(path);
    return {
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      ino: fileStats.ino,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function emptyJournalState() {
  return { sequence: 0, previousAt: 0, size: 0, mtimeMs: 0, ino: 0 };
}

async function withTraceJournalLock(path, operation) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + TRACE_LOCK_STALE_MS;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await traceLockIsStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error("timed out waiting for the trace journal lock");
        timeout.code = "ETIMEDOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, TRACE_LOCK_RETRY_MS));
      continue;
    }

    try {
      await writeFile(join(lockPath, "owner"), `${process.pid}\n`, {
        mode: 0o600,
      });
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function traceLockIsStale(lockPath) {
  let lockStats;
  try {
    lockStats = await stat(lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (Date.now() - lockStats.mtimeMs < TRACE_LOCK_STALE_MS) return false;
  let owner;
  try {
    owner = Number.parseInt(await readFile(join(lockPath, "owner"), "utf8"), 10);
  } catch {
    return true;
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return true;
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function parseStartedAt(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function traceAt(now, startedAt, previousAt) {
  return Math.max(previousAt, Math.max(0, now - startedAt));
}

export async function traceFromJournal(path, { scenarioId, provenance }) {
  const source = await readFile(path, "utf8");
  let previousAt = 0;
  const events = source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        fail(`trace journal line ${index + 1} is invalid JSON: ${error.message}`);
      }
      if (!isRecord(event)) fail(`trace journal line ${index + 1} is not an object`);
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) {
        fail(`trace journal line ${index + 1} has an invalid sequence`);
      }
      if (!Number.isSafeInteger(event.at_ms) || event.at_ms < previousAt) {
        fail(`trace journal line ${index + 1} has invalid timing`);
      }
      previousAt = event.at_ms;
      return event;
    });
  return validateTrace({
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    scenario_id: scenarioId,
    provenance,
    events,
  });
}

export function validateTrace(trace) {
  if (!isRecord(trace)) fail("trace must be an object");
  if (trace.schema !== TRACE_SCHEMA) {
    fail(`trace schema must be ${TRACE_SCHEMA}`);
  }
  if (trace.version !== TRACE_VERSION) fail("trace version is unsupported");
  if (typeof trace.scenario_id !== "string" || trace.scenario_id.length === 0) {
    fail("trace scenario_id must be a non-empty string");
  }
  validateProvenance(trace.provenance);
  if (!Array.isArray(trace.events)) fail("trace events must be an array");

  let previousSequence = 0;
  let previousAt = 0;
  for (const event of trace.events) {
    if (!isRecord(event)) fail("trace event must be an object");
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== previousSequence + 1) {
      fail("trace events must be ordered by contiguous sequence");
    }
    if (!Number.isSafeInteger(event.at_ms) || event.at_ms < previousAt) {
      fail("trace events must be ordered by non-decreasing at_ms");
    }
    if (!EVENT_KINDS.has(event.kind)) {
      fail(`trace event kind is unsupported: ${event.kind}`);
    }
    if (typeof event.operation !== "string" || event.operation.length === 0) {
      fail("trace event operation must be a non-empty string");
    }
    if (!isRecord(event.payload)) fail("trace event payload must be an object");
    if (event.payload.request !== undefined && !isRecord(event.payload.request)) {
      fail("trace event request must be an object");
    }
    if (event.kind === "delay") validateDelay(event.payload);
    if (event.kind === "transcript_event") validateTranscriptEvent(event.payload);
    if (event.kind === "error") validateError(event.payload);
    if (event.identity !== undefined) validateIdentity(event.identity);
    previousSequence = event.sequence;
    previousAt = event.at_ms;
  }
  assertSafeValue(trace);
  return trace;
}

export async function writeTrace(path, trace) {
  validateTrace(trace);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(canonicalizeJson(trace), null, 2)}\n`;
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readTrace(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TraceValidationError(`cannot read trace: ${error.message}`);
  }
  return validateTrace(parsed);
}

export function redactValue(value, path = [], options = {}) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, path.at(-1), options, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)], options));
  }
  if (!isRecord(value)) fail("trace values must be lossless JSON");

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (TOKEN_KEY.test(key) && typeof child === "string") {
        return [key, redactToken(child)];
      }
      if (SECRET_KEY.test(key)) return [key, "[REDACTED]"];
      if (PATH_KEY.test(key) && typeof child === "string") {
        return [key, redactPath(child)];
      }
      return [key, redactValue(child, [...path, key], options)];
    }),
  );
}

export function redactPaneSnapshot(value) {
  // Pane replay deliberately preserves only the Claude prompt-box grammar and
  // qualification sentinels. Arbitrary visible text is represented by a
  // digest so a captured terminal cannot become a secret-bearing fixture.
  const text = String(value);
  if (text.length === 0) return "";
  if (SAFE_STRUCTURED_TEXT.test(text)) return text;

  const lines = text.split(/\r?\n/u);
  const dividers = lines.flatMap((line, index) =>
    /^\s*[─━-]{3,}\s*$/u.test(line) ? [index] : [],
  );
  if (dividers.length >= 2) {
    const region = lines.slice(dividers.at(-2) + 1, dividers.at(-1));
    const promptLine = region.findIndex((line) => /^\s*❯/u.test(line));
    if (promptLine >= 0) {
      const displayLines = [
        region[promptLine].replace(/^\s*❯[ \u00a0]?/u, ""),
        ...region.slice(promptLine + 1),
      ];
      return [
        "────────",
        `❯${displayLines.map((line, index) =>
          index === 0 ? ` ${redactPaneLine(line)}` : redactPaneLine(line),
        ).join("\n")}`,
        "────────",
      ].join("\n");
    }
  }

  const pasted = [...text.matchAll(PASTED_TEXT)].map(([match]) => match);
  if (pasted.length > 0) return pasted.join("\n");
  return `[REDACTED_TEXT ${digestText(text)}]`;
}

function redactPaneLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "";
  if (
    SAFE_STRUCTURED_TEXT.test(trimmed) &&
    !trimmed.includes("\n")
  ) {
    return trimmed;
  }
  return `[REDACTED_TEXT ${digestText(trimmed)}]`;
}

function validateProvenance(provenance) {
  if (!isRecord(provenance)) fail("trace provenance must be an object");
  for (const key of ["drovr", "herdr", "claude", "codex"]) {
    if (typeof provenance[key] !== "string" || provenance[key].length === 0) {
      fail(`trace provenance.${key} must be a non-empty exact version`);
    }
  }
}

function validateDelay(payload) {
  if (!Number.isSafeInteger(payload.duration_ms) || payload.duration_ms < 0) {
    fail("trace delay duration_ms must be a non-negative integer");
  }
}

function validateTranscriptEvent(payload) {
  if (typeof payload.harness !== "string" || !isRecord(payload.record)) {
    fail("trace transcript events require harness and record");
  }
}

function validateError(payload) {
  if (!isRecord(payload.error) || typeof payload.error.message !== "string") {
    fail("trace errors require an error message");
  }
  for (const key of ["stdout", "stderr"]) {
    if (payload.error[key] !== undefined && typeof payload.error[key] !== "string") {
      fail(`trace errors require string ${key}`);
    }
  }
  if (payload.error.envelope !== undefined && !isRecord(payload.error.envelope)) {
    fail("trace errors require an object envelope");
  }
}

function validateIdentity(identity) {
  if (!isRecord(identity)) fail("trace identity must be an object");
  for (const [key, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) {
      fail(`trace identity.${key} must be a non-empty string`);
    }
  }
}

function assertSafeValue(value, path = []) {
  if (typeof value === "string") {
    const key = path.at(-1);
    if (TOKEN_KEY.test(key ?? "") && !TOKEN_DIGEST.test(value)) {
      fail(`trace contains an unredacted token at ${path.join(".")}`);
    }
    if (TOKEN_KEY.test(key ?? "") && TOKEN_DIGEST.test(value)) return;
    if (isUnsafeString(value, path.at(-1))) {
      fail(`trace contains unsafe value at ${path.join(".")}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, [...path, String(index)]));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertSafeValue(child, [...path, key]);
    }
  }
}

function isUnsafeString(value, key) {
  if (BEARER.test(value) || SECRET_ASSIGNMENT.test(value) || PRIVATE_KEY.test(value)) {
    return true;
  }
  if (PATH_KEY.test(key ?? "") && hasUnsafeAbsolutePath(value)) return true;
  if (hasUnsafeAbsolutePath(value)) return true;
  return false;
}

function redactString(value, key, options, path) {
  const pathRedacted = value.replace(
    ABSOLUTE_PATH_GLOBAL,
    (pathValue, offset, source) =>
      isPublicUrlPath(source, pathValue, offset) ? pathValue : redactPath(pathValue),
  );
  const secretRedacted = pathRedacted
    .replace(BEARER_GLOBAL, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT_GLOBAL, (match) => `${match.slice(0, match.search(/[:=]/u) + 1)}[REDACTED]`)
    .replace(PRIVATE_KEY_GLOBAL, "[REDACTED_PRIVATE_KEY]");
  if (
    TEXT_KEY.test(key ?? "") &&
    !SAFE_STRUCTURED_TEXT.test(secretRedacted)
  ) {
    const allowed = options.allowText?.some((pattern) => pattern.test(secretRedacted));
    if (!allowed) {
      return `[REDACTED_TEXT ${digestText(value)}]`;
    }
  }
  return secretRedacted;
}

function redactToken(value) {
  return TOKEN_DIGEST.test(value) ? value : `<token:${digestText(value)}>`;
}

function traceInput(value) {
  if (/^(?:QUALIFY|REPLAY|TRACE)-[A-Z0-9_-]+$/u.test(value)) {
    return { sentinel: value };
  }
  return { length: value.length, sha256: digestText(value) };
}

function redactPath(value) {
  return `<path:${digestText(value)}>`;
}

function hasUnsafeAbsolutePath(value) {
  UNSAFE_ABSOLUTE_PATH_GLOBAL.lastIndex = 0;
  for (const match of value.matchAll(UNSAFE_ABSOLUTE_PATH_GLOBAL)) {
    const markerOffset = match[0].search(/(?:\/{1,2}|[A-Z]:\\)/u);
    const absoluteOffset = match.index + markerOffset;
    const pathValue = match[0].slice(markerOffset);
    if (!isPublicUrlPath(value, pathValue, absoluteOffset)) return true;
  }
  return false;
}

function isPublicUrlPath(source, pathValue, offset) {
  if (!pathValue.startsWith("//")) return false;
  const schemeMatch = source
    .slice(0, offset)
    .match(/(?:^|[^\w.-])([A-Za-z][A-Za-z0-9+.-]*):$/u);
  if (!schemeMatch || !PUBLIC_URL_SCHEMES.has(schemeMatch[1].toLowerCase())) {
    return false;
  }
  const authority = pathValue.slice(2).split(/[/?#]/u, 1)[0];
  return authority.length > 0 && !authority.includes("@");
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new TraceValidationError(message);
}
