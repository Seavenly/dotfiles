#!/usr/bin/env node
// feature-flow-gate.js - the deterministic verification gate for /feature-flow.
//
//   node feature-flow-gate.js init     <runDir>
//   node feature-flow-gate.js red      <runDir> --slice ID --tests a,b
//   node feature-flow-gate.js verify   <runDir> --slice ID --title T --mode test|verify
//                                      [--final] [--red-exempt]
//   node feature-flow-gate.js finalize <runDir> --title T
//   node feature-flow-gate.js audit    <runDir>
//
// The host writes <runDir>/gate.json at launch from the approved brief; `init`
// records its digest, the base commit, and a baseline run of every command.
// The script only ever runs commands from that file, and refuses to run after
// the file changes, so allowing this one script does not allow arbitrary
// commands.
//
// History holds only commits this script made. Agents that commit on their
// own are folded back in: every verify and finalize first moves the branch to
// the last verified commit with `reset --soft`, which keeps the index and
// working tree untouched. A failed gate therefore never leaves unverified
// commits behind. Tree identity is computed on a temporary index, so checking
// content never disturbs the real one, and `ignorePaths` (files the suite
// itself writes, such as coverage) are excluded from identity and commits.
// Hooks always run; a hook that changes the committed tree fails the gate and
// the commit is undone the same way.
//
// Every subcommand prints one JSON object on stdout and exits 0 unless the
// arguments are unusable (exit 2). State lives under <runDir>/gate/.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const TAIL_LINES = 40;
const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_TEST_PATTERNS = [
  "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py",
  "**/test/**", "**/tests/**", "**/__tests__/**",
];
const FOCUS = /\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe|ftest)\s*\(/;
const SKIP = /\b(?:it|test|describe|context)\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/;
const ASSERTION = /\b(expect|assert\w*|should|t\.(is|not|true|false|deepEqual|equal|throws|regex|snapshot)|toBe|toEqual|toMatch|toThrow|toHaveBeenCalled\w*)\b/;

// Child runner: argv = [cmd, timeoutMs, logPath]. Streams output to the log,
// kills the process group on timeout, and writes <log>.status.
const RUNNER = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [cmd, timeoutMs, log] = process.argv.slice(1);
const out = fs.openSync(log, "w");
fs.writeSync(out, "$ " + cmd + "\\n");
const child = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, Number(timeoutMs));
child.on("error", (e) => { clearTimeout(timer); fs.writeFileSync(log + ".status", JSON.stringify({ exit: null, timedOut: false, error: e.message })); });
child.on("exit", (code) => {
  clearTimeout(timer);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  fs.writeFileSync(log + ".status", JSON.stringify({ exit: code, timedOut }));
});
`;

class GateError extends Error {}

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const [command, runDir, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith("--")) usage(`unexpected argument: ${key}`);
    const name = key.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[name] = true;
    else { opts[name] = next; i++; }
  }
  return { command, runDir, opts };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function tail(text, lines = TAIL_LINES) {
  const all = String(text || "").replace(/\s+$/, "").split("\n");
  return all.slice(-lines).join("\n");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

class Gate {
  constructor(runDir) {
    this.runDir = path.resolve(runDir);
    this.configPath = path.join(this.runDir, "gate.json");
    this.dir = path.join(this.runDir, "gate");
    this.statePath = path.join(this.dir, "state.json");
    this.ledgerPath = path.join(this.dir, "ledger.json");
    this.cachePath = path.join(this.dir, "cache.json");
    const raw = fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath, "utf8") : null;
    if (raw === null) throw new GateError(`missing ${this.configPath}`);
    this.configDigest = sha256(raw);
    this.config = JSON.parse(raw);
    const c = this.config;
    if (!c.worktree || !path.isAbsolute(c.worktree)) throw new GateError("gate.json needs an absolute worktree");
    if (!c.branch) throw new GateError("gate.json needs the run branch");
    this.wt = c.worktree;
    this.ignore = c.ignorePaths || [];
    this.testPatterns = c.testPathPatterns || DEFAULT_TEST_PATTERNS;
    this.timeoutMs = (c.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000;
    this.state = readJson(this.statePath, null);
  }

  git(args, { input, env, allowFail = false } = {}) {
    const res = spawnSync("git", args, {
      cwd: this.wt, input, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024,
    });
    if (res.status !== 0 && !allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${tail(res.stderr || res.stdout, 10)}`);
    }
    return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
  }

  pathspec() {
    return ["--", ".", ...this.ignore.map((glob) => `:(exclude,glob)${glob}`)];
  }

  // Tree of the working tree as it would be committed, built on a throwaway
  // index so the real index is never touched.
  contentTree() {
    const index = path.join(os.tmpdir(), `ff-gate-${process.pid}-${crypto.randomBytes(4).toString("hex")}.idx`);
    const env = { GIT_INDEX_FILE: index };
    try {
      this.git(["read-tree", this.state.verifiedHead], { env });
      this.git(["add", "-A", ...this.pathspec()], { env });
      return this.git(["write-tree"], { env }).out;
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  treeOf(rev) {
    return this.git(["rev-parse", `${rev}^{tree}`]).out;
  }

  changedPaths(fromTree, toTree) {
    if (fromTree === toTree) return [];
    return this.git(["diff", "--name-only", "--no-renames", fromTree, toTree]).out.split("\n").filter(Boolean);
  }

  checkTamper() {
    if (!this.state) return { reason: "not-initialized", message: "run `init` first" };
    if (this.state.configDigest !== this.configDigest) {
      return { reason: "config-changed", message: "gate.json changed after init; only the host may edit it, and it must re-run init" };
    }
    const top = this.git(["rev-parse", "--show-toplevel"], { allowFail: true }).out;
    if (fs.realpathSync(top || "/") !== fs.realpathSync(this.wt)) {
      return { reason: "wrong-worktree", message: `${this.wt} is not a git worktree root` };
    }
    const branch = this.git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }).out;
    if (branch !== this.config.branch) {
      return { reason: "wrong-branch", message: `HEAD is on '${branch || "detached"}', expected '${this.config.branch}'; switch back without discarding changes` };
    }
    return null;
  }

  // Move the branch back to the last verified commit, keeping index and
  // working tree. Commits an agent made itself become uncommitted changes.
  fold() {
    const head = this.git(["rev-parse", "HEAD"]).out;
    const verified = this.state.verifiedHead;
    if (head === verified) return { folded: [], diverged: false };
    const descends = this.git(["merge-base", "--is-ancestor", verified, head], { allowFail: true }).ok;
    const folded = this.git(["log", "--format=%h %s", "-n", "50", `${verified}..${head}`]).out.split("\n").filter(Boolean);
    this.git(["reset", "-q", "--soft", verified]);
    return { folded, diverged: !descends };
  }

  run(command, files, subdir) {
    let cmd = command;
    if (cmd.includes("{files}")) {
      if (!files || !files.length) return { skipped: true };
      cmd = cmd.replace("{files}", files.map(shellQuote).join(" "));
    }
    const started = Date.now();
    const logDir = path.join(this.dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, `${Date.now()}-${sha256(cmd).slice(0, 8)}.log`);
    // Run in its own process group so a timeout kills the whole tree
    // (pnpm -> vitest -> workers), not just the shell.
    const res = spawnSync(process.execPath, ["-e", RUNNER, cmd, String(this.timeoutMs), log], {
      cwd: subdir ? path.join(this.wt, subdir) : this.wt, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const outcome = readJson(`${log}.status`, { exit: null, timedOut: false, error: res.stderr || "runner failed" });
    const output = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return {
      command, exit: outcome.timedOut ? null : outcome.exit, timedOut: outcome.timedOut,
      error: outcome.error || undefined, durationMs: Date.now() - started, log, tail: tail(output),
    };
  }

  commandList(mode, final) {
    const c = this.config;
    const list = [
      ...(c.staticCmds || []).map((command) => ({ command, kind: "static" })),
      ...(c.suiteCmd ? [{ command: c.suiteCmd, kind: "suite" }] : []),
      ...((mode === "verify" || final) ? (c.verifyCmds || []).map((command) => ({ command, kind: "verification" })) : []),
    ];
    const seen = new Set();
    return list.filter(({ command }) => !seen.has(command) && seen.add(command));
  }

  saveState() { writeJson(this.statePath, this.state); }

  appendLedger(entries) {
    const ledger = readJson(this.ledgerPath, []);
    ledger.push(...entries);
    writeJson(this.ledgerPath, ledger);
  }

  // ── init ──────────────────────────────────────────────────────────
  init(opts = {}) {
    if (this.state && opts.force !== true) {
      return { ok: false, reason: "already-initialized", message: "pass --force to re-initialize" };
    }
    const top = this.git(["rev-parse", "--show-toplevel"], { allowFail: true }).out;
    if (!top || fs.realpathSync(top) !== fs.realpathSync(this.wt)) {
      return { ok: false, reason: "wrong-worktree", message: `${this.wt} is not a git worktree root` };
    }
    const branch = this.git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }).out;
    if (branch !== this.config.branch) return { ok: false, reason: "wrong-branch", message: `on '${branch}', expected '${this.config.branch}'` };
    const unscoped = (this.config.normalizeCmds || []).filter((cmd) => !cmd.includes("{files}"));
    if (unscoped.length) {
      return { ok: false, reason: "unscoped-normalize", message: "normalize commands must take {files} so they only touch files the slice changed", commands: unscoped };
    }
    const focused = [this.config.focusedTestCmd, ...(this.config.focusedTestCmds || []).map((e) => e && e.cmd)].filter((c) => c !== undefined && c !== null);
    if (focused.some((cmd) => typeof cmd !== "string" || !cmd.includes("{files}"))) {
      return { ok: false, reason: "unscoped-focused-test", message: "every focused test command must take {files}" };
    }
    const head = this.git(["rev-parse", "HEAD"]).out;
    this.state = {
      configDigest: this.configDigest, baseSha: head, verifiedHead: head,
      verifiedCommits: [], unverifiedCommits: [], slices: {},
    };
    const dirty = this.changedPaths(this.treeOf(head), this.contentTree());
    if (dirty.length) {
      return { ok: false, reason: "dirty-worktree", message: "commit or remove setup changes before init", paths: dirty.slice(0, 50) };
    }
    const baseline = [];
    for (const { command, kind } of this.commandList("verify", true)) {
      const before = this.contentTree();
      const r = this.run(command);
      const after = this.contentTree();
      baseline.push({ ...r, kind, mutated: this.changedPaths(before, after) });
    }
    const failed = baseline.filter((r) => r.exit !== 0 || r.mutated.length);
    fs.mkdirSync(this.dir, { recursive: true });
    this.saveState();
    writeJson(this.cachePath, {});
    this.appendLedger(baseline.map((r) => ({ at: new Date().toISOString(), slice: "baseline", kind: r.kind, command: r.command, exit: r.exit, tree: this.treeOf(head), sha: head, durationMs: r.durationMs, reused: false })));
    return {
      ok: failed.length === 0, baseSha: head, configDigest: this.configDigest,
      baseline: baseline.map(({ command, kind, exit, timedOut, durationMs, mutated, tail: t }) => ({
        command, kind, exit, timedOut, durationMs, mutated, tail: exit === 0 && !mutated.length ? undefined : t,
      })),
      ...(failed.length ? { reason: "baseline-red", message: "a gate command is red, hangs, or mutates the tree on the unchanged base" } : {}),
    };
  }

  // ── red ───────────────────────────────────────────────────────────
  red(opts) {
    const bad = this.checkTamper();
    if (bad) return { ok: false, ...bad };
    const slice = String(opts.slice || "");
    const tests = String(opts.tests || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!slice || !tests.length) throw new GateError("red needs --slice and --tests");
    const files = [];
    for (const rel of tests) {
      const abs = path.resolve(this.wt, rel);
      if (!abs.startsWith(`${fs.realpathSync(this.wt)}${path.sep}`) && !abs.startsWith(`${this.wt}${path.sep}`)) {
        return { ok: false, reason: "path-outside-worktree", message: rel };
      }
      if (!fs.existsSync(abs)) return { ok: false, reason: "missing-test-file", message: rel };
      files.push(path.relative(this.wt, abs));
    }
    const snapDir = path.join(this.dir, "red", slice.replace(/[^\w.-]/g, "_"));
    fs.rmSync(snapDir, { recursive: true, force: true });
    const snapshot = {};
    for (const rel of files) {
      const content = fs.readFileSync(path.join(this.wt, rel), "utf8");
      const dest = path.join(snapDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      snapshot[rel] = sha256(content);
    }
    // Group the files by the first focusedTestCmds entry whose `paths` glob
    // matches (files passed relative to its `cwd`), falling back to the root
    // focusedTestCmd. Red means every group ran and failed.
    const groups = new Map();
    const unrunnable = [];
    for (const rel of files) {
      const entry = (this.config.focusedTestCmds || []).find((e) => matchesAny(rel, [e.paths]));
      const key = entry ? JSON.stringify(entry) : this.config.focusedTestCmd ? "root" : null;
      if (!key) { unrunnable.push(rel); continue; }
      if (!groups.has(key)) groups.set(key, { entry, files: [] });
      groups.get(key).files.push(entry && entry.cwd ? path.relative(entry.cwd, rel) : rel);
    }
    let red = "unchecked";
    let result;
    const outcomes = [];
    for (const { entry, files: groupFiles } of groups.values()) {
      const r = this.run(entry ? entry.cmd : this.config.focusedTestCmd, groupFiles, entry && entry.cwd);
      outcomes.push({ files: groupFiles, outcome: r.timedOut || r.error ? "error" : r.exit === 0 ? "passed" : "failed", tail: r.tail });
    }
    if (outcomes.some((o) => o.outcome === "error")) red = "error";
    else if (outcomes.some((o) => o.outcome === "passed")) red = "passed";
    else if (outcomes.length && !unrunnable.length) red = "failed";
    result = outcomes.find((o) => o.outcome === red) || outcomes[0];
    const record = this.state.slices[slice] || {};
    record.red = { files: snapshot, dir: snapDir, outcome: red, at: new Date().toISOString() };
    this.state.slices[slice] = record;
    this.saveState();
    if (red === "error") {
      return { ok: false, reason: "red-errored", message: "the focused test run errored or timed out, which is not a behavioral failure; fix the test setup and run red again", files, tail: result.tail };
    }
    if (red === "passed") {
      return { ok: false, reason: "tests-not-red", message: "the new tests already pass, so they do not describe new behavior; fix the tests or ask for the slice to be red-exempt", files, tail: result.tail };
    }
    return { ok: true, slice, files, red, unrunnable, tail: result ? result.tail : undefined };
  }

  testEdits(slice, fromTree, toTree) {
    const changed = this.changedPaths(fromTree, toTree);
    const baseFiles = new Set(this.git(["ls-tree", "-r", "--name-only", this.state.baseSha]).out.split("\n"));
    const existingTestEdits = changed.filter((f) => baseFiles.has(f) && matchesAny(f, this.testPatterns));
    const weakenedAssertions = [];
    const red = this.state.slices[slice] && this.state.slices[slice].red;
    if (red) {
      for (const rel of Object.keys(red.files)) {
        const abs = path.join(this.wt, rel);
        if (!fs.existsSync(abs)) { weakenedAssertions.push({ file: rel, removed: ["(file deleted)"] }); continue; }
        const now = new Set(fs.readFileSync(abs, "utf8").split("\n").map((l) => l.trim()));
        const before = fs.readFileSync(path.join(red.dir, rel), "utf8").split("\n").map((l) => l.trim());
        const removed = before.filter((l) => ASSERTION.test(l) && !now.has(l));
        if (removed.length) weakenedAssertions.push({ file: rel, removed: removed.slice(0, 10) });
      }
    }
    const focusMarkers = [];
    const skipMarkers = [];
    for (const file of changed.filter((f) => matchesAny(f, this.testPatterns))) {
      const added = this.git(["diff", "-U0", fromTree, toTree, "--", file]).out
        .split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      if (added.some((l) => FOCUS.test(l))) focusMarkers.push(file);
      if (added.some((l) => SKIP.test(l))) skipMarkers.push(file);
    }
    return { existingTestEdits, weakenedAssertions, focusMarkers, skipMarkers };
  }

  // ── verify ────────────────────────────────────────────────────────
  verify(opts) {
    const bad = this.checkTamper();
    if (bad) return { ok: false, ...bad };
    const slice = String(opts.slice || "");
    const title = String(opts.title || "");
    const mode = opts.mode === "verify" ? "verify" : "test";
    const final = opts.final === true;
    const redExempt = opts["red-exempt"] === true;
    if (!slice || !title) throw new GateError("verify needs --slice and --title");

    const { folded, diverged } = this.fold();
    const verified = this.state.verifiedHead;
    const verifiedTree = this.treeOf(verified);
    const record = this.state.slices[slice] || { attempts: 0 };
    record.attempts = (record.attempts || 0) + 1;
    this.state.slices[slice] = record;
    const fail = (reason, extra = {}) => {
      this.saveState();
      return { ok: false, slice, reason, head: verified, folded, diverged, ...extra };
    };

    if (mode === "test" && !redExempt && !(record.red && ["failed", "unchecked"].includes(record.red.outcome))) {
      return fail("missing-red-snapshot", { message: "test-mode slices run `red` on their new tests before implementing; nothing is committed until then" });
    }

    const changed = this.changedPaths(verifiedTree, this.contentTree());
    for (const command of this.config.normalizeCmds || []) {
      const files = changed.filter((f) => fs.existsSync(path.join(this.wt, f)));
      const r = this.run(command, files);
      if (r.skipped) continue;
      if (r.exit !== 0) return fail("normalize-failed", { command, exit: r.exit, tail: r.tail });
    }

    const tree = this.contentTree();
    if (tree === verifiedTree && !final) {
      record.status = "no-change";
      this.saveState();
      return { ok: true, slice, noChange: true, head: verified, tree, folded, diverged, commands: [] };
    }

    const cache = readJson(this.cachePath, {});
    const results = [];
    for (const { command, kind } of this.commandList(mode, final)) {
      // Static and suite results depend only on content, so they are reusable
      // across the run. Verification commands can depend on credentials, time
      // or external state: reusable only by the same slice on the same tree as
      // its previous attempt.
      const key = sha256(`${kind}\n${command}\n${tree}\n${this.configDigest}`);
      const cacheKey = kind === "verification" ? `${slice}:${key}` : key;
      const canReuse = kind !== "verification" || record.lastAttemptTree === tree;
      if (canReuse && cache[cacheKey]) {
        results.push({ command, kind, exit: 0, reused: true, durationMs: 0 });
        continue;
      }
      const r = this.run(command);
      const after = this.contentTree();
      const mutated = this.changedPaths(tree, after);
      results.push({ command, kind, exit: r.exit, timedOut: r.timedOut, reused: false, durationMs: r.durationMs, mutated, log: r.log });
      if (r.exit !== 0 || r.timedOut || r.error) {
        record.lastAttemptTree = tree;
        this.writeAttempt(slice, tree, results, false);
        return fail(r.timedOut ? "command-timeout" : "command-failed", { command, kind, exit: r.exit, tail: r.tail, commands: results });
      }
      if (mutated.length) {
        record.lastAttemptTree = tree;
        this.writeAttempt(slice, tree, results, false);
        return fail("command-mutated-tree", { command, kind, mutated: mutated.slice(0, 50), message: "the command changed tracked or new files; add generated paths to ignorePaths or keep the command read-only" });
      }
      cache[cacheKey] = { at: new Date().toISOString() };
      writeJson(this.cachePath, cache);
    }
    record.lastAttemptTree = tree;

    const edits = this.testEdits(slice, verifiedTree, tree);
    if (edits.focusMarkers.length) {
      this.writeAttempt(slice, tree, results, false);
      return fail("focused-test-marker", { message: "a test file adds .only, fit, or fdescribe, which narrows the suite; remove it", files: edits.focusMarkers });
    }
    if (tree === verifiedTree) {
      record.status = "verified";
      this.writeAttempt(slice, tree, results, true, verified);
      this.saveState();
      return { ok: true, slice, noChange: true, head: verified, tree, folded, diverged, commands: results, testEdits: edits };
    }

    this.git(["add", "-A", ...this.pathspec()]);
    if (this.git(["write-tree"]).out !== tree) {
      this.git(["reset", "-q", "--soft", verified]);
      return fail("index-mismatch", { message: "the staged tree differs from the verified tree" });
    }
    const message = `${this.config.commitPrefix || ""}${title}`;
    const commit = this.git(["commit", "-q", "-m", message], { allowFail: true });
    if (!commit.ok) {
      this.git(["reset", "-q", "--soft", verified]);
      return fail("commit-hook-failed", { tail: tail(`${commit.out}\n${commit.err}`) });
    }
    const head = this.git(["rev-parse", "HEAD"]).out;
    if (this.treeOf(head) !== tree || this.changedPaths(this.treeOf(head), this.contentTreeAt(head)).length) {
      this.git(["reset", "-q", "--soft", verified]);
      return fail("hook-mutated-tree", { message: "a commit hook changed files after verification; run the formatter as a normalize command instead" });
    }
    this.state.verifiedHead = head;
    this.state.verifiedCommits.push(head);
    record.status = "verified";
    record.sha = head;
    record.testEdits = edits;
    this.writeAttempt(slice, tree, results, true, head);
    this.saveState();
    return { ok: true, slice, sha: head, head, tree, folded, diverged, commands: results, testEdits: edits };
  }

  contentTreeAt(head) {
    const saved = this.state.verifiedHead;
    this.state.verifiedHead = head;
    try { return this.contentTree(); } finally { this.state.verifiedHead = saved; }
  }

  writeAttempt(slice, tree, results, passed, sha = "") {
    this.appendLedger(results.map((r) => ({
      at: new Date().toISOString(), slice, kind: r.kind, command: r.command, exit: r.exit,
      reused: !!r.reused, tree, sha: passed ? sha : "", passed, durationMs: r.durationMs,
    })));
  }

  // ── finalize ──────────────────────────────────────────────────────
  // Commits whatever is left after the last gate (work from stuck slices) as
  // one commit marked unverified, so reviewers see it and the audit can tell
  // it apart from verified history. Hooks still run; when they refuse, the
  // work stays uncommitted and is reported.
  finalize(opts) {
    const bad = this.checkTamper();
    if (bad) return { ok: false, ...bad };
    const { folded, diverged } = this.fold();
    const verified = this.state.verifiedHead;
    const tree = this.contentTree();
    let unverifiedCommit = null;
    let uncommitted = false;
    let hookTail;
    if (tree !== this.treeOf(verified)) {
      this.git(["add", "-A", ...this.pathspec()]);
      const message = `[unverified] ${this.config.commitPrefix || ""}${opts.title || "Remaining work that did not pass the gate"}`;
      const commit = this.git(["commit", "-q", "-m", message], { allowFail: true });
      if (commit.ok) {
        unverifiedCommit = this.git(["rev-parse", "HEAD"]).out;
        this.state.unverifiedCommits.push(unverifiedCommit);
      } else {
        this.git(["reset", "-q", "--soft", verified]);
        uncommitted = true;
        hookTail = tail(`${commit.out}\n${commit.err}`);
      }
    }
    this.saveState();
    return { ok: true, head: this.git(["rev-parse", "HEAD"]).out, verifiedHead: verified, unverifiedCommit, uncommitted, hookTail, folded, diverged, audit: this.audit() };
  }

  // ── audit ─────────────────────────────────────────────────────────
  audit() {
    if (!this.state) return { ok: false, reason: "not-initialized" };
    const head = this.git(["rev-parse", "HEAD"]).out;
    const commits = this.git(["rev-list", "--reverse", `${this.state.baseSha}..${head}`]).out.split("\n").filter(Boolean);
    const verified = commits.filter((c) => this.state.verifiedCommits.includes(c));
    const unverified = commits.filter((c) => this.state.unverifiedCommits.includes(c));
    const unknown = commits.filter((c) => !verified.includes(c) && !unverified.includes(c));
    const dirty = this.changedPaths(this.treeOf(head), this.contentTreeAt(head)).length > 0;
    return {
      ok: unknown.length === 0 && this.state.configDigest === this.configDigest,
      base: this.state.baseSha, head, verifiedHead: this.state.verifiedHead,
      verified, unverified, unknown, dirty, configChanged: this.state.configDigest !== this.configDigest,
    };
  }
}

// An agent's shell call times out after ten minutes, and a full suite can take
// longer. `--detach` starts the subcommand in the background and prints
// { pending: true, token }; `wait` blocks up to --timeout seconds (default
// 540) and prints the result, or { pending: true, token } again.
function resultsDir(runDir) {
  return path.join(path.resolve(runDir), "gate", "results");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --request names the caller's attempt (the workflow passes its agent label),
// so a relay that retries reattaches to the same run instead of starting a
// second gate that would race the first.
function detach(command, runDir, argv, opts) {
  const request = typeof opts.request === "string" && /^[\w.:-]+$/.test(opts.request) ? opts.request.replace(/:/g, "_") : null;
  const token = request ? `${command}-${request}` : `${command}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = resultsDir(runDir);
  const resultFile = path.join(dir, `${token}.json`);
  const pidFile = path.join(dir, `${token}.pid`);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(resultFile)) return readJson(resultFile, { ok: false, reason: "gate-error", message: "unreadable result" });
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
  if (pid && pidAlive(pid)) return { pending: true, token, ok: false };
  const rest = argv.filter((x) => x !== "--detach");
  const child = spawnSync("/bin/sh", ["-c", `nohup ${[process.execPath, __filename, command, runDir, ...rest, "--result-file", resultFile].map(shellQuote).join(" ")} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  if (child.status !== 0) return { ok: false, reason: "gate-error", message: "could not start the detached gate" };
  fs.writeFileSync(pidFile, child.stdout.trim());
  return { pending: true, token, ok: false };
}

function waitFor(runDir, opts) {
  const token = String(opts.token || "");
  if (!/^[\w.-]+$/.test(token)) usage("wait needs --token");
  const resultFile = path.join(resultsDir(runDir), `${token}.json`);
  const pidFile = path.join(resultsDir(runDir), `${token}.pid`);
  const deadline = Date.now() + Math.min(Number(opts.timeout || 540), 570) * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) return readJson(resultFile, { ok: false, reason: "gate-error", message: "unreadable result" });
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    if (pid && !pidAlive(pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (fs.existsSync(resultFile)) continue;
      return { ok: false, reason: "gate-error", message: "the detached gate exited without a result" };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return { pending: true, token, ok: false };
}

// One gate at a time per run: a second caller waits for the lock rather than
// racing the first on reset, commit, and state.
function withLock(runDir, fn) {
  const lock = path.join(path.resolve(runDir), "gate", "lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 60 * 60 * 1000;
  while (true) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      const holder = Number(fs.readFileSync(lock, "utf8") || 0);
      if (!holder || !pidAlive(holder)) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) return { ok: false, reason: "gate-busy", message: `another gate (pid ${holder}) has held the lock for an hour` };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function main() {
  const argv = process.argv.slice(2);
  const { command, runDir, opts } = parseArgs(argv);
  if (!command || !runDir) usage("usage: feature-flow-gate.js <init|red|verify|finalize|audit|wait> <runDir> [options] [--detach] [--request id]");
  if (command === "wait") {
    process.stdout.write(`${JSON.stringify(waitFor(runDir, opts))}\n`);
    return;
  }
  if (!["init", "red", "verify", "finalize", "audit"].includes(command)) usage(`unknown subcommand: ${command}`);
  if (opts.detach) {
    process.stdout.write(`${JSON.stringify(detach(command, runDir, argv.slice(2), opts))}\n`);
    return;
  }
  let result;
  try {
    const gate = new Gate(runDir);
    const run = () => {
      switch (command) {
        case "init": return gate.init(opts);
        case "red": return gate.red(opts);
        case "verify": return gate.verify(opts);
        case "finalize": return gate.finalize(opts);
        default: return gate.audit();
      }
    };
    result = command === "audit" ? run() : withLock(runDir, run);
  } catch (error) {
    result = { ok: false, reason: error instanceof GateError ? "gate-config" : "gate-error", message: error.message };
  }
  if (typeof opts["result-file"] === "string") writeJson(opts["result-file"], result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
