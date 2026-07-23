import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureClaudeTranscriptCursor,
  extractClaudeTurn,
} from "../src/claude-transcript.mjs";

test("Claude adapter returns the complete final message after the captured cursor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-transcript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "11111111-2222-4333-8444-555555555555.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "STALE" }],
      },
    })}\n`,
  );
  const cursor = await captureClaudeTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "new request" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          content: [{ type: "text", text: "working" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [
            { type: "text", text: "first line\n" },
            { type: "text", text: "second line" },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  const result = await extractClaudeTurn(cursor, ["new request"]);

  assert.equal(cursor.adapter, "claude-jsonl/v1");
  assert.equal(result.text, "first line\nsecond line");
  assert.deepEqual(result.messages, ["first line\nsecond line"]);
});

test("Claude adapter rejects a cursor from another transcript adapter", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-adapter-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "transcript.jsonl");
  await writeFile(transcript, "");
  const cursor = await captureClaudeTranscriptCursor(transcript);
  cursor.adapter = "codex-jsonl/v1";
  await appendFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "new request" },
    })}\n${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "wrong adapter" }],
      },
    })}\n`,
  );

  await assert.rejects(() => extractClaudeTurn(cursor, ["new request"]), {
    message: "unsupported Claude transcript cursor adapter: codex-jsonl/v1",
    outcome: "unsupported_transcript",
  });
});
