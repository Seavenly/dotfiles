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

import {
  acquireResourceLock,
  readResourceLock,
  registryWatermark,
  registryOperation,
  releaseResourceLock,
  resourceLockPath,
  stateDirectory,
  taskLifecycleLockKey,
  writeRecord,
} from "../src/registry.mjs";

const execFileAsync = promisify(execFile);
const drovr = fileURLToPath(new URL("../../../bin/drovr", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("group list reads absent state without initializing the registry", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-empty-query-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = {
    ...process.env,
    DOTFILES_ROOT: root,
    XDG_STATE_HOME: join(scratch, "state"),
  };

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
      managed_runtime_evidence_digest: `sha256:${"d".repeat(64)}`,
      created_at: "2026-07-23T10:02:00.000Z",
    },
  ]);
  assert.equal(
    Object.hasOwn(agents.result.agents[0], "managed_runtime_identity"),
    false,
  );
  const agent = await runDrovr(fixture.env, [
    "agent",
    "get",
    "agent-active",
  ]);
  assert.equal(agent.result.agent.id, "agent-active");
  assert.equal(agent.result.agent.task_id, "task-active");
  assert.equal(
    Object.hasOwn(agent.result.agent, "managed_runtime_identity"),
    false,
  );
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
  await acquireResourceLock(
    fixture.registryDirectory,
    taskLifecycleLockKey("task-active"),
    {
      operation: registryOperation("agent.retire", "agent-active"),
      authorityId: "terminated-owner",
      processIdentity: {
        schema: "drovr.process-identity/v1",
        pid: 999999,
        boot_id: "boot-query",
        start_token: "1",
      },
    },
  );
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
  assert.deepEqual(
    report.result.authority_watermark,
    report.result.reconciliation.authority_watermark,
  );
  assert.match(
    report.result.authority_watermark.registry_sha256,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(report.result.reconciliation.status, "blocked");
  assert.deepEqual(report.result.reconciliation.legal_next_actions, [
    "agent_retire",
  ]);
  assert.deepEqual(report.result.reconciliation.locks[0].operation, {
    id: "drovr:agent.retire:agent-active",
    kind: "agent.retire",
  });
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

test("status exposes a typed public command for abandoning only a bare lock", async (t) => {
  const fixture = await queryFixture(t);
  const lockEntry = resourceLockPath(fixture.registryDirectory, "legacy-bare");
  await mkdir(lockEntry, { recursive: true, mode: 0o700 });
  const status = await runDrovr(fixture.env, ["status"]);
  const reconciliation = status.result.reconciliation;
  assert.equal(reconciliation.status, "blocked");
  assert.equal(reconciliation.locks[0].status, "bare");
  assert.ok(reconciliation.locks[0].lock_entry);
  assert.ok(reconciliation.legal_next_actions.includes("abandon_bare_registry_lock"));

  const abandoned = await runDrovr(fixture.env, [
    "lock",
    "abandon",
    reconciliation.locks[0].lock_entry,
    "--authority-watermark",
    JSON.stringify(reconciliation.authority_watermark),
    "--decision",
    "operator-review-1",
  ]);
  assert.equal(abandoned.command, "lock abandon");
  assert.equal(abandoned.result.status, "abandoned");
  assert.deepEqual((await runDrovr(fixture.env, ["status"])).result.reconciliation.legal_next_actions, [
    "acquire_registry_lock",
  ]);
  assert.deepEqual(await registryWatermark(fixture.registryDirectory), reconciliation.authority_watermark);
});

test("public bare-lock abandonment blocks a held successor subject", async (t) => {
  const fixture = await queryFixture(t);
  const resourceKey = "held-public-lock";
  const handle = await acquireResourceLock(fixture.registryDirectory, resourceKey, {
    operation: registryOperation("agent.retire", "agent-active", {
      agent_id: "agent-active",
    }),
    authorityId: "held-authority",
  });
  const lockEntry = resourceLockPath(fixture.registryDirectory, resourceKey)
    .split("/")
    .at(-1);
  const report = await runDrovr(fixture.env, [
    "lock",
    "abandon",
    lockEntry,
    "--authority-watermark",
    JSON.stringify(await registryWatermark(fixture.registryDirectory)),
    "--decision",
    "operator-review-held",
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.result.status, "registry_lock_recovery_evidence_invalid");
  assert.equal(
    (await readResourceLock(fixture.registryDirectory, resourceKey)).metadata.lock_id,
    handle.metadata.lock_id,
  );
  await releaseResourceLock(handle);
});

async function queryFixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-query-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = {
    ...process.env,
    DOTFILES_ROOT: root,
    XDG_STATE_HOME: join(scratch, "state"),
  };
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
    launch_binding: {
      schema: "drovr.agent-launch-binding/v1",
      comparison_key: `sha256:${"a".repeat(64)}`,
      configuration_watermark: `sha256:${"b".repeat(64)}`,
      compatibility_evidence_digest: `sha256:${"c".repeat(64)}`,
      managed_runtime_identity: {
        pane_id: "pane-active",
        process: { pid: 42 },
        executable: { canonical_path: "/managed/codex" },
      },
      managed_runtime_evidence_digest: `sha256:${"d".repeat(64)}`,
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
