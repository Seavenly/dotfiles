import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { codexExecutionAdapter } from "../../../tools/flow/src/codex-execution-adapter.mjs";

const expectedVersion = codexExecutionAdapter.supportedVersionForTrust("supervised-native-cli");
const release = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(expectedVersion)?.[1];
const hash = path => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const fail = (message, code) => { const error = new Error(message); if (code) error.code = code; throw error; };

function executable(path, native = false) {
  if (!isAbsolute(path)) fail("Select an absolute --codex-executable path");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) fail("Codex executable must be a regular executable file");
  accessSync(canonical, constants.X_OK | constants.R_OK);
  if (native) {
    const descriptor = openSync(canonical, "r");
    try {
      const header = Buffer.alloc(4);
      if (readSync(descriptor, header, 0, 4, 0) !== 4 || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        fail("Default Codex selection requires a native ELF binary, not a script or shim");
      }
    } finally { closeSync(descriptor); }
  }
  return canonical;
}

function selection(path, kind, location, bypassReason = null, sha256 = hash(path)) {
  return { path, sha256, expected_version: expectedVersion,
    provenance: { kind, location }, bypass_reason: bypassReason };
}

function originalSelection(profilePath, repository) {
  if (!existsSync(profilePath)) {
    // A partial or broken profile must not become a fresh installation selection.
    try { lstatSync(profilePath); } catch (error) { if (error.code === "ENOENT" && !existsSync(dirname(profilePath))) return null; if (error.code === "ENOENT") fail("Existing project profile is incomplete; retain its authority and original executable selection"); throw error; }
    fail("Existing project profile is unreadable; retain its authority and repair the original selection separately");
  }
  try {
    const stat = lstatSync(profilePath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || realpathSync(profilePath) !== resolve(profilePath)) throw new Error("Expected a canonical regular profile of at most 4 MiB");
    const fd = openSync(profilePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let profile;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4 * 1024 * 1024) throw new Error("Profile changed before reading");
      profile = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    const identity = profile.identity, pinned = identity?.executable;
    if (identity?.schema !== "flow.local-client/v1" || identity.repository !== repository ||
        typeof identity.runtime_root !== "string" || !isAbsolute(identity.runtime_root) ||
        typeof identity.node !== "string" || !isAbsolute(identity.node) ||
        identity.execution_trust?.schema !== "flow.supervised-native-cli/v1" || identity.execution_trust.acknowledgment !== "trust-official-cli-permissions" ||
        ![identity.git_identity?.author, identity.git_identity?.committer].every(person => typeof person?.name === "string" && person.name && typeof person.email === "string" && person.email) ||
        !pinned || pinned.version !== expectedVersion || typeof pinned.path !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(pinned.sha256)) throw new Error("incompatible pins");
    const path = executable(pinned.path);
    if (path !== pinned.path || hash(path) !== pinned.sha256) throw new Error("executable drift");
    return selection(path, "original_profile", profilePath, "The original project executable is retained; PATH defaults do not retarget existing clients.", pinned.sha256);
  } catch {
    fail(`Existing project Codex profile is malformed, incompatible or changed. Retain its exact executable and authority; expected ${expectedVersion}. No alternate executable was selected.`);
  }
}

/** Read only known installation metadata. Expected version is not an observed version. */
export function selectInitCodex({ repository, profilePath, explicitPath, env = process.env }) {
  if (explicitPath !== undefined) return selection(executable(explicitPath), "explicit", explicitPath);
  const original = originalSelection(profilePath, repository);
  if (original) return original;
  if (!release) fail("The supervised Codex policy has no supported installation version");
  const home = env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const miseData = env.MISE_DATA_DIR ?? join(home, ".local/share/mise");
  if (![home, codexHome, miseData].every(isAbsolute)) fail("Codex installation roots must be absolute HOME, CODEX_HOME and MISE_DATA_DIR paths");
  const target = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" }[process.arch];
  const packageName = { x64: "codex-linux-x64", arm64: "codex-linux-arm64" }[process.arch];
  const candidates = [];
  const add = (path, kind, location) => candidates.push({ path, kind, location });
  if (process.platform === "linux" && target) {
    const standalone = join(codexHome, "packages/standalone");
    add(join(standalone, "releases", `${release}-${target}`, "bin/codex"), "standalone_release", standalone);
    // `current` is only a candidate when its resolved release metadata is supported.
    try {
      const current = realpathSync(join(standalone, "current"));
      if (current === realpathSync(join(standalone, "releases", `${release}-${target}`))) add(join(standalone, "current/bin/codex"), "standalone_release", standalone);
    } catch { /* Missing installations are reported together below. */ }
    const mise = join(miseData, "installs/codex", release);
    const npm = join(mise, "lib/node_modules/@openai/codex");
    // Both official npm payload layouts have existed. The JS launcher is never selected.
    for (const path of [join(npm, "node_modules/@openai", packageName, "vendor", target, "bin/codex"), join(npm, "vendor", target, "bin/codex"), join(mise, "bin/codex")]) {
      add(path, "mise_release", mise);
    }
  }
  const seen = new Set();
  const available = [];
  for (const candidate of candidates) {
    try {
      const path = executable(candidate.path, true);
      if (!seen.has(path)) { seen.add(path); available.push({ ...candidate, path }); }
    } catch { /* Invalid/uninstalled candidates do not justify executing a launcher. */ }
  }
  const pathDefault = (env.PATH ?? "").split(":").filter(Boolean).map(directory => resolve(directory, "codex")).find(path => {
    try { executable(path); return true; } catch { return false; }
  });
  // PATH may alias one of the known supported payloads, but cannot authorize an unknown layout.
  let defaultCanonical;
  try { if (pathDefault) defaultCanonical = executable(pathDefault); } catch { /* Diagnostic only. */ }
  const chosen = available.find(candidate => candidate.path === defaultCanonical) ?? available[0];
  if (!chosen) fail(`No supported native ${expectedVersion} installation was found in the selected CODEX_HOME or MISE_DATA_DIR. Install it separately or provide --codex-executable ABSOLUTE_PATH to an existing supported official binary. Init installs nothing and does not execute discovery candidates.`, "supported_codex_not_found");
  const bypass = pathDefault && defaultCanonical !== chosen.path
    ? `PATH entry ${pathDefault} was bypassed: it is not a selected known supported native ${expectedVersion} payload.` : null;
  return selection(chosen.path, chosen.kind, chosen.location, bypass);
}
