import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { createProjectInitPlan, parseInitArguments, renderProjectInitPlan } from "../src/project-init.mjs";
import { installedExecutableMounts, projectCheckPreset, projectSignals } from "../src/project-check-presets.mjs";
import { fileURLToPath } from "node:url";

const linux = { skip: process.platform !== "linux" && "Guided registered project checks require the Linux backend" };
function fixture(t, files = { "package.json": JSON.stringify({ scripts: { test: "node --test math.test.mjs" } }), "math.test.mjs": "import 'node:test';\n", "feature.mjs": "export const answer = 42;\n" }) {
  const root = mkdtempSync(join(tmpdir(), "flow-init-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "project"); mkdirSync(repository);
  for (const [path, value] of Object.entries(files)) { mkdirSync(join(repository, path, ".."), { recursive: true }); writeFileSync(join(repository, path), value); }
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", repository, ...args], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: "pipe" });
  git(["init", "--quiet", "--initial-branch=main"]); git(["config", "user.name", "Init fixture"]); git(["config", "user.email", "init@example.invalid"]); git(["add", "."]); git(["commit", "--quiet", "-m", "Existing project"]);
  const executable = join(root, "official-cli"); writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const state = join(root, "state"); mkdirSync(state);
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: state, FLOW_LOCAL_CLIENT_STATE_HOME: state };
  const options = extra => parseInitArguments(["--repository", repository, "--summary", "Keep useful behavior", "--acceptance", "The existing suite passes", "--codex-executable", executable, ...extra]);
  return { root, repository, git, executable, state, env, options };
}

test("init options distinguish explicit confirmation and reject invalid selections", () => {
  const options = parseInitArguments(["--summary", "A feature", "--acceptance", "One", "--acceptance", "Two", "--read-executable", "/usr/bin/git"]);
  assert.deepEqual(options.acceptance, ["One", "Two"]);
  assert.deepEqual(options.extraExecutables, ["/usr/bin/git"]);
  assert.throws(() => parseInitArguments(["--timeout-seconds", "0"]), /1 through 1800/u);
  assert.throws(() => parseInitArguments(["--upgrade-runtime", "true"]), /yes explicitly/u);
  assert.throws(() => parseInitArguments(["--brief", "brief.json", "--summary", "mixed"]), /not both/u);
});

test("static ELF closure preserves interpreter and helper aliases without executing scripts", linux, t => {
  const f = fixture(t);
  const marker = join(f.root, "executed");
  writeFileSync(f.executable, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  assert.throws(() => installedExecutableMounts([f.executable]), /Unsupported script or shim/u);
  assert.equal(existsSync(marker), false);
  const mounts = installedExecutableMounts(["/bin/sh"]);
  assert(mounts.some(mount => mount.target === "/bin/sh"));
  assert(mounts.some(mount => /ld-linux/u.test(mount.target)));
  assert(mounts.every(mount => !["/usr", "/lib", "/bin"].includes(mount.target)));
});

test("npm requires explicit nonstandard tests and existing dependencies without pinning product files", linux, t => {
  const f = fixture(t, { "package.json": JSON.stringify({ scripts: { test: "node --test suite.mjs" } }), "suite.mjs": "import 'node:test';\n", "product.mjs": "export const answer = 42;\n" });
  const select = options => projectCheckPreset({ repository: f.repository, kind: "npm", criteria: ["suite passes"], options, env: f.env });
  assert.throws(() => select({}), /--pin/u);
  const plan = select({ pins: ["suite.mjs"] });
  assert(plan.recipe.pinned_files.includes("suite.mjs"));
  assert(!plan.recipe.pinned_files.includes("product.mjs"));
  writeFileSync(join(f.repository, "package.json"), JSON.stringify({ scripts: { test: "node --test suite.mjs" }, devDependencies: { missing: "1.0.0" } }));
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Declare missing dependency"]);
  assert.throws(() => select({ pins: ["suite.mjs"] }), /node_modules.*lockfile/u);
});

test("selection binds state aliases and refuses project-local output/link locations", linux, t => {
  const f = fixture(t);
  const other = join(f.root, "other-state"); mkdirSync(other);
  const alias = join(f.root, "state-alias"); symlinkSync(f.state, alias);
  const env = { ...f.env, FLOW_LOCAL_CLIENT_STATE_HOME: alias };
  const first = createProjectInitPlan(f.options([]), { env });
  unlinkSync(alias); symlinkSync(other, alias);
  const second = createProjectInitPlan(f.options([]), { env });
  assert.notEqual(digest(first), digest(second));
  assert.equal(first.setup.canonical_state_home, f.state);
  assert.throws(() => createProjectInitPlan(f.options(["--client-link", join(f.repository, "flow-project")]), { env: f.env }), /outside the project/u);
  unlinkSync(alias); symlinkSync(f.repository, alias);
  assert.throws(() => createProjectInitPlan(f.options([]), { env }), /outside the project/u);
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("actual per-repository authority inputs are excluded before ELF parsing", linux, t => {
  const f = fixture(t);
  const authority = join(f.state, "flow-local", digest(f.repository).slice(7, 31), "authority");
  mkdirSync(authority, { recursive: true });
  const helper = join(authority, "helper"); copyFileSync("/usr/bin/true", helper);
  assert.throws(() => createProjectInitPlan(f.options(["--read-executable", helper]), { env: f.env }), /project_check_private_input/u);
  assert.equal(readFileSync(helper).subarray(0, 4).toString("hex"), "7f454c46");
});

test("Git filename discovery stays literal and terminal previews escape repository controls", linux, t => {
  const f = fixture(t);
  const unusual = 'test/newline\ncase.test.mjs'; mkdirSync(join(f.repository, "test")); writeFileSync(join(f.repository, unusual), "test\n");
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Literal filename"]);
  assert(projectSignals(f.repository).files.includes(unusual));
  assert.throws(() => createProjectInitPlan(f.options([]), { env: f.env }), /Pinned files must be contained/u);
  f.git(["rm", "--quiet", unusual]); f.git(["commit", "--quiet", "-m", "Remove unsupported name"]);
  const plan = createProjectInitPlan(f.options([]), { env: f.env });
  plan.notes.push("npm script: echo \u001b[2Joverwrite\rhidden");
  plan.brief.summary = "A feature\u001b[2K";
  const rendered = renderProjectInitPlan(plan);
  assert(!rendered.includes("\u001b") && !rendered.includes("\r"));
  assert.match(rendered, /\\u001b\[2J/u);
  assert.match(rendered, /Private configuration parent:/u);
  assert.match(rendered, /Client link:/u);
});

test("public init refuses Git filters before status can run project code", linux, t => {
  const f = fixture(t);
  writeFileSync(join(f.repository, ".gitattributes"), "filtered.txt filter=marker\n");
  writeFileSync(join(f.repository, "filtered.txt"), "tracked\n");
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Existing filtered input"]);
  const marker = join(f.root, "filter-executed"), filter = join(f.root, "filter");
  writeFileSync(filter, `#!/bin/sh\nprintf hit >> '${marker}'\ncat\n`, { mode: 0o700 });
  f.git(["config", "filter.marker.clean", filter]);
  // Same clean bytes with a different inode force Git's refresh/filter path.
  unlinkSync(join(f.repository, "filtered.txt")); writeFileSync(join(f.repository, "filtered.txt"), "tracked\n");
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "init", "--repository", f.repository, "--summary", "A feature", "--acceptance", "Suite passes", "--codex-executable", f.executable, "--json"], { env: f.env, encoding: "utf8", timeout: 30000 });
  assert.equal(existsSync(marker), false, "Discovery must not invoke the configured clean filter");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Git.*filter|external_filter/u);
  assert.equal(existsSync(join(f.state, "flow-init")), false);
  assert.equal(existsSync(join(f.state, "flow-local")), false);
});

test("missing Git identity is actionable and creates no configuration", linux, t => {
  const f = fixture(t);
  f.git(["config", "--unset", "user.name"]); f.git(["config", "--unset", "user.email"]);
  const home = join(f.root, "empty-home"); mkdirSync(home);
  assert.throws(() => createProjectInitPlan(f.options([]), { env: { ...f.env, HOME: home, XDG_CONFIG_HOME: join(home, "config") } }), /Configure user.name and user.email separately/u);
  assert.equal(existsSync(join(f.state, "flow-init")), false);
  assert.equal(existsSync(join(f.state, "flow-local")), false);
});
