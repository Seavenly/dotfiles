import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { executionDescription } from "../../../tools/flow/src/execution-contract.mjs";
import { createProductionComposition } from "../src/production-composition.mjs";
import { createFlowRuntime as createCoreFlowRuntime } from "../../../tools/flow/src/flow-runtime.mjs";
import { createDurableRunAuthority, createInMemoryRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import { getWorkspaceAuthority } from "../../../tools/flow/src/work-authority.mjs";
import { createFlowRuntime, closeFlowRuntime } from "../src/runtime.mjs";

const request = () => ({
  schema: "flow.feature-preparation-request/v1",
  brief: {
    schema: "flow.feature-brief/v1",
    id: "brief:uppercase",
    summary: "Return uppercase text",
    acceptance: ["returns HELLO"],
  },
  repository: "/owned/repository",
  mode: "test",
  test: { check_id: "uppercase" },
  routes: {
    apply: { harness: "codex", capability: "workspace-write-denied" },
    critique: { harness: "codex", capability: "read-only" },
  },
});

test("production preparation binds a committed check without running it or inventing a verify baseline", async (t) => {
  const fixture = await preparationFixture(t);
  const composition = createProductionComposition({
    delegatedAgentPort: fixture.port,
    featureTestCheck: fixture.check,
    authorityDirectory: join(fixture.root, "authority"),
    env: { HOME: fixture.root, PATH: "/usr/bin:/bin" },
  });
  const selection = await composition.prepare(fixture.request, value => value);
  assert.equal(selection.definition, "feature/v1");
  assert.equal(selection.inputs.mode, "test");
  assert.equal(selection.inputs.slices.length, 1);
  assert.deepEqual(selection.inputs.slices[0].acceptance, ["returns HELLO"]);
  assert.equal(selection.inputs.slices[0].test.environment_status, "healthy");
  assert.match(selection.inputs.slices[0].test.environment_fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(selection.inputs.verification, undefined);
  assert.equal(JSON.stringify(selection).includes(fixture.repository), false);
  assert.equal(await readFile(join(fixture.repository, "feature.txt"), "utf8"), "hello\n");
});

async function preparationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "flow-test-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], {
    env: { HOME: root, PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.name", "Flow Fixture"]);
  git(["config", "user.email", "flow@example.test"]);
  const health = 'import test from "node:test"; import assert from "node:assert/strict"; test("health", () => assert.equal(Buffer.from("ready").toString(), "ready"));\n';
  const acceptance = 'import test from "node:test"; import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; test("uppercase", () => assert.equal(readFileSync("feature.txt", "utf8"), "HELLO\\n"));\n';
  await writeFile(join(repository, "health.mjs"), health);
  await writeFile(join(repository, "acceptance.mjs"), acceptance);
  await writeFile(join(repository, "feature.txt"), "hello\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "committed acceptance check"]);
  const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const executable = await realpath(process.execPath);
  const check = {
    schema: "flow.production-feature-test-check/v1",
    check_id: "uppercase",
    executable: { path: executable, version: process.version, sha256: sha(await readFile(executable)) },
    health: { path: "health.mjs", sha256: sha(health), case_name: "health" },
    acceptance: { path: "acceptance.mjs", sha256: sha(acceptance), case_name: "uppercase" },
    pinned_files: [],
    criteria: ["returns HELLO"],
    expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "HELLO\n", actual: "hello\n" },
    environment: { PATH: "/usr/bin:/bin" },
    limits: { timeout_ms: 1000, max_output_bytes: 64 * 1024 },
  };
  const port = {
    contract: "flow.delegated-agent-port/v1",
    backend: "direct",
    describe({ launch, caller_metadata }) {
      const description = executionDescription({
        launch,
        callerMetadata: caller_metadata,
        backend: { id: "direct", contract: "flow.direct-task/v1", adapter: "flow.codex-exec", adapter_version: "1", harness: "codex", native_session_strategy: "fresh_ephemeral", executable: { path: "/fixture/codex", version: "codex-cli 0.160.0", sha256: `sha256:${"a".repeat(64)}` } },
      });
      return { schema: "flow.execution-description-projection/v1", status: "compatible", description, watermark: description.watermark };
    },
  };
  return { root, repository, check, port, request: { ...request(), repository } };
}

test("test launch rejects a changed host check before creating a run or claiming workspace", async (t) => {
  const fixture = await preparationFixture(t);
  const composition = createProductionComposition({
    delegatedAgentPort: fixture.port,
    featureTestCheck: fixture.check,
    authorityDirectory: join(fixture.root, "authority"),
    env: { HOME: fixture.root, PATH: "/usr/bin:/bin" },
  });
  const authority = createDurableRunAuthority({
    authorityDirectory: join(fixture.root, "authority"),
    ...composition.authorityOptions,
  });
  t.after(() => authority.close());
  const runtime = createCoreFlowRuntime({
    runAuthority: authority,
    registeredOperations: composition.operations,
    predefinedDefinitions: composition.definitions,
    registeredAuthorities: composition.authorities,
    delegateOutputValidators: composition.validators,
    delegatedAgentPort: fixture.port,
  });
  composition.bindAuthority(authority);
  const prepared = await composition.prepare(fixture.request, selection => runtime.prepare(selection));
  assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
  const before = runtime.query({});
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority: authority });
  const workspaceQuery = { contract: "work.workspace/v1", subject_id: prepared.selection.inputs.workspace.subject_id };
  const beforeWorkspace = workspaceAuthority.query(workspaceQuery);
  fixture.check.limits.timeout_ms += 1;
  assert.throws(() => composition.beforeLaunch({ prepared }, authority), { code: "feature_test_check_drift" });
  assert.deepEqual(runtime.query({}), before);
  assert.deepEqual(workspaceAuthority.query(workspaceQuery), beforeWorkspace);
});

test("production rejects unknown checks, caller execution fields and incomplete criteria before effects", async (t) => {
  const fixture = await preparationFixture(t);
  const composition = createProductionComposition({
    delegatedAgentPort: fixture.port,
    featureTestCheck: fixture.check,
    authorityDirectory: join(fixture.root, "authority"),
    env: { HOME: fixture.root, PATH: "/usr/bin:/bin" },
  });
  const authority = createInMemoryRunAuthority();
  composition.bindAuthority(authority);
  const before = authority.query();
  for (const change of [
    value => { delete value.test; },
    value => { value.test.command = "run arbitrary code"; },
    value => { value.test.environment_fingerprint = `sha256:${"b".repeat(64)}`; },
    value => { value.test.environment_status = "healthy"; },
    value => { value.test.receipt = { outcome: "expected_failure" }; },
    value => { value.workspace_path = "/caller/path"; },
    value => { value.verification = { baseline: { assertion: "caller assertion" } }; },
    value => { value.mode = "mixed"; },
  ]) {
    const invalid = structuredClone(fixture.request);
    change(invalid);
    await assert.rejects(composition.prepare(invalid, value => value), { code: "invalid_preparation_request" });
  }
  const unknown = structuredClone(fixture.request);
  unknown.test.check_id = "unknown-check";
  await assert.rejects(composition.prepare(unknown, value => value), { code: "feature_test_check_unavailable" });
  const uncovered = structuredClone(fixture.request);
  uncovered.brief.acceptance.push("unsupported second criterion");
  await assert.rejects(composition.prepare(uncovered, value => value), { code: "feature_test_check_criterion_mismatch" });
  assert.deepEqual(authority.query(), before);
});

test("test route remains unavailable without valid trusted configuration", async (t) => {
  const fixture = await preparationFixture(t);
  for (const featureTestCheck of [undefined, { ...fixture.check, environment: { PATH: "/caller/bin" } }]) {
    const composition = createProductionComposition({
      delegatedAgentPort: fixture.port,
      featureTestCheck,
      authorityDirectory: join(fixture.root, "authority"),
      env: { HOME: fixture.root, PATH: "/usr/bin:/bin" },
    });
    const availability = composition.publicRouteAvailability({ flow: "feature", mode: "test" }, fixture.request);
    assert.equal(availability.available, false);
    assert.ok(availability.missing.includes("flow.operation/feature-test/v1"));
  }
});

test("public test preparation refuses caller-derived slices while qualified admission remains separate", async (t) => {
  const fixture = await preparationFixture(t);
  const configDirectory = join(fixture.root, "test-release");
  await cp(new URL("..", import.meta.url), configDirectory, {
    recursive: true,
    filter: source => !source.split("/").includes("node_modules"),
  });
  const manifestPath = join(configDirectory, "release-manifest.v1.json");
  const policyPath = join(configDirectory, "launch-policy.v1.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.release_id = "flow-release-test-preparation-fixture/v1";
  manifest.supported_routes.push({ flow: "feature", mode: "test" });
  manifest.disabled_routes = manifest.disabled_routes.filter(route => !(route.flow === "feature" && route.mode === "test"));
  manifest.dark_opt_in.release_id = manifest.release_id;
  manifest.dark_opt_in.routes = manifest.supported_routes.map(({ flow, mode }) => ({ flow, mode }));
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.implementations["flow-runtime/v1"].dark_opt_in.manifest_sha256 = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(manifestPath, manifestBytes);
  await writeFile(policyPath, JSON.stringify(policy));
  const runtime = createFlowRuntime({
    delegatedAgentPort: fixture.port,
    featureTestCheck: fixture.check,
    authorityDirectory: join(fixture.root, "public-authority"),
    autonomous: false,
    env: { HOME: fixture.root, PATH: "/usr/bin:/bin", FLOW_CONFIG_DIRECTORY: configDirectory, FLOW_QUALIFICATION_REPOSITORY_ROOT: fileURLToPath(new URL("../../..", import.meta.url)) },
  });
  t.after(() => closeFlowRuntime(runtime));
  const dark_opt_in = { schema: "flow.dark-opt-in/v1", release_id: manifest.release_id, purpose: "sacrificial_qualification" };
  const before = runtime.query({});
  const forged = await runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    dark_opt_in,
    inputs: { mode: "test", slices: [{ test: { intended_failure: "caller assertion", environment_fingerprint: `sha256:${"a".repeat(64)}` } }] },
  });
  assert.equal(forged.code, "invalid_preparation_request", JSON.stringify(forged));
  const withheld = await runtime.prepare({ ...fixture.request, dark_opt_in });
  assert.equal(withheld.code, "qualification_withheld", JSON.stringify(withheld));
  assert.deepEqual(runtime.query({}), before);
});

test("public test preparation selects only a trusted check identity", async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const name of ["flow.dark-opt-in.v1.schema.json", "flow.feature-preparation-request.v1.schema.json"]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema("https://dotfiles.local/schemas/flow.feature-preparation-request.v1.schema.json");
  assert.equal(validate(request()), true, ajv.errorsText(validate.errors));
  for (const testSelection of [undefined, {}, { check_id: "" }, { check_id: "uppercase", command: "run anything" }, { check_id: "uppercase", environment_status: "healthy" }]) {
    const invalid = request();
    if (testSelection === undefined) delete invalid.test;
    else invalid.test = testSelection;
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
  const conflicting = request();
  conflicting.verification = { baseline: { assertion: "caller baseline" } };
  assert.equal(validate(conflicting), false);
  const verify = request();
  verify.mode = "verify";
  delete verify.test;
  verify.verification = { baseline: { assertion: "existing behavior" } };
  assert.equal(validate(verify), true, ajv.errorsText(validate.errors));
  verify.test = { check_id: "uppercase" };
  assert.equal(validate(verify), false);
  const mixed = request();
  mixed.mode = "mixed";
  assert.equal(validate(mixed), false);
});
