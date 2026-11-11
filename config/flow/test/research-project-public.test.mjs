import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return { mode, link: readlinkSync(path) };
  if (stat.isDirectory()) return { mode, children: Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])) };
  return { mode, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

function privateResearch(t) {
  const root = realpathSync(mkdtempSync("/tmp/flow-research-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb",
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const call = args => spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  return { root, env, call, run: args => call(["research", ...args]) };
}

test("public research help accepts plain question and source selections without creating state", t => {
  const f = privateResearch(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const option of ["--question", "--source", "--confirm", "--attach", "--cancel"]) assert.ok(result.stdout.includes(option), option);
  assert.match(result.stdout, /research/iu);
});

function cleanProject(t) {
  const f = privateResearch(t), repository = join(f.root, "project"); mkdirSync(repository);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env: f.env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Research public fixture"]); git(["config", "user.email", "research@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]); git(["config", "commit.gpgSign", "false"]);
  writeFileSync(join(repository, "README.md"), "This existing project has no feature brief or project test.\n");
  git(["add", "."]); git(["commit", "-qm", "Existing research context"]);
  const source = join(f.root, "observations.txt"); writeFileSync(source, "Research observations describe finite uncertainty.\n");
  return { ...f, repository, source, git };
}

test("research refuses missing setup and lifecycle-shaped invalid selections without creating state", t => {
  const f = cleanProject(t), before = snapshot(f.root);
  for (const args of [[], ["--question"], ["--question", "Which evidence remains uncertain?", "--source", f.source, "--launch"],
    ["--repository", f.repository, "--question", "Which evidence remains uncertain?", "--source", f.source, "--json"]]) {
    const result = f.run(args); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(snapshot(f.root), before);
  }
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("public research-purpose setup previews without an invented feature brief, tests or executable calls", t => {
  const f = cleanProject(t), before = snapshot(f.root);
  // The running Node is an existing native-format metadata fixture only. This
  // unconfirmed preview must never execute it as Codex or claim compatibility.
  const result = f.call(["init", "--purpose", "research", "--repository", f.repository,
    "--codex-executable", realpathSync(process.execPath), "--json"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.schema, "flow.project-init-plan/v1");
  assert.equal(preview.status, "confirmation_required"); assert.equal(preview.writes_performed, false);
  assert.equal(preview.plan.purpose, "research"); assert.ok(preview.confirmation_digest);
  for (const name of ["brief", "recipe", "project_check"]) assert.ok(preview.plan[name] === null || preview.plan[name] === undefined, name);
});
