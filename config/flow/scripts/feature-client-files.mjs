import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
const shell = quoteShell;
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Materialize a private client and trusted owner configuration, without starting either. */
export function writeFeatureClient({ directory, runtimeRoot, workspace, featureTestCheck, executionTrust, codexExecutable, localStateHome, authorityDirectory = join(directory, "authority") }) {
  const node = realpathSync(process.execPath);
  const modulePath = join(directory, "trusted-owner.mjs");
  const moduleBytes = `import { createFlowRuntime as production } from ${JSON.stringify(pathToFileURL(join(runtimeRoot, "config/flow/src/runtime.mjs")).href)};\nconst featureTestCheck = ${JSON.stringify(featureTestCheck) ?? "undefined"};\nexport function createFlowRuntime(options = {}) { return production({ ...options, featureTestCheck${localStateHome ? `, localClientCheck: { repository: ${JSON.stringify(workspace)}, featureTestCheck }` : ""} }); }\n`;
  const environment = {
    FLOW_CONFIG_DIRECTORY: join(runtimeRoot, "config/flow/releases/1.1-dark-test"),
    FLOW_QUALIFICATION_REPOSITORY_ROOT: runtimeRoot,
    FLOW_EXECUTION_BACKEND: "direct",
    FLOW_EXECUTION_TRUST: executionTrust ?? "strict",
    ...(codexExecutable ? { FLOW_CODEX_EXECUTABLE: codexExecutable } : {}),
    FLOW_REPOSITORY_ROOT: workspace,
    FLOW_OWNER_RUNTIME_MODULE: modulePath,
    FLOW_AUTHORITY_DIRECTORY: authorityDirectory,
    FLOW_OWNER_SOCKET_PATH: join(authorityDirectory, "owner.sock"),
    FLOW_OWNER_ENDPOINT_PATH: join(authorityDirectory, "owner.json"),
    XDG_STATE_HOME: join(directory, "state"),
    ...(localStateHome ? { FLOW_LOCAL_CLIENT_STATE_HOME: localStateHome } : {}),
  };
  writeFileSync(modulePath, moduleBytes, { flag: "wx", mode: 0o600 });
  const entrypoint = join(runtimeRoot, "config/flow/src/cli.mjs");
  writeFileSync(join(directory, "flow"), `#!/bin/sh\nset -eu\n${Object.entries(environment).map(([key, value]) => `export ${key}=${shell(value)}`).join("\n")}\nexec ${shell(node)} ${shell(entrypoint)} "$@"\n`, { flag: "wx", mode: 0o700 });
  return { node, environment, owner_module_sha256: sha(moduleBytes) };
}
