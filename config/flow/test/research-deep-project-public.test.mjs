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
 const request=state.request,plan=graph(request),question=request.packet.question;
 result={schema:'flow.run-projection/v1',run_id:state.run_id,bundle_digest:state.bundle_digest,phase:state.cancelled?'cancelled':'active',watermark:'sha256:'+'7'.repeat(64),sequence:6,active_plan:plan,
  cards:plan.cards.map(card=>({id:card.id,status:card.executor.kind==='delegate'?'executing':'pending'})),effects:[],delegate_attempts:[],resource_dispositions:[],blocks:[],
  ...(request.deep?{deep_research:{schema:'flow.deep-research-progress/v1',cycle:1,scope:{question_id:question.id,text:question.text,source_packet_digest:request.packet.packet_digest,original_question_id:question.id,scope_digest:digest(question)},angles:request.deep.angles.map((angle,index)=>({...angle,card_id:'deep-angle-'+(index+1)+'-cycle-1',cycle:1,status:'executing',effect_id:null,attempt_id:null})),history:[],report:null,scope_proposal:null,operationally_blocked:false}}:{}),
  legal_actions:state.cancelled?[]:[{schema:'flow.command/v1',type:'cancel',run_id:state.run_id,expected_watermark:'sha256:'+'7'.repeat(64)}]};break;
}
case 'launch':{const prepared=input().prepared;state.run_id='run:'+prepared.bundle_digest.slice(7);state.bundle_digest=prepared.bundle_digest;state.launched=true;state.launches++;if(state.lose_reply&&!state.reply_lost){state.reply_lost=true;save(file,state);process.exit(99);}result={schema:'flow.launch-receipt/v1',run_id:state.run_id};break;}
case 'command':state.commands=(state.commands??0)+1;state.cancelled=true;result={schema:'flow.command-receipt/v1',run_id:state.run_id,outcome:'accepted'};break;
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
     else:os.write(master,step['answer'].encode())
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
  const result=spawnSync('/usr/bin/python3',['-I','-S','-c',driver,JSON.stringify([process.execPath,cli,'research','--repository',f.repository,...args]),JSON.stringify(steps)],{env:{...f.env,TERM:'xterm-256color'},cwd:f.root,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
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
