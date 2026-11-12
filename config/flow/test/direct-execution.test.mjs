import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFlowRuntime, closeFlowRuntime } from "../src/runtime.mjs";

import { claudeExecutionAdapter } from "../../../tools/flow/src/claude-execution-adapter.mjs";
import { fixtureCodexAdapter } from "../test-support/direct-feature-test-runtime.mjs";

const linuxTaskMechanism = { skip: process.platform !== "linux" &&
  "Linux subreaper/pidfd task containment is unsupported on this host; this skip is not macOS qualification" };

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
    directExecutionOptions: { executables: { codex: executable }, providers: { codex: fixtureCodexAdapter, claude: claudeExecutionAdapter } },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const query = (capability) => runtime.query({
    schema: "flow.query/v1", query: "delegated_agent_description",
    launch: { harness: "codex", model: "gpt-fixture", effort: "high", capability },
    caller_metadata: { owner: "test" },
  });
  const supported = await query("read-only");
  assert.equal(supported.status, "compatible", JSON.stringify(supported));
  assert.equal(supported.description.schema, "flow.execution-description/v1");
  assert.equal(supported.description.backend.executable.path, executable);
  assert.equal(supported.description.backend.executable.version, "codex-cli 0.160.0");
  assert.equal(supported.description.effective_authority.approvals, "denied");
  assert.equal(supported.description.effective_authority.network, "disabled");
  assert.equal(supported.description.capabilities.steering, false);
  assert.equal(supported.description.capabilities.session_reuse, false);
  const mutation = await query("workspace-write-denied");
  if (process.platform === "linux") {
    assert.equal(mutation.status, "compatible", JSON.stringify(mutation));
    assert.equal(mutation.description.effective_authority.approvals, "denied");
    assert.equal(mutation.description.effective_authority.network, "disabled");
  } else {
    assert.equal(mutation.status, "blocked");
    assert.equal(mutation.compatibility.code, "direct_mutation_containment_unsupported");
  }
  const claude = await runtime.query({schema:"flow.query/v1",query:"delegated_agent_description",launch:{harness:"claude",model:"fixture",effort:"high",capability:"read-only"},caller_metadata:{}});
  assert.equal(claude.status,"blocked");assert.equal(claude.compatibility.code,"claude_native_policy_unproven");
  for (const capability of ["workspace-write", "auto", "on-approve", "unrestricted"]) {
    assert.equal((await query(capability)).status, "blocked");
  }
  for (const query of ["push", "merge", "remote_mutation"]) {
    const rejected = await runtime.query({ schema: "flow.query/v1", query });
    assert.equal(rejected.schema, "flow.rejection/v1");
    assert.equal(rejected.code, "unsupported_query");
  }
});

for (const scenario of ["success", "cancel", "restart"]) test(scenario === "cancel" ? "detached public cancellation retains its writer through affirmative task retirement" : scenario === "restart" ? "detached owner replacement retains direct writer and adopts exactly one task" : "detached public direct feature fixture edits files before an operation commits and seals unknown candidate", linuxTaskMechanism, async (t) => {
  const cancellation = scenario === "cancel";
  const { execFileSync } = await import("node:child_process");
  const { mkdir, readFile, readdir } = await import("node:fs/promises");
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
if(${cancellation})process.on("SIGTERM",()=>{});
const raw=readFileSync(0,"utf8"); const envelope=JSON.parse(raw); const task=envelope.task_inputs;
appendFileSync(${JSON.stringify(join(scratch,"invocations"))},(task.phase ?? task.role)+"\\n");
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>"sha256:"+createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const evidence={kind:"git_file_equals",target:"feature.txt",expected:"after\\n"};
let output={schema:"flow.delegate-evidence/v1",observation:"owned subprocess evidence"};
if(task.flow==="review/v1") {
 if(existsSync(${JSON.stringify(join(scratch,"parallel-mode"))})) {
  const mode=readFileSync(${JSON.stringify(join(scratch,"parallel-mode"))},"utf8");
  const prefix=${JSON.stringify(scratch)}+"/parallel-"+mode;
  appendFileSync(prefix+"-events",task.role+":"+(task.lens??"critic")+"\\n");
  writeFileSync(prefix+"-"+(task.lens??"critic")+"-input.json",JSON.stringify(envelope));
  if(task.role==="lens") while(!existsSync(prefix+"-release-"+task.lens)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 output={schema:"flow.review-result/v1",findings:[],posture:"no_findings",coverage:"produced"};
}
else if(task.phase==="apply") {if(${scenario !== "success"})while(!existsSync(${JSON.stringify(join(scratch,"release"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);writeFileSync("feature.txt","after\\n");output.feature_evidence={schema:"flow.feature-criterion-evidence/v1",criteria:task.brief.acceptance.map(criterion=>({criterion,...evidence}))};}
else {if(readFileSync("feature.txt","utf8")!=="after\\n")process.exit(17);output.feature_critique={schema:"flow.feature-critique-output/v1",candidate_digest:task.candidate_digest,predecessor_evidence_digest:task.predecessor_evidence_digest,task_inputs_digest:digest(task),criteria:task.brief.acceptance.map(criterion=>({criterion,evidence,evidence_digest:digest({criterion,evidence,verdict:"passed"}),verdict:"passed"})),findings:[]};}
const text=JSON.stringify(output);writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],text);
for(const event of [{type:"thread.started",thread_id:"thread-"+(task.phase ?? task.role)+(task.lens??"")},{type:"turn.started"},{type:"item.completed",item:{id:"final",type:"agent_message",text}},{type:"turn.completed",usage:{}}])console.log(JSON.stringify(event));
`);
  await chmod(executable,0o700);
  execFileSync(process.execPath, ["--check", executable]);
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
  const fixtureRuntime = fileURLToPath(new URL("../test-support/direct-feature-test-runtime.mjs", import.meta.url));
  const ownerEnv={FLOW_OWNER_RUNTIME_MODULE:fixtureRuntime,...env,FLOW_REPOSITORY_ROOT:repository,FLOW_AUTHORITY_DIRECTORY:authorityDirectory,FLOW_CONFIG_DIRECTORY:configDirectory,FLOW_QUALIFICATION_REPOSITORY_ROOT:sourceRepository,FLOW_EXECUTION_BACKEND:"direct",FLOW_CODEX_EXECUTABLE:executable};
  let owner=await startFlowOwner({env:ownerEnv});
  assert.equal(owner.state,"running");assert.notEqual(owner.pid,process.pid);
  ownerCleanup=async()=>{
    await writeFile(join(scratch,"release"),"release");
    for (const mode of ["reverse", "restart", "cancel"]) for (const lens of ["security", "correctness"]) await writeFile(join(scratch, `parallel-${mode}-release-${lens}`), "release");
    const retirement=await stopFlowOwner({env:ownerEnv,pid:owner.pid,processStartIdentity:owner.process_start_identity,waitMs:3000,force:true});
    assert.equal(retirement.state,"stopped",JSON.stringify(retirement));
    await retainPublicFixtureEvidence(`owner-retirement-${scenario}`,{fixture_owner_retirement:{pid:owner.pid,process_start_identity:owner.process_start_identity,retirement}});
    if (cancellation) await retainPublicFixtureEvidence("direct-cancel-task-retirement",{fixture_direct_tasks:await captureDirectTasks()});
  };
  async function captureDirectTasks() {
    const directory=join(authorityDirectory,"direct-tasks");
    const tasks=[];
    for (const task of await readdir(directory)) {
      const files={};
      for (const name of ["descriptor.json","worker.json","cancel.json","receipt.json","stdin.bin","stdout.bin","stderr.bin","last-message.json"]) {
        files[name]=await readFile(join(directory,task,name)).then(bytes=>({base64:bytes.toString("base64")})).catch(error=>{
          if(error.code!=="ENOENT")throw error;
          return {absent:true};
        });
      }
      tasks.push({task_id:`task:${task}`,files});
    }
    return tasks;
  }
  const runtime=Object.fromEntries(["prepare","launch","command","query"].map(operation=>[operation,request=>requestFlowTransport({socketPath:owner.socket_path,operation,request})]));
  const optIn={schema:"flow.dark-opt-in/v1",release_id:"flow-release-1.0-dark/v1",purpose:"sacrificial_qualification"};
  const described = await runtime.query({ schema: "flow.query/v1", query: "delegated_agent_description", launch: { harness: "codex", model: "fixture-model", effort: "high", capability: "workspace-write-denied" }, caller_metadata: {} });
  assert.equal(described.status, "compatible", JSON.stringify(described));
  const prepared=await runtime.prepare({schema:"flow.feature-preparation-request/v1",dark_opt_in:optIn,brief:{schema:"flow.feature-brief/v1",id:"brief:direct",summary:"Change feature.txt to after",acceptance:["feature.txt contains after"]},repository,mode:"verify",routes:{apply:{harness:"codex",model:"fixture-model",effort:"high",capability:"workspace-write-denied"},critique:{harness:"codex",model:"fixture-model",effort:"high",capability:"read-only"}}});
  assert.equal(prepared.schema,"flow.prepared-run/v1",JSON.stringify(prepared));
  assert.ok(prepared.graph.cards.some(card=>card.executor.contract==="flow.operation/feature-direct-commit/v1"));
  assert.equal(JSON.stringify(prepared).includes('"candidate_digest"'),false);
  const launch=await runtime.launch({prepared,dark_opt_in:optIn,confirmation:{schema:"flow.predefined-flow-confirmation-decision/v1",decision:"accept",bundle_digest:prepared.bundle_digest,confirmation_digest:prepared.confirmation_digest},closed_facts:{schema:"flow.closed-fact-observation/v1",bundle_digest:prepared.bundle_digest,facts:structuredClone(prepared.explicit_facts)}});
  assert.equal(launch.schema,"flow.launch-receipt/v1",JSON.stringify(launch));
  let cancellationCommand;
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
    cancellationCommand=await runtime.command(cancel);
    assert.equal(cancellationCommand.accepted,true);
    }
  }
  let workspaceInspection;
  let cancellationWorkspace;
  const cancellationSnapshots=[];
  if (cancellation) {
    const { createDurableRunAuthority } = await import("../../../tools/flow/src/run-authority.mjs");
    const { getWorkspaceAuthority } = await import("../../../tools/flow/src/work-authority.mjs");
    workspaceInspection=createDurableRunAuthority({authorityDirectory,access:"inspect"});
    t.after(()=>workspaceInspection.close());
    cancellationWorkspace=getWorkspaceAuthority({runAuthority:workspaceInspection});
  }
  const cancellationSubject=prepared.graph.cards.find(({id})=>id==="feature-direct-commit").inputs.workspace.subject_id;
  let projection;const end=Date.now()+10000;
  do {
    projection=await runtime.query({run_id:launch.run_id});
    if (cancellation && projection.phase==="cancelled") {
      const workspace=cancellationWorkspace.query({contract:"work.workspace/v1",subject_id:cancellationSubject});
      const effect=projection.effects.find(effect=>effect.effect_kind==="delegate_cancellation");
      const previous=cancellationSnapshots.at(-1);
      if (!previous || JSON.stringify(previous.projection.watermark)!==JSON.stringify(projection.watermark)) {
        cancellationSnapshots.push({projection,workspace,direct_tasks:await captureDirectTasks(),head:git(["rev-parse","HEAD"]),invocations:await readFile(join(scratch,"invocations"),"utf8")});
        await retainPublicFixtureEvidence("direct-cancel-observations",{fixture_cancellation:{launch,cancellationCommand,cancellationSnapshots}});
      }
      if (!effect?.receipt) assert.ok(workspace.claims.some(claim=>claim.holder===launch.run_id),"pending cancellation must retain its writer");
      if (effect?.receipt?.provider_receipt?.terminal_disposition?.retired===true)break;
    } else if(["succeeded","failed","cancelled"].includes(projection.phase)) {
      break;
    }
    await new Promise(r=>setTimeout(r,20));
  } while(Date.now()<end);
  if (cancellation) {
    assert.equal(projection.phase,"cancelled",JSON.stringify(projection));
    assert.equal(git(["rev-parse","HEAD"]),initial);
    assert.equal(await readFile(join(scratch,"invocations"),"utf8"),"apply\n");
    const cancellationEffect=projection.effects.find(effect=>effect.effect_kind==="delegate_cancellation");
    assert.ok(cancellationEffect?.receipt,"cancelled admission preceded its affirmative retirement receipt");
    assert.equal(cancellationEffect.receipt.provider_receipt.terminal_disposition.proof,"linux_subreaper_echild");
    assert.equal(cancellationEffect.receipt.provider_receipt.terminal_disposition.retired,true);
    const disposition=cancellationEffect.receipt.provider_receipt.terminal_disposition;
    const task=cancellationSnapshots.at(-1).direct_tasks.find(({task_id})=>task_id===disposition.resource.id);
    const terminal=JSON.parse(Buffer.from(task.files["receipt.json"].base64,"base64").toString("utf8"));
    const { digest } = await import("../../../tools/flow/src/canonical.mjs");
    assert.equal(digest(terminal),disposition.terminal_receipt_digest);
    assert.equal(terminal.tree_retired,true);
    assert.equal(terminal.cancelled,true);
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
  await retainPublicFixtureEvidence(`candidate-${scenario}`, {fixture_candidate:{initial,commit:git(["rev-parse","HEAD"]),tree:git(["rev-parse","HEAD^{tree}"]),review:review.candidate_id,reference:projection.review_candidate_reference,handoffs:projection.handoffs}});
  if (scenario === "success") {
    // Close the actual producer process before deriving review facts from a
    // fresh public owner. No test helper supplies candidate or authority facts.
    const producerRetirement=await stopFlowOwner({env:ownerEnv,pid:owner.pid,processStartIdentity:owner.process_start_identity,waitMs:3000,force:true});
    assert.equal(producerRetirement.state,"stopped",JSON.stringify(producerRetirement));
    const producerPid=owner.pid;
    owner=await startFlowOwner({env:ownerEnv});
    assert.notEqual(owner.pid,producerPid);
    const selection={schema:"flow.review-preparation-selection/v1",lenses:["security"],routes:{lenses:{security:{launch:{harness:"codex",model:"fixture-model",effort:"high",capability:"read-only",role:"lens:security"}}},critic:{launch:{harness:"codex",model:"fixture-model",effort:"high",capability:"read-only",role:"critic"}}}};
    const factsRequest={schema:"flow.query/v1",query:"review_preparation_facts",candidate_id:review.subject_id,candidate_fingerprint:review.candidate_fingerprint,selection};
    const facts=await runtime.query(factsRequest);
    assert.equal(facts.schema,"flow.review-preparation-facts/v1",JSON.stringify(facts));
    const ajv=new Ajv2020({allErrors:true,strict:true});
    for (const name of ["flow.authority-fact.v1.schema.json","flow.time-fact.v1.schema.json","flow.review-preparation-facts.v1.schema.json"]) ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`,import.meta.url),"utf8")));
    const validateFacts=ajv.getSchema("https://dotfiles.local/schemas/flow.review-preparation-facts.v1.schema.json");
    assert.equal(validateFacts(facts),true,ajv.errorsText(validateFacts.errors));
    assert.equal(JSON.stringify(facts).includes(repository),false,"public facts redact the canonical workspace path");
    assert.notEqual(facts.route.bindings[0].route.launch_comparison_key,facts.route.bindings[1].route.launch_comparison_key);
    assert.notEqual(facts.route.bindings[0].route.agent_id,facts.route.bindings[1].route.agent_id);
    const beforeNegativeIndex=await runtime.query({});
    assert.equal(beforeNegativeIndex.schema,"flow.run-index-projection/v1");
    const beforeNegativeInvocations=await readFile(join(scratch,"invocations"),"utf8");
    const beforeNegativeEffects=(await runtime.query({run_id:launch.run_id})).effects.map(({effect_id})=>effect_id);
    // This parent config is outside Git and ignored by home-only inventory.
    // Only the trusted workspace ancestor walk can discover it for review.
    const ambientConfig=join(scratch,".codex","config.toml");
    await mkdir(join(scratch,".codex"),{recursive:true});
    await writeFile(ambientConfig,"# Workspace-ancestor authority fixture\n");
    assert.equal(git(["status","--porcelain"]),"");
    const homeOnlyControl=await runtime.query({schema:"flow.query/v1",query:"delegated_agent_description",launch:selection.routes.lenses.security.launch,caller_metadata:{flow:"review/v1",role:"lens:security"}});
    assert.equal(homeOnlyControl.status,"compatible",JSON.stringify(homeOnlyControl));
    const preflight=await runtime.query(factsRequest);
    assert.equal(preflight.code,"unproved_ambient_authority",JSON.stringify(preflight));
    const callerPath=join(scratch,"caller-workspace");
    await mkdir(callerPath);
    const callerPathRejections=[];
    for (const [placement,code] of [["selection","invalid_review_preparation_query"],["launch","unsupported_execution_capability"]]) {
      const suppliedPathRequest=structuredClone(factsRequest);
      if (placement==="selection") suppliedPathRequest.selection.workspace_path=callerPath;
      else suppliedPathRequest.selection.routes.lenses.security.launch.workspace_path=callerPath;
      const rejected=await runtime.query(suppliedPathRequest);
      assert.equal(rejected.schema,"flow.rejection/v1",JSON.stringify(rejected));
      assert.equal(rejected.code,code,JSON.stringify(rejected));
      callerPathRejections.push({placement,rejection:rejected});
    }
    await rm(join(scratch,".codex"),{recursive:true});
    const binding=card=>{const value=facts.route.bindings.find(({card_id})=>card_id===card);return {description:value.description,route:value.route};};
    const reviewPrepared=await runtime.prepare({schema:"flow.predefined-flow-selection/v1",definition:"review/v1",dark_opt_in:optIn,inputs:{schema:"flow.review-request/v1",target:{schema:"flow.review-local-candidate/v1",candidate:review.candidate,candidate_fingerprint:review.candidate_fingerprint,candidate_authority_watermark:review.watermark,lifecycle_generation:1},lenses:["security"],preparation_selection:selection,preparation_facts:facts,delegation:{schema:"flow.review-delegation-bindings/v1",lenses:{security:binding("review-lens-security")},critic:binding("review-critic")}}});
    assert.equal(reviewPrepared.schema,"flow.prepared-run/v1",JSON.stringify(reviewPrepared));
    const launchRequest={prepared:reviewPrepared,dark_opt_in:optIn,confirmation:{schema:"flow.predefined-flow-confirmation-decision/v1",decision:"accept",bundle_digest:reviewPrepared.bundle_digest,confirmation_digest:reviewPrepared.confirmation_digest},closed_facts:{schema:"flow.closed-fact-observation/v1",bundle_digest:reviewPrepared.bundle_digest,facts:structuredClone(reviewPrepared.explicit_facts)}};
    await mkdir(join(scratch,".codex"),{recursive:true});
    await writeFile(ambientConfig,"# Workspace-ancestor authority fixture\n");
    const staleLaunch=await runtime.launch(launchRequest);
    assert.equal(staleLaunch.schema,"flow.rejection/v1",JSON.stringify(staleLaunch));
    assert.equal(staleLaunch.code,"unproved_ambient_authority",JSON.stringify(staleLaunch));
    await rm(join(scratch,".codex"),{recursive:true});
    const afterNegativeIndex=await runtime.query({});
    const afterNegativeInvocations=await readFile(join(scratch,"invocations"),"utf8");
    const afterNegativeEffects=(await runtime.query({run_id:launch.run_id})).effects.map(({effect_id})=>effect_id);
    assert.deepEqual(afterNegativeIndex.runs,beforeNegativeIndex.runs,"rejected queries and launch create no runs");
    assert.deepEqual(afterNegativeEffects,beforeNegativeEffects,"rejected queries and launch create no effects");
    assert.equal(afterNegativeInvocations,beforeNegativeInvocations,"rejected queries and launch spawn no review tasks");
    const negativeEffects={run_ids_before:beforeNegativeIndex.runs,run_ids_after:afterNegativeIndex.runs,source_effect_ids_before:beforeNegativeEffects,source_effect_ids_after:afterNegativeEffects,invocations_before:beforeNegativeInvocations,invocations_after:afterNegativeInvocations};
    const reviewLaunch=await runtime.launch(launchRequest);
    assert.equal(reviewLaunch.schema,"flow.launch-receipt/v1",JSON.stringify(reviewLaunch));
    let reviewed;const reviewEnd=Date.now()+10000;
    do {reviewed=await runtime.query({run_id:reviewLaunch.run_id});if(["succeeded","failed","cancelled"].includes(reviewed.phase))break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<reviewEnd);
    assert.equal(reviewed.phase,"succeeded",JSON.stringify(reviewed));
    assert.equal(await readFile(join(scratch,"invocations"),"utf8"),"apply\ncritique\nlens\ncritic\n");
    const inbox=await runtime.query({schema:"flow.query/v1",query:"review_inbox"});
    assert.equal(inbox.schema,"flow.review-inbox-projection/v1");
    assert.equal(inbox.items.length,1);
    const automated=inbox.items[0].review;
    assert.equal(automated.status,"automated_completed");
    assert.equal(automated.current,true);
    const formats=automated.artifacts.formats;
    assert.match(formats.markdown,/# Automated review/);
    assert.match(formats.markdown,/Approval: not requested/);
    assert.ok(formats.markdown.includes(review.candidate_fingerprint));
    assert.ok(formats.markdown.includes(reviewLaunch.run_id));
    assert.match(formats.html,/<article data-schema="flow.review-artifact-html\/v1"/);
    assert.equal(JSON.parse(formats.json).approval.integration_authorized,false);
    await retainPublicFixtureEvidence("direct-review-success", {fixture_direct_review:{producer_pid:producerPid,producer_retirement:producerRetirement,review_owner_pid:owner.pid,candidate:review,facts,home_only_control:homeOnlyControl,caller_path_rejections:callerPathRejections,negative_effects:negativeEffects,preflight,revalidation_rejection:staleLaunch,prepared:reviewPrepared,launch:reviewLaunch,review_run:reviewed,inbox}});
    await exerciseParallelReview();

    async function exerciseParallelReview() {
      const { runCli } = await import("../src/cli-command.mjs");
      const output = () => ({ text: "", write(value) { this.text += value; } });
      const rejectedOut = output(), rejectedError = output();
      assert.equal(await runCli(["start", "--delegate-capacity", "2", "--json"], { env: ownerEnv, stdout: rejectedOut, stderr: rejectedError }), 1);
      assert.equal(JSON.parse(rejectedError.text).code, "owner_delegate_capacity_insufficient");
      const serialPid = owner.pid;
      const stopped = await stopFlowOwner({ env: ownerEnv, pid: owner.pid, processStartIdentity: owner.process_start_identity, waitMs: 3000, force: true });
      assert.equal(stopped.state, "stopped");
      const startedOut = output(), startedError = output();
      assert.equal(await runCli(["start", "--delegate-capacity", "2", "--json"], { env: ownerEnv, stdout: startedOut, stderr: startedError }), 0, startedError.text);
      owner = JSON.parse(startedOut.text);
      assert.equal(owner.runner.delegates.capacity, 2);
      assert.notEqual(owner.pid, serialPid);
      const policy = { schema: "flow.read-only-sibling-policy/v1", max_in_flight: 2, card_ids: ["review-lens-security", "review-lens-correctness"] };
      async function waitFor(predicate, label) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.fail(label);
      }
      const readEvents = mode => readFile(join(scratch, `parallel-${mode}-events`), "utf8").catch(() => "");
      const release = (mode, lens) => writeFile(join(scratch, `parallel-${mode}-release-${lens}`), "release");
      async function launchParallel(mode) {
        await writeFile(join(scratch, "parallel-mode"), mode);
        const selection = { schema: "flow.review-preparation-selection/v1", lenses: ["security", "correctness"], execution: policy,
          routes: { lenses: Object.fromEntries(["security", "correctness"].map(lens => [lens, { launch: { harness: "codex", model: "fixture-model", effort: "high", capability: "read-only", role: `lens:${lens}` } }])),
            critic: { launch: { harness: "codex", model: "fixture-model", effort: "high", capability: "read-only", role: "critic" } } } };
        const observed = await runtime.query({ ...factsRequest, selection });
        assert.equal(observed.schema, "flow.review-preparation-facts/v1", JSON.stringify(observed));
        const route = id => { const entry = observed.route.bindings.find(value => value.card_id === id); return { description: entry.description, route: entry.route }; };
        const prepared = await runtime.prepare({ schema: "flow.predefined-flow-selection/v1", definition: "review/v1", dark_opt_in: optIn,
          inputs: { schema: "flow.review-request/v1", target: reviewPrepared.selection.inputs.target,
            lenses: selection.lenses, execution: policy, preparation_selection: selection, preparation_facts: observed,
            delegation: { schema: "flow.review-delegation-bindings/v1", lenses: Object.fromEntries(selection.lenses.map(lens => [lens, route(`review-lens-${lens}`)])), critic: route("review-critic") } } });
        assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
        assert.deepEqual(prepared.graph.execution_policy, policy);
        const admitted = await runtime.launch({ prepared, dark_opt_in: optIn,
          confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept", bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest },
          closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } });
        assert.equal(admitted.schema, "flow.launch-receipt/v1", JSON.stringify(admitted));
        await waitFor(async () => { const events = await readEvents(mode); return events.includes("lens:security") && events.includes("lens:correctness"); }, "both independent lenses must overlap before either release");
        const pending = await runtime.query({ run_id: admitted.run_id });
        assert.equal(pending.effects.filter(effect => effect.effect_kind === "delegate" && effect.receipt === null).length, 2);
        assert.ok(!pending.legal_actions.some(action => action.card_id === "review-critic"));
        return admitted.run_id;
      }
      const firstRun = await launchParallel("reverse");
      await release("reverse", "correctness");
      await waitFor(async () => (await runtime.query({ run_id: firstRun })).delegate_attempts.some(attempt => attempt.card_id === "review-lens-correctness" && attempt.status === "accepted"), "correctness completes first");
      assert.equal((await readEvents("reverse")).includes("critic:"), false);
      await release("reverse", "security");
      const complete = await waitFor(async () => { const value = await runtime.query({ run_id: firstRun }); return value.phase === "succeeded" && value; }, "all-lens critic and review record complete");
      assert.equal(complete.delegate_attempts.length, 3);
      const criticInput = JSON.parse(await readFile(join(scratch, "parallel-reverse-critic-input.json"), "utf8"));
      assert.deepEqual(criticInput.predecessor_evidence.accepted_delegates.map(value => value.card_id).sort(), policy.card_ids.toSorted());
      assert.equal((await readEvents("reverse")).split("\n").filter(value => value === "critic:critic").length, 1);
      const restarting = await launchParallel("restart");
      const priorPid = owner.pid;
      assert.equal((await stopFlowOwner({ env: ownerEnv, pid: owner.pid, processStartIdentity: owner.process_start_identity, waitMs: 1000, force: true })).state, "stopped");
      owner = await startFlowOwner({ env: ownerEnv, runnerOptions: { delegateCapacity: 2 } });
      assert.notEqual(owner.pid, priorPid);
      await release("restart", "security"); await release("restart", "correctness");
      const adopted = await waitFor(async () => { const value = await runtime.query({ run_id: restarting }); return value.phase === "succeeded" && value; }, "replacement owner adopts both exact tasks");
      assert.equal(adopted.delegate_attempts.length, 3);
      const events = (await readEvents("restart")).trim().split("\n");
      assert.deepEqual(events.toSorted(), ["critic:critic", "lens:correctness", "lens:security"]);
      const cancelling = await launchParallel("cancel");
      const beforeCancel = await runtime.query({ run_id: cancelling });
      const cancel = beforeCancel.legal_actions.find(action => action.type === "cancel");
      assert.equal((await runtime.command(cancel)).accepted, true);
      try {
        await waitFor(async () => { const value = await runtime.query({ run_id: cancelling }); return value.effects.filter(effect => effect.effect_kind === "delegate_cancellation" && effect.receipt !== null).length === 2 && value; }, "both sibling cancellation effects positively settle");
      } catch (error) {
        await retainPublicFixtureEvidence("parallel-cancellation-failure", { projection: await runtime.query({ run_id: cancelling }) });
        throw error;
      }
      const cancelled = await runtime.query({ run_id: cancelling });
      assert.equal(cancelled.phase, "cancelled");
      assert.equal((await readEvents("cancel")).includes("critic:"), false);
      assert.ok(!cancelled.legal_actions.some(action => action.type === "delegate_execute"));
      const tasks = await captureDirectTasks();
      const descriptors = tasks.map(task => ({ task, descriptor: JSON.parse(Buffer.from(task.files["descriptor.json"].base64, "base64").toString()) }));
      for (const runId of [firstRun, restarting, cancelling]) {
        const matching = descriptors.filter(value => value.descriptor.run_id === runId);
        assert.equal(matching.length, runId === cancelling ? 2 : 3);
        for (const { task } of matching) assert.equal(JSON.parse(Buffer.from(task.files["receipt.json"].base64, "base64").toString()).tree_retired, true);
      }
      await retainPublicFixtureEvidence("direct-parallel-review", { fixture_parallel_review: { firstRun, complete, adopted, cancelled, policy } });
    }

  }

});

// The final validation owner supplies one private external directory. These are
// actual public results and rendered bytes, with no production authority input.
async function retainPublicFixtureEvidence(name, value) {
  const directory = process.env.FLOW_TEST_ARTIFACT_DIRECTORY;
  if (directory === undefined) {
    console.log(JSON.stringify(value));
    return;
  }
  assert.equal(isAbsolute(directory), true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const proof = value.fixture_direct_review;
  if (proof !== undefined) {
    for (const key of ["candidate", "facts", "prepared", "launch", "review_run", "inbox", "preflight", "revalidation_rejection"]) {
      await writeFile(join(directory, `${name}-${key}.json`), `${JSON.stringify(proof[key])}\n`, { mode: 0o600 });
    }
    const formats = proof.inbox.items[0].review.artifacts.formats;
    for (const [format, extension] of [["markdown", "md"], ["html", "html"], ["json", "json"]]) {
      await writeFile(join(directory, `${name}-rendered.${extension}`), formats[format], { mode: 0o600 });
    }
  }
  console.log(JSON.stringify({ retained_public_fixture: name }));
}
