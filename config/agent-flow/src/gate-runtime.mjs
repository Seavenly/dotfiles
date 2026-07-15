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
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      signal,
    });
    throwIfAborted(signal);
    beforePublish();
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
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
