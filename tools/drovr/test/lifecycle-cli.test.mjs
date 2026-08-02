import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
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

import { stateDirectory, writeRecord } from "../src/registry.mjs";

const execFileAsync = promisify(execFile);
const drovr = fileURLToPath(new URL("../../../bin/drovr", import.meta.url));

test("public CLI cancels, retires, and closes exact managed resources", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-lifecycle-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fakeBin = join(scratch, "bin");
  const herdrState = join(scratch, "herdr");
  const cwd = join(scratch, "caller-worktree");
  const callerFile = join(cwd, "keep.txt");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(herdrState, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(callerFile, "keep\n");
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(herdrState)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"persisted-session","running":true}]}\\n'
  exit
fi
[[ \${1:-} == --session && \${2:-} == persisted-session ]]
shift 2
case "\${1:-} \${2:-}" in
  "agent list")
    if [[ -f "$state/closed-pane" ]]; then
      printf '{"result":{"agents":[]}}\\n'
      exit
    fi
    if [[ -f "$state/interrupted" ]]; then status=idle; else status=working; fi
    printf '{"result":{"agents":[{"name":"managed-agent","pane_id":"pane-agent-1","agent_status":"%s","agent_session":{"value":"native-1"}}]}}\\n' "$status"
    ;;
  "agent send-keys")
    [[ \${3:-} == managed-agent && \${4:-} == ctrl+c ]]
    touch "$state/interrupted"
    printf '{"result":{"status":"sent"}}\\n'
    ;;
  "agent wait")
    printf '{"result":{"agent":{"name":"managed-agent","pane_id":"pane-agent-1","agent_status":"idle","agent_session":{"value":"native-1"}}}}\\n'
    ;;
  "pane close")
    [[ \${3:-} == pane-agent-1 ]]
    printf '%s\\n' "\${3}" > "$state/closed-pane"
    ;;
  "pane get")
    if [[ \${3:-} == pane-agent-1 && ! -f "$state/closed-pane" ]]; then
      printf '{"result":{"pane":{"pane_id":"pane-agent-1","tab_id":"tab-task-1"}}}\\n'
    elif [[ \${3:-} == pane-idle && -f "$state/created-idle" && ! -f "$state/closed-workspace" ]]; then
      printf '{"result":{"pane":{"pane_id":"pane-idle","tab_id":"tab-idle"}}}\\n'
    else
      printf '{"error":{"code":"pane_not_found"}}\\n' >&2
      exit 1
    fi
    ;;
  "tab create")
    touch "$state/created-idle"
    printf '{"result":{"tab":{"tab_id":"tab-idle"},"root_pane":{"pane_id":"pane-idle"}}}\\n'
    ;;
  "tab close")
    [[ \${3:-} == tab-task-1 ]]
    printf '%s\\n' "\${3}" > "$state/closed-tab"
    ;;
  "tab get")
    if [[ -f "$state/closed-workspace" ]]; then
      printf '{"error":{"code":"tab_not_found"}}\\n' >&2
      exit 1
    fi
    if [[ \${3:-} == tab-task-1 && ! -f "$state/closed-tab" ]]; then
      printf '{"result":{"tab":{"tab_id":"tab-task-1","workspace_id":"workspace-1"}}}\\n'
    elif [[ \${3:-} == tab-idle && -f "$state/created-idle" ]]; then
      printf '{"result":{"tab":{"tab_id":"tab-idle","workspace_id":"workspace-1"}}}\\n'
    else
      printf '{"error":{"code":"tab_not_found"}}\\n' >&2
      exit 1
    fi
    ;;
  "workspace close")
    [[ \${3:-} == workspace-1 ]]
    printf '%s\\n' "\${3}" > "$state/closed-workspace"
    ;;
  "workspace get")
    if [[ -f "$state/closed-workspace" ]]; then
      printf '{"error":{"code":"workspace_not_found"}}\\n' >&2
      exit 1
    fi
    printf '{"result":{"workspace":{"workspace_id":"workspace-1"}}}\\n'
    ;;
  *) printf 'unexpected fake Herdr call: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  await chmod(fakeHerdr, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_STATE_HOME: join(scratch, "state"),
  };
  const registryDirectory = stateDirectory(env);
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "group",
    label: "Group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: "group-1",
    key: "task",
    label: "Task",
    cwd,
    status: "active",
    herdr: { tab_id: "tab-task-1", root_pane_id: "pane-agent-1" },
  });
  await writeRecord(registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: "task-1",
    key: "agent",
    label: "Agent",
    status: "active",
    launch: { harness: "codex" },
    herdr: { name: "managed-agent", pane_id: "pane-agent-1" },
    native_session: "native-1",
  });
  await writeRecord(registryDirectory, "turns", {
    schema: "drovr.turn/v1",
    id: "turn-1",
    agent_id: "agent-1",
    task_id: "task-1",
    status: "working",
    inputs: [{ sequence: 1, text: "cancel me" }],
  });

  const cancelled = JSON.parse(
    (await execFileAsync(drovr, ["turn", "cancel", "turn-1"], { env })).stdout,
  );
  assert.equal(cancelled.command, "turn cancel");
  assert.equal(cancelled.result.status, "cancelled");

  const retired = JSON.parse(
    (await execFileAsync(drovr, ["agent", "retire", "agent-1"], { env })).stdout,
  );
  assert.equal(retired.command, "agent retire");
  assert.equal(retired.result.status, "retired");
  assert.equal((await readFile(join(herdrState, "closed-pane"), "utf8")).trim(), "pane-agent-1");

  const closed = JSON.parse(
    (await execFileAsync(drovr, ["task", "close", "task-1"], { env })).stdout,
  );
  assert.equal(closed.command, "task close");
  assert.equal(closed.result.status, "closed");
  assert.equal((await readFile(join(herdrState, "closed-tab"), "utf8")).trim(), "tab-task-1");
  const groupClosed = JSON.parse(
    (
      await execFileAsync(
        drovr,
        ["group", "close", "group-1", "--force"],
        { env },
      )
    ).stdout,
  );
  assert.equal(groupClosed.command, "group close");
  assert.equal(groupClosed.result.status, "closed");
  assert.equal(groupClosed.result.group.id, "group-1");
  assert.equal(
    (await readFile(join(herdrState, "closed-workspace"), "utf8")).trim(),
    "workspace-1",
  );
  await access(callerFile);
});
