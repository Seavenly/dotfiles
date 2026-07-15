import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { loadSealedGate } from "./run-bundle-validator.mjs";
import { validateContract } from "./schema-validator.mjs";

export async function executeCommandGate({
  adapter,
  gateSpecPath,
  taskId,
  inheritedEnv = process.env,
  runCommand = defaultRunCommand,
}) {
  const authority = await loadSealedGate({
    adapter,
    taskId,
    requestedGateSpecPath: gateSpecPath,
  });
  if (!authority.valid) {
    throw new Error(authority.errors[0]?.message ?? "gate authority is invalid");
  }

  const { gate, manifest } = authority;
  if (gate.kind !== "command") {
    throw new Error(`unsupported gate kind for command execution: ${gate.kind}`);
  }
  const runtime = await resolveRuntimeGate(gate, manifest);

  const results = [];
  const deadline = Date.now() + gate.timeout_seconds * 1000;
  for (const [index, command] of gate.commands.entries()) {
    const timeoutMilliseconds = deadline - Date.now();
    const runtimeCommand = { ...command, cwd: runtime.workspace };
    let result;
    if (timeoutMilliseconds > 0) {
      result = await runCommand(runtimeCommand, {
        env: { ...inheritedEnv, ...(command.env ?? {}) },
        timeoutMilliseconds,
      });
    } else {
      result = {
        exitCode: 1,
        termination: "timeout",
        stdout: "",
        stderr: "gate timeout exceeded before command execution",
      };
    }
    const evidence = {
      schema: "agent-flow.command-result/v1",
      run_id: gate.run_id,
      stage: gate.stage,
      gate_name: gate.name,
      gate_version: gate.version,
      command_index: index,
      argv: command.argv,
      cwd: command.cwd,
      termination: result.termination,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (!(await validateContract(evidence)).valid) {
      throw new Error("command result does not satisfy its evidence contract");
    }
    await writeJsonAtomically(runtime.outputPaths[index], evidence);
    results.push(evidence);
    if (result.termination !== "exit" || result.exitCode !== 0) break;
  }
  const passed = results.length === gate.commands.length &&
    results.every(({ exit_code: exitCode, termination }) =>
      termination === "exit" && exitCode === 0
    );
  if (passed) await validateDeclaredOutputs(runtime);
  return {
    passed,
    results,
  };
}

async function resolveRuntimeGate(gate, manifest) {
  const runDirectory = await resolveExisting(
    manifest.identity.run_directory,
    "run directory",
  );
  const repository = await resolveExisting(
    manifest.identity.repository.path,
    "repository root",
  );
  const approvedReadRoots = await resolveAll(
    manifest.approved_read_roots,
    "approved read root",
  );
  if (
    approvedReadRoots.some((root) =>
      !pathIsWithin(runDirectory, root) && !pathIsWithin(repository, root)
    )
  ) {
    throw new Error(
      "approved read root resolves outside run or repository roots",
    );
  }
  const readRoots = await resolveAll(gate.read_roots, "gate read root");
  for (const root of readRoots) {
    if (approvedReadRoots.some((approved) => pathIsWithin(approved, root))) {
      continue;
    }
    throw new Error("gate read root resolves outside approved read roots");
  }

  const workspace = await resolveExisting(gate.workspace, "workspace");
  if (!readRoots.some((root) => pathIsWithin(root, workspace))) {
    throw new Error("workspace resolves outside read roots");
  }
  for (const input of gate.inputs) {
    const resolvedInput = await resolveExisting(input, "gate input");
    if (readRoots.some((root) => pathIsWithin(root, resolvedInput))) continue;
    throw new Error("gate input resolves outside read roots");
  }

  const artifactDirectory = await resolveExisting(
    manifest.identity.artifact_directory,
    "artifact directory",
  );
  if (artifactDirectory !== join(runDirectory, "artifacts")) {
    throw new Error(
      "artifact directory must resolve to canonical run artifacts directory",
    );
  }
  const approvedArtifactRoots = await resolveAll(
    manifest.approved_artifact_roots,
    "approved artifact root",
  );
  if (
    approvedArtifactRoots.some((root) =>
      !pathIsWithin(artifactDirectory, root)
    )
  ) {
    throw new Error(
      "approved artifact root resolves outside artifact directory",
    );
  }
  const writeRoot = await resolveExisting(gate.write_root, "gate write root");
  if (!approvedArtifactRoots.some((root) => pathIsWithin(root, writeRoot))) {
    throw new Error("gate write root resolves outside approved artifact roots");
  }

  const declaredOutputPaths = new Map();
  for (const output of gate.outputs) {
    const outputParent = await resolveExisting(
      dirname(output),
      "gate output parent",
    );
    if (!pathIsWithin(writeRoot, outputParent)) {
      throw new Error("gate output resolves outside write root");
    }
    const resolvedPath = join(outputParent, basename(output));
    await validateExistingOutput(resolvedPath, writeRoot);
    declaredOutputPaths.set(output, resolvedPath);
  }
  return {
    workspace,
    writeRoot,
    declaredOutputPaths: [...declaredOutputPaths.values()],
    outputPaths: gate.commands.map(({ output_path: outputPath }) =>
      declaredOutputPaths.get(outputPath)
    ),
  };
}

async function validateExistingOutput(output, writeRoot) {
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let resolvedOutput;
  try {
    resolvedOutput = await realpath(output);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`existing gate output is a dangling symlink: ${output}`);
    }
    throw error;
  }
  if (!pathIsWithin(writeRoot, resolvedOutput)) {
    throw new Error("existing gate output resolves outside write root");
  }
}

async function validateDeclaredOutputs({ declaredOutputPaths, writeRoot }) {
  for (const output of declaredOutputPaths) {
    let resolvedOutput;
    try {
      resolvedOutput = await realpath(output);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`declared gate output is missing: ${output}`);
      }
      throw error;
    }
    if (!pathIsWithin(writeRoot, resolvedOutput)) {
      throw new Error("declared gate output resolves outside write root");
    }
  }
}

async function resolveAll(paths, description) {
  return Promise.all(paths.map((path) => resolveExisting(path, description)));
}

async function resolveExisting(path, description) {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(`${description} is not accessible: ${path}`, {
      cause: error,
    });
  }
}

function pathIsWithin(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate))
  );
}

function defaultRunCommand(command, { env, timeoutMilliseconds }) {
  return new Promise((resolve) => {
    const maxBufferBytes = 10 * 1024 * 1024;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimit = null;
    let spawnError = null;
    let timer;
    const child = spawn(
      command.argv[0],
      command.argv.slice(1),
      {
        cwd: command.cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBufferBytes) stdoutChunks.push(chunk);
      else stopForOutputLimit("stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBufferBytes) stderrChunks.push(chunk);
      else stopForOutputLimit("stderr");
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killProcessGroup(child);
      const termination = classifyTermination({
        timedOut,
        outputLimit,
        spawnError,
        signal,
      });
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        exitCode: Number.isInteger(code) ? code : 1,
        termination,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderr || terminationMessage(
          termination,
          timeoutMilliseconds,
          { outputLimit, signal, spawnError },
        ),
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMilliseconds);

    function stopForOutputLimit(stream) {
      if (outputLimit !== null) return;
      outputLimit = stream;
      killProcessGroup(child);
    }
  });
}

function killProcessGroup(child) {
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") child.kill("SIGKILL");
  }
}

function classifyTermination({ timedOut, outputLimit, spawnError, signal }) {
  if (timedOut) return "timeout";
  if (outputLimit !== null) return "output-limit";
  if (spawnError !== null) return "spawn-error";
  return signal === null ? "exit" : "signal";
}

function terminationMessage(termination, timeoutMilliseconds, details) {
  if (termination === "timeout") {
    return `command timed out after ${timeoutMilliseconds}ms`;
  }
  if (termination === "signal") {
    return `command terminated by ${details.signal}`;
  }
  if (termination === "output-limit") {
    return `${details.outputLimit} exceeded the 10485760-byte limit`;
  }
  return details.spawnError?.message ?? "";
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
