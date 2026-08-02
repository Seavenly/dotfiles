import { spawnSync } from "node:child_process";

import { freezeCanonical } from "./canonical.mjs";

export function createGitRetentionAdapter({ resolveRepository } = {}) {
  if (typeof resolveRepository !== "function") {
    throw new TypeError("Git retention Adapter requires repository resolution");
  }
  return Object.freeze({
    retain({ repository_id: repositoryId, git }) {
      const repository = resolveRepository(repositoryId);
      const observedCommit = gitOutput(repository, ["rev-parse", git.commit_sha]);
      const observedTree = gitOutput(repository, ["rev-parse", `${git.commit_sha}^{tree}`]);
      if (observedCommit !== git.commit_sha || observedTree !== git.tree_sha) {
        throw new Error("Git retention facts do not match repository objects");
      }
      const retentionRef = `refs/flow/retained/${git.commit_sha}`;
      gitOutput(repository, ["update-ref", retentionRef, git.commit_sha]);
      return freezeCanonical({
        schema: "flow.git-retention-receipt/v1",
        repository_id: repositoryId,
        commit_sha: git.commit_sha,
        tree_sha: git.tree_sha,
        retention_ref: retentionRef,
      });
    },

    observe(receipt) {
      try {
        const repository = resolveRepository(receipt.repository_id);
        const commit = gitOutput(repository, ["rev-parse", receipt.retention_ref]);
        const tree = gitOutput(repository, ["rev-parse", `${receipt.retention_ref}^{tree}`]);
        return freezeCanonical({
          schema: "flow.git-retention-observation/v1",
          available: commit === receipt.commit_sha && tree === receipt.tree_sha,
          repository_id: receipt.repository_id,
          commit_sha: commit,
          tree_sha: tree,
          retention_ref: receipt.retention_ref,
        });
      } catch {
        return unavailableGitRetentionObservation(receipt);
      }
    },
  });
}

export function createGitWorkspaceObservationAdapter() {
  return Object.freeze({
    observe({ workspace_path: workspacePath, ref }) {
      const commitSha = gitOutput(workspacePath, ["rev-parse", "HEAD"]);
      const treeSha = gitOutput(workspacePath, ["rev-parse", "HEAD^{tree}"]);
      const resolvedRef = gitOutput(workspacePath, ["symbolic-ref", "HEAD"]);
      const clean = gitOutput(workspacePath, ["status", "--porcelain"]) === "";
      if (resolvedRef !== ref) {
        throw new Error("workspace Git ref does not match the observed checkout");
      }
      return freezeCanonical({
        schema: "work.git-observation/v1",
        git: {
          commit_sha: commitSha,
          tree_sha: treeSha,
          ref: resolvedRef,
          clean,
        },
      });
    },
  });
}

export function createFailClosedGitWorkspaceObservationAdapter() {
  return Object.freeze({
    observe() {
      throw new Error("workspace Git observation Adapter is unavailable");
    },
  });
}

export function createFailClosedGitRetentionAdapter() {
  return Object.freeze({
    retain() {
      throw new Error("Git retention Adapter is unavailable");
    },
    observe(receipt) {
      return unavailableGitRetentionObservation(receipt);
    },
  });
}

function unavailableGitRetentionObservation(receipt = {}) {
  return freezeCanonical({
    schema: "flow.git-retention-observation/v1",
    available: false,
    repository_id: receipt.repository_id ?? null,
    commit_sha: null,
    tree_sha: null,
    retention_ref: receipt.retention_ref ?? null,
  });
}

function gitOutput(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Git retention operation failed");
  }
  return result.stdout.trim();
}
