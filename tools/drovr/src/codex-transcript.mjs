import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";

import { DrovrError } from "./errors.mjs";
import { walkFiles } from "./files.mjs";

export async function locateCodexTranscript(root, sessionId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let files = [];
    try {
      files = await walkFiles(root);
    } catch (error) {
      throw new DrovrError(
        `cannot scan Codex transcript root ${root}: ${error.message}`,
      );
    }
    const match = files.find(
      (path) => path.endsWith(".jsonl") && path.includes(sessionId),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new DrovrError(
    `Codex transcript not found for native session ${sessionId}`,
    {
      outcome: "unsupported_transcript",
      code: 4,
    },
  );
}

export async function captureTranscriptCursor(path) {
  const { size } = await stat(path);
  const anchorStart = Math.max(0, size - 1024);
  const length = size - anchorStart;
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    if (length) await handle.read(buffer, 0, length, anchorStart);
  } finally {
    await handle.close();
  }
  return {
    adapter: "codex-jsonl/v1",
    path,
    offset: size,
    anchor_start: anchorStart,
    anchor_sha256: createHash("sha256").update(buffer).digest("hex"),
  };
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
  return {
    adapter: "codex-jsonl/v1",
    path,
    offset: 0,
    anchor_start: 0,
    anchor_sha256: createHash("sha256").update("").digest("hex"),
    captured_at: cursor.captured_at,
  };
}

function messageText(content, type) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === type && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function userText(record) {
  if (record?.type === "event_msg" && record.payload?.type === "user_message") {
    return record.payload.message;
  }
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
  const current = await readFile(cursor.path);
  if (current.length < cursor.offset) {
    throw new DrovrError(
      "Codex transcript was truncated after cursor capture",
      {
        outcome: "unsupported_transcript",
      },
    );
  }
  const anchor = current.subarray(cursor.anchor_start, cursor.offset);
  if (
    createHash("sha256").update(anchor).digest("hex") !== cursor.anchor_sha256
  ) {
    throw new DrovrError("Codex transcript cursor anchor no longer matches", {
      outcome: "unsupported_transcript",
    });
  }
  const records = current
    .subarray(cursor.offset)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new DrovrError(
          `unsupported Codex JSONL record: ${error.message}`,
          {
            outcome: "unsupported_transcript",
          },
        );
      }
    });

  let recordIndex = -1;
  for (const input of inputs) {
    recordIndex = records.findIndex(
      (record, index) => index > recordIndex && userText(record) === input,
    );
    if (recordIndex < 0) {
      throw new DrovrError(
        "submitted input was not observed after the transcript cursor",
        {
          outcome: "uncertain",
        },
      );
    }
  }
  const messages = records
    .slice(recordIndex + 1)
    .map(finalAssistantText)
    .filter((text) => text !== null);
  if (messages.length === 0) {
    throw new DrovrError(
      "no completed Codex assistant result followed the final input",
      {
        outcome: "uncertain",
      },
    );
  }
  return { text: messages.at(-1), messages };
}
