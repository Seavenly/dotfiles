import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { canonicalize, digest, freezeCanonical } from "./canonical.mjs";
import { digestDelegateInputBytes } from "./delegate-input-envelope.mjs";
import { directDescriptionIssue } from "./execution-contract.mjs";
import { executableIdentity } from "./direct-delegated-agent-port.mjs";

const pythonPath = "/usr/bin/python3";
const workerPath = fileURLToPath(new URL("./direct-task-worker.py", import.meta.url));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hashBytes = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const keyDigest = (key) => hashBytes(Buffer.from(key)).slice(7);

export function createDirectTaskPort({ taskDirectory, env, adapters, resolveWorkspace }) {
  const directory = (id) => {
    if (typeof id !== "string" || !/^task:[0-9a-f]{64}$/u.test(id)) throw new TypeError("invalid_task_identity");
    return join(taskDirectory, id.slice(5));
  };
  const observe = (id) => taskObservation(directory(id), id, adapters);
  return Object.freeze({
    async discover(request) {
      if (typeof request?.caller_key !== "string" || !request.caller_key) return blocked("invalid_discovery_request");
      const issue = directDescriptionIssue(request.description);
      if (issue) return blocked(issue);
      const adapter = adapters[request.description.backend.harness];
      if (adapter?.id !== request.description.backend.adapter || adapter.version !== request.description.backend.adapter_version) return blocked("adapter_identity_changed");
      const id = `task:${keyDigest(request.caller_key)}`;
      // Only an atomic reservation's exact absence permits the initial spawn.
      if (!existsSync(directory(id))) return { schema: "flow.task-observation/v1", status: "proven_absent", task: null };
      return observe(id);
    },
    async dispatch(request) {
      let root;
      try {
        if (request?.schema !== "flow.delegated-agent-dispatch-request/v1" ||
            typeof request.caller_key !== "string" || !request.caller_key ||
            typeof request.input_key !== "string" || !request.input_key ||
            digestDelegateInputBytes(request.prompt) !== request.payload_sha256) throw new Error("invalid_dispatch_request");
        const issue = directDescriptionIssue(request.description); if (issue) throw new Error(issue);
        const binding = request.task_binding;
        if (!binding || binding.attempt_id !== request.caller_key ||
            !binding.run_id || !binding.card_id || !binding.effect_id || !binding.workspace_claim ||
            !binding.output_contract?.schema || !Array.isArray(binding.output_contract.schemas)) throw new Error("invalid_task_binding");
        const adapter = adapters[request.description.backend.harness];
        if (adapter?.id !== request.description.backend.adapter || adapter.version !== request.description.backend.adapter_version) throw new Error("adapter_identity_changed");
        const id = `task:${keyDigest(request.caller_key)}`;
        root = directory(id);
        const adopt = () => {
          const previous = validatedDescriptor(root);
          if (!previous) return blocked("reservation_outcome_unknown", id);
          const bound = { task_id: previous.task_id, caller_key: previous.caller_key,
            input_key: previous.input_key, input_sha256: previous.input_sha256,
            run_id: previous.run_id, card_id: previous.card_id, attempt_id: previous.attempt_id, effect_id: previous.effect_id,
            description: previous.description, workspace_claim: previous.workspace.claim, output_contract: previous.output_contract };
          const requested = { task_id: id, caller_key: request.caller_key,
            input_key: request.input_key, input_sha256: request.payload_sha256,
            run_id: binding.run_id, card_id: binding.card_id, attempt_id: binding.attempt_id, effect_id: binding.effect_id,
            description: request.description, workspace_claim: binding.workspace_claim, output_contract: binding.output_contract };
          return digest(bound) === digest(requested) ? observe(id) : blocked("caller_key_conflict", id);
        };
        // Recovery uses the immutable reservation, not today's spawn environment
        // or executable. Ambient checks remain mandatory for a new invocation.
        if (existsSync(root)) return adopt();
        const identity = executableIdentity(request.description.backend.executable.path, adapter, env);
        if (digest(identity) !== digest(request.description.backend.executable)) throw new Error("executable_identity_changed");
        if (process.platform !== "linux") throw new Error("direct_task_containment_unsupported");
        // No fallback executable: Python availability and subreaper capability
        // are checked before the reservation can cross the spawn boundary.
        const python = realpathSync(pythonPath);
        execFileSync(python, ["-I", "-S", "-c", "import ctypes,os,signal; p=ctypes.CDLL(None); assert p.prctl(36,1,0,0,0)==0; assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'); fd=os.pidfd_open(os.getpid()); os.close(fd)"], { timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: env.HOME ?? process.env.HOME } });
        const supervision = { executable: python, executable_sha256: hashBytes(readFileSync(python)),
          worker_sha256: hashBytes(readFileSync(workerPath)), args: ["-I", "-S"], signal_identity: "linux_pidfd" };
        const workspace = resolveWorkspace(binding.workspace_claim, { owner: { run_id: binding.run_id, card_id: binding.card_id } });
        if (!workspace?.canonical_path) throw new Error("workspace_claim_uncertain");
        const workspacePath = realpathSync(workspace.canonical_path);
        const authorityIssue = adapter.authorityIssue({ env, workspacePath }); if (authorityIssue) throw new Error(authorityIssue);
        const outputSchemaBytes = JSON.stringify(canonicalize(binding.output_contract.schema));
        const identityInput = {
          schema: "flow.task-invocation/v1", task_id: id, caller_key: request.caller_key,
          input_key: request.input_key, input_sha256: request.payload_sha256,
          run_id: binding.run_id, card_id: binding.card_id, attempt_id: binding.attempt_id, effect_id: binding.effect_id,
          description: request.description, workspace: { path: workspacePath, claim: binding.workspace_claim },
          output_contract: binding.output_contract,
          output_schema_bytes: outputSchemaBytes,
          output_contract_digest: digest(binding.output_contract),
          environment: taskEnvironment(env, join(root, "scratch")),
          supervision, process_containment: "linux_subreaper", retention: "authority_owned_until_explicit_disposition",
        };
        const invocation = adapter.buildInvocation({ descriptor: identityInput, taskDirectory: root });
        const descriptorIdentity = { ...identityInput, invocation };
        const descriptor = freezeCanonical({ ...descriptorIdentity, descriptor_digest: digest(descriptorIdentity) });
        ensurePrivateDirectory(taskDirectory);
        try { mkdirSync(root, { mode: 0o700 }); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          return adopt();
        }
        // Publish the reservation itself, not only files inside it, before
        // any worker can cross the native invocation boundary.
        syncDirectory(taskDirectory);
        atomicJson(root, "descriptor.json", descriptor);
        durableBytes(root, "input.bin", Buffer.from(request.prompt));
        durableBytes(root, "output-schema.json", Buffer.from(outputSchemaBytes));
        mkdirSync(join(root, "scratch"), { mode: 0o700 });
        const errorFd = openSync(join(root, "worker-errors.bin"), "wx", 0o600);
        let worker;
        try {
          syncDirectory(root);
          worker = spawn(python, ["-I", "-S", workerPath, root], { detached: true, stdio: ["ignore", "ignore", errorFd], env: taskEnvironment(env, join(root, "scratch")) });
        }
        finally { closeSync(errorFd); }
        worker.on("error", () => {}); worker.unref();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const current = observe(id);
          if (current.status === "completed" || current.status === "cancelled" || current.task?.process?.stage === "running") return current;
          if (existsSync(join(root, "failure.json"))) return current;
          await pause(10);
        }
        return blocked("worker_handshake_unknown", id);
      } catch (error) {
        return blocked(/^[a-z_]+$/u.test(error.message) ? error.message : "task_dispatch_failed");
      }
    },
    async observe(request) { return observe(request.turn_id); },
    async wait(request) {
      if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0 || request.timeout_ms > 300_000) return blocked("invalid_wait_request");
      const end = Date.now() + request.timeout_ms;
      do {
        const current = observe(request.turn_id);
        if (current.status !== "still_running") return current;
        await pause(Math.min(20, Math.max(1, end - Date.now())));
      } while (Date.now() < end);
      return observe(request.turn_id);
    },
    async reconcile(request) { return this.wait(request); },
    async cancel(request) {
      const root = directory(request.turn_id);
      const descriptor = validatedDescriptor(root);
      if (!descriptor) return blocked("task_identity_unknown", request.turn_id);
      const current = observe(request.turn_id);
      if (current.task?.receipt?.tree_retired === true) return current;
      if (current.status !== "still_running") return current;
      if (current.task.descriptor_digest !== descriptor.descriptor_digest || !workerBindingMatches(current.task.process, descriptor)) return blocked("worker_binding_conflict", request.turn_id);
      if (!processMatches(current.task?.process?.identity)) return blocked("process_identity_uncertain", request.turn_id);
      // The owner signals no PID. The verified worker reads the durable exact
      // intent and signals only its currently owned descendants.
      atomicJson(root, "cancel.json", { schema: "flow.task-cancellation/v1", descriptor_digest: descriptor.descriptor_digest });
      return this.wait({ ...request, timeout_ms: 3000 });
    },
    async retire(request) {
      const current = observe(request.turn_id);
      return current.task?.receipt?.tree_retired === true
        ? { ...current, status: "retired" } : blocked("task_retirement_uncertain", request.turn_id);
    },
  });
}
function taskObservation(root, id, adapters) {
  const descriptor = validatedDescriptor(root);
  if (!descriptor) return blocked("reservation_outcome_unknown", id);
  const process = readJson(join(root, "worker.json"));
  const task = { id, descriptor_digest: descriptor.descriptor_digest, descriptor, process, receipt: null, result: null };
  if (!workerBindingMatches(process, descriptor)) return blocked("worker_binding_conflict", id, task);
  const receipt = readJson(join(root, "receipt.json"));
  if (receipt) {
    try {
      const stdout = readFileSync(join(root, "stdout.bin"));
      const stderr = readFileSync(join(root, "stderr.bin"));
      if (receipt.schema !== "flow.task-terminal-receipt/v1" || receipt.descriptor_digest !== descriptor.descriptor_digest ||
          receipt.input_sha256 !== descriptor.input_sha256 || hashBytes(stdout) !== receipt.stdout_sha256 ||
          hashBytes(stderr) !== receipt.stderr_sha256 || receipt.tree_retired !== true ||
          digest(receipt.worker_identity) !== digest(process?.identity) || digest(receipt.child_identity) !== digest(process?.child)) throw new Error("terminal_receipt_conflict");
      task.receipt = receipt;
      if (receipt.cancelled) return freezeCanonical({ schema: "flow.task-observation/v1", status: "cancelled", task });
      const adapter = adapters[descriptor.description.backend.harness];
      const parsed = adapter.parseTerminal({ descriptor, stdout: stdout.toString("utf8"),
        lastMessage: existsSync(join(root, "last-message.json")) ? readFileSync(join(root, "last-message.json"), "utf8") : null,
        exitCode: receipt.exit_code });
      const validate = new Ajv({ strict: false }).compile(descriptor.output_contract.schema);
      if (!validate(JSON.parse(parsed.output))) throw new Error("structured_output_invalid");
      task.result = { text: JSON.stringify(canonicalize(JSON.parse(parsed.output))), native_session: parsed.native_session };
      const proofIdentity = { schema: "flow.task-settlement-proof/v1", classification: "exact_task_correlation",
        descriptor_digest: descriptor.descriptor_digest, input_sha256: descriptor.input_sha256,
        output_contract_digest: descriptor.output_contract_digest, stdout_sha256: receipt.stdout_sha256,
        terminal_receipt_digest: digest(receipt), native_session: parsed.native_session };
      task.settlement_proof = { ...proofIdentity, record_sha256: digest(proofIdentity) };
      return freezeCanonical({ schema: "flow.task-observation/v1", status: "completed", task });
    } catch (error) {
      return freezeCanonical({ schema: "flow.task-observation/v1", status: "quarantined", reason: { code: /^[a-z_]+$/u.test(error.message) ? error.message : "terminal_output_invalid" }, task });
    }
  }
  if (readJson(join(root, "failure.json"))) return blocked("task_outcome_uncertain", id, task);
  return processMatches(process?.identity) && process?.stage === "running"
    ? freezeCanonical({ schema: "flow.task-observation/v1", status: "still_running", task }) : blocked("process_identity_uncertain", id, task);
}
function validatedDescriptor(root) {
  try { checkPrivateDirectory(root); } catch { return null; }
  const descriptor = readJson(join(root, "descriptor.json")); if (!descriptor) return null;
  const { descriptor_digest: expected, ...identity } = descriptor;
  try { return digest(identity) === expected && hashBytes(readFileSync(join(root, "input.bin"))) === descriptor.input_sha256 ? descriptor : null; } catch { return null; }
}
function workerBindingMatches(record, descriptor) {
  return record?.schema === "flow.task-process/v1" &&
    record.descriptor_digest === descriptor.descriptor_digest &&
    descriptor.process_containment === "linux_subreaper" && record.containment === descriptor.process_containment;
}
function processMatches(identity) {
  if (!identity || process.platform !== "linux") return false;
  try {
    const text = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return identity.boot === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() &&
      identity.start === fields[19] && identity.group === Number(fields[2]) && fields[0] !== "Z";
  } catch { return false; }
}
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function blocked(code, id = null, task = null) { return { schema: "flow.task-observation/v1", status: "blocked", reason: { code }, ...(id ? { task: task ?? { id } } : {}) }; }
function durableBytes(root, name, bytes) {
  const fd = openSync(join(root, name), "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(root, "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
function syncDirectory(path) {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicJson(root, name, value) {
  const temp = name + ".new"; durableBytes(root, temp, Buffer.from(JSON.stringify(canonicalize(value)))); renameSync(join(root, temp), join(root, name));
  const fd = openSync(root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function taskEnvironment(env, scratch) {
  // Authentication stays native; no configuration is copied and no auth file
  // is read. Provider transport environment is retained only inside private
  // task storage, never in public receipt or prompt projections.
  return { PATH: env.PATH ?? process.env.PATH, HOME: env.HOME ?? process.env.HOME,
    ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}), TMPDIR: scratch,
 };
}

function ensurePrivateDirectory(path) {
  const parts = [];
  for (let current = path; dirname(current) !== current; current = dirname(current)) parts.unshift(current);
  for (const part of parts) {
    if (existsSync(part) && (!lstatSync(part).isDirectory() || lstatSync(part).isSymbolicLink())) throw new Error("task_directory_untrusted");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  checkPrivateDirectory(path);
  // An existing directory may remain after a prior failed publication. Sync
  // the full hierarchy so a later dispatch cannot rely on that uncertain entry.
  for (const part of parts) syncDirectory(dirname(part));
}
function checkPrivateDirectory(path) {
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("task_directory_untrusted");
  }
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("task_directory_untrusted");
}
