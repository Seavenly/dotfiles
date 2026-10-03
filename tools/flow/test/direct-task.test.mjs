import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createDirectDelegatedAgentPort } from "../src/direct-delegated-agent-port.mjs";
import { digest } from "../src/canonical.mjs";
import { digestDelegateInputBytes } from "../src/delegate-input-envelope.mjs";

test("direct task keeps exact stdin and output and adopts duplicate dispatch once", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-direct-task-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const executable = join(scratch, "codex");
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
if(process.argv[2]==="--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
const input=readFileSync(0,"utf8"); writeFileSync(${JSON.stringify(join(scratch, "input"))},input); appendFileSync(${JSON.stringify(join(scratch, "launches"))},"once\\n");
const output=JSON.stringify({schema:"fixture.result/v1",answer:42});
writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],output);
for(const event of [{type:"thread.started",thread_id:"thread-fixture"},{type:"turn.started"},{type:"item.completed",item:{id:"final",type:"agent_message",text:output}},{type:"turn.completed",usage:{}}]) console.log(JSON.stringify(event));
`);
  await chmod(executable, 0o700);
  const port = createDirectDelegatedAgentPort({ env: { HOME: scratch, PATH: process.env.PATH },
    executables: { codex: executable }, taskDirectory: join(scratch, "tasks"),
    resolveWorkspace: () => ({ canonical_path: scratch }) });
  const { description } = await port.describe({schema:"flow.delegated-agent-description-request/v1",
    launch:{harness:"codex",model:"fixture-model",effort:"high",capability:"read-only"},caller_metadata:{}});
  const prompt = 'exact bytes $(echo unsafe) `literal`\nUnicode: λ\n';
  const outputSchema = {type:"object",additionalProperties:false,required:["schema","answer"],properties:{schema:{const:"fixture.result/v1"},answer:{type:"integer"}}};
  const request = {schema:"flow.delegated-agent-dispatch-request/v1",agent_id:"agent:test",caller_key:"attempt:one",input_key:"attempt:one:input:1",prompt,payload_sha256:digestDelegateInputBytes(prompt),description,
    task_binding:{run_id:"run:one",card_id:"card:one",attempt_id:"attempt:one",effect_id:"effect:one",workspace_claim:{subject_id:"workspace:one",generation:1,mutation_epoch:0,fingerprint:digest({initial:true}),access:"read_only"},output_contract:{schemas:["fixture.result/v1"],schema:outputSchema}}};
  const requests = await Promise.all([port.dispatch(request),port.dispatch(request)]);
  assert.ok(requests[0].task,JSON.stringify(requests));
  assert.ok(requests[1].task,JSON.stringify(requests));
  assert.equal(requests[0].task.id,requests[1].task.id);
  const result = await port.wait({schema:"flow.delegated-agent-wait-request/v1",turn_id:requests[0].task.id,timeout_ms:5000});
  assert.equal(result.status,"completed",JSON.stringify(result));
  assert.equal(result.task.result.text,'{"answer":42,"schema":"fixture.result/v1"}');
  assert.equal(result.task.settlement_proof.schema,"flow.task-settlement-proof/v1");
  assert.equal(await readFile(join(scratch,"input"),"utf8"),prompt);
  assert.equal(await readFile(join(scratch,"launches"),"utf8"),"once\n");
  const conflict = await port.dispatch({...request,prompt:"changed",payload_sha256:digestDelegateInputBytes("changed")});
  assert.equal(conflict.status,"blocked");
  assert.equal(conflict.reason.code,"caller_key_conflict");
});

import { directTaskFixture, directTaskFailureFixture } from "../test-support/direct-task-fixture.mjs";
import childProcess, { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execFile = promisify(execFileCallback);

test("direct reservation publication faults block before any worker or provider spawn", async (t) => {
  for (const boundary of ["hierarchy", "reservation"]) {
    await t.test(boundary, async (t) => {
      const fixture = await directTaskFixture(t);
      fixture.options.taskDirectory = join(fixture.scratch, "state", "direct", "tasks");
      const port = fixture.freshPort();
      const target = boundary === "hierarchy" ? fixture.scratch : fixture.options.taskDirectory;
      const fsync = filesystem.fsyncSync;
      let faults = 0;
      const mocked = t.mock.method(filesystem, "fsyncSync", (fd) => {
        if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === target) {
          faults += 1;
          throw Object.assign(new Error("publication_failed"), { code: "EIO" });
        }
        return fsync(fd);
      });
      syncBuiltinESMExports();
      let result;
      try { result = await port.dispatch(fixture.request); }
      finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(faults, 1, "the publication boundary must be synced before spawn");
      assert.equal(result.status, "blocked", JSON.stringify(result));
      await assert.rejects(readFile(join(fixture.scratch, "launches")), { code: "ENOENT" });
      const root = join(fixture.options.taskDirectory, digestBytesKey(fixture.request.caller_key));
      await assert.rejects(readFile(join(root, "worker.json")), { code: "ENOENT" });
      if (boundary === "reservation") {
        assert.equal((await port.dispatch(fixture.request)).status, "blocked");
        await assert.rejects(readFile(join(fixture.scratch, "launches")), { code: "ENOENT" });
      }
    });
  }
});

function digestBytesKey(key) { return digestDelegateInputBytes(key).slice(7); }

test("exact worker binding and blocked observations refuse adoption and cancellation intent", async (t) => {
  const corruptions = [
    ["missing schema", (record) => { delete record.schema; }],
    ["conflicting schema", (record) => { record.schema = "foreign.worker/v1"; }],
    ["missing containment", (record) => { delete record.containment; }],
    ["conflicting containment", (record) => { record.containment = "process_group"; }],
    ["missing descriptor binding", (record) => { delete record.descriptor_digest; }],
    ["conflicting descriptor binding", (record) => { record.descriptor_digest = digest({ foreign: true }); }],
    ["before spawn", (record) => { record.stage = "before_spawn"; }],
    ["failure observation", () => {}],
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async (t) => {
      const fixture = await directTaskFixture(t, "wait");
      const dispatched = await fixture.port.dispatch(fixture.request);
      assert.equal(dispatched.status, "still_running");
      const root = join(fixture.options.taskDirectory, dispatched.task.id.slice(5));
      const workerPath = join(root, "worker.json");
      const exact = JSON.parse(await readFile(workerPath, "utf8"));
      const changed = structuredClone(exact);
      corrupt(changed);
      let observations;
      let intentAbsent;
      let childAlive;
      try {
        await writeFile(workerPath, JSON.stringify(changed));
        if (name === "failure observation") await writeFile(join(root, "failure.json"), JSON.stringify({ schema: "flow.task-failure/v1", reason: "fixture_failure" }));
        const recovered = fixture.freshPort();
        observations = [
          await recovered.observe({ turn_id: dispatched.task.id }),
          await recovered.discover({ caller_key: fixture.request.caller_key, description: fixture.request.description }),
          await recovered.dispatch(fixture.request),
          await recovered.cancel({ turn_id: dispatched.task.id }),
        ];
        intentAbsent = !filesystem.existsSync(join(root, "cancel.json"));
        try { process.kill(exact.child.pid, 0); childAlive = true; } catch { childAlive = false; }
      } finally {
        await writeFile(workerPath, JSON.stringify(exact));
        await rm(join(root, "failure.json"), { force: true });
        await fixture.release();
        await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 });
      }
      assert.deepEqual(observations.map(({ status }) => status), ["blocked", "blocked", "blocked", "blocked"]);
      assert.equal(intentAbsent, true, "blocked cancellation must persist no intent");
      assert.equal(childAlive, true, "blocked cancellation must signal no process");
      assert.equal(await readFile(join(fixture.scratch, "launches"), "utf8"), "once\n");
      assert.equal((await fixture.port.observe({ turn_id: dispatched.task.id })).status, "completed");
    });
  }
});

for (const mode of ["malformed", "nonterminal", "failure", "duplicate_final"]) {
  test(`direct task quarantines ${mode} provider output without success`, async (t) => {
    const fixture = await directTaskFixture(t, mode);
    const dispatched = await fixture.port.dispatch(fixture.request);
    assert.ok(dispatched.task?.id, JSON.stringify(dispatched));
    const result = await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 });
    assert.equal(result.status, "quarantined", JSON.stringify(result));
    assert.equal(result.task.result, null);
    assert.equal(result.task.receipt.tree_retired, true);
  });
}

test("owned task survives launch-client exit and a fresh process adopts exact invocation", async (t) => {
  const fixture = await directTaskFixture(t, "wait");
  const requestPath = join(fixture.scratch,"request.json");
  await writeFile(requestPath, JSON.stringify(fixture.request));
  const module = fileURLToPath(new URL("../src/direct-delegated-agent-port.mjs",import.meta.url));
  const clientCode = `import {readFileSync} from "node:fs";import {createDirectDelegatedAgentPort} from ${JSON.stringify(module)};
const request=JSON.parse(readFileSync(${JSON.stringify(requestPath)},"utf8"));
const port=createDirectDelegatedAgentPort({env:${JSON.stringify(fixture.options.env)},executables:${JSON.stringify(fixture.options.executables)},taskDirectory:${JSON.stringify(fixture.options.taskDirectory)},resolveWorkspace:()=>({canonical_path:${JSON.stringify(fixture.scratch)}})});
console.log(JSON.stringify(await port.dispatch(request)));process.exit(0);`;
  const launched = JSON.parse((await execFile(process.execPath,["--input-type=module","-e",clientCode])).stdout);
  assert.equal(launched.status,"still_running");
  const recovered=fixture.freshPort();
  const adopted=await recovered.dispatch(fixture.request);
  assert.equal(adopted.task.id,launched.task.id);assert.equal(adopted.task.descriptor_digest,launched.task.descriptor_digest);
  await fixture.release();
  const completed=await recovered.wait({turn_id:adopted.task.id,timeout_ms:3000});
  assert.equal(completed.status,"completed",JSON.stringify(completed));
  assert.equal(await readFile(join(fixture.scratch,"launches"),"utf8"),"once\n");
});

test("double-fork setsid descendant prevents retirement until worker cancels and reaps exact tree", async (t) => {
  const fixture=await directTaskFixture(t,"descendant");
  const dispatched=await fixture.port.dispatch(fixture.request);
  const pending=await fixture.port.wait({turn_id:dispatched.task.id,timeout_ms:150});
  assert.equal(pending.status,"still_running",JSON.stringify(pending));
  const descendant=Number(await readFile(join(fixture.scratch,"descendant-pid"),"utf8"));
  assert.doesNotThrow(()=>process.kill(descendant,0));
  const cancelled=await fixture.port.cancel({turn_id:dispatched.task.id});
  assert.equal(cancelled.status,"cancelled",JSON.stringify(cancelled));
  assert.equal(cancelled.task.receipt.tree_retired,true);assert.equal(cancelled.task.result,null);
  assert.equal((await fixture.port.cancel({turn_id:dispatched.task.id})).status,"cancelled");
  assert.throws(()=>process.kill(descendant,0),/ESRCH/u);
});

test("missing terminal receipt remains uncertain after owner loss and never replays", async (t) => {
  const fixture=await directTaskFixture(t);
  const dispatched=await fixture.port.dispatch(fixture.request);
  const completed=await fixture.port.wait({turn_id:dispatched.task.id,timeout_ms:3000});
  assert.equal(completed.status,"completed");
  await rm(join(fixture.options.taskDirectory,dispatched.task.id.slice(5),"receipt.json"));
  const recovered=fixture.freshPort();
  const adopted=await recovered.dispatch(fixture.request);
  assert.equal(adopted.status,"blocked");assert.equal(adopted.reason.code,"process_identity_uncertain");
  assert.equal(await readFile(join(fixture.scratch,"launches"),"utf8"),"once\n");
});

test("boot or process-start ambiguity blocks cancellation without signalling the task", async (t) => {
  const fixture=await directTaskFixture(t,"wait");
  const dispatched=await fixture.port.dispatch(fixture.request);
  const path=join(fixture.options.taskDirectory,dispatched.task.id.slice(5),"worker.json");
  const exact=JSON.parse(await readFile(path,"utf8"));
  await writeFile(path,JSON.stringify({...exact,identity:{...exact.identity,boot:"other-boot"}}));
  const rejected=await fixture.port.cancel({turn_id:dispatched.task.id});
  assert.equal(rejected.reason.code,"process_identity_uncertain");
  assert.doesNotThrow(()=>process.kill(exact.child.pid,0));
  await writeFile(path,JSON.stringify(exact));
  const cancelled=await fixture.port.cancel({turn_id:dispatched.task.id});
  assert.equal(cancelled.status,"cancelled");
});

test("task supervision pins isolated Python and ignores hostile sitecustomize", async (t) => {
  const fixture = await directTaskFixture(t);
  await writeFile(join(fixture.scratch, "sitecustomize.py"), `from pathlib import Path\nPath(${JSON.stringify(join(fixture.scratch, "unexpected-python-code"))}).write_text('executed')\n`);
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = fixture.scratch;
  let dispatched;
  try { dispatched = await fixture.port.dispatch(fixture.request); }
  finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
  const result = await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.task.descriptor.supervision.args, ["-I", "-S"]);
  assert.equal(result.task.descriptor.supervision.signal_identity, "linux_pidfd");
  assert.ok(result.task.descriptor.supervision.executable.startsWith("/usr/bin/python"));
  await assert.rejects(readFile(join(fixture.scratch, "unexpected-python-code")), { code: "ENOENT" });
});

test("cancellation uses owned process handles and leaves an unrelated owned test child alive", async (t) => {
  const { spawn } = await import("node:child_process");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  t.after(() => unrelated.kill());
  const fixture = await directTaskFixture(t, "descendant");
  const dispatched = await fixture.port.dispatch(fixture.request);
  const result = await fixture.port.cancel({ turn_id: dispatched.task.id });
  assert.equal(result.status, "cancelled", JSON.stringify(result));
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("cancellation ancestry snapshot rejects reuse before pidfd validation without signalling", async () => {
  const workerPath = fileURLToPath(new URL("../src/direct-task-worker.py", import.meta.url));
  const code = `import ast, pathlib, os, signal, select\nsource=ast.parse(pathlib.Path(${JSON.stringify(workerPath)}).read_text())\nfunctions=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in ['identity','snapshot','handle_alive','owned_handles']]\nexec(compile(ast.Module(body=functions,type_ignores=[]),'worker-helpers','exec'))\nparent={'pid':1,'start':'original-parent','group':1,'boot':'boot'}\nexpected={'pid':2,'start':'original-child','group':2,'boot':'boot'}\nforeign={**expected,'start':'reused-child'}\nclass Entry:\n name='2'\nclass Proc:\n def iterdir(self):return [Entry()]\npathlib.Path=lambda _:Proc()\nidentity=lambda pid:parent if pid==1 else foreign\nsnapshots=iter([(expected,1),(foreign,1)])\nsnapshot=lambda pid:next(snapshots)\nopened=[];closed=[]\nos.pidfd_open=lambda pid,flags:opened.append(pid) or 42\nos.close=lambda fd:closed.append(fd)\nassert owned_handles(parent)==[]\nassert opened==[2] and closed==[42]\nhandle_alive=lambda handle:False\nassert owned_handles(parent,42)==[]\nprint('reused child identity and dead ancestor handle rejected; no signal invoked')\n`;
  const result = await execFile("/usr/bin/python3", ["-I", "-S", "-c", code]);
  assert.match(result.stdout, /no signal invoked/u);
});

test("direct description, immutable descriptor, observations and positive receipt satisfy source schemas", async (t) => {
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const ajv = new Ajv({ strict: true, allErrors: true });
  const names = ["flow.execution-description.v1", "flow.execution-description-projection.v1", "flow.task-invocation.v1", "flow.task-observation.v1", "flow.task-settlement-proof.v1", "flow.task-terminal-receipt.v1"];
  for (const name of names) ajv.addSchema(JSON.parse(await readFile(new URL(`../../../config/flow/schemas/${name}.schema.json`, import.meta.url), "utf8")));
  const fixture = await directTaskFixture(t);
  const projected = await fixture.port.describe({schema:"flow.delegated-agent-description-request/v1",launch:fixture.request.description.launch,caller_metadata:{}});
  const dispatched = await fixture.port.dispatch(fixture.request);
  const result = await fixture.port.wait({turn_id:dispatched.task.id,timeout_ms:3000});
  assert.equal(result.status,"completed",JSON.stringify(result));
  for (const [name,value] of [[names[0],fixture.request.description],[names[1],projected],[names[2],result.task.descriptor],[names[3],result],[names[4],result.task.settlement_proof],[names[5],result.task.receipt]]) {
    assert.equal(ajv.validate(`https://dotfiles.local/schemas/${name}.schema.json`, value),true,`${name}: ${ajv.errorsText()}`);
  }
});

test("attempt identity refuses changed model, effort, workspace, schema and executable binding without a second launch", async (t) => {
  const fixture=await directTaskFixture(t);
  const dispatched=await fixture.port.dispatch(fixture.request);
  assert.equal((await fixture.port.wait({turn_id:dispatched.task.id,timeout_ms:3000})).status,"completed");
  for (const launch of [{...fixture.request.description.launch,model:"changed-model"},{...fixture.request.description.launch,effort:"medium"}]) {
    const {description}=await fixture.port.describe({schema:"flow.delegated-agent-description-request/v1",launch,caller_metadata:{}});
    assert.equal((await fixture.port.dispatch({...fixture.request,description})).reason.code,"caller_key_conflict");
  }
  const changedWorkspace=structuredClone(fixture.request);changedWorkspace.task_binding.workspace_claim.mutation_epoch=1;
  assert.equal((await fixture.port.dispatch(changedWorkspace)).reason.code,"caller_key_conflict");
  const changedSchema=structuredClone(fixture.request);changedSchema.task_binding.output_contract.schema.properties.answer.minimum=10;
  assert.equal((await fixture.port.dispatch(changedSchema)).reason.code,"caller_key_conflict");
  const executable=fixture.options.executables.codex;
  await writeFile(executable,(await readFile(executable,"utf8"))+"\n# executable drift\n");
  assert.equal((await fixture.port.dispatch(fixture.request)).status,"completed");
  const { description } = await fixture.port.describe({schema:"flow.delegated-agent-description-request/v1",launch:fixture.request.description.launch,caller_metadata:{}});
  assert.equal((await fixture.port.dispatch({...fixture.request,description})).reason.code,"caller_key_conflict");
  assert.equal(await readFile(join(fixture.scratch,"launches"),"utf8"),"once\n");
});

test("exact reservation recovery adopts stored invocation before ambient spawn probes", async (t) => {
  for (const mode of ["complete", "wait"]) {
    await t.test(mode, async (t) => {
      const fixture = await directTaskFixture(t, mode);
      const dispatched = await fixture.port.dispatch(fixture.request);
      const original = mode === "complete" ? await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 }) : dispatched;
      await writeFile(fixture.options.executables.codex, (await readFile(fixture.options.executables.codex, "utf8")) + "\n# ambient executable update\n");
      const recovered = createDirectDelegatedAgentPort({ ...fixture.options,
        env: { HOME: join(fixture.scratch, "other-home"), PATH: fixture.options.env.PATH + ":/different-owner-path", CODEX_HOME: join(fixture.scratch, "other-codex") },
        resolveWorkspace: () => { throw new Error("ambient_workspace_lookup"); },
      });
      let adopted;
      try { adopted = await recovered.dispatch(fixture.request); }
      finally { await fixture.release(); await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 }); }
      assert.equal(adopted.status, original.status, JSON.stringify(adopted));
      assert.equal(adopted.task.descriptor_digest, original.task.descriptor_digest);
      assert.deepEqual(adopted.task.descriptor, original.task.descriptor);
      assert.equal((await recovered.discover({ caller_key: fixture.request.caller_key, description: fixture.request.description })).status, "completed");
      const fresh = structuredClone(fixture.request);
      fresh.caller_key = fresh.task_binding.attempt_id = "attempt:fresh";
      fresh.input_key = "attempt:fresh:input:1";
      assert.equal((await recovered.dispatch(fresh)).reason.code, "executable_identity_changed", "fresh spawn retains ambient preflight");
      assert.equal(await readFile(join(fixture.scratch, "launches"), "utf8"), "once\n");
    });
  }
});

test("stored recovery preserves owner, input, descriptor integrity and terminal worker binding", async (t) => {
  const fixture = await directTaskFixture(t);
  const dispatched = await fixture.port.dispatch(fixture.request);
  assert.equal((await fixture.port.wait({ turn_id: dispatched.task.id, timeout_ms: 3000 })).status, "completed");
  for (const field of ["run_id", "card_id", "effect_id"]) {
    const changed = structuredClone(fixture.request);
    changed.task_binding[field] = "foreign:owner";
    assert.equal((await fixture.port.dispatch(changed)).reason.code, "caller_key_conflict");
  }
  assert.equal((await fixture.port.dispatch({ ...fixture.request, input_key: "foreign:input" })).reason.code, "caller_key_conflict");
  const root = join(fixture.options.taskDirectory, dispatched.task.id.slice(5));
  const descriptorPath = join(root, "descriptor.json");
  const descriptorBytes = await readFile(descriptorPath);
  const damaged = JSON.parse(descriptorBytes);
  damaged.run_id = "foreign:owner";
  await writeFile(descriptorPath, JSON.stringify(damaged));
  assert.equal((await fixture.port.dispatch(fixture.request)).reason.code, "reservation_outcome_unknown");
  await writeFile(descriptorPath, descriptorBytes);
  const inputPath = join(root, "input.bin");
  const inputBytes = await readFile(inputPath);
  await writeFile(inputPath, "damaged input");
  assert.equal((await fixture.port.dispatch(fixture.request)).reason.code, "reservation_outcome_unknown");
  await writeFile(inputPath, inputBytes);
  const workerPath = join(root, "worker.json");
  const workerBytes = await readFile(workerPath);
  const worker = JSON.parse(workerBytes);
  worker.descriptor_digest = digest({ foreign: true });
  await writeFile(workerPath, JSON.stringify(worker));
  assert.equal((await fixture.port.observe({ turn_id: dispatched.task.id })).reason.code, "worker_binding_conflict");
  assert.equal((await fixture.port.cancel({ turn_id: dispatched.task.id })).status, "blocked");
  await assert.rejects(readFile(join(root, "cancel.json")), { code: "ENOENT" });
  await writeFile(workerPath, workerBytes);
  assert.equal((await fixture.port.dispatch(fixture.request)).status, "completed");
  assert.equal(await readFile(join(fixture.scratch, "launches"), "utf8"), "once\n");
});

test("direct discovery proves absence only for a valid direct backend description", async (t) => {
  const fixture = await directTaskFixture(t);
  const foreign = structuredClone(fixture.request.description);
  foreign.backend.id = "drovr";
  for (const description of [undefined, { schema: "drovr.delegated-agent-description/v1" }, foreign]) {
    const observed = await fixture.port.discover({ caller_key: fixture.request.caller_key, description });
    assert.equal(observed.status, "blocked", JSON.stringify(observed));
  }
  assert.equal((await fixture.port.discover({ caller_key: fixture.request.caller_key, description: fixture.request.description })).status, "proven_absent");
  await assert.rejects(readFile(join(fixture.scratch, "launches")), { code: "ENOENT" });
});

test("worker failure retires its exact owned tree even when failure persistence fails", async (t) => {
  const unrelated = childProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  t.after(() => unrelated.kill());
  for (const fault of ["cancellation_conflict", "running_record"]) {
    for (const failPersistence of [false, true]) {
      await t.test(`${fault} persistence=${!failPersistence}`, async (t) => {
        const fixture = await directTaskFailureFixture(t, fault, failPersistence);
        const spawn = childProcess.spawn;
        const mocked = t.mock.method(childProcess, "spawn", (executable, args, options) =>
          spawn(executable, ["-I", "-S", fixture.wrapper, args[2], args[3]], options));
        syncBuiltinESMExports();
        let dispatched;
        try { dispatched = await fixture.port.dispatch(fixture.request); }
        finally { mocked.mock.restore(); syncBuiltinESMExports(); }
        const deadline = Date.now() + 5000;
        const reportPath = join(fixture.scratch, "failure-report.json");
        while (!filesystem.existsSync(reportPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.equal(report.wrapper_echild, true, "baseline isolation must positively reap every owned descendant");
        assert.equal(report.retired_before_wrapper, true, "the production worker must reap its tree before exiting on failure");
        assert.ok(report.production_kills > 0, "TERM-resistant descendants require bounded pidfd escalation");
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
        const root = join(fixture.options.taskDirectory, digestBytesKey(fixture.request.caller_key));
        const observed = await fixture.port.wait({ turn_id: `task:${digestBytesKey(fixture.request.caller_key)}`, timeout_ms: 3000 });
        assert.equal(observed.status, "blocked", JSON.stringify({ dispatched, observed }));
        await assert.rejects(readFile(join(root, "receipt.json")), { code: "ENOENT" });
        assert.equal((await fixture.freshPort().dispatch(fixture.request)).status, "blocked");
        assert.equal(await readFile(join(fixture.scratch, "launches"), "utf8"), "once\n");
      });
    }
  }
});

test("terminal output durability precedes receipt publication and sync faults retain uncertainty", async (t) => {
  const cases = [
    { fault: "output_order", mode: "complete", status: "completed" },
    ...["stdout.bin", "stderr.bin", "last-message.json"].map((name) => ({ fault: `output_sync_${name}`, mode: "complete", status: "blocked" })),
    { fault: "output_sync_last-message.json", mode: "complete", failPersistence: true, status: "blocked" },
    { fault: "missing_result", mode: "complete_without_result", status: "blocked" },
    { fault: "provider_failure", mode: "failure_without_result", status: "quarantined" },
    { fault: "cancellation_without_result", mode: "wait", status: "cancelled" },
  ];
  for (const { fault, mode, failPersistence = false, status } of cases) {
    await t.test(`${fault} persistence=${!failPersistence}`, async (t) => {
      const fixture = await directTaskFailureFixture(t, fault, failPersistence, mode);
      const spawn = childProcess.spawn;
      const mocked = t.mock.method(childProcess, "spawn", (executable, args, options) =>
        spawn(executable, ["-I", "-S", fixture.wrapper, args[2], args[3]], options));
      syncBuiltinESMExports();
      let dispatched;
      try { dispatched = await fixture.port.dispatch(fixture.request); }
      finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      const reportPath = join(fixture.scratch, "failure-report.json");
      const deadline = Date.now() + 5000;
      while (!filesystem.existsSync(reportPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.wrapper_echild, true, "fixture isolation must positively retire every owned child");
      assert.equal(report.retired_before_wrapper, true, "the worker must prove retirement before leaving the output boundary");
      const id = `task:${digestBytesKey(fixture.request.caller_key)}`;
      const root = join(fixture.options.taskDirectory, id.slice(5));
      const observed = await fixture.freshPort().wait({ turn_id: id, timeout_ms: 3000 });
      assert.equal(observed.status, status, JSON.stringify({ dispatched, observed }));
      if (status === "blocked") {
        await assert.rejects(readFile(join(root, "receipt.json")), { code: "ENOENT" });
        assert.equal((await fixture.freshPort().dispatch(fixture.request)).status, "blocked");
      } else {
        const receipt = report.events.findIndex(({ event }) => event === "receipt");
        const echild = report.events.findIndex(({ event }) => event === "echild");
        for (const name of status === "completed" ? ["stdout.bin", "stderr.bin", "last-message.json"] : ["stdout.bin", "stderr.bin"]) {
          const synced = report.events.findIndex((entry) => entry.event === "sync" && entry.name === name);
          assert.ok(echild >= 0 && synced > echild && receipt > synced, `${name} must be durable after ECHILD and before the terminal receipt`);
          const read = report.events.findIndex((entry) => entry.event === "read" && entry.name === name);
          if (read >= 0) assert.ok(read > synced, `${name} must be synced before hashing`);
        }
        assert.equal(observed.task.receipt.tree_retired, true);
        if (status !== "completed") {
          assert.equal(observed.task.result, null);
          await assert.rejects(readFile(join(root, "last-message.json")), { code: "ENOENT" });
        }
      }
      assert.equal(await readFile(join(fixture.scratch, "launches"), "utf8"), "once\n");
    });
  }
});
