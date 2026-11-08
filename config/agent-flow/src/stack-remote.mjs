import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export class GitHubStackRemote {
  async assertRepositoryCoordinate({ expected, repo }) {
    const actual = JSON.parse((await execFile(
      "gh", ["repo", "view", "--json", "nameWithOwner"],
      { cwd: repo, encoding: "utf8" },
    )).stdout).nameWithOwner;
    const origin = await git(repo, "remote", "get-url", "origin");
    const originCoordinate = JSON.parse((await execFile(
      "gh", ["repo", "view", origin, "--json", "nameWithOwner"],
      { cwd: repo, encoding: "utf8" },
    )).stdout).nameWithOwner;
    if (
      actual.toLowerCase() !== expected.toLowerCase() ||
      originCoordinate.toLowerCase() !== expected.toLowerCase()
    ) {
      throw new Error(
        `repository selection ${actual} and origin ${originCoordinate} must both equal sealed coordinate ${expected}`,
      );
    }
  }

  async assertTargetRef({ expectedSha, ref, repo }) {
    const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const output = await git(repo, "ls-remote", "--refs", "origin", fullRef);
    const matches = output.split("\n").filter(Boolean);
    if (matches.length !== 1 || matches[0].split(/\s+/)[0] !== expectedSha) {
      throw new Error(`remote target ${fullRef} moved from its approved SHA`);
    }
  }

  async pushBranch({ branch, expectedSha, repo }) {
    const actual = await git(repo, "rev-parse", `refs/heads/${branch}^{commit}`);
    if (actual !== expectedSha) throw new Error(`branch ${branch} moved before push`);
    await execFile("git", ["-C", repo, "push", "--set-upstream", "origin", branch], {
      encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    });
  }

  async createPullRequest({ base, body, draft, head, title, repo = null }) {
    const options = repo ? { cwd: repo, encoding: "utf8" } : { encoding: "utf8" };
    const existing = JSON.parse((await execFile("gh", [
      "pr", "list", "--head", head, "--state", "open", "--json", "number,url,baseRefName",
    ], options)).stdout);
    if (existing.length > 1) throw new Error(`multiple open PRs exist for ${head}`);
    if (existing[0]) {
      if (existing[0].baseRefName !== base) throw new Error(`existing PR for ${head} targets another base`);
      return { id: String(existing[0].number), url: existing[0].url };
    }
    const args = ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body];
    if (draft) args.push("--draft");
    const url = (await execFile("gh", args, options)).stdout.trim();
    const view = JSON.parse((await execFile("gh", ["pr", "view", head, "--json", "number,url"], options)).stdout);
    return { id: String(view.number), url: view.url || url };
  }

  async retargetPullRequest({ base, id, repo = null }) {
    await execFile("gh", ["pr", "edit", String(id), "--base", base], repo ? { cwd: repo, encoding: "utf8" } : { encoding: "utf8" });
  }

  async getRepositoryPolicy({ repo, target }) {
    const coordinate = JSON.parse((await execFile("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repo, encoding: "utf8" })).stdout).nameWithOwner;
    const branch = target.replace(/^refs\/heads\//, "");
    const protection = JSON.parse((await execFile("gh", ["api", `repos/${coordinate}/branches/${encodeURIComponent(branch)}/protection`], { cwd: repo, encoding: "utf8" })).stdout);
    return {
      current_base_enforced: protection.required_status_checks?.strict === true,
      required_checks: (protection.required_status_checks?.contexts ?? []).map(String),
    };
  }

  async markDraft({ id, repo = null }) {
    await execFile("gh", ["pr", "ready", "--undo", String(id)], repo ? { cwd: repo, encoding: "utf8" } : { encoding: "utf8" });
  }

  async markReady({ id, repo = null }) {
    await execFile("gh", ["pr", "ready", String(id)], repo ? { cwd: repo, encoding: "utf8" } : { encoding: "utf8" });
  }

  async getPullRequest({ id, repo = null }) {
    const options = repo ? { cwd: repo, encoding: "utf8" } : { encoding: "utf8" };
    const value = JSON.parse((await execFile("gh", ["pr", "view", String(id), "--json", "state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid"], options)).stdout);
    return {
      merged: value.state === "MERGED" && value.mergedAt !== null,
      merge_commit_sha: value.mergeCommit?.oid ?? null,
      base_ref: value.baseRefName,
      head_ref: value.headRefName,
      head_sha: value.headRefOid,
    };
  }
}

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}
