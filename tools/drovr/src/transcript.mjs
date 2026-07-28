import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";

import { DrovrError } from "./errors.mjs";
import { walkFiles } from "./files.mjs";

export async function locateJsonlTranscript({
  root,
  sessionId,
  harness,
  matchesSession,
}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let files = [];
    try {
      files = await walkFiles(root);
    } catch (error) {
      throw new DrovrError(
        `cannot scan ${harness} transcript root ${root}: ${error.message}`,
      );
    }
    const match = files.find(
      (path) => path.endsWith(".jsonl") && matchesSession(path, sessionId),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new DrovrError(
    `${harness} transcript not found for native session ${sessionId}`,
    {
      outcome: "unsupported_transcript",
      code: 4,
      details: { correlation_pending: true },
    },
  );
}

export async function captureJsonlCursor(path, adapter) {
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
    adapter,
    path,
    offset: size,
    anchor_start: anchorStart,
    anchor_sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export async function readJsonlRecordsAfterCursor(cursor, harness) {
  const current = await readFile(cursor.path);
  if (current.length < cursor.offset) {
    throw new DrovrError(
      `${harness} transcript was truncated after cursor capture`,
      { outcome: "unsupported_transcript" },
    );
  }
  const anchor = current.subarray(cursor.anchor_start, cursor.offset);
  if (
    createHash("sha256").update(anchor).digest("hex") !== cursor.anchor_sha256
  ) {
    throw new DrovrError(
      `${harness} transcript cursor anchor no longer matches`,
      { outcome: "unsupported_transcript" },
    );
  }
  return current
    .subarray(cursor.offset)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new DrovrError(
          `unsupported ${harness} JSONL record: ${error.message}`,
          { outcome: "unsupported_transcript" },
        );
      }
    });
}

export function initialJsonlCursor(adapter, path, capturedAt) {
  return {
    adapter,
    path,
    offset: 0,
    anchor_start: 0,
    anchor_sha256: createHash("sha256").update("").digest("hex"),
    captured_at: capturedAt,
  };
}

export function correlateTranscriptRecords(
  records,
  inputs,
  { harness, userText, finalAssistantText },
) {
  let recordIndex = -1;
  let firstInputIndex = -1;
  for (const input of inputs) {
    const nextInputIndex = records.findIndex(
      (record, index) =>
        index > recordIndex && userText(record) !== null,
    );
    recordIndex = nextInputIndex;
    if (recordIndex < 0) {
      throw new DrovrError(
        "submitted input was not observed after the transcript cursor",
        {
          outcome: "uncertain",
          details: {
            correlation_pending: true,
            correlation_stage: "recorded_inputs",
          },
        },
      );
    }
    if (userText(records[recordIndex]) !== input) {
      throw new DrovrError(
        "recorded input order was interrupted by an unrelated native input",
        { outcome: "uncertain" },
      );
    }
    if (firstInputIndex < 0) firstInputIndex = recordIndex;
  }

  const nextInputIndex = records.findIndex(
    (record, index) => index > recordIndex && userText(record) !== null,
  );
  const conversationEnd = nextInputIndex < 0 ? records.length : nextInputIndex;

  const messages = records
    .slice(firstInputIndex + 1, conversationEnd)
    .map(finalAssistantText)
    .filter((text) => text !== null);
  const settledMessages = records
    .slice(recordIndex + 1, conversationEnd)
    .map(finalAssistantText)
    .filter((text) => text !== null);
  if (settledMessages.length === 0) {
    throw new DrovrError(
      `no completed ${harness} assistant result followed the final input`,
      {
        outcome: "uncertain",
        details: {
          correlation_pending: true,
          correlation_stage: "assistant_result",
        },
      },
    );
  }
  return { text: settledMessages.at(-1), messages };
}
