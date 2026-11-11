import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { writeFeatureClient } from '../scripts/feature-client-files.mjs';
import { researchProject, parseResearchArguments } from '../src/project-research.mjs';
import { collectProjectRuns } from '../src/project-runs-state.mjs';
import { projectRunsReport, renderProjectRuns } from '../src/project-runs-view.mjs';
const runtimeRoot=resolve(import.meta.dirname,'../../..'),trust={schema:'flow.supervised-native-cli/v1',acknowledgment:'trust-official-cli-permissions'};
const save=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});
const sink=()=>({isTTY:false,value:'',write(text){this.value+=text;}});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'guided-research-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repository=join(root,'repository'),state=join(root,'state'),source=join(root,'source.txt');mkdirSync(repository);mkdirSync(state);writeFileSync(source,'A bounded supplied note.\n');
 const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test','-C',repository,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'});
 git(['init','-q','--initial-branch=main']);writeFileSync(join(repository,'file'),'baseline');git(['add','.']);git(['commit','-qm','fixture']);
 const profileRoot=join(state,'flow-local',digest(repository).slice(7,31)),directory=join(profileRoot,'clients','verify'),authority=join(profileRoot,'authority');
 for(const path of [join(directory,'requests'),join(directory,'receipts'),authority])mkdirSync(path,{recursive:true});
 const identity={schema:'flow.local-client/v1',repository,runtime_root:runtimeRoot,node:process.execPath,executable:{path:'/uninvoked/fixture',sha256:'sha256:'+'a'.repeat(64)},execution_trust:trust,git_identity:{}};
 const files=writeFeatureClient({directory,runtimeRoot,workspace:repository,executionTrust:'supervised-native-cli',localStateHome:state,authorityDirectory:authority});
 save(join(profileRoot,'profile.json'),{identity,initial_check_digest:null});save(join(directory,'pilot.json'),{directory,runtime_root:runtimeRoot,...files,local_client:identity,execution_trust:trust});
 return{root,repository,state,source,directory,authority,env:{...process.env,FLOW_LOCAL_CLIENT_STATE_HOME:state}};
}
function transport(f){
 const state={calls:[],preparations:0,launches:0,launched:false,loseReply:false,driftBeforeSend:false,accepted:0};
 state.call=async(_selection,args)=>{
  state.calls.push(args);
  if(args[0]==='status'||args[0]==='start')return{state:'running',started:false};
  if(args[0]==='query'){
   const request=JSON.parse(args[2]);if(!request.run_id)return{schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:state.launched?[state.run.run_id]:[]};
   return state.launched?state.run:{schema:'flow.rejection/v1',code:'unknown_run'};
  }
  if(args[0]==='prepare'){
   state.preparations++;state.request=JSON.parse(readFileSync(args[2]));
   const graph={cards:[{id:'spike-research',executor:{kind:'delegate'},inputs:{task_inputs:{flow:'spike/v2',packet:state.request.packet}}}]},confirmation={question:state.request.packet.question,packet_digest:state.request.packet.packet_digest,limits:state.request.limits};
   state.prepared={schema:'flow.prepared-run/v1',bundle_digest:'sha256:'+'b'.repeat(64),graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation)};
   state.run={schema:'flow.run-projection/v1',run_id:'run:'+'b'.repeat(64),bundle_digest:state.prepared.bundle_digest,phase:'active',progress:'executing',sequence:1,cards:[],blocks:[],effects:[],delegate_attempts:[],active_plan:graph,legal_actions:[]};return state.prepared;
  }
  if(args[0]==='local'&&args[1]==='inspect-prepared')return{limits:state.request.limits,routes:[],trust_posture:{}};
  if(args[0]==='local'&&args[1]==='accept-prepared'){
   state.accepted++;const directory=join(f.directory,'receipts',`accept-${state.accepted}`);mkdirSync(directory);const request=join(directory,'launch-request.json');save(request,{prepared:state.prepared,confirmation:{confirmation_digest:state.prepared.confirmation_digest}});
   if(state.driftBeforeSend)writeFileSync(f.source,'Changed after durable acceptance.');return{request};
  }
  if(args[0]==='launch'){state.launches++;state.launched=true;if(state.loseReply)throw new Error('response lost');return{run_id:state.run.run_id};}
  throw new Error('Unexpected transport command '+args[0]);
 };
 return state;
}
async function invoke(f,transport,args=[]){const stdout=sink(),stderr=sink(),preview=!args.some(item=>['--confirm','--attach','--cancel'].includes(item));const selections=preview?['--question','What follows?','--source',f.source]:[];
 const exit=await researchProject(['--repository',f.repository,'--client',f.directory,...selections,'--json','--no-follow',...args],{env:f.env,stdout,stderr,stdin:{isTTY:false},callClient:transport.call});return{exit,stderr:stderr.value,records:stdout.value.trim().split('\n').filter(Boolean).map(JSON.parse)};}
const previewOf=result=>result.records.find(item=>item.schema==='flow.project-research-preview/v1');
test('cached exact source preview plus lost launch reply/repeat/attach retains one preparation and dispatch',async t=>{
 const f=fixture(t),api=transport(f),preview=previewOf(await invoke(f,api));assert.ok(preview);assert.equal(api.preparations,1);await invoke(f,api);assert.equal(api.preparations,1);
 api.loseReply=true;const result=await invoke(f,api,['--confirm',preview.confirmation_digest]);assert.equal(result.exit,0,result.stderr);assert.equal(result.records.at(-1).schema,'flow.project-research-result/v1');
 await invoke(f,api,['--confirm',preview.confirmation_digest]);await invoke(f,api,['--attach',preview.run_id]);assert.equal(api.launches,1);assert.equal(api.accepted,1);assert.equal(api.preparations,1);
});
test('changed source before confirmation and after durable acceptance both prevent send',async t=>{
 const f=fixture(t),api=transport(f),preview=previewOf(await invoke(f,api));writeFileSync(f.source,'Changed before yes.');let result=await invoke(f,api,['--confirm',preview.confirmation_digest]);assert.equal(result.exit,1);assert.equal(api.launches,0);assert.equal(api.accepted,0);
 writeFileSync(f.source,'A bounded supplied note.\n');api.driftBeforeSend=true;result=await invoke(f,api,['--confirm',preview.confirmation_digest]);assert.equal(result.exit,1);assert.equal(api.accepted,1);assert.equal(api.launches,0);
 result=await invoke(f,api,['--confirm',preview.confirmation_digest]);assert.equal(result.exit,1);assert.equal(api.launches,0);
});
test('attachment mismatch refuses before owner action and saved policy cannot be changed',async t=>{
 const f=fixture(t),api=transport(f);await invoke(f,api);api.calls.length=0;assert.equal((await invoke(f,api,['--attach','run:'+'c'.repeat(64)])).exit,1);assert.equal(api.calls.length,0);
 assert.throws(()=>parseResearchArguments(['--attach','run:'+'b'.repeat(64),'--timeout-seconds','5']),/saved source/);
});
test('research-only requestless client appears in runs with exact confirmation, not feature checks or candidate',async t=>{
 const f=fixture(t),api=transport(f),preview=previewOf(await invoke(f,api));
 const inventory=await collectProjectRuns({repository:f.repository,client:f.directory},{env:f.env,observer:{status:()=>({state:'stopped'}),query:()=>{throw new Error('uninitialized authority must not query');}}});
 const report=projectRunsReport(inventory),row=report.attempts.find(item=>item.kind==='research');assert.equal(report.complete,true,JSON.stringify(report));assert.equal(row.summary,'What follows?');assert.equal(row.state,'prepared');assert.equal(row.checks,null);assert.equal(row.candidate,null);assert.equal(row.research.packet_digest,preview.packet.packet_digest);
 assert.match(row.next_commands.find(item=>item.kind==='confirm').command,/flow-supervised research/);assert.match(renderProjectRuns(report),/residual gaps unknown/);assert.equal(existsSync(join(f.authority,'authority.sqlite')),false);
});

test('public research setup preview escapes an owned executable path without changing selected bytes',async t=>{
 const f=fixture(t),{runProjectInit}=await import('../src/project-init.mjs');
 const path=join(f.root,'native-\u001b[31m\npretend-confirmed');copyFileSync('/usr/bin/true',path);chmodSync(path,0o700);
 execFileSync('/usr/bin/git',['-C',f.repository,'config','user.name','Fixture']);execFileSync('/usr/bin/git',['-C',f.repository,'config','user.email','fixture@example.test']);
 const stdout=sink(),stderr=sink(),env={...f.env,FLOW_LOCAL_CLIENT_STATE_HOME:join(f.root,'new-state')};
 const exit=await runProjectInit(['--purpose','research','--repository',f.repository,'--codex-executable',path],{env,stdout,stderr,stdin:{isTTY:false}});
 assert.equal(exit,0,stderr.value);assert.equal(stdout.value.includes('\u001b'),false);assert.equal(stdout.value.includes('\npretend-confirmed'),false);assert.match(stdout.value,/\\u001b/);
 const json=sink();assert.equal(await runProjectInit(['--purpose','research','--repository',f.repository,'--codex-executable',path,'--json'],{env,stdout:json,stderr:sink(),stdin:{isTTY:false}}),0);
 assert.equal(JSON.parse(json.value).plan.codex_executable.path,path);assert.equal(existsSync(env.FLOW_LOCAL_CLIENT_STATE_HOME),false);
});
