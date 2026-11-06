import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecutionAdapter as adapter } from "../src/codex-execution-adapter.mjs";
import { executionDescription, directDescriptionIssue } from "../src/execution-contract.mjs";
import { digest } from "../src/canonical.mjs";
import { createDirectDelegatedAgentPort } from "../src/direct-delegated-agent-port.mjs";
import { digestDelegateInputBytes } from "../src/delegate-input-envelope.mjs";

test("direct description checks known workspace ambient authority before executable access", async () => {
  const port = createDirectDelegatedAgentPort({
    env: { HOME: "/fixture/home", PATH: "" },
    executables: { codex: "/fixture/unavailable-executable" },
    providers: { codex: { ...adapter, id: "flow.fixture-codex-exec", nativeQualificationIssue() { return null; },
      authorityIssue({ workspacePath }) {
        return workspacePath === "/fixture/repository" ? "unproved_ambient_authority" : null;
      },
    } },
  });
  const result = await port.describe({
    schema: "flow.delegated-agent-description-request/v1",
    launch: { harness: "codex", model: "fixture", effort: "high", capability: "read-only" },
    caller_metadata: {},
    workspace_path: "/fixture/repository",
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.compatibility.code, "unproved_ambient_authority");
});

test("Codex ambient authority guard rejects system policy with a hermetic filesystem", () => {
  assert.equal(adapter.authorityIssue({
    env: { HOME: "/fixture/home" }, workspacePath: "/fixture/home/dev/repository",
  }, {
    pathExists: (path) => path === "/etc/codex/config.toml",
    canonicalPath: (path) => path,
  }), "unproved_ambient_authority");
});

for (const codexHome of [undefined, "/fixture/selected-codex"]) {
  const home = codexHome ?? "/fixture/home/.codex";
  for (const path of [
    "/etc/codex/config.toml", "/etc/codex/requirements.toml",
    `${home}/requirements.toml`, `${home}/hooks`, `${home}/plugins`,
    "/fixture/home/dev/repository/.codex/config.toml", "/fixture/home/dev/repository/.codex/hooks",
    "/fixture/home/dev/.codex/config.toml", "/fixture/home/dev/.codex/hooks",
    "/fixture/home/.codex/config.toml", "/fixture/home/.codex/hooks",
    "/fixture/.codex/config.toml", "/fixture/.codex/hooks",
    "/.codex/config.toml", "/.codex/hooks",
  ]) {
    test(`Codex ambient authority guard rejects ${path} with ${codexHome ? "explicit" : "default"} home`, () => {
      const env = { HOME: "/fixture/home", ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
      assert.equal(adapter.authorityIssue({ env, workspacePath: "/fixture/link" }, {
        pathExists: (candidate) => candidate === path,
        canonicalPath: () => "/fixture/home/dev/repository",
      }), "unproved_ambient_authority");
    });
  }
}

test("Codex keeps native qualification withheld after absent inventories and stops at filesystem root", () => {
  const checked = [];
  assert.equal(adapter.authorityIssue({
    env: { HOME: "/fixture/home" }, workspacePath: "/fixture/home/dev/repository",
  }, {
    pathExists(path) { checked.push(path); return false; },
    canonicalPath: (path) => path,
  }), "codex_native_policy_unproven");
  assert.equal(checked.filter((path) => path === "/.codex/config.toml").length, 1);
  assert.equal(checked.filter((path) => path === "/.codex/hooks").length, 1);
});

test("direct dispatch rechecks workspace ambient authority after description without reserving or spawning", async (t) => {
  if (process.platform !== "linux") return t.skip("direct containment is Linux-only");
  const scratch = await mkdtemp(join(tmpdir(), "flow-adapter-preflight-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const executable = join(scratch, "codex-fixture");
  const launched = join(scratch, "unexpected-native-launch");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
await import("node:fs").then(fs => fs.writeFileSync(${JSON.stringify(launched)}, "launched"));
`);
  await chmod(executable, 0o700);
  let ambient = false;
  const taskDirectory = join(scratch, "tasks");
  const port = createDirectDelegatedAgentPort({
    env: { HOME: scratch, PATH: process.env.PATH }, taskDirectory,
    executables: { codex: executable },
    resolveWorkspace: () => ({ canonical_path: scratch }),
    providers: { codex: { ...adapter, id: "flow.fixture-codex-exec", nativeQualificationIssue() { return null; },
      authorityIssue(context) {
        const issue = adapter.authorityIssue(context, { canonicalPath: (path) => path,
          pathExists: (path) => ambient && path === join(scratch, ".codex", "config.toml") });
        return issue === "codex_native_policy_unproven" ? null : issue;
      },
    } },
  });
  const described = await port.describe({ schema: "flow.delegated-agent-description-request/v1",
    launch: { harness: "codex", model: "fixture", effort: "high", capability: "read-only" },
    caller_metadata: {}, workspace_path: scratch });
  assert.equal(described.status, "compatible", JSON.stringify(described));
  ambient = true;
  const result = await port.dispatch({ schema: "flow.delegated-agent-dispatch-request/v1",
    caller_key: "attempt:preflight", input_key: "attempt:preflight:input:1", prompt: "exact input",
    payload_sha256: digestDelegateInputBytes("exact input"), description: described.description,
    task_binding: { run_id: "run:preflight", card_id: "card:preflight", effect_id: "effect:preflight",
      attempt_id: "attempt:preflight", workspace_claim: { subject_id: "workspace:preflight" },
      output_contract: { schemas: ["fixture.result/v1"], schema: { type: "object" } } } });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason.code, "unproved_ambient_authority");
  await assert.rejects(stat(taskDirectory), { code: "ENOENT" });
  await assert.rejects(stat(launched), { code: "ENOENT" });
});
const output = '{"schema":"fixture.result/v1","answer":42}';
const events = () => [{ type:"thread.started",thread_id:"thread:fixture" },{type:"turn.started"},
  {type:"item.completed",item:{id:"commentary",type:"agent_message",text:"Checking workspace."}},
  {type:"item.completed",item:{id:"final",type:"agent_message",text:output}},{type:"turn.completed",usage:{}}];
const parse = list => adapter.parseTerminal({stdout:list.map(JSON.stringify).join("\n")+"\n",lastMessage:output,exitCode:0});
test("Codex argv excludes ambient temporary roots and binds only owned scratch", () => {
  const invocation=adapter.buildInvocation({descriptor:{description:{launch:{model:"fixture-model",effort:"high",capability:"workspace-write-denied"},backend:{executable:{path:"/fixture/codex"}}},workspace:{path:"/fixture/workspace"}},taskDirectory:"/fixture/tasks/owned"});
  for (const value of ["sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.exclude_slash_tmp=true", 'sandbox_workspace_write.writable_roots=["/fixture/tasks/owned/scratch"]']) assert.ok(invocation.args.includes(value), value);
});
test("Codex selects terminal last-message after supported commentary", () => { assert.equal(parse(events()).output, output); });
for (const [label, mutate] of [
  ["null event", list=>list.splice(2,0,null)],
  ["object thread id", list=>list[0].thread_id={}],
  ["empty thread id", list=>list[0].thread_id=""],
  ["postterminal thread", list=>list.push({type:"thread.started",thread_id:"another"})],
  ["postterminal turn", list=>list.push({type:"turn.started"})],
  ["postterminal duplicate complete", list=>list.push({type:"turn.completed"})],
  ["early synthetic result", list=>list[2].item.text=output],
]) test(`Codex rejects ${label}`,()=>{const list=events();mutate(list);assert.throws(()=>parse(list));});
test("direct description rejects widened recomputed authority", () => {
  const description=structuredClone(executionDescription({launch:{harness:"codex",model:"fixture",effort:"high",capability:"workspace-write-denied"},callerMetadata:{},backend:{contract:"flow.direct-task/v1",id:"direct",harness:"codex",adapter:"flow.codex-exec",adapter_version:"1",executable:{path:"/fixture",version:"codex-cli 0.160.0",sha256:digest("executable")},native_session_strategy:"fresh_ephemeral"}}));
  description.effective_authority.writable_roots.push("foreign_root");
  description.comparison_keys.effective_authority=digest(description.effective_authority);
  const {description_digest,...identity}=description;description.description_digest=digest(identity);
  assert.equal(directDescriptionIssue(description),"contradictory_execution_description");
});


test("official Codex refuses stale described dispatch before native startup", async (t) => {
  if (process.platform !== "linux") return t.skip("direct containment is Linux-only; this skip is not macOS qualification");
  const { directTaskFixture } = await import("../test-support/direct-task-fixture.mjs");
  const fixture = await directTaskFixture(t);
  const description = executionDescription({
    launch: fixture.request.description.launch, callerMetadata: {},
    backend: { ...fixture.request.description.backend, adapter: adapter.id },
  });
  const port = createDirectDelegatedAgentPort({ ...fixture.options,
    env: { ...fixture.options.env, FLOW_NATIVE_QUALIFICATION_PASSED: "1", FLOW_ALLOW_NATIVE: "1" },
    providers: { codex: adapter },
  });
  const result = await port.dispatch({ ...fixture.request, description });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason.code, "codex_native_policy_unproven");
  await assert.rejects(stat(fixture.options.taskDirectory), { code: "ENOENT" });
  await assert.rejects(stat(join(fixture.scratch, "launches")), { code: "ENOENT" });
});

test("supervised native description is constructor-owned and cannot leak into a strict port", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux supervision only");
  const { directTaskFixture } = await import("../test-support/direct-task-fixture.mjs");
  const fixture = await directTaskFixture(t);
  const executable = fixture.options.executables.codex;
  await writeFile(executable, (await readFile(executable, "utf8")).replace("codex-cli 0.160.0", "codex-cli 0.166.0"));
  const port = createDirectDelegatedAgentPort({ ...fixture.options, providers: { codex: adapter }, executionTrust: "supervised-native-cli" });
  const request = { schema: "flow.delegated-agent-description-request/v1", launch: fixture.request.description.launch, caller_metadata: {} };
  const described = await port.describe(request);
  assert.equal(described.status, "compatible", JSON.stringify(described));
  assert.equal(described.description.backend.executable.version, "codex-cli 0.166.0");
  assert.equal(described.description.effective_authority.network, "not_independently_verified");
  const strict = createDirectDelegatedAgentPort({ ...fixture.options, providers: { codex: adapter }, env: { ...fixture.options.env, FLOW_EXECUTION_TRUST: "supervised-native-cli" } });
  const refused = await strict.dispatch({ ...fixture.request, description: described.description });
  assert.equal(refused.reason.code, "execution_trust_mismatch");
  const injected = await strict.describe({ ...request, launch: { ...request.launch, trust_posture: "supervised-native-cli" } });
  assert.equal(injected.compatibility.code, "request_supplied_execution_trust");
  await assert.rejects(stat(fixture.options.taskDirectory), { code: "ENOENT" });
  const started = await port.dispatch({ ...fixture.request, description: described.description });
  const done = started.status === "completed" ? started : await port.wait({ turn_id: started.task.id, timeout_ms: 5000 });
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.task.receipt.tree_retired, true);
  assert.equal(done.task.descriptor.description.launch.trust_posture, "supervised-native-cli");
  assert.equal(done.task.descriptor.description.backend.adapter_version, "2");
  const nativeBytes = await readFile(join(fixture.options.taskDirectory, done.task.id.slice(5), "native-output-schema.json"), "utf8");
  assert.equal(nativeBytes, done.task.descriptor.native_output_schema_bytes);
  assert.equal(done.task.descriptor.native_output_schema_sha256, "sha256:" + (await import("node:crypto")).createHash("sha256").update(nativeBytes).digest("hex"));
  const argv = done.task.descriptor.invocation.args;
  assert.equal(argv[argv.indexOf("--output-schema") + 1], join(fixture.options.taskDirectory, done.task.id.slice(5), "native-output-schema.json"));
  assert.equal(done.task.descriptor.output_schema_bytes, JSON.stringify((await import("../src/canonical.mjs")).canonicalize(fixture.request.task_binding.output_contract.schema)));
  assert.equal(JSON.parse(done.task.result.text).answer, 42);
  assert.equal((await readFile(join(fixture.scratch, "launches"), "utf8")).trim(), "once");
  const again = await port.dispatch({ ...fixture.request, description: described.description });
  assert.equal(again.status, "completed");
  assert.equal((await readFile(join(fixture.scratch, "launches"), "utf8")).trim(), "once");
});


test("supervised Codex transports full logical schema through a bounded native object envelope", () => {
  const logical = { type: "object", not: { required: ["coverage", "terminal_disposition"] }, properties: { schema: { const: "flow.review-result/v1" } } };
  const description = { launch: { trust_posture: "supervised-native-cli" }, backend: { trust_contract: "flow.supervised-native-cli/v1", adapter_version: "2" } };
  const native = adapter.nativeOutputSchema({ description, logicalSchema: logical });
  assert.deepEqual(Object.keys(native).sort(), ["additionalProperties", "properties", "required", "type"]);
  assert.equal(native.type, "object"); assert.equal(native.additionalProperties, false);
  assert.deepEqual(native.required, ["output_json"]);
  assert.ok(native.properties.output_json.description.includes(JSON.stringify(logical)));
  const wrapped = JSON.stringify({ output_json: output });
  const list = events(); list[list.length - 2].item.text = wrapped;
  const parsed = adapter.parseTerminal({ descriptor: { description }, stdout: list.map(JSON.stringify).join("\n") + "\n", lastMessage: wrapped, exitCode: 0 });
  assert.equal(parsed.output, output);
  for (const invalid of [{ output_json: "not JSON" }, { output_json: "[]" }, { output_json: output, extra: true }, { output_json: "x".repeat(4194305) }]) {
    const raw = JSON.stringify(invalid); const bad = events(); bad[bad.length - 2].item.text = raw;
    assert.throws(() => adapter.parseTerminal({ descriptor: { description }, stdout: bad.map(JSON.stringify).join("\n") + "\n", lastMessage: raw, exitCode: 0 }));
  }
});


test("supervised wire output still fails the original host logical contract", async (t) => {
  const { directTaskFixture } = await import("../test-support/direct-task-fixture.mjs");
  const fixture = await directTaskFixture(t);
  const executable = fixture.options.executables.codex;
  await writeFile(executable, (await readFile(executable, "utf8")).replace("codex-cli 0.160.0", "codex-cli 0.166.0"));
  const port = createDirectDelegatedAgentPort({ ...fixture.options, providers: { codex: adapter }, executionTrust: "supervised-native-cli" });
  const { description } = await port.describe({ schema: "flow.delegated-agent-description-request/v1", launch: fixture.request.description.launch, caller_metadata: {} });
  const contract = structuredClone(fixture.request.task_binding.output_contract);
  contract.schema.not = { properties: { answer: { const: 42 } }, required: ["answer"] };
  const started = await port.dispatch({ ...fixture.request, description, task_binding: { ...fixture.request.task_binding, output_contract: contract } });
  const done = started.task?.receipt ? started : await port.wait({ turn_id: started.task.id, timeout_ms: 5000 });
  assert.equal(done.status, "quarantined"); assert.equal(done.reason.code, "structured_output_invalid");
  assert.equal(done.task.receipt.tree_retired, true);
});

test("wire schema tampering is rejected by the actual worker before native execution and by adoption", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { writeFileSync } = await import("node:fs");
  const { directTaskFixture } = await import("../test-support/direct-task-fixture.mjs");
  const fixture = await directTaskFixture(t);
  const executable = fixture.options.executables.codex;
  await writeFile(executable, (await readFile(executable, "utf8")).replace("codex-cli 0.160.0", "codex-cli 0.166.0"));
  const port = createDirectDelegatedAgentPort({ ...fixture.options, providers: { codex: adapter }, executionTrust: "supervised-native-cli" });
  const { description } = await port.describe({ schema: "flow.delegated-agent-description-request/v1", launch: fixture.request.description.launch, caller_metadata: {} });
  const original = childProcess.spawn;
  const mock = t.mock.method(childProcess, "spawn", function (executable, args, options) {
    if (args[2]?.endsWith("direct-task-worker.py")) writeFileSync(join(args[3], "native-output-schema.json"), "{}");
    return original(executable, args, options);
  });
  syncBuiltinESMExports();
  const request = { ...fixture.request, description };
  try {
    const result = await port.dispatch(request);
    assert.equal(result.status, "blocked");
    // Task IDs hash the caller's bytes, rather than canonical JSON.
    const roots = await (await import("node:fs/promises")).readdir(fixture.options.taskDirectory);
    const root = join(fixture.options.taskDirectory, roots[0]);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { const failure = JSON.parse(await readFile(join(root, "failure.json"))); assert.equal(failure.reason, "native_output_schema_digest_conflict"); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 10)); }
    }
    assert.equal(JSON.parse(await readFile(join(root, "failure.json"))).reason, "native_output_schema_digest_conflict");
    await assert.rejects(stat(join(fixture.scratch, "launches")), { code: "ENOENT" });
    const again = await port.dispatch(request); assert.equal(again.reason.code, "reservation_outcome_unknown");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
