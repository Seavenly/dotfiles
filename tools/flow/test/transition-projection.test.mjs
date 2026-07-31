import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import test from "node:test";

import { queryTransition } from "../src/transition-projection.mjs";

const configDirectory = fileURLToPath(
  new URL("../../../config/flow", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

test("transition query derives its watermark and legal actions from authority", async (t) => {
  const copiedRepository = await cloneRepositoryAtHead(t, "authority");
  const projection = await queryTransition({
    configDirectory,
    repositoryRoot: copiedRepository,
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  });

  assert.equal(projection.schema, "flow.transition-projection/v1");
  assert.match(projection.watermark.ledger, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.policy, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.catalog, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.legacy_inventory, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.legacy_baseline_audit, /^sha256:[0-9a-f]{64}$/);
  assert.equal(projection.release, "flow-stage0/v1");
  assert.deepEqual(projection.environment, {
    id: "repository-linux-x64",
    kind: "repository",
    os: "linux",
    architecture: "x64",
  });
  assert.equal(projection.selected_implementation, "legacy-claude/v1");
  assert.equal(projection.selected_authority_root, "/test/home/.agent-teams");
  assert.deepEqual(projection.evidence_statuses, {
    passed: 3,
    failed: 0,
    blocked: 0,
    not_run: 1,
  });
  assert.equal(projection.legacy_baseline_audit.status, "passed");
  assert.deepEqual(projection.legal_actions, [
    "launch_default_legacy",
    "launch_explicit_legacy_agent_flow",
    "inspect_frozen_baselines",
  ]);
});

test("transition watermark binds the resolved authority root", async () => {
  const first = await queryTransition({
    configDirectory,
    repositoryRoot,
    homeDirectory: "/test/first-home",
    stateDirectory: "/test/first-state",
  });
  const second = await queryTransition({
    configDirectory,
    repositoryRoot,
    homeDirectory: "/test/second-home",
    stateDirectory: "/test/second-state",
  });

  assert.match(first.watermark.authority_root, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first.watermark.authority_root, second.watermark.authority_root);
});

test("transition query rejects a decision that contradicts launch policy", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "decision");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.decision.selected_implementation = "flow-runtime/v1";
  ledger.decision.replacement_launch_enabled = true;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /transition decision contradicts the launch policy/,
  );
});

test("transition query rejects a release unrelated to the frozen inventory", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "release");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.release.source_commit = "0".repeat(40);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /transition release differs from the frozen inventory/,
  );
});

test("transition query rejects passed evidence without digest-backed bytes", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "evidence");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.push({
    id: "unsupported_claim",
    path: null,
    sha256: null,
    status: "passed",
    recorded_at: "2026-07-30T23:06:09Z",
  });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /passed transition evidence requires digest-backed bytes: unsupported_claim/,
  );
});

test("transition query rejects a ledger without an explicit evidence array", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "evidence-array");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  delete ledger.evidence;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /transition ledger evidence, defects, and exceptions must be explicit arrays/,
  );
});

test("transition query rejects duplicate evidence identities", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "duplicate-evidence");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.push({
    ...ledger.evidence[0],
    status: "failed",
  });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /duplicate transition evidence identity: public_contract_catalog/,
  );
});

test("transition query rejects missing evidence identities", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "missing-evidence-id");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  delete ledger.evidence[0].id;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /invalid transition evidence: missing/,
  );
});

test("transition query rejects outside evidence and recovers from authority", async (t) => {
  const { scratch, copiedConfig } = await copyTransitionConfig(t, "outside");
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
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /outside the transition configuration root/,
  );

  await writeFile(ledgerPath, originalLedger);
  const recovered = await queryTransition({ configDirectory: copiedConfig, repositoryRoot });
  assert.equal(recovered.selected_implementation, "legacy-claude/v1");
});

test("transition query rejects an evidence symlink outside authority", async (t) => {
  const { scratch, copiedConfig } = await copyTransitionConfig(t, "link");
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
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /resolves outside the transition configuration root/,
  );
});

test("transition query identifies missing evidence", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "missing");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.push({
    id: "missing_evidence",
    path: "missing.txt",
    sha256: "0".repeat(64),
    status: "failed",
    recorded_at: "2026-07-30T23:06:09Z",
  });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /transition evidence is unavailable: missing_evidence/,
  );
});

test("transition query withholds launch actions when authority records failure", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "failed");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence[0].status = "failed";
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({ configDirectory: copiedConfig, repositoryRoot });

  assert.deepEqual(projection.legal_actions, ["inspect_frozen_baselines"]);
});

test("transition query withholds launch actions when required evidence is blocked", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "blocked");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "legacy_default_policy").status = "blocked";
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({ configDirectory: copiedConfig, repositoryRoot });

  assert.deepEqual(projection.legal_actions, ["inspect_frozen_baselines"]);
});

for (const authorityGap of ["not_run", "defect", "exception"]) {
  test(`transition query withholds launch actions for ${authorityGap} authority`, async (t) => {
    const { copiedConfig } = await copyTransitionConfig(t, authorityGap);
    const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    if (authorityGap === "not_run") {
      const evidence = ledger.evidence.find(
        ({ id }) => id === "public_contract_catalog",
      );
      evidence.status = "not_run";
      evidence.path = null;
      evidence.sha256 = null;
    } else {
      ledger[`${authorityGap}s`].push(`${authorityGap}_test`);
    }
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const projection = await queryTransition({
      configDirectory: copiedConfig,
      repositoryRoot,
    });

    assert.deepEqual(projection.legal_actions, ["inspect_frozen_baselines"]);
  });
}

test("transition query exposes frozen baseline drift as an operator defect", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "baseline");
  const inventoryPath = join(copiedConfig, "legacy-baselines.v1.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  inventory.baselines[0].components[0].git_object = "0".repeat(40);
  const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(inventoryPath, inventoryBytes);
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "frozen_legacy_inventory").sha256 =
    createHash("sha256").update(inventoryBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({ configDirectory: copiedConfig, repositoryRoot });

  assert.equal(projection.legacy_baseline_audit.status, "failed");
  assert.deepEqual(projection.defects, ["frozen_legacy_baseline_audit_failed"]);
  assert.deepEqual(projection.legal_actions, []);
});

test("transition query distinguishes a dirty frozen worktree from content drift", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "dirty-worktree");
  const copiedRepository = await cloneRepositoryAtHead(t, "dirty-worktree-repository");
  await writeFile(join(copiedRepository, "config/claude", "untracked-flow-test"), "dirty\n");

  const projection = await queryTransition({
    configDirectory: copiedConfig,
    repositoryRoot: copiedRepository,
  });

  assert.equal(projection.legacy_baseline_audit.status, "passed");
  assert.equal(projection.legacy_baseline_audit.working_tree_clean, false);
  assert.deepEqual(projection.defects, ["frozen_legacy_worktree_dirty"]);
  assert.deepEqual(projection.legal_actions, ["inspect_frozen_baselines"]);
});

test("transition query derives the launch action from either legacy default", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "default");
  const copiedRepository = await cloneRepositoryAtHead(t, "default-repository");
  const policyPath = join(copiedConfig, "launch-policy.v1.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.default_implementation = "legacy-agent-flow/v1";
  const policyBytes = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(policyPath, policyBytes);
  const inventoryPath = join(copiedConfig, "legacy-baselines.v1.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  inventory.baselines.reverse();
  const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(inventoryPath, inventoryBytes);
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.decision.selected_implementation = "legacy-agent-flow/v1";
  ledger.evidence.find(({ id }) => id === "legacy_default_policy").sha256 =
    createHash("sha256").update(policyBytes).digest("hex");
  ledger.evidence.find(({ id }) => id === "frozen_legacy_inventory").sha256 =
    createHash("sha256").update(inventoryBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({
    configDirectory: copiedConfig,
    repositoryRoot: copiedRepository,
  });

  assert.equal(projection.selected_implementation, "legacy-agent-flow/v1");
  assert.deepEqual(projection.legal_actions, [
    "launch_default_legacy",
    "inspect_frozen_baselines",
  ]);
});

async function copyTransitionConfig(t, label) {
  const scratch = await mkdtemp(join(tmpdir(), `flow-transition-${label}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedConfig = join(scratch, "flow");
  await cp(configDirectory, copiedConfig, { recursive: true });
  return { scratch, copiedConfig };
}

async function cloneRepositoryAtHead(t, label) {
  const scratch = await mkdtemp(join(tmpdir(), `flow-repository-${label}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedRepository = join(scratch, "repository");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  await execFileAsync(
    "git",
    ["clone", "-q", "--no-checkout", repositoryRoot, copiedRepository],
  );
  await execFileAsync("git", ["checkout", "-q", stdout.trim()], {
    cwd: copiedRepository,
  });
  return copiedRepository;
}
