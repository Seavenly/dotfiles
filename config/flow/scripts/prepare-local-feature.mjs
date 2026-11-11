import { provisionLocalClient } from "../src/local-client-provisioning.mjs";
import { validateProjectCheck, resolveProjectCheck } from "../src/production-project-check.mjs";
import { projectCheckRunnerIdentity } from "../src/production-project-check-runner.mjs";
import { PROJECT_CHECK_SCOPE } from "../../../tools/flow/src/project-check.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { executableIdentity } from "../../../tools/flow/src/direct-delegated-agent-port.mjs";
import { codexExecutionAdapter } from "../../../tools/flow/src/codex-execution-adapter.mjs";
import { createGitWorkspaceObservationAdapter } from "../../../tools/flow/src/git-retention-adapter.mjs";
import { resolveProductionFeatureTestSelection, validateProductionFeatureTestCheck } from "../src/production-feature-test-check.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT } from "../src/supervised-native-trust.mjs";
import { quoteShell, writeFeatureClient } from "./feature-client-files.mjs";
import { assertLocalCheckChangeQuiescent } from "../src/local-client-state.mjs";
import { statusFlowOwner } from "../src/owner-process.mjs";
import { resolveProductionGitIdentity } from "../src/production-direct-commit.mjs";

const runtimeRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const load = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const verifyScope = "Git-backed content observations plus independent model critique; project checks NOT_RUN; runtime behavior not established";

try {
  await setup(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function setup(args) {
  if (!/^v22\./u.test(process.version)) throw new Error("Local setup requires Node 22");
  const options = {};
  const allowed = ["--repository", "--brief", "--codex-executable", "--execution-trust", "--mode", "--check", "--client-link", "--reconfigure-check", "--upgrade-runtime"];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.includes(flag) || !value || Object.hasOwn(options, flag)) throw new Error("Invalid local setup arguments");
    options[flag] = value;
  }
  if (options["--execution-trust"] !== "supervised-native-cli") throw new Error("Select --execution-trust supervised-native-cli explicitly");
  if (!options["--repository"] || !options["--brief"] || !options["--codex-executable"]) {
    throw new Error("Local setup requires --repository PATH --brief JSON_FILE --codex-executable ABSOLUTE_PATH");
  }
  const mode = options["--mode"] ?? "verify";
  if (options["--reconfigure-check"] !== undefined && options["--reconfigure-check"] !== "yes") throw new Error("Use --reconfigure-check yes to explicitly select a different check");
  if (options["--upgrade-runtime"] !== undefined && options["--upgrade-runtime"] !== "yes") throw new Error("Use --upgrade-runtime yes to explicitly select a different runtime");
  if (!["test", "verify"].includes(mode) || mode === "test" && !options["--check"]) {
    throw new Error("Use verify with an optional v2 project --check, or test with one explicit v1 trusted --check JSON_FILE");
  }
  const repository = realpathSync(options["--repository"]);
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", repository, ...args], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  let ref;
  try { ref = git(["symbolic-ref", "--quiet", "HEAD"]).trim(); }
  catch { ref = "HEAD"; }
  const observation = createGitWorkspaceObservationAdapter().observe({ workspace_path: repository, ref });
  if (git(["rev-parse", "--show-toplevel"]).trim() !== repository || observation.git?.clean !== true) {
    throw new Error("Choose the root of an existing clean Git repository");
  }
  const brief = load(options["--brief"]);
  if (!brief || Object.keys(brief).sort().join(",") !== "acceptance,id,schema,summary" ||
      brief.schema !== "flow.feature-brief/v1" || !brief.id || !brief.summary ||
      !Array.isArray(brief.acceptance) || !brief.acceptance.length ||
      [brief.id, brief.summary, ...brief.acceptance].some(value => typeof value !== "string" || !value)) {
    throw new Error("Brief must be flow.feature-brief/v1 with id, summary and non-empty acceptance criteria");
  }
  const executable = executableIdentity(options["--codex-executable"], codexExecutionAdapter, process.env, "supervised-native-cli");
  let gitIdentity;
  try { gitIdentity = resolveProductionGitIdentity(repository); }
  catch (error) {
    if (error.message !== "candidate_commit_author_identity_unproven") throw error;
    throw new Error("Git author and committer identity are required; configure user.name and user.email in the repository or selected Git configuration, then repeat local setup");
  }
  const rawCheck = options["--check"] ? load(options["--check"]) : undefined;
  const projectCheck = rawCheck?.schema === "flow.production-project-check/v2";
  const check = rawCheck === undefined ? undefined : projectCheck ? validateProjectCheck(rawCheck) : validateProductionFeatureTestCheck(rawCheck);
  if (check && projectCheck !== (mode === "verify")) throw new Error("Use v2 GREEN-only project checks with verify; v1 health/expected-RED/GREEN checks require test");
  if (projectCheck) resolveProjectCheck({ config: check, brief, workspace: { path: repository }, runnerIdentity: projectCheckRunnerIdentity() });
  else if (check) resolveProductionFeatureTestSelection({ checkId: check.check_id, brief, workspace: { path: repository }, featureTestCheck: check });
  const { stateHome, profileRoot, authorityDirectory, directory, profile, reused, runtimeChanged } = await provisionLocalClient({ repository, executable, gitIdentity, check, runtimeRoot, node: realpathSync(process.execPath), env: process.env,
    upgradeRuntime: options["--upgrade-runtime"], reconfigureCheck: options["--reconfigure-check"] });
  const requestDirectory = mkdtempSync(join(directory, "requests/feature-"));
  const request = { schema: "flow.feature-preparation-request/v1", brief, repository, mode,
    ...(check ? { [projectCheck ? "check" : "test"]: { check_id: check.check_id } } : {}),
    routes: { apply: { harness: "codex", capability: "workspace-write-denied" }, critique: { harness: "codex", capability: "read-only" } },
    limits: { max_elapsed_seconds: projectCheck ? Math.max(600, Math.ceil(check.limits.timeout_ms / 1000) + 600) : 600, max_revisions: 0 }, execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT };
  const requestPath = join(requestDirectory, "prepare-request.json");
  const preparedPath = join(requestDirectory, "prepared.json");
  save(requestPath, request);
  const client = join(directory, "flow");
  if (options["--client-link"]) {
    const link = resolve(options["--client-link"]);
    if (existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) {
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== client) throw new Error("Client link already exists and will not be replaced");
    } else symlinkSync(client, link);
  }
  process.stdout.write(`${JSON.stringify({ status: "request_only", directory, client,
    request: requestPath, mode, commit_identity: gitIdentity, verification_scope: projectCheck ? PROJECT_CHECK_SCOPE : check
      ? "Registered pinned Node health and acceptance checks, including expected RED then GREEN; arbitrary project suites are not registered"
      : verifyScope, owner_started: false, provider_execution: "not_run", profile_reused: reused,
    runtime_upgrade: runtimeChanged,
    next_commands: [
      `${quoteShell(client)} start --json`,
      `${quoteShell(client)} prepare --input-file ${quoteShell(requestPath)} --json > ${quoteShell(preparedPath)}`,
      `${quoteShell(client)} local inspect-prepared ${quoteShell(preparedPath)}`,
      `${quoteShell(client)} local accept-prepared ${quoteShell(directory)} ${quoteShell(preparedPath)}`,
    ],
    instruction: "Inspect the confirmation before accept-prepared. That command writes a launch request and prints its explicit launch command; it starts no provider.",
    ...(options["--client-link"] ? { client_link: resolve(options["--client-link"]) } : {}) }, null, 2)}\n`);
}
