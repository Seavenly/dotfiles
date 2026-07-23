import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const drovr = fileURLToPath(new URL("../../../bin/drovr", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

async function executable(path, source) {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}`);
  await chmod(path, 0o755);
}

test("public command advertises doctor and delegate", async () => {
  const { stdout } = await execFileAsync(drovr, ["--help"], {
    encoding: "utf8",
  });

  assert.match(stdout, /drovr doctor/);
  assert.match(stdout, /drovr delegate \[options\] \[PROMPT\]/);
  assert.match(stdout, /drovr attach AGENT_ID \[--takeover\]/);
});

test("convergence installs the public command and tracked configuration", async () => {
  const mise = await readFile(join(root, "mise.toml"), "utf8");

  assert.match(mise, /"~\/\.local\/bin\/drovr" = "bin\/drovr"/u);
  assert.match(mise, /"~\/\.config\/drovr" = "config\/drovr"/u);
});

test("delegate rejects ambiguous prompt sources before touching the runtime", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-prompt-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const promptFile = join(scratch, "prompt.md");
  await writeFile(promptFile, "from file\n");

  let failure;
  try {
    await execFileAsync(
      drovr,
      [
        "delegate",
        "--task-key",
        "prompt-test",
        "--prompt-file",
        promptFile,
        "from argument",
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.code, 2);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.error.outcome, "ambiguous_prompt");
});

test("doctor reports a compatible configured Codex runtime", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-doctor-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const codexHome = join(scratch, "codex");
  const claudeHome = join(scratch, "claude");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(claudeHome, "projects"), { recursive: true });
  await executable(
    join(fakeBin, "herdr"),
    'if [[ ${1:-} == --version ]]; then echo "herdr 0.7.5"; else printf "claude: current (v7)\\ncodex: current (v6)\\n"; fi\n',
  );
  await executable(
    join(fakeBin, "codex"),
    'if [[ "$*" == *--help* ]]; then echo "--model --sandbox --ask-for-approval --search"; else echo "codex-cli 0.145.0"; fi\n',
  );
  await executable(join(fakeBin, "claude"), 'echo "2.1.0 (Claude Code)"\n');

  const { stdout } = await execFileAsync(drovr, ["doctor"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      DROVR_CONFIG_DIR: join(root, "config", "drovr"),
    },
  });
  const report = JSON.parse(stdout);

  assert.equal(report.schema, "drovr.command/v1");
  assert.equal(report.command, "doctor");
  assert.equal(report.ok, true);
  assert.equal(report.result.status, "ready");
  assert.deepEqual(report.result.defaults, {
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    capability: "on-approve",
  });
  assert.equal(
    report.result.checks.find(({ id }) => id === "codex-integration").status,
    "pass",
  );
  assert.equal(
    report.result.checks.find(({ id }) => id === "codex-native-session").status,
    "pass",
  );
});

test("delegate returns the correlated final Codex message", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-delegate-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const codexHome = join(scratch, "codex");
  const stateHome = join(scratch, "state");
  const cwd = join(scratch, "work");
  const herdrState = join(scratch, "herdr-state");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(codexHome, "sessions", "2026", "07", "23"), {
    recursive: true,
  });
  await mkdir(cwd, { recursive: true });
  const canonicalCwd = await realpath(cwd);
  await mkdir(herdrState, { recursive: true });
  const transcript = join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "23",
    "rollout-2026-07-23-codex-session-1.jsonl",
  );
  const oldTranscript = join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "23",
    "rollout-2026-07-23-old-session.jsonl",
  );
  await writeFile(
    oldTranscript,
    `${[
      {
        type: "session_meta",
        payload: { id: "old-session", cwd: canonicalCwd },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "STALE" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  await executable(
    join(fakeBin, "herdr"),
    `herdrState=${JSON.stringify(herdrState)}
transcript=${JSON.stringify(transcript)}
taskCwd=${JSON.stringify(canonicalCwd)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  if [[ -f "$herdrState/running" ]]; then running=true; else running=false; fi
  printf '{"sessions":[{"name":"delegates","running":%s}]}\\n' "$running"
  exit
fi
if [[ $# -eq 2 && \${1:-} == --session ]]; then
  touch "$herdrState/running"
  exit 1
fi
if [[ \${1:-} != --session ]]; then
  touch "$herdrState/running"
  exit 1
fi
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\\n'
    ;;
  "pane process-info")
    if [[ -f "$herdrState/shell-polled" ]]; then
      touch "$herdrState/shell-ready"
      printf '{"result":{"process_info":{"shell_pid":10,"foreground_processes":[{"pid":10,"name":"zsh"}]}}}\\n'
    else
      touch "$herdrState/shell-polled"
      printf '{"result":{"process_info":{"shell_pid":10,"foreground_processes":[{"pid":11,"name":"startup"}]}}}\\n'
    fi
    ;;
  "pane get")
    printf '{"result":{"pane":{"pane_id":"pane-1","tab_id":"tab-1"}}}\\n'
    ;;
  "tab rename")
    printf '%s\\n' "\${4}" > "$herdrState/tab-label"
    ;;
  "pane rename") ;;
  "agent start")
    [[ -f "$herdrState/shell-ready" ]] || {
      printf 'agent target pane is not an available shell\\n' >&2
      exit 1
    }
    [[ $(<"$herdrState/tab-label") == feature-123 ]] || {
      printf 'task tab was not labeled\\n' >&2
      exit 1
    }
    name=\${3}
    [[ $name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || {
      printf 'invalid agent name: %s\\n' "$name" >&2
      exit 1
    }
    printf '%s\\n' "$*" > "$herdrState/start-args"
    touch "$herdrState/agent"
    printf '{"result":{"agent":{"name":"managed"}}}\\n'
    ;;
  "agent list")
    if [[ -f "$herdrState/agent" ]]; then
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      if [[ -f "$herdrState/blocked" ]]; then status=blocked; else status=idle; fi
      if [[ -f "$herdrState/prompted" ]]; then
        session=',"agent_session":{"value":"codex-session-1"}'
      else
        session=''
      fi
      printf '{"result":{"agents":[{"name":"%s","agent_status":"%s"%s}]}}\\n' "$name" "$status" "$session"
    else
      printf '{"result":{"agents":[]}}\\n'
    fi
    ;;
  "agent prompt")
    [[ " $* " == *" --wait "* ]] || {
      printf 'prompt must wait for a post-submission transition\\n' >&2
      exit 1
    }
    prompt=\${4}
    touch "$herdrState/prompted"
    if [[ ! -f "$transcript" ]]; then
      jq -nc --arg cwd "$taskCwd" '{timestamp:(now | todate),type:"session_meta",payload:{id:"codex-session-1",cwd:$cwd}}' >> "$transcript"
    fi
    jq -nc --arg prompt "$prompt" '{type:"event_msg",payload:{type:"user_message",message:$prompt}}' >> "$transcript"
    if [[ $prompt == BLOCK ]]; then
      touch "$herdrState/blocked"
    else
      jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"DELEGATED"}]}}' >> "$transcript"
    fi
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  "agent read")
    printf 'Permission approval required\\n'
    ;;
  "agent wait")
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  *) printf 'unsupported fake herdr call: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );

  let execution;
  try {
    execution = await execFileAsync(
      drovr,
      [
        "delegate",
        "--task-key",
        "feature-123",
        "--agent-key",
        "builder",
        "--cwd",
        cwd,
        "Reply with exactly DELEGATED",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CODEX_HOME: codexHome,
          XDG_STATE_HOME: stateHome,
          DROVR_CONFIG_DIR: join(root, "config", "drovr"),
        },
      },
    );
  } catch (error) {
    assert.fail(
      `${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
  const report = JSON.parse(execution.stdout);

  assert.equal(report.schema, "drovr.command/v1");
  assert.equal(report.command, "delegate");
  assert.equal(report.ok, true);
  assert.equal(report.result.status, "completed");
  assert.equal(report.result.task.key, "feature-123");
  assert.equal(report.result.agent.key, "builder");
  assert.equal(report.result.agent.capability, "on-approve");
  assert.equal(report.result.turn.result.text, "DELEGATED");
  assert.match(report.result.turn.id, /^[0-9a-f-]{36}$/u);
  const startArgs = await readFile(join(herdrState, "start-args"), "utf8");
  assert.match(startArgs, /--kind codex/);
  assert.match(startArgs, /--sandbox read-only/);
  assert.match(startArgs, /--ask-for-approval on-request/);

  const blockedExecution = await execFileAsync(
    drovr,
    [
      "delegate",
      "--task-key",
      "feature-123",
      "--agent-key",
      "builder",
      "--cwd",
      cwd,
      "BLOCK",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CODEX_HOME: codexHome,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
      },
    },
  );
  const blocked = JSON.parse(blockedExecution.stdout);
  assert.equal(blocked.result.status, "needs_input");
  assert.equal(blocked.result.turn.status, "working");
  assert.match(blocked.result.block.id, /^[0-9a-f-]{36}$/u);
  assert.equal(blocked.result.block.excerpt, "Permission approval required\n");
  assert.equal(
    blocked.result.block.attach.command,
    `drovr attach ${blocked.result.agent.id}`,
  );
});

test("delegate returns the correlated final Claude Code message", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-delegate-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const claudeHome = join(scratch, "claude");
  const stateHome = join(scratch, "state");
  const cwd = join(scratch, "work");
  const herdrState = join(scratch, "herdr-state");
  const nativeSession = "11111111-2222-4333-8444-555555555555";
  await mkdir(fakeBin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const canonicalCwd = await realpath(cwd);
  await mkdir(herdrState, { recursive: true });
  await executable(
    join(fakeBin, "claude"),
    `touch ${JSON.stringify(join(herdrState, "claude-validated"))}
printf '%s\n' '--model --effort --permission-mode manual dontAsk acceptEdits auto bypassPermissions --allowedTools --append-system-prompt --allow-dangerously-skip-permissions'
`,
  );
  const transcriptDirectory = join(claudeHome, "projects", "-test-work");
  await mkdir(transcriptDirectory, { recursive: true });
  const transcript = join(transcriptDirectory, `${nativeSession}.jsonl`);
  const oldTranscript = join(transcriptDirectory, "old-session.jsonl");
  await writeFile(
    oldTranscript,
    `${[
      {
        type: "user",
        sessionId: "old-session",
        cwd: canonicalCwd,
        message: { role: "user", content: "old request" },
      },
      {
        type: "assistant",
        sessionId: "old-session",
        cwd: canonicalCwd,
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "STALE" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  await executable(
    join(fakeBin, "herdr"),
    `herdrState=${JSON.stringify(herdrState)}
transcript=${JSON.stringify(transcript)}
taskCwd=${JSON.stringify(canonicalCwd)}
nativeSession=${JSON.stringify(nativeSession)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\\n'
  exit
fi
[[ \${1:-} == --session ]] || exit 1
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\\n'
    ;;
  "pane get")
    printf '{"result":{"pane":{"pane_id":"pane-1","tab_id":"tab-1"}}}\\n'
    ;;
  "tab rename"|"pane rename") ;;
  "pane process-info")
    printf '{"result":{"process_info":{"shell_pid":10,"foreground_processes":[{"pid":10,"name":"zsh"}]}}}\\n'
    ;;
  "agent start")
    printf '%s\\n' "$*" > "$herdrState/start-args"
    touch "$herdrState/agent"
    printf '{"result":{"agent":{"name":"managed"}}}\\n'
    ;;
  "agent list")
    if [[ -f "$herdrState/agent" ]]; then
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      printf '{"result":{"agents":[{"name":"%s","agent_status":"idle","agent_session":{"value":"%s"}}]}}\\n' "$name" "$nativeSession"
    else
      printf '{"result":{"agents":[]}}\\n'
    fi
    ;;
  "agent prompt")
    prompt=\${4}
    jq -nc --arg prompt "$prompt" --arg session "$nativeSession" --arg cwd "$taskCwd" '{type:"user",sessionId:$session,cwd:$cwd,message:{role:"user",content:$prompt}}' >> "$transcript"
    jq -nc --arg session "$nativeSession" --arg cwd "$taskCwd" '{type:"assistant",sessionId:$session,cwd:$cwd,message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:"CLAUDE DELEGATED"}]}}' >> "$transcript"
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  *) printf 'unsupported fake herdr call: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );

  const { stdout } = await execFileAsync(
    drovr,
    [
      "delegate",
      "--task-key",
      "claude-feature",
      "--agent-key",
      "builder",
      "--cwd",
      cwd,
      "--harness",
      "claude",
      "--capability",
      "read-only",
      "Reply with exactly CLAUDE DELEGATED",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CLAUDE_CONFIG_DIR: claudeHome,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
      },
    },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.schema, "drovr.command/v1");
  assert.equal(report.command, "delegate");
  assert.equal(report.ok, true);
  assert.equal(report.result.status, "completed");
  assert.equal(report.result.agent.harness, "claude");
  assert.equal(report.result.agent.model, "sonnet");
  assert.equal(report.result.agent.effort, "high");
  assert.equal(report.result.agent.capability, "read-only");
  assert.equal(report.result.turn.result.text, "CLAUDE DELEGATED");
  const startArgs = await readFile(join(herdrState, "start-args"), "utf8");
  assert.match(startArgs, /--kind claude/);
  assert.match(startArgs, /--model sonnet/);
  assert.match(startArgs, /--effort high/);
  assert.match(startArgs, /--permission-mode dontAsk/);
  assert.doesNotMatch(startArgs, /--allowedTools Read,Glob,Grep,Bash(?:\s|$)/u);
  assert.match(startArgs, /Bash\(git diff \*\)/u);
  await readFile(join(herdrState, "claude-validated"));
});
