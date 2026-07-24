import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureTranscriptCursor,
  extractCodexTurn,
  validateCodexTranscript,
} from "../src/codex-transcript.mjs";

test("Codex recovery validation binds transcript metadata to session and cwd", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-codex-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "rollout-native-1.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "native-1", cwd: scratch },
    })}\n`,
  );

  assert.equal(
    await validateCodexTranscript(transcript, "native-1", scratch),
    true,
  );
  await assert.rejects(
    () => validateCodexTranscript(transcript, "native-1", "/wrong/cwd"),
    { outcome: "recovery_blocked" },
  );
});

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

test("Codex adapter correlates ordered steering before accepting the final result", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-codex-steering-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "rollout-session-1.jsonl");
  await writeFile(transcript, "");
  const cursor = await captureTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "initial" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "intermediate" }],
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "steer" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "settled" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  const result = await extractCodexTurn(cursor, ["initial", "steer"]);

  assert.equal(result.text, "settled");
  assert.deepEqual(result.messages, ["intermediate", "settled"]);
});

test("Codex adapter does not count duplicate native records as repeated inputs", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-codex-duplicates-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "rollout-session-1.jsonl");
  await writeFile(transcript, "");
  const cursor = await captureTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "repeat" }],
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "repeat" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "only one delivery" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  await assert.rejects(() => extractCodexTurn(cursor, ["repeat", "repeat"]), {
    message: "submitted input was not observed after the transcript cursor",
    outcome: "uncertain",
  });
});
