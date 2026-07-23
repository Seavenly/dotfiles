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
    { outcome: "unsupported_transcript", code: 4 },
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
