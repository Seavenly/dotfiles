import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export async function resolveGateRuntime(gate, manifest) {
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
  const inputPathByDeclaration = new Map();
  for (const input of gate.inputs) {
    const resolvedInput = await resolveExisting(input, "gate input");
    if (!readRoots.some((root) => pathIsWithin(root, resolvedInput))) {
      throw new Error("gate input resolves outside read roots");
    }
    inputPathByDeclaration.set(input, resolvedInput);
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

  const outputPathByDeclaration = new Map();
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
    outputPathByDeclaration.set(output, resolvedPath);
  }
  return {
    workspace,
    writeRoot,
    inputPathByDeclaration,
    outputPathByDeclaration,
    declaredOutputPaths: [...outputPathByDeclaration.values()],
  };
}

export async function validateDeclaredOutputs({
  declaredOutputPaths,
  writeRoot,
}) {
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

export async function writeJsonAtomically(
  path,
  value,
  { signal, beforePublish = () => {} } = {},
) {
  return writeFilesAtomically([{ path, bytes: `${JSON.stringify(value, null, 2)}\n` }], {
    signal,
    beforePublish,
  });
}

export async function writeFilesAtomically(
  files,
  { signal, beforePublish = () => {} } = {},
) {
  const pending = files.map(({ path, bytes }) => ({
    path,
    bytes,
    temporaryPath: `${path}.tmp-${process.pid}-${randomUUID()}`,
  }));
  try {
    const writes = await Promise.allSettled(pending.map(({ temporaryPath, bytes }) =>
      writeFile(temporaryPath, bytes, { mode: 0o600, signal })
    ));
    const failedWrite = writes.find(({ status }) => status === "rejected");
    if (failedWrite) throw failedWrite.reason;
    throwIfAborted(signal);
    beforePublish();
    for (const { temporaryPath, path } of pending) {
      await rename(temporaryPath, path);
    }
  } catch (error) {
    await Promise.all(pending.map(({ temporaryPath }) =>
      rm(temporaryPath, { force: true })
    ));
    throw error;
  }
}

export async function withGateTimeout(kind, timeoutSeconds, operation) {
  const controller = new AbortController();
  const timeoutError = new Error(
    `${kind} gate timed out after ${timeoutSeconds}s`,
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
    return await Promise.race([operation(controller.signal, commit), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
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
