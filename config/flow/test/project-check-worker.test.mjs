import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectCheckRunner } from "../src/production-project-check-runner.mjs";
import { initializeProject, projectProfile, bindProject, projectIntent, projectToolPaths } from "../test-support/project-check.mjs";

function fixture(files, profile = {}) {
  const root = mkdtempSync(join(tmpdir(), "flow-project-worker-"));
  const workspace = initializeProject(join(root, "repo"), files);
  const config = projectProfile({ root: workspace.path, ...profile });
  const binding = bindProject(config, workspace);
  const intent = projectIntent(binding);
  const authorityDirectory = join(root, "authority"); mkdirSync(authorityDirectory);
  return { root, workspace, binding, intent, runner: createProjectCheckRunner({ authorityDirectory }), authorityDirectory };
}
function passed(result) {
  assert.equal(result.terminal.outcome, "passed", JSON.stringify(result.terminal));
  assert.equal(result.terminal.exit_code, 0);
  assert.equal(result.terminal.retired, true);
  assert.equal(result.terminal.proof, "linux_subreaper_echild");
}
const waitFor = async condition => { const until = Date.now() + 10000; while (!condition()) { if (Date.now() > until) throw Error("fixture_worker_not_started"); await new Promise(resolve => setTimeout(resolve, 10)); } };

describe("Linux registered project check worker", { skip: process.platform !== "linux" && "Linux containment mechanism; this skip is not macOS qualification" }, () => {
test("registered npm test runs a real suite with private caches and no host home/network/write authority", async () => {
  const f = fixture({ "package.json": JSON.stringify({ scripts: { test: "node --test suite.mjs" } }), "suite.mjs": `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net';
    test('bounded scratch',()=>{for(const [path,bytes] of [['/scratch',536870912],['/tmp',67108864]]){const stat=fs.statfsSync(path);assert.equal(stat.bsize*stat.blocks,bytes);}});
    test('ordinary behavior',()=>assert.equal([2,4,6].reduce((a,b)=>a+b),12));
    test('isolated environment',()=>{assert.equal(process.env.HOME,'/scratch/home');assert.equal(process.env.NPM_CONFIG_CACHE,'/scratch/npm');assert.throws(()=>fs.writeFileSync('/workspace/escape','bad'));assert.throws(()=>fs.writeFileSync('/unbounded-root-cache','bad'));assert.throws(()=>fs.writeFileSync('/dev/unbounded-cache','bad'));assert.throws(()=>fs.writeFileSync('/dev/shm/unbounded-cache','bad'));assert.throws(()=>fs.readFileSync('${process.env.HOME}/.codex/auth.json'));assert.equal(fs.existsSync('/etc/passwd'),false);});
    test('network isolated',async()=>{await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:1});s.on('connect',()=>{s.destroy();throw Error('external network reachable');});s.on('error',error=>{assert.ok(['ENETUNREACH','EHOSTUNREACH'].includes(error.code),error.code);resolve();});s.setTimeout(500,()=>{s.destroy();throw Error('network outcome unknown');});});});` }, { tool: "npm", files: ["package.json", "suite.mjs"] });
  const result = await f.runner.run(f.intent, f.workspace, f.binding); passed(result);
  assert.match(readFileSync(join(result.root, "command.stdout"), "utf8"), /tests 4/u);
  assert.equal(existsSync(join(f.workspace.path, "escape")), false);
  assert.deepEqual(f.runner.read(f.intent), result);
});

test("registered Python unittest suite executes offline", { skip: projectToolPaths.python ? false : "installed Python unavailable" }, async () => {
  const f = fixture({ "test_numbers.py": "import unittest\nclass Numbers(unittest.TestCase):\n def test_sum(self): self.assertEqual(sum([2, 4, 6]), 12)\n def test_filter(self): self.assertEqual(list(filter(lambda x: x > 3, [2,4,6])), [4,6])\n" }, { tool: "python", files: ["test_numbers.py"] });
  const result = await f.runner.run(f.intent, f.workspace, f.binding); passed(result);
  assert.match(readFileSync(join(result.root, "command.stderr"), "utf8"), /Ran 2 tests/u);
});

test("registered Go test suite compiles and runs offline with private scratch caches", { skip: projectToolPaths.go ? false : "installed Go unavailable" }, async () => {
  const f = fixture({ "go.mod": "module example.invalid/flow-fixture\n\ngo 1.26\n", "sum.go": "package fixture\nfunc Sum(xs []int) int { n:=0; for _, x:=range xs { n+=x }; return n }\n", "sum_test.go": 'package fixture\nimport "testing"\nfunc TestSum(t *testing.T) { if Sum([]int{2,4,6}) != 12 { t.Fatal("sum") } }\n' }, { tool: "go", files: ["go.mod", "sum_test.go"], timeout: 120000 });
  const result = await f.runner.run(f.intent, f.workspace, f.binding); passed(result);
  assert.match(readFileSync(join(result.root, "command.stdout"), "utf8"), /ok\s+example.invalid\/flow-fixture/u);
});

test("nonzero suite, timeout, and bounded output are distinct retired outcomes", async () => {
  for (const [script, expected, options] of [
    ["process.exit(7)", "failed", {}],
    ["setTimeout(()=>{},60000)", "timeout", { timeout: 150 }],
    ["process.stdout.write('x'.repeat(100000))", "output_limit", { output: 1024 }],
  ]) {
    const f = fixture({ "suite.mjs": script }, { argv: ["suite.mjs"], ...options });
    const result = await f.runner.run(f.intent, f.workspace, f.binding);
    assert.equal(result.terminal.outcome, expected, JSON.stringify(result.terminal));
    assert.equal(result.terminal.retired, true);
    if (expected === "failed") assert.equal(result.terminal.exit_code, 7);
    if (expected === "timeout") assert.notEqual(result.terminal.exit_code, 0);
    assert.ok(readFileSync(join(result.root, "command.stdout")).length <= f.binding.registration.limits.max_output_bytes);
  }
});

test("same pending reservation is adopted and cancelled by exact run/effect, never replayed", async () => {
  const f = fixture({ "suite.mjs": "import fs from 'node:fs'; console.log('suite-started'); setTimeout(()=>{},60000);" }, { argv: ["suite.mjs"] });
  const first = f.runner.run(f.intent, f.workspace, f.binding);
  const base = join(f.authorityDirectory, "project-checks-v2");
  let effectRoot;
  await waitFor(() => { const dirs = existsSync(base) ? readdirSync(base) : []; effectRoot = dirs[0] && join(base, dirs[0]); return effectRoot && existsSync(join(effectRoot, "command.live.stdout")) && readFileSync(join(effectRoot, "command.live.stdout"), "utf8").includes("suite-started"); });
  const witness = readFileSync(join(effectRoot, "worker.json"), "utf8");
  const restarted = createProjectCheckRunner({ authorityDirectory: f.authorityDirectory });
  const adopted = restarted.run({ ...f.intent, authority_epoch: 9, authority_boot_id: "next-owner" }, f.workspace, f.binding);
  assert.equal(restarted.requestCancellation({ run_id: f.intent.run_id, effect_id: "another-effect" }), false);
  assert.equal(restarted.requestCancellation(f.intent), true);
  const [a, b] = await Promise.all([first, adopted]);
  assert.equal(a.terminal.outcome, "cancelled"); assert.notEqual(a.terminal.exit_code, 0); assert.deepEqual(a, b);
  assert.equal(readFileSync(join(effectRoot, "worker.json"), "utf8"), witness);
  assert.equal(restarted.requestCancellation(f.intent), false);
  await waitFor(() => { try { process.kill(a.terminal.owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
});

test("descendant escaping session is positively retired before successful terminal", async () => {
  const f = fixture({ "suite.mjs": "import {spawn} from 'node:child_process'; const p=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});p.unref(); console.log('spawned');" }, { argv: ["suite.mjs"] });
  const result = await f.runner.run(f.intent, f.workspace, f.binding); passed(result);
  assert.match(readFileSync(join(result.root, "command.stdout"), "utf8"), /spawned/u);
});

test("input drift and evidence tampering fail closed without redispatch", async () => {
  const f = fixture({ "suite.mjs": "console.log('passed')" }, { argv: ["suite.mjs"] });
  writeFileSync(join(f.workspace.path, "suite.mjs"), "process.exit(0)");
  await assert.rejects(f.runner.run(f.intent, f.workspace, f.binding), { code: "project_check_input_drift" });
  const clean = fixture({ "suite.mjs": "console.log('passed')" }, { argv: ["suite.mjs"] });
  const result = await clean.runner.run(clean.intent, clean.workspace, clean.binding); passed(result);
  writeFileSync(join(result.root, "command.stdout"), "altered evidence");
  assert.throws(() => clean.runner.read(clean.intent), { code: "project_check_evidence_conflict" });
  await assert.rejects(clean.runner.run(clean.intent, clean.workspace, clean.binding), { code: "project_check_evidence_conflict" });
});


test("committed snapshot excludes ignored secrets and preserves the exact committed suite", async () => {
  const f = fixture({ "suite.mjs": "import fs from 'node:fs'; if(fs.existsSync('/workspace/ignored-secret')) process.exit(8);console.log('committed-only');" }, { argv: ["suite.mjs"] });
  writeFileSync(join(f.workspace.path, "ignored-secret"), "synthetic sentinel, never mounted");
  const result = await f.runner.run(f.intent, f.workspace, f.binding); passed(result);
  assert.notEqual(result.reservation.workspace, f.workspace.path);
  assert.equal(existsSync(join(result.reservation.workspace, "ignored-secret")), false);
  assert.equal(readFileSync(join(result.reservation.workspace, "suite.mjs"), "utf8"), readFileSync(join(f.workspace.path, "suite.mjs"), "utf8"));
  assert.equal(readFileSync(join(f.workspace.path, "ignored-secret"), "utf8"), "synthetic sentinel, never mounted");
});

test("accepted cancellation before worker startup suppresses the command and remains durable", async () => {
  const f = fixture({ "suite.mjs": "import fs from 'node:fs';console.log('command-must-not-start');fs.writeFileSync('/scratch/should-not-start','bad');" }, { argv: ["suite.mjs"] });
  const pending = f.runner.run(f.intent, f.workspace, f.binding);
  assert.equal(f.runner.requestCancellation(f.intent), true);
  const result = await pending;
  assert.equal(result.terminal.outcome, "cancelled");
  assert.equal(result.terminal.retired, true);
  assert.equal(readFileSync(join(result.root, "command.stdout"), "utf8"), "");
});

test("actual authority overlap, including a symlinked state alias, is rejected before reading private sentinels", async () => {
  const f = fixture({ "suite.mjs": "process.exit(0)" }, { argv: ["suite.mjs"] });
  const { digest } = await import("../../../tools/flow/src/canonical.mjs");
  const { projectInputDigest } = await import("../src/production-project-check.mjs");
  writeFileSync(join(f.authorityDirectory, "sentinel"), "synthetic authority");
  const registration = { ...f.binding.registration, read_mounts: [...f.binding.registration.read_mounts, { source: f.authorityDirectory, target: "/runtime/private", sha256: projectInputDigest(f.authorityDirectory) }] };
  const { fingerprint, ...identity } = f.binding;
  const changed = { ...identity, registration };
  const binding = { ...changed, fingerprint: digest(changed) };
  await assert.rejects(f.runner.run(projectIntent(binding), f.workspace, binding), { code: "project_check_private_input" });
  const alias = join(f.root, "state-alias"); symlinkSync(f.authorityDirectory, alias, "dir");
  const aliased = createProjectCheckRunner({ authorityDirectory: alias });
  await assert.rejects(aliased.run(projectIntent(binding), f.workspace, binding), { code: "project_check_private_input" });
  assert.equal(existsSync(join(f.authorityDirectory, "project-checks-v2")), false);
});


test("explicit ignored installed dependency remains visible above the committed snapshot", async () => {
  const f = fixture({ "suite.mjs": "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);if(require('semver').valid('1.2.3')!=='1.2.3')process.exit(7);console.log('dependency-loaded');" }, { argv: ["suite.mjs"] });
  const dependency = join(f.workspace.path, "node_modules/semver");
  mkdirSync(join(f.workspace.path, "node_modules"));
  cpSync(join(projectToolPaths.npm, "node_modules/semver"), dependency, { recursive: true });
  const { projectInputDigest } = await import("../src/production-project-check.mjs");
  const config = { ...f.binding.registration, read_mounts: [...f.binding.registration.read_mounts, { source: dependency, target: "/workspace/node_modules/semver", sha256: projectInputDigest(dependency) }] };
  const binding = bindProject(config, f.workspace), intent = projectIntent(binding);
  const result = await f.runner.run(intent, f.workspace, binding); passed(result);
  assert.match(readFileSync(join(result.root, "command.stdout"), "utf8"), /dependency-loaded/u);
  assert.deepEqual(readdirSync(join(result.reservation.workspace, "node_modules/semver")), []);
});


test("version probing has its own five-second ceiling before the longer suite budget", async () => {
  const f = fixture({ "suite.mjs": "console.log('suite-must-not-start')" }, { argv: ["suite.mjs"], versionArgv: ["-e", "setTimeout(()=>{},60000)"], timeout: 30000 });
  const started = Date.now();
  const result = await f.runner.run(f.intent, f.workspace, f.binding);
  assert.equal(result.terminal.outcome, "timeout");
  assert.equal(result.terminal.version, null);
  assert.equal(result.terminal.retired, true);
  assert.equal(readFileSync(join(result.root, "command.stdout"), "utf8"), "");
  assert.ok(Date.now() - started < 15000, "version stage used the full thirty-second suite budget");
});

});
