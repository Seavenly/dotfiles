import { spawnSync } from "node:child_process";

import { freezeCanonical } from "./canonical.mjs";

const GIT_TIMEOUT_MS = 10_000;

export function createGitRetentionAdapter({ resolveRepository } = {}) {
  if (typeof resolveRepository !== "function") {
    throw new TypeError("Git retention Adapter requires repository resolution");
  }
  return Object.freeze({
    retain({ repository_id: repositoryId, git }) {
      if (!nonEmpty(repositoryId) || !validObjectId(git?.commit_sha) ||
          !validObjectId(git?.tree_sha)) {
        throw new TypeError("Git retention requires exact object identities");
      }
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
        if (!nonEmpty(receipt?.repository_id) ||
            !validObjectId(receipt?.commit_sha) ||
            !validObjectId(receipt?.tree_sha) ||
            receipt.retention_ref !==
              `refs/flow/retained/${receipt.commit_sha}`) {
          throw new TypeError("Git retention receipt is not canonical");
        }
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
      const resolvedRef = gitOptionalOutput(
        workspacePath,
        ["symbolic-ref", "HEAD"],
      ) ?? "HEAD";
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
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Git retention operation failed");
  }
  return result.stdout.trim();
}

function gitOptionalOutput(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function validObjectId(value) {
  return /^[0-9a-f]{40,64}$/u.test(value ?? "");
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}
