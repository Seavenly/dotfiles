import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { captureClaudeTranscriptCursor } from "../src/claude-transcript.mjs";
import { collectProductionCompatibility } from "../src/compatibility.mjs";
import {
  createAgentLaunchBinding,
} from "../src/description.mjs";
import {
  loadConfiguration,
  resolveLaunchSpecification,
} from "../src/config.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
import { createTurnRecord, settleTurnRecord } from "../src/turn-record.mjs";
import {
  bindStagedInputToken,
  createStagedInputReceipt,
} from "../src/staged-input-receipt.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const drovr = join(root, "bin", "drovr");

test("public CLI recovers owned input and explicitly clears unknown input", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-staged-input-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const herdrState = join(scratch, "herdr");
  const cwd = join(scratch, "work");
  const claudeHome = join(scratch, "claude");
  const transcriptDirectory = join(claudeHome, "projects", "fixture");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(herdrState, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(transcriptDirectory, { recursive: true });
  const nativeSession = "11111111-2222-4333-8444-555555555555";
  const transcript = join(transcriptDirectory, `${nativeSession}.jsonl`);
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      sessionId: nativeSession,
      cwd,
      message: { role: "user", content: "earlier request" },
    })}\n`,
  );
  const snapshotToken = createHash("sha256")
    .update("Exact Drovr work")
    .digest("hex");
  const fakeClaude = join(fakeBin, "claude");
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env bash
if [[ \${1:-} == --version ]]; then
  printf '2.1.199 (Claude Code)\\n'
  exit
fi
printf '%s\\n' '--model --effort --permission-mode manual dontAsk acceptEdits auto bypassPermissions --allowedTools --append-system-prompt --append-system-prompt-file'
`,
  );
  await chmod(fakeClaude, 0o755);
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(herdrState)}
if [[ \${1:-} == --version ]]; then
  printf 'herdr 0.7.5\\n'
  exit
fi
if [[ \${1:-} == integration && \${2:-} == status ]]; then
  printf 'claude: current (v7)\\ncodex: current (v6)\\n'
  exit
fi
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"persisted-session","running":true}]}\\n'
  exit
fi
[[ \${1:-} == --session && \${2:-} == persisted-session ]]
shift 2
case "\${1:-} \${2:-}" in
  "agent list")
    if [[ -f "$state/settled" ]]; then status=idle; seq=14
    elif [[ -f "$state/asked" ]]; then status=done; seq=15
    elif [[ -f "$state/follow-up-complete" ]]; then status=done; seq=16
    elif [[ -f "$state/submitted" ]]; then status=working; seq=14
    elif [[ -f "$state/advanced" ]]; then status=idle; seq=13
    else status=idle; seq=12
    fi
    if [[ -f "$state/missing-seq" ]]; then
      printf '{"result":{"agents":[{"name":"managed-agent","pane_id":"pane-agent-1","agent_status":"%s","agent_session":{"value":"${nativeSession}"}}]}}\\n' "$status"
      exit
    fi
    printf '{"result":{"agents":[{"name":"managed-agent","pane_id":"pane-agent-1","agent_status":"%s","state_change_seq":%s,"agent_session":{"value":"${nativeSession}"}}]}}\\n' "$status" "$seq"
    ;;
  "agent read")
    if [[ -f "$state/staged-by-command" ]]; then
      printf '────────\\n❯ %s\\n────────\\n' "$(cat "$state/staged-by-command")"
    elif [[ -f "$state/replaced" ]]; then
      printf '────────\\n❯ replacement staged work\\n────────\\n'
    elif [[ -f "$state/asked" ]]; then
      printf '────────\\n❯ follow-up\\n────────\\n'
    elif [[ -f "$state/settled" ]]; then
      printf '────────\\n❯ operator staged work\\n────────\\n'
    elif [[ -f "$state/cleared" ]]; then
      printf '────────\\n❯\\n────────\\n'
    elif [[ -f "$state/follow-up-complete" || -f "$state/submitted" ]]; then
      printf '────────\\n❯\\n────────\\n'
    else
      printf '────────\\n❯ Exact Drovr work\\n────────\\n'
    fi
    ;;
  "agent send-keys")
    [[ \${3:-} == managed-agent ]]
    if [[ \${4:-} == enter ]]; then
      touch "$state/submitted"
      if [[ -f "$state/asked" ]]; then
        rm -f "$state/asked"
        touch "$state/follow-up-complete"
      fi
    elif [[ \${4:-} == esc && \${5:-} == esc ]]; then
      rm -f "$state/staged-by-command"
      rm -f "$state/replaced" "$state/settled" "$state/submitted"
      touch "$state/cleared"
    else exit 1
    fi
    printf '{"result":{"status":"sent"}}\\n'
    ;;
  "pane send-text")
    [[ \${3:-} == pane-agent-1 ]]
    printf '%s' "\${4:-}" > "$state/staged-by-command"
    printf '{"result":{"status":"sent"}}\\n'
    ;;
  "agent prompt")
    [[ -f "$state/cleared" && \${3:-} == managed-agent && \${4:-} == follow-up ]]
    touch "$state/follow-up-complete"
    printf '%s\\n' '{"type":"user","message":{"role":"user","content":"follow-up"}}' '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Follow-up result"}]}}' >> ${JSON.stringify(transcript)}
    printf '{"result":{"status":"sent"}}\\n'
    ;;
  *) printf 'unexpected fake Herdr call: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  await chmod(fakeHerdr, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    DOTFILES_ROOT: root,
    CLAUDE_CONFIG_DIR: claudeHome,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
    DROVR_STAGED_INPUT_STABILITY_INTERVAL_MS: "0",
  };
  const registryDirectory = stateDirectory(env);
  const group = {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "group",
    label: "Group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  };
  const task = {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: group.id,
    key: "task",
    label: "Task",
    cwd,
    status: "active",
  };
  const agent = {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: task.id,
    key: "reviewer",
    label: "Reviewer",
    status: "active",
    launch: {
      harness: "claude",
      model: "opus",
      effort: "medium",
      capability: "read-only",
      native: {
        permission_mode: "dontAsk",
        allowed_tools: [
          "Read",
          "Glob",
          "Grep",
          "Bash(git diff *)",
          "Bash(git status *)",
          "Bash(git log *)",
          "Bash(git show *)",
          "Bash(git rev-parse *)",
        ],
      },
    },
    herdr: { name: "managed-agent", pane_id: "pane-agent-1" },
    native_session: nativeSession,
  };
  const configuration = await loadConfiguration({ env });
  agent.launch = resolveLaunchSpecification(configuration, agent.launch);
  const compatibility = await collectProductionCompatibility({
    harness: "claude",
    env,
  });
  agent.launch_binding = createAgentLaunchBinding(
    configuration,
    agent.launch,
    { compatibility },
  );
  const turn = createTurnRecord({
    id: "turn-1",
    agentId: agent.id,
    taskId: task.id,
    prompt: "Exact Drovr work",
    submittedAt: "2026-08-02T16:00:00.000Z",
    transcriptCursor: await captureClaudeTranscriptCursor(transcript),
  });
  settleTurnRecord(turn, {
    status: "uncertain",
    error: "Herdr did not confirm Claude prompt submission for managed-agent",
    settledAt: "2026-08-02T16:00:01.000Z",
  });
  turn.staged_input = createStagedInputReceipt({
    agentName: agent.herdr.name,
    observed: {
      pane_id: agent.herdr.pane_id,
      agent_session: { value: agent.native_session },
      state_change_seq: 12,
    },
    prompt: turn.inputs[0].text,
    snapshot: {
      token: snapshotToken,
      display_text: "Exact Drovr work",
    },
  });
  turn.late_result_recovery = "exact_transcript_correlation";
  const completedTurn = createTurnRecord({
    id: "completed-turn",
    agentId: agent.id,
    taskId: task.id,
    prompt: "earlier request",
    submittedAt: "2026-08-02T15:00:00.000Z",
    transcriptCursor: await captureClaudeTranscriptCursor(transcript),
  });
  settleTurnRecord(completedTurn, {
    status: "completed",
    result: { text: "Earlier result", messages: ["Earlier result"] },
    settledAt: "2026-08-02T15:00:01.000Z",
  });
  await writeRecord(registryDirectory, "groups", group);
  await writeRecord(registryDirectory, "tasks", task);
  await writeRecord(registryDirectory, "agents", agent);
  await writeRecord(registryDirectory, "turns", completedTurn);
  await writeRecord(registryDirectory, "turns", turn);
  await writeFile(join(herdrState, "advanced"), "");

  const inspected = await runDrovr(env, ["agent", "staged-input", agent.id]);
  assert.equal(inspected.result.staged_input.ownership, "drovr");
  assert.equal(inspected.result.staged_input.turn_id, turn.id);
  assert.equal(
    inspected.result.staged_input.snapshot_token,
    bindStagedInputToken(snapshotToken, 13),
  );
  assert.equal(inspected.result.state_change_seq, 13);
  assert.equal(inspected.result.staged_input.state_change_seq, 13);
  const submitAction = inspected.result.staged_input.actions.find(
    ({ action }) => action === "submit",
  );
  assert.equal(
    submitAction.command,
    `drovr agent staged-input ${agent.id} --submit ${turn.staged_input.token}`,
  );

  const recovered = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--submit",
    submitAction.command.split(" ").at(-1),
  ]);
  assert.equal(recovered.result.status, "submitted");
  assert.equal(recovered.result.turn.id, turn.id);
  assert.equal((await readRecords(registryDirectory, "turns")).length, 2);

  await appendFile(
    transcript,
    [
      { type: "user", message: { role: "user", content: "Exact Drovr work" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Recovered result" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const projected = await runDrovr(env, ["turn", "get", turn.id]);
  assert.equal(projected.result.turn.late_result.text, "Recovered result");

  await writeFile(join(herdrState, "settled"), "");
  const blockedAsk = await runDrovr(env, [
    "ask",
    agent.id,
    "blocked-follow-up",
    "--timeout",
    "1s",
  ]);
  assert.equal(blockedAsk.result.status, "recovery_blocked");
  assert.equal(
    blockedAsk.result.details.next_command,
    `drovr agent staged-input ${agent.id}`,
  );
  assert.equal((await readRecords(registryDirectory, "turns")).length, 2);

  const unknown = await runDrovr(env, ["agent", "staged-input", agent.id]);
  assert.equal(unknown.result.staged_input.ownership, "unknown");
  assert.equal(unknown.result.state_change_seq, 14);
  const mismatched = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--clear-unknown",
    "mismatched-snapshot-token",
  ]);
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.result.status, "recovery_blocked");
  assert.equal(
    (await runDrovr(env, ["agent", "staged-input", agent.id])).result
      .staged_input.token,
    unknown.result.staged_input.token,
  );
  await writeFile(join(herdrState, "replaced"), "");
  const stale = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--clear-unknown",
    unknown.result.staged_input.token,
  ]);
  assert.equal(stale.result.status, "recovery_blocked");
  const replacement = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
  ]);
  assert.equal(
    replacement.result.staged_input.display_text,
    "replacement staged work",
  );
  const cleared = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--clear-unknown",
    replacement.result.staged_input.token,
  ]);
  assert.equal(cleared.result.status, "cleared");
  assert.equal(cleared.result.turn, undefined);

  const asked = await runDrovr(env, [
    "ask",
    agent.id,
    "follow-up",
    "--timeout",
    "1s",
  ]);
  assert.equal(asked.result.status, "completed");
  assert.equal(asked.result.turn.result.text, "Follow-up result");
  assert.equal((await readRecords(registryDirectory, "turns")).length, 3);

  const unknownPromptFile = join(scratch, "unknown-prompt.txt");
  await writeFile(unknownPromptFile, "QUALIFY-UNKNOWN-STAGED");
  const stagedByCommand = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--stage-unknown-file",
    unknownPromptFile,
  ]);
  assert.equal(stagedByCommand.result.status, "staged_input");
  assert.equal(stagedByCommand.result.staged_input.ownership, "unknown");
  assert.equal(
    stagedByCommand.result.staged_input.display_text,
    "QUALIFY-UNKNOWN-STAGED",
  );
  assert.equal((await readRecords(registryDirectory, "turns")).length, 3);
  const clearedStagedByCommand = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--clear-unknown",
    stagedByCommand.result.staged_input.token,
  ]);
  assert.equal(clearedStagedByCommand.result.status, "cleared");

  const stagedBeforeMissingTransition = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
    "--stage-unknown-file",
    unknownPromptFile,
  ]);
  assert.equal(stagedBeforeMissingTransition.result.status, "staged_input");
  assert.equal(
    stagedBeforeMissingTransition.result.staged_input.display_text,
    "QUALIFY-UNKNOWN-STAGED",
  );

  await writeFile(join(herdrState, "missing-seq"), "");
  const missingTransition = await runDrovr(env, [
    "agent",
    "staged-input",
    agent.id,
  ]);
  assert.equal(missingTransition.result.status, "staged_input");
  assert.equal(missingTransition.result.staged_input.snapshot_token, null);
  assert.equal(missingTransition.result.staged_input.token, null);
  assert.deepEqual(missingTransition.result.staged_input.actions, []);
  assert.equal(
    missingTransition.result.staged_input.reason,
    "staged snapshot lacks an exact native transition token",
  );
});

async function runDrovr(env, argv) {
  try {
    const { stdout } = await execFileAsync(drovr, argv, { env });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.stdout || error.stderr || error.message);
  }
}
