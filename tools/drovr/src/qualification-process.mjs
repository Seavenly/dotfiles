import { spawn } from "node:child_process";

export const CLEANUP_LIMIT_MS = 65_000;
export const PROCESS_EXIT_GRACE_MS = CLEANUP_LIMIT_MS + 5_000;

const PROCESS_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const activeProcesses = new Set();
const terminatingProcesses = new Map();

export function interruptProcesses() {
  for (const child of activeProcesses) terminateProcess(child);
}

export function runProcess(
  command,
  args,
  { cwd, env, timeoutMs, terminationGraceMs = PROCESS_EXIT_GRACE_MS },
) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeProcesses.add(child);
    const output = { stdout: [], stderr: [] };
    const outputBytes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let settled = false;
    const started = Date.now();
    const append = (key, chunk) => {
      const remaining = PROCESS_OUTPUT_LIMIT_BYTES - outputBytes[key];
      if (remaining <= 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = bytes.subarray(0, remaining);
      output[key].push(retained);
      outputBytes[key] += retained.length;
    };
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      activeProcesses.delete(child);
      clearProcessTermination(child);
      resolveResult({
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        elapsedMs: Date.now() - started,
        ...(error
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      });
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child, terminationGraceMs);
    }, timeoutMs);
  });
}

function terminateProcess(child, graceMs = PROCESS_EXIT_GRACE_MS) {
  if (terminatingProcesses.has(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const killTimer = setTimeout(() => {
    terminatingProcesses.delete(child);
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited after the graceful termination request.
    }
  }, graceMs);
  terminatingProcesses.set(child, killTimer);
}

function clearProcessTermination(child) {
  const killTimer = terminatingProcesses.get(child);
  if (killTimer) clearTimeout(killTimer);
  terminatingProcesses.delete(child);
}
