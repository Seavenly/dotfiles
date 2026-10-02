// Behavioral tests for config/claude/scripts/feature-flow-gate.js and the
// builder guard hook, driven through their command-line interfaces against
// scratch git repositories.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const gateScript = path.join(root, "config/claude/scripts/feature-flow-gate.js");
const guardScript = path.join(root, "config/claude/scripts/feature-flow-builder-guard.js");

function sh(cwd, cmd) {
  return execFileSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

function fixture(t, config = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-gate-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const wt = path.join(runDir, "worktree");
  fs.mkdirSync(wt);
  sh(wt, "git init -q -b main && git config user.email t@example.com && git config user.name Test && git config commit.gpgsign false");
  fs.writeFileSync(path.join(wt, "src.txt"), "ok\n");
  fs.mkdirSync(path.join(wt, "tests"));
  fs.writeFileSync(path.join(wt, "tests", "old.test.js"), "expect(old).toBe(1)\n");
  fs.writeFileSync(path.join(wt, ".gitignore"), "node_modules/\n");
  sh(wt, "git add -A && git commit -q -m base && git checkout -q -b agt/feature-x");
  const gate = {
    worktree: wt, branch: "agt/feature-x", commitPrefix: "ABC-1: ",
    staticCmds: ["true"],
    suiteCmd: "! grep -q FAIL src.txt",
    verifyCmds: [],
    focusedTestCmd: "! grep -q TODO {files}",
    ignorePaths: ["coverage/**"],
    timeoutSec: 20,
    ...config,
  };
  fs.writeFileSync(path.join(runDir, "gate.json"), JSON.stringify(gate, null, 2));
  return { runDir, wt };
}

function gate(runDir, ...args) {
  const res = spawnSync(process.execPath, [gateScript, args[0], runDir, ...args.slice(1)], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function write(wt, rel, content) {
  fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  fs.writeFileSync(path.join(wt, rel), content);
}

function log(wt) {
  return sh(wt, "git log --format=%s main..HEAD").split("\n").filter(Boolean);
}

test("init records the base and baselines every command", (t) => {
  const { runDir } = fixture(t);
  const r = gate(runDir, "init");
  assert.equal(r.ok, true);
  assert.equal(r.baseline.length, 2);
  assert.ok(r.baseline.every((c) => c.exit === 0));
});

test("init refuses a red base", (t) => {
  const { runDir, wt } = fixture(t);
  sh(wt, "git checkout -q main && echo FAIL > src.txt && git commit -qam red && git checkout -q agt/feature-x && git reset -q --hard main");
  const r = gate(runDir, "init");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "baseline-red");
});

test("a builder self-commit on green is folded into one gate commit", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  write(wt, "tests/new.test.js", "// TODO: red until implemented\nexpect(feature()).toBe(2)\n");
  assert.equal(gate(runDir, "red", "--slice", "1", "--tests", "tests/new.test.js").ok, true);
  write(wt, "feature.txt", "done\n");
  sh(wt, "git add -A && git commit -q -m 'implementer did this'");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "Add the feature", "--mode", "test");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.folded.map((l) => l.replace(/^\S+ /, "")), ["implementer did this"]);
  assert.deepEqual(log(wt), ["ABC-1: Add the feature"]);
  assert.equal(gate(runDir, "audit").ok, true);
});

test("a failing gate removes unverified self-commits from history but keeps the work", (t) => {
  const { runDir, wt } = fixture(t);
  const init = gate(runDir, "init");
  write(wt, "src.txt", "FAIL\n");
  sh(wt, "git add -A && git commit -q -m 'broken self-commit'");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "Change", "--mode", "verify");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "command-failed");
  assert.equal(r.command, "! grep -q FAIL src.txt");
  assert.equal(sh(wt, "git rev-parse HEAD"), init.baseSha);
  assert.equal(fs.readFileSync(path.join(wt, "src.txt"), "utf8"), "FAIL\n");
  assert.deepEqual(log(wt), []);
});

test("rewritten history is folded instead of dead-ending the slice", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  write(wt, "a.txt", "a\n");
  assert.equal(gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify").ok, true);
  write(wt, "b.txt", "b\n");
  sh(wt, "git add -A && git commit -q --amend -m 'amended'");
  const r = gate(runDir, "verify", "--slice", "2", "--title", "B", "--mode", "verify");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.diverged, true);
  assert.deepEqual(log(wt), ["ABC-1: B", "ABC-1: A"]);
  assert.equal(gate(runDir, "audit").ok, true);
});

test("test-mode slices need a red snapshot first", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  write(wt, "feature.txt", "x\n");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "F", "--mode", "test");
  assert.equal(r.reason, "missing-red-snapshot");
  assert.equal(gate(runDir, "verify", "--slice", "1", "--title", "F", "--mode", "test", "--red-exempt").ok, true);
});

test("red rejects tests that already pass and flags assertions removed later", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  write(wt, "tests/n.test.js", "expect(a).toBe(1)\n");
  assert.equal(gate(runDir, "red", "--slice", "1", "--tests", "tests/n.test.js").reason, "tests-not-red");
  write(wt, "tests/n.test.js", "// TODO\nexpect(a).toBe(1)\nexpect(b).toBe(2)\n");
  assert.equal(gate(runDir, "red", "--slice", "1", "--tests", "tests/n.test.js").ok, true);
  write(wt, "tests/n.test.js", "expect(a).toBe(1)\n");
  write(wt, "tests/old.test.js", "expect(old).toBe(2)\n");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "F", "--mode", "test");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.testEdits.weakenedAssertions, [{ file: "tests/n.test.js", removed: ["expect(b).toBe(2)"] }]);
  assert.deepEqual(r.testEdits.existingTestEdits, ["tests/old.test.js"]);
});

test("a commit hook that changes files fails the gate and leaves no commit", (t) => {
  const { runDir, wt } = fixture(t);
  const init = gate(runDir, "init");
  write(wt, ".git/hooks/pre-commit", "#!/bin/sh\necho hooked >> a.txt\n");
  fs.chmodSync(path.join(wt, ".git/hooks/pre-commit"), 0o755);
  write(wt, "a.txt", "a\n");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "hook-mutated-tree");
  assert.equal(sh(wt, "git rev-parse HEAD"), init.baseSha);
});

test("a command that writes files fails unless the path is ignored", (t) => {
  const { runDir, wt } = fixture(t, { suiteCmd: "mkdir -p coverage && echo 1 > coverage/c.json && echo x > stray.txt" });
  gate(runDir, "init");
  const init = JSON.parse(fs.readFileSync(path.join(runDir, "gate", "state.json"), "utf8"));
  assert.ok(init);
  fs.rmSync(path.join(wt, "stray.txt"), { force: true });
  write(wt, "a.txt", "a\n");
  const r = gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify");
  assert.equal(r.reason, "command-mutated-tree");
  assert.deepEqual(r.mutated, ["stray.txt"]);
});

test("gate.json edits after init are refused", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  const cfg = JSON.parse(fs.readFileSync(path.join(runDir, "gate.json"), "utf8"));
  cfg.suiteCmd = "true";
  fs.writeFileSync(path.join(runDir, "gate.json"), JSON.stringify(cfg));
  write(wt, "a.txt", "a\n");
  assert.equal(gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify").reason, "config-changed");
});

test("a retry on an unchanged tree reuses the suite and reruns only live checks", (t) => {
  const { runDir, wt } = fixture(t, {
    suiteCmd: "echo run >> ../suite.log",
    verifyCmds: ["test -f ../live.flag"],
  });
  fs.writeFileSync(path.join(runDir, "live.flag"), "");
  gate(runDir, "init");
  fs.rmSync(path.join(runDir, "live.flag"));
  write(wt, "a.txt", "a\n");
  const first = gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify");
  assert.equal(first.reason, "command-failed");
  assert.equal(first.kind, "verification");
  fs.writeFileSync(path.join(runDir, "live.flag"), "");
  const second = gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.commands.map((c) => [c.kind, c.reused]), [["static", true], ["suite", true], ["verification", false]]);
  assert.equal(fs.readFileSync(path.join(runDir, "suite.log"), "utf8").trim().split("\n").length, 2);
});

test("a hanging command times out and its process group is killed", (t) => {
  const { runDir, wt } = fixture(t, { verifyCmds: ["sleep 30 & sleep 30; wait"], timeoutSec: 2 });
  gate(runDir, "init");
  write(wt, "a.txt", "a\n");
  const started = Date.now();
  const r = gate(runDir, "verify", "--slice", "1", "--title", "A", "--mode", "verify");
  assert.equal(r.reason, "command-timeout");
  assert.ok(Date.now() - started < 15000);
});

test("finalize commits leftover work as unverified and audit catches stray commits", (t) => {
  const { runDir, wt } = fixture(t);
  gate(runDir, "init");
  write(wt, "src.txt", "FAIL\n");
  sh(wt, "git add -A && git commit -q -m 'stuck self-commit'");
  const f = gate(runDir, "finalize", "--title", "Remaining work");
  assert.equal(f.ok, true);
  assert.ok(f.unverifiedCommit);
  assert.deepEqual(log(wt), ["[unverified] ABC-1: Remaining work"]);
  assert.equal(f.audit.ok, true);
  assert.deepEqual(f.audit.unverified, [f.unverifiedCommit]);
  write(wt, "c.txt", "c\n");
  sh(wt, "git add -A && git commit -q -m 'manual'");
  const a = gate(runDir, "audit");
  assert.equal(a.ok, false);
  assert.equal(a.unknown.length, 1);
});

test("normalize commands must be scoped to {files}", (t) => {
  const { runDir } = fixture(t, { normalizeCmds: ["prettier --write ."] });
  assert.equal(gate(runDir, "init").reason, "unscoped-normalize");
});

function guard(payload) {
  return spawnSync(process.execPath, [guardScript], { input: JSON.stringify(payload), encoding: "utf8" });
}

test("the builder guard blocks history changes and gate state, and allows reads", () => {
  const bash = (command) => guard({ tool_name: "Bash", tool_input: { command } }).status;
  assert.equal(bash("git commit -am wip"), 2);
  assert.equal(bash("cd x && git -C /tmp/wt stash -u"), 2);
  assert.equal(bash("git reset --hard HEAD"), 2);
  assert.equal(bash("git checkout -- src.ts"), 2);
  assert.equal(bash("git branch -D other"), 2);
  assert.equal(bash("node ~/.claude/scripts/feature-flow-gate.js verify /r --slice 1"), 2);
  assert.equal(bash("node ~/.claude/scripts/feature-flow-gate.js red /r --slice 1 --tests a.test.ts"), 0);
  assert.equal(bash("git status && git diff --stat && git log -5"), 0);
  assert.equal(bash("pnpm vitest run src/a.test.ts"), 0);
  const edit = (file_path) => guard({ tool_name: "Write", tool_input: { file_path } }).status;
  assert.equal(edit("/Users/me/.agent-teams/runs/2026-10-02-x/gate.json"), 2);
  assert.equal(edit("/Users/me/.agent-teams/runs/2026-10-02-x/gate/state.json"), 2);
  assert.equal(edit("/Users/me/.agent-teams/runs/2026-10-02-x/worktree/src/gate/index.ts"), 0);
  assert.equal(edit("/Users/me/.agent-teams/runs/2026-10-02-x/worktree/src/a.ts"), 0);
});
