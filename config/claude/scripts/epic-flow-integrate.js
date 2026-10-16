#!/usr/bin/env node
// epic-flow-integrate.js - moves approved work onto an epic's integration
// branch for /epic-flow, deterministically.
//
//   node epic-flow-integrate.js integrate <epicDir> --story KEY --run <runDir> --head <sha>
//                                         [--accept-unknown sha,sha] [--title T]
//   node epic-flow-integrate.js refresh   <epicDir> [--title T]
//   node epic-flow-integrate.js land      <epicDir> --head <sha>
//   node epic-flow-integrate.js receipts  <epicDir>
//   node epic-flow-integrate.js wait      <epicDir> --token T [--timeout 540]
//
// `integrate` merges one approved story head into the epic branch. `refresh`
// merges the target branch (main) into a candidate branch cut from the epic
// tip, for the owner to review; `land` pushes that reviewed candidate.
//
// The shared branch is never touched until a candidate is verified: every
// merge is built on a script-owned candidate branch from the exact remote tip,
// checked, recorded in <epicDir>/integrations.json, and only then pushed as a
// fast-forward. A failed merge, check, or push leaves the remote branch where
// it was. Pushes never force, so a tip that moved under the candidate is a
// `target-moved` result, not an overwrite.
//
// Provenance: a story head is integrated only when it is the head the owner
// approved, every commit the gate did not make (review fixes made by hand) is
// one the owner was shown and accepted with --accept-unknown, and the story
// was cut from epic history (so no sibling's unreviewed commits ride along).
// Accepted unknown commits and [unverified] commits force a full check. Re-running after a crash is safe: a head already reachable from
// the remote tip returns its receipt, derived from git when none was saved.
//
// Reads <epicDir>/epic.json (host-written): { repo, branch, target, remote,
// installCmd, timeoutSec } and <epicDir>/gate.template.json for refresh
// checks. Every subcommand prints one JSON object and exits 0 unless the
// arguments are unusable (exit 2).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const GATE = path.join(__dirname, "feature-flow-gate.js");

class IntegrateError extends Error {}

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const [command, epicDir, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith("--")) usage(`unexpected argument: ${key}`);
    const name = key.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[name] = true;
    else { opts[name] = next; i++; }
  }
  return { command, epicDir, opts };
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "").trim();
  if (r.status !== 0 && !allowFail) throw new IntegrateError(`git ${args.join(" ")} failed: ${(r.stderr || out).trim()}`);
  return { ok: r.status === 0, out, err: (r.stderr || "").trim() };
}

class Epic {
  constructor(epicDir) {
    this.dir = path.resolve(epicDir);
    this.config = readJson(path.join(this.dir, "epic.json"), null);
    if (!this.config) throw new IntegrateError(`no readable epic.json in ${this.dir}`);
    for (const key of ["repo", "branch"]) {
      if (typeof this.config[key] !== "string" || !this.config[key]) throw new IntegrateError(`epic.json needs "${key}"`);
    }
    this.repo = path.resolve(this.config.repo);
    this.branch = this.config.branch;
    this.target = this.config.target || "main";
    this.remote = this.config.remote || "origin";
    this.slug = this.branch.replace(/[^\w.-]+/g, "-");
    this.receiptsPath = path.join(this.dir, "integrations.json");
  }

  receipts() {
    return readJson(this.receiptsPath, { receipts: [] }).receipts;
  }

  // Records are append-or-replace by id, written atomically, so a crash
  // between steps leaves either the old or the new record, never half of one.
  record(entry) {
    const all = this.receipts().filter((r) => r.id !== entry.id);
    all.push({ ...entry, at: new Date().toISOString() });
    writeJson(this.receiptsPath, { receipts: all });
    return entry;
  }

  remoteTip(ref) {
    return git(this.repo, ["rev-parse", `refs/remotes/${this.remote}/${ref}`]).out;
  }

  fetch() {
    const r = git(this.repo, ["fetch", "--quiet", this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`, `+refs/heads/${this.target}:refs/remotes/${this.remote}/${this.target}`], { allowFail: true });
    if (!r.ok) throw new IntegrateError(`fetch failed: ${r.err}`);
  }

  isAncestor(a, b) {
    return git(this.repo, ["merge-base", "--is-ancestor", a, b], { allowFail: true }).ok;
  }

  // A script-owned worktree on a candidate branch reset to `startSha`. Any
  // leftover state from an earlier crash (a half merge, stray files) is
  // discarded: nothing in it is worth keeping, and it is never the shared
  // branch.
  candidate(name, branch, startSha) {
    const wt = path.join(this.dir, name);
    if (!fs.existsSync(path.join(wt, ".git"))) {
      fs.rmSync(wt, { recursive: true, force: true });
      git(this.repo, ["worktree", "prune"], { allowFail: true });
      git(this.repo, ["worktree", "add", "--quiet", "--no-track", "-B", branch, wt, startSha]);
    } else {
      git(wt, ["merge", "--abort"], { allowFail: true });
      git(wt, ["checkout", "--quiet", "--no-track", "-B", branch, startSha]);
      git(wt, ["reset", "--quiet", "--hard", startSha]);
      git(wt, ["clean", "-fdq"]);
    }
    return wt;
  }

  // Merge `ref` into the candidate with a merge commit. Hooks run; a hook that
  // changes the merged tree fails the merge rather than slipping unreviewed
  // edits in.
  merge(wt, ref, title, resetTo) {
    const m = git(wt, ["merge", "--no-ff", "--no-commit", ref], { allowFail: true });
    if (!m.ok) {
      const files = git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
      git(wt, ["merge", "--abort"], { allowFail: true });
      git(wt, ["reset", "--quiet", "--hard", resetTo]);
      return files.length
        ? { ok: false, reason: "conflict", message: `merging ${ref} conflicts; resolve it on a repair branch`, files }
        : { ok: false, reason: "merge-failed", message: m.err || m.out };
    }
    const tree = git(wt, ["write-tree"]).out;
    const c = git(wt, ["commit", "--quiet", "--no-edit", "-m", title], { allowFail: true });
    if (!c.ok) {
      git(wt, ["merge", "--abort"], { allowFail: true });
      git(wt, ["reset", "--quiet", "--hard", resetTo]);
      return { ok: false, reason: "commit-hook-failed", message: (c.err || c.out).slice(-2000) };
    }
    const committed = git(wt, ["rev-parse", "HEAD^{tree}"]).out;
    if (committed !== tree) {
      git(wt, ["reset", "--quiet", "--hard", resetTo]);
      return { ok: false, reason: "hook-mutated-tree", message: "a commit hook changed the merged files; the merge was undone" };
    }
    return { ok: true, commit: git(wt, ["rev-parse", "HEAD"]).out, tree };
  }

  // Full check of a merged tree: install, then the gate's baseline run of
  // every static, suite, and verification command on a throwaway gate run
  // dir pointed at the candidate. The gate refuses dirty trees, so an install
  // that rewrites tracked files fails here too.
  verify(wt, branch, gateConfig, label) {
    const runDir = path.join(this.dir, "verify", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(runDir, { recursive: true });
    const timeoutSec = Number(this.config.timeoutSec || gateConfig.timeoutSec || 900);
    if (this.config.installCmd) {
      const r = spawnSync("/bin/sh", ["-c", this.config.installCmd], { cwd: wt, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
      fs.writeFileSync(path.join(runDir, "install.log"), `${r.stdout || ""}\n--- stderr ---\n${r.stderr || ""}`);
      if (r.status !== 0) return { ran: true, ok: false, reason: "install-failed", dir: runDir };
    }
    writeJson(path.join(runDir, "gate.json"), { ...gateConfig, worktree: wt, branch });
    const g = spawnSync(process.execPath, [GATE, "init", runDir], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const result = readJsonText(g.stdout);
    if (!result) return { ran: true, ok: false, reason: "gate-error", message: (g.stderr || "").slice(-2000), dir: runDir };
    return {
      ran: true, ok: result.ok === true, dir: runDir,
      ...(result.ok ? {} : { reason: result.reason || "verification-failed", message: result.message }),
      commands: (result.baseline || []).map(({ command, kind, exit, timedOut, mutated, tail }) => ({ command, kind, exit, timedOut, mutated, tail })),
    };
  }

  // Fast-forward the remote branch to `sha`. Never forces: a moved tip is
  // rejected by the remote and reported.
  push(sha) {
    const r = git(this.repo, ["push", "--quiet", "--porcelain", this.remote, `${sha}:refs/heads/${this.branch}`], { allowFail: true });
    if (r.ok) return { ok: true };
    const rejected = /rejected|non-fast-forward|fetch first/i.test(`${r.out}\n${r.err}`);
    return { ok: false, reason: rejected ? "target-moved" : "push-failed", message: (r.err || r.out).slice(-2000) };
  }

  // Keep the local epic ref current, because tuicr diffs story branches
  // against it. Only fast-forwards, and never a branch checked out somewhere.
  updateLocalRef(sha) {
    const ref = `refs/heads/${this.branch}`;
    const local = git(this.repo, ["rev-parse", "-q", "--verify", ref], { allowFail: true }).out;
    if (!local) {
      git(this.repo, ["update-ref", ref, sha]);
      return { updated: true };
    }
    if (local === sha) return { updated: false, current: true };
    const listing = git(this.repo, ["worktree", "list", "--porcelain"]).out.split("\n\n");
    const holder = listing.find((block) => block.split("\n").includes(`branch ${ref}`));
    if (holder) return { updated: false, checkedOutIn: holder.split("\n")[0].replace(/^worktree /, "") };
    if (!this.isAncestor(local, sha)) return { updated: false, diverged: true };
    git(this.repo, ["update-ref", ref, sha, local]);
    return { updated: true };
  }

  // The merge commit that brought `head` into the remote tip, for receipts
  // that were never saved (a crash after the push).
  deriveMerge(head, tip) {
    const lines = git(this.repo, ["rev-list", "--merges", "--parents", "--reverse", `${head}..${tip}`]).out.split("\n").filter(Boolean);
    const hit = lines.map((l) => l.split(" ")).find((parts) => parts.slice(1).includes(head));
    return hit ? hit[0] : null;
  }

  // ── integrate ─────────────────────────────────────────────────────
  integrate(opts) {
    const story = String(opts.story || "");
    const head = String(opts.head || "");
    if (!story || !/^[0-9a-f]{40}$/.test(head) || typeof opts.run !== "string") {
      throw new IntegrateError("integrate needs --story KEY --run <runDir> --head <full sha>");
    }
    const runDir = path.resolve(opts.run);
    const gateConfig = readJson(path.join(runDir, "gate.json"), null);
    if (!gateConfig) throw new IntegrateError(`no gate.json in ${runDir}`);
    const id = `story:${story}:${head}`;

    this.fetch();
    const tip = this.remoteTip(this.branch);
    if (this.isAncestor(head, tip)) {
      const saved = this.receipts().find((r) => r.id === id && r.state === "pushed");
      const receipt = saved || this.record({ id, kind: "story", story, approvedHead: head, mergeCommit: this.deriveMerge(head, tip), state: "pushed", derived: true });
      return { ok: true, alreadyIntegrated: true, receipt, localRef: this.updateLocalRef(tip) };
    }

    const branchHead = git(this.repo, ["rev-parse", "-q", "--verify", `refs/heads/${gateConfig.branch}`], { allowFail: true }).out;
    if (branchHead !== head) {
      return { ok: false, reason: "head-moved", message: `${gateConfig.branch} is at ${branchHead || "nothing"}, not the approved ${head}; review the new commits first`, branchHead };
    }
    const a = spawnSync(process.execPath, [GATE, "audit", runDir], { encoding: "utf8" });
    const audit = readJsonText(a.stdout);
    if (!audit || audit.reason === "not-initialized") return { ok: false, reason: "no-audit", message: "the story's gate audit is unavailable; integrate it by hand after checking its history" };
    if (audit.head !== head) return { ok: false, reason: "head-moved", message: `the story worktree is at ${audit.head}, not the approved ${head}` };
    const accepted = String(typeof opts["accept-unknown"] === "string" ? opts["accept-unknown"] : "").split(",").filter(Boolean);
    const unaccepted = audit.unknown.filter((c) => !accepted.includes(c));
    if (unaccepted.length) return { ok: false, reason: "unknown-commits", message: "the story has commits the gate did not make that the owner has not accepted", unknown: unaccepted };
    if (audit.configChanged) return { ok: false, reason: "config-changed", message: "the story's gate.json changed after init" };
    if (!this.isAncestor(audit.base, tip)) {
      return { ok: false, reason: "foreign-base", message: `the story was cut from ${audit.base}, which is not on ${this.branch}; it would bring another branch's unreviewed commits` };
    }

    const ib = `agt/integrate-${this.slug}`;
    const wt = this.candidate("integration", ib, tip);
    const title = typeof opts.title === "string" ? opts.title : `Merge ${gateConfig.branch} into ${this.branch}`;
    const merged = this.merge(wt, head, title, tip);
    if (!merged.ok) return { ...merged, story };

    // The merged tree equals the reviewed one only when the tip has not moved
    // since the story's base; then the story's own gate already checked it,
    // unless it ends in work the gate never passed.
    const reviewedTree = git(this.repo, ["rev-parse", `${head}^{tree}`]).out;
    const trivial = merged.tree === reviewedTree && audit.unverified.length === 0 && audit.unknown.length === 0;
    const verification = trivial
      ? { ran: false, ok: true, reason: "merged tree equals the reviewed, gate-verified tree" }
      : this.verify(wt, ib, gateConfig, story);
    const base = { id, kind: "story", story, approvedHead: head, storyBase: audit.base, targetOld: tip, mergeCommit: merged.commit, tree: merged.tree, unverified: audit.unverified, acceptedUnknown: audit.unknown, verification };
    if (!verification.ok) {
      this.record({ ...base, state: "failed", reason: verification.reason });
      return { ok: false, reason: "verification-failed", story, verification, mergeCommit: merged.commit };
    }
    this.record({ ...base, state: "verified" });
    const pushed = this.push(merged.commit);
    if (!pushed.ok) {
      this.record({ ...base, state: "failed", reason: pushed.reason });
      return { ...pushed, story, mergeCommit: merged.commit };
    }
    const receipt = this.record({ ...base, state: "pushed" });
    this.fetch();
    return { ok: true, story, receipt, dirty: audit.dirty, localRef: this.updateLocalRef(merged.commit) };
  }

  // ── refresh ───────────────────────────────────────────────────────
  refresh(opts) {
    this.fetch();
    const tip = this.remoteTip(this.branch);
    const targetTip = this.remoteTip(this.target);
    const behind = Number(git(this.repo, ["rev-list", "--count", `${tip}..${targetTip}`]).out);
    if (behind === 0) return { ok: true, upToDate: true, behind };
    const gateConfig = readJson(path.join(this.dir, "gate.template.json"), null);
    if (!gateConfig) throw new IntegrateError(`no gate.template.json in ${this.dir}`);
    const rb = `agt/refresh-${this.slug}`;
    const wt = this.candidate("refresh", rb, tip);
    const title = typeof opts.title === "string" ? opts.title : `Merge ${this.target} into ${this.branch}`;
    const merged = this.merge(wt, targetTip, title, tip);
    if (!merged.ok) return { ...merged, behind };
    // Files both sides changed: where a clean merge can still be wrong (two
    // branches adding the same key in different places).
    const mb = git(this.repo, ["merge-base", tip, targetTip]).out;
    const changed = (from, to) => new Set(git(this.repo, ["diff", "--name-only", from, to]).out.split("\n").filter(Boolean));
    const ours = changed(mb, tip);
    const bothSides = [...changed(mb, targetTip)].filter((f) => ours.has(f)).sort();
    const verification = this.verify(wt, rb, gateConfig, "refresh");
    const id = `refresh:${merged.commit}`;
    const entry = { id, kind: "refresh", head: merged.commit, tree: merged.tree, base: tip, target: targetTip, behind, bothSides, verification };
    if (!verification.ok) {
      this.record({ ...entry, state: "failed", reason: verification.reason });
      return { ok: false, reason: "verification-failed", head: merged.commit, worktree: wt, branch: rb, behind, bothSides, verification };
    }
    this.record({ ...entry, state: "awaiting-review" });
    return { ok: true, head: merged.commit, base: tip, worktree: wt, branch: rb, behind, bothSides, verification };
  }

  // ── land ──────────────────────────────────────────────────────────
  land(opts) {
    const head = String(opts.head || "");
    if (!/^[0-9a-f]{40}$/.test(head)) throw new IntegrateError("land needs --head <full sha>");
    const id = `refresh:${head}`;
    const entry = this.receipts().find((r) => r.id === id);
    this.fetch();
    const tip = this.remoteTip(this.branch);
    if (this.isAncestor(head, tip)) {
      return { ok: true, alreadyIntegrated: true, receipt: entry ? this.record({ ...entry, state: "pushed" }) : null, localRef: this.updateLocalRef(tip) };
    }
    if (!entry || !["awaiting-review", "failed"].includes(entry.state) || !entry.verification || !entry.verification.ok) {
      return { ok: false, reason: "not-a-verified-refresh", message: `${head} is not a verified refresh candidate; run refresh` };
    }
    const rb = `agt/refresh-${this.slug}`;
    const branchHead = git(this.repo, ["rev-parse", "-q", "--verify", `refs/heads/${rb}`], { allowFail: true }).out;
    if (branchHead !== head) return { ok: false, reason: "head-moved", message: `${rb} is at ${branchHead || "nothing"}, not the approved ${head}` };
    if (tip !== entry.base) return { ok: false, reason: "target-moved", message: `${this.branch} moved since the refresh was cut; run refresh again` };
    const pushed = this.push(head);
    if (!pushed.ok) {
      this.record({ ...entry, state: "failed", reason: pushed.reason });
      return pushed;
    }
    const receipt = this.record({ ...entry, state: "pushed" });
    this.fetch();
    return { ok: true, receipt, localRef: this.updateLocalRef(head) };
  }

  // ── receipts ──────────────────────────────────────────────────────
  // Saved receipts, each checked against the remote tip, so the host reads
  // what git proves rather than what was last written.
  listReceipts() {
    this.fetch();
    const tip = this.remoteTip(this.branch);
    const behind = Number(git(this.repo, ["rev-list", "--count", `${tip}..${this.remoteTip(this.target)}`]).out);
    const receipts = this.receipts().map((r) => {
      const sha = r.kind === "story" ? r.approvedHead : r.head;
      return { ...r, onRemote: Boolean(sha) && this.isAncestor(sha, tip) };
    });
    return { ok: true, tip, behind, receipts };
  }
}

function readJsonText(text) {
  try { return JSON.parse(String(text || "").trim().split("\n").pop()); } catch { return null; }
}

// One mutation at a time per epic: a second caller waits for the lock instead
// of racing the first on the candidate worktree, receipts, and push.
function withLock(epicDir, fn) {
  const lock = path.join(path.resolve(epicDir), "integrate.lock");
  const deadline = Date.now() + 60 * 60 * 1000;
  while (true) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      const holder = Number(fs.readFileSync(lock, "utf8") || 0);
      if (!holder || !pidAlive(holder)) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) return { ok: false, reason: "busy", message: `another integration (pid ${holder}) has held the lock for an hour` };
      sleep(1000);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

// An agent's shell call times out after ten minutes, and verification can run
// longer. `--detach` starts the subcommand in the background and prints
// { pending: true, token }; `wait` prints the result, or the token again.
function resultsDir(epicDir) {
  return path.join(path.resolve(epicDir), "results");
}

function detach(command, epicDir, argv) {
  const token = `${command}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = resultsDir(epicDir);
  fs.mkdirSync(dir, { recursive: true });
  const resultFile = path.join(dir, `${token}.json`);
  const rest = argv.filter((x) => x !== "--detach");
  const child = spawnSync("/bin/sh", ["-c", `nohup ${[process.execPath, __filename, command, epicDir, ...rest, "--result-file", resultFile].map(shellQuote).join(" ")} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  if (child.status !== 0) return { ok: false, reason: "error", message: "could not start the detached run" };
  fs.writeFileSync(path.join(dir, `${token}.pid`), child.stdout.trim());
  return { pending: true, token, ok: false };
}

function waitFor(epicDir, opts) {
  const token = String(opts.token || "");
  if (!/^[\w.-]+$/.test(token)) usage("wait needs --token");
  const resultFile = path.join(resultsDir(epicDir), `${token}.json`);
  const pidFile = path.join(resultsDir(epicDir), `${token}.pid`);
  const deadline = Date.now() + Math.min(Number(opts.timeout || 540), 570) * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) return readJson(resultFile, { ok: false, reason: "error", message: "unreadable result" });
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    if (pid && !pidAlive(pid)) {
      sleep(500);
      if (fs.existsSync(resultFile)) continue;
      return { ok: false, reason: "error", message: "the detached run exited without a result" };
    }
    sleep(2000);
  }
  return { pending: true, token, ok: false };
}

function main() {
  const argv = process.argv.slice(2);
  const { command, epicDir, opts } = parseArgs(argv);
  if (!command || !epicDir) usage("usage: epic-flow-integrate.js <integrate|refresh|land|receipts|wait> <epicDir> [options] [--detach]");
  if (command === "wait") {
    process.stdout.write(`${JSON.stringify(waitFor(epicDir, opts))}\n`);
    return;
  }
  if (!["integrate", "refresh", "land", "receipts"].includes(command)) usage(`unknown subcommand: ${command}`);
  if (opts.detach) {
    process.stdout.write(`${JSON.stringify(detach(command, epicDir, argv.slice(2)))}\n`);
    return;
  }
  let result;
  try {
    const epic = new Epic(epicDir);
    const run = () => {
      switch (command) {
        case "integrate": return epic.integrate(opts);
        case "refresh": return epic.refresh(opts);
        case "land": return epic.land(opts);
        default: return epic.listReceipts();
      }
    };
    result = withLock(epicDir, run);
  } catch (error) {
    result = { ok: false, reason: error instanceof IntegrateError ? "config" : "error", message: error.message };
  }
  if (typeof opts["result-file"] === "string") writeJson(opts["result-file"], result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
