import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectCheckRegistration } from "../src/project-check-registration.mjs";

try {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--repository", "--recipe", "--output"].includes(args[index]) || !args[index + 1] || options[args[index]]) throw new Error("Use --repository PATH --recipe JSON_FILE --output NEW_JSON_FILE");
    options[args[index]] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error("Use --repository PATH --recipe JSON_FILE --output NEW_JSON_FILE");
  const repository = realpathSync(options["--repository"]);
  const recipe = JSON.parse(readFileSync(options["--recipe"], "utf8"));
  const { config, registration_digest, binding_fingerprint, scope } = createProjectCheckRegistration({ repository, recipe });
  const output = resolve(options["--output"]);
  writeFileSync(output, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "registration_only", output, registration_digest,
    binding_fingerprint, scope, command_executed: false, owner_started: false, provider_execution: "not_run" }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
