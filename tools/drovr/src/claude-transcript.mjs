import { open } from "node:fs/promises";

import { DrovrError } from "./errors.mjs";
import { walkFiles } from "./files.mjs";
import {
  captureJsonlCursor,
  correlateTranscriptRecords,
  initialJsonlCursor,
  locateJsonlTranscript,
  readJsonlRecordsAfterCursor,
} from "./transcript.mjs";

const ADAPTER = "claude-jsonl/v1";

export async function locateClaudeTranscript(root, sessionId) {
  return locateJsonlTranscript({
    root,
    sessionId,
    harness: "Claude",
    matchesSession: (path, candidate) => path.endsWith(`/${candidate}.jsonl`),
  });
}

export async function captureClaudeTranscriptCursor(path) {
  return captureJsonlCursor(path, ADAPTER);
}

async function readSessionMetadata(path) {
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
  } finally {
    await handle.close();
  }
  for (const line of buffer
    .subarray(0, bytesRead)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record?.sessionId && record?.cwd) {
        return { native_session: record.sessionId, cwd: record.cwd };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function captureClaudeTranscriptInventory(
  root,
  cwd,
  capturedAt = new Date().toISOString(),
) {
  const candidates = [];
  for (const path of await walkFiles(root)) {
    if (!path.endsWith(".jsonl")) continue;
    const metadata = await readSessionMetadata(path);
    if (metadata?.cwd !== cwd || !metadata.native_session) continue;
    candidates.push({
      native_session: metadata.native_session,
      ...(await captureClaudeTranscriptCursor(path)),
    });
  }
  return {
    adapter: ADAPTER,
    transcript_root: root,
    cwd,
    captured_at: capturedAt,
    candidates: candidates.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export async function resolveClaudeInventoryCursor(cursor, path, sessionId) {
  const candidate = cursor.candidates.find(
    ({ native_session: nativeSession }) => nativeSession === sessionId,
  );
  if (candidate) {
    if (candidate.path !== path) {
      throw new DrovrError(
        "reported Claude session moved to a different transcript path",
        { outcome: "uncertain" },
      );
    }
    const { native_session: _nativeSession, ...resolved } = candidate;
    return resolved;
  }

  const metadata = await readSessionMetadata(path);
  if (!metadata) {
    throw new DrovrError("Claude transcript metadata is not available yet", {
      outcome: "uncertain",
      details: { correlation_pending: true },
    });
  }
  if (metadata?.native_session !== sessionId || metadata.cwd !== cursor.cwd) {
    throw new DrovrError(
      "Claude transcript metadata does not match the reported session",
      { outcome: "uncertain" },
    );
  }
  return initialJsonlCursor(ADAPTER, path, cursor.captured_at);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function userText(record) {
  if (record?.type !== "user" || record.message?.role !== "user") return null;
  return messageText(record.message.content);
}

function finalAssistantText(record) {
  if (
    record?.type !== "assistant" ||
    record.message?.role !== "assistant" ||
    record.message.stop_reason !== "end_turn"
  ) {
    return null;
  }
  const text = messageText(record.message.content);
  return text.length > 0 ? text : null;
}

export async function extractClaudeTurn(cursor, inputs) {
  if (cursor.adapter !== ADAPTER) {
    throw new DrovrError(
      `unsupported Claude transcript cursor adapter: ${cursor.adapter}`,
      { outcome: "unsupported_transcript" },
    );
  }
  const records = await readJsonlRecordsAfterCursor(cursor, "Claude");
  return correlateTranscriptRecords(records, inputs, {
    harness: "Claude",
    userText,
    finalAssistantText,
  });
}
