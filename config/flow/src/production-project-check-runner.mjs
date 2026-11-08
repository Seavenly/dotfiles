import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";
import { validProjectCheckBinding } from "../../../tools/flow/src/project-check.mjs";
import { validateProjectCheck, projectInputDigest, projectCheckError, createProjectCheckWorkspaceSnapshot, assertProjectReadPath } from "./production-project-check.mjs";

const worker = fileURLToPath(new URL("./production-project-check-worker.py", import.meta.url));
const implementation = fileURLToPath(import.meta.url);
const descriptor = fileURLToPath(new URL("./production-project-check.mjs", import.meta.url));
const python = "/usr/bin/python3";
const sandbox = "/usr/bin/bwrap";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const failure = code => { throw projectCheckError(code); };
const intentIdentity = ({ authority_epoch: _epoch, authority_boot_id: _boot, ...identity }) => identity;
function sync(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durable(root, name, value) {
  const temporary = join(root, `${name}.${randomUUID()}.new`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(root, name)); sync(root);
}
export function projectCheckRunnerIdentity() {
  if (process.platform !== "linux") return failure("project_check_unavailable");
  const version = execFileSync(sandbox, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 2000, maxBuffer: 4096 }).toString().trim();
  if (version !== "bubblewrap 0.11.1") return failure("project_check_unavailable");
  return freezeCanonical({ schema: "flow.project-check-runner/v2", scratch_bytes: 512 * 1024 * 1024, temporary_bytes: 64 * 1024 * 1024, version_timeout_ms: 5000, contract: "linux-bwrap-explicit-readonly-project/v2",
    python: { path: realpathSync(python), sha256: hash(readFileSync(python)) },
    sandbox: { path: sandbox, version, sha256: hash(readFileSync(sandbox)) },
    worker: { path: worker, sha256: hash(readFileSync(worker)) },
    implementation: { path: implementation, sha256: hash(readFileSync(implementation)) }, descriptor: { path: descriptor, sha256: hash(readFileSync(descriptor)) } });
}
function alive(owner) {
  try {
    const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === owner.start &&
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === owner.boot;
  } catch { return false; }
}
function canonicalAuthority(path) {
  const remaining = [];
  let parent = path;
  while (!existsSync(parent)) {
    remaining.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) return failure("project_check_unavailable");
    parent = next;
  }
  return join(realpathSync(parent), ...remaining);
}
/** One immutable effect reservation; an uncertain reservation is never dispatched again. */
export function createProjectCheckRunner({ authorityDirectory }) {
  const base = typeof authorityDirectory === "string" && resolve(authorityDirectory) === authorityDirectory ? join(canonicalAuthority(authorityDirectory), "project-checks-v2") : null;
  const rootFor = intent => join(base, digest({ effect_id: intent.effect_id, idempotency_key: intent.idempotency_key }).slice(7));
  function reserved(intent) {
    if (base === null) return failure("project_check_unavailable");
    const root = rootFor(intent);
    if (!existsSync(join(root, "reservation.json"))) return null;
    const reservation = JSON.parse(readFileSync(join(root, "reservation.json"), "utf8"));
    const { reservation_digest, ...identity } = reservation;
    if (digest(identity) !== reservation_digest || digest(intentIdentity(intent)) !== reservation.intent_digest) return failure("project_check_evidence_conflict");
    return { root, reservation };
  }
  function read(intent) {
    const found = reserved(intent);
    if (!found) return null;
    const { root, reservation } = found;
    if (!existsSync(join(root, "terminal.json"))) return failure("project_check_outcome_unknown");
    const terminal = JSON.parse(readFileSync(join(root, "terminal.json"), "utf8"));
    const { self_digest, ...value } = terminal;
    if (hash(Buffer.from(JSON.stringify(value))) !== self_digest || terminal.reservation_digest !== reservation.reservation_digest ||
        terminal.retired !== true || terminal.proof !== "linux_subreaper_echild" || !["passed", "failed", "timeout", "output_limit", "cancelled", "environment_failure"].includes(terminal.outcome) ||
        terminal.outcome === "passed" && (terminal.exit_code !== 0 || terminal.version !== reservation.binding.registration.version) ||
        !terminal.owner || !Number.isSafeInteger(terminal.owner.pid) ||
        hash(readFileSync(join(root, "command.stdout"))) !== terminal.stdout_sha256 || hash(readFileSync(join(root, "command.stderr"))) !== terminal.stderr_sha256 ||
        hash(readFileSync(join(root, "version.stdout"))) !== terminal.version_stdout_sha256 || hash(readFileSync(join(root, "version.stderr"))) !== terminal.version_stderr_sha256) return failure("project_check_evidence_conflict");
    const witness = JSON.parse(readFileSync(join(root, "worker.json"), "utf8"));
    if (digest(witness.owner) !== digest(terminal.owner) || witness.reservation_digest !== reservation.reservation_digest) return failure("project_check_evidence_conflict");
    sync(root);
    return { root, reservation, terminal };
  }
  async function wait(intent, found) {
    const deadline = Date.now() + found.reservation.binding.registration.limits.timeout_ms * 2 + 10000;
    // A newly spawned worker may not yet have durably announced its identity.
    const startupDeadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(join(found.root, "terminal.json"))) return read(intent);
      if (existsSync(join(found.root, "worker.json"))) {
        const witness = JSON.parse(readFileSync(join(found.root, "worker.json"), "utf8"));
        if (witness.reservation_digest !== found.reservation.reservation_digest) return failure("project_check_outcome_unknown");
        if (!alive(witness.owner)) {
          if (existsSync(join(found.root, "terminal.json"))) return read(intent);
          return failure("project_check_outcome_unknown");
        }
      } else if (Date.now() > startupDeadline) return failure("project_check_outcome_unknown");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return failure("project_check_outcome_unknown");
  }
  return Object.freeze({ read,
    async waitExisting(intent) {
      const found = reserved(intent);
      if (!found) return failure("project_check_outcome_unknown");
      if (existsSync(join(found.root, "terminal.json"))) return read(intent);
      return wait(intent, found);
    },
    async run(intent, workspace, binding) {
      if (base === null || process.platform !== "linux" || !validProjectCheckBinding(binding)) return failure("project_check_unavailable");
      validateProjectCheck(binding.registration);
      const previous = reserved(intent);
      if (previous) {
        if (digest(previous.reservation.binding) !== digest(binding) || previous.reservation.source_workspace !== workspace.path) return failure("project_check_evidence_conflict");
        if (existsSync(join(previous.root, "terminal.json"))) return read(intent);
        return wait(intent, previous);
      }
      if (digest(projectCheckRunnerIdentity()) !== digest(binding.runner)) return failure("project_check_input_drift");
      if (realpathSync(workspace.path) !== resolve(workspace.path) || !lstatSync(workspace.path).isDirectory()) return failure("project_check_input_drift");
      for (const mount of binding.registration.read_mounts) assertProjectReadPath(mount.source, { authorityDirectory });
      for (const input of [...binding.registration.read_mounts.map(mount => ({ path: mount.source, sha256: mount.sha256 })), binding.registration.executable,
        ...binding.registration.pinned_files.map(file => ({ path: join(workspace.path, file.path), sha256: file.sha256 }))]) {
        if (projectInputDigest(input.path) !== input.sha256) return failure("project_check_input_drift");
      }
      mkdirSync(base, { recursive: true, mode: 0o700 }); sync(base); sync(dirname(base));
      const root = rootFor(intent);
      try { mkdirSync(root, { mode: 0o700 }); } catch { return failure("project_check_outcome_unknown"); }
      sync(base);
      const snapshot = createProjectCheckWorkspaceSnapshot(workspace.path, join(root, "workspace"));
      // bwrap cannot create child mountpoints after making the candidate root
      // read-only. Empty directories are not candidate content and are created
      // only for explicitly validated ignored dependency mounts.
      for (const mount of binding.registration.read_mounts) {
        if (!mount.target.startsWith("/workspace/")) continue;
        const target = join(snapshot.path, mount.target.slice("/workspace/".length));
        mkdirSync(target, { recursive: true, mode: 0o700 });
        if (realpathSync(target) !== target) return failure("project_check_input_drift");
      }
      const identity = { schema: "flow.project-check-reservation/v2", intent: intentIdentity(intent), intent_digest: digest(intentIdentity(intent)), binding,
        authority_directory: realpathSync(authorityDirectory), source_workspace: workspace.path, source_commit: snapshot.commit_sha, source_tree: snapshot.tree_sha, workspace: snapshot.path, workspace_digest: projectInputDigest(snapshot.path) };
      const reservation = { ...identity, reservation_digest: digest(identity) };
      durable(root, "reservation.json", reservation);
      const child = spawn(binding.runner.python.path, ["-I", "-S", worker, root], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      child.on("error", () => {}); child.unref();
      return wait(intent, { root, reservation });
    },
    requestCancellation({ run_id, effect_id }) {
      if (base === null || typeof run_id !== "string" || typeof effect_id !== "string" || !existsSync(base)) return false;
      let matched = false;
      for (const name of readdirSync(base)) {
        if (!/^[a-f0-9]{64}$/u.test(name)) continue;
        const root = join(base, name);
        if (!existsSync(join(root, "reservation.json"))) continue;
        const reservation = JSON.parse(readFileSync(join(root, "reservation.json"), "utf8"));
        const { reservation_digest, ...identity } = reservation;
        if (digest(identity) !== reservation_digest) return failure("project_check_evidence_conflict");
        if (reservation.intent.run_id !== run_id || reservation.intent.effect_id !== effect_id || existsSync(join(root, "terminal.json"))) continue;
        // Share terminal-publication exclusion with the worker: an accepted
        // marker cannot arrive between its last cancellation read and rename.
        const lock = join(root, "publication.lock");
        try { mkdirSync(lock, { mode: 0o700 }); } catch { return failure("project_check_outcome_unknown"); }
        try {
          if (existsSync(join(root, "terminal.json"))) continue;
          const marker = { run_id, effect_id, reservation_digest };
          if (!existsSync(join(root, "cancel.json"))) durable(root, "cancel.json", marker);
          else if (digest(JSON.parse(readFileSync(join(root, "cancel.json"), "utf8"))) !== digest(marker)) return failure("project_check_evidence_conflict");
          matched = true;
        } finally { rmdirSync(lock); sync(root); }
      }
      return matched;
    },
  });
}
