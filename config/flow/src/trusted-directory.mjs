import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create or validate a private directory without following caller-controlled
 * links. A pre-existing root-owned system link is resolved once to its
 * canonical target, and all later mutations use that target instead of the
 * lexical path.
 */
export async function ensureTrustedDirectoryTree(
  path,
  {
    code,
    errorFactory,
    statReader = lstat,
    realpathReader = realpath,
  } = {},
) {
  if (typeof errorFactory !== "function") {
    throw new TypeError("Trusted directory validation requires an error factory");
  }
  if (path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw errorFactory(`${code}_traversal`);
  }

  let resolvedCurrent = "/";
  const segments = path.split("/").filter((value) => value.length > 0);
  for (const [index, segment] of segments.entries()) {
    const candidate = join(resolvedCurrent, segment);
    let info;
    try {
      info = await statReader(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      info = await statReader(candidate);
    }
    if (info.isSymbolicLink()) {
      if (index === segments.length - 1) {
        throw errorFactory(`${code}_symlink`);
      }
      resolvedCurrent = await resolveTrustedSystemLink({
        path: candidate,
        info,
        code,
        statReader,
        realpathReader,
        errorFactory,
      });
      continue;
    }
    if (!info.isDirectory()) {
      throw errorFactory(`${code}_not_directory`);
    }
    resolvedCurrent = candidate;
  }
  return {
    path: resolvedCurrent,
    info: await statReader(resolvedCurrent),
  };
}

async function resolveTrustedSystemLink({
  path,
  info,
  code,
  statReader,
  realpathReader,
  errorFactory,
}) {
  if (info.uid !== 0) {
    throw errorFactory(`${code}_symlink`);
  }
  let resolvedTarget;
  try {
    resolvedTarget = await realpathReader(path);
  } catch {
    throw errorFactory(`${code}_symlink`);
  }
  const targetInfo = await statReader(resolvedTarget);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw errorFactory(`${code}_symlink`);
  }
  return resolvedTarget;
}
