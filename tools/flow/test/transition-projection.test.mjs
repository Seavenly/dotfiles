import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { queryTransition } from "../src/transition-projection.mjs";

const configDirectory = fileURLToPath(
  new URL("../../../config/flow", import.meta.url),
);

test("transition query derives its watermark and legal actions from authority", async () => {
  const projection = await queryTransition({ configDirectory });

  assert.equal(projection.schema, "flow.transition-projection/v1");
  assert.match(projection.watermark.ledger, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.policy, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.catalog, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.legacy_inventory, /^sha256:[0-9a-f]{64}$/);
  assert.equal(projection.release, "flow-stage0/v1");
  assert.deepEqual(projection.environment, {
    id: "repository-linux-x64",
    kind: "repository",
    os: "linux",
    architecture: "x64",
  });
  assert.equal(projection.selected_implementation, "legacy-claude/v1");
  assert.deepEqual(projection.evidence_statuses, {
    passed: 3,
    failed: 0,
    blocked: 0,
    not_run: 1,
  });
  assert.deepEqual(projection.legal_actions, [
    "launch_default_legacy",
    "launch_explicit_legacy_agent_flow",
    "inspect_frozen_baselines",
  ]);
});

test("transition query rejects a decision that contradicts launch policy", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-transition-decision-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedConfig = join(scratch, "flow");
  await cp(configDirectory, copiedConfig, { recursive: true });
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.decision.selected_implementation = "flow-runtime/v1";
  ledger.decision.replacement_launch_enabled = true;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig }),
    /transition decision contradicts the launch policy/,
  );
});

test("transition query rejects outside evidence and recovers from authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-transition-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedConfig = join(scratch, "flow");
  await cp(configDirectory, copiedConfig, { recursive: true });
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const originalLedger = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(originalLedger);
  const outsideBytes = "not transition authority\n";
  await writeFile(join(scratch, "outside.txt"), outsideBytes);
  ledger.evidence.push({
    id: "forged_outside_evidence",
    path: "../outside.txt",
    sha256: createHash("sha256").update(outsideBytes).digest("hex"),
    status: "passed",
    recorded_at: "2026-07-30T00:49:56Z",
  });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig }),
    /outside the transition configuration root/,
  );

  await writeFile(ledgerPath, originalLedger);
  const recovered = await queryTransition({ configDirectory: copiedConfig });
  assert.equal(recovered.selected_implementation, "legacy-claude/v1");
});

test("transition query rejects an evidence symlink outside authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-transition-link-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedConfig = join(scratch, "flow");
  await cp(configDirectory, copiedConfig, { recursive: true });
  const outsidePath = join(scratch, "outside.txt");
  const outsideBytes = "not transition authority\n";
  await writeFile(outsidePath, outsideBytes);
  await symlink(outsidePath, join(copiedConfig, "linked-outside.txt"));
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.push({
    id: "forged_symlink_evidence",
    path: "linked-outside.txt",
    sha256: createHash("sha256").update(outsideBytes).digest("hex"),
    status: "passed",
    recorded_at: "2026-07-30T23:06:09Z",
  });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig }),
    /resolves outside the transition configuration root/,
  );
});
