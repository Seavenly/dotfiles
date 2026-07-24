import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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

test("task open creates an explicit task idempotently through the public CLI", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-task-open-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const stateHome = join(scratch, "state");
  const cwd = join(scratch, "work");
  const otherCwd = join(scratch, "other-work");
  const calls = join(scratch, "herdr-calls");
  const tabClosed = join(scratch, "tab-closed");
  const workspaceClosed = join(scratch, "workspace-closed");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(cwd);
  await mkdir(otherCwd);
  await executable(
    join(fakeBin, "herdr"),
    `printf '%s\n' "$*" >> ${JSON.stringify(calls)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\n'
  exit
fi
[[ \${1:-} == --session && \${2:-} == delegates ]] || exit 1
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\n'
    ;;
  "pane get")
    printf '{"result":{"pane":{"pane_id":"pane-1","tab_id":"tab-1"}}}\n'
    ;;
  "tab get")
    if [[ -f ${JSON.stringify(tabClosed)} ]]; then
      printf '{"error":{"code":"tab_not_found","message":"tab not found"}}\n' >&2
      exit 1
    fi
    printf '{"result":{"tab":{"tab_id":"tab-1"}}}\n'
    ;;
  "tab close") touch ${JSON.stringify(tabClosed)} ;;
  "workspace get")
    if [[ -f ${JSON.stringify(workspaceClosed)} ]]; then
      printf '{"error":{"code":"workspace_not_found","message":"workspace not found"}}\n' >&2
      exit 1
    fi
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"}}}\n'
    ;;
  "workspace close") touch ${JSON.stringify(workspaceClosed)} ;;
  "workspace rename"|"tab rename") ;;
  *) printf 'unsupported fake herdr call: %s\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const argv = [
    "task",
    "open",
    "--group",
    "work/EPIC-123",
    "--group-label",
    "Authentication overhaul",
    "--key",
    "FEATURE-456",
    "--label",
    "Add passkey login",
    "--cwd",
    cwd,
  ];

  let firstExecution;
  try {
    firstExecution = await execFileAsync(drovr, argv, {
      encoding: "utf8",
      env,
    });
  } catch (error) {
    assert.fail(
      `${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
  const first = JSON.parse(firstExecution.stdout);
  const repeated = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );

  assert.equal(first.schema, "drovr.command/v1");
  assert.equal(first.command, "task open");
  assert.equal(first.ok, true);
  assert.equal(first.result.status, "completed");
  assert.deepEqual(first.result.group, {
    id: first.result.group.id,
    key: "work/EPIC-123",
    label: "Authentication overhaul",
    inferred: false,
  });
  assert.deepEqual(first.result.task, {
    id: first.result.task.id,
    group_id: first.result.group.id,
    key: "FEATURE-456",
    label: "Add passkey login",
    cwd: await import("node:fs/promises").then(({ realpath }) => realpath(cwd)),
  });
  assert.equal(repeated.result.group.id, first.result.group.id);
  assert.equal(repeated.result.task.id, first.result.task.id);
  const relabeledArgv = argv
    .with(argv.indexOf("Authentication overhaul"), "Identity program")
    .with(argv.indexOf("Add passkey login"), "Passkey delivery");
  const relabeled = JSON.parse(
    (
      await execFileAsync(drovr, relabeledArgv, {
        encoding: "utf8",
        env,
      })
    ).stdout,
  );
  assert.equal(relabeled.result.group.id, first.result.group.id);
  assert.equal(relabeled.result.group.label, "Identity program");
  assert.equal(relabeled.result.task.id, first.result.task.id);
  assert.equal(relabeled.result.task.label, "Passkey delivery");
  const conflicting = JSON.parse(
    (
      await execFileAsync(
        drovr,
        [
          "task",
          "open",
          "--group",
          "work/EPIC-123",
          "--group-label",
          "Must not be applied",
          "--key",
          "FEATURE-456",
          "--cwd",
          otherCwd,
        ],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(conflicting.result.status, "configuration_conflict");
  const unchangedGroup = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["group", "get", first.result.group.id],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(unchangedGroup.result.group.label, "Identity program");
  const closed = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["task", "close", first.result.task.id],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(closed.result.status, "closed");
  const reopened = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );
  assert.equal(reopened.result.status, "task_closed");
  const groupClosed = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["group", "close", first.result.group.id],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(groupClosed.result.status, "closed");
  const groupReplacement = JSON.parse(
    (
      await execFileAsync(
        drovr,
        [
          "task",
          "open",
          "--group",
          "work/EPIC-123",
          "--key",
          "FEATURE-789",
          "--cwd",
          cwd,
        ],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(groupReplacement.result.status, "configuration_conflict");
  const herdrCalls = (await readFile(calls, "utf8")).trim().split("\n");
  assert.equal(
    herdrCalls.filter((call) => call.includes("workspace create")).length,
    1,
  );
});

test("task open derives a stable standalone group from a non-Git cwd", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-task-inferred-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const stateHome = join(scratch, "state");
  const cwd = join(scratch, "plain-directory");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(cwd);
  await executable(
    join(fakeBin, "herdr"),
    `if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\n'
  exit
fi
[[ \${1:-} == --session && \${2:-} == delegates ]] || exit 1
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\n'
    ;;
  "pane get")
    printf '{"result":{"pane":{"pane_id":"pane-1","tab_id":"tab-1"}}}\n'
    ;;
  "tab rename") ;;
  *) printf 'unsupported fake herdr call: %s\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const argv = ["task", "open", "--key", "standalone-task", "--cwd", cwd];

  const first = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );
  const repeated = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );

  assert.equal(first.result.group.inferred, true);
  assert.match(
    first.result.group.key,
    /^standalone\/plain-directory-[0-9a-f]{12}$/u,
  );
  assert.equal(first.result.group.label, "plain-directory - standalone");
  assert.equal(repeated.result.group.id, first.result.group.id);
  assert.equal(repeated.result.task.id, first.result.task.id);
});

test("agent start resolves and reuses an immutable launch through the public CLI", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-start-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const stateHome = join(scratch, "state");
  const cwd = join(scratch, "work");
  const herdrState = join(scratch, "herdr-state");
  const paneClosed = join(herdrState, "pane-closed");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(cwd);
  await mkdir(herdrState);
  await executable(join(fakeBin, "codex"), "exit 0\n");
  await executable(
    join(fakeBin, "herdr"),
    `herdrState=${JSON.stringify(herdrState)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\n'
  exit
fi
[[ \${1:-} == --session && \${2:-} == delegates ]] || exit 1
shift 2
case "\${1:-} \${2:-}" in
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"},"root_pane":{"pane_id":"pane-1"}}}\n'
    ;;
  "pane get")
    if [[ -f ${JSON.stringify(paneClosed)} ]]; then
      printf '{"error":{"code":"pane_not_found","message":"pane not found"}}\n' >&2
      exit 1
    fi
    printf '{"result":{"pane":{"pane_id":"pane-1","tab_id":"tab-1"}}}\n'
    ;;
  "pane close") touch ${JSON.stringify(paneClosed)} ;;
  "tab rename"|"pane rename") ;;
  "pane process-info")
    printf '{"result":{"process_info":{"shell_pid":10,"foreground_processes":[{"pid":10,"name":"zsh"}]}}}\n'
    ;;
  "agent start")
    printf '%s\n' "$*" > "$herdrState/start-args"
    touch "$herdrState/started"
    printf '{"result":{"agent":{"name":"managed"}}}\n'
    ;;
  "agent list")
    if [[ -f "$herdrState/started" ]]; then
      name=$(sed -n 's/^agent start \\([^ ]*\\).*/\\1/p' "$herdrState/start-args")
      printf '{"result":{"agents":[{"name":"%s","pane_id":"pane-1","agent_status":"idle","agent_session":{"value":"native-1"}}]}}\n' "$name"
    else
      printf '{"result":{"agents":[]}}\n'
    fi
    ;;
  *) printf 'unsupported fake herdr call: %s\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const opened = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["task", "open", "--group", "release", "--key", "task", "--cwd", cwd],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  const argv = [
    "agent",
    "start",
    opened.result.task.id,
    "--key",
    "critic",
    "--label",
    "Implementation review",
    "--role",
    "reviewer",
    "--model",
    "gpt-5.6-luna",
    "--effort",
    "low",
  ];

  let firstExecution;
  try {
    firstExecution = await execFileAsync(drovr, argv, {
      encoding: "utf8",
      env,
    });
  } catch (error) {
    assert.fail(
      `${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
  const first = JSON.parse(firstExecution.stdout);
  const repeated = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );

  assert.equal(first.schema, "drovr.command/v1");
  assert.equal(first.command, "agent start");
  assert.equal(first.result.status, "completed");
  assert.deepEqual(first.result.agent, {
    id: first.result.agent.id,
    task_id: opened.result.task.id,
    key: "critic",
    label: "Implementation review",
    harness: "codex",
    role: "reviewer",
    model: "gpt-5.6-luna",
    effort: "low",
    capability: "read-only",
    native: {
      sandbox: "read-only",
      approval: "never",
      search: false,
    },
    native_session: "native-1",
  });
  assert.equal(repeated.result.agent.id, first.result.agent.id);
  const relabeled = JSON.parse(
    (
      await execFileAsync(
        drovr,
        argv.with(argv.indexOf("Implementation review"), "Release review"),
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(relabeled.result.agent.id, first.result.agent.id);
  assert.equal(relabeled.result.agent.label, "Release review");
  const conflicting = JSON.parse(
    (
      await execFileAsync(
        drovr,
        argv.with(argv.indexOf("low"), "high"),
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(conflicting.result.status, "configuration_conflict");
  const retired = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["agent", "retire", first.result.agent.id],
        { encoding: "utf8", env },
      )
    ).stdout,
  );
  assert.equal(retired.result.status, "retired");
  const replacement = JSON.parse(
    (await execFileAsync(drovr, argv, { encoding: "utf8", env })).stdout,
  );
  assert.equal(replacement.result.status, "configuration_conflict");
  const startArgs = await readFile(join(herdrState, "start-args"), "utf8");
  assert.match(startArgs, /--kind codex/u);
  assert.match(startArgs, /--model gpt-5\.6-luna/u);
  assert.match(startArgs, /model_reasoning_effort="low"/u);
  assert.match(startArgs, /--sandbox read-only/u);
});
