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

export async function locateCodexTranscript(root, sessionId) {
  return locateJsonlTranscript({
    root,
    sessionId,
    harness: "Codex",
    matchesSession: (path, candidate) => path.includes(candidate),
  });
}

export async function captureTranscriptCursor(path) {
  return captureJsonlCursor(path, "codex-jsonl/v1");
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
  const firstLine = buffer
    .subarray(0, bytesRead)
    .toString("utf8")
    .split(/\r?\n/u)
    .find(Boolean);
  try {
    const record = JSON.parse(firstLine);
    return record?.type === "session_meta" ? record : null;
  } catch {
    return null;
  }
}

export async function validateCodexTranscript(path, sessionId, cwd) {
  const metadata = await readSessionMetadata(path);
  if (
    metadata?.payload?.id !== sessionId ||
    metadata.payload?.cwd !== cwd
  ) {
    throw new DrovrError(
      "Codex transcript metadata does not match the registered session and cwd",
      { outcome: "recovery_blocked" },
    );
  }
  return true;
}

export async function captureTranscriptInventory(
  root,
  cwd,
  capturedAt = new Date().toISOString(),
) {
  const candidates = [];
  for (const path of await walkFiles(root)) {
    if (!path.endsWith(".jsonl")) continue;
    const metadata = await readSessionMetadata(path);
    if (metadata?.payload?.cwd !== cwd || !metadata.payload.id) continue;
    candidates.push({
      native_session: metadata.payload.id,
      ...(await captureTranscriptCursor(path)),
    });
  }
  return {
    adapter: "codex-jsonl/v1",
    transcript_root: root,
    cwd,
    captured_at: capturedAt,
    candidates: candidates.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export async function resolveInventoryCursor(cursor, path, sessionId) {
  const candidate = cursor.candidates.find(
    ({ native_session: nativeSession }) => nativeSession === sessionId,
  );
  if (candidate) {
    if (candidate.path !== path) {
      throw new DrovrError(
        "reported Codex session moved to a different transcript path",
        { outcome: "uncertain" },
      );
    }
    const { native_session: _nativeSession, ...resolved } = candidate;
    return resolved;
  }

  const firstRecord = await readSessionMetadata(path);
  if (
    firstRecord?.payload?.id !== sessionId ||
    firstRecord.payload?.cwd !== cursor.cwd
  ) {
    throw new DrovrError(
      "Codex transcript header does not match the reported session",
      { outcome: "uncertain" },
    );
  }
  return initialJsonlCursor("codex-jsonl/v1", path, cursor.captured_at);
}

function messageText(content, type) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === type && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function eventUserText(record) {
  if (record?.type === "event_msg" && record.payload?.type === "user_message") {
    return record.payload.message;
  }
  return null;
}

function responseUserText(record) {
  if (
    record?.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "user"
  ) {
    return messageText(record.payload.content, "input_text");
  }
  return null;
}

function finalAssistantText(record) {
  if (
    record?.type !== "response_item" ||
    record.payload?.type !== "message" ||
    record.payload?.role !== "assistant" ||
    (record.payload.phase ?? "final_answer") !== "final_answer"
  )
    return null;
  return messageText(record.payload.content, "output_text");
}

export async function extractCodexTurn(cursor, inputs) {
  const records = await readJsonlRecordsAfterCursor(cursor, "Codex");
  const responseItemsAreAuthoritative = records.some(
    (record) => responseUserText(record) !== null,
  );
  const observedUserText = responseItemsAreAuthoritative
    ? responseUserText
    : eventUserText;

  return correlateTranscriptRecords(records, inputs, {
    harness: "Codex",
    userText: observedUserText,
    finalAssistantText,
  });
}
