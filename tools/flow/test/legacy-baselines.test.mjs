import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { auditLegacyBaselines } from "../src/legacy-baselines.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const inventoryPath = fileURLToPath(
  new URL("../../../config/flow/legacy-baselines.v1.json", import.meta.url),
);
const execFileAsync = promisify(execFile);

test("legacy baseline audit resolves exact frozen trees from the recorded commit", async () => {
  const audit = await auditLegacyBaselines({ repositoryRoot, inventoryPath });

  assert.equal(audit.schema, "flow.legacy-baseline-audit/v1");
  assert.equal(audit.status, "passed");
  assert.equal(audit.source_commit, "1e3e4665d4241419ad573d208077a20d845289bc");
  assert.deepEqual(
    audit.baselines.map(({ implementation, status }) => ({ implementation, status })),
    [
      { implementation: "legacy-claude/v1", status: "passed" },
      { implementation: "legacy-agent-flow/v1", status: "passed" },
    ],
  );
  for (const baseline of audit.baselines) {
    assert.ok(baseline.components.length > 0);
    for (const component of baseline.components) {
      assert.equal(component.recorded_git_object, component.expected_git_object);
      assert.equal(component.current_git_object, component.expected_git_object);
    }
  }
});

test("legacy baseline audit distinguishes worktree dirt from content drift", async (t) => {
  const { scratch, fixtureInventory } = await createFrozenLegacyRepository(t, "audit");

  await writeFile(join(scratch, "legacy", "flow.txt"), "drifted\n");
  const audit = await auditLegacyBaselines({
    repositoryRoot: scratch,
    inventoryPath: fixtureInventory,
  });

  assert.equal(audit.status, "passed");
  assert.equal(audit.working_tree_clean, false);
  assert.equal(audit.baselines[0].status, "passed");
  assert.equal(audit.baselines[0].working_tree_clean, false);
  assert.equal(audit.baselines[0].components[0].status, "passed");
  assert.equal(audit.baselines[0].components[0].working_tree_clean, false);
});

test("legacy baseline audit reports a deleted frozen component", async (t) => {
  const { scratch, fixtureInventory } =
    await createFrozenLegacyRepository(t, "deleted");
  await unlink(join(scratch, "legacy", "flow.txt"));
  await execFileAsync("git", ["add", "legacy/flow.txt"], { cwd: scratch });
  await execFileAsync("git", ["commit", "-qm", "delete frozen component"], {
    cwd: scratch,
  });

  const audit = await auditLegacyBaselines({
    repositoryRoot: scratch,
    inventoryPath: fixtureInventory,
  });

  assert.equal(audit.baselines[0].status, "failed");
  assert.equal(audit.baselines[0].components[0].current_git_object, null);
  assert.equal(
    audit.baselines[0].components[0].current_failure,
    "unresolved_git_object",
  );
});

test("legacy baseline audit rejects component paths outside the repository", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-outside-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixtureInventory = join(scratch, "inventory.json");
  await writeFile(
    fixtureInventory,
    `${JSON.stringify({
      schema: "flow.legacy-baseline-inventory/v1",
      source_commit: "1e3e4665d4241419ad573d208077a20d845289bc",
      baselines: [
        {
          implementation: "legacy-test/v1",
          components: [{ source_path: "../outside", git_object: "0".repeat(40) }],
        },
      ],
    })}\n`,
  );

  await assert.rejects(
    auditLegacyBaselines({ repositoryRoot, inventoryPath: fixtureInventory }),
    /legacy baseline component is outside the repository: \.\.\/outside/,
  );
});

test("legacy baseline audit reports unavailable repository status", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-unavailable-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixtureInventory = join(scratch, "inventory.json");
  await writeFile(
    fixtureInventory,
    `${JSON.stringify({
      schema: "flow.legacy-baseline-inventory/v1",
      source_commit: "1e3e4665d4241419ad573d208077a20d845289bc",
      baselines: [
        {
          implementation: "legacy-test/v1",
          components: [{ source_path: "legacy/flow.txt", git_object: "0".repeat(40) }],
        },
      ],
    })}\n`,
  );

  const audit = await auditLegacyBaselines({
    repositoryRoot: scratch,
    inventoryPath: fixtureInventory,
  });

  assert.equal(audit.status, "failed");
  assert.equal(
    audit.baselines[0].components[0].working_tree_failure,
    "unavailable_worktree_status",
  );
});

async function createFrozenLegacyRepository(t, label) {
  const scratch = await mkdtemp(join(tmpdir(), `flow-legacy-${label}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: scratch });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: scratch });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: scratch,
  });
  await mkdir(join(scratch, "legacy"));
  await writeFile(join(scratch, "legacy", "flow.txt"), "frozen\n");
  await execFileAsync("git", ["add", "legacy/flow.txt"], { cwd: scratch });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: scratch });
  const sourceCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: scratch })
  ).stdout.trim();
  const gitObject = (
    await execFileAsync("git", ["rev-parse", `${sourceCommit}:legacy/flow.txt`], {
      cwd: scratch,
    })
  ).stdout.trim();
  const fixtureInventory = join(scratch, "inventory.json");
  await writeFile(
    fixtureInventory,
    `${JSON.stringify({
      schema: "flow.legacy-baseline-inventory/v1",
      source_commit: sourceCommit,
      baselines: [
        {
          implementation: "legacy-test/v1",
          components: [{ source_path: "legacy/flow.txt", git_object: gitObject }],
        },
      ],
    })}\n`,
  );
  return { scratch, fixtureInventory };
}
