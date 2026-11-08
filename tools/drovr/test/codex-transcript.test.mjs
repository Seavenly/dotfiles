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

const SESSION_CONTEXT =
  "# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nUse plain hyphens.\n" +
  "</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>/work</cwd>\n</environment_context>";

async function transcriptAfterCursor(t, prefix, records) {
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "rollout-session-1.jsonl");
  await writeFile(transcript, "");
  const cursor = await captureTranscriptCursor(transcript);
  await appendFile(
    transcript,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return cursor;
}

function userRecord(text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

function finalAnswerRecord(text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  };
}

test("Codex adapter correlates a prompt recorded without its terminating newline", async (t) => {
  const cursor = await transcriptAfterCursor(t, "drovr-codex-newline-", [
    userRecord("review the branch"),
    finalAnswerRecord("no findings"),
  ]);

  const result = await extractCodexTurn(cursor, ["review the branch\n"]);

  assert.equal(result.text, "no findings");
});

test("Codex adapter skips the session context recorded before the first prompt", async (t) => {
  const cursor = await transcriptAfterCursor(t, "drovr-codex-preamble-", [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>" }],
      },
    },
    userRecord(SESSION_CONTEXT),
    userRecord("review the branch"),
    { type: "event_msg", payload: { type: "user_message", message: "" } },
    finalAnswerRecord("no findings"),
  ]);

  const result = await extractCodexTurn(cursor, ["review the branch"]);

  assert.equal(result.text, "no findings");
  assert.deepEqual(result.messages, ["no findings"]);
});

test("Codex adapter rejects a native input interleaved with recorded inputs", async (t) => {
  const cursor = await transcriptAfterCursor(t, "drovr-codex-interleaved-", [
    userRecord(SESSION_CONTEXT),
    userRecord("begin"),
    finalAnswerRecord("intermediate"),
    userRecord("typed straight into the TUI"),
    finalAnswerRecord("answers the human, not us"),
    userRecord("steer"),
    finalAnswerRecord("settled"),
  ]);

  await assert.rejects(() => extractCodexTurn(cursor, ["begin", "steer"]), {
    message:
      "recorded input order was interrupted by an unrelated native input",
    outcome: "uncertain",
  });
});

test("Codex adapter stops the settled result at a native input that follows it", async (t) => {
  const cursor = await transcriptAfterCursor(t, "drovr-codex-trailing-", [
    userRecord(SESSION_CONTEXT),
    userRecord("review the branch"),
    finalAnswerRecord("ours"),
    userRecord("typed straight into the TUI"),
    finalAnswerRecord("theirs"),
  ]);

  const result = await extractCodexTurn(cursor, ["review the branch"]);

  assert.equal(result.text, "ours");
  assert.deepEqual(result.messages, ["ours"]);
});
