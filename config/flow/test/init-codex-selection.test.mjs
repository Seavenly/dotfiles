import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { selectInitCodex } from "../src/init-codex-selection.mjs";
import { codexExecutionAdapter } from "../../../tools/flow/src/codex-execution-adapter.mjs";
const version = codexExecutionAdapter.supportedVersionForTrust("supervised-native-cli");
const release = version.split(" ")[1];
const target = process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
const linux = { skip: process.platform !== "linux" && "Known default native layouts belong to the supported Linux backend" };
const sha = path => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "init-codex-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); mkdirSync(home);
  const repository = join(root, "project"); mkdirSync(repository);
  const profilePath = join(root, "state/project/profile.json");
  const env = { HOME: home, CODEX_HOME: join(home, ".codex"), MISE_DATA_DIR: join(home, ".local/share/mise"), PATH: join(root, "path") };
  const standalone = join(env.CODEX_HOME, "packages/standalone/releases", `${release}-${target}`, "bin/codex");
  // Reduced native metadata, deliberately not runnable. Selection must never execute it.
  const native = path => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from("\x7fELFselection fixture only"), { mode: 0o700 }); return path; };
  const select = extra => selectInitCodex({ repository, profilePath, env, ...extra });
  const profile = path => { mkdirSync(dirname(profilePath), { recursive: true }); writeFileSync(profilePath, JSON.stringify({ identity: { schema: "flow.local-client/v1", repository, runtime_root: root, node: process.execPath,
    execution_trust: { schema: "flow.supervised-native-cli/v1", acknowledgment: "trust-official-cli-permissions" }, git_identity: { author: { name: "Fixture", email: "fixture@example.invalid" }, committer: { name: "Fixture", email: "fixture@example.invalid" } },
    executable: { path, version, sha256: sha(path) } } })); };
  return { root, repository, profilePath, env, standalone, native, select, profile };
}

test("known native selection bypasses PATH scripts without executing or reading authentication", linux, t => {
  const f = fixture(t); f.native(f.standalone);
  mkdirSync(f.env.PATH); const marker = join(f.root, "executed");
  writeFileSync(join(f.env.PATH, "codex"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  // Auth entries are not discovery inputs, even when they are unreadable/broken aliases.
  symlinkSync(join(f.root, "absent-private-auth"), join(f.env.CODEX_HOME, "auth.json"));
  const result = f.select();
  assert.equal(result.path, f.standalone); assert.equal(result.sha256, sha(f.standalone));
  assert.equal(result.expected_version, version); assert.equal(result.provenance.kind, "standalone_release");
  assert.match(result.bypass_reason, /PATH.*bypassed/u); assert.equal(existsSync(marker), false);
});

test("selected custom roots, known layout metadata and malformed payloads do not fall back to host home", linux, t => {
  const f = fixture(t); f.native(f.standalone);
  const env = { ...f.env, CODEX_HOME: join(f.root, "other-codex"), MISE_DATA_DIR: join(f.root, "other-mise") };
  assert.throws(() => f.select({ env }), /No supported native.*--codex-executable/u);
  const candidate = join(env.CODEX_HOME, "packages/standalone/releases", `${release}-${target}`, "bin/codex");
  mkdirSync(dirname(candidate), { recursive: true }); writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.throws(() => f.select({ env }), /No supported native/u);
  unlinkSync(candidate); mkdirSync(candidate); assert.throws(() => f.select({ env }), /No supported native/u);
  rmSync(candidate, { recursive: true }); f.native(candidate); chmodSync(candidate, 0o600);
  assert.throws(() => f.select({ env }), /No supported native/u);
  chmodSync(candidate, 0o700); assert.equal(f.select({ env }).path, candidate);
});

test("original executable survives newer defaults and rejects missing, malformed, version and hash drift", linux, t => {
  const f = fixture(t); const original = f.native(join(f.root, "original-codex")); f.profile(original); f.native(f.standalone);
  assert.equal(f.select().path, original); assert.equal(f.select().provenance.kind, "original_profile");
  writeFileSync(original, "changed", { mode: 0o700 }); assert.throws(() => f.select(), /Existing project Codex profile.*changed/u);
  f.native(original); f.profile(original);
  const profile = JSON.parse(readFileSync(f.profilePath)); profile.identity.executable.version = "codex-cli 99.0.0";
  writeFileSync(f.profilePath, JSON.stringify(profile)); assert.throws(() => f.select(), /incompatible/u);
  writeFileSync(f.profilePath, "{}"); assert.throws(() => f.select(), /malformed/u);
  unlinkSync(f.profilePath); assert.throws(() => f.select(), /incomplete/u);
});

test("explicit aliases stay exact, preserve unknown layouts and hash changed bytes without discovery execution", linux, t => {
  const f = fixture(t); const native = f.native(join(f.root, "unlabelled-native"));
  const alias = join(f.root, "selected"); symlinkSync(native, alias);
  const first = f.select({ explicitPath: alias }); assert.equal(first.path, native); assert.equal(first.provenance.kind, "explicit");
  writeFileSync(native, "different bytes"); const changed = f.select({ explicitPath: alias }); assert.notEqual(changed.sha256, first.sha256);
  assert.throws(() => f.select({ explicitPath: "relative" }), /absolute/u);
});

test("known Mise payload and canonical aliases select once without invoking npm or latest shims", linux, t => {
  const f = fixture(t);
  const packageName = process.arch === "arm64" ? "codex-linux-arm64" : "codex-linux-x64";
  const native = f.native(join(f.env.MISE_DATA_DIR, "installs/codex", release, "lib/node_modules/@openai/codex/node_modules/@openai", packageName, "vendor", target, "bin/codex"));
  mkdirSync(f.env.PATH); symlinkSync(native, join(f.env.PATH, "codex"));
  assert.equal(f.select().path, native); assert.equal(f.select().provenance.kind, "mise_release"); assert.equal(f.select().bypass_reason, null);
  mkdirSync(dirname(f.standalone), { recursive: true }); symlinkSync(native, f.standalone);
  assert.equal(f.select().path, native); assert.equal(f.select().provenance.kind, "standalone_release");
});

test("original profile aliases are refused before reading unrelated file bytes", linux, t => {
  const f = fixture(t); const native = f.native(join(f.root, "original-native")); f.profile(native);
  const unrelated = join(f.root, "unrelated-owned-file"); writeFileSync(unrelated, readFileSync(f.profilePath));
  unlinkSync(f.profilePath); symlinkSync(unrelated, f.profilePath);
  assert.throws(() => f.select(), /profile.*regular|profile.*alias|profile.*malformed/iu);
});


test("original profile directories, FIFOs, oversized files and ancestor aliases refuse without a fallback", linux, t => {
  const f = fixture(t); f.native(f.standalone); mkdirSync(dirname(f.profilePath), { recursive: true });
  mkdirSync(f.profilePath); assert.throws(() => f.select(), /profile.*malformed/iu); rmSync(f.profilePath, { recursive: true });
  execFileSync("/usr/bin/mkfifo", [f.profilePath]); assert.throws(() => f.select(), /profile.*malformed/iu); unlinkSync(f.profilePath);
  writeFileSync(f.profilePath, Buffer.alloc(4 * 1024 * 1024 + 1, 32)); assert.throws(() => f.select(), /profile.*malformed/iu); unlinkSync(f.profilePath);
  const original = f.native(join(f.root, "original")); f.profile(original);
  const alias = join(f.root, "profile-parent"); symlinkSync(dirname(f.profilePath), alias);
  assert.throws(() => f.select({ profilePath: join(alias, "profile.json") }), /profile.*malformed/iu);
  unlinkSync(f.profilePath); symlinkSync(join(f.root, "missing"), f.profilePath);
  assert.throws(() => f.select(), /profile.*unreadable/iu);
});
