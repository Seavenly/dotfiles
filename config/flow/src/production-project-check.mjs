import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve, isAbsolute, relative, dirname, basename } from "node:path";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";
import { PROJECT_CHECK_SCOPE } from "../../../tools/flow/src/project-check.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashed = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? "");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function projectCheckError(code) { const error = new TypeError(code); error.code = code; return error; }
const invalid = () => { throw projectCheckError("project_check_invalid"); };
export function projectPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("-") && path.split("/").every(part => /^[a-zA-Z0-9_.-]+$/u.test(part) && ![".", "..", ".git", ".agents"].includes(part) && !privateNames.has(part));
}
const privateNames = new Set([".ssh", ".aws", ".codex", ".claude", ".config", ".gnupg", ".docker", ".kube", ".azure", ".password-store", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".gitconfig", "auth.json", "credentials.json", "pip.conf", ".vault-token"]);
const overlap = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export function assertProjectReadPath(path, { authorityDirectory, home = process.env.HOME } = {}) {
  home = home && (existsSync(home) ? realpathSync(home) : resolve(home));
  const authority = authorityDirectory && (existsSync(authorityDirectory) ? realpathSync(authorityDirectory) : resolve(authorityDirectory));
  if (path.split("/").some(part => privateNames.has(part)) || ["/etc", "/proc", "/dev", "/root"].some(root => path === root || path.startsWith(root + "/")) ||
      home && (path === home || home.startsWith(path + "/")) ||
      authority && overlap(path, authority)) throw projectCheckError("project_check_private_input");
}
const absolute = path => typeof path === "string" && isAbsolute(path) && resolve(path) === path && !path.includes("\0");
export function validateProjectCheck(config) {
  if (!exact(config, ["schema", "check_id", "executable", "argv", "version_argv", "version", "cwd", "pinned_files", "criteria", "read_mounts", "environment", "limits"]) ||
      config.schema !== "flow.production-project-check/v2" || !/^[a-zA-Z0-9:_-]{1,128}$/u.test(config.check_id ?? "") ||
      !exact(config.executable, ["path", "sha256"]) || !absolute(config.executable.path) || !hashed(config.executable.sha256) ||
      /\/(?:ba|da|z|fi|k|c|tc)?sh$/u.test(config.executable.path) ||
      ![config.argv, config.version_argv].every(args => Array.isArray(args) && args.length > 0 && args.length <= 128 && args.every(arg => typeof arg === "string" && !arg.includes("\0") && Buffer.byteLength(arg) <= 8192)) ||
      typeof config.version !== "string" || config.version.length === 0 || Buffer.byteLength(config.version) > 4096 ||
      config.cwd !== "." && !projectPath(config.cwd) || !Array.isArray(config.criteria) || config.criteria.length === 0 || config.criteria.some(x => typeof x !== "string" || !x) || new Set(config.criteria).size !== config.criteria.length ||
      !Array.isArray(config.pinned_files) || config.pinned_files.length === 0 || config.pinned_files.some(x => !exact(x, ["path", "sha256"]) || !projectPath(x.path) || !hashed(x.sha256)) || new Set(config.pinned_files.map(x => x.path)).size !== config.pinned_files.length ||
      !Array.isArray(config.read_mounts) || config.read_mounts.length === 0 || config.read_mounts.length > 64 ||
      !exact(config.limits, ["timeout_ms", "max_output_bytes"]) || !Number.isSafeInteger(config.limits.timeout_ms) || config.limits.timeout_ms < 1 || config.limits.timeout_ms > 1800000 ||
      !Number.isSafeInteger(config.limits.max_output_bytes) || config.limits.max_output_bytes < 1024 || config.limits.max_output_bytes > 16 * 1024 * 1024) invalid();
  const envKeys = new Set(["PATH", "LANG", "LC_ALL", "NODE_ENV", "PYTHONHASHSEED", "GOROOT", "GOTOOLCHAIN", "GOPROXY", "GOSUMDB", "CGO_ENABLED"]);
  if (!config.environment || !Object.hasOwn(config.environment, "PATH") || Object.entries(config.environment).some(([key, value]) => !envKeys.has(key) || typeof value !== "string" || value.includes("\0") || value.length > 4096) ||
      config.environment.GOTOOLCHAIN !== undefined && config.environment.GOTOOLCHAIN !== "local" || config.environment.GOPROXY !== undefined && config.environment.GOPROXY !== "off" || config.environment.GOSUMDB !== undefined && config.environment.GOSUMDB !== "off" || config.environment.CGO_ENABLED !== undefined && config.environment.CGO_ENABLED !== "0") invalid();
  const targets = [];
  for (const mount of config.read_mounts) {
    if (!exact(mount, ["source", "target", "sha256"]) || !absolute(mount.source) || !absolute(mount.target) || !hashed(mount.sha256) ||
        ["/", "/usr", "/lib", "/lib64", "/bin", "/etc", "/home", "/root", "/tmp", "/proc", "/dev", "/scratch", "/workspace"].includes(mount.target) ||
        ["/etc", "/proc", "/dev", "/scratch", "/tmp"].some(path => mount.target.startsWith(path + "/")) ||
        /\/(?:\.ssh|\.aws|\.codex|\.claude|\.config|\.local\/state)(?:\/|$)/u.test(mount.source) ||
        mount.source.split("/").filter(Boolean).length < 3 || targets.some(path => path === mount.target || path.startsWith(mount.target + "/") || mount.target.startsWith(path + "/"))) invalid();
    assertProjectReadPath(mount.source);
    targets.push(mount.target);
  }
  if (!targets.some(path => config.executable.path === path || config.executable.path.startsWith(path + "/"))) invalid();
  return freezeCanonical(config);
}

/** A directory binding includes content, executable bits and in-root symlinks. */
export function projectInputDigest(path) {
  if (privateNames.has(basename(path))) throw projectCheckError("project_check_private_input");
  const root = realpathSync(path);
  if (root !== path) throw projectCheckError("project_check_input_drift");
  const records = []; let total = 0, count = 0;
  function walk(path, name) {
    if (++count > 100000) throw projectCheckError("project_check_input_limit");
    if (name.split("/").some(part => privateNames.has(part))) throw projectCheckError("project_check_private_input");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path), rel = relative(root, target);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw projectCheckError("project_check_symlink_escape");
      records.push({ path: name, symlink: readlinkSync(path) });
    } else if (stat.isDirectory()) {
      records.push({ path: name, directory: true });
      for (const child of readdirSync(path).sort()) walk(join(path, child), name ? name + "/" + child : child);
    } else if (stat.isFile()) {
      total += stat.size; if (total > 1024 * 1024 * 1024) throw projectCheckError("project_check_input_limit");
      records.push({ path: name, executable: Boolean(stat.mode & 0o111), sha256: hash(readFileSync(path)) });
    } else throw projectCheckError("project_check_input_invalid");
  }
  if (lstatSync(path).isFile()) {
    if (lstatSync(path).size > 256 * 1024 * 1024) throw projectCheckError("project_check_input_limit");
    return hash(readFileSync(path));
  }
  walk(path, ""); return digest(records);
}

export function resolveProjectCheck({ config: input, brief, workspace, runnerIdentity, authorityDirectory = process.env.FLOW_AUTHORITY_DIRECTORY }) {
  if (process.platform !== "linux") throw projectCheckError("project_check_backend_unsupported");
  const config = validateProjectCheck(input);
  if (digest(config.criteria) !== digest(brief.acceptance)) throw projectCheckError("project_check_criterion_mismatch");
  const root = realpathSync(workspace.path);
  if (root !== resolve(workspace.path) || realpathSync(config.executable.path) !== config.executable.path || projectInputDigest(config.executable.path) !== config.executable.sha256) throw projectCheckError("project_check_input_drift");
  const executableMount = config.read_mounts.find(mount => config.executable.path === mount.target || config.executable.path.startsWith(mount.target + "/"));
  const mountedExecutable = executableMount && join(executableMount.source, relative(executableMount.target, config.executable.path));
  if (!mountedExecutable || realpathSync(mountedExecutable) !== config.executable.path || projectInputDigest(mountedExecutable) !== config.executable.sha256) throw projectCheckError("project_check_executable_masked");
  const cwd = config.cwd === "." ? root : join(root, config.cwd);
  if (realpathSync(cwd) !== cwd || !lstatSync(cwd).isDirectory()) throw projectCheckError("project_check_input_drift");
  for (const file of config.pinned_files) {
    const path = join(root, file.path);
    if (realpathSync(path) !== path || projectInputDigest(path) !== file.sha256) throw projectCheckError("project_check_input_drift");
    const committed = execFileSync("/usr/bin/git", ["-C", root, "show", `HEAD:${file.path}`], { env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    if (!committed.equals(readFileSync(path))) throw projectCheckError("project_check_input_drift");
  }
  for (const mount of config.read_mounts) {
    assertProjectReadPath(mount.source, { authorityDirectory });
    if (mount.source === root || root.startsWith(mount.source + "/") || projectInputDigest(mount.source) !== mount.sha256) throw projectCheckError("project_check_input_drift");
    if (mount.target.startsWith("/workspace/")) {
      const local = mount.target.slice("/workspace/".length);
      if (!projectPath(local) || mount.source !== join(root, local) || !lstatSync(mount.source).isDirectory()) throw projectCheckError("project_check_dependency_invalid");
      const tracked = execFileSync("/usr/bin/git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD", "--", local], {
        env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
      if (tracked.length || config.pinned_files.some(file => file.path === local || file.path.startsWith(local + "/"))) throw projectCheckError("project_check_dependency_masks_candidate");
    } else if (mount.source.startsWith(root + "/")) throw projectCheckError("project_check_dependency_invalid");
  }
  const binding = { schema: "flow.project-check-binding/v2", scope: PROJECT_CHECK_SCOPE, registration: config, runner: runnerIdentity };
  return freezeCanonical({ ...binding, fingerprint: digest(binding) });
}

/** Materialize committed bytes only; ignored files and ambient project auth never enter the checker. */
export function createProjectCheckWorkspaceSnapshot(workspacePath, destination) {
  const env = { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (args, options = {}) => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", workspacePath, ...args], {
    env, timeout: 10000, maxBuffer: 64 * 1024 * 1024, ...options,
  });
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const tree = git(["rev-parse", "HEAD^{tree}"]).toString().trim();
  const rows = new TextDecoder("utf-8", { fatal: true }).decode(git(["ls-tree", "-rz", "HEAD"])).split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t"), [mode, type, blob] = line.slice(0, tab).split(" "), path = line.slice(tab + 1);
    if (!["100644", "100755", "120000"].includes(mode) || type !== "blob" || !/^[a-f0-9]{40,64}$/u.test(blob) ||
        !path || path.startsWith("/") || path.split("/").some(part => [".", "..", ".git"].includes(part))) throw projectCheckError("project_check_snapshot_unsupported");
    return { mode, blob, path };
  });
  if (rows.length > 100000) throw projectCheckError("project_check_input_limit");
  const output = git(["cat-file", "--batch"], { input: rows.map(row => row.blob + "\n").join("") });
  const contents = []; let offset = 0, total = 0;
  for (const row of rows) {
    const newline = output.indexOf(10, offset), header = output.subarray(offset, newline).toString();
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== row.blob) throw projectCheckError("project_check_snapshot_invalid");
    const size = Number(match[2]); total += size;
    if (total > 64 * 1024 * 1024 || output.length < newline + size + 2) throw projectCheckError("project_check_input_limit");
    const bytes = output.subarray(newline + 1, newline + 1 + size); offset = newline + size + 2;
    contents.push({ ...row, bytes });
  }
  mkdirSync(destination, { mode: 0o700 });
  // Write regular files first. A tracked symlink cannot redirect an extraction.
  for (const row of contents) {
    if (row.mode === "120000") continue;
    const path = join(destination, row.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, row.bytes, { flag: "wx", mode: row.mode === "100755" ? 0o755 : 0o644 });
  }
  for (const row of contents) {
    if (row.mode !== "120000") continue;
    const path = join(destination, row.path), target = row.bytes.toString();
    const selected = resolve(dirname(path), target);
    if (isAbsolute(target) || selected !== destination && !selected.startsWith(destination + "/")) throw projectCheckError("project_check_symlink_escape");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); symlinkSync(target, path);
  }
  if (git(["rev-parse", "HEAD"]).toString().trim() !== commit) throw projectCheckError("project_check_candidate_changed");
  return Object.freeze({ path: destination, commit_sha: commit, tree_sha: tree, sha256: projectInputDigest(destination) });
}
