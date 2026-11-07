import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const miseInstalls = dirname(dirname(dirname(dirname(realpathSync(process.execPath)))));
const npmFiles = {
  "package.json": JSON.stringify({ name: "existing-math", private: true, scripts: { test: "node --test math.test.mjs" } }),
  "package-lock.json": JSON.stringify({ name: "existing-math", lockfileVersion: 3, packages: {} }),
  "math.mjs": "export const sum = values => values.reduce((total, value) => total + value, 0);\n",
  "math.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; import {writeFileSync} from "node:fs"; import {sum} from "./math.mjs"; writeFileSync("executed", "unexpected"); test("sum handles empty and signed values", () => { assert.equal(sum([]), 0); assert.equal(sum([2, -3, 7]), 6); });\n',
};

function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), "flow-init-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const part of ["project", "home", "state", "config", "authority", "tmp"]) mkdirSync(join(root, part));
  const repository = join(root, "project");
  const env = { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"), FLOW_AUTHORITY_DIRECTORY: join(root, "authority"),
    TMPDIR: join(root, "tmp"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["NODE_TEST_CONTEXT", "FLOW_LOCAL_CLIENT_STATE_HOME", "DOTFILES_ROOT", "FLOW_RUNTIME_ROOT", "FLOW_OWNER_CONFIGURATION_MODULE"]) delete env[name];
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), bytes);
  }
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Init fixture"]);
  git(["config", "user.email", "init-fixture@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  git(["config", "commit.gpgSign", "false"]);
  git(["add", "."]); git(["commit", "-qm", "Existing project tests"]);
  const codex = join(root, "codex");
  writeFileSync(codex, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/codex-invocations"\n[ "$1" = "--version" ] && { echo "codex-cli 0.166.0"; exit 0; }\nexit 99\n', { mode: 0o700 });
  const args = [cli, "init", "--repository", repository, "--summary", "Improve the existing project",
    "--acceptance", "The existing project suite passes", "--codex-executable", codex];
  const invoke = (selected, options = {}) => spawnSync(process.execPath, selected, { env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024, ...options });
  const run = extra => invoke([...args, ...extra]);
  const success = extra => { const result = run(extra); assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout); };
  return { root, repository, env, git, run, success, invoke, args, codex };
}

test("public init previews an installed npm project without executing scripts or writing configuration", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles);
  const before = f.git(["rev-parse", "HEAD"]);
  const preview = f.success(["--json"]);
  assert.equal(preview.schema, "flow.project-init-plan/v1");
  assert.equal(preview.status, "confirmation_required");
  assert.equal(preview.writes_performed, false);
  assert.equal(preview.plan.repository, f.repository);
  assert.equal(preview.plan.kind, "npm");
  assert.deepEqual(preview.plan.brief.acceptance, ["The existing project suite passes"]);
  assert.equal(preview.plan.project_check.schema, "flow.production-project-check/v2");
  assert.ok(preview.plan.project_check.pinned_files.some(file => file.path === "math.test.mjs"));
  assert.match(preview.confirmation_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(existsSync(join(f.repository, "executed")), false);
  assert.equal(existsSync(join(f.env.HOME, "codex-invocations")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(f.git(["rev-parse", "HEAD"]), before);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public init detects a real Python suite with project imports and nonstandard test naming", { skip: process.platform !== "linux" }, t => {
  const executable = join(miseInstalls, "python/latest/bin/python3");
  if (!existsSync(executable)) return t.skip("Installed Mise Python is unavailable; no interpreter is installed by this test");
  const f = project(t, {
    "pyproject.toml": '[project]\nname = "existing-statistics"\nversion = "0.1.0"\n',
    "statistics_util.py": "def mean(values):\n    return sum(values) / len(values) if values else None\n",
    "tests/statistics_test.py": "import unittest\nfrom statistics_util import mean\nclass StatisticsTest(unittest.TestCase):\n    def test_empty_and_signed_values(self):\n        self.assertIsNone(mean([]))\n        self.assertEqual(mean([2, -3, 7]), 2)\n",
  });
  const selections = ["--tool-executable", executable, "--test-directory", "tests", "--test-pattern", "*_test.py"];
  const preview = f.success([...selections, "--json"]);
  assert.equal(preview.plan.kind, "python");
  assert.equal(preview.plan.project_check.executable.path, realpathSync(executable));
  assert.ok(preview.plan.project_check.argv.includes("*_test.py"));
  assert.ok(preview.plan.project_check.pinned_files.some(file => file.path === "tests/statistics_test.py"));
  const accepted = f.success([...selections, "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(accepted.status, "request_only");
  assert.equal(accepted.owner_started, false);
  assert.equal(accepted.provider_execution, "not_run");
  assert.equal(existsSync(join(f.env.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public init detects an installed offline Go suite and creates only its local setup", { skip: process.platform !== "linux" }, t => {
  const executable = join(miseInstalls, "go/latest/bin/go");
  if (!existsSync(executable)) return t.skip("Installed Mise Go is unavailable; no toolchain is installed by this test");
  const f = project(t, {
    "go.mod": "module example.invalid/statistics\n\ngo 1.26\n",
    "statistics.go": "package statistics\nfunc Sum(values []int) int { result := 0; for _, value := range values { result += value }; return result }\n",
    "statistics_test.go": 'package statistics\nimport "testing"\nfunc TestEmptyAndSignedValues(t *testing.T) { if Sum(nil) != 0 || Sum([]int{2, -3, 7}) != 6 { t.Fatal("unexpected sum") } }\n',
  });
  const preview = f.success(["--tool-executable", executable, "--json"]);
  assert.equal(preview.plan.kind, "go");
  assert.equal(preview.plan.project_check.executable.path, realpathSync(executable));
  assert.deepEqual(preview.plan.project_check.argv, ["test", "./..."]);
  assert.equal(preview.plan.project_check.environment.GOPROXY, "off");
  assert.equal(preview.plan.project_check.environment.GOTOOLCHAIN, "local");
  assert.ok(preview.plan.project_check.pinned_files.some(file => file.path === "statistics_test.go"));
  const accepted = f.success(["--tool-executable", executable, "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(accepted.status, "request_only");
  assert.equal(accepted.owner_started, false);
  assert.equal(accepted.provider_execution, "not_run");
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("explicit public init confirmation creates a reusable client without starting project work", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles);
  const preview = f.success(["--kind", "npm", "--json"]);
  const accepted = f.success(["--kind", "npm", "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(accepted.status, "request_only");
  assert.equal(accepted.owner_started, false);
  assert.equal(accepted.provider_execution, "not_run");
  assert.equal(accepted.next_commands.length, 4);
  assert.match(accepted.next_commands[0], /start/u);
  assert.match(accepted.next_commands[1], /prepare --input-file/u);
  assert.match(accepted.next_commands[2], /inspect-prepared/u);
  assert.match(accepted.next_commands[3], /accept-prepared/u);
  assert.equal(statSync(accepted.registration).mode & 0o777, 0o600);
  assert.equal(statSync(accepted.client).mode & 0o777, 0o700);
  const metadata = JSON.parse(readFileSync(join(accepted.directory, "pilot.json"), "utf8"));
  assert.equal(existsSync(join(metadata.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
  const preserved = [accepted.client, join(accepted.directory, "trusted-owner.mjs"), join(accepted.directory, "pilot.json"), join(accepted.directory, "../../profile.json")]
    .map(path => [path, readFileSync(path)]);
  const repeated = f.success(["--kind", "npm", "--confirm", preview.confirmation_digest, "--json"]);
  assert.equal(repeated.client, accepted.client);
  assert.equal(repeated.profile_reused, true);
  assert.notEqual(repeated.request, accepted.request);
  for (const [path, bytes] of preserved) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(f.repository, "executed")), false);
  assert.match(readFileSync(join(f.env.HOME, "codex-invocations"), "utf8"), /^--version\n(?:--version\n)*$/u);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public init requires an explicit pin for a nonstandard npm acceptance entrypoint", { skip: process.platform !== "linux" }, t => {
  const f = project(t, {
    "package.json": JSON.stringify({ name: "existing-math", private: true, scripts: { test: "node --test suite.mjs" } }),
    "suite.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; test("signed sum", () => assert.equal(2 - 3 + 7, 6));\n',
  });
  const refused = f.run(["--json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--pin/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  const preview = f.success(["--pin", "suite.mjs", "--json"]);
  assert.ok(preview.plan.project_check.pinned_files.some(file => file.path === "suite.mjs"));
  assert.equal(preview.writes_performed, false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public init rejects Python discovery that selects no committed tests", { skip: process.platform !== "linux" }, t => {
  const executable = join(miseInstalls, "python/latest/bin/python3");
  if (!existsSync(executable)) return t.skip("Installed Mise Python is unavailable");
  const f = project(t, { "tests/statistics_test.py": "import unittest\nclass StatisticsTest(unittest.TestCase):\n    def test_sum(self): self.assertEqual(2 - 3 + 7, 6)\n" });
  const refused = f.run(["--tool-executable", executable, "--test-directory", "tests", "--test-pattern", "missing*.py", "--json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no committed tests/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
});

test("public init explains missing non-TTY input without creating a profile", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles);
  const refused = f.invoke([cli, "init", "--repository", f.repository, "--codex-executable", f.codex, "--json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--summary.*--acceptance/u);
  assert.equal(refused.stdout, "");
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(existsSync(join(f.env.HOME, "codex-invocations")), false);
});

test("public init exposes ambiguous project signals and accepts an explicit preset choice", { skip: process.platform !== "linux" }, t => {
  const f = project(t, { ...npmFiles, "go.mod": "module example.invalid/statistics\n\ngo 1.26\n", "statistics_test.go": "package statistics\n" });
  const refused = f.run(["--json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Ambiguous.*npm.*go/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(f.success(["--kind", "npm", "--json"]).plan.kind, "npm");
});

test("public init reports missing npm dependencies without installing or silently changing verification", { skip: process.platform !== "linux" }, t => {
  const pkg = JSON.parse(npmFiles["package.json"]);
  pkg.devDependencies = { "missing-fixture-dependency": "1.0.0" };
  const f = project(t, { ...npmFiles, "package.json": JSON.stringify(pkg) });
  const refused = f.run(["--json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /existing node_modules/u);
  assert.match(refused.stderr, /never installs/u);
  assert.equal(existsSync(join(f.repository, "node_modules")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public init preserves relative repository and client-link choices from the caller directory", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles), caller = join(f.root, "caller");
  mkdirSync(caller);
  const args = f.args.with(f.args.indexOf(f.repository), "../project");
  const selections = [...args, "--client-link", "./flow-project"];
  const previewResult = f.invoke([...selections, "--json"], { cwd: caller });
  assert.equal(previewResult.status, 0, previewResult.stdout + previewResult.stderr);
  const preview = JSON.parse(previewResult.stdout);
  assert.equal(preview.plan.repository, f.repository);
  assert.equal(preview.plan.setup.client_link, join(caller, "flow-project"));
  const acceptedResult = f.invoke([...selections, "--confirm", preview.confirmation_digest, "--json"], { cwd: caller });
  assert.equal(acceptedResult.status, 0, acceptedResult.stdout + acceptedResult.stderr);
  const accepted = JSON.parse(acceptedResult.stdout);
  assert.equal(realpathSync(join(caller, "flow-project")), accepted.client);
  assert.equal(existsSync(join(f.repository, "flow-project")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

function terminalInit(f, response, { args = f.args, questions = [] } = {}) {
  const driver = `import errno,json,os,pty,select,signal,subprocess,sys,time
master,slave=pty.openpty()
child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
output=bytearray(); answered=0; cursor=0; deadline=time.monotonic()+20; timed_out=False
questions=json.loads(sys.argv[3]); questions.append(['Create this supervised setup? [y/N]','n\\n' if sys.argv[2]=='decline' else '\\x04'])
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try: chunk=os.read(master,65536)
   except OSError as error:
    if error.errno==errno.EIO: break
    raise
   if not chunk: break
   output.extend(chunk)
   if len(output)>1048576: raise RuntimeError('terminal_output_limit')
   if answered<len(questions):
    prompt,answer=questions[answered]; position=output.find(prompt.encode(),cursor)
    if position>=0:
     os.write(master,answer.encode()); cursor=position+len(prompt.encode()); answered+=1
 else: timed_out=True
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL)
 child.wait(); os.close(master)
print(json.dumps({'status':child.returncode,'output':output.decode('utf8','replace'),'responded':answered==len(questions),'timed_out':timed_out}))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, ...args]), response, JSON.stringify(questions)], {
    env: { ...f.env, TERM: "dumb" }, encoding: "utf8", timeout: 25000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.timed_out, false, terminal.output);
  assert.equal(terminal.responded, true, terminal.output);
  return terminal;
}

test("rendered TTY preview can be declined without creating configuration", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles), terminal = terminalInit(f, "decline");
  assert.equal(terminal.status, 0, terminal.output);
  assert.match(terminal.output, /Flow project setup - preview/u);
  assert.match(terminal.output, /Preset: npm \(GREEN-only verify\)/u);
  assert.match(terminal.output, /not independently enforced/u);
  assert.match(terminal.output, /Nothing created\./u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("TTY EOF at confirmation leaves the project and state unchanged", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles), terminal = terminalInit(f, "eof");
  assert.equal(terminal.status, 1, terminal.output);
  assert.match(terminal.output, /Aborted with Ctrl\+D|Input ended.*Nothing created/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("guided TTY init collects a summary and ordered acceptance without a JSON brief", { skip: process.platform !== "linux" }, t => {
  const f = project(t, npmFiles);
  const terminal = terminalInit(f, "decline", {
    args: [cli, "init", "--repository", f.repository, "--codex-executable", f.codex],
    questions: [
      ["What feature should Flow work on? ", "Handle missing measurements\n"],
      ["  Criterion: ", "Preserve signed values\n"],
      ["  Criterion: ", "Handle empty collections\n"],
      ["  Criterion: ", "\n"],
    ],
  });
  assert.equal(terminal.status, 0, terminal.output);
  assert.match(terminal.output, /Feature: Handle missing measurements/u);
  assert.match(terminal.output, /Acceptance: Preserve signed values\r?\n\s+Acceptance: Handle empty collections/u);
  assert.match(terminal.output, /Nothing created\./u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-init")), false);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});
