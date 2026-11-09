import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const linux = { skip: process.platform !== "linux" && "Guided native setup currently requires Linux" };
const nativeTriple = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" }[process.arch];
const installedSupported = nativeTriple && join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-init-codex-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const part of ["project", "home", "codex-home", "mise-data", "bin", "state", "config", "tmp"]) mkdirSync(join(root, part));
  const repository = join(root, "project");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !name.endsWith("_API_KEY") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home"), MISE_DATA_DIR: join(root, "mise-data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: join(root, "tmp"),
    PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const files = {
    "package.json": JSON.stringify({ name: "codex-selection-fixture", private: true, scripts: { test: "node --test sum.test.mjs" } }),
    "sum.mjs": "export const sum = values => values.reduce((total, value) => total + value, 0);\n",
    "sum.test.mjs": 'import {writeFileSync} from "node:fs"; writeFileSync("project-test-executed", "unexpected");\n',
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(repository, name), bytes);
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", repository, ...args], { env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]); git(["config", "user.name", "Codex selection fixture"]);
  git(["config", "user.email", "codex-selection@example.invalid"]); git(["add", "."]); git(["commit", "-qm", "Existing project tests"]);
  const args = [cli, "init", "--repository", repository, "--summary", "Improve the existing sum utility", "--acceptance", "Existing sum tests pass"];
  const run = extra => spawnSync(process.execPath, [...args, ...extra], { env, encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const success = extra => { const result = run(extra); assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout); };
  const supported = () => {
    const path = join(env.CODEX_HOME, "packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
    mkdirSync(dirname(path), { recursive: true }); symlinkSync(installedSupported, path); return path;
  };
  const upgradedMise = () => {
    const mise = join(root, "mise"); writeFileSync(mise, '#!/bin/sh\ntouch "$HOME/shim-executed"\nexit 98\n', { mode: 0o700 });
    symlinkSync(mise, join(root, "bin/codex"));
    const launcher = join(env.MISE_DATA_DIR, "installs/codex/0.167.0/bin/codex");
    mkdirSync(dirname(launcher), { recursive: true });
    // Controlled installed-layout transport: any execution is observable. It is
    // not official native protocol or permission qualification evidence.
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/new-cli-invocations"\n[ "$1" = "--version" ] && { echo "codex-cli 0.167.0"; exit 0; }\nexit 99\n', { mode: 0o700 });
    symlinkSync("0.167.0", join(env.MISE_DATA_DIR, "installs/codex/latest")); return launcher;
  };
  const noActivity = () => {
    for (const marker of [join(env.HOME, "shim-executed"), join(env.HOME, "new-cli-invocations"), join(repository, "project-test-executed")]) assert.equal(existsSync(marker), false, marker);
    assert.equal(git(["status", "--porcelain"]), "");
  };
  return { root, repository, env, git, run, success, supported, upgradedMise, noActivity };
}

test("public init bypasses an upgraded Mise default for an already installed supported native Codex", linux, t => {
  if (!installedSupported || !existsSync(installedSupported)) return t.skip("Retained official Codex 0.166 native binary is not installed; no binary is downloaded");
  const f = fixture(t); f.upgradedMise(); f.supported();
  const preview = f.success(["--json"]);
  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.writes_performed, false);
  assert.equal(preview.plan.codex_executable.path, realpathSync(installedSupported));
  assert.equal(preview.plan.codex_executable.sha256, hash(readFileSync(installedSupported)));
  f.noActivity(); assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  const accepted = f.success(["--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(accepted.status, "request_only"); assert.equal(accepted.owner_started, false); assert.equal(accepted.provider_execution, "not_run");
  const metadata = JSON.parse(readFileSync(join(accepted.directory, "pilot.json"), "utf8"));
  assert.equal(metadata.local_client.executable.path, realpathSync(installedSupported));
  assert.equal(metadata.local_client.executable.version, "codex-cli 0.166.0");
  assert.equal(existsSync(join(metadata.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
  assert.equal(existsSync(join(metadata.environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
  f.noActivity();
});
