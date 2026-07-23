import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureTranscriptCursor,
  extractCodexTurn,
} from "../src/codex-transcript.mjs";

test("Codex adapter returns the complete final message after the captured cursor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-transcript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "rollout-session-1.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "STALE" }],
      },
    })}\n`,
  );
  const cursor = await captureTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "new request" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "working" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [
            { type: "output_text", text: "first line\n" },
            { type: "output_text", text: "second line" },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  const result = await extractCodexTurn(cursor, ["new request"]);

  assert.equal(result.text, "first line\nsecond line");
  assert.deepEqual(result.messages, ["first line\nsecond line"]);
});
