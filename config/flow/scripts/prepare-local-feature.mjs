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
  const allowed = ["--repository", "--brief", "--codex-executable", "--execution-trust", "--mode", "--check", "--client-link", "--reconfigure-check"];
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
  if (!["test", "verify"].includes(mode) || (mode === "test") !== Boolean(options["--check"])) {
    throw new Error("Use verify without --check, or test with one explicit trusted --check JSON_FILE");
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
  const check = options["--check"] ? validateProductionFeatureTestCheck(load(options["--check"])) : undefined;
  if (check) resolveProductionFeatureTestSelection({ checkId: check.check_id, brief, workspace: { path: repository }, featureTestCheck: check });
  const stateHome = process.env.FLOW_LOCAL_CLIENT_STATE_HOME ?? process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? homedir(), ".local/state");
  const parent = join(stateHome, "flow-local");
  const profileRoot = join(parent, digest(repository).slice(7, 31));
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtimeRoot,
    node: realpathSync(process.execPath), executable, execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT };
  const checkDigest = check ? digest(check) : null;
  const directory = join(profileRoot, "clients", checkDigest?.slice(7) ?? "verify");
  const authorityDirectory = join(profileRoot, "authority");
  let profile;
  const reused = existsSync(directory);
  if (existsSync(profileRoot)) {
    if (!lstatSync(profileRoot).isDirectory() || lstatSync(profileRoot).isSymbolicLink()) throw new Error("Local client path is not an owned profile directory");
    const pinned = load(join(profileRoot, "profile.json"));
    if (digest(pinned.identity) !== digest(identity)) throw new Error("This repository already has different runtime or executable pins; retain its authority and existing clients");
    if (pinned.initial_check_digest !== checkDigest || readdirSync(join(profileRoot, "clients")).length > 1) {
      if (options["--reconfigure-check"] !== "yes") throw new Error("Use --reconfigure-check yes to select a different check while retaining the same authority");
      const owner = await statusFlowOwner({ authorityDirectory });
      if (owner.state !== "stopped") throw new Error("Stop the existing local owner before selecting a different check");
      assertLocalCheckChangeQuiescent({ authorityDirectory, repository });
    }
  } else {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    mkdirSync(profileRoot, { mode: 0o700 });
    mkdirSync(join(profileRoot, "clients"), { mode: 0o700 });
    mkdirSync(authorityDirectory, { mode: 0o700 });
    save(join(profileRoot, "profile.json"), { identity, initial_check_digest: checkDigest });
  }
  if (reused) {
    profile = load(join(directory, "pilot.json"));
    if (digest(profile.local_client) !== digest(identity)) throw new Error("Local client identity changed");
  } else {
    mkdirSync(directory, { mode: 0o700 });
    for (const name of ["state", "receipts", "requests"]) mkdirSync(join(directory, name), { mode: 0o700 });
    const clientFiles = writeFeatureClient({ directory, runtimeRoot, workspace: repository,
      featureTestCheck: check, executionTrust: "supervised-native-cli", codexExecutable: executable.path, localStateHome: stateHome, authorityDirectory });
    profile = { directory, runtime_root: runtimeRoot, ...clientFiles, local_client: identity,
      execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT };
    save(join(directory, "pilot.json"), profile);
  }
  const requestDirectory = mkdtempSync(join(directory, "requests/feature-"));
  const request = { schema: "flow.feature-preparation-request/v1", brief, repository, mode,
    ...(check ? { test: { check_id: check.check_id } } : {}),
    routes: { apply: { harness: "codex", capability: "workspace-write-denied" }, critique: { harness: "codex", capability: "read-only" } },
    limits: { max_elapsed_seconds: 600, max_revisions: 0 }, execution_trust: SUPERVISED_NATIVE_ACKNOWLEDGMENT };
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
    request: requestPath, mode, verification_scope: check
      ? "Registered pinned Node health and acceptance checks, including expected RED then GREEN; arbitrary project suites are not registered"
      : verifyScope, owner_started: false, provider_execution: "not_run", profile_reused: reused,
    next_commands: [
      `${quoteShell(client)} start --json`,
      `${quoteShell(client)} prepare --input-file ${quoteShell(requestPath)} --json > ${quoteShell(preparedPath)}`,
      `${quoteShell(client)} local inspect-prepared ${quoteShell(preparedPath)}`,
      `${quoteShell(client)} local accept-prepared ${quoteShell(directory)} ${quoteShell(preparedPath)}`,
    ],
    instruction: "Inspect the confirmation before accept-prepared. That command writes a launch request and prints its explicit launch command; it starts no provider.",
    ...(options["--client-link"] ? { client_link: resolve(options["--client-link"]) } : {}) }, null, 2)}\n`);
}
