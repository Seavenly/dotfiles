import { spawn } from "node:child_process";

import {
  resolveGateRuntime,
  validateDeclaredOutputs,
  writeJsonAtomically,
} from "./gate-runtime.mjs";
import { validateContract } from "./schema-validator.mjs";

export async function executeCommandGate({
  sealedGate,
  inheritedEnv = process.env,
  runCommand = defaultRunCommand,
}) {
  const { gate, manifest } = sealedGate;
  if (gate.kind !== "command") {
    throw new Error(`unsupported gate kind for command execution: ${gate.kind}`);
  }
  const runtime = await resolveGateRuntime(gate, manifest);
  const outputPaths = gate.commands.map(({ output_path: outputPath }) =>
    runtime.outputPathByDeclaration.get(outputPath)
  );

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
    await writeJsonAtomically(outputPaths[index], evidence);
    results.push(evidence);
  }
  const passed = results.length === gate.commands.length &&
    results.every(({ exit_code: exitCode, termination }) =>
      termination === "exit" && exitCode === 0
    );
  await validateDeclaredOutputs(runtime);
  return {
    passed,
    results,
  };
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
