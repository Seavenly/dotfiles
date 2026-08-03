import { HerdrClient } from "./herdr.mjs";
import { canonicalizeJson } from "./canonical-json.mjs";
import { correlateTranscriptRecords } from "./transcript.mjs";
import { traceOperation, traceRequest, validateTrace } from "./trace.mjs";

export class ReplayError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReplayError";
    this.details = details;
  }
}

export function createReplayHarness(trace, { harness = "codex", session = "replay" } = {}) {
  validateTrace(trace);
  const timeline = new ReplayTimeline(trace);
  const clock = new ReplayClock(timeline);
  const transport = createReplayTransport(timeline, clock);
  const adapter = createReplayTranscriptAdapter(timeline, clock, harness);
  const client = new HerdrClient({
    session,
    run: transport,
    env: {},
    delay: (milliseconds) => clock.delay(milliseconds),
  });
  return {
    client,
    clock,
    adapter,
    transcript: adapter,
    remainingEvents: () => timeline.remainingEvents(),
    consumedEvents: () => timeline.consumedEvents(),
  };
}

export class ReplayClock {
  constructor(timeline, startMs = 0) {
    this.timeline = timeline;
    this.currentMs = startMs;
  }

  now() {
    return this.currentMs;
  }

  async delay(requestedMs) {
    const event = this.timeline.consumeDelay(requestedMs, this.currentMs);
    this.currentMs = Math.max(
      this.currentMs,
      event.at_ms,
      this.currentMs + event.payload.duration_ms,
    );
  }
}

function createReplayTransport(timeline, clock) {
  return async (_file, args) => {
    const operation = traceOperation(args);
    const event = timeline.consumeOperation(operation, args, clock.now());
    if (event.kind === "error") {
      const error = new ReplayError(event.payload.error.message, {
        operation,
        sequence: event.sequence,
      });
      if (event.payload.error.envelope !== undefined) {
        error.envelope = event.payload.error.envelope;
      }
      error.stderr = JSON.stringify({
        schema: "herdr.error/v1",
        error: event.payload.error,
      });
      if (typeof event.payload.error.stdout === "string") {
        error.stdout = event.payload.error.stdout;
      }
      if (typeof event.payload.error.stderr === "string") {
        error.stderr = event.payload.error.stderr;
      }
      throw error;
    }
    if (event.kind === "pane_snapshot") return String(event.payload.text ?? "");
    const envelope = event.payload.envelope ?? {
      schema: "herdr.command/v1",
      result: event.payload.result ?? {},
    };
    return JSON.stringify(envelope);
  };
}

function createReplayTranscriptAdapter(timeline, clock, harness) {
  const adapter = `replay-${harness}/v1`;
  return {
    adapter,
    root: `replay:${timeline.trace.scenario_id}`,
    locate: async () => `replay:${timeline.trace.scenario_id}`,
    validateTranscript: async () => true,
    captureCursor: async () => cursor(adapter, clock.now()),
    captureInventory: async () => cursor(adapter, clock.now()),
    resolveInventory: async () => cursor(adapter, clock.now()),
    extract: async (cursorValue, inputs) => {
      if (
        cursorValue?.adapter !== adapter ||
        cursorValue?.path !== "replay://trace"
      ) {
        throw new ReplayError("replay transcript cursor does not belong to this adapter");
      }
      const records = timeline.transcriptRecords(harness, clock.now());
      return correlateTranscriptRecords(records, inputs, {
        harness: harness === "claude" ? "Claude" : "Codex",
        userText: harness === "claude" ? claudeUserText : codexUserText,
        finalAssistantText:
          harness === "claude" ? claudeAssistantText : codexAssistantText,
      });
    },
  };
}

function cursor(adapter, atMs) {
  return {
    adapter,
    path: "replay://trace",
    offset: 0,
    anchor_start: 0,
    anchor_sha256: "",
    captured_at_ms: atMs,
  };
}

class ReplayTimeline {
  constructor(trace) {
    this.trace = trace;
    this.consumed = new Set();
  }

  consumeOperation(operation, args, now) {
    const event = this.nextUnconsumed(now);
    if (!event) {
      throw new ReplayError(`replay ended before ${operation}`, { operation });
    }
    if (event.kind === "transcript_event") {
      throw new ReplayError(
        `replay requires consuming transcript event ${event.sequence} before ${operation}`,
        { operation, expected: "transcript_event", sequence: event.sequence },
      );
    }
    if (event.kind === "delay") {
      throw new ReplayError(
        `replay requires advancing the clock before ${operation}`,
        { operation, expected: "delay", sequence: event.sequence },
      );
    }
    if (event.operation !== operation) {
      throw new ReplayError(
        `replay expected ${event.operation}, received ${operation}`,
        { expected: event.operation, received: operation, sequence: event.sequence },
      );
    }
    if (event.payload.request !== undefined) {
      const actualRequest = traceRequest(args);
      if (
        JSON.stringify(canonicalizeJson(event.payload.request)) !==
        JSON.stringify(canonicalizeJson(actualRequest))
      ) {
        throw new ReplayError(
          `replay request for ${operation} does not match the trace`,
          {
            operation,
            sequence: event.sequence,
            expected_request: event.payload.request,
            received_request: actualRequest,
          },
        );
      }
    }
    if (event.at_ms > now) {
      throw new ReplayError(
        `replay event ${event.sequence} is not available until ${event.at_ms}ms`,
        { operation, sequence: event.sequence, available_at_ms: event.at_ms },
      );
    }
    this.consumed.add(event.sequence);
    return event;
  }

  consumeDelay(requestedMs, now) {
    const event = this.nextUnconsumed(now, { skipFutureTranscript: true });
    if (!event || event.kind !== "delay") {
      if (event?.kind === "transcript_event") {
        throw new ReplayError(
          `replay requires consuming transcript event ${event.sequence} before advancing time`,
          { expected: "transcript_event", sequence: event.sequence },
        );
      }
      throw new ReplayError("replay requested an unrecorded delay", {
        requested_ms: requestedMs,
        at_ms: now,
      });
    }
    if (event.at_ms < now) {
      throw new ReplayError("replay delay is earlier than the current clock", {
        sequence: event.sequence,
      });
    }
    if (requestedMs !== event.payload.duration_ms) {
      throw new ReplayError("replay delay duration does not match the trace", {
        requested_ms: requestedMs,
        recorded_ms: event.payload.duration_ms,
        sequence: event.sequence,
      });
    }
    this.consumed.add(event.sequence);
    return event;
  }

  transcriptRecords(harness, now) {
    const records = [];
    for (const event of this.trace.events) {
      if (this.consumed.has(event.sequence)) continue;
      if (event.kind !== "transcript_event") break;
      if (event.at_ms > now) break;
      if (event.payload.harness !== harness) break;
      this.consumed.add(event.sequence);
      records.push(event.payload.record);
    }
    return records;
  }

  remainingEvents() {
    return this.trace.events.filter(({ sequence }) => !this.consumed.has(sequence));
  }

  consumedEvents() {
    return this.trace.events.filter(({ sequence }) => this.consumed.has(sequence));
  }

  nextUnconsumed(now, { skipFutureTranscript = false } = {}) {
    for (const event of this.trace.events) {
      if (this.consumed.has(event.sequence)) continue;
      if (skipFutureTranscript && event.kind === "transcript_event" && event.at_ms > now) {
        continue;
      }
      return event;
    }
    return undefined;
  }
}

function codexUserText(record) {
  if (record?.type === "event_msg" && record.payload?.type === "user_message") {
    return typeof record.payload.message === "string" ? record.payload.message : null;
  }
  if (
    record?.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "user"
  ) {
    return textContent(record.payload.content, "input_text");
  }
  return null;
}

function claudeUserText(record) {
  if (record?.type !== "user" || record.message?.role !== "user") return null;
  return textContent(record.message.content, "text");
}

function codexAssistantText(record) {
  if (
    record?.type !== "response_item" ||
    record.payload?.type !== "message" ||
    record.payload?.role !== "assistant" ||
    (record.payload.phase ?? "final_answer") !== "final_answer"
  ) return null;
  return textContent(record.payload.content, "output_text");
}

function claudeAssistantText(record) {
  if (
    record?.type !== "assistant" ||
    record.message?.role !== "assistant" ||
    record.message.stop_reason !== "end_turn"
  ) return null;
  return textContent(record.message.content, "text");
}

function textContent(content, type) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((item) => item?.type === type && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
  return text.length > 0 ? text : null;
}
