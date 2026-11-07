import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { projectInputDigest, resolveProjectCheck, assertProjectReadPath, projectPath } from "./production-project-check.mjs";
import { projectCheckRunnerIdentity } from "./production-project-check-runner.mjs";

/** The same read-only registration calculation serves manual and guided setup. */
export function createProjectCheckRegistration({ repository, recipe }) {
  repository = realpathSync(repository);
  if (recipe.schema !== "flow.project-check-recipe/v2" || typeof recipe.executable !== "string" ||
      !Array.isArray(recipe.pinned_files) || !Array.isArray(recipe.read_mounts)) throw new Error("Expected flow.project-check-recipe/v2 with exact executable, pinned_files and read_mounts");
  if (recipe.pinned_files.some(path => !projectPath(path))) throw new Error("Pinned files must be contained project-relative paths");
  const executable = realpathSync(recipe.executable);
  assertProjectReadPath(executable);
  const config = { ...recipe, schema: "flow.production-project-check/v2",
    executable: { path: executable, sha256: projectInputDigest(executable) },
    pinned_files: recipe.pinned_files.map(path => ({ path, sha256: projectInputDigest(resolve(repository, path)) })),
    read_mounts: recipe.read_mounts.map(mount => {
      if (!mount || Object.keys(mount).sort().join(",") !== "source,target") throw new Error("Each read mount needs only source and target");
      const source = realpathSync(mount.source); assertProjectReadPath(source);
      return { source, target: mount.target, sha256: projectInputDigest(source) };
    }),
  };
  const binding = resolveProjectCheck({ config, brief: { acceptance: config.criteria }, workspace: { path: repository }, runnerIdentity: projectCheckRunnerIdentity() });
  return { config, registration_digest: digest(config), binding_fingerprint: binding.fingerprint, scope: binding.scope };
}
