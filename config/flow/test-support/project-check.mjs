import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectInputDigest, resolveProjectCheck } from "../src/production-project-check.mjs";
import { projectCheckRunnerIdentity } from "../src/production-project-check-runner.mjs";

const installed = name => {
  try {
    let selected = realpathSync(execFileSync('/usr/bin/which', [name], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim());
    if (selected.endsWith('/mise')) {
      const data = realpathSync(process.execPath).split('/installs/')[0];
      selected = realpathSync(join(data, "installs", name === "python3" ? "python" : name, "latest", "bin", name));
    }
    return selected;
  }
  catch { return null; }
};
export const projectToolPaths = Object.freeze({
  node: realpathSync(process.execPath),
  npm: join(dirname(dirname(realpathSync(process.execPath))), 'lib/node_modules/npm'),
  python: installed('python3'),
  go: installed('go') ? dirname(dirname(installed('go'))) : null,
});
export const projectFileHash = file => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
export function explicitRuntimeMounts(executables, directories = []) {
  const targets = new Map();
  function mount(source, target) {
    source = realpathSync(source);
    if (!targets.has(target)) targets.set(target, { source, target, sha256: projectInputDigest(source) });
  }
  for (const directory of directories) mount(directory, directory);
  for (const executable of executables) {
    mount(executable, executable);
    let dependencies;
    try { dependencies = execFileSync("/usr/bin/ldd", [executable], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { if (/not a dynamic executable|statically linked/u.test(String(error.stdout) + String(error.stderr))) dependencies = ""; else throw error; }
    for (const line of dependencies.split("\n")) {
      const path = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/u)?.[1];
      if (path) mount(path, path);
    }
  }
  return [...targets.values()];
}
export function projectProfile({ root, tool = "node", argv, versionArgv, version, timeout = 30000, output = 65536, files = ["suite.mjs"], extraMounts = [] }) {
  let executable, mounts, environment;
  if (tool === "npm") {
    executable = projectToolPaths.node;
    mounts = explicitRuntimeMounts([executable, "/bin/sh"], ["bin", "lib", "node_modules", "package.json"].map(path => join(projectToolPaths.npm, path)));
    argv ??= [join(projectToolPaths.npm, "bin/npm-cli.js"), "test"];
    versionArgv ??= [join(projectToolPaths.npm, "bin/npm-cli.js"), "--version"];
    version ??= JSON.parse(readFileSync(join(projectToolPaths.npm, "package.json"), "utf8")).version;
    environment = { PATH: `${dirname(executable)}:/usr/bin:/bin` };
  } else if (tool === "python") {
    executable = projectToolPaths.python;
    const stdlib = execFileSync(executable, ["-I", "-S", "-c", "import sysconfig;print(sysconfig.get_path(\"stdlib\"))"], { encoding: "utf8" }).trim();
    mounts = explicitRuntimeMounts([executable], [stdlib]);
    argv ??= ["-S", "-m", "unittest", "discover", "-v"];
    versionArgv ??= ["--version"];
    version ??= execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
    environment = { PATH: "/usr/bin:/bin" };
  } else if (tool === "go") {
    executable = join(projectToolPaths.go, "bin/go");
    mounts = explicitRuntimeMounts([executable], [join(projectToolPaths.go, "pkg"), join(projectToolPaths.go, "src"), join(projectToolPaths.go, "lib")]);
    argv ??= ["test", "./..."];
    versionArgv ??= ["version"];
    version ??= execFileSync(executable, ["version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GOTOOLCHAIN: "local" } }).trim();
    environment = { PATH: "/usr/bin:/bin", GOROOT: projectToolPaths.go, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", CGO_ENABLED: "0" };
  } else {
    executable = projectToolPaths.node;
    mounts = explicitRuntimeMounts([executable]);
    argv ??= ["--test", "suite.mjs"];
    versionArgv ??= ["--version"];
    version ??= process.version;
    environment = { PATH: "/usr/bin:/bin" };
  }
  // Directory mounts subsume files already present under that exact namespace path.
  const byTarget = new Map();
  for (const mount of [...mounts, ...extraMounts]) {
    const previous = byTarget.get(mount.target);
    if (previous && JSON.stringify(previous) !== JSON.stringify(mount)) throw new Error("conflicting_runtime_mount");
    byTarget.set(mount.target, mount);
  }
  const all = [...byTarget.values()];
  const read_mounts = all.filter((mount, index) => !all.some((other, j) => j !== index && mount.target.startsWith(other.target + "/")));
  return { schema: "flow.production-project-check/v2", check_id: `suite-${tool}`, executable: { path: executable, sha256: projectFileHash(executable) },
    argv, version_argv: versionArgv, version, cwd: ".", pinned_files: files.map(path => ({ path, sha256: projectFileHash(join(root, path)) })),
    criteria: ["the registered project suite passes"], read_mounts, environment, limits: { timeout_ms: timeout, max_output_bytes: output } };
}
export function initializeProject(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  const git = args => execFileSync("/usr/bin/git", ["-C", root, ...args], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
  git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=Flow fixture", "-c", "user.email=flow-fixture@example.invalid", "commit", "-qm", "Initial project suite"]);
  return { path: root };
}
export function bindProject(config, workspace) {
  return resolveProjectCheck({ config, workspace, brief: { acceptance: config.criteria }, runnerIdentity: projectCheckRunnerIdentity() });
}
export function projectIntent(binding) {
  const id = randomUUID();
  return { run_id: `run:${id}`, effect_id: `effect:${id}`, attempt_id: `attempt:${id}`, idempotency_key: `check:${id}`, operation_input: { project_check: binding } };
}
