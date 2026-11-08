import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { DrovrError } from "./errors.mjs";
import { execute } from "./process.mjs";

export async function resolveTaskIdentity({
  cwd,
  groupKey,
  groupLabel,
  run = execute,
}) {
  const absoluteCwd = resolve(cwd);
  try {
    if (!(await stat(absoluteCwd)).isDirectory())
      throw new Error("not a directory");
  } catch (error) {
    throw new DrovrError(
      `task cwd is not an existing directory: ${absoluteCwd}`,
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  const canonicalCwd = await realpath(absoluteCwd);
  if (groupKey) {
    return {
      cwd: canonicalCwd,
      groupKey,
      groupLabel: groupLabel ?? groupKey,
      inferred: false,
    };
  }

  let identity = canonicalCwd;
  let labelPath = canonicalCwd;
  try {
    const commonDirectory = (
      await run(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        {
          cwd: canonicalCwd,
        },
      )
    ).trim();
    const gitDirectory = (
      await run("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
        cwd: canonicalCwd,
      })
    ).trim();
    labelPath = (
      await run("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalCwd })
    ).trim();
    const canonicalCommon = await realpath(commonDirectory);
    const canonicalGit = await realpath(gitDirectory);
    identity =
      canonicalCommon === canonicalGit
        ? await realpath(labelPath)
        : canonicalCommon;
  } catch {
    // A non-Git directory is itself the standalone group identity.
  }
  const name = basename(labelPath);
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 12);
  return {
    cwd: canonicalCwd,
    groupKey: `standalone/${name}-${digest}`,
    groupLabel: groupLabel ?? `${name} - standalone`,
    inferred: true,
  };
}
