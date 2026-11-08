import { projectProfile } from "../test-support/project-check.mjs";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFlowRuntime } from "../../../tools/flow/src/flow-runtime.mjs";
import { createInMemoryRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { dynamicCheckpointProposal } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { supervisedTrustPosture } from "../src/supervised-native-trust.mjs";
import { createFlowRuntime as productionRuntime, closeFlowRuntime } from "../src/runtime.mjs";
import { createDurableRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";
import { createGitWorkspaceObservationAdapter } from "../../../tools/flow/src/git-retention-adapter.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const load = path => JSON.parse(readFileSync(path, "utf8"));
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function copyRuntime(root) {
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const destination = join(root, "next-runtime");
  cpSync(source, destination, { recursive: true,
    filter: path => !path.slice(source.length).split("/").some(part => [".git", "node_modules"].includes(part)) });
  for (const section of ["config/flow", "tools/flow", "config/agent-flow"]) {
    symlinkSync(join(source, section, "node_modules"), join(destination, section, "node_modules"));
  }
  return join(destination, "config/flow/src/cli.mjs");
}

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
  mkdirSync(join(env.XDG_CONFIG_HOME, "git"), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME, "git/config"), '[user]\n name = Flow Fixture\n email = flow@example.test\n');
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
  return { root, repository, executable, run, success, git, args, checkPath, env, ownClient(value) { client = value; } };
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
  assert.equal(existsSync(join(load(join(first.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
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

test("explicit runtime upgrade preserves the original client and authority and reuses its new client", t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  const originalProfile = load(join(original.directory, "pilot.json"));
  const authority = originalProfile.environment.FLOW_AUTHORITY_DIRECTORY;
  const profilePath = join(authority, "../profile.json");
  const preserved = [profilePath, original.client, join(original.directory, "trusted-owner.mjs"), join(original.directory, "pilot.json")]
    .map(path => [path, readFileSync(path)]);
  const nextCli = copyRuntime(f.root);
  const nextArgs = [nextCli, ...f.args.slice(1)];
  assert.equal(f.run(process.execPath, nextArgs).status, 1, "runtime change requires explicit selection");
  const next = f.success(process.execPath, [...nextArgs, "--upgrade-runtime", "yes"]);
  assert.notEqual(next.client, original.client);
  assert.equal(next.owner_started, false);
  assert.equal(next.provider_execution, "not_run");
  assert.equal(load(join(next.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY, authority);
  const repeated = f.success(process.execPath, [...nextArgs, "--upgrade-runtime", "yes"]);
  assert.equal(repeated.client, next.client);
  assert.equal(repeated.profile_reused, true);
  assert.equal(f.success(process.execPath, nextArgs).client, next.client, "registered runtime reuse needs no new upgrade");
  assert.equal(f.success(process.execPath, f.args).client, original.client, "runtime variants are not different checks");
  for (const [path, bytes] of preserved) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(authority, "authority.sqlite")), false, "setup must not start an owner");
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
  f.ownClient(next.client);
  f.success(next.client, ["start", "--json"]);
  assert.equal(f.success(next.client, ["prepare", "--input-file", next.request, "--json"]).schema, "flow.prepared-run/v1");
  f.success(next.client, ["stop", "--json"]);
  f.ownClient(original.client);
  f.success(original.client, ["start", "--json"]);
  assert.equal(f.success(original.client, ["query", "--input", "{}", "--json"]).schema, "flow.run-index-projection/v1");
  f.success(original.client, ["stop", "--json"]);
  assert.equal(existsSync(join(authority, "direct-tasks")), false);
});

test("runtime upgrade refuses a live owner without replacing its client", t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  const before = readFileSync(original.client);
  const nextArgs = [copyRuntime(f.root), ...f.args.slice(1), "--upgrade-runtime", "yes"];
  f.ownClient(original.client);
  f.success(original.client, ["start", "--json"]);
  const refused = f.run(process.execPath, nextArgs);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Stop the existing local owner/u);
  assert.deepEqual(readFileSync(original.client), before);
  assert.equal(f.success(original.client, ["status", "--json"]).state, "running");
});

test("runtime upgrade never changes executable, trust or Git identity pins", t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  const oldProfile = readFileSync(join(original.directory, "pilot.json"));
  const nextArgs = [copyRuntime(f.root), ...f.args.slice(1), "--upgrade-runtime", "yes"];
  const identityPath = join(f.env.XDG_CONFIG_HOME, "git/config");
  const identity = readFileSync(identityPath);
  writeFileSync(identityPath, '[user]\n name = Different Author\n email = other@example.test\n');
  const changedIdentity = f.run(process.execPath, nextArgs);
  assert.equal(changedIdentity.status, 1);
  assert.match(changedIdentity.stderr, /different Node, executable, trust or Git identity pins/u);
  writeFileSync(identityPath, identity);
  writeFileSync(f.executable, readFileSync(f.executable, "utf8") + "# changed executable bytes\n");
  const changedExecutable = f.run(process.execPath, nextArgs);
  assert.equal(changedExecutable.status, 1);
  assert.match(changedExecutable.stderr, /different Node, executable, trust or Git identity pins/u);
  const trustArgs = [...nextArgs]; trustArgs[trustArgs.indexOf("supervised-native-cli")] = "another-contract";
  const changedTrust = f.run(process.execPath, trustArgs);
  assert.equal(changedTrust.status, 1);
  assert.match(changedTrust.stderr, /Select --execution-trust supervised-native-cli/u);
  assert.deepEqual(readFileSync(join(original.directory, "pilot.json")), oldProfile);
});

test("same-check runtime upgrade refuses active work before any provider is invoked", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  const profile = load(join(original.directory, "pilot.json"));
  const options = { env: { ...f.env, ...profile.environment }, autonomous: false,
    localClientCheck: { repository: f.repository } };
  const runtime = productionRuntime(options);
  let runId;
  try {
    const prepared = await runtime.prepare(load(original.request));
    const launched = runtime.launch({ prepared, execution_trust: profile.execution_trust,
      confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
      closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } });
    assert.equal(launched.schema, "flow.launch-receipt/v1");
    runId = launched.run_id;
  } finally { closeFlowRuntime(runtime); }
  const upgradedArgs = [copyRuntime(f.root), ...f.args.slice(1), "--upgrade-runtime", "yes"];
  const active = f.run(process.execPath, upgradedArgs);
  assert.equal(active.status, 1);
  assert.match(active.stderr, /Settle every retained run and uncertain effect/u);
  const retained = productionRuntime(options);
  try {
    const run = retained.query({ run_id: runId });
    assert.equal(run.phase, "active");
    const cancelled = retained.command(run.views.operator.legal_actions.find(action => action.type === "cancel"));
    assert.equal(cancelled.accepted, true);
    assert.equal(retained.query({ run_id: runId }).phase, "cancelled");
  } finally { closeFlowRuntime(retained); }
  assert.equal(existsSync(join(profile.environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
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
  assert.equal(existsSync(join(load(join(profile.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
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

test("local setup refuses missing commit identity before creating a client or starting work", t => {
  const f = fixture(t);
  rmSync(join(f.env.XDG_CONFIG_HOME, "git"), { recursive: true });
  const result = f.run(process.execPath, f.args);
  assert.equal(result.status, 1, "a repository without configured author/committer must fail before model work");
  assert.match(result.stderr, /identity/u);
  assert.equal(existsSync(join(f.root, "state/flow-local")), false);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("local setup binds global XDG Git identity in confirmation despite later configuration drift", t => {
  const f = fixture(t);
  const setup = f.success(process.execPath, f.args);
  assert.equal(setup.commit_identity.author.name, "Flow Fixture");
  assert.equal(f.run("/usr/bin/git", ["-C", f.repository, "config", "--local", "--get", "user.name"]).status, 1);
  writeFileSync(join(f.env.XDG_CONFIG_HOME, "git/config"), '[user]\n name = Changed Host\n email = changed@example.test\n');
  f.ownClient(setup.client);
  f.success(setup.client, ["start", "--json"]);
  const prepared = f.success(setup.client, ["prepare", "--input-file", setup.request, "--json"]);
  assert.deepEqual(prepared.confirmation.trust_posture.git_identity, setup.commit_identity);
  assert.deepEqual(prepared.trust_posture.git_identity, setup.commit_identity);
  assert.equal(existsSync(join(load(join(setup.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
});

test("a stopped repository client advances from verify to a new checked feature without replacing its authority or old client", t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  const oldBytes = readFileSync(original.client);
  const rejected = f.run(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath]);
  assert.equal(rejected.status, 1, "a changed check requires explicit selection");
  const next = f.success(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath, "--reconfigure-check", "yes"]);
  assert.notEqual(next.client, original.client);
  assert.equal(load(join(next.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY,
    load(join(original.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY);
  assert.deepEqual(readFileSync(original.client), oldBytes);
  f.ownClient(next.client);
  f.success(next.client, ["start", "--json"]);
  assert.equal(f.success(next.client, ["prepare", "--input-file", next.request, "--json"]).schema, "flow.prepared-run/v1");
  assert.equal(f.run(process.execPath, [...f.args, "--reconfigure-check", "yes"]).status, 1, "a live owner prevents selecting a different check");
  f.success(next.client, ["stop", "--json"]);
  const reverted = f.success(process.execPath, [...f.args, "--reconfigure-check", "yes"]);
  assert.equal(reverted.client, original.client);
  const briefPath = f.args[f.args.indexOf("--brief") + 1];
  const brief = load(briefPath);
  brief.id = "brief:second-feature";
  brief.acceptance = ["feature.txt contains later"];
  writeFileSync(briefPath, JSON.stringify(brief));
  const check = load(f.checkPath);
  check.check_id = "check:second-feature";
  check.criteria = brief.acceptance;
  check.expected_failure.expected = "later\n";
  const acceptancePath = join(f.repository, check.acceptance.path);
  const nextAcceptance = readFileSync(acceptancePath, "utf8").replace('"after\\n"', '"later\\n"');
  writeFileSync(acceptancePath, nextAcceptance);
  check.acceptance.sha256 = sha(nextAcceptance);
  writeFileSync(f.checkPath, JSON.stringify(check));
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Register next feature acceptance"]);
  const third = f.success(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath, "--reconfigure-check", "yes"]);
  assert.notEqual(third.client, next.client);
  assert.equal(load(join(third.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY,
    load(join(original.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY);
  f.success(third.client, ["start", "--json"]);
  const prepared = f.success(third.client, ["prepare", "--input-file", third.request, "--json"]);
  assert.deepEqual(prepared.selection.inputs.brief.acceptance, brief.acceptance);
  f.success(third.client, ["stop", "--json"]);
});

for (const version of ["v1", "v2"]) {
test(`a different retained client refuses active ${version} checked work before recovery or provider dispatch`, { skip: process.platform !== "linux" && "native checked clients require Linux containment" }, async t => {
  const f = fixture(t);
  if (version === "v2") {
    const config = projectProfile({ root: f.repository, argv: ["--test", "acceptance.test.mjs"], files: ["acceptance.test.mjs"] });
    config.criteria = load(join(f.root, "brief.json")).acceptance;
    writeFileSync(f.checkPath, JSON.stringify(config));
  }
  const original = f.success(process.execPath, f.args);
  const next = f.success(process.execPath, [...f.args, "--mode", version === "v2" ? "verify" : "test", "--check", f.checkPath, "--reconfigure-check", "yes"]);
  const profile = load(join(next.directory, "pilot.json"));
  const options = { env: { ...f.env, ...profile.environment }, featureTestCheck: load(f.checkPath),
    localClientCheck: { repository: f.repository, featureTestCheck: load(f.checkPath) }, autonomous: false };
  const runtime = productionRuntime(options);
  let launched;
  try {
    const prepared = await runtime.prepare(load(next.request));
    launched = runtime.launch({ prepared, execution_trust: prepared.selection.inputs.execution_trust ?? profile.execution_trust,
      confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
      closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } });
    assert.equal(launched.schema, "flow.launch-receipt/v1", JSON.stringify(launched));
  } finally { closeFlowRuntime(runtime); }
  assert.equal(f.run(process.execPath, [...f.args, "--reconfigure-check", "yes"]).status, 1, "offline setup sees active retained work");
  const upgraded = f.run(process.execPath, [copyRuntime(f.root), ...f.args.slice(1),
    "--mode", version === "v2" ? "verify" : "test", "--check", f.checkPath,
    "--reconfigure-check", "yes", "--upgrade-runtime", "yes"]);
  assert.equal(upgraded.status, 1);
  assert.match(upgraded.stderr, /Settle every retained run and uncertain effect/u);
  const wrong = f.run(original.client, ["start", "--json"]);
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.equal(existsSync(join(profile.environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
  const same = productionRuntime(options);
  try {
    const retained = same.query({ run_id: launched.run_id });
    assert.equal(retained.phase, "active");
    assert.equal(retained.views.operator.trust_posture.verification_scope.schema, "flow.supervised-verification-scope/v1");
  }
  finally { closeFlowRuntime(same); }
});

}

test("check and runtime changes retain and refuse claimed or tainted workspace authority", t => {
  const f = fixture(t);
  const original = f.success(process.execPath, f.args);
  f.ownClient(original.client);
  f.success(original.client, ["start", "--json"]);
  const prepared = f.success(original.client, ["prepare", "--input-file", original.request, "--json"]);
  f.success(original.client, ["stop", "--json"]);
  const authorityDirectory = load(join(original.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY;
  const upgradedArgs = [copyRuntime(f.root), ...f.args.slice(1), "--upgrade-runtime", "yes"];
  const authority = createDurableRunAuthority({ authorityDirectory, gitWorkspaceObservationAdapter: createGitWorkspaceObservationAdapter() });
  try {
    const workspace = getWorkspaceAuthority({ runAuthority: authority });
    const query = { contract: "work.workspace/v1", subject_id: prepared.selection.inputs.workspace.subject_id };
    const before = workspace.query(query);
    const claim = workspace.command({ schema: "work.workspace-claim-command/v1", command_id: "claim:local-held", type: "workspace_claim", ...query,
      expected_generation: before.generation, expected_watermark: before.watermark, expected_fingerprint: prepared.selection.inputs.workspace.fingerprint,
      claim: { claim_id: "claim:local-held", holder: "run:retained", operations: ["feature-apply"] } });
    assert.equal(claim.accepted, true, JSON.stringify(claim));
    assert.equal(f.run(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath, "--reconfigure-check", "yes"]).status, 1);
    assert.match(f.run(process.execPath, upgradedArgs).stderr, /Settle retained workspace claims and taint/u);
    assert.equal(workspace.query(query).claims.length, 1);
    assert.equal(workspace.command(workspace.query(query).legal_actions.find(action => action.type === "workspace_claim_release")).accepted, true);
    const taint = workspace.command({ schema: "work.workspace-taint-command/v1", command_id: "taint:local-uncertain", type: "workspace_taint", ...query,
      expected_watermark: workspace.query(query).watermark, taint: { reason: "effect_outcome_uncertain", evidence_digest: `sha256:${"8".repeat(64)}` } });
    assert.equal(taint.accepted, true, JSON.stringify(taint));
    assert.equal(f.run(process.execPath, [...f.args, "--mode", "test", "--check", f.checkPath, "--reconfigure-check", "yes"]).status, 1);
    assert.match(f.run(process.execPath, upgradedArgs).stderr, /Settle retained workspace claims and taint/u);
    assert.equal(workspace.query(query).taint.reason, "effect_outcome_uncertain");
  } finally { authority.close(); }
});


test("local setup exposes GREEN-only project registration in public prepare and compact inspection", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const config = projectProfile({ root: f.repository, argv: ["--test", "acceptance.test.mjs"], files: ["acceptance.test.mjs"] });
  config.criteria = load(join(f.root, "brief.json")).acceptance;
  writeFileSync(f.checkPath, JSON.stringify(config));
  const profile = f.success(process.execPath, [...f.args, "--mode", "verify", "--check", f.checkPath]);
  f.ownClient(profile.client);
  assert.match(profile.verification_scope, /GREEN-only/u);
  const request = load(profile.request);
  assert.equal(request.check.check_id, config.check_id);
  assert.equal(request.test, undefined);
  assert.equal(existsSync(join(profile.directory, "authority.sqlite")), false);
  f.success(profile.client, ["start", "--json"]);
  const prepared = f.success(profile.client, ["prepare", "--input-file", profile.request, "--json"]);
  assert.equal(prepared.schema, "flow.prepared-run/v1");
  assert.deepEqual(prepared.selection.inputs.project_check.registration, config);
  assert.match(prepared.trust_posture.verification_scope.verify, /GREEN-only/u);
  const apply = prepared.graph.cards.find(card => card.id === "feature-apply");
  assert.deepEqual(apply.inputs.project_check.registration.argv, config.argv, "writer receives exact selected command and inputs");
  const path = join(f.root, "prepared-v2.json"); writeFileSync(path, JSON.stringify(prepared));
  const summary = f.success(profile.client, ["local", "inspect-prepared", path]);
  assert.deepEqual(summary.project_check, prepared.selection.inputs.project_check);
  assert.equal(existsSync(join(load(join(profile.directory, "pilot.json")).environment.FLOW_AUTHORITY_DIRECTORY, "direct-tasks")), false);
  f.success(profile.client, ["stop", "--json"]);
});
