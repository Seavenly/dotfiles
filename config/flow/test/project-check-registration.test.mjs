import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { projectProfile, initializeProject, bindProject, projectFileHash } from "../test-support/project-check.mjs";
import { validateProjectCheck, resolveProjectCheck, assertProjectReadPath, projectPath, projectInputDigest, createProjectCheckWorkspaceSnapshot } from "../src/production-project-check.mjs";
import { projectCheckRunnerIdentity } from "../src/production-project-check-runner.mjs";
import { validateProjectCheckReceipt } from "../../../tools/flow/src/project-check.mjs";

const linux = { skip: process.platform !== "linux" && "registered project checks require Linux containment" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-project-registration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = initializeProject(join(root, "repo"), { "suite.mjs": 'throw new Error("preparation must not execute me");\n', "feature.txt": "before\n" });
  const config = projectProfile({ root: workspace.path });
  const select = value => resolveProjectCheck({ config: value, brief: { acceptance: config.criteria }, workspace, runnerIdentity: projectCheckRunnerIdentity() });
  return { root, workspace, config, select };
}

test("registered command selection binds all operator inputs without executing version or project code", linux, t => {
  const f = fixture(t), selected = f.select(f.config);
  assert.equal(selected.registration.argv[0], "--test");
  assert.match(selected.scope, /GREEN-only/u);
  assert.equal(selected.fingerprint, bindProject(f.config, f.workspace).fingerprint);
  for (const change of [value => value.argv.push("--extra"), value => value.version = "wrong", value => value.environment.LANG = "C", value => value.limits.timeout_ms = 60000]) {
    const value = structuredClone(f.config); change(value);
    assert.notEqual(f.select(value).fingerprint, selected.fingerprint);
  }
  assert.equal(existsSync(join(f.root, "authority")), false);
});

test("registration rejects mount masks, private inputs, traversal, authority overlap and drift", linux, t => {
  const f = fixture(t);
  for (const change of [value => value.cwd = "../repo", value => value.read_mounts.push(value.read_mounts[0]),
    value => value.read_mounts[0].source = join(f.root, ".netrc")]) {
    const value = structuredClone(f.config); change(value); assert.throws(() => validateProjectCheck(value));
  }
  const alternate = join(f.root, "alternate-node"); writeFileSync(alternate, readFileSync(f.config.executable.path));
  const masked = structuredClone(f.config); masked.read_mounts.find(value => value.target === masked.executable.path).source = alternate;
  assert.throws(() => f.select(masked), { code: "project_check_executable_masked" });
  const authority = join(f.root, "authority"); mkdirSync(authority);
  const sentinel = join(authority, "sentinel"); writeFileSync(sentinel, "owned metadata");
  const value = structuredClone(f.config); value.read_mounts.push({ source: sentinel, target: "/opt/metadata", sha256: projectFileHash(sentinel) });
  assert.throws(() => resolveProjectCheck({ config: value, workspace: f.workspace, brief: { acceptance: value.criteria }, runnerIdentity: projectCheckRunnerIdentity(), authorityDirectory: authority }), { code: "project_check_private_input" });
  writeFileSync(join(f.workspace.path, "suite.mjs"), "changed\n");
  assert.throws(() => f.select(f.config), { code: "project_check_input_drift" });
});

test("snapshot preserves committed internal symlinks and excludes ignored ambient files", linux, t => {
  const f = fixture(t);
  const git = args => execFileSync("/usr/bin/git", ["-C", f.workspace.path, ...args], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  writeFileSync(join(f.workspace.path, ".gitignore"), "ambient-private\n");
  writeFileSync(join(f.workspace.path, "ambient-private"), "not a selected input");
  symlinkSync("feature.txt", join(f.workspace.path, "CLAUDE.md"));
  git(["add", ".gitignore", "CLAUDE.md"]); git(["-c", "user.name=Flow fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Internal symlink"]);
  const snapshot = createProjectCheckWorkspaceSnapshot(f.workspace.path, join(f.root, "snapshot"));
  assert.equal(readFileSync(join(snapshot.path, "CLAUDE.md"), "utf8"), "before\n");
  assert.equal(existsSync(join(snapshot.path, "ambient-private")), false);
  assert.equal(existsSync(join(snapshot.path, ".git")), false);
  const parent = join(f.root, "inputs"); mkdirSync(parent); symlinkSync("..", join(parent, "parent"));
  assert.throws(() => projectInputDigest(parent), { code: "project_check_symlink_escape" });
});

test("public registration command hashes a recipe without running it and refuses output replacement", linux, t => {
  const f = fixture(t), recipe = structuredClone(f.config);
  recipe.schema = "flow.project-check-recipe/v2"; recipe.executable = recipe.executable.path;
  recipe.pinned_files = recipe.pinned_files.map(value => value.path);
  recipe.read_mounts = recipe.read_mounts.map(({ source, target }) => ({ source, target }));
  const path = join(f.root, "recipe.json"), output = join(f.root, "check.json"); writeFileSync(path, JSON.stringify(recipe));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const args = [cli, "local", "register-check", "--repository", f.workspace.path, "--recipe", path, "--output", output];
  const env = { ...process.env, HOME: f.root, XDG_STATE_HOME: join(f.root, "state"), FLOW_AUTHORITY_DIRECTORY: join(f.root, "authority") };
  const first = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 30000 });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).command_executed, false);
  assert.deepEqual(JSON.parse(readFileSync(output)), f.config);
  assert.equal(spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 30000 }).status, 1);
  assert.equal(existsSync(env.FLOW_AUTHORITY_DIRECTORY), false);
});

test("authority receipt validation rejects a forged version even with a new self digest", linux, t => {
  const f = fixture(t), binding = f.select(f.config), git = { ref: "refs/heads/main", commit_sha: "a".repeat(40), tree_sha: "b".repeat(40), clean: true };
  const capture = { schema: "work.feature-capture-receipt/v1", git, receipt_digest: digest("capture") };
  const intent = { run_id: "run:receipt", effect_id: "effect:receipt", attempt_id: "attempt:receipt", idempotency_key: "receipt",
    operation_input: { project_check: binding, authority_materialized_result_bindings: [{ output_contract: "candidate_capture_receipt", content: capture }] } };
  const result = { schema: "work.project-check-receipt/v2", run_id: intent.run_id, effect_id: intent.effect_id, attempt_id: intent.attempt_id, idempotency_key: intent.idempotency_key,
    reservation_digest: digest("reservation"), worker_identity_digest: digest("worker"), check_fingerprint: binding.fingerprint, scope: binding.scope, candidate: git, capture_receipt_digest: capture.receipt_digest, outcome: "passed", exit_code: 0,
    version: binding.registration.version, test_count: "unknown", stdout_sha256: digest("stdout"), stderr_sha256: digest("stderr"), terminal_digest: digest("terminal"), retired: true, proof: "linux_subreaper_echild" };
  assert.equal(validateProjectCheckReceipt({ ...result, self_digest: digest(result) }, intent), true);
  result.version = "wrong version";
  assert.equal(validateProjectCheckReceipt({ ...result, self_digest: digest(result) }, intent), false);
});

 test("registration rejects canonical HOME aliases and private root files before hashing", linux, t => {
  const f = fixture(t), home = join(f.root, "owned-home"), alias = join(f.root, "home-alias");
  mkdirSync(home); symlinkSync(home, alias);
  assert.throws(() => assertProjectReadPath(home, { home: alias }), { code: "project_check_private_input" });
  assert.throws(() => assertProjectReadPath(f.root, { home: alias }), { code: "project_check_private_input" });
  const sentinel = join(f.workspace.path, ".netrc"); writeFileSync(sentinel, "owned sentinel");
  assert.equal(projectPath(".netrc"), false);
  assert.equal(projectPath("inputs/.npmrc"), false);
  assert.throws(() => projectInputDigest(sentinel), { code: "project_check_private_input" });
  const config = structuredClone(f.config); config.pinned_files = [{ path: ".netrc", sha256: projectFileHash(sentinel) }];
  assert.throws(() => validateProjectCheck(config), { code: "project_check_invalid" });
 });
