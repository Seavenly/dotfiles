import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      assert.equal(component.working_tree_clean, true);
    }
  }
});

test("legacy baseline audit fails when current legacy content drifts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-audit-"));
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

  await writeFile(join(scratch, "legacy", "flow.txt"), "drifted\n");
  const audit = await auditLegacyBaselines({
    repositoryRoot: scratch,
    inventoryPath: fixtureInventory,
  });

  assert.equal(audit.baselines[0].status, "failed");
  assert.equal(audit.baselines[0].components[0].working_tree_clean, false);
});
