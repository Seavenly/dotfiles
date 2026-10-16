// Behavioral tests for config/claude/scripts/epic-flow-integrate.js, driven
// through its command-line interface against scratch repositories with a bare
// origin, an epic branch, and story worktrees whose commits come from the
// real feature-flow gate.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "config/claude/scripts/epic-flow-integrate.js");
const gateScript = path.join(root, "config/claude/scripts/feature-flow-gate.js");

function sh(cwd, cmd) {
  return execFileSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function run(...args) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function gate(runDir, ...args) {
  const res = spawnSync(process.execPath, [gateScript, args[0], runDir, ...args.slice(1)], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const GATE_CONFIG = {
  commitPrefix: "ABC-1: ", staticCmds: ["true"],
  // Red when two stories each wrote a conflicting marker: a clean merge can
  // still be broken, and only verification of the merged tree sees it.
  suiteCmd: "! (test -f a.txt && test -f clash.txt)",
  verifyCmds: [], timeoutSec: 20,
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epic-int-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  sh(dir, `git init -q --bare -b main ${origin} && git clone -q ${origin} ${repo}`);
  sh(repo, "git config user.email t@example.com && git config user.name Test && git config commit.gpgsign false");
  write(repo, "base.txt", "base\n");
  write(repo, ".gitignore", "node_modules/\n");
  sh(repo, "git add -A && git commit -q -m base && git push -q origin main && git push -q origin main:refs/heads/epic/abc-1 && git fetch -q origin");
  const epicDir = path.join(dir, "epic-abc-1");
  fs.mkdirSync(epicDir);
  fs.writeFileSync(path.join(epicDir, "epic.json"), JSON.stringify({ repo, branch: "epic/abc-1", target: "main" }));
  fs.writeFileSync(path.join(epicDir, "gate.template.json"), JSON.stringify(GATE_CONFIG));
  return { dir, origin, repo, epicDir };
}

// A story built through the real gate: worktree cut from the epic tip, one
// verified slice per file. Returns the run dir and the story head.
function story(fx, name, files, { from = "origin/epic/abc-1" } = {}) {
  const runDir = path.join(fx.dir, `run-${name}`);
  const wt = path.join(runDir, "worktree");
  fs.mkdirSync(runDir);
  sh(fx.repo, `git fetch -q origin && git worktree add -q -b agt/feature-${name} ${wt} ${from}`);
  fs.writeFileSync(path.join(runDir, "gate.json"), JSON.stringify({ ...GATE_CONFIG, worktree: wt, branch: `agt/feature-${name}` }));
  assert.equal(gate(runDir, "init").ok, true);
  for (const [rel, content] of Object.entries(files)) {
    write(wt, rel, content);
    const r = gate(runDir, "verify", "--slice", rel, "--title", `add ${rel}`, "--mode", "verify");
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  return { runDir, wt, head: sh(wt, "git rev-parse HEAD") };
}

function originTip(fx) {
  return sh(fx.origin, "git rev-parse refs/heads/epic/abc-1");
}

function pushToEpic(fx, rel) {
  const tmp = path.join(fx.dir, `side-${rel}`);
  sh(fx.repo, `git worktree add -q --detach ${tmp} origin/epic/abc-1`);
  write(tmp, rel, "side\n");
  sh(tmp, `git add -A && git commit -q -m side && git push -q origin HEAD:refs/heads/epic/abc-1`);
}

test("an unmoved tip integrates without re-running checks and pushes a merge commit", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head, "--title", "ABC-2: add a");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.verification.ran, false);
  const tip = originTip(fx);
  assert.equal(tip, r.receipt.mergeCommit);
  assert.equal(sh(fx.origin, `git rev-parse ${tip}^2`), s.head);
  assert.equal(sh(fx.origin, `git log -1 --format=%s ${tip}`), "ABC-2: add a");
  assert.equal(r.localRef.updated, true);
  assert.equal(sh(fx.repo, "git rev-parse refs/heads/epic/abc-1"), tip);
});

test("re-running a pushed integration returns its receipt without a second merge", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  const first = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  const tip = originTip(fx);
  const again = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  assert.equal(again.alreadyIntegrated, true);
  assert.equal(again.receipt.mergeCommit, first.receipt.mergeCommit);
  assert.equal(originTip(fx), tip);
});

test("a receipt lost after the push is derived from git", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  const first = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  fs.rmSync(path.join(fx.epicDir, "integrations.json"));
  const again = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  assert.equal(again.alreadyIntegrated, true);
  assert.equal(again.receipt.derived, true);
  assert.equal(again.receipt.mergeCommit, first.receipt.mergeCommit);
});

test("a moved tip re-verifies the merged tree and a red merge never reaches the remote", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  pushToEpic(fx, "clash.txt");
  const before = originTip(fx);
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "verification-failed");
  assert.equal(r.verification.ran, true);
  assert.equal(originTip(fx), before);
  const saved = JSON.parse(fs.readFileSync(path.join(fx.epicDir, "integrations.json"), "utf8")).receipts;
  assert.equal(saved[0].state, "failed");
});

test("a moved tip with a green merged tree integrates after verification", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  pushToEpic(fx, "other.txt");
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.verification.ran, true);
  assert.ok(r.receipt.verification.commands.every((c) => c.exit === 0));
  assert.equal(originTip(fx), r.receipt.mergeCommit);
});

test("a conflict aborts, reports the files, and leaves the remote untouched", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "base.txt": "story\n" });
  pushToEpic(fx, "base.txt");
  const before = originTip(fx);
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  assert.equal(r.reason, "conflict");
  assert.deepEqual(r.files, ["base.txt"]);
  assert.equal(originTip(fx), before);
  assert.equal(sh(path.join(fx.epicDir, "integration"), "git status --porcelain"), "");
});

test("a head other than the approved one is refused", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n", "b.txt": "b\n" });
  const approved = sh(s.wt, "git rev-parse HEAD~1");
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", approved);
  assert.equal(r.reason, "head-moved");
});

test("commits the gate did not make are refused", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  write(s.wt, "sneak.txt", "x\n");
  sh(s.wt, "git add -A && git commit -q -m sneak");
  const head = sh(s.wt, "git rev-parse HEAD");
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", head);
  assert.equal(r.reason, "unknown-commits");
});

test("review fixes the owner accepted integrate after a full check; others are still refused", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  write(s.wt, "fix1.txt", "x\n");
  sh(s.wt, "git add -A && git commit -q -m fix1");
  const fix1 = sh(s.wt, "git rev-parse HEAD");
  write(s.wt, "fix2.txt", "y\n");
  sh(s.wt, "git add -A && git commit -q -m fix2");
  const head = sh(s.wt, "git rev-parse HEAD");
  const partial = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", head, "--accept-unknown", fix1);
  assert.equal(partial.reason, "unknown-commits");
  assert.deepEqual(partial.unknown, [head]);
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", head, "--accept-unknown", `${fix1},${head}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.verification.ran, true);
  assert.deepEqual(r.receipt.acceptedUnknown, [fix1, head]);
});

test("a story stacked on an unintegrated sibling is refused", (t) => {
  const fx = fixture(t);
  story(fx, "a", { "a.txt": "a\n" });
  const s = story(fx, "b", { "b.txt": "b\n" }, { from: "agt/feature-a" });
  const r = run("integrate", fx.epicDir, "--story", "ABC-3", "--run", s.runDir, "--head", s.head);
  assert.equal(r.reason, "foreign-base");
});

test("work the gate never passed forces verification even on an unmoved tip", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  write(s.wt, "late.txt", "late\n");
  assert.equal(gate(s.runDir, "finalize", "--title", "leftover").ok, true);
  const head = sh(s.wt, "git rev-parse HEAD");
  const r = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", head);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.verification.ran, true);
  assert.equal(r.receipt.unverified.length, 1);
});

test("refresh merges main on a candidate branch and land pushes it only from the recorded tip", (t) => {
  const fx = fixture(t);
  sh(fx.repo, "git checkout -q main");
  write(fx.repo, "main.txt", "m\n");
  sh(fx.repo, "git add -A && git commit -q -m main-change && git push -q origin main");
  const before = originTip(fx);
  const r = run("refresh", fx.epicDir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.behind, 1);
  assert.equal(originTip(fx), before, "refresh must not touch the epic branch");
  assert.equal(sh(fx.repo, "git rev-parse refs/heads/agt/refresh-epic-abc-1"), r.head);
  const landed = run("land", fx.epicDir, "--head", r.head);
  assert.equal(landed.ok, true, JSON.stringify(landed));
  assert.equal(originTip(fx), r.head);
  assert.equal(run("refresh", fx.epicDir).upToDate, true);
});

test("land refuses a refresh cut from a tip that has since moved", (t) => {
  const fx = fixture(t);
  sh(fx.repo, "git checkout -q main");
  write(fx.repo, "main.txt", "m\n");
  sh(fx.repo, "git add -A && git commit -q -m main-change && git push -q origin main");
  const r = run("refresh", fx.epicDir);
  pushToEpic(fx, "other.txt");
  const landed = run("land", fx.epicDir, "--head", r.head);
  assert.equal(landed.reason, "target-moved");
});

test("receipts report what the remote holds", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head);
  const r = run("receipts", fx.epicDir);
  assert.equal(r.receipts.length, 1);
  assert.equal(r.receipts[0].onRemote, true);
  assert.equal(r.behind, 0);
});

test("detach and wait return the integration result", (t) => {
  const fx = fixture(t);
  const s = story(fx, "a", { "a.txt": "a\n" });
  const started = run("integrate", fx.epicDir, "--story", "ABC-2", "--run", s.runDir, "--head", s.head, "--detach");
  assert.equal(started.pending, true);
  const r = run("wait", fx.epicDir, "--token", started.token, "--timeout", "60");
  assert.equal(r.ok, true, JSON.stringify(r));
});
