import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
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

test("group list reads absent state without initializing the registry", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-empty-query-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: join(scratch, "state") };

  const report = await runDrovr(env, ["group", "list"]);

  assert.deepEqual(report.result.groups, []);
  await assert.rejects(stat(stateDirectory(env)), { code: "ENOENT" });
});

test("group list filters durable records and group get uses immutable identity", async (t) => {
  const fixture = await queryFixture(t);

  const listed = await runDrovr(fixture.env, [
    "group",
    "list",
    "--status",
    "active",
  ]);
  assert.equal(listed.command, "group list");
  assert.equal(listed.result.status, "completed");
  assert.deepEqual(listed.result.groups, [
    {
      id: "group-active",
      key: "work/active",
      label: "Active group",
      inferred: false,
      lifecycle_status: "active",
      created_at: "2026-07-23T10:00:00.000Z",
    },
  ]);

  const fetched = await runDrovr(fixture.env, [
    "group",
    "get",
    "group-closed",
  ]);
  assert.equal(fetched.command, "group get");
  assert.equal(fetched.result.group.id, "group-closed");
  assert.equal(fetched.result.group.key, "work/closed");
  assert.equal(fetched.result.group.lifecycle_status, "closed");
});

test("task and agent queries filter by stable owner identity", async (t) => {
  const fixture = await queryFixture(t);

  const tasks = await runDrovr(fixture.env, [
    "task",
    "list",
    "--group",
    "group-active",
    "--status",
    "active",
  ]);
  assert.deepEqual(tasks.result.tasks, [
    {
      id: "task-active",
      group_id: "group-active",
      key: "task",
      label: "Active task",
      cwd: "/tmp/caller-owned",
      lifecycle_status: "active",
      created_at: "2026-07-23T10:01:00.000Z",
    },
  ]);
  const task = await runDrovr(fixture.env, ["task", "get", "task-active"]);
  assert.equal(task.result.task.id, "task-active");
  assert.equal(task.result.task.group_id, "group-active");

  const agents = await runDrovr(fixture.env, [
    "agent",
    "list",
    "--task",
    "task-active",
    "--status",
    "active",
    "--harness",
    "codex",
  ]);
  assert.deepEqual(agents.result.agents, [
    {
      id: "agent-active",
      task_id: "task-active",
      key: "builder",
      label: "Builder",
      lifecycle_status: "active",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
      capability: "workspace-write",
      native_session: "native-active",
      created_at: "2026-07-23T10:02:00.000Z",
    },
  ]);
  const agent = await runDrovr(fixture.env, [
    "agent",
    "get",
    "agent-active",
  ]);
  assert.equal(agent.result.agent.id, "agent-active");
  assert.equal(agent.result.agent.task_id, "task-active");
});

test("agent get reports observed loss without recovering or mutating Herdr", async (t) => {
  const fixture = await queryFixture(t);
  const fakeBin = join(fixture.scratch, "bin");
  const calls = join(fixture.scratch, "herdr-calls");
  await mkdir(fakeBin);
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\n'
  exit
fi
if [[ \${1:-} == --session && \${2:-} == delegates && \${3:-} == agent && \${4:-} == list ]]; then
  printf '{"result":{"agents":[]}}\n'
  exit
fi
printf 'unexpected mutation: %s\n' "$*" >&2
exit 1
`,
  );
  await chmod(fakeHerdr, 0o755);
  const env = {
    ...fixture.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const report = await runDrovr(env, ["agent", "get", "agent-active"]);
  assert.equal(report.result.status, "agent_lost");
  assert.deepEqual(report.result.agent.observation, {
    status: "agent_lost",
    reason: "agent_not_found",
  });
  assert.deepEqual(
    (await readFile(calls, "utf8")).trim().split("\n"),
    ["session list --json", "--session delegates agent list"],
  );
});

test("status reports a missing configured session without creating it", async (t) => {
  const fixture = await queryFixture(t);
  const fakeBin = join(fixture.scratch, "missing-session-bin");
  const calls = join(fixture.scratch, "missing-session-calls");
  await mkdir(fakeBin);
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[]}\n'
  exit
fi
printf 'unexpected mutation: %s\n' "$*" >&2
exit 1
`,
  );
  await chmod(fakeHerdr, 0o755);
  const env = {
    ...fixture.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const report = await runDrovr(env, ["status"]);
  assert.equal(report.result.status, "session_missing");
  assert.deepEqual(report.result.session, {
    name: "delegates",
    status: "missing",
  });
  assert.deepEqual(report.result.warnings, [
    { code: "session_missing", session: "delegates" },
    {
      code: "agent_lost",
      agent_id: "agent-active",
      reason: "session_missing",
    },
  ]);
  assert.equal((await readFile(calls, "utf8")).trim(), "session list --json");
});

test("status reports active durable work and reconciliation warnings without recovery", async (t) => {
  const fixture = await queryFixture(t);
  const fakeBin = join(fixture.scratch, "status-bin");
  const calls = join(fixture.scratch, "status-herdr-calls");
  await mkdir(fakeBin);
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
if [[ \${1:-} == session && \${2:-} == list ]]; then
  printf '{"sessions":[{"name":"delegates","running":true}]}\n'
  exit
fi
if [[ \${1:-} == --session && \${2:-} == delegates && \${3:-} == agent && \${4:-} == list ]]; then
  printf '{"result":{"agents":[]}}\n'
  exit
fi
printf 'unexpected mutation: %s\n' "$*" >&2
exit 1
`,
  );
  await chmod(fakeHerdr, 0o755);
  const env = {
    ...fixture.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const report = await runDrovr(env, ["status"]);
  assert.equal(report.command, "status");
  assert.equal(report.result.status, "completed");
  assert.deepEqual(report.result.session, {
    name: "delegates",
    status: "running",
  });
  assert.equal(report.result.groups.length, 2);
  assert.equal(report.result.tasks.length, 1);
  assert.deepEqual(report.result.active_turns, [
    {
      id: "turn-active",
      agent_id: "agent-active",
      task_id: "task-active",
      status: "working",
      input_count: 1,
      created_at: "2026-07-23T10:03:00.000Z",
    },
  ]);
  assert.deepEqual(report.result.blocked_events, [
    {
      id: "block-active",
      turn_id: "turn-active",
      agent_id: "agent-active",
      task_id: "task-active",
      status: "open",
      created_at: "2026-07-23T10:04:00.000Z",
    },
  ]);
  assert.deepEqual(report.result.warnings, [
    {
      code: "agent_lost",
      agent_id: "agent-active",
      reason: "agent_not_found",
    },
  ]);
  assert.deepEqual(
    (await readFile(calls, "utf8")).trim().split("\n"),
    ["session list --json", "--session delegates agent list"],
  );
});

async function queryFixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-query-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: join(scratch, "state") };
  const registryDirectory = stateDirectory(env);
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-closed",
    key: "work/closed",
    label: "Closed group",
    inferred: false,
    status: "closed",
    herdr: { session: "delegates", workspace_id: "workspace-closed" },
    created_at: "2026-07-23T09:00:00.000Z",
    closed_at: "2026-07-23T09:30:00.000Z",
  });
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-active",
    key: "work/active",
    label: "Active group",
    inferred: false,
    status: "active",
    herdr: { session: "delegates", workspace_id: "workspace-active" },
    created_at: "2026-07-23T10:00:00.000Z",
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-active",
    group_id: "group-active",
    key: "task",
    label: "Active task",
    cwd: "/tmp/caller-owned",
    status: "active",
    herdr: { tab_id: "tab-active", root_pane_id: "pane-active" },
    created_at: "2026-07-23T10:01:00.000Z",
  });
  await writeRecord(registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-active",
    task_id: "task-active",
    key: "builder",
    label: "Builder",
    status: "active",
    launch: {
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
      capability: "workspace-write",
    },
    herdr: { name: "managed-active", pane_id: "pane-active" },
    native_session: "native-active",
    created_at: "2026-07-23T10:02:00.000Z",
  });
  await writeRecord(registryDirectory, "turns", {
    schema: "drovr.turn/v1",
    id: "turn-active",
    agent_id: "agent-active",
    task_id: "task-active",
    status: "working",
    inputs: [{ sequence: 1, text: "Continue" }],
    created_at: "2026-07-23T10:03:00.000Z",
  });
  await writeRecord(registryDirectory, "blocks", {
    schema: "drovr.block/v1",
    id: "block-active",
    turn_id: "turn-active",
    agent_id: "agent-active",
    task_id: "task-active",
    status: "open",
    created_at: "2026-07-23T10:04:00.000Z",
  });
  return { scratch, env, registryDirectory };
}

async function runDrovr(env, args) {
  return JSON.parse((await execFileAsync(drovr, args, { env })).stdout);
}
