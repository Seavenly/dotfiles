import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("public review help explains exact confirmation and continuation without starting work", t => {
  const root = mkdtempSync(join(tmpdir(), "flow-review-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config", "authority", "tmp"]) mkdirSync(join(root, name));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb",
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    FLOW_AUTHORITY_DIRECTORY: join(root, "authority"), TMPDIR: join(root, "tmp") };
  const result = spawnSync(process.execPath, [cli, "review", "--help"], {
    env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /--confirm/u);
  assert.match(result.stdout, /--attach/u);
  assert.match(result.stdout, /--cancel/u);
  assert.equal(existsSync(join(env.XDG_STATE_HOME, "flow-local")), false);
  for (const name of ["owner.json", "authority.sqlite", "runs.sqlite"]) {
    assert.equal(existsSync(join(env.FLOW_AUTHORITY_DIRECTORY, name)), false, name);
  }
});
