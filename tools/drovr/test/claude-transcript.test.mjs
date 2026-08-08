import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureClaudeTranscriptCursor,
  extractClaudeTurn,
  locateClaudeTranscript,
  resolveClaudeInventoryCursor,
  validateClaudeTranscript,
} from "../src/claude-transcript.mjs";

test("missing Claude transcript remains a recoverable correlation state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-missing-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      locateClaudeTranscript(
        scratch,
        "11111111-2222-4333-8444-555555555555",
      ),
    {
      outcome: "uncertain",
      details: { correlation_pending: true },
    },
  );
});

test("Claude recovery validation binds transcript metadata to session and cwd", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(
    scratch,
    "11111111-2222-4333-8444-555555555555.jsonl",
  );
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      sessionId: "11111111-2222-4333-8444-555555555555",
      cwd: scratch,
      message: { role: "user", content: "request" },
    })}\n`,
  );

  assert.equal(
    await validateClaudeTranscript(
      transcript,
      "11111111-2222-4333-8444-555555555555",
      scratch,
    ),
    true,
  );
  await assert.rejects(
    () =>
      validateClaudeTranscript(
        transcript,
        "11111111-2222-4333-8444-555555555555",
        "/wrong/cwd",
      ),
    { outcome: "recovery_blocked" },
  );
});

test("Claude inventory resolution distinguishes startup metadata still being written", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-startup-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const nativeSession = "11111111-2222-4333-8444-555555555555";
  const transcript = join(scratch, `${nativeSession}.jsonl`);
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "mode", sessionId: nativeSession })}\n`,
  );
  const inventory = {
    adapter: "claude-jsonl/v1",
    transcript_root: scratch,
    cwd: scratch,
    captured_at: "2026-07-23T10:00:00.000Z",
    candidates: [],
  };

  await assert.rejects(
    () => resolveClaudeInventoryCursor(inventory, transcript, nativeSession),
    { details: { correlation_pending: true } },
  );

  await appendFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      sessionId: nativeSession,
      cwd: scratch,
      message: { role: "user", content: "request" },
    })}\n`,
  );
  const resolved = await resolveClaudeInventoryCursor(
    inventory,
    transcript,
    nativeSession,
  );
  assert.equal(resolved.path, transcript);
  assert.equal(resolved.offset, 0);
});

test("Claude adapter returns the complete final message after the captured cursor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-transcript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(
    scratch,
    "11111111-2222-4333-8444-555555555555.jsonl",
  );
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
          content: [{ type: "thinking", thinking: "hidden" }],
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

test("Claude adapter correlates ordered steering before accepting the final result", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-steering-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(
    scratch,
    "11111111-2222-4333-8444-555555555555.jsonl",
  );
  await writeFile(transcript, "");
  const cursor = await captureClaudeTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      { type: "user", message: { role: "user", content: "initial" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "intermediate" }],
        },
      },
      { type: "user", message: { role: "user", content: "steer" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "settled" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  const result = await extractClaudeTurn(cursor, ["initial", "steer"]);

  assert.equal(result.text, "settled");
  assert.deepEqual(result.messages, ["intermediate", "settled"]);
});

test("Claude adapter rejects an assistant result after an unrelated later input", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-boundary-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(
    scratch,
    "11111111-2222-4333-8444-555555555555.jsonl",
  );
  await writeFile(transcript, "");
  const cursor = await captureClaudeTranscriptCursor(transcript);
  await appendFile(
    transcript,
    [
      { type: "user", message: { role: "user", content: "recorded input" } },
      { type: "user", message: { role: "user", content: "unrelated input" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "unrelated result" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  await assert.rejects(
    () => extractClaudeTurn(cursor, ["recorded input"]),
    {
      message: "no completed Claude assistant result followed the final input",
      outcome: "uncertain",
    },
  );
});
