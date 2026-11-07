import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { projectInputDigest, resolveProjectCheck, assertProjectReadPath, projectPath } from "../src/production-project-check.mjs";
import { projectCheckRunnerIdentity } from "../src/production-project-check-runner.mjs";

try {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--repository", "--recipe", "--output"].includes(args[index]) || !args[index + 1] || options[args[index]]) throw new Error("Use --repository PATH --recipe JSON_FILE --output NEW_JSON_FILE");
    options[args[index]] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error("Use --repository PATH --recipe JSON_FILE --output NEW_JSON_FILE");
  const repository = realpathSync(options["--repository"]);
  const recipe = JSON.parse(readFileSync(options["--recipe"], "utf8"));
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
  const output = resolve(options["--output"]);
  writeFileSync(output, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "registration_only", output, registration_digest: digest(config),
    binding_fingerprint: binding.fingerprint, scope: binding.scope, command_executed: false, owner_started: false, provider_execution: "not_run" }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
