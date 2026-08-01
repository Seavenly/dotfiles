import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
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

test("public command advertises durable turn commands", async () => {
  const { stdout } = await execFileAsync(drovr, ["--help"], {
    encoding: "utf8",
    env: { ...process.env, DOTFILES_ROOT: root },
  });

  assert.match(stdout, /drovr doctor/);
  assert.match(stdout, /drovr delegate \[options\] \[PROMPT\]/);
  assert.match(stdout, /drovr ask AGENT_ID \[options\] \[PROMPT\]/);
  assert.match(stdout, /drovr turn start AGENT_ID \[options\] \[PROMPT\]/);
  assert.match(stdout, /drovr turn dispatch AGENT_ID/);
  assert.match(stdout, /drovr turn discover CALLER_KEY/);
  assert.match(stdout, /drovr turn send TURN_ID \[options\] \[PROMPT\]/);
  assert.match(
    stdout,
    /drovr turn wait TURN_ID \[--after-block BLOCK_ID\] \[--timeout DURATION\]/,
  );
  assert.match(stdout, /drovr turn get TURN_ID \[--include-messages\]/);
  assert.match(stdout, /drovr turn list \[filters\]/);
  assert.match(stdout, /drovr turn cancel TURN_ID/);
  assert.match(stdout, /drovr task open \[options\]/);
  assert.match(stdout, /drovr agent start TASK_ID \[options\]/);
  assert.match(stdout, /drovr agent retire AGENT_ID/);
  assert.match(stdout, /drovr task close TASK_ID/);
  assert.match(stdout, /drovr attach AGENT_ID \[--takeover\]/);
  assert.match(stdout, /drovr describe \[launch options\] --caller-metadata JSON/);
});

test("public describe command returns an exact launch without initializing state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-describe-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stateHome = join(scratch, "state");

  const { stdout } = await execFileAsync(
    drovr,
    [
      "describe",
      "--harness",
      "codex",
      "--capability",
      "read-only",
      "--caller-metadata",
      '{"run_id":"run:example"}',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DOTFILES_ROOT: root,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
        XDG_STATE_HOME: stateHome,
      },
    },
  );

  const report = JSON.parse(stdout);
  assert.equal(report.schema, "drovr.command/v1");
  assert.equal(report.command, "describe");
  assert.equal(report.ok, true);
  assert.equal(report.result.schema, "drovr.delegated-agent-description/v1");
  assert.equal(report.result.launch.harness, "codex");
  assert.deepEqual(report.result.caller_metadata, { run_id: "run:example" });
  await assert.rejects(stat(join(stateHome, "drovr")), { code: "ENOENT" });
});

test("public caller discovery proves absence without initializing state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-discover-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stateHome = join(scratch, "state");

  const { stdout } = await execFileAsync(
    drovr,
    ["turn", "discover", "run:1/card:review/attempt:1"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DOTFILES_ROOT: root,
        XDG_STATE_HOME: stateHome,
      },
    },
  );

  const report = JSON.parse(stdout);
  assert.equal(report.command, "turn discover");
  assert.equal(report.result.status, "proven_absent");
  assert.equal(
    report.result.authority_watermark.authority,
    "drovr.registry",
  );
  assert.match(
    report.result.authority_watermark.turns_sha256,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(report.result.legal_next_actions, [
    "dispatch_with_same_caller_key",
  ]);
  await assert.rejects(stat(join(stateHome, "drovr")), { code: "ENOENT" });
});

test("describe help documents its non-mutating contract arguments", async () => {
  const { stdout, stderr } = await execFileAsync(
    drovr,
    ["describe", "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, DOTFILES_ROOT: root },
    },
  );

  assert.equal(stderr, "");
  assert.match(
    stdout,
    /^Usage:\n  drovr describe \[launch options\] --caller-metadata JSON/u,
  );
  assert.match(stdout, /--caller-metadata JSON/u);
  assert.match(stdout, /--capability CAPABILITY/u);
});

test("delegate help documents options without initializing state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-delegate-help-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(drovr, ["delegate", "--help"], {
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: join(scratch, "state") },
  });

  assert.match(stdout, /^Usage:\n  drovr delegate \[options\] \[PROMPT\]/u);
  assert.match(stdout, /--task-key KEY/u);
  assert.match(stdout, /--capability CAPABILITY/u);
  assert.match(stdout, /--timeout DURATION/u);
  await assert.rejects(stat(join(scratch, "state", "drovr")), {
    code: "ENOENT",
  });
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

test("delegate rejects a prompt file that holds only trailing whitespace", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-blank-prompt-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const promptFile = join(scratch, "prompt.md");
  await writeFile(promptFile, "\n\n");

  let failure;
  try {
    await execFileAsync(
      drovr,
      ["delegate", "--task-key", "prompt-test", "--prompt-file", promptFile],
      { encoding: "utf8" },
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.code, 2);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.error.outcome, "missing_prompt");
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
  const driftConfig = join(scratch, "drift-config");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(codexHome, "sessions", "2026", "07", "23"), {
    recursive: true,
  });
  await mkdir(cwd, { recursive: true });
  const canonicalCwd = await realpath(cwd);
  await mkdir(herdrState, { recursive: true });
  await mkdir(driftConfig, { recursive: true });
  await cp(
    join(root, "config", "drovr", "capabilities"),
    join(driftConfig, "capabilities"),
    { recursive: true },
  );
  await writeFile(
    join(driftConfig, "config.toml"),
    [
      'schema = "drovr.config/v1"',
      'session = "drifted-session"',
      "",
      "[defaults]",
      'harness = "codex"',
      'model = "gpt-5.6-sol"',
      'effort = "high"',
      'capability = "on-approve"',
      "",
    ].join("\n"),
  );
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
[[ \${2:-} == delegates ]] || {
  printf 'unexpected Herdr session: %s\\n' "\${2:-}" >&2
  exit 1
}
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\\n'
    ;;
  "pane process-info")
    if [[ ! -f "$herdrState/pane-discovered" ]]; then
      touch "$herdrState/pane-discovered"
      printf '{"error":{"code":"pane_not_found","message":"pane not found"}}\\n' >&2
      exit 1
    elif [[ -f "$herdrState/shell-polled" ]]; then
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
    if [[ ! -f "$herdrState/agent-start-retried" ]]; then
      touch "$herdrState/agent-start-retried"
      printf '{"error":{"code":"agent_pane_busy","message":"agent target pane is not an available shell"}}\\n' >&2
      exit 1
    fi
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
      if [[ ! -f "$herdrState/agent-registration-polled" ]]; then
        touch "$herdrState/agent-registration-polled"
        printf '{"result":{"agents":[]}}\\n'
        exit
      fi
      touch "$herdrState/agent-registration-ready"
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      stateChangeSeq=2
      if [[ -f "$herdrState/state-change-seq" ]]; then
        stateChangeSeq=$(<"$herdrState/state-change-seq")
      fi
      if [[ -f "$herdrState/out-of-band-working" ]]; then
        status=working
      elif [[ ! -f "$herdrState/startup-settled" && ! -f "$herdrState/prompted" ]]; then
        status=working
      elif [[ -f "$herdrState/blocked" ]]; then
        if [[ -f "$herdrState/resume-block" ]]; then
          status=idle
          stateChangeSeq=$((stateChangeSeq + 2))
        else
          status=blocked
        fi
      elif [[ -f "$herdrState/steering" && ! -f "$herdrState/steering-settled" ]]; then
        status=working
      else
        status=idle
      fi
      if [[ -f "$herdrState/prompted" ]]; then
        session=',"agent_session":{"value":"codex-session-1"}'
      else
        session=''
      fi
      printf '{"result":{"agents":[{"name":"%s","agent_status":"%s","state_change_seq":%s%s}]}}\\n' "$name" "$status" "$stateChangeSeq" "$session"
    else
      printf '{"result":{"agents":[]}}\\n'
    fi
    ;;
  "agent prompt")
    [[ -f "$herdrState/agent-registration-ready" ]] || {
      printf '{"error":{"code":"agent_not_found","message":"agent target not found"}}\\n' >&2
      exit 1
    }
    [[ -f "$herdrState/startup-settled" ]] || {
      printf '{"error":{"code":"agent_starting","message":"agent target is still starting"}}\\n' >&2
      exit 1
    }
    prompt=\${4}
    printf '%s\\n' "$*" > "$herdrState/prompt-args"
    touch "$herdrState/prompted"
    stateChangeSeq=2
    if [[ -f "$herdrState/state-change-seq" ]]; then
      stateChangeSeq=$(<"$herdrState/state-change-seq")
    fi
    printf '%s' $((stateChangeSeq + 2)) > "$herdrState/state-change-seq"
    if [[ ! -f "$transcript" ]]; then
      jq -nc --arg cwd "$taskCwd" '{timestamp:(now | todate),type:"session_meta",payload:{id:"codex-session-1",cwd:$cwd}}' >> "$transcript"
    fi
    jq -nc --arg prompt "$prompt" '{type:"event_msg",payload:{type:"user_message",message:$prompt}}' >> "$transcript"
    if [[ $prompt == BLOCK ]]; then
      touch "$herdrState/blocked"
    elif [[ $prompt == "Begin a steerable turn" ]]; then
      touch "$herdrState/steering"
      jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"INTERMEDIATE"}]}}' >> "$transcript"
    elif [[ -f "$herdrState/steering" && ! -f "$herdrState/steering-settled" ]]; then
      :
    else
      if [[ $prompt == "Reply with exactly ASKED" ]]; then result=ASKED; else result=DELEGATED; fi
      jq -nc --arg result "$result" '{type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:$result}]}}' >> "$transcript"
    fi
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  "agent read")
    printf 'Permission approval required\\n'
    ;;
  "agent wait")
    if [[ ! -f "$herdrState/startup-settled" && ! -f "$herdrState/prompted" ]]; then
      touch "$herdrState/startup-settled"
      printf '{"result":{"status":"idle"}}\\n'
      exit
    fi
    if [[ " $* " == *" --timeout 1 "* ]]; then
      printf '{"code":"timeout"}\\n' >&2
      exit 1
    fi
    if [[ -f "$herdrState/blocked" && ! -f "$herdrState/resume-block" ]]; then
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      stateChangeSeq=2
      if [[ -f "$herdrState/state-change-seq" ]]; then
        stateChangeSeq=$(<"$herdrState/state-change-seq")
      fi
      printf '{"result":{"type":"agent_info","agent":{"name":"%s","agent_status":"blocked","state_change_seq":%s,"agent_session":{"value":"codex-session-1"}}}}\\n' "$name" "$stateChangeSeq"
      exit
    fi
    if [[ -f "$herdrState/resume-block" && ! -f "$herdrState/block-result" ]]; then
      jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"NATIVE AFTER BLOCK"}]}}' >> "$transcript"
      touch "$herdrState/block-result"
    fi
    if [[ -f "$herdrState/steering" && ! -f "$herdrState/steering-settled" ]]; then
      jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"NATIVE STEERED"}]}}' >> "$transcript"
      touch "$herdrState/steering-settled"
    fi
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
  const promptArgs = await readFile(join(herdrState, "prompt-args"), "utf8");
  assert.doesNotMatch(promptArgs, /--wait/u);

  let askedExecution;
  try {
    askedExecution = await execFileAsync(
      drovr,
      ["ask", report.result.agent.id, "Reply with exactly ASKED"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CODEX_HOME: codexHome,
          XDG_STATE_HOME: stateHome,
          DROVR_CONFIG_DIR: driftConfig,
        },
      },
    );
  } catch (error) {
    assert.fail(
      `${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
  const asked = JSON.parse(askedExecution.stdout);
  assert.equal(asked.schema, "drovr.command/v1");
  assert.equal(asked.command, "ask");
  assert.equal(asked.result.status, "completed");
  assert.equal(asked.result.agent.id, report.result.agent.id);
  assert.notEqual(asked.result.turn.id, report.result.turn.id);
  assert.equal(asked.result.turn.result.text, "ASKED");

  await writeFile(join(herdrState, "out-of-band-working"), "");
  const { stdout: busyOutput } = await execFileAsync(
    drovr,
    ["ask", report.result.agent.id, "Do not deliver this"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CODEX_HOME: codexHome,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: driftConfig,
      },
    },
  );
  const busy = JSON.parse(busyOutput);
  assert.equal(busy.ok, true);
  assert.equal(busy.result.status, "task_busy");
  await rm(join(herdrState, "out-of-band-working"));

  const { stdout: fetchedOutput } = await execFileAsync(
    drovr,
    ["turn", "get", asked.result.turn.id],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
      },
    },
  );
  const fetched = JSON.parse(fetchedOutput);
  assert.equal(fetched.command, "turn get");
  assert.equal(fetched.result.turn.result.text, "ASKED");
  assert.equal(fetched.result.turn.result.messages, undefined);

  const { stdout: listedOutput } = await execFileAsync(
    drovr,
    ["turn", "list", "--agent", report.result.agent.id],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
      },
    },
  );
  const listed = JSON.parse(listedOutput);
  assert.equal(listed.command, "turn list");
  assert.deepEqual(
    listed.result.turns.map(({ id }) => id).sort(),
    [report.result.turn.id, asked.result.turn.id].sort(),
  );

  const { stdout: startedOutput } = await execFileAsync(
    drovr,
    ["turn", "start", report.result.agent.id, "Begin a steerable turn"],
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
  const started = JSON.parse(startedOutput);
  assert.equal(started.command, "turn start");
  assert.equal(started.result.status, "working");
  const startedPromptArgs = await readFile(
    join(herdrState, "prompt-args"),
    "utf8",
  );
  assert.doesNotMatch(startedPromptArgs, /--wait/u);

  const { stdout: timedOutput } = await execFileAsync(
    drovr,
    ["turn", "wait", started.result.turn.id, "--timeout", "1ms"],
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
  const timed = JSON.parse(timedOutput);
  assert.equal(timed.result.status, "still_running");
  assert.equal(timed.result.turn.status, "working");

  for (const [prompt, expectedCount] of [
    ["Prioritize correctness", 2],
    ["Then keep the answer concise", 3],
  ]) {
    const { stdout: sentOutput } = await execFileAsync(
      drovr,
      ["turn", "send", started.result.turn.id, prompt],
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
    const sent = JSON.parse(sentOutput);
    assert.equal(sent.command, "turn send");
    assert.equal(sent.result.status, "working");
    assert.equal(sent.result.turn.input_count, expectedCount);
    const steeringPromptArgs = await readFile(
      join(herdrState, "prompt-args"),
      "utf8",
    );
    assert.doesNotMatch(steeringPromptArgs, /--wait/u);
  }

  const { stdout: waitedOutput } = await execFileAsync(
    drovr,
    ["turn", "wait", started.result.turn.id, "--timeout", "5s"],
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
  const waited = JSON.parse(waitedOutput);
  assert.equal(waited.command, "turn wait");
  assert.equal(waited.result.status, "completed");
  assert.equal(waited.result.turn.result.text, "NATIVE STEERED");
  assert.deepEqual(waited.result.turn.result.messages, [
    "INTERMEDIATE",
    "NATIVE STEERED",
  ]);

  const { stdout: lateSendOutput } = await execFileAsync(
    drovr,
    ["turn", "send", started.result.turn.id, "Too late"],
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
  const lateSend = JSON.parse(lateSendOutput);
  assert.equal(lateSend.command, "turn send");
  assert.equal(lateSend.result.status, "turn_closed");
  assert.equal(lateSend.result.turn.id, started.result.turn.id);

  const { stdout: steeringFetchedOutput } = await execFileAsync(
    drovr,
    ["turn", "get", started.result.turn.id, "--include-messages"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        DROVR_CONFIG_DIR: join(root, "config", "drovr"),
      },
    },
  );
  const steeringFetched = JSON.parse(steeringFetchedOutput);
  assert.equal(steeringFetched.result.turn.input_count, 3);
  assert.deepEqual(steeringFetched.result.turn.result.messages, [
    "INTERMEDIATE",
    "NATIVE STEERED",
  ]);

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

  const { stdout: repeatedBlockedOutput } = await execFileAsync(
    drovr,
    ["turn", "wait", blocked.result.turn.id, "--timeout", "5s"],
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
  const repeatedBlocked = JSON.parse(repeatedBlockedOutput);
  assert.equal(repeatedBlocked.result.status, "needs_input");
  assert.equal(repeatedBlocked.result.block.id, blocked.result.block.id);

  await writeFile(join(herdrState, "resume-block"), "");
  await appendFile(
    transcript,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "NATIVE AFTER BLOCK" }],
      },
    })}\n`,
  );
  await writeFile(join(herdrState, "block-result"), "");
  const { stdout: resumedOutput } = await execFileAsync(
    drovr,
    [
      "turn",
      "wait",
      blocked.result.turn.id,
      "--after-block",
      blocked.result.block.id,
      "--timeout",
      "5s",
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
  const resumed = JSON.parse(resumedOutput);
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.result.turn.result.text, "NATIVE AFTER BLOCK");
  assert.notEqual(
    resumed.result.turn.result.text,
    blocked.result.block.excerpt.trim(),
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
      stateChangeSeq=2
      if [[ -f "$herdrState/state-change-seq" ]]; then
        stateChangeSeq=$(<"$herdrState/state-change-seq")
      fi
      if [[ -f "$herdrState/blocked" ]]; then
        if [[ -f "$herdrState/resume-block" ]]; then
          status=idle
          stateChangeSeq=$((stateChangeSeq + 2))
        else
          status=blocked
        fi
      else
        status=idle
      fi
      printf '{"result":{"agents":[{"name":"%s","agent_status":"%s","state_change_seq":%s,"agent_session":{"value":"%s"}}]}}\\n' "$name" "$status" "$stateChangeSeq" "$nativeSession"
    else
      printf '{"result":{"agents":[]}}\\n'
    fi
    ;;
  "agent prompt")
    prompt=\${4}
    stateChangeSeq=2
    if [[ -f "$herdrState/state-change-seq" ]]; then
      stateChangeSeq=$(<"$herdrState/state-change-seq")
    fi
    printf '%s' $((stateChangeSeq + 2)) > "$herdrState/state-change-seq"
    if [[ $prompt == "Reply with exactly CLAUDE ASKED" ]]; then result="CLAUDE ASKED"; else result="CLAUDE DELEGATED"; fi
    if [[ ! -f "$herdrState/initial-transcript-delivered" ]]; then
      jq -nc --arg session "$nativeSession" '{type:"mode",sessionId:$session}' >> "$transcript"
      printf '%s' "$prompt" > "$herdrState/pending-prompt"
      printf '%s' "$result" > "$herdrState/pending-result"
    else
      jq -nc --arg prompt "$prompt" --arg session "$nativeSession" --arg cwd "$taskCwd" '{type:"user",sessionId:$session,cwd:$cwd,message:{role:"user",content:$prompt}}' >> "$transcript"
      if [[ $prompt == "BLOCK CLAUDE" ]]; then
        touch "$herdrState/blocked"
      else
        jq -nc --arg session "$nativeSession" --arg cwd "$taskCwd" --arg result "$result" '{type:"assistant",sessionId:$session,cwd:$cwd,message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:$result}]}}' >> "$transcript"
      fi
    fi
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  "agent wait")
    if [[ -f "$herdrState/pending-prompt" && ! -f "$herdrState/initial-transcript-delivered" ]]; then
      if [[ ! -f "$herdrState/stale-idle-observed" ]]; then
        touch "$herdrState/stale-idle-observed"
        printf '{"result":{"status":"idle"}}\\n'
        exit
      fi
      prompt=$(<"$herdrState/pending-prompt")
      result=$(<"$herdrState/pending-result")
      jq -nc --arg prompt "$prompt" --arg session "$nativeSession" --arg cwd "$taskCwd" '{type:"user",sessionId:$session,cwd:$cwd,message:{role:"user",content:$prompt}}' >> "$transcript"
      jq -nc --arg session "$nativeSession" --arg cwd "$taskCwd" --arg result "$result" '{type:"assistant",sessionId:$session,cwd:$cwd,message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:$result}]}}' >> "$transcript"
      touch "$herdrState/initial-transcript-delivered"
    fi
    if [[ -f "$herdrState/blocked" && ! -f "$herdrState/resume-block" ]]; then
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      stateChangeSeq=2
      if [[ -f "$herdrState/state-change-seq" ]]; then
        stateChangeSeq=$(<"$herdrState/state-change-seq")
      fi
      printf '{"result":{"type":"agent_info","agent":{"name":"%s","agent_status":"blocked","state_change_seq":%s,"agent_session":{"value":"%s"}}}}\\n' "$name" "$stateChangeSeq" "$nativeSession"
      exit
    fi
    if [[ -f "$herdrState/resume-block" && ! -f "$herdrState/block-result" ]]; then
      jq -nc --arg session "$nativeSession" --arg cwd "$taskCwd" '{type:"assistant",sessionId:$session,cwd:$cwd,message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:"CLAUDE NATIVE AFTER BLOCK"}]}}' >> "$transcript"
      touch "$herdrState/block-result"
    fi
    printf '{"result":{"status":"idle"}}\\n'
    ;;
  "agent read")
    printf 'Claude approval required\\n'
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

  const { stdout: askedOutput } = await execFileAsync(
    drovr,
    ["ask", report.result.agent.id, "Reply with exactly CLAUDE ASKED"],
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
  const asked = JSON.parse(askedOutput);
  assert.equal(asked.command, "ask");
  assert.equal(asked.result.status, "completed");
  assert.equal(asked.result.agent.harness, "claude");
  assert.equal(asked.result.turn.result.text, "CLAUDE ASKED");

  const { stdout: blockedOutput } = await execFileAsync(
    drovr,
    ["ask", report.result.agent.id, "BLOCK CLAUDE"],
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
  const blocked = JSON.parse(blockedOutput);
  assert.equal(blocked.command, "ask");
  assert.equal(blocked.result.status, "needs_input");
  assert.equal(blocked.result.block.harness, "claude");
  assert.equal(blocked.result.block.turn_id, blocked.result.turn.id);
  assert.equal(blocked.result.block.agent_id, blocked.result.agent.id);
  assert.equal(blocked.result.block.task_id, blocked.result.task.id);
  assert.equal(blocked.result.block.excerpt, "Claude approval required\n");
  assert.equal(
    blocked.result.block.attach.command,
    `drovr attach ${blocked.result.agent.id}`,
  );

  await writeFile(join(herdrState, "resume-block"), "");
  await appendFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      sessionId: nativeSession,
      cwd: canonicalCwd,
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "CLAUDE NATIVE AFTER BLOCK" }],
      },
    })}\n`,
  );
  await writeFile(join(herdrState, "block-result"), "");
  const { stdout: resumedOutput } = await execFileAsync(
    drovr,
    [
      "turn",
      "wait",
      blocked.result.turn.id,
      "--after-block",
      blocked.result.block.id,
      "--timeout",
      "5s",
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
  const resumed = JSON.parse(resumedOutput);
  assert.equal(resumed.result.status, "completed");
  assert.equal(
    resumed.result.turn.result.text,
    "CLAUDE NATIVE AFTER BLOCK",
  );
  assert.notEqual(
    resumed.result.turn.result.text,
    blocked.result.block.excerpt.trim(),
  );
});
