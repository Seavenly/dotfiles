import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  queryTransition,
  readGovernedReleaseFile,
} from "../src/transition-projection.mjs";
import { digest as canonicalDigest } from "../src/canonical.mjs";
import {
  deriveGitTreeSha,
  isGovernedReleasePath,
} from "../src/release-content-contract.mjs";

const configDirectory = fileURLToPath(
  new URL("../../../config/flow", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

test("release content binds the governed candidate tree and declared base", async () => {
  const content = JSON.parse(await readFile(
    join(configDirectory, "evidence/release-content.v1.json"),
    "utf8",
  ));

  assert.equal(content.git_binding.schema, "flow.release-content-git-binding/v1");
  assert.match(content.git_binding.candidate_tree_sha, /^[0-9a-f]{40}$/u);
  assert.deepEqual({
    qualification_base_commit: content.git_binding.qualification_base_commit,
    included_paths: content.git_binding.included_paths,
    excluded_paths: content.git_binding.excluded_paths,
  }, {
    qualification_base_commit: "a4a9a88a330be2b668339cf1a9b1b7c1b992564e",
    included_paths: [
      "CONTEXT.md",
      "README.md",
      "bin/flow",
      "config/flow/",
      "docs/adr/0007-use-drovr-as-the-delegated-agent-runtime.md",
      "docs/adr/0008-use-a-sole-run-authority-for-flow-lifecycle.md",
      "tests/flow_cli_test.sh",
      "tests/flow_transition_test.sh",
      "tools/drovr/HARNESS-INTERFACE.md",
      "tools/drovr/SPEC.md",
      "tools/drovr/package.json",
      "tools/drovr/src/",
      "tools/drovr/test/compatibility.test.mjs",
      "tools/drovr/test/description.test.mjs",
      "tools/flow/",
    ],
    excluded_paths: [
      "config/flow/evidence/",
      "config/flow/node_modules/",
      "config/flow/transition-ledger.v1.json",
      "tools/flow/node_modules/",
    ],
  });
  assert.deepEqual(content.files.map(({ path }) => path),
    [...content.files.map(({ path }) => path)].sort());
  for (const path of [
    "bin/flow",
    "config/flow/host/flow-owner",
    "tests/flow_cli_test.sh",
    "tests/flow_transition_test.sh",
    "tools/drovr/src/compatibility.mjs",
    "tools/drovr/src/description.mjs",
    "tools/flow/src/flow-runtime.mjs",
  ]) {
    assert.ok(content.files.some((entry) => entry.path === path), path);
  }
  assert.equal(content.content_digest, canonicalDigest({
    schema: content.schema,
    release_id: content.release_id,
    git_binding: content.git_binding,
    files: content.files,
  }));
});

test("release content validates from a fresh clone without synthesized Git objects", async (t) => {
  const { content, clonedConfig, clonedRepository } =
    await copyReleaseCandidateToFreshClone(t, "portable-release-content");
  assert.equal(
    deriveGitTreeSha(content.files),
    content.git_binding.candidate_tree_sha,
  );

  assert.throws(() => execFileSync("git", [
    "cat-file",
    "-e",
    content.git_binding.candidate_tree_sha,
  ], { cwd: clonedRepository, stdio: "ignore" }));
  const unreachableBlob = content.files.find(({ git_blob_sha }) => {
    try {
      execFileSync("git", ["cat-file", "-e", git_blob_sha], {
        cwd: clonedRepository,
        stdio: "ignore",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(unreachableBlob, "fresh clone contains no candidate-only blobs");
  const ignoredPath = "tools/flow/.DS_Store";
  await writeFile(join(clonedRepository, ignoredPath), "Finder metadata\n");
  assert.equal(execFileSync("git", ["check-ignore", "--", ignoredPath], {
    cwd: clonedRepository,
    encoding: "utf8",
  }).trim(), ignoredPath);
  const projection = await queryTransition({
    configDirectory: clonedConfig,
    repositoryRoot: clonedRepository,
  });
  assert.equal(projection.schema, "flow.transition-projection/v1");
});

test("release-content generator excludes ignored files beneath governed prefixes", async (t) => {
  const { clonedRepository } =
    await copyReleaseCandidateToFreshClone(t, "ignored-release-content");
  const ignoredPath = "tools/flow/.DS_Store";
  await writeFile(join(clonedRepository, ignoredPath), "Finder metadata\n");
  assert.equal(execFileSync("git", ["check-ignore", "--", ignoredPath], {
    cwd: clonedRepository,
    encoding: "utf8",
  }).trim(), ignoredPath);

  await execFileAsync(process.execPath, [
    "config/flow/scripts/generate-release-content.mjs",
  ], { cwd: clonedRepository, env: process.env });

  const generated = JSON.parse(await readFile(join(
    clonedRepository,
    "config/flow/evidence/release-content.v1.json",
  ), "utf8"));
  assert.equal(generated.files.some(({ path }) => path === ignoredPath), false);
});

test("Git tree derivation matches Git's nested object hashing and detects tampering", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-git-tree-derivation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  execFileSync("git", ["read-tree", "--empty"], { cwd: scratch, env });

  const contents = new Map([
    ["a/inner/leaf", Buffer.from("nested executable\n")],
    ["a.tail", Buffer.from("file ordering\n")],
    ["a/child", Buffer.from("nested sibling\n")],
    ["z", Buffer.from("root file\n")],
  ]);
  const files = [];
  for (const [path, bytes] of contents) {
    const mode = path === "a/inner/leaf" ? "100755" : "100644";
    const git_blob_sha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: scratch,
      input: bytes,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `${mode},${git_blob_sha},${path}`], {
      cwd: scratch,
      env,
    });
    files.push({ path, mode, git_blob_sha });
  }
  const expected = execFileSync("git", ["write-tree"], {
    cwd: scratch,
    env,
    encoding: "utf8",
  }).trim();

  assert.equal(deriveGitTreeSha(files), expected);
  const tampered = files.map((entry) => entry.path === "a/inner/leaf"
    ? { ...entry, git_blob_sha: "0".repeat(40) }
    : entry);
  assert.notEqual(deriveGitTreeSha(tampered), expected);
});

test("transition query rejects a release manifest with a missing governed file", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "release-missing-file");
  await mutateReleaseContent(copiedConfig, (content) => {
    content.files = content.files.filter(({ path }) => path !== "README.md");
  });

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /release content governed file listing differs from the working tree/u,
  );
});

test("transition query rejects candidate-tree bytes that differ from the worktree", async (t) => {
  const { clonedConfig, clonedRepository } = await copyReleaseCandidateToFreshClone(
    t,
    "release-changed-bytes",
  );
  await writeFile(
    join(clonedRepository, "README.md"),
    "README bytes changed in the candidate tree\n",
  );

  await assert.rejects(
    queryTransition({
      configDirectory: clonedConfig,
      repositoryRoot: clonedRepository,
    }),
    /release content digest changed: README\.md/u,
  );
});

test("transition query rejects a wrong or unavailable candidate tree binding", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "release-wrong-tree");
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  await mutateReleaseContent(copiedConfig, (content) => {
    content.git_binding.candidate_tree_sha = headTree;
  });
  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /release content candidate tree does not match the governed files/u,
  );

  const { copiedConfig: unavailableConfig } = await copyTransitionConfig(
    t,
    "release-unavailable-tree",
  );
  await mutateReleaseContent(unavailableConfig, (content) => {
    content.git_binding.candidate_tree_sha = "0".repeat(40);
  });
  await assert.rejects(
    queryTransition({ configDirectory: unavailableConfig, repositoryRoot }),
    /release content candidate tree does not match the governed files/u,
  );
});

test("transition query derives its watermark and legal actions from authority", async () => {
  const projection = await queryTransition({
    configDirectory,
    repositoryRoot,
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  });

  assert.equal(projection.schema, "flow.transition-projection/v1");
  assert.match(projection.watermark.ledger, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.policy, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.catalog, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.legacy_inventory, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.watermark.legacy_baseline_audit, /^sha256:[0-9a-f]{64}$/);
  assert.equal(projection.release, "flow-release-1.0-dark/v1");
  assert.deepEqual(projection.environment, {
    id: "repository-linux-x64",
    kind: "repository",
    os: "linux",
    architecture: "x64",
  });
  assert.equal(projection.selected_implementation, "legacy-claude/v1");
  assert.equal(projection.selected_authority_root, "/test/home/.agent-teams");
  assert.deepEqual(projection.evidence_statuses, {
    passed: 6,
    failed: 0,
    blocked: 0,
    not_run: 1,
  });
  assert.equal(projection.dark_opt_in.available, true);
  assert.equal(projection.legacy_baseline_audit.status, "passed");
  assert.equal(projection.capability_manifest.release_id, "flow-release-1.0-dark/v1");
  assert.deepEqual(projection.capability_manifest.supported_routes, [
    { flow: "feature", mode: "verify" },
    { flow: "review", mode: "local" },
  ]);
  assert.equal(projection.dark_opt_in.normal_use_authorized, false);
  assert.equal(projection.dark_opt_in.remote_mutations_authorized, false);
  assert.deepEqual(
    projection.prerequisites.map(({ issue, short_commit, status }) => ({
      issue,
      short_commit,
      status,
    })),
    [
      { issue: 80, short_commit: "cca3158", status: "integrated" },
      { issue: 81, short_commit: "da66e76", status: "integrated" },
      { issue: 82, short_commit: "6935cb2", status: "integrated" },
      { issue: 83, short_commit: "685b075", status: "integrated" },
      { issue: 26, short_commit: "da95b977", status: "integrated" },
      { issue: 29, short_commit: "a4a9a88", status: "integrated" },
    ],
  );
  assert.match(projection.legacy_inventory_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(projection.legal_actions, [
    "launch_default_legacy",
    "launch_explicit_legacy_agent_flow",
    "inspect_frozen_baselines",
  ]);
});

test("transition status withholds dark opt-in when production-route conformance is blocked", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "phase2-blocked-status");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const phase2 = ledger.evidence.find(({ id }) =>
    id === "production_route_conformance");
  const evidencePath = join(copiedConfig, phase2.path);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.status = "blocked";
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBytes);
  phase2.status = "blocked";
  phase2.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({
    configDirectory: copiedConfig,
    repositoryRoot,
  });

  assert.equal(projection.dark_opt_in.available, false);
  assert.equal(projection.evidence_statuses.blocked, 1);
  assert.equal(projection.evidence_digests.production_route_conformance,
    `sha256:${phase2.sha256}`);
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

for (const status of ["failed", "blocked", "not_run"]) {
  test(`dark opt-in availability fails closed when qualification evidence is ${status}`, async (t) => {
    const { copiedConfig } = await copyTransitionConfig(t, `qualification-${status}`);
    const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const evidence = ledger.evidence.find(({ id }) =>
      id === "deterministic_qualification");
    evidence.status = status;
    if (status === "not_run") {
      evidence.path = null;
      evidence.sha256 = null;
      const productionRouteEvidence = ledger.evidence.find(({ id }) =>
        id === "production_route_conformance");
      productionRouteEvidence.status = "not_run";
      productionRouteEvidence.path = null;
      productionRouteEvidence.sha256 = null;
    }
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const projection = await queryTransition({
      configDirectory: copiedConfig,
      repositoryRoot,
    });

    assert.equal(projection.dark_opt_in.available, false);
  });
}

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

test("transition query rejects catalog evidence with a stale ledger timestamp", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "catalog-timestamp");
  const ledgerPath = join(copiedConfig, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "public_contract_catalog")
    .recorded_at = "2026-09-10T17:42:34Z";
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await assert.rejects(
    queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
    /catalog evidence timestamp must match the transition ledger timestamp/,
  );
});

for (const [label, mutate] of [
  ["a changed command", async (evidence) => {
    evidence.recipe.commands[0].command = "node --test forged.mjs";
  }],
  ["passed not equal to tests", async (evidence) => {
    evidence.recipe.commands[0].passed += 1;
  }],
  ["a TAP summary count mismatch", async (evidence, copiedConfig) => {
    const command = evidence.recipe.commands[0];
    const receiptPath = join(copiedConfig, command.receipt_path);
    const receipt = await readFile(receiptPath, "utf8");
    const changedReceipt = receipt.replace(
      new RegExp(`^# pass ${command.passed}$`, "m"),
      `# pass ${command.passed - 1}`,
    );
    assert.notEqual(changedReceipt, receipt);
    await writeFile(receiptPath, changedReceipt);
    command.receipt_sha256 = createHash("sha256")
      .update(changedReceipt)
      .digest("hex");
  }],
  ["a receipt symlink outside config", async (evidence, copiedConfig, scratch) => {
    const command = evidence.recipe.commands[0];
    const receiptPath = join(copiedConfig, command.receipt_path);
    const outsidePath = join(scratch, "outside-receipt.tap");
    const bytes = "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
    await writeFile(outsidePath, bytes);
    await rm(receiptPath);
    await symlink(outsidePath, receiptPath);
    command.receipt_sha256 = createHash("sha256").update(bytes).digest("hex");
  }],
]) {
  test(`transition query rejects tampered qualification receipt with updated ledger digest: ${label}`, async (t) => {
    const { scratch, copiedConfig } = await copyTransitionConfig(t, `tampered-${label}`);
    const evidencePath = join(
      copiedConfig,
      "evidence/release-qualification.v1.json",
    );
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    await mutate(evidence, copiedConfig, scratch);
    await persistQualificationEvidenceMutation(copiedConfig, evidence);

    await assert.rejects(
      queryTransition({ configDirectory: copiedConfig, repositoryRoot }),
      /deterministic qualification evidence is not bound to the release/u,
    );
  });
}

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
    /transition evidence symlink is forbidden/,
  );
});

test("release-content reader rejects an external symlink before reading it", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-release-content-symlink-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedRepository = join(scratch, "repository");
  const outsideFile = join(scratch, "outside.txt");
  const symlinkPath = join(copiedRepository, "config/flow/external.txt");
  await mkdir(join(copiedRepository, "config/flow"), { recursive: true });
  await writeFile(outsideFile, "outside release authority\n");
  await symlink(outsideFile, symlinkPath);

  assert.throws(
    () => readGovernedReleaseFile(copiedRepository, "config/flow/external.txt"),
    /release content symlink is forbidden/u,
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
  ledger.legacy_inventory.sha256 =
    createHash("sha256").update(inventoryBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({ configDirectory: copiedConfig, repositoryRoot });

  assert.equal(projection.legacy_baseline_audit.status, "failed");
  assert.deepEqual(projection.defects, ["frozen_legacy_baseline_audit_failed"]);
  assert.deepEqual(projection.legal_actions, []);
});

test("legacy baseline audit distinguishes a dirty frozen worktree from content drift", async (t) => {
  const { auditLegacyBaselines } = await import("../src/legacy-baselines.mjs");
  const copiedRepository = await cloneRepositoryAtHead(t, "dirty-worktree-repository");
  await writeFile(join(copiedRepository, "config/claude", "untracked-flow-test"), "dirty\n");

  const audit = await auditLegacyBaselines({
    repositoryRoot: copiedRepository,
    inventoryPath: join(configDirectory, "legacy-baselines.v1.json"),
  });

  assert.equal(audit.status, "passed");
  assert.equal(audit.working_tree_clean, false);
});

test("transition query derives the launch action from either legacy default", async (t) => {
  const { copiedConfig } = await copyTransitionConfig(t, "default");
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
  ledger.legacy_inventory.sha256 =
    createHash("sha256").update(inventoryBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const projection = await queryTransition({
    configDirectory: copiedConfig,
    repositoryRoot,
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
  await cp(configDirectory, copiedConfig, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules"),
  });
  return { scratch, copiedConfig };
}

async function copyReleaseCandidateToFreshClone(t, label) {
  const content = JSON.parse(await readFile(
    join(configDirectory, "evidence/release-content.v1.json"),
    "utf8",
  ));
  const clonedRepository = await cloneRepositoryAtHead(t, label, { noLocal: true });
  const clonedConfig = join(clonedRepository, "config/flow");
  await rm(clonedConfig, { recursive: true, force: true });
  await cp(configDirectory, clonedConfig, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules"),
  });

  const candidatePaths = new Set(content.files.map(({ path }) => path));
  const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
    cwd: clonedRepository,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  for (const path of trackedPaths) {
    if (isGovernedReleasePath(path) && !candidatePaths.has(path)) {
      await rm(join(clonedRepository, path), { force: true });
    }
  }
  for (const { path } of content.files) {
    if (path.startsWith("config/flow/")) continue;
    const target = join(clonedRepository, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repositoryRoot, path), target);
  }
  return { content, clonedConfig, clonedRepository };
}

async function cloneRepositoryAtHead(t, label, { noLocal = false } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), `flow-repository-${label}-`));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copiedRepository = join(scratch, "repository");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  await execFileAsync("git", [
    "clone",
    "-q",
    ...(noLocal ? ["--no-local"] : []),
    "--no-checkout",
    repositoryRoot,
    copiedRepository,
  ]);
  await execFileAsync("git", ["checkout", "-q", stdout.trim()], {
    cwd: copiedRepository,
  });
  return copiedRepository;
}

async function mutateReleaseContent(configDirectory, mutate) {
  const contentPath = join(configDirectory, "evidence/release-content.v1.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  mutate(content);
  content.content_digest = canonicalDigest({
    schema: content.schema,
    release_id: content.release_id,
    git_binding: content.git_binding,
    files: content.files,
  });
  const contentBytes = `${JSON.stringify(content, null, 2)}\n`;
  await writeFile(contentPath, contentBytes);
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const contentEvidence = ledger.evidence.find(({ id }) =>
    id === "release_content_binding");
  const sha256 = createHash("sha256").update(contentBytes).digest("hex");
  contentEvidence.sha256 = sha256;
  ledger.release.content.sha256 = sha256;
  ledger.release.content.digest = content.content_digest;
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function persistQualificationEvidenceMutation(configDirectory, evidence) {
  evidence.recipe.digest = canonicalDigest(evidence.recipe.commands);
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(
    join(configDirectory, "evidence/release-qualification.v1.json"),
    evidenceBytes,
  );
  const ledgerPath = join(configDirectory, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.evidence.find(({ id }) => id === "deterministic_qualification").sha256 =
    createHash("sha256").update(evidenceBytes).digest("hex");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}
