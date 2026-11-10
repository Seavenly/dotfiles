import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function privateState(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-runs-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const run = args => spawnSync(process.execPath, [cli, "runs", ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  return { root, env, run };
}

function snapshot(root) {
  const result = {};
  const visit = (path, relative) => {
    const stat = lstatSync(path), item = { mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) item.link = readlinkSync(path);
    else if (stat.isFile()) item.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    else if (stat.isDirectory()) {
      item.type = "directory"; result[relative] = item;
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    } else item.type = "other";
    result[relative] = item;
  };
  visit(root, "."); return result;
}

test("public runs help describes the read-only inventory without creating local state", t => {
  const f = privateState(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /flow-supervised runs/u);
  assert.match(result.stdout, /read.only|without starting|starts no owner/iu);
});

test("an uninitialized project has an honest empty inventory and plain init guidance", t => {
  const f = privateState(t), repository = join(f.root, "project"); mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q", repository], { env: f.env });
  const before = snapshot(f.root), result = f.run(["--repository", repository, "--json"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, "flow.project-runs/v1"); assert.equal(value.status, "uninitialized");
  assert.deepEqual(value.attempts, []); assert.deepEqual(value.clients, []);
  const human = f.run(["--repository", repository]);
  assert.equal(human.status, 0, human.stdout + human.stderr); assert.match(human.stdout, /flow-supervised init/u);
  assert.deepEqual(snapshot(f.root), before);
});

test("invalid project selections and lifecycle-shaped flags refuse without creating state", t => {
  const f = privateState(t), before = snapshot(f.root);
  for (const args of [["--repository", join(f.root, "absent"), "--json"], ["--confirm", `sha256:${"a".repeat(64)}`], ["--cancel", "run:unknown"]]) {
    const result = f.run(args); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(snapshot(f.root), before);
  }
});
