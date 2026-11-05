import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const script = resolve(import.meta.dirname, "../scripts/prepare-feature-pilot.mjs");
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const run = (file, args, options = {}) => {
  const env = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(file, args, { encoding: "utf8", timeout: 30000, ...options, env });
};

test("public setup creates separate committed test/verify targets and runnable discriminating checks", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "flow-setup-' "));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const name of ["flow.dark-opt-in.v1.schema.json", "flow.feature-preparation-request.v1.schema.json"]) {
    ajv.addSchema(load(resolve(import.meta.dirname, "../schemas", name)));
  }
  const validate = ajv.getSchema("https://dotfiles.local/schemas/flow.feature-preparation-request.v1.schema.json");
  const pilots = [];
  for (const mode of ["test", "verify"]) {
    const result = run(process.execPath, [script, "setup", "--mode", mode, "--parent", parent], {
      env: { ...process.env, GIT_DIR: "/unowned/foreign-repository", GIT_INDEX_FILE: "/unowned/foreign-index", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/unowned/hooks" },
    });
    assert.equal(result.status, 0, result.stderr);
    const pilot = JSON.parse(result.stdout);
    pilots.push(pilot);
    assert.equal(pilot.status, "preparation_only");
    assert.equal(pilot.native_execution, "not_run");
    assert.equal(pilot.qualification, "not_run");
    assert.equal(pilot.normal_use_authorized, false);
    const directory = pilot.directory;
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "trusted-owner.mjs")).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "flow")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(directory, "authority")), []);
    assert.deepEqual(readdirSync(join(directory, "state")), []);
    const request = load(join(directory, "prepare-request.json"));
    assert.equal(validate(request), true, ajv.errorsText(validate.errors));
    assert.equal(request.mode, mode);
    assert.equal(request.dark_opt_in.release_id, "flow-release-1.1-dark-test/v1");
    assert.equal(Object.hasOwn(request, "test"), mode === "test");
    assert.equal(run("/bin/sh", ["-n", join(directory, "flow")]).status, 0);
    const stopped = run(join(directory, "flow"), ["status", "--json"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).state, "stopped");
    const workspace = pilot.environment.FLOW_REPOSITORY_ROOT;
    const git = (args) => run("/usr/bin/git", ["-C", workspace, ...args]);
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]).stdout, "");
    assert.equal(git(["show", "HEAD:acceptance.test.mjs"]).stdout, readFileSync(join(workspace, "acceptance.test.mjs"), "utf8"));
    assert.equal(run(pilot.node, ["--test", "health.test.mjs"], { cwd: workspace }).status, 0);
    const red = run(pilot.node, ["--test", "acceptance.test.mjs"], { cwd: workspace });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /ERR_ASSERTION/u);
    assert.match(red.stdout, /strictEqual/u);
    writeFileSync(join(workspace, "feature.txt"), "after\n");
    assert.equal(run(pilot.node, ["--test", "acceptance.test.mjs"], { cwd: workspace }).status, 0);
    assert.equal(readFileSync(join(directory, "untouched-canary.txt"), "utf8"), "Flow must preserve this sibling file.\n");
  }
  assert.notEqual(pilots[0].directory, pilots[1].directory);
  assert.notEqual(pilots[0].environment.FLOW_AUTHORITY_DIRECTORY, pilots[1].environment.FLOW_AUTHORITY_DIRECTORY);
});

test("generated public client starts its isolated production owner and preserves withheld native admission", (t) => {
  const result = run(process.execPath, [script, "setup"]);
  assert.equal(result.status, 0, result.stderr);
  const pilot = JSON.parse(result.stdout);
  const client = join(pilot.directory, "flow");
  // Cleanup only this test's recorded owner, including an assertion-failure path.
  t.after(() => {
    const stopped = run(client, ["stop", "--json"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    rmSync(pilot.directory, { recursive: true, force: true });
  });
  const started = run(client, ["start", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const status = run(client, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, "running");
  const prepared = run(client, ["prepare", "--input", readFileSync(join(pilot.directory, "prepare-request.json"), "utf8"), "--json"]);
  const rejection = JSON.parse(prepared.stdout || prepared.stderr);
  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "qualification_withheld");
  assert.equal(readFileSync(join(pilot.environment.FLOW_REPOSITORY_ROOT, "feature.txt"), "utf8"), "before\n");
  assert.equal(existsSync(join(pilot.environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
  const review = run(process.execPath, [script, "review-request", pilot.directory, `run:${"0".repeat(64)}`]);
  assert.equal(review.status, 1, review.stdout);
  assert.deepEqual(readdirSync(join(pilot.directory, "receipts")), [], "a nonexistent producer cannot create a review request");
});

test("setup rejects invalid mode and oversized socket paths before allocating a pilot", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "flow-setup-invalid-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  assert.equal(run(process.execPath, [script, "setup", "--mode", "mixed", "--parent", parent]).status, 1);
  assert.deepEqual(readdirSync(parent), []);
  const longParent = join(parent, "long-".repeat(20));
  mkdirSync(longParent);
  assert.equal(run(process.execPath, [script, "setup", "--parent", longParent]).status, 1);
  assert.deepEqual(readdirSync(longParent), []);
  const invalidReview = run(process.execPath, [script, "review-request", parent, "latest"]);
  assert.equal(invalidReview.status, 1);
  assert.match(invalidReview.stderr, /exact run_id/u);
});
