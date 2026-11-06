import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFlowRuntime } from "../../../tools/flow/src/flow-runtime.mjs";
import { createInMemoryRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { dynamicCheckpointProposal } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { supervisedTrustPosture } from "../src/supervised-native-trust.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const load = path => JSON.parse(readFileSync(path, "utf8"));
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-local-test-"));
  let client;
  t.after(() => {
    if (client) success(client, ["stop", "--json"]);
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ["home", "state", "repository"]) mkdirSync(join(root, name));
  const repository = join(root, "repository"), executable = join(root, "codex-fixture");
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi\nexit 99\n', { mode: 0o700 });
  const env = { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  delete env.NODE_TEST_CONTEXT;
  delete env.FLOW_LOCAL_CLIENT_STATE_HOME;
  const run = (file, args) => spawnSync(file, args, { env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const success = (file, args) => { const r = run(file, args); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Flow Fixture", "-c", "user.email=flow@example.test", "-C", repository, ...args], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 10000,
  });
  const health = 'import test from "node:test"; import assert from "node:assert/strict"; test("health", () => assert.equal(2+2,4));\n';
  const acceptance = 'import test from "node:test"; import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; test("feature", () => assert.equal(readFileSync("feature.txt","utf8"),"after\\n"));\n';
  for (const [name, bytes] of Object.entries({ "feature.txt": "before\n", "health.test.mjs": health, "acceptance.test.mjs": acceptance })) writeFileSync(join(repository, name), bytes);
  git(["init", "--quiet", "--initial-branch=main"]); git(["add", "."]); git(["commit", "--quiet", "-m", "Local feature fixture"]);
  const brief = { schema: "flow.feature-brief/v1", id: "brief:local", summary: "Change feature.txt to after", acceptance: ["feature.txt contains after"] };
  const briefPath = join(root, "brief.json"); writeFileSync(briefPath, JSON.stringify(brief));
  const node = realpathSync(process.execPath);
  const check = { schema: "flow.production-feature-test-check/v1", check_id: "check:local",
    executable: { path: node, version: process.version, sha256: sha(readFileSync(node)) },
    health: { path: "health.test.mjs", sha256: sha(health), case_name: "health" },
    acceptance: { path: "acceptance.test.mjs", sha256: sha(acceptance), case_name: "feature" },
    pinned_files: [], criteria: brief.acceptance,
    expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "after\n", actual: "before\n" },
    environment: { PATH: "/usr/bin:/bin" }, limits: { timeout_ms: 5000, max_output_bytes: 65536 } };
  const checkPath = join(root, "check.json"); writeFileSync(checkPath, JSON.stringify(check));
  const args = [cli, "local", "setup", "--execution-trust", "supervised-native-cli", "--repository", repository, "--brief", briefPath, "--codex-executable", executable];
  return { root, repository, executable, run, success, git, args, checkPath, ownClient(value) { client = value; } };
}

test("local setup preserves an existing repo, installs an explicit client link and reuses one authority", t => {
  const f = fixture(t), link = join(f.root, "flow-project");
  const before = f.git(["rev-parse", "HEAD^{tree}"]);
  const first = f.success(process.execPath, [...f.args, "--client-link", link]);
  assert.equal(first.status, "request_only");
  assert.equal(first.owner_started, false);
  assert.equal(first.provider_execution, "not_run");
  assert.equal(first.next_commands.length, 4);
  assert.match(first.next_commands[1], /--input-file/u);
  assert.match(first.verification_scope, /project checks NOT_RUN; runtime behavior not established/u);
  assert.equal(realpathSync(link), first.client);
  assert.equal(statSync(first.client).mode & 0o777, 0o700);
  assert.equal(existsSync(join(first.directory, "authority/authority.sqlite")), false);
  const second = f.success(link, f.args.slice(1));
  assert.equal(second.directory, first.directory);
  assert.equal(second.client, first.client);
  assert.equal(second.profile_reused, true);
  assert.notEqual(second.request, first.request);
  assert.equal(f.git(["rev-parse", "HEAD^{tree}"]), before);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
  writeFileSync(join(f.root, "occupied"), "preserve me");
  assert.equal(f.run(process.execPath, [...f.args, "--client-link", join(f.root, "occupied")]).status, 1);
  assert.equal(readFileSync(join(f.root, "occupied"), "utf8"), "preserve me");
});

test("local test setup binds explicit committed checks and public confirmation without running a provider", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  assert.equal(f.run(process.execPath, [...f.args, "--mode", "test"]).status, 1);
  const profile = f.success(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath]);
  assert.match(profile.verification_scope, /expected RED then GREEN/u);
  f.ownClient(profile.client);
  f.success(profile.client, ["start", "--json"]);
  const prepared = f.success(profile.client, ["prepare", "--input-file", profile.request, "--json"]);
  assert.equal(prepared.schema, "flow.prepared-run/v1");
  assert.equal(prepared.selection.inputs.mode, "test");
  assert.match(prepared.confirmation.trust_posture.verification_scope.verify, /project checks NOT_RUN/u);
  assert.match(prepared.confirmation.trust_posture.verification_scope.test, /expected RED then GREEN/u);
  const preparedPath = join(profile.directory, "prepared.json");
  writeFileSync(preparedPath, JSON.stringify(prepared));
  const inspected = f.success(profile.client, ["local", "inspect-prepared", preparedPath]);
  assert.equal(inspected.bundle_digest, prepared.bundle_digest);
  assert.equal(inspected.routes[0].executable.version, "codex-cli 0.166.0");
  const accepted = f.success(profile.client, ["local", "accept-prepared", profile.directory, preparedPath]);
  assert.match(accepted.launch_command, /launch --input-file/u);
  assert.equal(existsSync(join(profile.directory, "authority/direct-tasks")), false);
  assert.equal(readFileSync(join(f.repository, "feature.txt"), "utf8"), "before\n");
});

test("retained run status preserves the exact supervised verification scope from confirmation", () => {
  const definition = supervisedTrustPosture({ schema: "flow.predefined-definition/v1", id: "feature/v1",
    contract: "flow.definition/feature/v1", promised_outcomes: ["local content observations"], negative_outcomes: ["no behavioral test claim"],
    trust_posture: {}, compile: () => dynamicCheckpointProposal() }, "supervised-native-cli");
  const runtime = createFlowRuntime({ runAuthority: createInMemoryRunAuthority(), predefinedDefinitions: { "feature/v1": definition } });
  const prepared = runtime.prepare({ schema: "flow.predefined-flow-selection/v1", definition: "feature/v1", inputs: {}, explicit_facts: dynamicCheckpointProposal().explicit_facts });
  const launched = runtime.launch({ prepared,
    confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
    closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } });
  const projection = runtime.query({ run_id: launched.run_id });
  assert.deepEqual(projection.views.operator.trust_posture, prepared.confirmation.trust_posture);
  assert.deepEqual(projection.views.trust.trust_posture, prepared.confirmation.trust_posture);
});
