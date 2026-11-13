import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// Optional reviewer artifacts from these same controlled public subprocesses.
// This directory is supplied only by an owned author-validation invocation.
function captureUi(name, output) {
  const directory=process.env.FLOW_PUBLIC_CONTROLLED_UI_DIR;
  if(!directory)return;
  assert.equal(realpathSync(directory),directory);
  writeFileSync(join(directory,name),"CONTROLLED PUBLIC UI FIXTURE - no native or authority qualification.\n\n"+output,{flag:'wx',mode:0o600});
}

test("public research help explains confirmed deep angles and total cycles without starting work", t => {
  const root = mkdtempSync("/tmp/flow-deep-research-public-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home"));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), LANG: "C.UTF-8" };
  const result = spawnSync(process.execPath, [cli, "research", "--help"], {
    env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  captureUi("help.txt",result.stdout);
  for (const option of ["--mode deep", "--angle", "--parallel", "--max-cycles"]) assert.ok(result.stdout.includes(option), option);
  assert.match(result.stdout, /two.*angle|angle.*two/iu);
  assert.match(result.stdout, /total cycles|initial.*revision/iu);
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
  assert.equal(existsSync(env.XDG_CONFIG_HOME), false);
});

// These metadata/generated-client transports exercise the actual public CLI and
// terminal only. They do not qualify a native stream, own real workers or prove
// authority admission. Main's durable production-wire tests cover those seams.
function controlledDeepResearch(t,{capable=true}={}) {
  const root=realpathSync(mkdtempSync("/tmp/flow-deep-research-fixture-"));
  for(const name of ["home","state","config"])mkdirSync(join(root,name));
  const env={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:join(root,"home"),
    XDG_STATE_HOME:join(root,"state"),XDG_CONFIG_HOME:join(root,"config"),LANG:"C.UTF-8",TERM:"dumb",
    GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_OPTIONAL_LOCKS:"0"};
  const repository=join(root,"project"),runtime=join(root,"original-runtime");mkdirSync(repository);
  const git=args=>execFileSync("/usr/bin/git",["-C",repository,...args],{env,encoding:"utf8",timeout:10000});
  git(["init","-q","--initial-branch=main"]);git(["config","user.name","Deep research fixture"]);git(["config","user.email","research@example.invalid"]);
  git(["config","core.hooksPath","/dev/null"]);git(["config","commit.gpgSign","false"]);
  writeFileSync(join(repository,"README.md"),"Research does not modify this existing project.\n");git(["add","."]);git(["commit","-qm","Existing research context"]);
  const head=git(["rev-parse","HEAD"]).trim(),source=join(root,"observations.txt");writeFileSync(source,"Change notifications provide hints with explicit limits.\n");
  mkdirSync(join(runtime,"tools/flow/src"),{recursive:true});mkdirSync(join(runtime,"config/flow/src"),{recursive:true});
  copyFileSync(fileURLToPath(new URL("../../../tools/flow/src/canonical.mjs",import.meta.url)),join(runtime,"tools/flow/src/canonical.mjs"));
  writeFileSync(join(runtime,"tools/flow/src/research-flow.mjs"),"// Controlled capability marker; never executed.\n");
  if(capable)writeFileSync(join(runtime,"tools/flow/src/deep-research-flow.mjs"),"// Controlled deep capability marker; never executed.\n");
  const profile=join(env.XDG_STATE_HOME,"flow-local",digest(repository).slice(7,31)),directory=join(profile,"clients","verify"),authority=join(profile,"authority");
  mkdirSync(join(directory,"requests"),{recursive:true});mkdirSync(join(directory,"receipts"));mkdirSync(authority);
  const marker=join(root,"native-or-version-executed"),executable=join(root,"never-execute-codex");writeFileSync(executable,`#!/bin/sh\nprintf unexpected > '${marker}'\nexit 99\n`,{mode:0o700});
  const trust={schema:"flow.supervised-native-cli/v1",acknowledgment:"trust-official-cli-permissions"},person={name:"Deep fixture",email:"research@example.invalid"},gitIdentity={author:person,committer:person};
  const identity={schema:"flow.local-client/v1",repository,runtime_root:runtime,node:realpathSync(process.execPath),executable:{path:executable,sha256:`sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`},execution_trust:trust,git_identity:gitIdentity};
  const save=(path,value)=>writeFileSync(path,JSON.stringify(value)+"\n",{mode:0o600});save(join(profile,"profile.json"),{identity,initial_check_digest:null});
  const generated=writeFeatureClient({directory,runtimeRoot:runtime,workspace:repository,executionTrust:"supervised-native-cli",codexExecutable:executable,localStateHome:env.XDG_STATE_HOME,authorityDirectory:authority,gitIdentity});
  save(join(directory,"pilot.json"),{directory,runtime_root:runtime,...generated,local_client:identity,execution_trust:trust});
  const stateFile=join(root,"transport-state.json");save(stateFile,{calls:[],preparations:0,launches:0,started:false,capacity:1});
  writeFileSync(join(runtime,"config/flow/src/cli.mjs"),`import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../../tools/flow/src/canonical.mjs';
import {compileDeepResearchCycle} from ${JSON.stringify(new URL('../../../tools/flow/src/deep-research-flow.mjs',import.meta.url).href)};
import {createDeepTerminalSet,deepTerminalEntry} from ${JSON.stringify(new URL('../../../tools/flow/src/deep-research-evidence.mjs',import.meta.url).href)};
import {deriveDeepCycleReceipt} from ${JSON.stringify(new URL('../../../tools/flow/src/deep-research-cycle.mjs',import.meta.url).href)};
import {researchQuestion} from ${JSON.stringify(new URL('../../../tools/flow/src/deep-research-contract.mjs',import.meta.url).href)};
import {readDeepResearchReport} from ${JSON.stringify(new URL('../../../tools/flow/src/deep-research-report.mjs',import.meta.url).href)};
import {validateDelegateEvidenceSafety} from ${JSON.stringify(new URL('../../../tools/flow/src/evidence-safety.mjs',import.meta.url).href)};
const file=${JSON.stringify(stateFile)},state=JSON.parse(readFileSync(file)),args=process.argv.slice(2),directory=${JSON.stringify(directory)};
const load=p=>JSON.parse(readFileSync(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const description=role=>({launch:{harness:'codex',model:'gpt-6.1-sol',effort:'high',role,capability:'read-only'},backend:{executable:{path:'/fixture/official-codex',version:'codex-cli 0.166.0',sha256:'sha256:'+'f'.repeat(64)}},effective_authority:{workspace:'read-only',approvals:'never'}});
function graph(request){
 if(!request.deep)return {cards:['spike-research','spike-synthesis'].map(id=>({id,inputs:{description:description(id)},executor:{kind:'delegate'}}))};
 const names=['deep-angle-1-cycle-1','deep-angle-2-cycle-1','deep-critic-cycle-1','deep-decision-cycle-1','deep-gate-cycle-1'];
 return {deep_research:{schema:'flow.deep-research-plan/v1',packet:request.packet,deep:request.deep,workspace:{},delegation:{}},cards:names.map((id,index)=>({id,dependencies:[],inputs:index<3?{description:description(id)}:{},executor:{kind:index<3?'delegate':index===3?'operation':'checkpoint'}}))};
}
function routes(request){return request.deep?Array.from({length:request.deep.max_cycles},(_,index)=>['deep-angle-1-cycle-','deep-angle-2-cycle-','deep-critic-cycle-'].map(prefix=>prefix+(index+1))).flat():['spike-research','spike-synthesis'];}
// Reduced accepted public receipts use the actual pure cycle/card contracts.
// They are metadata fixtures, never native-valid terminal or authority proof.
function completedRun(request){
 const packet=request.packet,deep=request.deep,isScope=state.mode.startsWith('scope'),replacement=researchQuestion('What independent checks protect consumers across connections?');
 const cycleLimit=state.mode==='blocked'||isScope&&state.mode!=='scope_approved'?1:deep.max_cycles;let effectiveQuestion=packet.question,scope=digest({packet_digest:packet.packet_digest,question:effectiveQuestion}),lastReceipt;
 const metadata={schema:'flow.deep-research-plan/v1',packet,deep,workspace:{subject_id:'workspace:fixture',generation:1,mutation_epoch:0,fingerprint:'sha256:'+'3'.repeat(64)},delegation:Object.fromEntries(routes(request).map(id=>[id,{description:description(id),route:{agent_id:'agent:fixture-'+id}}]))};
 const run={schema:'flow.run-projection/v1',run_id:state.run_id,bundle_digest:state.bundle_digest,phase:state.mode==='blocked'?'active':'succeeded',progress:state.mode==='blocked'?'blocked':'completed',watermark:'sha256:'+'8'.repeat(64),sequence:40,active_plan:{schema:'flow.plan/v1',deep_research:metadata,cards:[]},effects:[],delegate_attempts:[],cards:[],resource_dispositions:[],blocks:[],legal_actions:[]};
 let retained=[];
 for(let cycle=1;cycle<=cycleLimit;cycle++){
  if(cycle===2&&state.mode==='scope_approved'){effectiveQuestion=replacement;scope=digest({packet_digest:packet.packet_digest,question:effectiveQuestion});}
  const cards=compileDeepResearchCycle(metadata,{cycle,question:effectiveQuestion,scope_digest:scope,angle_ids:deep.angles.map(angle=>angle.angle_id),retained_card_ids:retained});run.active_plan.cards.push(...cards);
  for(const card of cards.filter(card=>card.executor.kind==='delegate')){
   const task=card.inputs.task_inputs,critic=task.role==='critic',predecessor=critic?createDeepTerminalSet(run,card):null;
   const value={schema:critic?'flow.deep-research-critic-output/v1':'flow.deep-research-angle-output/v1',question_id:effectiveQuestion.id,cycle,answer:'A change hint cannot replace verified authority replay.',assurance:'lower',citations:packet.sources.map(source=>({source_id:source.id,digest:source.digest})),findings:['Notification scope is narrower than an integrity guarantee.'],residual_gaps:['Supported-host notification behavior has not been measured.'],...(critic?{revise_angles:isScope?[]:['angle:1','angle:2'],proposed_question:isScope&&cycle===1?replacement.text:null,retained_evidence_digest:predecessor.evidence_digest}:{angle_id:task.angle.angle_id})};
   const output=JSON.stringify(value),safety=validateDelegateEvidenceSafety(output);if(!safety.accepted)throw Error('Unsafe controlled deep output');
   const attempt_id=run.run_id+':'+card.id+':attempt:1',effect_id='effect:'+card.id,key='delegate:'+card.id;
   const quarantined=state.mode==='blocked'&&task.angle?.angle_id==='angle:2';
   const retirement={schema:'flow.resource-retirement/v1',resource:{type:'direct_task',id:'task:'+digest(attempt_id).slice(7)},retired:true,proof:'linux_subreaper_echild',terminal_receipt_digest:'sha256:'+'5'.repeat(64)};
   const evidence=quarantined?{schema:'flow.delegate-quarantine/v1',card_id:card.id,attempt_id,route_binding:card.route,execution_watermark:{schema:'flow.execution-watermark/v1',content_sha256:'sha256:'+'4'.repeat(64)},quarantine_reason:'terminal_output_not_completed',correlated_output:null,settlement_proof:null,terminal_disposition:retirement,turn_id:retirement.resource.id,validator_receipts:[{contract:'flow.validator/deep-research-angle/v1',accepted:false,evidence_safety_accepted:false,evidence_safety_rejection:'invalid_delegate_output'}]}:{schema:'flow.delegate-evidence/v1',card_id:card.id,attempt_id,route_binding:card.route,validated_output:output,evidence_safety_receipt:safety.receipt,evidence_safety_binding:safety.binding,terminal_disposition:retirement};
   run.effects.push({effect_id,run_id:run.run_id,card_id:card.id,attempt_id,idempotency_key:key,source_authority_watermark:'sha256:'+'6'.repeat(64),route_binding:card.route,effect_kind:'delegate',status:quarantined?'quarantined':'succeeded',receipt:{effect_id,idempotency_key:key,outcome:quarantined?'quarantined':'succeeded',provider_receipt:evidence}});
   run.delegate_attempts.push({card_id:card.id,attempt_id,effect_id,route_binding:card.route,status:quarantined?'quarantined':'accepted',evidence:quarantined?null:evidence,...(quarantined?{validated_output:null}:{})});
  }
  const decision=cards.find(card=>card.executor.kind==='operation'),effect_id='effect:'+decision.id,key='operation:'+decision.id;
  const operation={effect_id,run_id:run.run_id,card_id:decision.id,attempt_id:run.run_id+':'+decision.id+':attempt:1',idempotency_key:key,effect_kind:'operation',operation_contract:'flow.research-cycle/v1',status:'succeeded'};
  const provider=deriveDeepCycleReceipt({...operation,operation_input:{...decision.inputs,authority_materialized_evidence:createDeepTerminalSet(run,decision)}});
  operation.receipt={effect_id,idempotency_key:key,outcome:'succeeded',provider_receipt:provider};run.effects.push(operation);lastReceipt=provider;
  retained.push(...cards.filter(card=>card.executor.kind==='delegate').map(card=>card.id));
 }
 const report=readDeepResearchReport(run,packet,deep);run.cards=run.active_plan.cards.map(card=>({id:card.id,status:state.mode==='blocked'&&['deep-angle-2-cycle-1','deep-gate-cycle-1'].includes(card.id)?'blocked':'completed'}));
 run.deep_research={schema:'flow.deep-research-progress/v1',cycle:cycleLimit,scope:{question_id:effectiveQuestion.id,text:effectiveQuestion.text,source_packet_digest:packet.packet_digest,original_question_id:packet.question.id,scope_digest:scope},angles:deep.angles.map((angle,index)=>{const card_id='deep-angle-'+(index+1)+'-cycle-'+cycleLimit,attempt=run.delegate_attempts.find(attempt=>attempt.card_id===card_id);return {...angle,card_id,cycle:cycleLimit,status:attempt.status,effect_id:attempt.effect_id,attempt_id:attempt.attempt_id};}),history:retained.map(id=>deepTerminalEntry(run,id)),report,remaining_cycles:deep.max_cycles-cycleLimit,scope_proposal:null,operationally_blocked:state.mode==='blocked'};
 if(isScope&&!['scope_approved','scope_declined'].includes(state.mode)){
  run.phase='active';run.progress='waiting';const checkpoint_id='deep-gate-cycle-1';run.cards.find(card=>card.id===checkpoint_id).status='waiting_checkpoint';
  const proposedQuestion=state.mode==='scope_unsafe'?{id:replacement.id,text:'/private/unsafe'}:replacement;
  const proposal={checkpoint_id,old_question:packet.question,new_question:proposedQuestion,unchanged_packet_digest:packet.packet_digest,angle_ids:deep.angles.map(angle=>angle.angle_id),remaining_elapsed_seconds:state.mode==='scope_unknown'?null:583,original_elapsed_limit:request.limits.max_elapsed_seconds,original_time_facts_digest:digest({schema:'fixture-clock/v1'}),remaining_cycles:1,next_cycle_attempts:3,next_cycle_graph_cards:5,proposal_digest:digest({decision_digest:lastReceipt.self_digest,question:proposedQuestion,scope_digest:digest({packet_digest:packet.packet_digest,question:proposedQuestion})})};
  run.deep_research.scope_proposal=proposal;if(state.mode==='scope_unknown'){run.progress='blocked';run.cards.find(card=>card.id===checkpoint_id).status='blocked';}const {remaining_elapsed_seconds,...draft}=proposal;
  run.watermark='sha256:'+(state.stale?'9':'8').repeat(64);
  run.legal_actions=[{schema:'flow.command/v1',type:'cancel',run_id:run.run_id,expected_watermark:run.watermark},...(state.mode==='scope_unknown'?[]:['approve','decline']).map(decision=>({schema:'flow.command/v1',type:'checkpoint_decision',run_id:run.run_id,checkpoint_id,decision,expected_watermark:run.watermark,checkpoint_binding:{schema:'flow.checkpoint-binding/v1',checkpoint_id,draft,draft_digest:digest(draft)}}))];
 }
 if(state.mode==='forged'){const receipt=run.effects.find(effect=>effect.card_id==='deep-decision-cycle-2').receipt;receipt.provider_receipt={...receipt.provider_receipt,report:{...receipt.provider_receipt.report,answer:'Unbound replacement report'}};}
 return run;
}
state.calls.push(args);let result;
switch(args[0]){
case 'status':result={schema:'flow.owner-status/v1',state:state.started?'running':'stopped',runner:{delegates:{capacity:state.capacity}}};break;
case 'start':if(args.includes('--delegate-capacity')&&!state.started)state.capacity=Number(args[args.indexOf('--delegate-capacity')+1]);state.started=true;result={schema:'flow.owner-status/v1',state:'running',runner:{delegates:{capacity:state.capacity}}};break;
case 'stop':throw Error('The guided fixture never stops an owner implicitly');
case 'prepare':{
 state.preparations++;const request=input();state.request=request;const plan=graph(request),confirmation={packet:request.packet,limits:request.limits,...(request.deep?{deep:request.deep}:{})};
 result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:request.deep?'spike/v3':'spike/v2'},bundle_digest:digest({plan,confirmation}),graph:plan,plan_fingerprint:digest(plan),selection:{inputs:{packet:request.packet,...(request.deep?{deep:request.deep}:{})}},confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:request.limits},trust_posture:{execution_contract:'flow.supervised-native-cli/v1'},requested_authority:{capabilities:[],mutations:request.deep?['flow.research-cycle/v1']:[]}};
 if(state.drop_deep){delete result.graph.deep_research;result.plan_fingerprint=digest(result.graph);}break;
}
case 'local':{
 if(args[1]==='inspect-prepared'){
  const prepared=load(args[2]),request=state.request;
  result={status:'inspection_only',prepared_file:args[2],bundle_digest:prepared.bundle_digest,confirmation_digest:prepared.confirmation_digest,limits:prepared.explicit_facts.limits,requested_authority:prepared.requested_authority,
   ...(request.deep?{deep:{selection:request.deep,initial_graph_cards:5,max_graph_cards:request.deep.max_cycles*5,max_native_attempts:request.deep.max_cycles*3,whole_cycle_cards:{one_angle:4,both_angles:5},source_packet_digest:request.packet.packet_digest}}:{}),
   routes:routes(request).map(id=>({card_id:id,launch:description(id).launch,executable:description(id).backend.executable,requested_permissions:description(id).effective_authority}))};
 }else if(args[1]==='accept-prepared'){
  const prepared=load(args[3]),folder=mkdtempSync(join(directory,'receipts','accepted-')),request=join(folder,'launch-request.json');
  save(request,{prepared,confirmation:{schema:'flow.predefined-flow-confirmation-decision/v1',decision:'accept',bundle_digest:prepared.bundle_digest,confirmation_digest:prepared.confirmation_digest},closed_facts:{schema:'flow.closed-fact-observation/v1',bundle_digest:prepared.bundle_digest,facts:prepared.explicit_facts},execution_trust:${JSON.stringify(trust)}});result={status:'launch_request_only',directory:folder,request};
 }else throw Error('Unsupported fixture local command');break;
}
case 'query':{
 const q=input();if(!q.run_id){result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:state.launched?[state.run_id]:[]};break;}
 if(!state.launched){result={schema:'flow.rejection/v1',code:'unknown_run'};break;}
 const request=state.request;if(['complete','blocked','forged'].includes(state.mode)||state.mode?.startsWith('scope')){result=completedRun(request);break;}const plan=graph(request),question=request.packet.question;
 result={schema:'flow.run-projection/v1',run_id:state.run_id,bundle_digest:state.bundle_digest,phase:state.cancelled?'cancelled':'active',watermark:'sha256:'+'7'.repeat(64),sequence:6,active_plan:plan,
  cards:plan.cards.map(card=>({id:card.id,status:card.id.startsWith('deep-angle-')||card.id==='spike-research'?'executing':'pending'})),effects:[],delegate_attempts:[],resource_dispositions:[],blocks:[],
  ...(request.deep?{deep_research:{schema:'flow.deep-research-progress/v1',cycle:1,scope:{question_id:question.id,text:question.text,source_packet_digest:request.packet.packet_digest,original_question_id:question.id,scope_digest:digest(question)},angles:request.deep.angles.map((angle,index)=>({...angle,card_id:'deep-angle-'+(index+1)+'-cycle-1',cycle:1,status:'executing',effect_id:null,attempt_id:null})),history:[],report:null,scope_proposal:null,operationally_blocked:false}}:{}),
  legal_actions:state.cancelled?[]:[{schema:'flow.command/v1',type:'cancel',run_id:state.run_id,expected_watermark:'sha256:'+'7'.repeat(64)}]};break;
}
case 'launch':{const prepared=input().prepared;state.run_id='run:'+prepared.bundle_digest.slice(7);state.bundle_digest=prepared.bundle_digest;state.launched=true;state.launches++;if(state.lose_reply&&!state.reply_lost){state.reply_lost=true;save(file,state);process.exit(99);}result={schema:'flow.launch-receipt/v1',run_id:state.run_id};break;}
case 'command':{const command=input();state.commands=(state.commands??0)+1;if(command.type==='cancel')state.cancelled=true;else{(state.decisions??=[]).push(command);state.mode=command.decision==='approve'?'scope_approved':'scope_declined';}result={schema:'flow.command-receipt/v1',run_id:state.run_id,outcome:'accepted'};break;}
default:throw Error('Unexpected fixture transport '+args[0]);
}
save(file,state);process.stdout.write(JSON.stringify(result)+'\\n');
`);
  const pins=[join(profile,"profile.json"),join(directory,"pilot.json"),join(directory,"flow"),join(directory,"trusted-owner.mjs"),executable].map(path=>({path,bytes:readFileSync(path)}));
  t.after(()=>{try{for(const pin of pins)assert.deepEqual(readFileSync(pin.path),pin.bytes);assert.equal(existsSync(marker),false);assert.equal(git(["status","--porcelain"]),"");assert.equal(git(["rev-parse","HEAD"]).trim(),head);for(const name of ["owner.json","authority.sqlite","direct-tasks"])assert.equal(existsSync(join(authority,name)),false);}finally{rmSync(root,{recursive:true,force:true});}});
  const call=args=>spawnSync(process.execPath,[cli,...args],{env,cwd:root,encoding:"utf8",timeout:15000,maxBuffer:1024*1024});
  return {root,env,repository,runtime,directory,authority,source,stateFile,call,run:args=>call(['research','--repository',repository,...args]),state:()=>JSON.parse(readFileSync(stateFile)),change:values=>save(stateFile,{...JSON.parse(readFileSync(stateFile)),...values})};
}

const deepFlags=["--mode","deep","--angle","Connection-local notification limits","--angle","Durable cross-process verification","--parallel","2","--max-cycles","2"];
const question="Can change hints preserve complete verified replay?";
function previewFrom(result) {
  assert.equal(result.status,0,result.stdout+result.stderr);
  const values=result.stdout.split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const preview=values.find(value=>value.schema==='flow.project-research-preview/v1');assert.ok(preview,result.stdout);return preview;
}

function terminalResearch(f,args,steps) {
  const driver=`import errno,json,os,pty,select,signal,subprocess,sys,time
master,slave=pty.openpty();child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
steps=json.loads(sys.argv[2]);output=bytearray();answered=0;cursor=0;deadline=time.monotonic()+25;timed_out=False
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try:chunk=os.read(master,65536)
   except OSError as error:
    if error.errno==errno.EIO:break
    raise
   if not chunk:break
   output.extend(chunk)
   if len(output)>1048576:raise RuntimeError('terminal_output_limit')
   if answered<len(steps):
    step=steps[answered];position=output.find(step['prompt'].encode(),cursor)
    if position>=0:
     if step.get('interrupt'):os.kill(child.pid,signal.SIGINT)
     else:
      if step.get('state'):
       path=sys.argv[3];value=json.load(open(path));value.update(step['state']);json.dump(value,open(path,'w'))
      os.write(master,step['answer'].encode())
     cursor=position+len(step['prompt'].encode());answered+=1
 else:timed_out=True
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 os.close(master)
print(json.dumps({'exit':child.wait(),'output':output.decode(errors='replace'),'answered':answered,'timed_out':timed_out}))
`;
  const result=spawnSync('/usr/bin/python3',['-I','-S','-c',driver,JSON.stringify([process.execPath,cli,'research','--repository',f.repository,...args]),JSON.stringify(steps),f.stateFile],{env:{...f.env,TERM:'xterm-256color'},cwd:f.root,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);const terminal=JSON.parse(result.stdout);assert.equal(terminal.timed_out,false,terminal.output);assert.equal(terminal.answered,steps.length,terminal.output);return terminal;
}

test("deep preview refuses unsupported original runtimes before any owner or preparation call", t=>{
  const f=controlledDeepResearch(t,{capable:false}),result=f.run([...deepFlags,"--question",question,"--source",f.source,"--json"]);
  assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/original runtime.*deep research/iu);assert.match(result.stderr,/upgrade-runtime yes/u);assert.deepEqual(f.state().calls,[]);
});

test("omitted quick mode retains its literal identity and old request while deep selection is separate",t=>{
  const f=controlledDeepResearch(t),args=["--question",question,"--source",f.source];
  const original=previewFrom(f.run([...args,"--json"])),bytes=readFileSync(original.prepared_file),request=JSON.parse(readFileSync(original.request));
  assert.equal(request.schema,'flow.research-preparation-request/v1');assert.equal(Object.hasOwn(request,'deep'),false);assert.equal(Object.hasOwn(original,'deep'),false);assert.equal(request.limits.max_revisions,0);
  const before=f.state().calls.length,explicit=previewFrom(f.run([...args,"--mode","quick","--json"]));
  assert.equal(explicit.selection_digest,original.selection_digest);assert.equal(explicit.confirmation_digest,original.confirmation_digest);assert.deepEqual(readFileSync(explicit.prepared_file),bytes);assert.equal(f.state().calls.length,before);
  assert.ok(f.state().calls.some(args=>JSON.stringify(args)===JSON.stringify(['start','--json'])));assert.equal(f.state().launches,0);
});

test("deep preview binds both fixed angles and actual whole-cycle and native bounds without dispatch",t=>{
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2});
  const preview=previewFrom(f.run([...deepFlags,"--question",question,"--source",f.source,"--json"]));
  assert.deepEqual(preview.deep,{schema:'flow.project-deep-research-selection/v1',angles:[{angle_id:'angle:1',text:'Connection-local notification limits'},{angle_id:'angle:2',text:'Durable cross-process verification'}],parallel:2,max_cycles:2});
  assert.equal(preview.owner_delegate_capacity,2);assert.equal(preview.inspection.deep.initial_graph_cards,5);assert.equal(preview.inspection.deep.max_graph_cards,10);assert.equal(preview.inspection.deep.max_native_attempts,6);assert.equal(preview.inspection.routes.length,6);
  const request=JSON.parse(readFileSync(preview.request));assert.equal(request.schema,'flow.deep-research-preparation-request/v1');assert.equal(request.limits.max_revisions,1);assert.equal(request.packet.sources[0].content,readFileSync(f.source,'utf8'));assert.deepEqual(request.deep,preview.deep);
  const prepared=readFileSync(preview.prepared_file),declined=terminalResearch(f,[...deepFlags,"--question",question,"--source",f.source],[{prompt:'Launch this exact supervised research? [y/N]',answer:'n\n'}]);
  captureUi('confirmation-preview.pty.txt',declined.output);
  assert.equal(declined.exit,0,declined.output);assert.match(declined.output,/Total cycles: 2/iu);assert.match(declined.output,/maximum native attempts: 6/iu);assert.match(declined.output,/Actual initial graph: 5 cards/iu);assert.match(declined.output,/remaining cycle|remaining.*cycle|whole.*cycle/iu);assert.match(declined.output,/question requires an exact same-run checkpoint/iu);
  assert.deepEqual(readFileSync(preview.prepared_file),prepared);
  assert.equal(f.state().preparations,1);assert.equal(f.state().launches,0);
});

test("a fresh deep owner requests two runner slots while an insufficient running owner is not resized",t=>{
  const fresh=controlledDeepResearch(t),preview=previewFrom(fresh.run([...deepFlags,"--question",question,"--source",fresh.source,"--json"]));
  assert.equal(preview.owner_delegate_capacity,2);
  assert.ok(fresh.state().calls.some(args=>JSON.stringify(args)===JSON.stringify(['start','--delegate-capacity','2','--json'])));
  const existing=controlledDeepResearch(t);existing.change({started:true,capacity:1});
  const refused=existing.run([...deepFlags,"--question",question,"--source",existing.source,"--json"]);
  assert.equal(refused.status,1,refused.stdout+refused.stderr);assert.match(refused.stderr,/capacity/iu);
  assert.equal(existing.state().capacity,1);assert.equal(existing.state().preparations,0);assert.equal(existing.state().launches,0);
  assert.ok(existing.state().calls.every(args=>args[0]!=='stop'&&!args.includes('--delegate-capacity')));
});

test("deep confirmation refuses changed source bytes and coherent metadata that drops its selected policy",t=>{
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2});
  const preview=previewFrom(f.run([...deepFlags,"--question",question,"--source",f.source,"--json"])),prepared=readFileSync(preview.prepared_file);
  writeFileSync(f.source,"Different supplied evidence must not reuse the old question packet.\n");
  const changed=f.run(['--confirm',preview.confirmation_digest,'--no-follow','--json']);
  assert.equal(changed.status,1,changed.stdout+changed.stderr);assert.match(changed.stderr,/source bytes changed/iu);assert.equal(f.state().launches,0);assert.deepEqual(readFileSync(preview.prepared_file),prepared);
  const dropped=controlledDeepResearch(t);dropped.change({started:true,capacity:2,drop_deep:true});
  const rejected=dropped.run([...deepFlags,'--question',question,'--source',dropped.source,'--json']);
  assert.equal(rejected.status,1,rejected.stdout+rejected.stderr);assert.match(rejected.stderr,/prepared deep research.*exact selected/iu);assert.equal(dropped.state().launches,0);
});

test("deep selection rejects incomplete angles and changed attachment policy before client discovery", t => {
  const root = mkdtempSync("/tmp/flow-deep-research-invalid-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), LANG: "C.UTF-8" };
  for (const [args, message] of [
    [["--mode", "deep", "--angle", "Connection-local invalidation"], /two distinct.*angle/iu],
    [["--attach", `run:${"a".repeat(64)}`, "--mode", "deep"], /saved.*policy|omit.*mode/iu],
    [["--mode", "deep", "--angle", "Connection-local invalidation", "--angle", "Cross-process continuity", "--max-cycles", "3"], /max-cycles 1\|2/iu],
  ]) {
    const result = spawnSync(process.execPath, [cli, "research", ...args], {
      env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /initialize|Git project/iu);
  }
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
});


test("lost deep launch reply and repeated confirmation adopt the same saved run without policy changes",t=>{
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2,lose_reply:true});
  const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));
  const prepared=readFileSync(preview.prepared_file),confirm=['--confirm',preview.confirmation_digest,'--no-follow','--json'];
  const first=f.run(confirm);assert.equal(first.status,0,first.stdout+first.stderr);
  const result=first.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.schema==='flow.project-deep-research-result/v1');
  assert.equal(result.run_id,preview.run_id);assert.equal(result.status,'detached');assert.deepEqual(result.deep,preview.deep);
  const repeated=f.run(confirm);assert.equal(repeated.status,0,repeated.stdout+repeated.stderr);
  assert.equal(f.state().launches,1);assert.equal(f.state().preparations,1);assert.deepEqual(readFileSync(preview.prepared_file),prepared);
  const attached=f.run(['--attach',preview.run_id,'--no-follow','--json']);assert.equal(attached.status,0,attached.stdout+attached.stderr);
  assert.match(attached.stdout,/flow.project-deep-research-result\/v1/u);assert.equal(f.state().launches,1);
  const cancelled=f.run(['--cancel',preview.run_id,'--json']);assert.equal(cancelled.status,1,cancelled.stdout+cancelled.stderr);
  const terminal=cancelled.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.schema==='flow.project-deep-research-result/v1');
  assert.equal(terminal.run_id,preview.run_id);assert.equal(terminal.status,'cancelled');assert.equal(terminal.report,null);
  assert.equal(f.state().launches,1);assert.equal(f.state().commands,1);
});

test("real terminal confirms deep research then Ctrl-C detaches and exact attach preserves the run",t=>{
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2});
  const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));
  const tty=terminalResearch(f,[...deepFlags,'--question',question,'--source',f.source],[
    {prompt:'Launch this exact supervised research? [y/N]',answer:'y\n'},
    {prompt:`Run ${preview.run_id}: active`,interrupt:true},
  ]);
  captureUi('active-detach.pty.txt',tty.output);
  assert.equal(tty.exit,130,tty.output);assert.match(tty.output,/Deep research result/iu);assert.match(tty.output,/detached/iu);assert.match(tty.output,/--attach/iu);
  const attached=f.run(['--attach',preview.run_id,'--no-follow','--json']);assert.equal(attached.status,0,attached.stdout+attached.stderr);
  assert.ok(attached.stdout.includes(preview.run_id));assert.equal(f.state().launches,1);assert.equal(f.state().commands??0,0);assert.equal(f.state().preparations,1);
});


test("deep public results retain validated cycle history, genuine findings and gaps while a semantic cap is distinct from operational failure",t=>{
 const f=controlledDeepResearch(t);f.change({started:true,capacity:2,mode:'complete'});
 const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));
 const confirmed=f.run(['--confirm',preview.confirmation_digest,'--json']);assert.equal(confirmed.status,0,confirmed.stdout+confirmed.stderr);
 const result=confirmed.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.schema==='flow.project-deep-research-result/v1');
 assert.equal(result.status,'succeeded');assert.equal(result.report.cycles_used,2);assert.equal(result.report.cap_exhausted,true);assert.equal(result.deep_research.history.length,6);assert.equal(result.report.assurance,'lower');
 assert.deepEqual(result.report.findings,['Notification scope is narrower than an integrity guarantee.']);assert.deepEqual(result.report.residual_gaps,['Supported-host notification behavior has not been measured.']);assert.equal(Object.hasOwn(result,'candidate'),false);assert.equal(Object.hasOwn(result,'approval'),false);
 const human=f.run(['--attach',preview.run_id]);assert.equal(human.status,0,human.stdout+human.stderr);captureUi('completed-cap-report.txt',human.stdout);assert.match(human.stdout,/Notification scope is narrower/iu);assert.match(human.stdout,/cycle.*cap|cap.*cycle/iu);assert.match(human.stdout,/lower/iu);
 f.change({mode:'blocked'});const blocked=f.run(['--attach',preview.run_id,'--json']);assert.equal(blocked.status,1,blocked.stdout+blocked.stderr);const failure=blocked.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.schema==='flow.project-deep-research-result/v1');assert.equal(failure.status,'blocked');assert.equal(failure.phase,'active');assert.equal(failure.report,null);assert.equal(failure.deep_research.operationally_blocked,true);assert.ok(failure.deep_research.history.some(entry=>entry.angle_id==='angle:2'&&entry.disposition==='operational_failure'&&entry.output===null&&entry.tree_retired===true));
 const blockedHuman=f.run(['--attach',preview.run_id]);assert.equal(blockedHuman.status,1,blockedHuman.stdout+blockedHuman.stderr);captureUi('settled-operational-block.txt',blockedHuman.stdout);assert.match(blockedHuman.stdout,/operational_failure/iu);assert.match(blockedHuman.stdout,/blocked/iu);
 f.change({mode:'forged'});const forged=f.run(['--attach',preview.run_id,'--json']);assert.equal(forged.status,1,forged.stdout+forged.stderr);assert.match(forged.stderr,/report no longer binds/iu);assert.equal(f.state().launches,1);
});


test("same-run scope decisions show exact question and remaining bounds, require fresh approval and retain original scope on decline",t=>{
 for(const decision of ['approve','decline']){
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2,mode:'scope'});
  const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));
  const launch=f.run(['--confirm',preview.confirmation_digest,'--no-follow','--json']);assert.equal(launch.status,0,launch.stdout+launch.stderr);
  const tty=terminalResearch(f,['--attach',preview.run_id],[{prompt:'Choice number, or Enter to detach:',answer:decision==='approve'?'1\n':'2\n'},{prompt:'Submit this exact decision? [y/N]',answer:'y\n'}]);
  assert.equal(tty.exit,0,tty.output);captureUi('scope-'+decision+'.pty.txt',tty.output);assert.match(tty.output,/Same-run research scope checkpoint/iu);assert.ok(tty.output.includes(question));assert.match(tty.output,/What independent checks protect consumers across connections/iu);assert.match(tty.output,/583 seconds.*remaining total cycles: 1/iu);assert.match(tty.output,/3 native attempts/iu);
  const selected=f.state().decisions;assert.equal(selected.length,1);assert.equal(selected[0].decision,decision);assert.equal(selected[0].run_id,preview.run_id);assert.equal(selected[0].checkpoint_binding.draft.unchanged_packet_digest,preview.packet.packet_digest);
  const attached=f.run(['--attach',preview.run_id,'--json']);assert.equal(attached.status,0,attached.stdout+attached.stderr);const result=attached.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(value=>value.schema==='flow.project-deep-research-result/v1');
  assert.equal(result.status,'succeeded');assert.equal(result.original_question.text,question);assert.equal(result.question.text,decision==='approve'?'What independent checks protect consumers across connections?':question);assert.equal(result.report.cycles_used,decision==='approve'?2:1);assert.equal(result.packet_digest,preview.packet.packet_digest);assert.deepEqual(result.deep,preview.deep);assert.equal(f.state().launches,1);
 }
});

test("stale or unsafe scope choices submit no decision, and unknown elapsed time cannot complete through decline",t=>{
 for(const mode of ['scope','scope_unsafe','scope_unknown']){
  const f=controlledDeepResearch(t);f.change({started:true,capacity:2,mode});const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));const launched=f.run(['--confirm',preview.confirmation_digest,'--no-follow','--json']);assert.equal(launched.status,0,launched.stdout+launched.stderr);
  if(mode==='scope_unsafe'){
   const tty=terminalResearch(f,['--attach',preview.run_id],[{prompt:'Choice number, or Enter to detach:',answer:'1\n'}]);assert.equal(tty.exit,1,tty.output);assert.match(tty.output,/scope checkpoint does not bind/iu);assert.equal(f.state().commands??0,0);
  }else if(mode==='scope'){
   const tty=terminalResearch(f,['--attach',preview.run_id],[{prompt:'Choice number, or Enter to detach:',answer:'1\n'},{prompt:'Submit this exact decision? [y/N]',answer:'y\n',state:{stale:true}}]);
   assert.equal(tty.exit,1,tty.output);assert.match(tty.output,/decision is no longer offered/iu);assert.equal(f.state().commands??0,0);
  }else{
   const blocked=f.run(['--attach',preview.run_id]);assert.equal(blocked.status,1,blocked.stdout+blocked.stderr);captureUi('scope-unknown-time.txt',blocked.stdout);assert.match(blocked.stdout,/Remaining original budget: unavailable or exhausted/iu);assert.match(blocked.stdout,/diagnostic evidence, not successful completion/iu);assert.doesNotMatch(blocked.stdout,/Submit this exact decision/u);assert.equal(f.state().commands??0,0);
  }
  assert.equal(f.state().launches,1);assert.equal(f.state().preparations,1);
 }
});

test("runs preserves a prepared deep intent and prints its exact saved confirmation without starting it",t=>{
 const f=controlledDeepResearch(t);f.change({started:true,capacity:2});
 const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));
 const before=f.state().calls.length,inventory=f.call(['runs','--repository',f.repository,'--client',f.directory,'--json']);
 assert.equal(inventory.status,0,inventory.stdout+inventory.stderr);const report=JSON.parse(inventory.stdout);
 const attempt=report.attempts.find(attempt=>attempt.intended_run_id===preview.run_id||attempt.run_id===preview.run_id);assert.ok(attempt,inventory.stdout);assert.equal(attempt.state,'prepared');
 const confirm=attempt.next_commands.find(command=>command.kind==='confirm');assert.ok(confirm,inventory.stdout);assert.ok(confirm.command.includes(preview.confirmation_digest));assert.match(confirm.command,/flow-supervised research/iu);assert.doesNotMatch(confirm.command,/--mode|--angle|--max-cycles/iu);
 assert.equal(f.state().launches,0);assert.equal(f.state().preparations,1);assert.ok(f.state().calls.slice(before).every(args=>['status','query'].includes(args[0])));
});

test("usage inspects the exact deep run and all recorded cycle attempts without inventing metrics or starting an owner",t=>{
 const f=controlledDeepResearch(t);f.change({started:true,capacity:2,mode:'complete'});
 const preview=previewFrom(f.run([...deepFlags,'--question',question,'--source',f.source,'--json']));const confirmed=f.run(['--confirm',preview.confirmation_digest,'--no-follow','--json']);assert.equal(confirmed.status,0,confirmed.stdout+confirmed.stderr);
 // A metadata-only sentinel selects the public stopped inspection transport.
 // It is never opened as SQLite and is removed before the preservation check.
 const database=join(f.authority,'authority.sqlite'),bytes=Buffer.from('Owned controlled inspection sentinel; no real authority database.\n');writeFileSync(database,bytes,{mode:0o600});
 try{
  const before=f.state().calls.length,inspected=f.call(['usage','--repository',f.repository,'--client',f.directory,'--run',preview.run_id,'--json']);
  assert.equal(inspected.status,1,inspected.stdout+inspected.stderr);const report=JSON.parse(inspected.stdout);assert.equal(report.schema,'flow.project-usage/v1');assert.equal(report.root_run_id,preview.run_id);assert.equal(report.observation,'inspect_only');assert.equal(report.runtime_root,f.runtime);assert.equal(report.complete,false);
  assert.equal(report.attempt_count,6);assert.equal(new Set(report.attempts.map(attempt=>attempt.card_id)).size,6);assert.ok(report.attempts.every(attempt=>attempt.run_id===preview.run_id&&attempt.status==='unavailable'));assert.equal(report.cost.billing,null);assert.equal(report.cost.known_list_cost_usd,null);assert.deepEqual(readFileSync(database),bytes);
  const calls=f.state().calls.slice(before);assert.equal(calls.length,1);assert.equal(calls[0][0],'query');assert.ok(calls[0].includes(JSON.stringify({run_id:preview.run_id})));assert.equal(f.state().launches,1);assert.equal(f.state().preparations,1);
 }finally{rmSync(database);}
});
