import { validateCompletedAttempt } from "./attempt-validator.mjs";
import {
  resolveGateRuntime,
  validateDeclaredOutputs,
  writeJsonAtomically,
} from "./gate-runtime.mjs";
import { validateContract } from "./schema-validator.mjs";

export async function executeHandoffValidationGate({
  adapter,
  sealedGate,
  now = () => new Date(),
}) {
  const { gate, manifest, taskAuthority } = sealedGate;
  if (gate.kind !== "handoff-validation") {
    throw new Error(
      `unsupported gate kind for handoff validation: ${gate.kind}`,
    );
  }
  if (
    typeof taskAuthority.producerTaskId !== "string" ||
    taskAuthority.producerTaskId.length === 0
  ) {
    throw new Error("handoff-validation gate is not bound to a producer task");
  }
  if (gate.outputs.length !== 1) {
    throw new Error("handoff-validation gate must declare one evidence output");
  }

  return withGateTimeout(gate.timeout_seconds, async (signal, commit) => {
    const runtime = await resolveGateRuntime(gate, manifest);
    throwIfAborted(signal);
    const completed = await adapter.getTerminalCompletedAttempt({
      taskId: taskAuthority.producerTaskId,
      signal,
    });
    const validation = await validateCompletedAttempt({
      adapter,
      taskId: taskAuthority.producerTaskId,
      stage: gate.handoff_validation.producer_stage,
      attempt: completed.attempt,
      requirePassed: gate.handoff_validation.require_passed,
      expectedRunAuthority: taskAuthority,
      now,
      signal,
    });
    if (!(await validateContract(validation)).valid) {
      throw new Error("handoff validation does not satisfy its evidence contract");
    }
    throwIfAborted(signal);
    const outputPath = runtime.outputPathByDeclaration.get(gate.outputs[0]);
    await writeJsonAtomically(outputPath, validation, {
      signal,
      beforePublish: commit,
    });
    await validateDeclaredOutputs(runtime);
    return {
      passed: validation.valid,
      validation,
    };
  });
}

async function withGateTimeout(timeoutSeconds, operation) {
  const controller = new AbortController();
  const timeoutError = new Error(
    `handoff-validation gate timed out after ${timeoutSeconds}s`,
  );
  let timer;
  let committed = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (committed) return;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutSeconds * 1000);
  });
  const commit = () => {
    throwIfAborted(controller.signal);
    committed = true;
    clearTimeout(timer);
  };
  try {
    return await Promise.race([
      operation(controller.signal, commit),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason;
}
