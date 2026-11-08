import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";

const reporter = fileURLToPath(new URL("./production-feature-test-reporter.mjs", import.meta.url));
const worker = fileURLToPath(new URL("./production-feature-test-worker.py", import.meta.url));
const python = "/usr/bin/python3";
const sandbox = "/usr/bin/bwrap";
const sandboxVersion = "bubblewrap 0.11.1";
const sandboxContract = "linux-bwrap-readonly-check/v1";
const schema = "flow.production-feature-test-check/v1";
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;

export function featureTestError(code, message = code) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateProductionFeatureTestCheck(config) {
  if (!exact(config, ["schema", "check_id", "executable", "health", "acceptance", "pinned_files", "criteria", "expected_failure", "environment", "limits"]) ||
      config.schema !== schema || !/^[a-zA-Z0-9:_-]{1,128}$/u.test(config.check_id ?? "") ||
      !exact(config.executable, ["path", "version", "sha256"]) ||
      typeof config.executable.path !== "string" || !config.executable.path.startsWith("/") ||
      !/^v22\.[0-9]+\.[0-9]+$/u.test(config.executable.version ?? "") || !hashPattern.test(config.executable.sha256 ?? "") ||
      !Array.isArray(config.criteria) || config.criteria.length === 0 ||
      config.criteria.some((criterion) => typeof criterion !== "string" || !criterion) || new Set(config.criteria).size !== config.criteria.length ||
      !Array.isArray(config.pinned_files) || config.pinned_files.some((file) => !exact(file, ["path", "sha256"]) || !relativeFile(file.path) || !hashPattern.test(file.sha256 ?? "")) ||
      !exact(config.expected_failure, ["code", "operator", "expected", "actual"]) ||
      config.expected_failure.code !== "ERR_ASSERTION" || config.expected_failure.operator !== "strictEqual" ||
      ![config.expected_failure.expected, config.expected_failure.actual].every((value) => typeof value === "string" && Buffer.byteLength(value) <= 4096) ||
      config.expected_failure.expected === config.expected_failure.actual ||
      !exact(config.limits, ["timeout_ms", "max_output_bytes"]) ||
      !Number.isSafeInteger(config.limits.timeout_ms) || config.limits.timeout_ms < 1 || config.limits.timeout_ms > 30_000 ||
      !Number.isSafeInteger(config.limits.max_output_bytes) || config.limits.max_output_bytes < 1024 || config.limits.max_output_bytes > 1024 * 1024 ||
      !exact(config.environment, ["PATH"]) || config.environment.PATH !== "/usr/bin:/bin") {
    throw featureTestError("feature_test_check_invalid");
  }
  for (const value of [config.health, config.acceptance]) {
    if (!exact(value, ["path", "sha256", "case_name"]) || !relativeFile(value.path) || !hashPattern.test(value.sha256 ?? "") ||
        typeof value.case_name !== "string" || !value.case_name || Buffer.byteLength(value.case_name) > 256) throw featureTestError("feature_test_check_invalid");
  }
  const paths = [config.health.path, config.acceptance.path, ...config.pinned_files.map(({ path }) => path)];
  if (new Set(paths).size !== paths.length || config.health.case_name === config.acceptance.case_name) throw featureTestError("feature_test_check_invalid");
  return freezeCanonical(config);
}

function relativeFile(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("-") &&
    path.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part) && ![".", "..", ".git", ".agents", ".codex"].includes(part));
}

function git(root, args) {
  return execFileSync("/usr/bin/git", ["-c", "diff.autoRefreshIndex=false", "-c", "core.fsmonitor=false", "-C", root, ...args], {
    env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}

export function resolveProductionFeatureTestSelection({ checkId, brief, workspace, featureTestCheck }) {
  if (featureTestCheck === undefined || featureTestCheck.check_id !== checkId) throw featureTestError("feature_test_check_unavailable");
  const config = validateProductionFeatureTestCheck(featureTestCheck);
  if (!Array.isArray(brief?.acceptance) || digest(brief.acceptance) !== digest(config.criteria)) throw featureTestError("feature_test_check_criterion_mismatch");
  try {
    const root = realpathSync(workspace.path);
    if (root !== resolve(workspace.path) || realpathSync(config.executable.path) !== config.executable.path ||
        !lstatSync(config.executable.path).isFile() || sha(readFileSync(config.executable.path)) !== config.executable.sha256 ||
        git(root, ["rev-parse", "--show-toplevel"]).toString().trim() !== root) throw featureTestError("feature_test_check_drift");
    const files = [config.health, config.acceptance, ...config.pinned_files].map(({ path, sha256 }) => {
      const absolute = join(root, path); const status = lstatSync(absolute); const bytes = readFileSync(absolute);
      if (!status.isFile() || realpathSync(absolute) !== absolute || sha(bytes) !== sha256 || !git(root, ["show", `HEAD:${path}`]).equals(bytes)) throw featureTestError("feature_test_check_drift");
      return { path, sha256, mode: status.mode & 0o111 ? "100755" : "100644" };
    });
    const fingerprint = digest({ config, files, reporter: sha(readFileSync(reporter)), worker: sha(readFileSync(worker)), supervision: sha(readFileSync(python)),
      check_implementation: sha(readFileSync(fileURLToPath(import.meta.url))),
      operation_implementation: sha(readFileSync(fileURLToPath(new URL("./production-feature-operations.mjs", import.meta.url)))),
      sandbox: { contract: sandboxContract, version: sandboxVersion, sha256: sha(readFileSync(sandbox)) } });
    return freezeCanonical({
      slice: { schema: "flow.feature-slice/v1", id: `check-${config.check_id}`, mode: "test", acceptance: [...brief.acceptance],
        test: { schema: "flow.feature-test-request/v1", intended_failure: `check:${config.check_id}:${digest(config.expected_failure)}`,
          environment_fingerprint: fingerprint, environment_status: "healthy" } },
      checkBinding: { schema: "flow.production-feature-test-check-binding/v1", check_id: config.check_id, fingerprint },
    });
  } catch (error) {
    if (error?.code?.startsWith("feature_test_")) throw error;
    throw featureTestError("feature_test_check_drift");
  }
}

function syncDirectory(path) {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durable(root, name, value) {
  const temporary = join(root, `${name}.${randomUUID()}.new`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(root, name)); syncDirectory(root);
}

// Adoption changes the current authority fence, not the immutable effect.
// RunAuthority validates that current fence before dispatching this operation.
function checkEffectIntentIdentity(intent) {
  const { authority_epoch: _authorityEpoch, authority_boot_id: _authorityBootId, ...identity } = intent;
  return identity;
}

/** One fixed Node check sequence. Pending records are never replayed. */
export function createProductionFeatureCheckRunner({ authorityDirectory, featureTestCheck }) {
  let config = null;
  try { if (featureTestCheck !== undefined) config = validateProductionFeatureTestCheck(featureTestCheck); }
  catch (error) { if (error?.code !== "feature_test_check_invalid") throw error; }
  const base = typeof authorityDirectory === "string" ? join(authorityDirectory, "feature-test-checks") : null;
  const rootFor = (identity) => join(base, digest({ effect_id: identity.effect_id, idempotency_key: identity.idempotency_key }).slice(7));
  function read(identity) {
    if (base === null) throw featureTestError("feature_test_evidence_unavailable");
    const root = rootFor(identity);
    if (!existsSync(join(root, "reservation.json"))) return null;
    const reservation = JSON.parse(readFileSync(join(root, "reservation.json"), "utf8"));
    const { reservation_digest, ...reserved } = reservation;
    if (digest(reserved) !== reservation_digest || reservation.intent_digest !== digest(checkEffectIntentIdentity(identity))) throw featureTestError("feature_test_evidence_conflict");
    if (!existsSync(join(root, "terminal.json"))) throw featureTestError("feature_test_outcome_unknown");
    const terminal = JSON.parse(readFileSync(join(root, "terminal.json"), "utf8"));
    const { self_digest, ...value } = terminal;
    if (sha(Buffer.from(JSON.stringify(value))) !== self_digest || terminal.reservation_digest !== reservation.reservation_digest || terminal.retired !== true || terminal.proof !== "linux_subreaper_echild") throw featureTestError("feature_test_outcome_unknown");
    for (const check of terminal.checks) {
      if (!["health", "acceptance"].includes(check.phase) ||
          sha(readFileSync(join(root, check.phase + ".stdout"))) !== check.stdout_sha256 ||
          sha(readFileSync(join(root, check.phase + ".stderr"))) !== check.stderr_sha256) throw featureTestError("feature_test_outcome_unknown");
    }
    syncDirectory(root);
    return { root, reservation, terminal };
  }
  return Object.freeze({
    available: config !== null && base !== null && process.platform === "linux",
    read,
    readRed(receipt) {
      if (base === null) throw featureTestError("feature_test_evidence_unavailable");
      const root = rootFor(receipt);
      let saved;
      try { saved = JSON.parse(readFileSync(join(root, "accepted-red.json"), "utf8")); }
      catch { throw featureTestError("feature_test_red_evidence_missing"); }
      if (digest(saved.provider_receipt) !== digest(receipt) || saved.evidence_digest !== digest(saved.evidence)) throw featureTestError("feature_test_evidence_conflict");
      const observed = read(saved.intent);
      if (observed === null || observed.terminal.self_digest !== saved.evidence.terminal.self_digest) throw featureTestError("feature_test_evidence_conflict");
      return saved;
    },
    retainRed(intent, receipt, evidence) {
      durable(rootFor(intent), "accepted-red.json", { intent, provider_receipt: receipt, evidence, evidence_digest: digest(evidence) });
    },
    async run(intent, workspace, selected) {
      if (config === null || base === null || process.platform !== "linux") throw featureTestError("feature_test_check_unavailable");
      if (digest(featureTestCheck) !== digest(config)) throw featureTestError("feature_test_check_drift");
      let existing = read(intent);
      if (existing !== null) return existing;
      mkdirSync(base, { recursive: true, mode: 0o700 }); syncDirectory(base); syncDirectory(dirname(base));
      const root = rootFor(intent);
      try { mkdirSync(root, { mode: 0o700 }); } catch { throw featureTestError("feature_test_outcome_unknown"); }
      syncDirectory(root); syncDirectory(base);
      const identity = { intent_digest: digest(checkEffectIntentIdentity(intent)), check_fingerprint: selected.checkBinding.fingerprint, workspace: workspace.path, config, reporter,
        reporter_sha256: sha(readFileSync(reporter)), worker_sha256: sha(readFileSync(worker)), python_sha256: sha(readFileSync(python)),
        sandbox, sandbox_version: sandboxVersion, sandbox_sha256: sha(readFileSync(sandbox)), sandbox_contract: sandboxContract };
      const reservation = { ...identity, reservation_digest: digest(identity) };
      durable(root, "reservation.json", reservation);
      const child = spawn(python, ["-I", "-S", worker, root], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      child.on("error", () => {}); child.unref();
      const deadline = Date.now() + config.limits.timeout_ms * 3 + 5000;
      while (Date.now() < deadline) {
        if (existsSync(join(root, "terminal.json"))) return read(intent);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw featureTestError("feature_test_outcome_unknown");
    },
  });
}

export function validateProductionFeatureCheckObservation(observed, config, expected) {
  const terminal = observed.terminal;
  if (terminal.failure !== null || terminal.version !== config.executable.version || terminal.checks.length !== 2) throw featureTestError("feature_test_environment_unhealthy");
  const [health, acceptance] = terminal.checks;
  for (const [check, recipe] of [[health, config.health], [acceptance, config.acceptance]]) {
    if (check.events.length !== 2 || check.events[0].name !== recipe.case_name || check.events[1].kind !== "summary" || check.events[1].tests !== 1 || check.events[1].cancelled !== 0 || check.events[1].skipped !== 0 || check.events[1].todo !== 0) throw featureTestError("feature_test_output_invalid");
  }
  if (health.exit_code !== 0 || health.events[0].kind !== "pass" || health.events[1].passed !== 1 || health.events[1].failed !== 0) throw featureTestError("feature_test_environment_unhealthy");
  const result = acceptance.events[0]; const summary = acceptance.events[1];
  if (expected === "red") {
    if (acceptance.exit_code !== 1 || result.kind !== "fail" || summary.failed !== 1 || summary.passed !== 0 || digest(result.failure) !== digest(config.expected_failure)) throw featureTestError("feature_test_expected_failure_missing");
  } else if (acceptance.exit_code !== 0 || result.kind !== "pass" || summary.passed !== 1 || summary.failed !== 0) throw featureTestError("feature_test_green_missing");
  return freezeCanonical({ check_fingerprint: observed.reservation.check_fingerprint, terminal, evidence_digest: digest(terminal) });
}
