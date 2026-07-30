import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      const { stdout: recordedStdout } = await execFileAsync(
        "git",
        ["rev-parse", `${inventory.source_commit}:${component.source_path}`],
        { cwd: repositoryRoot },
      );
      const { stdout: currentStdout } = await execFileAsync(
        "git",
        ["rev-parse", `HEAD:${component.source_path}`],
        { cwd: repositoryRoot },
      );
      const { stdout: statusStdout } = await execFileAsync(
        "git",
        [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--",
          component.source_path,
        ],
        { cwd: repositoryRoot },
      );
      const recordedGitObject = recordedStdout.trim();
      const currentGitObject = currentStdout.trim();
      const workingTreeClean = statusStdout.trim() === "";
      components.push({
        source_path: component.source_path,
        expected_git_object: component.git_object,
        recorded_git_object: recordedGitObject,
        current_git_object: currentGitObject,
        working_tree_clean: workingTreeClean,
        status: recordedGitObject === component.git_object &&
            currentGitObject === component.git_object && workingTreeClean
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
      status: components.every(({ status }) => status === "passed")
        ? "passed"
        : "failed",
    });
  }

  return {
    schema: "flow.legacy-baseline-audit/v1",
    source_commit: inventory.source_commit,
    baselines,
  };
}
