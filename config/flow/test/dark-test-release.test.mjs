import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

import { closeFlowRuntime, createFlowRuntime } from "../src/runtime.mjs";
import { bindQualifiedReleaseFixture, rebindReleaseContentFixture } from "../test-support/qualified-release-fixture.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const config = join(root, "config/flow");
const execFileAsync = promisify(execFile);

test("generated dark test not-run evidence with accurate route assertions still withholds public admission", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-not-run-test-release-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copied = join(scratch, "test-config");
  await cp(join(config, "releases/1.1-dark-test"), copied, { recursive: true });
  await execFileAsync(process.execPath, [join(config, "scripts/generate-release-content.mjs"),
    "--config-directory", copied, "--repository-root", root], { cwd: root });
  const qualification = JSON.parse(await readFile(join(copied, "evidence/release-qualification.v1.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(JSON.parse(await readFile(join(config, "schemas/flow.transition-qualification-evidence.v1.schema.json"), "utf8")));
  assert.equal(validate(qualification), true, ajv.errorsText(validate.errors));
  assert.equal(qualification.status, "not_run");
  assert.equal(qualification.recipe, null);
  assert.equal(qualification.assertions[1], "dark opt-in resolves only exact feature verify, feature test, and local review routes");
  const runtime = createFlowRuntime({ env: { HOME: scratch, FLOW_CONFIG_DIRECTORY: copied, FLOW_QUALIFICATION_REPOSITORY_ROOT: root, FLOW_REPOSITORY_ROOT: root }, autonomous: false });
  t.after(() => closeFlowRuntime(runtime));
  const before = runtime.query({});
  const rejected = await runtime.prepare({ schema: "flow.feature-preparation-request/v1", brief: { schema: "flow.feature-brief/v1", id: "brief:accurate-not-run", summary: "Withhold unqualified test release", acceptance: ["no run is created"] }, repository: root, mode: "verify", dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: "flow-release-1.1-dark-test/v1", purpose: "sacrificial_qualification" } });
  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "qualification_withheld");
  assert.deepEqual(runtime.query({}).runs, before.runs);
});

test("fixture qualification cannot rewrite either source release", async () => {
  for (const directory of [config, join(config, "releases/1.1-dark-test")]) {
    await assert.rejects(bindQualifiedReleaseFixture({ configDirectory: directory, repositoryRoot: root }), /disposable copied config/u);
  }
});

test("honest not-run qualification template validates but cannot admit a public route", async (t) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schema = JSON.parse(await readFile(join(config, "schemas/flow.transition-qualification-evidence.v1.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  const historical = JSON.parse(await readFile(join(config, "evidence/release-qualification.v1.json"), "utf8"));
  assert.equal(validate(historical), true, ajv.errorsText(validate.errors));
  const pending = { ...historical, status: "not_run", recipe: null };
  assert.equal(validate(pending), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...pending, status: "passed" }), false);
  assert.equal(validate({ ...historical, status: "not_run" }), false);
  assert.equal(validate({ ...pending, status: "running" }), false);

  const scratch = await mkdtemp(join(tmpdir(), "flow-not-run-release-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const copied = join(scratch, "config");
  await cp(config, copied, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  await writeFile(join(copied, "evidence/release-qualification.v1.json"), JSON.stringify(pending));
  const ledgerPath = join(copied, "transition-ledger.v1.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  Object.assign(ledger.evidence.find(({ id }) => id === "deterministic_qualification"), { status: "not_run", path: null, sha256: null });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await rebindReleaseContentFixture({ configDirectory: copied, repositoryRoot: root });
  const runtime = createFlowRuntime({ env: { HOME: scratch, FLOW_CONFIG_DIRECTORY: copied, FLOW_QUALIFICATION_REPOSITORY_ROOT: root, FLOW_REPOSITORY_ROOT: root }, autonomous: false });
  t.after(() => closeFlowRuntime(runtime));
  const before = runtime.query({});
  const rejected = await runtime.prepare({ schema: "flow.feature-preparation-request/v1", brief: { schema: "flow.feature-brief/v1", id: "brief:not-run", summary: "Withhold unqualified release", acceptance: ["no run is created"] }, repository: root, mode: "verify", dark_opt_in: { schema: "flow.dark-opt-in/v1", release_id: "flow-release-1.0-dark/v1", purpose: "sacrificial_qualification" } });
  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "qualification_withheld");
  assert.deepEqual(runtime.query({}).runs, before.runs);
});
