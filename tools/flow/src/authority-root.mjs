import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveAuthorityRoot(
  specification,
  options = {},
) {
  if (specification?.base === "home" &&
      options.stateDirectory !== undefined && options.homeDirectory === undefined) {
    throw new Error("authority root environment requires an explicit home directory");
  }
  const homeDirectory = options.homeDirectory ?? homedir();
  const stateDirectory = options.stateDirectory ??
    (options.homeDirectory === undefined
      ? process.env.XDG_STATE_HOME || join(homeDirectory, ".local", "state")
      : join(homeDirectory, ".local", "state"));
  if (!specification || !["home", "state"].includes(specification.base) ||
      typeof specification.path !== "string" || !specification.path) {
    throw new Error("authority root specification is invalid");
  }
  if (isAbsolute(specification.path)) {
    throw new Error("authority root path must be relative to its declared base");
  }
  const baseDirectory = specification.base === "home" ? homeDirectory : stateDirectory;
  const root = resolve(baseDirectory, specification.path);
  const relativeRoot = relative(resolve(baseDirectory), root);
  if (relativeRoot === ".." || relativeRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeRoot)) {
    throw new Error("authority root path escapes its declared base");
  }
  return root;
}

export function authorityRootsAreDisjoint(specifications, options) {
  const roots = specifications.map((specification) =>
    resolveAuthorityRoot(specification, options));
  return roots.every((root, index) => roots.every((otherRoot, otherIndex) => {
    if (index === otherIndex) return true;
    const nestedPath = relative(root, otherRoot);
    return nestedPath === ".." || nestedPath.startsWith(`..${sep}`) ||
      isAbsolute(nestedPath);
  }));
}
