import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { findInstalledExecutable, projectCheckPreset, projectGit, projectSignals } from "./project-check-presets.mjs";
import { createProjectCheckRegistration } from "./project-check-registration.mjs";
import { assertProductionGitFiltersAbsent, resolveProductionGitIdentity } from "./production-direct-commit.mjs";

const runtimeRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const fail = message => { throw new Error(message); };
const text = path => readFileSync(path, "utf8");
const hash = path => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const valueFlags = new Set(["--repository", "--kind", "--summary", "--acceptance", "--id", "--brief", "--codex-executable", "--tool-executable", "--test-directory", "--test-pattern", "--python-runner", "--read-executable", "--pin", "--timeout-seconds", "--client-link", "--upgrade-runtime", "--reconfigure-check", "--confirm"]);
function canonicalDestination(path) {
  const remaining = [];
  while (!existsSync(path)) { remaining.unshift(path.split("/").at(-1)); path = dirname(path); }
  return join(realpathSync(path), ...remaining);
}

export const INIT_USAGE = `Usage:
  flow-supervised init
  flow-supervised init --summary TEXT --acceptance TEXT [--acceptance TEXT ...] --json
  flow-supervised init [same selections] --confirm sha256:DIGEST [--json]

Options:
  --repository PATH            existing clean Git project (default: current project)
  --kind npm|python|go          select when project signals are ambiguous
  --summary TEXT               feature summary; TTY prompts when omitted
  --acceptance TEXT            acceptance criterion, repeatable
  --id TEXT                    optional stable feature brief identifier
  --brief JSON_FILE            optional existing brief instead of plain text
  --codex-executable PATH      installed official Codex (default: installed PATH entry)
  --tool-executable PATH       installed Python/Go; npm uses this CLI's Node 22
  --python-runner unittest|pytest
  --test-directory DIRECTORY   Python discovery root
  --test-pattern GLOB          unittest filename glob
  --pin FILE                  additional committed acceptance/config file, repeatable
  --read-executable PATH       extra installed native helper and ELF libraries, repeatable
  --timeout-seconds NUMBER     suite timeout, 1 through 1800 (default: 300)
  --client-link NEW_PATH       optional client link; existing links are preserved
  --upgrade-runtime yes        existing stopped/settled runtime-selection procedure
  --reconfigure-check yes      existing stopped/settled check-selection procedure

Preview and confirmation select supervised setup only. Init starts no owner,
provider or project test and installs nothing. Missing dependencies are errors.
`;

export function parseInitArguments(args) {
  const options = { acceptance: [], extraExecutables: [], pins: [] };
  const repeats = { "--acceptance": "acceptance", "--read-executable": "extraExecutables", "--pin": "pins" };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (["--json", "--help", "-h"].includes(key)) {
      if (options[key]) fail(`Duplicate ${key}`);
      options[key] = true; continue;
    }
    if (!valueFlags.has(key) || !args[index + 1] || args[index + 1].startsWith("--")) fail(`Invalid init option ${key}. Use init --help.`);
    const value = args[++index];
    if (repeats[key]) options[repeats[key]].push(value);
    else {
      if (Object.hasOwn(options, key)) fail(`Duplicate ${key}`);
      options[key] = value;
    }
  }
  if (options["--brief"] && (options["--summary"] || options.acceptance.length || options["--id"])) fail("Choose --brief or plain --summary/--acceptance flags, not both");
  for (const key of ["--upgrade-runtime", "--reconfigure-check"]) if (options[key] !== undefined && options[key] !== "yes") fail(`Use ${key} yes explicitly`);
  const seconds = Number(options["--timeout-seconds"] ?? 300);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800) fail("--timeout-seconds must be an integer from 1 through 1800");
  options.timeoutMs = seconds * 1000;
  return options;
}

function briefFromOptions(options) {
  if (options["--brief"]) return JSON.parse(text(resolve(options["--brief"])));
  const summary = options["--summary"]?.trim();
  const acceptance = options.acceptance.map(value => value.trim());
  if (!summary || !acceptance.length || acceptance.some(value => !value)) fail("Provide --summary TEXT and repeatable --acceptance TEXT, or run init in a TTY for guided input.");
  return { schema: "flow.feature-brief/v1", id: options["--id"] ?? `feature-${digest({ summary, acceptance }).slice(7, 23)}`, summary, acceptance };
}

/** A read-only concrete selection, suitable for human preview or digest confirmation. */
export function createProjectInitPlan(options, { env = process.env, cwd = process.cwd() } = {}) {
  if (!/^v22\./u.test(process.version)) fail("Guided setup requires Node 22");
  const selected = realpathSync(resolve(cwd, options["--repository"] ?? "."));
  const repository = realpathSync(projectGit(selected, ["rev-parse", "--show-toplevel"]).trim());
  try { assertProductionGitFiltersAbsent((args, options) => projectGit(repository, args, { ...options, encoding: null })); }
  catch (error) {
    if (error.message === "candidate_commit_external_filter_unsupported") fail("Git clean/process filters or declared filter attributes are unsupported by the existing commit contract. Init runs no filter; review this configuration separately.");
    throw error;
  }
  if (projectGit(repository, ["status", "--porcelain"]).length) fail("Choose an existing clean Git project. Preserve or commit dirty work before init.");
  const brief = briefFromOptions(options);
  if (!brief || Object.keys(brief).sort().join(",") !== "acceptance,id,schema,summary" || brief.schema !== "flow.feature-brief/v1" ||
      !Array.isArray(brief.acceptance) || !brief.acceptance.length || new Set(brief.acceptance).size !== brief.acceptance.length ||
      [brief.id, brief.summary, ...brief.acceptance].some(value => typeof value !== "string" || !value.trim() || value.length > 8192)) fail("Provide a valid brief with unique non-empty acceptance criteria");
  const codex = findInstalledExecutable("codex", { env, selected: options["--codex-executable"] });
  let gitIdentity;
  try { gitIdentity = resolveProductionGitIdentity(repository, env); }
  catch (error) {
    if (error.message === "candidate_commit_author_identity_unproven") fail("Git author and committer identity are required. Configure user.name and user.email separately, then repeat init; init writes no Git configuration.");
    throw error;
  }
  const stateHome = env.FLOW_LOCAL_CLIENT_STATE_HOME ?? env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local/state");
  if (!isAbsolute(stateHome)) fail("Choose an absolute machine-local state directory");
  const actualStateHome = canonicalDestination(stateHome);
  if (actualStateHome === repository || actualStateHome.startsWith(repository + "/")) fail("Choose a machine-local state directory outside the project");
  const profile = join(stateHome, "flow-local", digest(repository).slice(7, 31));
  const authorityDirectory = canonicalDestination(join(profile, "authority"));
  const configurationParent = canonicalDestination(join(stateHome, "flow-init"));
  if (configurationParent === repository || configurationParent.startsWith(repository + "/")) fail("Choose a private configuration directory outside the project");
  const preset = projectCheckPreset({ repository, kind: options["--kind"], criteria: brief.acceptance, env, authorityDirectory, options: {
    toolExecutable: options["--tool-executable"], pythonRunner: options["--python-runner"], testDirectory: options["--test-directory"], testPattern: options["--test-pattern"],
    pins: options.pins, extraExecutables: options.extraExecutables, timeoutMs: options.timeoutMs,
  } });
  const registration = createProjectCheckRegistration({ repository, recipe: preset.recipe, authorityDirectory });
  let clientDirectory = join(profile, "clients", registration.registration_digest.slice(7));
  if (existsSync(join(profile, "profile.json"))) {
    const original = JSON.parse(text(join(profile, "profile.json")));
    if (original.identity.runtime_root !== runtimeRoot) clientDirectory += `.runtime-${digest(runtimeRoot).slice(7)}`;
  }
  const clientLink = options["--client-link"] && resolve(cwd, options["--client-link"]);
  let canonicalClientLink = null;
  if (clientLink) {
    const destination = join(canonicalDestination(dirname(clientLink)), basename(clientLink));
    canonicalClientLink = destination;
    if (destination === repository || destination.startsWith(repository + "/")) fail("Choose a --client-link outside the project so preparation keeps a clean workspace");
    let existing;
    try { existing = lstatSync(clientLink); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing && (!existing.isSymbolicLink() || realpathSync(clientLink) !== join(clientDirectory, "flow"))) fail("Client link already exists and will not be replaced. Choose a new --client-link.");
  }
  return { schema: "flow.project-init-selection/v1", repository, git_head: projectGit(repository, ["rev-parse", "HEAD"]).trim(),
    kind: preset.kind, brief, runtime_root: runtimeRoot, node: realpathSync(process.execPath), git_identity: gitIdentity,
    codex_executable: { path: codex, sha256: hash(codex) }, recipe: preset.recipe, project_check: registration.config,
    registration_digest: registration.registration_digest, binding_fingerprint: registration.binding_fingerprint, scope: registration.scope,
    setup: { authority_directory: join(profile, "authority"), canonical_authority_directory: authorityDirectory,
      state_home: stateHome, canonical_state_home: actualStateHome, configuration_parent: configurationParent,
      client_link: clientLink ?? null, canonical_client_link: canonicalClientLink,
      upgrade_runtime: options["--upgrade-runtime"] ?? null, reconfigure_check: options["--reconfigure-check"] ?? null },
    execution_trust: "supervised-native-cli", trust_disclosure: "Official CLI requested permissions and ambient startup are operator-supervised, not independently enforced. This confirmation authorizes setup, not launch.",
    notes: [...preset.notes, "Changing acceptance changes the check identity: existing profiles may require --reconfigure-check yes and a stopped, settled owner", "Runtime selection changes require explicit --upgrade-runtime yes and the existing stopped, settled procedure"],
    project_tests: "not_run", owner_started: false, provider_execution: "not_run" };
}

export function renderProjectInitPlan(plan) {
  const check = plan.project_check;
  const display = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return ["Flow project setup - preview", `Project: ${plan.repository}`, `Feature: ${plan.brief.summary}`,
    ...plan.brief.acceptance.map(value => `  Acceptance: ${value}`), `Preset: ${plan.kind} (GREEN-only verify)`,
    `Official CLI: ${plan.codex_executable.path} (${plan.codex_executable.sha256})`,
    `Command: ${JSON.stringify([check.executable.path, ...check.argv])}`, `Version probe: ${JSON.stringify(check.version_argv)} -> ${check.version}`,
    `Timeout: ${check.limits.timeout_ms / 1000}s + bounded 5s version probe; output: ${check.limits.max_output_bytes} bytes`,
    "Read-only inputs:", ...check.read_mounts.flatMap(input => [`  ${input.source} -> ${input.target}`, `    ${input.sha256}`]),
    "Pinned existing tests/configuration:", ...check.pinned_files.map(file => `  ${file.path} (${file.sha256})`),
    `Environment: ${JSON.stringify(check.environment)}`, `Private configuration parent: ${plan.setup.configuration_parent}`,
    `Client link: ${plan.setup.client_link ?? "none (use the returned immutable client path)"}`,
    ...(plan.setup.client_link ? [`Resolved client link destination: ${plan.setup.canonical_client_link}`] : []),
    `Authority: ${plan.setup.authority_directory}`, `Trust: ${plan.trust_disclosure}`,
    ...plan.notes.map(note => `Note: ${note}`), "No project tests, owner or model work have run. Nothing has been created.", ""].map(display).join("\n");
}

async function applyPlan(plan, options, env, cwd) {
  const current = createProjectInitPlan(options, { env, cwd });
  if (digest(current) !== digest(plan)) fail("Project or selected inputs changed after preview. Review a fresh init plan.");
  const parent = plan.setup.configuration_parent;
  if (parent === plan.repository || parent.startsWith(plan.repository + "/")) fail("Choose a machine-local state directory outside the project");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "setup-"));
  const recipe = join(directory, "recipe.json"), brief = join(directory, "brief.json"), registration = join(directory, "project-check.json");
  save(recipe, plan.recipe); save(brief, plan.brief); save(join(directory, "accepted-plan.json"), { plan, confirmation_digest: digest(plan) });
  const run = async (script, args) => {
    try { return JSON.parse((await promisify(execFile)(process.execPath, [join(runtimeRoot, "config/flow/scripts", script), ...args], { env, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout); }
    catch (error) { fail(`Setup refused; retained configuration at ${directory}. ${error.stderr?.trim() || error.message}`); }
  };
  const registered = await run("register-project-check.mjs", ["--repository", plan.repository, "--recipe", recipe, "--output", registration]);
  if (registered.registration_digest !== plan.registration_digest) fail(`Selected inputs changed during registration. No client was created; inspect ${directory} and preview again.`);
  const args = ["--repository", plan.repository, "--brief", brief, "--codex-executable", plan.codex_executable.path, "--execution-trust", "supervised-native-cli", "--mode", "verify", "--check", registration];
  for (const [flag, value] of [["--client-link", plan.setup.client_link], ["--upgrade-runtime", plan.setup.upgrade_runtime], ["--reconfigure-check", plan.setup.reconfigure_check]]) if (value) args.push(flag, value);
  const result = await run("prepare-local-feature.mjs", args);
  return { ...result, init_directory: directory, registration, brief, confirmation_digest: digest(plan) };
}

export async function runProjectInit(args, { env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let prompts;
  try {
    const options = parseInitArguments(args);
    if (options["--help"] || options["-h"]) { stdout.write(INIT_USAGE); return 0; }
    const interactive = Boolean(stdin.isTTY && stdout.isTTY && !options["--json"] && !options["--confirm"]);
    if (interactive) {
      prompts = createInterface({ input: stdin, output: stdout });
      if (!options["--brief"]) {
        options["--summary"] ??= (await prompts.question("What feature should Flow work on? ")).trim();
        if (!options.acceptance.length) {
          stdout.write("Acceptance criteria, one per line. Finish with an empty line.\n");
          for (;;) { const criterion = (await prompts.question("  Criterion: ")).trim(); if (!criterion) break; options.acceptance.push(criterion); }
        }
      }
      const selected = realpathSync(resolve(cwd, options["--repository"] ?? "."));
      const repository = projectGit(selected, ["rev-parse", "--show-toplevel"]).trim();
      const signals = projectSignals(repository);
      if (!options["--kind"] && signals.kinds.length !== 1) options["--kind"] = (await prompts.question(`Project type (${signals.kinds.join(", ") || "npm, python, go"}): `)).trim();
      if (!options["--codex-executable"]) {
        try { findInstalledExecutable("codex", { env }); }
        catch { options["--codex-executable"] = (await prompts.question("Installed official Codex absolute path: ")).trim(); }
      }
    }
    const plan = createProjectInitPlan(options, { env, cwd });
    const confirmationDigest = digest(plan);
    if (options["--confirm"] && options["--confirm"] !== confirmationDigest) fail("Confirmation digest does not match the current configuration. Preview again; nothing was created.");
    if (!options["--confirm"] && !interactive) {
      const output = { schema: "flow.project-init-plan/v1", status: "confirmation_required", plan, confirmation_digest: confirmationDigest, writes_performed: false, project_command_executed: false };
      stdout.write(options["--json"] ? JSON.stringify(output, null, 2) + "\n" : renderProjectInitPlan(plan) + `Repeat the same init selections with --confirm ${confirmationDigest}.\n`);
      return 0;
    }
    if (interactive) {
      stdout.write(renderProjectInitPlan(plan));
      const answer = (await prompts.question("Create this supervised setup? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(answer)) { stdout.write("Nothing created.\n"); return 0; }
    }
    const result = await applyPlan(plan, options, env, cwd);
    if (options["--json"]) stdout.write(JSON.stringify(result, null, 2) + "\n");
    else stdout.write([`Created supervised project setup: ${result.directory}`, "No owner, provider or project test was started.", "Next commands:", ...result.next_commands.map(command => `  ${command}`), result.instruction, ""].join("\n"));
    return 0;
  } catch (error) {
    stderr.write(`${error.code === "ERR_USE_AFTER_CLOSE" ? "Input ended. Nothing created." : error.message}\n`);
    return 1;
  } finally { prompts?.close(); }
}
