import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    providers: { codex: { ...adapter,
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

test("Codex ambient authority guard permits absent inventories and stops at filesystem root", () => {
  const checked = [];
  assert.equal(adapter.authorityIssue({
    env: { HOME: "/fixture/home" }, workspacePath: "/fixture/home/dev/repository",
  }, {
    pathExists(path) { checked.push(path); return false; },
    canonicalPath: (path) => path,
  }), null);
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
    providers: { codex: { ...adapter,
      authorityIssue(context) {
        return adapter.authorityIssue(context, { canonicalPath: (path) => path,
          pathExists: (path) => ambient && path === join(scratch, ".codex", "config.toml") });
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
