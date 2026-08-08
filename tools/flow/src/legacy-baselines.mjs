import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function auditLegacyBaselines({ repositoryRoot, inventoryPath }) {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (inventory.schema !== "flow.legacy-baseline-inventory/v1") {
    throw new Error("legacy baseline inventory contract is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(inventory.source_commit)) {
    throw new Error("legacy baseline source commit is invalid");
  }

  const baselines = [];
  for (const baseline of inventory.baselines) {
    const components = [];
    for (const component of baseline.components ?? []) {
      assertRepositoryPath(repositoryRoot, component.source_path);
      const recorded = await resolveGitObject({
        repositoryRoot,
        revision: inventory.source_commit,
        sourcePath: component.source_path,
      });
      const current = await resolveGitObject({
        repositoryRoot,
        revision: "HEAD",
        sourcePath: component.source_path,
      });
      const workingTree = await resolveWorkingTreeStatus({
        repositoryRoot,
        sourcePath: component.source_path,
      });
      const recordedGitObject = recorded.gitObject;
      const currentGitObject = current.gitObject;
      const workingTreeClean = workingTree.clean;
      components.push({
        source_path: component.source_path,
        expected_git_object: component.git_object,
        recorded_git_object: recordedGitObject,
        current_git_object: currentGitObject,
        recorded_failure: recorded.failure,
        current_failure: current.failure,
        working_tree_clean: workingTreeClean,
        working_tree_failure: workingTree.failure,
        status: recordedGitObject === component.git_object &&
            currentGitObject === component.git_object
          ? "passed"
          : "failed",
      });
    }
    if (components.length === 0) {
      throw new Error(`legacy baseline has no content components: ${baseline.implementation}`);
    }
    baselines.push({
      implementation: baseline.implementation,
      components,
      working_tree_clean: components.every(({ working_tree_clean }) => working_tree_clean),
      status: components.every(({ status }) => status === "passed")
        ? "passed"
        : "failed",
    });
  }

  return {
    schema: "flow.legacy-baseline-audit/v1",
    source_commit: inventory.source_commit,
    status: baselines.every((baseline) => baseline.status === "passed")
      ? "passed"
      : "failed",
    working_tree_clean: baselines.every((baseline) => baseline.working_tree_clean),
    baselines,
  };
}

async function resolveGitObject({ repositoryRoot, revision, sourcePath }) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", `${revision}:${sourcePath}`],
      { cwd: repositoryRoot },
    );
    return { gitObject: stdout.trim(), failure: null };
  } catch {
    return {
      gitObject: null,
      failure: "unresolved_git_object",
    };
  }
}

async function resolveWorkingTreeStatus({ repositoryRoot, sourcePath }) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", sourcePath],
      { cwd: repositoryRoot },
    );
    return { clean: stdout.trim() === "", failure: null };
  } catch {
    return { clean: false, failure: "unavailable_worktree_status" };
  }
}

function assertRepositoryPath(repositoryRoot, sourcePath) {
  const relativePath = relative(
    resolve(repositoryRoot),
    resolve(repositoryRoot, sourcePath ?? ""),
  );
  if (!sourcePath || relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`legacy baseline component is outside the repository: ${sourcePath}`);
  }
}
