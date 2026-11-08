import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
// The last reviewed source before verification-scope annotations existed.
const priorSource = "4b3fedc52f8a2c82d115ca096515cc8c3f4e07d5";
const load = path => JSON.parse(readFileSync(path, "utf8"));

test("public owner reopens an authentic prior-source supervised run without changing its stored fold", { skip: process.platform !== "linux" }, t => {
  const scratch = mkdtempSync(join(tmpdir(), "flow-prior-replay-"));
  const prior = join(scratch, "prior"), home = join(scratch, "home");
  mkdirSync(prior); mkdirSync(home);
  const archive = execFileSync("/usr/bin/git", ["-C", root, "archive", priorSource], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", prior], { input: archive });
  for (const pkg of ["config/flow", "tools/flow", "config/agent-flow"]) {
    const modules = join(prior, pkg, "node_modules"); mkdirSync(modules);
    for (const name of readdirSync(join(root, pkg, "node_modules"))) symlinkSync(join(root, pkg, "node_modules", name), join(modules, name));
  }
  const executable = join(scratch, "codex-fixture");
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi\nexit 99\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(scratch, "state"), XDG_CONFIG_HOME: join(scratch, "config"), FLOW_AUTHORITY_DIRECTORY: join(scratch, "unused-authority") };
  delete env.NODE_TEST_CONTEXT;
  let active;
  const invoke = (cli, args, environment = env) => spawnSync(process.execPath, [cli, ...args], { env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const success = (cli, args, environment = env) => { const result = invoke(cli, args, environment); assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout); };
  t.after(() => {
    if (active) success(active[0], ["stop", "--json"], active[1]);
    rmSync(scratch, { recursive: true, force: true });
  });
  const oldCli = join(prior, "config/flow/src/cli.mjs");
  const pilot = success(oldCli, ["pilot", "setup", "--parent", scratch, "--mode", "verify", "--execution-trust", "supervised-native-cli", "--codex-executable", executable]);
  const profile = load(join(pilot.directory, "pilot.json"));
  const ownerModule = (path, source) => writeFileSync(path, `import { createFlowRuntime as production } from ${JSON.stringify(pathToFileURL(join(source, "config/flow/src/runtime.mjs")).href)};\nexport function createFlowRuntime(options = {}) { return production({ ...options, autonomous: false }); }\n`);
  ownerModule(profile.environment.FLOW_OWNER_RUNTIME_MODULE, prior);
  const oldEnv = { ...env, ...profile.environment };
  success(oldCli, ["start", "--json"], oldEnv);
  active = [oldCli, oldEnv];
  const prepared = success(oldCli, ["prepare", "--input-file", join(pilot.directory, "prepare-request.json"), "--json"], oldEnv);
  assert.equal(prepared.trust_posture.verification_scope, undefined);
  const request = join(scratch, "launch.json");
  writeFileSync(request, JSON.stringify({ prepared, execution_trust: profile.execution_trust,
    confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
    closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } }));
  const launched = success(oldCli, ["launch", "--input-file", request, "--json"], oldEnv);
  success(oldCli, ["stop", "--json"], oldEnv); active = null;
  const databasePath = join(oldEnv.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite");
  const storedRun = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare("SELECT fold_json, fold_digest FROM authority_streams WHERE stream_id = ?").get(launched.run_id); }
    finally { database.close(); }
  };
  const before = storedRun();
  assert.equal(JSON.parse(before.fold_json).trust_posture, undefined);
  const currentCli = join(root, "config/flow/src/cli.mjs"), module = join(scratch, "current-owner.mjs");
  ownerModule(module, root);
  const currentEnv = { ...oldEnv, FLOW_OWNER_RUNTIME_MODULE: module, FLOW_CONFIG_DIRECTORY: join(root, "config/flow/releases/1.1-dark-test"), FLOW_QUALIFICATION_REPOSITORY_ROOT: root };
  success(currentCli, ["start", "--json"], currentEnv); active = [currentCli, currentEnv];
  const projection = success(currentCli, ["query", "--input-file", (() => { const path = join(scratch, "query.json"); writeFileSync(path, JSON.stringify({ run_id: launched.run_id })); return path; })(), "--json"], currentEnv);
  assert.equal(projection.run_id, launched.run_id);
  assert.equal(projection.bundle_digest, prepared.bundle_digest);
  assert.equal(projection.views.operator.trust_posture, undefined, "historical run must not acquire a new verification claim");
  success(currentCli, ["stop", "--json"], currentEnv); active = null;
  assert.deepEqual(storedRun(), before, "replay must preserve the exact historical fold and digest");
});
