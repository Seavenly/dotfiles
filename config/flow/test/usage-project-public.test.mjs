import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function snapshot(root) {
  const rows = {};
  const visit = (path, relative) => {
    const stat = lstatSync(path), row = { mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) row.link = readlinkSync(path);
    else if (stat.isFile()) row.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    else if (stat.isDirectory()) {
      row.type = "directory"; rows[relative] = row;
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    } else row.type = "other";
    rows[relative] = row;
  };
  visit(root, "."); return rows;
}

function privateUsage(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-usage-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const run = args => spawnSync(process.execPath, [cli, "usage", ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  return { root, env, run };
}

test("public usage help describes run-scoped read-only measurements without creating state", t => {
  const f = privateUsage(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /flow-supervised usage/u);
  assert.match(result.stdout, /--run/u);
  assert.match(result.stdout, /read.only|no owner|without start/iu);
});
