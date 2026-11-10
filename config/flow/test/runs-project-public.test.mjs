import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("public runs help describes the read-only inventory without creating local state", t => {
  const root = mkdtempSync(join(tmpdir(), "flow-runs-public-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") });
  const before = readdirSync(root, { recursive: true });
  const result = spawnSync(process.execPath, [cli, "runs", "--help"], { env, cwd: root, encoding: "utf8", timeout: 10000 });
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /flow-supervised runs/u);
  assert.match(result.stdout, /read.only|without starting|starts no owner/iu);
});
