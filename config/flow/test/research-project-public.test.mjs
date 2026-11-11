import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function snapshot(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path), mode = stat.mode & 0o777;
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
  const run = args => spawnSync(process.execPath, [cli, "research", ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  return { root, env, run };
}

test("public research help accepts plain question and source selections without creating state", t => {
  const f = privateResearch(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const option of ["--question", "--source", "--confirm", "--attach", "--cancel"]) assert.ok(result.stdout.includes(option), option);
  assert.match(result.stdout, /research/iu);
});
