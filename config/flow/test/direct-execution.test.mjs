import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFlowRuntime, closeFlowRuntime } from "../src/runtime.mjs";

test("public direct description pins Codex identity and denies old approval profiles", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-direct-description-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const executable = join(scratch, "codex-fixture");
  await writeFile(executable, '#!/usr/bin/env node\nif(process.argv[2]==="--version") console.log("codex-cli 0.160.0"); else process.exit(99);\n');
  await chmod(executable, 0o700);
  const runtime = createFlowRuntime({
    authorityDirectory: join(scratch, "authority"),
    env: { HOME: scratch, PATH: process.env.PATH },
    executionBackend: "direct",
    directExecutionOptions: { executables: { codex: executable } },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const query = (capability) => runtime.query({
    schema: "flow.query/v1", query: "delegated_agent_description",
    launch: { harness: "codex", model: "gpt-fixture", effort: "high", capability },
    caller_metadata: { owner: "test" },
  });
  const supported = await query("workspace-write-denied");
  assert.equal(supported.status, "compatible", JSON.stringify(supported));
  assert.equal(supported.description.schema, "flow.execution-description/v1");
  assert.equal(supported.description.backend.executable.path, executable);
  assert.equal(supported.description.backend.executable.version, "codex-cli 0.160.0");
  assert.equal(supported.description.effective_authority.approvals, "denied");
  assert.equal(supported.description.effective_authority.network, "disabled");
  assert.equal(supported.description.capabilities.steering, false);
  assert.equal(supported.description.capabilities.session_reuse, false);
  const claude = await runtime.query({schema:"flow.query/v1",query:"delegated_agent_description",launch:{harness:"claude",model:"fixture",effort:"high",capability:"read-only"},caller_metadata:{}});
  assert.equal(claude.status,"blocked");assert.equal(claude.compatibility.code,"claude_native_policy_unproven");
  for (const capability of ["workspace-write", "auto", "on-approve", "unrestricted"]) {
    assert.equal((await query(capability)).status, "blocked");
  }
});

for (const scenario of ["success", "cancel", "restart"]) test(scenario === "cancel" ? "detached public cancellation retires direct task before writer release" : scenario === "restart" ? "detached owner replacement retains direct writer and adopts exactly one task" : "detached public direct feature fixture edits files before an operation commits and seals unknown candidate", async (t) => {
  const cancellation = scenario === "cancel";
  const { execFileSync } = await import("node:child_process");
  const { mkdir, readFile } = await import("node:fs/promises");
  const scratch = await mkdtemp(join(tmpdir(), "flow-direct-feature-"));
  let ownerCleanup = async () => {};
  t.after(async () => { await ownerCleanup(); await rm(scratch, { recursive: true, force: true }); });
  const repository = join(scratch,"repository"); await mkdir(repository);
  const gitEnv={HOME:scratch,PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:join(scratch,".gitconfig")};
  if (scenario === "success") {
    await mkdir(join(scratch,".config","dotfiles"),{recursive:true});
    await writeFile(join(scratch,".gitconfig"),await readFile(new URL("../../git/config",import.meta.url)),{mode:0o600});
    await writeFile(join(scratch,".config","dotfiles","git.local"),'[user]\n name = Private Global Fixture\n email = private-global@example.test\n',{mode:0o600});
  }
  const git=(args)=>execFileSync("/usr/bin/git",["-C",repository,...args],{encoding:"utf8",env:gitEnv}).trim();
  git(["init","--quiet","--initial-branch","main"]);
  if (scenario !== "success") { git(["config","user.name","Flow Fixture"]); git(["config","user.email","flow@example.test"]); }
  await writeFile(join(repository,"feature.txt"),"before\n"); git(["add","feature.txt"]); git(["commit","--quiet","-m","initial"]);
  const initial=git(["rev-parse","HEAD"]);
  const executable=join(scratch,"codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
if(process.argv[2]==="--version"){console.log("codex-cli 0.160.0");process.exit(0);}
const raw=readFileSync(0,"utf8"); const envelope=JSON.parse(raw); const task=envelope.task_inputs;
appendFileSync(${JSON.stringify(join(scratch,"invocations"))},task.phase+"\\n");
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>"sha256:"+createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const evidence={kind:"git_file_equals",target:"feature.txt",expected:"after\\n"};
let output={schema:"flow.delegate-evidence/v1",observation:"owned subprocess evidence"};
if(task.phase==="apply") {if(${scenario !== "success"})while(!existsSync(${JSON.stringify(join(scratch,"release"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);writeFileSync("feature.txt","after\\n");output.feature_evidence={schema:"flow.feature-criterion-evidence/v1",criteria:task.brief.acceptance.map(criterion=>({criterion,...evidence}))};}
else {if(readFileSync("feature.txt","utf8")!=="after\\n")process.exit(17);output.feature_critique={schema:"flow.feature-critique-output/v1",candidate_digest:task.candidate_digest,predecessor_evidence_digest:task.predecessor_evidence_digest,task_inputs_digest:digest(task),criteria:task.brief.acceptance.map(criterion=>({criterion,evidence,evidence_digest:digest({criterion,evidence,verdict:"passed"}),verdict:"passed"})),findings:[]};}
const text=JSON.stringify(output);writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],text);
for(const event of [{type:"thread.started",thread_id:"thread-"+task.phase},{type:"turn.started"},{type:"item.completed",item:{id:"final",type:"agent_message",text}},{type:"turn.completed",usage:{}}])console.log(JSON.stringify(event));
`);
  await chmod(executable,0o700);
  const authorityDirectory=join(scratch,"authority");
  const env={HOME:scratch,PATH:process.env.PATH};
  const production=createFlowRuntime({authorityDirectory,env,directExecutionOptions:{executables:{codex:executable}},autonomous:false});
  const withheld=await production.prepare({schema:"flow.feature-preparation-request/v1",dark_opt_in:{schema:"flow.dark-opt-in/v1",release_id:"flow-release-1.0-dark/v1",purpose:"sacrificial_qualification"},brief:{schema:"flow.feature-brief/v1",id:"brief:qualification",summary:"Pending qualification",acceptance:["not_run"]},repository,mode:"verify",routes:{apply:{harness:"codex",capability:"workspace-write-denied"},critique:{harness:"codex",capability:"read-only"}}});
  assert.equal(withheld.code,"qualification_withheld");closeFlowRuntime(production);
  const { cp } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { bindQualifiedReleaseFixture } = await import("../test-support/qualified-release-fixture.mjs");
  const sourceConfig = fileURLToPath(new URL("..", import.meta.url));
  const sourceRepository = fileURLToPath(new URL("../../..", import.meta.url));
  const configDirectory = join(scratch, "test-config");
  await cp(sourceConfig, configDirectory, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  await bindQualifiedReleaseFixture({ configDirectory, repositoryRoot: sourceRepository });
  const { startFlowOwner, stopFlowOwner } = await import("../src/owner-process.mjs");
  const { requestFlowTransport } = await import("../src/transport.mjs");
  const ownerEnv={...env,FLOW_AUTHORITY_DIRECTORY:authorityDirectory,FLOW_CONFIG_DIRECTORY:configDirectory,FLOW_QUALIFICATION_REPOSITORY_ROOT:sourceRepository,FLOW_EXECUTION_BACKEND:"direct",FLOW_CODEX_EXECUTABLE:executable};
  let owner=await startFlowOwner({env:ownerEnv});
  assert.equal(owner.state,"running");assert.notEqual(owner.pid,process.pid);
  ownerCleanup=async()=>{await writeFile(join(scratch,"release"),"release");await stopFlowOwner({env:ownerEnv,pid:owner.pid,processStartIdentity:owner.process_start_identity,waitMs:3000,force:true});};
  const runtime=Object.fromEntries(["prepare","launch","command","query"].map(operation=>[operation,request=>requestFlowTransport({socketPath:owner.socket_path,operation,request})]));
  const optIn={schema:"flow.dark-opt-in/v1",release_id:"flow-release-1.0-dark/v1",purpose:"sacrificial_qualification"};
  const prepared=await runtime.prepare({schema:"flow.feature-preparation-request/v1",dark_opt_in:optIn,brief:{schema:"flow.feature-brief/v1",id:"brief:direct",summary:"Change feature.txt to after",acceptance:["feature.txt contains after"]},repository,mode:"verify",routes:{apply:{harness:"codex",model:"fixture-model",effort:"high",capability:"workspace-write-denied"},critique:{harness:"codex",model:"fixture-model",effort:"high",capability:"read-only"}}});
  assert.equal(prepared.schema,"flow.prepared-run/v1",JSON.stringify(prepared));
  assert.ok(prepared.graph.cards.some(card=>card.executor.contract==="flow.operation/feature-direct-commit/v1"));
  assert.equal(JSON.stringify(prepared).includes('"candidate_digest"'),false);
  const launch=await runtime.launch({prepared,dark_opt_in:optIn,confirmation:{schema:"flow.predefined-flow-confirmation-decision/v1",decision:"accept",bundle_digest:prepared.bundle_digest,confirmation_digest:prepared.confirmation_digest},closed_facts:{schema:"flow.closed-fact-observation/v1",bundle_digest:prepared.bundle_digest,facts:structuredClone(prepared.explicit_facts)}});
  assert.equal(launch.schema,"flow.launch-receipt/v1",JSON.stringify(launch));
  if (scenario !== "success") {
    const end = Date.now() + 5000;
    while (Date.now() < end && !(await readFile(join(scratch,"invocations"),"utf8").catch(()=>"")).includes("apply")) await new Promise(resolve=>setTimeout(resolve,20));
    if (scenario === "restart") {
      const subject_id=prepared.graph.cards.find(({id})=>id==="feature-direct-commit").inputs.workspace.subject_id;
      const { createDurableRunAuthority } = await import("../../../tools/flow/src/run-authority.mjs");
      const { getWorkspaceAuthority } = await import("../../../tools/flow/src/work-authority.mjs");
      const inspect = createDurableRunAuthority({authorityDirectory,access:"inspect"});
      const workspaceReader=getWorkspaceAuthority({runAuthority:inspect});
      const before=workspaceReader.query({contract:"work.workspace/v1",subject_id});
      assert.ok(before.claims.some(claim=>claim.holder===launch.run_id));
      await stopFlowOwner({env:ownerEnv,pid:owner.pid,processStartIdentity:owner.process_start_identity,waitMs:1000,force:true});
      const previous=owner.pid;owner=await startFlowOwner({env:ownerEnv});assert.notEqual(owner.pid,previous);
      const recovered=workspaceReader.query({contract:"work.workspace/v1",subject_id});
      inspect.close();
      assert.ok(recovered.claims.some(claim=>claim.holder===launch.run_id),JSON.stringify(recovered));
      assert.equal(await readFile(join(scratch,"invocations"),"utf8"),"apply\n");
      await writeFile(join(scratch,"release"),"release");
    }
    if (cancellation) {
    const active=await runtime.query({run_id:launch.run_id});
    const cancel=active.legal_actions.find(({type})=>type==="cancel");assert.ok(cancel,JSON.stringify(active));
    assert.equal((await runtime.command(cancel)).accepted,true);
    }
  }
  let projection;const end=Date.now()+10000;
  do { projection=await runtime.query({run_id:launch.run_id}); if(["succeeded","failed","cancelled"].includes(projection.phase))break; await new Promise(r=>setTimeout(r,20)); } while(Date.now()<end);
  if (cancellation) {
    assert.equal(projection.phase,"cancelled",JSON.stringify(projection));
    assert.equal(git(["rev-parse","HEAD"]),initial);
    assert.equal(await readFile(join(scratch,"invocations"),"utf8"),"apply\n");
    const cancellationEffect=projection.effects.find(effect=>effect.effect_kind==="delegate_cancellation");
    assert.equal(cancellationEffect.receipt.provider_receipt.terminal_disposition.proof,"linux_subreaper_echild");
    assert.equal(cancellationEffect.receipt.provider_receipt.terminal_disposition.retired,true);
    assert.ok(projection.resource_dispositions.every(record=>record.disposition!=="unresolved"));
    return;
  }
  assert.equal(projection.phase,"succeeded",JSON.stringify({phase:projection.phase,cards:projection.cards,effects:projection.effects.map(({card_id,status,last_observation,receipt})=>({card_id,status,last_observation,receipt}))}));
  assert.notEqual(git(["rev-parse","HEAD"]),initial);assert.equal(git(["status","--porcelain"]),"");
  if (scenario === "success") assert.deepEqual(git(["show","-s","--format=%an%x00%ae%x00%cn%x00%ce","HEAD"]).split("\0"),["Private Global Fixture","private-global@example.test","Private Global Fixture","private-global@example.test"]);
  assert.equal(await readFile(join(scratch,"invocations"),"utf8"),"apply\ncritique\n");
  const review=await runtime.query({contract:"work.review/v1",subject_id:projection.review_candidate_reference.candidate_id});
  assert.equal(review.status,"sealed");assert.equal(review.candidate.git.clean,true);
  assert.equal(review.candidate.verification.acceptance_criteria[0].verdict,"passed");
  assert.equal(review.candidate.critique.delegate_evidence.card_id,"feature-critique");
  assert.equal(projection.handoffs.length,1);
  console.log(JSON.stringify({fixture_candidate:{initial,commit:git(["rev-parse","HEAD"]),tree:git(["rev-parse","HEAD^{tree}"]),review:review.candidate_id,reference:projection.review_candidate_reference,handoffs:projection.handoffs}}));
});
