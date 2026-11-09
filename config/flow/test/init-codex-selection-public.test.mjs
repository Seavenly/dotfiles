import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const linux = { skip: process.platform !== "linux" && "Guided native setup currently requires Linux" };
const nativeTriple = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" }[process.arch];
const installedSupported = nativeTriple && join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
const hash = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

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
  // Mandatory discovery cases use a small ELF as metadata only. They never
  // confirm that sentinel or claim it is compatible with the native protocol.
  const native = join(root, "native-format-sentinel"); copyFileSync("/usr/bin/true", native); chmodSync(native, 0o700);
  const supported = (target = native) => {
    const path = join(env.CODEX_HOME, "packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
    mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); return path;
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
  const noActivity = ({ versionProbe = false } = {}) => {
    const markers = [join(env.HOME, "shim-executed"), join(repository, "project-test-executed")];
    if (!versionProbe) markers.push(join(env.HOME, "new-cli-invocations"));
    for (const marker of markers) assert.equal(existsSync(marker), false, marker);
    assert.equal(git(["status", "--porcelain"]), "");
  };
  return { root, repository, env, git, run, success, supported, upgradedMise, noActivity, native };
}

test("public init previews a known native layout instead of an upgraded Mise launcher without executing either", linux, t => {
  const f = fixture(t); f.upgradedMise(); f.supported();
  const preview = f.success(["--json"]);
  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.writes_performed, false);
  assert.equal(preview.plan.codex_executable.path, f.native);
  assert.equal(preview.plan.codex_executable.sha256, hash(readFileSync(f.native)));
  assert.equal(preview.plan.codex_executable.expected_version, "codex-cli 0.166.0");
  assert.equal(preview.plan.codex_executable.provenance.kind, "standalone_release");
  assert.equal(typeof preview.plan.codex_executable.provenance.location, "string");
  assert.equal(typeof preview.plan.codex_executable.bypass_reason, "string");
  const rendered = f.run([]); assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  assert.ok(rendered.stdout.includes(f.native)); assert.match(rendered.stdout, /Expected CLI version.*not observed.*0\.166\.0/u);
  assert.match(rendered.stdout, /CLI selection: standalone_release/u); assert.match(rendered.stdout, /bypassed/u);
  f.noActivity(); assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
});

test("public init preserves original profile pins and rejects drift without repairing declared fixture metadata", linux, t => {
  const f = fixture(t); const selected = f.supported();
  const original = f.success(["--codex-executable", selected, "--json"]);
  const plan = original.plan;
  const profile = join(dirname(plan.setup.authority_directory), "profile.json");
  mkdirSync(dirname(profile), { recursive: true });
  // This is owned declarative profile metadata, not a generated client or a
  // successful native setup. Public confirmation of the sentinel is forbidden.
  writeFileSync(profile, JSON.stringify({ identity: { schema: "flow.local-client/v1", repository: f.repository,
    runtime_root: plan.runtime_root, node: plan.node, git_identity: plan.git_identity,
    execution_trust: { schema: "flow.supervised-native-cli/v1", acknowledgment: "trust-official-cli-permissions" },
    executable: { path: f.native, version: "codex-cli 0.166.0", sha256: hash(readFileSync(f.native)) } }, initial_check_digest: plan.registration_digest }));
  const preserved = readFileSync(profile);
  f.upgradedMise();
  const preview = f.success(["--json"]);
  assert.equal(preview.plan.codex_executable.path, f.native);
  assert.equal(preview.plan.codex_executable.provenance.kind, "original_profile");
  assert.deepEqual(readFileSync(profile), preserved);
  assert.equal(existsSync(plan.setup.authority_directory), false);
  f.noActivity();
  // Corrupt only this owned fixture's declarative profile pin. Discovery must
  // not repair it by selecting a different installation or rewriting clients.
  const altered = JSON.parse(readFileSync(profile, "utf8"));
  altered.identity.executable.sha256 = `sha256:${"0".repeat(64)}`;
  writeFileSync(profile, JSON.stringify(altered));
  const invalid = f.run(["--json"]);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /profile|pin|changed|identity/iu);
  assert.deepEqual(JSON.parse(readFileSync(profile, "utf8")), altered); f.noActivity();
});

test("an explicit unsupported Codex is never substituted by the installed supported default", linux, t => {
  const f = fixture(t); const explicit = f.upgradedMise(); f.supported();
  const preview = f.success(["--codex-executable", explicit, "--json"]);
  assert.equal(preview.plan.codex_executable.path, realpathSync(explicit)); f.noActivity();
  assert.equal(preview.plan.codex_executable.provenance.kind, "explicit");
  const rejected = f.run(["--codex-executable", explicit, "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /unsupported_executable_version|supported.*0\.166|0\.166.*supported/u);
  assert.match(readFileSync(join(f.env.HOME, "new-cli-invocations"), "utf8"), /^(?:--version\n)+$/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  f.noActivity({ versionProbe: true });
});

test("no supported installation in the selected roots gives guidance without running candidate code", linux, t => {
  const f = fixture(t); f.upgradedMise();
  const result = f.run(["--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /0\.166\.0/u); assert.match(result.stderr, /--codex-executable|absolute.*path/iu);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false); f.noActivity();
});

test("exact explicit aliases are canonical and changed bytes invalidate their public preview", linux, t => {
  const f = fixture(t), executable = join(f.root, "selected-native"), alias = join(f.root, "selected-alias");
  copyFileSync("/usr/bin/true", executable); chmodSync(executable, 0o700); symlinkSync(executable, alias);
  const preview = f.success(["--codex-executable", alias, "--json"]);
  assert.equal(preview.plan.codex_executable.path, executable);
  writeFileSync(executable, Buffer.concat([readFileSync(executable), Buffer.from("changed after preview")]));
  const rejected = f.run(["--codex-executable", alias, "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /changed|fresh.*plan|confirmation.*match/iu);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false); f.noActivity();
});

test("a supported Mise npm layout pins its native payload instead of executing its JS launcher", linux, t => {
  const f = fixture(t); f.upgradedMise();
  const release = join(f.env.MISE_DATA_DIR, "installs/codex/0.166.0");
  const npm = join(release, "lib/node_modules/@openai/codex");
  const native = join(npm, "node_modules", `@openai/codex-linux-${process.arch}`, "vendor", nativeTriple, "bin/codex");
  mkdirSync(dirname(native), { recursive: true }); symlinkSync(f.native, native);
  mkdirSync(join(npm, "bin"));
  writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.166.0", bin: { codex: "bin/codex.js" } }));
  writeFileSync(join(npm, "bin/codex.js"), 'require("node:fs").writeFileSync(process.env.HOME + "/npm-launcher-executed", "unexpected");\n', { mode: 0o700 });
  mkdirSync(join(release, "bin")); symlinkSync(join(npm, "bin/codex.js"), join(release, "bin/codex"));
  const preview = f.success(["--json"]);
  assert.equal(preview.plan.codex_executable.path, f.native);
  assert.equal(preview.plan.codex_executable.provenance.kind, "mise_release");
  assert.equal(preview.plan.codex_executable.expected_version, "codex-cli 0.166.0");
  assert.equal(existsSync(join(f.env.HOME, "npm-launcher-executed")), false); f.noActivity();
});

test("selected Codex and Mise roots isolate discovery from other HOME installations and malformed candidates", linux, t => {
  const f = fixture(t); f.upgradedMise();
  const ignored = join(f.env.HOME, ".codex/packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
  mkdirSync(dirname(ignored), { recursive: true }); symlinkSync(f.native, ignored);
  const candidate = join(f.env.CODEX_HOME, "packages/standalone/releases", `0.166.0-${nativeTriple}`, "bin/codex");
  mkdirSync(dirname(candidate), { recursive: true });
  const refused = () => {
    const result = f.run(["--json"]); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /0\.166\.0/u); assert.match(result.stderr, /--codex-executable|absolute.*path/iu);
    assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false); f.noActivity();
  };
  symlinkSync(join(f.root, "missing-native"), candidate); refused(); unlinkSync(candidate);
  mkdirSync(candidate); refused(); rmSync(candidate, { recursive: true });
  copyFileSync("/usr/bin/true", candidate); chmodSync(candidate, 0o600); refused();
});

test("real installed Codex 0.166 confirms default setup and reuses exact clients without starting work", linux, t => {
  if (!installedSupported || !existsSync(installedSupported)) return t.skip("Optional real-version confirmation: retained official Codex 0.166 native binary is not installed in selected process HOME/CODEX_HOME; mandatory discovery tests still run");
  const f = fixture(t); f.upgradedMise(); f.supported(installedSupported);
  const preview = f.success(["--json"]);
  assert.equal(preview.plan.codex_executable.path, realpathSync(installedSupported)); f.noActivity();
  const accepted = f.success(["--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(accepted.status, "request_only"); assert.equal(accepted.owner_started, false); assert.equal(accepted.provider_execution, "not_run");
  const preserved = [accepted.client, join(accepted.directory, "pilot.json"), join(accepted.directory, "trusted-owner.mjs"), join(accepted.directory, "../../profile.json")].map(path => [path, readFileSync(path)]);
  const metadata = JSON.parse(readFileSync(join(accepted.directory, "pilot.json"), "utf8"));
  assert.equal(metadata.local_client.executable.path, realpathSync(installedSupported));
  assert.equal(metadata.local_client.executable.version, "codex-cli 0.166.0");
  const repeat = f.success(["--json"]);
  assert.equal(repeat.plan.codex_executable.provenance.kind, "original_profile");
  const reused = f.success(["--confirm", repeat.confirmation_digest, "--json"]);
  assert.equal(reused.client, accepted.client); assert.equal(reused.profile_reused, true);
  for (const [path, bytes] of preserved) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(metadata.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
  assert.equal(existsSync(join(metadata.environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false); f.noActivity();
});
