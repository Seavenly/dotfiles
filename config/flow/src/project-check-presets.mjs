import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertProjectReadPath, projectPath } from "./production-project-check.mjs";

const fail = message => { throw new Error(message); };
const text = path => readFileSync(path, "utf8");
const canonical = path => realpathSync(path);
const gitEnvironment = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
export function projectGit(repository, args) {
  return execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", repository, ...args], {
    env: gitEnvironment, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Inspect PATH entries and known installed Mise links without executing shims. */
export function findInstalledExecutable(name, { env = process.env, selected } = {}) {
  if (selected) {
    if (!isAbsolute(selected)) fail(`Select an absolute ${name} executable path`);
    accessSync(selected, constants.X_OK);
    return canonical(selected);
  }
  for (const directory of (env.PATH ?? "").split(":").filter(isAbsolute)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const found = canonical(candidate);
      if (basename(found) !== "mise") return found;
      const data = env.MISE_DATA_DIR ?? canonical(process.execPath).split("/installs/")[0];
      const installed = join(data, "installs", name === "python3" ? "python" : name, "latest", "bin", name);
      accessSync(installed, constants.X_OK);
      return canonical(installed);
    } catch { /* Another explicit installed PATH entry may be usable. */ }
  }
  fail(`No installed ${name} executable found. Select its absolute path or install it separately; init installs nothing.`);
}

/** Read ELF declarations with a trusted parser; never invoke the selected binary. */
export function installedExecutableMounts(executables, directories = []) {
  const mounts = new Map();
  const add = (source, target = source) => {
    source = canonical(source); assertProjectReadPath(source);
    const previous = mounts.get(target);
    if (previous && previous.source !== source) fail(`Conflicting installed input at ${target}`);
    mounts.set(target, { source, target });
  };
  for (const directory of directories) add(directory);
  const seen = new Set();
  const inspect = (selected, target = selected) => {
    const executable = canonical(selected); add(executable, target);
    if (seen.has(executable)) return;
    seen.add(executable);
    if (!readFileSync(executable).subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) fail(`Unsupported script or shim ${selected}. Select its installed native executable; use manual registration for other layouts.`);
    let declarations;
    try { declarations = execFileSync("/usr/bin/readelf", ["--wide", "--program-headers", "--dynamic", executable], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }); } catch { fail("Static ELF discovery requires installed /usr/bin/readelf. Install it separately or use manual registration."); }
    const interpreter = declarations.match(/Requesting program interpreter:\s*([^\]]+)\]/u)?.[1];
    if (interpreter) inspect(interpreter, interpreter);
    const paths = [...declarations.matchAll(/\((?:RUNPATH|RPATH)\).*?\[([^\]]+)\]/gu)].flatMap(match => match[1].split(":"));
    const search = paths.map(path => path.replace(/\$\{ORIGIN\}|\$ORIGIN/gu, dirname(executable)));
    if (search.some(path => !isAbsolute(path) || path.includes("$"))) fail(`Unsupported relative loader path in ${executable}; use manual registration`);
    search.push(join(dirname(dirname(executable)), "lib"), "/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib");
    for (const match of declarations.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/gu)) {
      if (match[1].includes("/")) fail(`Unsupported loader dependency ${match[1]}`);
      const library = search.map(path => resolve(path, match[1])).find(existsSync);
      if (!library) fail(`Missing installed library ${match[1]} for ${executable}; init installs nothing`);
      inspect(library, library);
    }
  };
  for (const executable of executables) inspect(executable, executable);
  return [...mounts.values()].filter(mount => ![...mounts.values()].some(other => other !== mount && mount.target.startsWith(other.target + "/")));
}

export function projectSignals(repository) {
  const files = projectGit(repository, ["ls-tree", "-rz", "--name-only", "HEAD"]).split("\0").filter(Boolean);
  const kinds = [];
  if (files.includes("package.json")) kinds.push("npm");
  if (files.some(file => ["pyproject.toml", "setup.cfg", "pytest.ini", "requirements.txt"].includes(file) || /(?:^|\/)(?:test[^/]*|[^/]*_test)\.py$/u.test(file))) kinds.push("python");
  if (files.includes("go.mod")) kinds.push("go");
  return { files, kinds };
}

export function projectCheckPreset({ repository, kind, criteria, options = {}, env = process.env }) {
  if (process.platform !== "linux") fail("Guided project checks currently require the Linux backend; Mac native execution remains unsupported");
  const { files, kinds } = projectSignals(repository);
  if (!kind) {
    if (kinds.length !== 1) fail(kinds.length ? `Ambiguous project types: ${kinds.join(", ")}. Select --kind npm, python or go.` : "No supported committed project/test signals. Select --kind or use manual registration.");
    [kind] = kinds;
  }
  if (!["npm", "python", "go"].includes(kind)) fail("Select --kind npm, python or go");
  if (options.testDirectory !== undefined && options.testDirectory !== "." && !projectPath(options.testDirectory)) fail("--test-directory must be a contained project-relative directory");
  for (const path of options.pins ?? []) if (!files.includes(path) || !projectPath(path)) fail(`Select a committed contained test/config file for --pin: ${path}`);
  let executable, argv, versionArgv, version, pinned, mounts, environment;
  const notes = ["GREEN-only command completion; no intended RED or test-count guarantee", "Read-only committed candidate; private bounded scratch; no network or installs"];
  if (kind === "npm") {
    if (options.toolExecutable && canonical(options.toolExecutable) !== canonical(process.execPath)) fail("The npm preset uses init's exact Node 22 executable; select another runtime through manual registration");
    if (!files.includes("package.json")) fail("npm requires a committed package.json with an existing test script");
    const pkg = JSON.parse(projectGit(repository, ["show", "HEAD:package.json"]));
    if (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim()) fail("No committed npm test script. Add the project test command first; init will not invent one.");
    executable = canonical(process.execPath);
    const npm = join(dirname(dirname(executable)), "lib/node_modules/npm");
    if (!existsSync(join(npm, "bin/npm-cli.js"))) fail("No npm payload beside the selected Node. Install it separately or use manual registration.");
    const packageMetadata = JSON.parse(text(join(npm, "package.json")));
    version = packageMetadata.version;
    argv = [join(npm, "bin/npm-cli.js"), "test"];
    versionArgv = [join(npm, "bin/npm-cli.js"), "--version"];
    pinned = files.filter(path => ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(path) || /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path));
    const explicitPins = options.pins ?? [];
    const namedFiles = files.filter(file => !pinned.includes(file) && pkg.scripts.test.split(/[\s"';&|]+/u).some(token => token.replace(/^\.\//u, "") === file));
    if (namedFiles.some(file => !explicitPins.includes(file))) fail(`The npm script names nonstandard test input(s): ${namedFiles.join(", ")}. Select those existing tests explicitly with repeatable --pin FILE; product files must remain editable.`);
    if (!pinned.some(file => !["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(file)) && !explicitPins.length) fail("No conventional committed npm test files found. Select existing acceptance tests with repeatable --pin FILE; init never invents tests.");
    mounts = installedExecutableMounts([executable, "/bin/sh"], ["bin", "lib", "node_modules", "package.json"].map(path => join(npm, path)));
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length) {
      const dependencies = join(repository, "node_modules");
      if (!existsSync(dependencies) || !files.some(path => ["package-lock.json", "npm-shrinkwrap.json"].includes(path))) fail("npm dependencies require an existing node_modules tree and committed npm lockfile. Install separately, then retry; init never installs.");
      mounts.push({ source: canonical(dependencies), target: "/workspace/node_modules" });
    }
    environment = { PATH: `${dirname(executable)}:/usr/bin:/bin` };
    notes.push(`Committed npm script: ${pkg.scripts.test}`, "Only Node/npm, sh and explicitly selected extra executables are available; scripts writing project outputs must use scratch paths");
  } else if (kind === "python") {
    const requested = options.toolExecutable ?? (existsSync(join(repository, ".venv/bin/python")) ? join(repository, ".venv/bin/python") : undefined);
    executable = findInstalledExecutable("python3", { env, selected: requested });
    const prefix = dirname(dirname(executable));
    const includes = existsSync(join(prefix, "include")) ? readdirSync(join(prefix, "include")).filter(path => /^python3\.\d+[a-z]*$/u.test(path)) : [];
    if (includes.length !== 1) fail("Python preset needs an installed prefix with one include/python3.x/patchlevel.h. Select --tool-executable or use manual registration for this layout.");
    const majorMinor = includes[0].replace(/^python/u, "").replace(/[a-z]+$/u, "");
    const header = text(join(prefix, "include", includes[0], "patchlevel.h"));
    const pythonVersion = header.match(/^#define PY_VERSION\s+"([^"]+)"/mu)?.[1];
    if (!pythonVersion) fail("Python version metadata is missing; use manual registration");
    version = `Python ${pythonVersion}`; versionArgv = ["--version"];
    const stdlib = join(prefix, "lib", `python${majorMinor}`);
    if (!existsSync(stdlib)) fail("Selected Python has no closed standard-library directory; use manual registration");
    const tests = files.filter(file => /(?:^|\/)(?:test[^/]*|[^/]*_test)\.py$/u.test(file));
    if (!tests.length) fail("No committed Python test*.py or *_test.py files found; add existing tests first");
    const signals = files.filter(file => ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"].includes(file));
    const pytest = signals.some(file => /pytest/u.test(projectGit(repository, ["show", `HEAD:${file}`]))) || tests.some(file => /^\s*(?:import pytest|from pytest\b)/mu.test(projectGit(repository, ["show", `HEAD:${file}`])));
    const runner = options.pythonRunner ?? (pytest ? "pytest" : "unittest");
    if (!["pytest", "unittest"].includes(runner)) fail("Select --python-runner unittest or pytest");
    mounts = installedExecutableMounts([executable], [stdlib]);
    if (runner === "pytest") {
      const venv = requested && existsSync(join(dirname(dirname(requested)), "pyvenv.cfg")) ? dirname(dirname(requested)) : null;
      const site = venv ? join(venv, "lib", `python${majorMinor}`, "site-packages") : join(stdlib, "site-packages");
      if (!existsSync(join(site, "pytest/__init__.py"))) fail("The selected Python has no installed pytest. Select a compatible --tool-executable or install dependencies separately; init never installs or falls back to unittest.");
      let siteTarget = canonical(site);
      if (siteTarget.startsWith(repository + "/")) {
        siteTarget = "/workspace/" + relative(repository, siteTarget);
        mounts.push({ source: canonical(site), target: siteTarget });
      } else if (!siteTarget.startsWith(canonical(stdlib) + "/")) mounts.push({ source: canonical(site), target: siteTarget });
      const directory = options.testDirectory ?? (tests.every(file => file.startsWith("tests/")) ? "tests" : ".");
      if (!tests.some(file => directory === "." || file.startsWith(directory + "/"))) fail("The Python directory selects no committed tests");
      argv = ["-I", "-S", "-c", "import os,sys;sys.path.insert(0,sys.argv.pop(1));import pytest;sys.path.insert(0,os.getcwd());raise SystemExit(pytest.main(sys.argv[1:]))", siteTarget, directory];
      if (options.testPattern) fail("--test-pattern is for unittest discovery; pytest uses its committed configuration");
    } else {
      const patterns = ["test*.py", "*_test.py"].filter(pattern => tests.some(file => pattern === "test*.py" ? basename(file).startsWith("test") : basename(file).endsWith("_test.py")));
      if (!options.testPattern && patterns.length > 1) fail("Python test naming is ambiguous. Select --test-pattern 'test*.py' or --test-pattern '*_test.py'.");
      const pattern = options.testPattern ?? patterns[0];
      if (!pattern || !/^[a-zA-Z0-9_.*?-]+$/u.test(pattern) || pattern.startsWith("-")) fail("Use a simple filename glob for --test-pattern");
      const directory = options.testDirectory ?? (tests.every(file => file.startsWith("tests/")) ? "tests" : ".");
      const match = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".") + "$", "u");
      if (!tests.some(file => (directory === "." || file.startsWith(directory + "/")) && match.test(basename(file)))) fail("The Python directory/pattern selects no committed tests. Choose --test-directory and --test-pattern explicitly.");
      argv = ["-I", "-S", "-c", "import os,sys,unittest;sys.path.insert(0,os.getcwd());unittest.main(module=None)", "discover", "-s", directory, "-p", pattern, "-v"];
    }
    pinned = [...tests, ...signals];
    environment = { PATH: "/usr/bin:/bin" };
    notes.push(`Python runner: ${runner}; no host interpreter or test collection ran during discovery`);
  } else {
    if (!files.includes("go.mod")) fail("Go requires a committed go.mod and existing tests");
    const tests = files.filter(file => file.endsWith("_test.go"));
    if (!tests.length) fail("No committed Go *_test.go files found");
    executable = findInstalledExecutable("go", { env, selected: options.toolExecutable });
    const prefix = dirname(dirname(executable));
    const release = existsSync(join(prefix, "VERSION")) && text(join(prefix, "VERSION")).split("\n")[0];
    if (!/^go\d+\.\d+(?:\.\d+)?$/u.test(release)) fail("Go preset needs installed GOROOT VERSION metadata; select --tool-executable or use manual registration");
    version = `go version ${release} linux/${process.arch === "x64" ? "amd64" : process.arch}`;
    argv = ["test", "./..."]; versionArgv = ["version"];
    pinned = files.filter(file => ["go.mod", "go.sum", "vendor/modules.txt"].includes(file) || file.endsWith("_test.go"));
    if (/^\s*require\b/mu.test(projectGit(repository, ["show", "HEAD:go.mod"])) && !files.includes("vendor/modules.txt")) fail("Go dependencies require an existing committed vendor tree for this offline preset. Vendor separately or use manual registration; init never downloads modules.");
    mounts = installedExecutableMounts([executable], ["pkg", "src", "lib"].map(path => join(prefix, path)));
    environment = { PATH: "/usr/bin:/bin", GOROOT: prefix, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", CGO_ENABLED: "0" };
    notes.push("Go uses only its local toolchain, committed/vendor inputs and private caches; cgo and module downloads are disabled");
  }
  if (options.extraExecutables?.length) mounts.push(...installedExecutableMounts(options.extraExecutables));
  const byTarget = new Map();
  for (const mount of mounts) {
    const previous = byTarget.get(mount.target);
    if (previous && previous.source !== mount.source) fail(`Conflicting input ${mount.target}`);
    byTarget.set(mount.target, mount);
  }
  mounts = [...byTarget.values()].filter(mount => ![...byTarget.values()].some(other => other !== mount && mount.target.startsWith(other.target + "/")));
  return { kind, notes, recipe: { schema: "flow.project-check-recipe/v2", check_id: `init-${kind}`, executable, argv, version_argv: versionArgv, version, cwd: ".", pinned_files: [...new Set([...pinned, ...(options.pins ?? [])])].sort(), criteria,
    read_mounts: mounts.sort((a, b) => a.target.localeCompare(b.target)), environment,
    limits: { timeout_ms: options.timeoutMs ?? 300000, max_output_bytes: 1024 * 1024 } } };
}
