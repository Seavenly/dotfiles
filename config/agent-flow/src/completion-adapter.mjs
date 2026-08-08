import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { parseExternalRef } from "./external-root.mjs";

const execFile = promisify(execFileCallback);

export class GitHubCompletionAdapter {
  async markDone({ evidence, externalRef }) {
    const root = parseExternalRef(externalRef);
    if (root?.system !== "github") throw new Error("CLI completion supports GitHub external roots only");
    const [coordinate, issue] = root.id.split("#");
    const current = JSON.parse((await execFile("gh", ["issue", "view", issue, "--repo", coordinate, "--json", "state"], { encoding: "utf8" })).stdout);
    if (current.state === "CLOSED") return;
    const body = `Agent Flow observed completion PR merge ${evidence.completion_pr} at ${evidence.merge_commit_sha}.`;
    await execFile("gh", ["issue", "close", issue, "--repo", coordinate, "--comment", body], { encoding: "utf8" });
  }
}
