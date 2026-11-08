import { quoteShell, writeFeatureClient } from "./feature-client-files.mjs";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup") setup(args);
  else if (command === "inspect-prepared" && args.length === 1) inspectPrepared(args[0]);
  else if (command === "accept-prepared" && args.length === 2) acceptPrepared(...args);
  else if (command === "review-request" && args.length === 2) reviewRequest(...args);
  else throw new Error("Usage: prepare-feature-pilot.mjs setup [--mode test|verify] [--parent DIRECTORY] [--execution-trust supervised-native-cli --codex-executable ABSOLUTE_PATH]\n       prepare-feature-pilot.mjs review-request PILOT_DIRECTORY PRODUCER_RUN_ID");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function setup(args) {
  if (!/^v22\./u.test(process.version)) throw new Error("Setup requires the approved Node 22 executable");
  let mode = "test";
  let parent = tmpdir();
  let executionTrust, codexExecutable;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--mode", "--parent", "--execution-trust", "--codex-executable"].includes(flag) || !value || seen.has(flag)) throw new Error("Invalid setup arguments");
    seen.add(flag);
    if (flag === "--mode") mode = value;
    else if (flag === "--parent") parent = value;
    else if (flag === "--execution-trust") executionTrust = value;
    else codexExecutable = value;
  }
  if (!["test", "verify"].includes(mode)) throw new Error("Mode must be test or verify");
  if (executionTrust !== undefined && executionTrust !== "supervised-native-cli") throw new Error("Unsupported execution trust");
  if (executionTrust) {
    if (!codexExecutable?.startsWith("/")) throw new Error("Supervised setup requires --codex-executable with an installed absolute Codex0.166 path");
    codexExecutable = realpathSync(codexExecutable);
    const version = execFileSync(codexExecutable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
    if (version.trim() !== "codex-cli 0.166.0") throw new Error("Supervised setup requires official Codex0.166.0");
  } else if (codexExecutable) throw new Error("An explicit native executable requires supervised setup");
  const trustAcknowledgment = executionTrust ? { schema: "flow.supervised-native-cli/v1", acknowledgment: "trust-official-cli-permissions" } : null;
  parent = realpathSync(parent);
  // Check before allocation. Unix socket limits are shorter than filesystem limits.
  if (Buffer.byteLength(join(parent, "flow-pilot-XXXXXX/authority/owner.sock")) > 100) {
    throw new Error("Choose a shorter parent directory for the isolated owner socket");
  }
  const directory = mkdtempSync(join(parent, "flow-pilot-"));
  chmodSync(directory, 0o700);
  const workspace = join(directory, "repository");
  for (const name of ["repository", "authority", "receipts", "empty-template", "state"]) {
    mkdirSync(join(directory, name), { mode: 0o700 });
  }
  const executable = realpathSync(process.execPath);
  writeFileSync(join(directory, "untouched-canary.txt"), "Flow must preserve this sibling file.\n", { flag: "wx", mode: 0o600 });
  const files = {
    "feature.txt": "before\n",
    "health.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("positive health probe", () => assert.equal(2 + 2, 4));\n`,
    "acceptance.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\ntest("selected feature behavior", () => assert.equal(readFileSync("feature.txt", "utf8"), "after\\n"));\n`,
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(workspace, name), bytes, { flag: "wx", mode: 0o600 });
  // Ambient Git configuration, hooks and GIT_DIR must not redirect setup or run code.
  const git = (args) => execFileSync("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
    "-c", "user.name=Flow Pilot", "-c", "user.email=flow-pilot@example.test", "-C", workspace, ...args,
  ], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10000, encoding: "utf8" });
  git(["init", "--quiet", "--initial-branch=main", `--template=${join(directory, "empty-template")}`]);
  git(["add", "--", ...Object.keys(files)]);
  git(["commit", "--quiet", "-m", "Create disposable Flow pilot baseline"]);
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error(`New pilot workspace is dirty: ${workspace}`);
  const criteria = ["feature.txt contains after"];
  const featureTestCheck = {
    schema: "flow.production-feature-test-check/v1", check_id: "check:feature-text",
    executable: { path: executable, version: process.version, sha256: sha(readFileSync(executable)) },
    health: { path: "health.test.mjs", sha256: sha(files["health.test.mjs"]), case_name: "positive health probe" },
    acceptance: { path: "acceptance.test.mjs", sha256: sha(files["acceptance.test.mjs"]), case_name: "selected feature behavior" },
    pinned_files: [], criteria,
    expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "after\n", actual: "before\n" },
    environment: { PATH: "/usr/bin:/bin" }, limits: { timeout_ms: 5000, max_output_bytes: 65536 },
  };
  const clientFiles = writeFeatureClient({ directory, runtimeRoot, workspace,
    featureTestCheck, executionTrust, codexExecutable });
  const request = {
    schema: "flow.feature-preparation-request/v1",
    brief: { schema: "flow.feature-brief/v1", id: `brief:pilot-${mode}`, summary: "Change feature.txt from before to after, preserving the committed checks", acceptance: criteria },
    repository: workspace, mode,
    ...(mode === "test" ? { test: { check_id: featureTestCheck.check_id } } : {}),
    routes: { apply: { harness: "codex", capability: "workspace-write-denied" }, critique: { harness: "codex", capability: "read-only" } },
    limits: { max_elapsed_seconds: 600, max_revisions: 0 },
    ...(executionTrust ? { execution_trust: trustAcknowledgment } : {
      dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: "flow-release-1.1-dark-test/v1", purpose: "sacrificial_qualification" },
    }),
  };
  save(join(directory, "prepare-request.json"), request);
  save(join(directory, "starting-git-facts.json"), { clean: true, commit_sha: git(["rev-parse", "HEAD"]).trim(), tree_sha: git(["rev-parse", "HEAD^{tree}"]).trim() });
  const result = {
    status: "preparation_only", directory, mode, runtime_root: runtimeRoot, ...clientFiles,
    canary_sha256: sha(readFileSync(join(directory, "untouched-canary.txt"))),
    native_execution: "not_run", qualification: "not_run", normal_use_authorized: false,
    ...(executionTrust ? { execution_trust: trustAcknowledgment,
      trust_limitations: "Official CLI permissions and ambient startup are trusted by the supervisor; Flow has not independently established workspace, protected-path, escalation or tool-network enforcement.",
      native_executable: { path: codexExecutable, version: "codex-cli 0.166.0", sha256: sha(readFileSync(codexExecutable)) } } : {}),
  };
  save(join(directory, "pilot.json"), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function acceptPrepared(directory, preparedPath) {
  directory = realpathSync(directory);
  const pilot = json(join(directory, "pilot.json"));
  if (pilot.directory !== directory || pilot.runtime_root !== runtimeRoot) throw new Error("Pilot runtime/directory binding changed");
  const prepared = readPrepared(preparedPath);
  const request = {
    prepared,
    confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept",
      bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
    closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest,
      facts: prepared.explicit_facts },
    ...(pilot.execution_trust ? { execution_trust: pilot.execution_trust } : {
      dark_opt_in: json(join(directory, "prepare-request.json")).dark_opt_in,
    }),
  };
  const receiptDirectory = mkdtempSync(join(directory, "receipts/accepted-"));
  chmodSync(receiptDirectory, 0o700);
  save(join(receiptDirectory, "prepared.json"), prepared);
  const requestPath = join(receiptDirectory, "launch-request.json");
  save(requestPath, request);
  process.stdout.write(`${JSON.stringify({ status: "launch_request_only", directory: receiptDirectory,
    request: requestPath,
    launch_command: `${quoteShell(join(directory, "flow"))} launch --input-file ${quoteShell(requestPath)} --json`,
    instruction: "Inspect the retained confirmation and exact launch request before explicitly calling flow launch. No task has been started." }, null, 2)}\n`);
}

function readPrepared(preparedPath) {
  const prepared = json(preparedPath);
  if (prepared.schema !== "flow.prepared-run/v1" || prepared.kind !== "predefined" ||
      !/^sha256:[0-9a-f]{64}$/u.test(prepared.bundle_digest ?? "") ||
      prepared.confirmation_digest !== digest(prepared.confirmation) ||
      prepared.plan_fingerprint !== digest(prepared.graph) || !prepared.explicit_facts) {
    throw new Error("Use the exact public prepare response after inspecting its confirmation");
  }
  return prepared;
}

function inspectPrepared(path) {
  const prepared = readPrepared(path);
  process.stdout.write(`${JSON.stringify({ status: "inspection_only", prepared_file: realpathSync(path),
    bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest,
    definition: prepared.definition.id, mode: prepared.selection.inputs.mode ?? "local_review",
    brief: prepared.selection.inputs.brief ?? null,
    project_check: prepared.selection.inputs.project_check ?? null, trust_posture: prepared.trust_posture,
    requested_authority: prepared.requested_authority, limits: prepared.explicit_facts.limits,
    routes: prepared.graph.cards.filter(card => card.executor.kind === "delegate")
      .map(card => ({ card_id: card.id, launch: card.inputs.description?.launch,
        executable: card.inputs.description?.backend?.executable,
        requested_permissions: card.inputs.description?.effective_authority })),
    instruction: "Inspect the complete retained confirmation before accepting this exact prepared file. This summary grants no authority." }, null, 2)}\n`);
}

function reviewRequest(directory, runId) {
  directory = realpathSync(directory);
  if (!/^run:[a-f0-9]{64}$/u.test(runId)) throw new Error("Use the exact run_id returned by feature launch");
  const pilot = json(join(directory, "pilot.json"));
  if (pilot.directory !== directory || pilot.runtime_root !== runtimeRoot) throw new Error("Pilot runtime/directory binding changed");
  // This uses only public query commands. No candidate or authority fact is supplied by setup.
  const query = (input) => {
    const output = execFileSync(join(directory, "flow"), ["query", "--input", JSON.stringify(input), "--json"], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const value = JSON.parse(output);
    if (value.schema === "flow.rejection/v1") throw new Error(`Public query rejected: ${value.code}`);
    return value;
  };
  const run = query({ run_id: runId });
  if (run.run_id !== runId || run.phase !== "succeeded" || !run.review_candidate_reference?.candidate_id) throw new Error("Producer has no successful retained candidate");
  const candidate = query({ contract: "work.review/v1", subject_id: run.review_candidate_reference.candidate_id });
  if (candidate.schema !== "work.review-candidate-projection/v1" || candidate.status !== "sealed" || candidate.candidate?.candidate_id !== run.review_candidate_reference.candidate_id || candidate.candidate_fingerprint !== candidate.candidate?.candidate_fingerprint) throw new Error("Candidate is not sealed and exact");
  const target = { candidate_id: candidate.candidate.candidate_id, candidate_fingerprint: candidate.candidate_fingerprint };
  const selection = {
    schema: "flow.review-preparation-selection/v1", target, lenses: ["security"],
    routes: { lenses: { security: { launch: { harness: "codex", role: "lens:security", capability: "read-only" } } }, critic: { launch: { harness: "codex", role: "critic", capability: "read-only" } } },
  };
  const facts = query({ schema: "flow.query/v1", query: "review_preparation_facts", ...target, selection });
  if (facts.schema !== "flow.review-preparation-facts/v1" || facts.candidate?.candidate_id !== target.candidate_id || facts.candidate?.candidate_fingerprint !== target.candidate_fingerprint) throw new Error("Review preparation facts do not bind the exact candidate");
  const routes = Object.fromEntries(facts.route.bindings.map((route) => [route.card_id, route]));
  const binding = (id) => {
    const value = routes[id];
    if (!value?.description || !value.route) throw new Error(`Missing authority-owned route: ${id}`);
    return { description: value.description, route: value.route };
  };
  const request = {
    schema: "flow.predefined-flow-selection/v1", definition: "review/v1",
    inputs: {
      schema: "flow.review-request/v1",
      target: { schema: "flow.review-local-candidate/v1", candidate: candidate.candidate, candidate_fingerprint: target.candidate_fingerprint, candidate_authority_watermark: candidate.watermark, lifecycle_generation: candidate.generation },
      lenses: selection.lenses, preparation_selection: selection, preparation_facts: facts,
      delegation: { schema: "flow.review-delegation-bindings/v1", lenses: { security: binding("review-lens-security") }, critic: binding("review-critic") },
    },
    ...(pilot.execution_trust ? { execution_trust: pilot.execution_trust } : {
      dark_opt_in: json(join(directory, "prepare-request.json")).dark_opt_in,
    }),
  };
  // Exclusive writes keep earlier attempts available; use a new receipt directory per observation.
  const receiptDirectory = mkdtempSync(join(directory, "receipts/review-"));
  chmodSync(receiptDirectory, 0o700);
  for (const [name, value] of Object.entries({ "completed-run": run, candidate, "preparation-facts": facts, "prepare-request": request })) save(join(receiptDirectory, `${name}.json`), value);
  process.stdout.write(`${JSON.stringify({ status: "request_only", directory: receiptDirectory, request: join(receiptDirectory, "prepare-request.json") }, null, 2)}\n`);
}
