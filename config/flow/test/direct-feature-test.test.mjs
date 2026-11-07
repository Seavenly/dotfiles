import { projectProfile } from "../test-support/project-check.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDurableRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";

import { startFlowOwner, stopFlowOwner } from "../src/owner-process.mjs";
import { requestFlowTransport } from "../src/transport.mjs";
import { deriveOwnerRuntimeBinding } from "../src/owner-runtime-binding.mjs";
import { bindQualifiedReleaseFixture } from "../test-support/qualified-release-fixture.mjs";

const sourceConfig = fileURLToPath(new URL("..", import.meta.url));
const sourceRepository = fileURLToPath(new URL("../../..", import.meta.url));
const productionRuntimeModule = fileURLToPath(new URL("../src/runtime.mjs", import.meta.url));
const checkId = "check:feature-text";
const criterion = "feature.txt contains after";
const fixtureRelease = "flow-release-1.1-dark-test/v1";
const linuxCheckMechanism = { skip: process.platform !== "linux" &&
  "Linux subreaper/pidfd and bubblewrap check containment are unsupported on this host; this skip is not macOS qualification" };

test("isolated non-Linux valid check configuration is unavailable before mkdir or worker spawn", async (t) => {
  assert.equal(Object.getOwnPropertyDescriptor(process, "platform").configurable, true,
    "platform simulation requires an actual configurable Node descriptor");
  const scratch = await mkdtemp(join(tmpdir(), "flow-check-portable-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const authorityDirectory = join(scratch, "authority");
  const hash = `sha256:${"0".repeat(64)}`;
  const config = { schema: "flow.production-feature-test-check/v1", check_id: checkId,
    executable: { path: process.execPath, version: "v22.23.1", sha256: hash },
    health: { path: "health.test.mjs", sha256: hash, case_name: "positive health probe" },
    acceptance: { path: "acceptance.test.mjs", sha256: hash, case_name: "selected feature behavior" },
    pinned_files: [], criteria: [criterion],
    expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "after\n", actual: "before\n" },
    environment: { PATH: "/usr/bin:/bin" }, limits: { timeout_ms: 5000, max_output_bytes: 64 * 1024 } };
  const module = new URL("../src/production-feature-test-check.mjs", import.meta.url).href;
  const code = `import assert from "node:assert/strict";
import filesystem from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
assert.equal(Object.getOwnPropertyDescriptor(process, "platform").configurable, true);
Object.defineProperty(process, "platform", { value: "darwin" });
let mkdirs = 0, workers = 0;
filesystem.mkdirSync = () => { mkdirs++; throw new Error("unexpected_mkdir"); };
childProcess.spawn = () => { workers++; throw new Error("unexpected_worker"); };
syncBuiltinESMExports();
const { validateProductionFeatureTestCheck, createProductionFeatureCheckRunner } = await import(${JSON.stringify(module)});
const featureTestCheck = validateProductionFeatureTestCheck(${JSON.stringify(config)});
const runner = createProductionFeatureCheckRunner({ authorityDirectory: ${JSON.stringify(authorityDirectory)}, featureTestCheck });
await assert.rejects(runner.run({ effect_id: "effect:portable", idempotency_key: "portable" },
  { path: ${JSON.stringify(join(scratch, "missing-workspace"))} }, {}), { code: "feature_test_check_unavailable" });
console.log(JSON.stringify({ valid: true, available: runner.available, mkdirs, workers, platform: process.platform }));`;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const observed = JSON.parse((await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
    env: { HOME: scratch, PATH: process.env.PATH }, timeout: 10_000,
  })).stdout);
  assert.deepEqual(observed, { valid: true, available: false, mkdirs: 0, workers: 0, platform: "darwin" });
  await assert.rejects(lstat(authorityDirectory), { code: "ENOENT" });
});

for (const scenario of ["success", "restart", "check-restart"]) {
  test(`public production feature test proves real RED/GREEN and ${scenario === "restart" ? "one writer across owner restart" : scenario === "check-restart" ? "one checker across owner restart" : "sealed unknown candidate"}`, linuxCheckMechanism, async (t) => {
    const fixture = await createFixture(t, scenario);
    const { repository, git, initial, request, invocations, ownerEnv, scratch } = fixture;
    let owner = await fixture.start();
    const client = () => publicClient(owner.socket_path);
    const rejected = [];
    if (scenario === "success") {
      const before = await client().query({});
      for (const [code, mutation] of [
        ["invalid_preparation_request", value => { delete value.test; }],
        ["feature_test_check_unavailable", value => { value.test.check_id = "check:unknown"; }],
        ["invalid_preparation_request", value => { value.test.command = "echo success"; }],
        ["invalid_preparation_request", value => { value.test.receipt = { schema: "work.feature-test-receipt/v1" }; }],
        ["invalid_preparation_request", value => { value.workspace_path = scratch; }],
        ["route_disabled", value => { value.mode = "mixed"; }],
        ["dark_opt_in_required", value => { delete value.dark_opt_in; }],
      ]) {
        const value = structuredClone(request);
        mutation(value);
        const result = await client().prepare(value);
        assert.equal(result.schema, "flow.rejection/v1", JSON.stringify(result));
        assert.equal(result.code, code, JSON.stringify(result));
        rejected.push(result);
      }
      assert.deepEqual((await client().query({})).runs, before.runs);
      assert.equal(await invocations(), "");
      const ledgerPath = join(fixture.configDirectory, "transition-ledger.v1.json");
      const ledgerBytes = await readFile(ledgerPath);
      const ledger = JSON.parse(ledgerBytes);
      ledger.evidence.find(({ id }) => id === "deterministic_qualification").status = "not_run";
      try {
        await writeFile(ledgerPath, JSON.stringify(ledger));
        const unqualified = await client().prepare(request);
        assert.equal(unqualified.schema, "flow.rejection/v1", JSON.stringify(unqualified));
        assert.equal(unqualified.code, "qualification_withheld", JSON.stringify(unqualified));
        rejected.push(unqualified);
        assert.deepEqual((await client().query({})).runs, before.runs);
        assert.equal(await invocations(), "");
      } finally {
        await writeFile(ledgerPath, ledgerBytes);
      }
      for (const query of ["push", "merge", "remote_mutation"]) {
        const result = await client().query({ schema: "flow.query/v1", query });
        assert.equal(result.schema, "flow.rejection/v1", JSON.stringify(result));
        assert.equal(result.code, "unsupported_query", JSON.stringify(result));
        rejected.push(result);
      }
      const genericTest = await client().prepare({
        schema: "flow.predefined-flow-selection/v1", definition: "feature/v1",
        dark_opt_in: request.dark_opt_in,
        inputs: { schema: "flow.feature-request/v1", mode: "test", brief: request.brief },
      });
      assert.equal(genericTest.schema, "flow.rejection/v1", JSON.stringify(genericTest));
      assert.equal(genericTest.code, "invalid_preparation_request", JSON.stringify(genericTest));
      rejected.push(genericTest);
      assert.deepEqual((await client().query({})).runs, before.runs);
      assert.equal(await invocations(), "");
    }

    const prepared = await client().prepare(request);
    await retain(`${scenario}-preparation`, { request, prepared });
    assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
    assert.equal(JSON.stringify(prepared).includes('"candidate_digest"'), false);
    assert.ok(prepared.graph.cards.some(card => card.executor.contract === "flow.operation/feature-test/v1"));
    assert.ok(prepared.graph.cards.some(card => card.executor.contract === "flow.operation/feature-direct-commit/v1"));
    assert.equal(await invocations(), "", "preparation does not run a probe or delegate");
    const launchRequest = confirmation(prepared, request.dark_opt_in);

    if (scenario === "success") {
      const checkPath = join(repository, "acceptance.test.mjs");
      const bytes = await readFile(checkPath);
      await writeFile(checkPath, Buffer.concat([bytes, Buffer.from("\n// drift\n")]));
      const before = await client().query({});
      const drift = await client().launch(launchRequest);
      assert.equal(drift.schema, "flow.rejection/v1", JSON.stringify(drift));
      assert.equal(drift.code, "feature_test_check_drift", JSON.stringify(drift));
      assert.deepEqual((await client().query({})).runs, before.runs);
      assert.equal(await invocations(), "");
      rejected.push(drift);
      await writeFile(checkPath, bytes);
    }

    const launched = await client().launch(launchRequest);
    await retain(`${scenario}-launch`, { launched });
    assert.equal(launched.schema, "flow.launch-receipt/v1", JSON.stringify(launched));
    let checkRestart;
    if (scenario === "check-restart") {
      const checks = join(ownerEnv.FLOW_AUTHORITY_DIRECTORY, "feature-test-checks");
      let checkRoot;
      await waitFor(async () => {
        let directories;
        try { directories = await readdir(checks); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
        for (const directory of directories) {
          try { await readFile(join(checks, directory, "reservation.json")); checkRoot = join(checks, directory); return true; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return false;
      });
      const reservation = await readFile(join(checkRoot, "reservation.json"));
      await assert.rejects(readFile(join(checkRoot, "terminal.json")), { code: "ENOENT" });
      const before = await client().query({ run_id: launched.run_id });
      assert.equal(before.effects.length, 1);
      assert.equal(before.effects[0].receipt, null);
      assert.equal(before.effects[0].retry.consumed_attempts, 1);
      assert.equal(await invocations(), "");
      const previous = owner;
      const retirement = await fixture.stop(previous);
      assert.equal(retirement.state, "stopped");
      let terminalBytes;
      await waitFor(async () => {
        try { terminalBytes = await readFile(join(checkRoot, "terminal.json")); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
      });
      const terminal = JSON.parse(terminalBytes);
      assert.equal(terminal.retired, true);
      assert.equal(terminal.proof, "linux_subreaper_echild");
      assert.equal(terminal.checks[0].events[0].kind, "pass");
      assert.equal(terminal.checks[1].events[0].kind, "fail");
      assert.equal(await invocations(), "");
      owner = await fixture.start();
      checkRestart = { checkRoot, before, previous, retirement, replacement: owner, reservation: JSON.parse(reservation), terminal, reservation_sha256: sha256(reservation), terminal_sha256: sha256(terminalBytes) };
      await retain(`${scenario}-checker-takeover`, { checkRestart });
    }
    try {
      await waitFor(async () => (await invocations()).includes("apply\n"));
    } catch (error) {
      await retain(`${scenario}-writer-block`, { projection: await client().query({ run_id: launched.run_id }), invocations: await invocations() });
      throw error;
    }
    const active = await client().query({ run_id: launched.run_id });
    await retain(`${scenario}-active`, { active });
    assert.equal(active.phase, "active", JSON.stringify(active));
    const red = active.effects.find(effect => effect.receipt?.provider_receipt?.schema === "work.feature-test-receipt/v1");
    assert.ok(red, JSON.stringify(active.effects));
    assert.equal(red.receipt.provider_receipt.outcome, "expected_failure");
    assert.equal(red.receipt.provider_receipt.environment_status, "healthy");
    assert.equal(git(["rev-parse", "HEAD"]), initial);
    assert.equal(await readFile(join(repository, "feature.txt"), "utf8"), "before\n");
    assert.equal(await invocations(), "apply\n");
    if (checkRestart !== undefined) {
      assert.equal(active.effects.find(effect => effect.effect_id === checkRestart.before.effects[0].effect_id).retry.consumed_attempts, 1);
      assert.equal(sha256(await readFile(join(checkRestart.checkRoot, "reservation.json"))), checkRestart.reservation_sha256);
      assert.equal(sha256(await readFile(join(checkRestart.checkRoot, "terminal.json"))), checkRestart.terminal_sha256);
      assert.equal((await readdir(join(ownerEnv.FLOW_AUTHORITY_DIRECTORY, "feature-test-checks"))).length, 1);
      const events = inspectEffectEvents(ownerEnv.FLOW_AUTHORITY_DIRECTORY, launched.run_id);
      const original = events.find(event => event.type === "effect_intent_recorded").intent;
      const adopted = events.find(event => event.type === "effect_intent_adopted").intent;
      const identity = ({ authority_epoch: _epoch, authority_boot_id: _boot, ...value }) => value;
      assert.deepEqual(identity(adopted), identity(original));
      assert.equal(adopted.authority_epoch, original.authority_epoch + 1);
      assert.equal(adopted.authority_boot_id, original.authority_boot_id);
      assert.equal(events.filter(event => event.type === "effect_invocation_started" && event.effect_id === original.effect_id).length, 1);
      assert.equal(events.filter(event => event.type === "effect_invocation_resumed" && event.effect_id === original.effect_id).length, 1);
      checkRestart = { ...checkRestart, events, original, adopted };
    }
    const workspaceId = prepared.graph.cards.find(card => card.executor.contract === "flow.operation/feature-direct-commit/v1").inputs.workspace.subject_id;
    const workspaceBefore = inspectWorkspace(ownerEnv.FLOW_AUTHORITY_DIRECTORY, workspaceId);
    assert.ok(workspaceBefore.claims.some(claim => claim.holder === launched.run_id));

    let restart;
    if (scenario === "restart") {
      const previous = owner;
      const retirement = await fixture.stop(previous);
      assert.equal(retirement.state, "stopped", JSON.stringify(retirement));
      owner = await fixture.start();
      assert.notEqual(owner.pid, previous.pid);
      const recovered = await client().query({ run_id: launched.run_id });
      const workspaceAfter = inspectWorkspace(ownerEnv.FLOW_AUTHORITY_DIRECTORY, workspaceId);
      assert.ok(workspaceAfter.claims.some(claim => claim.holder === launched.run_id));
      assert.equal(recovered.run_id, launched.run_id);
      assert.deepEqual(recovered.effects.map(({ effect_id }) => effect_id), active.effects.map(({ effect_id }) => effect_id));
      assert.equal(await invocations(), "apply\n", "owner replacement adopts the existing writer");
      restart = { previous, retirement, replacement: owner, recovered, workspaceBefore, workspaceAfter };
    }
    await writeFile(join(scratch, "release-writer"), "release\n");
    const completed = await terminal(client(), launched.run_id, scenario);
    await retain(`${scenario}-terminal`, { completed });
    assert.equal(completed.phase, "succeeded", JSON.stringify(completed));
    assert.equal(await invocations(), "apply\ncritique\n");
    assert.notEqual(git(["rev-parse", "HEAD"]), initial);
    assert.equal(git(["status", "--porcelain"]), "");
    assert.equal(await readFile(join(repository, "acceptance.test.mjs"), "utf8"), fixture.acceptanceBytes);
    assert.equal(await readFile(join(repository, "health.test.mjs"), "utf8"), fixture.healthBytes);
    const candidate = await client().query({ contract: "work.review/v1", subject_id: completed.review_candidate_reference.candidate_id });
    assert.equal(candidate.status, "sealed");
    assert.equal(candidate.candidate.git.clean, true);
    assert.equal(candidate.candidate.verification.acceptance_criteria[0].verdict, "passed");
    assert.equal(candidate.candidate.critique.delegate_evidence.card_id, "feature-critique");
    assert.equal(completed.handoffs.length, 1);
    const finalEffects = completed.effects.map(({ effect_id }) => effect_id);
    const writerRetirement = await fixture.stop(owner);
    assert.equal(writerRetirement.state, "stopped", JSON.stringify(writerRetirement));
    owner = await fixture.start();
    const fresh = await client().query({ contract: "work.review/v1", subject_id: candidate.subject_id });
    assert.equal(fresh.candidate_fingerprint, candidate.candidate_fingerprint);
    const freshRun = await client().query({ run_id: launched.run_id });
    assert.equal(freshRun.phase, "succeeded");
    assert.deepEqual(freshRun.effects.map(({ effect_id }) => effect_id), finalEffects);
    assert.equal(await invocations(), "apply\ncritique\n");
    const renderedCandidate = execFileSync(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "query", "--input", JSON.stringify({ contract: "work.review/v1", subject_id: candidate.subject_id }), "--json"], { env: ownerEnv, encoding: "utf8" });
    const renderedRun = execFileSync(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "query", "--input", JSON.stringify({ run_id: launched.run_id }), "--json"], { env: ownerEnv, encoding: "utf8" });
    assert.equal(JSON.parse(renderedCandidate).candidate_fingerprint, candidate.candidate_fingerprint);
    assert.equal(JSON.parse(renderedRun).phase, "succeeded");
    const stopped = await fixture.stop(owner);
    await retain(scenario, { fixture_only: true, native_qualification: "not_run", request, prepared, launched, active, red, rejected, restart, checkRestart, completed, candidate, fresh, freshRun, renderedCandidate, renderedRun, producer_retirement: writerRetirement, final_retirement: stopped, initial, commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), invocations: await invocations() });
    fixture.completed();
  });
}

test("public trusted owner accepts check_id with an embedded recipe and no caller configuration", linuxCheckMechanism, async (t) => {
  const fixture = await createFixture(t, "trusted-factory");
  const owner = await fixture.start();
  const prepared = await publicClient(owner.socket_path).prepare(fixture.request);
  await retain("trusted-factory-preparation", { request: fixture.request, prepared, owner, factory_sha256: sha256(Buffer.from(fixture.factoryBytes)), fixture_only: true, native_qualification: "not_run" });
  assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
  assert.equal(await fixture.invocations(), "");
  const stopped = await fixture.stop(owner);
  assert.equal(stopped.state, "stopped");
  fixture.completed();
});

test("public trusted owner withholds missing or invalid private recipes before dispatch", async (t) => {
  for (const recipe of ["missing", "invalid"]) {
    await t.test(recipe, async (t) => {
      const fixture = await createFixture(t, `factory-${recipe}`, { recipe });
      const owner = await fixture.start();
      const client = publicClient(owner.socket_path);
      const before = await client.query({});
      const rejected = await client.prepare(fixture.request);
      assert.equal(rejected.schema, "flow.rejection/v1", JSON.stringify(rejected));
      assert.equal(rejected.code, "route_unavailable", JSON.stringify(rejected));
      assert.deepEqual((await client.query({})).runs, before.runs);
      assert.equal(await fixture.invocations(), "");
      assert.equal((await fixture.stop(owner)).state, "stopped");
      await retain(`factory-${recipe}`, { fixture_only: true, rejected, owner });
      fixture.completed();
    });
  }
});

test("public owner rejects changed trusted module bytes before runtime construction", async (t) => {
  const fixture = await createFixture(t, "factory-module-drift", { recipe: "missing" });
  const binding = deriveOwnerRuntimeBinding({ env: fixture.ownerEnv });
  await writeFile(fixture.runtimeModule, fixture.factoryBytes + '\nthrow new Error("changed factory executed");\n');
  await assert.rejects(startFlowOwner({ env: {
    ...fixture.ownerEnv, FLOW_OWNER_RUNTIME_BINDING: JSON.stringify(binding),
  } }), { code: "owner_runtime_binding_mismatch" });
  assert.equal(await fixture.invocations(), "");
  await assert.rejects(readFile(join(fixture.ownerEnv.FLOW_AUTHORITY_DIRECTORY, "owner.json")), { code: "ENOENT" });
  await retain("factory-module-drift", { fixture_only: true, binding, code: "owner_runtime_binding_mismatch", dispatched: false });
  fixture.completed();
});

test("public launch rejects a newly provisioned recipe after owner replacement", linuxCheckMechanism, async (t) => {
  const fixture = await createFixture(t, "factory-check-drift");
  let owner = await fixture.start();
  const prepared = await publicClient(owner.socket_path).prepare(fixture.request);
  assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
  assert.equal((await fixture.stop(owner)).state, "stopped");
  const changed = { ...fixture.featureTestCheck, limits: {
    ...fixture.featureTestCheck.limits, timeout_ms: fixture.featureTestCheck.limits.timeout_ms + 1,
  } };
  await writeFile(fixture.runtimeModule, trustedFactorySource(changed));
  owner = await fixture.start();
  const client = publicClient(owner.socket_path);
  const before = await client.query({});
  const rejected = await client.launch(confirmation(prepared, fixture.request.dark_opt_in));
  assert.equal(rejected.schema, "flow.rejection/v1", JSON.stringify(rejected));
  assert.equal(rejected.code, "feature_test_check_drift", JSON.stringify(rejected));
  assert.deepEqual((await client.query({})).runs, before.runs);
  assert.equal(await fixture.invocations(), "");
  assert.equal((await fixture.stop(owner)).state, "stopped");
  await retain("factory-check-drift", { fixture_only: true, prepared, rejected, dispatched: false });
  fixture.completed();
});

function trustedFactorySource(featureTestCheck) {
  return `import { createFlowRuntime as production } from ${JSON.stringify(pathToFileURL(productionRuntimeModule).href)};
import { fixtureExecutionOptions } from ${JSON.stringify(new URL("../test-support/direct-feature-test-runtime.mjs", import.meta.url).href)};
const featureTestCheck = ${JSON.stringify(featureTestCheck, null, 2)};
export function createFlowRuntime(options = {}) {
  return production(fixtureExecutionOptions({ ...options, featureTestCheck }));
}
`;
}

async function createFixture(t, scenario, { recipe = "valid", project = false, checkDelay = 0 } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-feature-test-"));
  let ownerCleanup = async () => {};
  let succeeded = false;
  t.after(async () => {
    try {
      await ownerCleanup();
    } finally {
      if (succeeded) await rm(scratch, { recursive: true, force: true });
      else {
        const stat = await lstat(scratch);
        await retain(`${scenario}-failed-scratch`, { preserved_scratch: { path: scratch, uid: stat.uid, gid: stat.gid, mode: stat.mode, device: stat.dev, inode: stat.ino }, native_qualification: "not_run" });
        const directory = process.env.FLOW_FEATURE_TEST_RECEIPT_DIRECTORY;
        if (directory !== undefined) {
          for (const name of ["feature-test-checks", "direct-tasks", "candidate-commits"]) {
            const source = join(scratch, "authority", name);
            try { await lstat(source); }
            catch (error) { if (error.code === "ENOENT") continue; throw error; }
            await cp(source, join(directory, `${scenario}-${process.pid}-private-${name}`), { recursive: true });
          }
        }
      }
    }
  });
  const repository = join(scratch, "repository");
  await mkdir(repository);
  const gitEnv = { HOME: scratch, PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = args => execFileSync("/usr/bin/git", ["-c", "diff.autoRefreshIndex=false", "-C", repository, ...args], { encoding: "utf8", env: gitEnv }).trim();
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.name", "Flow Fixture"]);
  git(["config", "user.email", "flow@example.test"]);
  const healthBytes = scenario === "check-restart"
    ? 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("positive health probe", async () => { await new Promise(resolve => setTimeout(resolve, 2000)); assert.equal(2 + 2, 4); });\n'
    : 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("positive health probe", () => assert.equal(2 + 2, 4));\n';
  const acceptanceBytes = (checkDelay ? `import {setTimeout as delay} from "node:timers/promises"; process.stdout.write("FLOW_PROJECT_COMMAND_READY\\n"); await delay(${checkDelay});\n` : '') + 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\ntest("selected feature behavior", () => assert.equal(readFileSync("feature.txt", "utf8"), "after\\n"));\n';
  await writeFile(join(repository, "feature.txt"), "before\n");
  await writeFile(join(repository, "health.test.mjs"), healthBytes);
  await writeFile(join(repository, "acceptance.test.mjs"), acceptanceBytes);
  git(["add", "feature.txt", "health.test.mjs", "acceptance.test.mjs"]);
  git(["commit", "--quiet", "-m", "committed acceptance check and health probe"]);
  const initial = git(["rev-parse", "HEAD"]);
  const node = await realpath(process.execPath);
  const runtimeModule = join(scratch, "trusted-feature-test-owner.mjs");
  let featureTestCheck = {
    schema: "flow.production-feature-test-check/v1", check_id: checkId,
    executable: { path: node, version: process.version, sha256: checkDigest(await readFile(node)) },
    health: { path: "health.test.mjs", sha256: checkDigest(healthBytes), case_name: "positive health probe" },
    acceptance: { path: "acceptance.test.mjs", sha256: checkDigest(acceptanceBytes), case_name: "selected feature behavior" },
    pinned_files: [],
    criteria: [criterion], expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "after\n", actual: "before\n" },
    environment: { PATH: "/usr/bin:/bin" }, limits: { timeout_ms: 5000, max_output_bytes: 64 * 1024 },
  };
  if (project) {
    featureTestCheck = { ...projectProfile({ root: repository, argv: ["--test", "acceptance.test.mjs"], files: ["acceptance.test.mjs"] }), check_id: checkId, criteria: [criterion] };
    await writeFile(runtimeModule, trustedFactorySource(featureTestCheck), { flag: "wx", mode: 0o600 });
  } else if (recipe === "valid") {
    // Execute the documented zero-provider preparation, then exercise its
    // generated embedded recipe through the actual detached public owner.
    const guide = await readFile(join(sourceRepository, "docs/flow/operator-guide.md"), "utf8");
    const command = guide.match(/"\$FLOW_CHECK_NODE" --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/u);
    assert.ok(command, "the trusted owner preparation recipe is documented");
    execFileSync(node, ["--input-type=module"], {
      input: command[1], encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, FLOW_RUNTIME_ROOT: sourceRepository,
        FLOW_CHECK_WORKSPACE: repository, FLOW_OWNER_RUNTIME_MODULE: runtimeModule },
    });
  } else {
    const selectedCheck = recipe === "missing" ? undefined
      : { ...featureTestCheck, environment: { PATH: "/caller/bin" } };
    await writeFile(runtimeModule, trustedFactorySource(selectedCheck), { flag: "wx", mode: 0o600 });
  }
  // Keep the documented generated factory intact. A private, digest-bound test
  // wrapper supplies an explicit fixture adapter through trusted construction.
  const documentedFactory = `${runtimeModule}.prepared.mjs`;
  await rename(runtimeModule, documentedFactory);
  const documentedBytes = await readFile(documentedFactory);
  const fixtureOptionsModule = pathToFileURL(fileURLToPath(new URL("../test-support/direct-feature-test-runtime.mjs", import.meta.url))).href;
  await writeFile(runtimeModule, `import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixtureExecutionOptions } from ${JSON.stringify(fixtureOptionsModule)};
const original = ${JSON.stringify(documentedFactory)};
if (createHash("sha256").update(readFileSync(original)).digest("hex") !== ${JSON.stringify(sha256(documentedBytes))}) throw new Error("fixture_factory_drift");
const { createFlowRuntime: documented } = await import(${JSON.stringify(pathToFileURL(documentedFactory).href)});
export function createFlowRuntime(options = {}) { return documented({ ...fixtureExecutionOptions(options),
  ${scenario === "project-cancel-crash" ? `authorityOptions: { ...options.authorityOptions, afterCancellationCommit() { writeFileSync(${JSON.stringify(join(scratch, "cancel-committed"))}, "committed\\n"); process.exit(71); } },` : ""}
}); }
`, { flag: "wx", mode: 0o600 });
  const factoryBytes = await readFile(runtimeModule, "utf8");
  const invocationPath = join(scratch, "invocations");
  const executable = join(scratch, "codex-fixture");
  await writeFile(executable, delegateFixture({ invocationPath, releasePath: join(scratch, "release-writer") }));
  await chmod(executable, 0o700);
  const configDirectory = join(scratch, "config");
  await cp(sourceConfig, configDirectory, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  await copiedTestRelease(configDirectory);
  await bindQualifiedReleaseFixture({ configDirectory, repositoryRoot: sourceRepository });
  const ownerEnv = { HOME: scratch, PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "0", FLOW_REPOSITORY_ROOT: repository, FLOW_AUTHORITY_DIRECTORY: join(scratch, "authority"), FLOW_CONFIG_DIRECTORY: configDirectory, FLOW_QUALIFICATION_REPOSITORY_ROOT: sourceRepository, FLOW_EXECUTION_BACKEND: "direct", FLOW_CODEX_EXECUTABLE: executable, FLOW_OWNER_RUNTIME_MODULE: runtimeModule };
  const owners = [];
  const retirements = [];
  const stop = async owner => {
    const retirement = await stopFlowOwner({ env: ownerEnv, pid: owner.pid, processStartIdentity: owner.process_start_identity, waitMs: 3000, force: true });
    retirements.push({ pid: owner.pid, identity: owner.process_start_identity, retirement });
    return retirement;
  };
  ownerCleanup = async () => {
    await writeFile(join(scratch, "release-writer"), "release\n");
    for (const owner of owners) {
      if (!retirements.some(value => value.pid === owner.pid && value.retirement.state === "stopped")) assert.equal((await stop(owner)).state, "stopped");
    }
    await retain(`${scenario}-retirement`, { retirements });
  };
  const request = { schema: "flow.feature-preparation-request/v1", dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: fixtureRelease, purpose: "sacrificial_qualification" }, brief: { schema: "flow.feature-brief/v1", id: `brief:test-${scenario}`, summary: "Change feature.txt to after", acceptance: [criterion] }, repository, mode: project ? "verify" : "test", ...(project ? { check: { check_id: checkId } } : { test: { check_id: checkId } }), routes: { apply: { harness: "codex", model: "fixture-model", effort: "high", capability: "workspace-write-denied" }, critique: { harness: "codex", model: "fixture-model", effort: "high", capability: "read-only" } } };
  return { scratch, repository, git, initial, ownerEnv, configDirectory, runtimeModule, factoryBytes, featureTestCheck, request, acceptanceBytes, healthBytes, completed: () => { succeeded = true; }, invocations: () => readFile(invocationPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }), start: async () => { const owner = await startFlowOwner({ env: ownerEnv }); assert.equal(owner.state, "running", JSON.stringify(owner)); owners.push(owner); return owner; }, stop };
}

async function copiedTestRelease(directory) {
  const read = async name => JSON.parse(await readFile(join(directory, name), "utf8"));
  const write = (name, value) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  const manifest = JSON.parse(await readFile(join(sourceConfig, "releases/1.1-dark-test/release-manifest.v1.json"), "utf8"));
  assert.equal(manifest.release_id, fixtureRelease);
  await write("release-manifest.v1.json", manifest);
  const manifestSha = sha256(await readFile(join(directory, "release-manifest.v1.json")));
  const policy = await read("launch-policy.v1.json");
  policy.implementations["flow-runtime/v1"].dark_opt_in.manifest_sha256 = manifestSha;
  await write("launch-policy.v1.json", policy);
  const ledger = await read("transition-ledger.v1.json");
  ledger.release.id = fixtureRelease;
  ledger.capability_manifest.release_id = fixtureRelease;
  ledger.capability_manifest.sha256 = manifestSha;
  ledger.decision.dark_opt_in_release_id = fixtureRelease;
  ledger.routes.supported = manifest.supported_routes.map(({ flow, mode }) => ({ flow, mode }));
  ledger.evidence.find(({ id }) => id === "legacy_default_policy").sha256 = sha256(await readFile(join(directory, "launch-policy.v1.json")));
  await write("transition-ledger.v1.json", ledger);
  const content = await read("evidence/release-content.v1.json");
  content.release_id = fixtureRelease;
  await write("evidence/release-content.v1.json", content);
  const qualification = await read("evidence/release-qualification.v1.json");
  qualification.routes.supported = ledger.routes.supported;
  qualification.routes.negative_classes = manifest.disabled_routes.map(({ flow, mode, outcome }) => ({ flow, mode, outcome }));
  await write("evidence/release-qualification.v1.json", qualification);
}

function delegateFixture({ invocationPath, releasePath }) {
  return `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
if(process.argv[2]==="--version"){console.log("codex-cli 0.160.0");process.exit(0);}
const task=JSON.parse(readFileSync(0,"utf8")).task_inputs;
appendFileSync(${JSON.stringify(invocationPath)},task.phase+"\\n");
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>"sha256:"+createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const evidence={kind:"git_file_equals",target:"feature.txt",expected:"after\\n"};
const output={schema:"flow.delegate-evidence/v1",observation:"actual owned fixture file observation"};
if(task.phase==="apply") {while(!existsSync(${JSON.stringify(releasePath)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);writeFileSync("feature.txt","after\\n");output.feature_evidence={schema:"flow.feature-criterion-evidence/v1",criteria:task.brief.acceptance.map(criterion=>({criterion,...evidence}))};}
else {if(readFileSync("feature.txt","utf8")!=="after\\n")process.exit(17);output.feature_critique={schema:"flow.feature-critique-output/v1",candidate_digest:task.candidate_digest,predecessor_evidence_digest:task.predecessor_evidence_digest,task_inputs_digest:digest(task),criteria:task.brief.acceptance.map(criterion=>({criterion,evidence,evidence_digest:digest({criterion,evidence,verdict:"passed"}),verdict:"passed"})),findings:[]};}
const text=JSON.stringify(output);writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],text);
for(const event of [{type:"thread.started",thread_id:"thread-"+task.phase},{type:"turn.started"},{type:"item.completed",item:{id:"final",type:"agent_message",text}},{type:"turn.completed",usage:{}}])console.log(JSON.stringify(event));
`;
}

function publicClient(socketPath) {
  return Object.fromEntries(["prepare", "launch", "command", "query"].map(operation => [operation, request => requestFlowTransport({ socketPath, operation, request })]));
}

function inspectWorkspace(authorityDirectory, subject_id) {
  const authority = createDurableRunAuthority({ authorityDirectory, access: "inspect" });
  try {
    return getWorkspaceAuthority({ runAuthority: authority }).query({ contract: "work.workspace/v1", subject_id });
  } finally {
    authority.close();
  }
}

function confirmation(prepared, dark_opt_in) {
  return { prepared, dark_opt_in, confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest }, closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: structuredClone(prepared.explicit_facts) } };
}

async function waitFor(observe) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await observe()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail("public feature test did not reach its expected state within ten seconds");
}

async function terminal(client, run_id, scenario) {
  let value;
  try {
    await waitFor(async () => { value = await client.query({ run_id }); return ["succeeded", "failed", "cancelled"].includes(value.phase); });
  } catch (error) {
    await retain(`${scenario}-last-projection`, { completed: value });
    throw error;
  }
  return value;
}

async function retain(name, value) {
  const directory = process.env.FLOW_FEATURE_TEST_RECEIPT_DIRECTORY;
  if (directory === undefined) return;
  assert.equal(isAbsolute(directory), true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prefix = `${name}-${process.pid}`;
  await writeFile(join(directory, `${prefix}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  for (const key of ["prepared", "launched", "active", "red", "completed", "candidate", "fresh", "freshRun"]) {
    if (value[key] !== undefined) await writeFile(join(directory, `${prefix}-${key}.json`), `${JSON.stringify(value[key])}\n`, { mode: 0o600 });
  }
  for (const key of ["renderedCandidate", "renderedRun"]) {
    if (value[key] !== undefined) await writeFile(join(directory, `${prefix}-${key}.json`), value[key], { mode: 0o600 });
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function checkDigest(value) { return `sha256:${sha256(value)}`; }

function inspectEffectEvents(authorityDirectory, runId) {
  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT payload_json FROM authority_events WHERE stream_id = ? ORDER BY sequence").all(runId).map(row => JSON.parse(row.payload_json)); }
  finally { database.close(); }
}

for (const scenario of ["success", "restart", "cancel", "cancel-crash"]) {
  test(`public project check GREEN-only ${scenario} retains exact candidate and one owned checker`, linuxCheckMechanism, async t => {
    const f = await createFixture(t, `project-${scenario}`, { project: true, checkDelay: scenario.startsWith("cancel") ? 20000 : scenario === "restart" ? 1500 : 0 });
    let owner = await f.start();
    const client = () => publicClient(owner.socket_path);
    const prepared = await client().prepare(f.request);
    assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
    assert.equal(prepared.selection.inputs.project_check.registration.argv[0], "--test");
    assert.equal(prepared.graph.cards.some(card => card.executor.contract === "flow.operation/feature-test/v1"), false);
    const check = prepared.graph.cards.find(card => card.id === "feature-project-check");
    assert.deepEqual(check.dependencies, ["feature-capture"]);
    assert.equal(check.executor.effect_classification, "reconcilable");
    assert.equal(await f.invocations(), "", "prepare does not run the project suite or delegates");
    if (scenario === "success") {
      const path = join(f.repository, "acceptance.test.mjs"), original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from("\n// drift\n")]));
      const rejected = await client().launch(confirmation(prepared, f.request.dark_opt_in));
      assert.equal(rejected.code, "project_check_input_drift", JSON.stringify(rejected));
      assert.equal(await f.invocations(), "");
      await writeFile(path, original);
    }
    await writeFile(join(f.scratch, "release-writer"), "release\n");
    const launched = await client().launch(confirmation(prepared, f.request.dark_opt_in));
    assert.equal(launched.created, true, JSON.stringify(launched));
    const base = join(f.ownerEnv.FLOW_AUTHORITY_DIRECTORY, "project-checks-v2");
    let checkRoot, reservation;
    await waitFor(async () => {
      const dirs = await readdir(base).catch(() => []);
      if (dirs.length !== 1) return false;
      checkRoot = join(base, dirs[0]);
      reservation = await readFile(join(checkRoot, "reservation.json")).catch(() => null);
      return reservation && await readFile(join(checkRoot, "worker.json")).catch(() => null);
    });
    if (scenario !== "success") {
      await waitFor(async () => (await readFile(join(checkRoot, "command.live.stdout"), "utf8").catch(() => "")).includes("FLOW_PROJECT_COMMAND_READY"));
    }
    if (scenario === "restart") {
      assert.equal((await f.stop(owner)).state, "stopped");
      owner = await f.start();
    }
    if (scenario.startsWith("cancel")) {
      const active = await client().query({ run_id: launched.run_id });
      const action = active.legal_actions.find(action => action.type === "cancel");
      assert.ok(action, JSON.stringify(active));
      if (scenario === "cancel-crash") {
        await assert.rejects(client().command(action));
        assert.equal(await readFile(join(f.scratch, "cancel-committed"), "utf8"), "committed\n");
        assert.equal((await f.stop(owner)).state, "stopped");
        owner = await f.start();
      } else assert.equal((await client().command(action)).accepted, true);
      await waitFor(async () => {
        const run = await client().query({ run_id: launched.run_id });
        return run.effects.find(effect => effect.operation_contract === "flow.operation/project-check/v2")?.receipt;
      });
      const run = await client().query({ run_id: launched.run_id });
      assert.equal(run.phase, "cancelled");
      const result = run.effects.find(effect => effect.operation_contract === "flow.operation/project-check/v2").receipt;
      assert.equal(result.outcome, "not_created");
      assert.equal(result.provider_receipt.record.outcome, "cancelled");
      assert.equal(result.provider_receipt.record.retired, true);
      assert.equal(run.review_candidate_reference ?? null, null);
      assert.equal(await f.invocations(), "apply\n");
    } else {
      const run = await terminal(client(), launched.run_id, `project-${scenario}`);
      assert.equal(run.phase, "succeeded", JSON.stringify(run));
      const result = run.effects.find(effect => effect.operation_contract === "flow.operation/project-check/v2").receipt.provider_receipt;
      assert.equal(result.outcome, "passed");
      assert.equal(result.exit_code, 0);
      assert.equal(result.test_count, "unknown");
      assert.equal(result.retired, true);
      assert.equal(result.candidate.commit_sha, f.git(["rev-parse", "HEAD"]));
      assert.equal(await f.invocations(), "apply\ncritique\n");
      const candidate = await client().query({ contract: "work.review/v1", subject_id: run.review_candidate_reference.candidate_id });
      assert.equal(candidate.status, "sealed");
    }
    assert.equal(await readFile(join(checkRoot, "reservation.json"), "utf8"), reservation.toString());
    assert.equal((await readdir(base)).length, 1);
    assert.equal((await f.stop(owner)).state, "stopped");
    owner = await f.start();
    const reopened = await client().query({ run_id: launched.run_id });
    assert.equal(reopened.phase, scenario.startsWith("cancel") ? "cancelled" : "succeeded");
    assert.equal((await readdir(base)).length, 1);
    assert.equal((await f.stop(owner)).state, "stopped");
    f.completed();
  });
}
