// Linux-only finite synthetic observation diagnostic. See docs/flow/observation.md.
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
const [source, output] = process.argv.slice(2);
const socketOnly = process.argv.includes("--socket-only");
const load = path => import(pathToFileURL(join(source,path)));
const { createFlowRuntime } = await load("tools/flow/src/flow-runtime.mjs");
const { dynamicCheckpointProposal, confirmedLaunchRequest } = await load("tools/flow/test-support/dynamic-checkpoint.mjs");
const { createFixedTimeDurableRunAuthority, fixedHostIdentity } = await load("tools/flow/test-support/fixed-host-identity.mjs");
const { createProjectionWatcher } = await load("tools/flow/src/projection-watcher.mjs");
const { watchFlowTransport, FLOW_RUNTIME_INTERFACE, FLOW_TRANSPORT_RESPONSE } = await load("config/flow/src/transport.mjs");
const responseFrame = ({ operation, requestId, ...values }) => ({ schema: FLOW_TRANSPORT_RESPONSE, interface: FLOW_RUNTIME_INTERFACE, version: 1, request_id: requestId, operation, ok: true, ...values });
const plan = JSON.parse(readFileSync(join(output,"measurement-plan.json")));
const began = performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (condition,message) => { if (!condition) throw new Error(message); };
function metrics() {
 const io = Object.fromEntries(readFileSync("/proc/self/io","utf8").trim().split("\n").map(line=>{const [key,value]=line.split(":");return [key,Number(value.trim())];}));
 return { wall:performance.now(), cpu:process.cpuUsage(), io, rss:process.memoryUsage().rss, maxrss:process.resourceUsage().maxRSS*1024 };
}
function delta(before,after) {
 const wall = after.wall-before.wall;
 return {wall_ms:wall,user_cpu_ms:(after.cpu.user-before.cpu.user)/1000,system_cpu_ms:(after.cpu.system-before.cpu.system)/1000,cpu_percent_one_core:((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/wall*100,
 logical_read_chars:after.io.rchar-before.io.rchar,read_syscalls:after.io.syscr-before.io.syscr,physical_read_bytes:after.io.read_bytes-before.io.read_bytes,physical_write_bytes:after.io.write_bytes-before.io.write_bytes,rss_bytes:after.rss,peak_rss_bytes:after.maxrss};
}
function stats(samples) { const sorted=[...samples].sort((a,b)=>a-b);return {samples:sorted.length,min_ms:sorted[0],p50_ms:sorted[Math.ceil(sorted.length*.5)-1],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1)}; }
function proposal(count,label) {
 const p=dynamicCheckpointProposal(), card=p.graph.cards[0];p.requested_authority.commands.push("cancel");
 p.graph.cards=Array.from({length:count},(_,index)=>({...structuredClone(card),id:`checkpoint-${index}`,inputs:{prompt:label+":"+"x".repeat(plan.workload.accepted_prompt_bytes_per_card)}}));
 p.explicit_facts.limits.max_cards=count;
 return p;
}
function prepare(runtime,count,label) { const p=runtime.prepare(proposal(count,label));check(p.schema==="flow.prepared-run/v1","prepare refused "+JSON.stringify(p));return p; }
function launch(runtime,prepared) { const value=runtime.launch(confirmedLaunchRequest(prepared));check(value.created===true,"launch refused "+JSON.stringify(value));return value.run_id; }
function action(runtime,runId,type) { const p=runtime.query({run_id:runId});const a=p.legal_actions.find(a=>a.type===type);check(a,"no fresh action "+type);const before=performance.now();const result=runtime.command(a);check(result.accepted===true,"command refused "+JSON.stringify(result));return performance.now()-before; }
function diskBytes(root) {return readdirSync(root,{withFileTypes:true}).reduce((sum,entry)=>sum+(entry.isDirectory()?diskBytes(join(root,entry.name)):statSync(join(root,entry.name)).size),0);}
const authorities=[],results=[];
let outcome;
try {
 for(const cards of (socketOnly ? [] : plan.workload.checkpoint_cards)) {
  for(const observers of plan.workload.watchers) {
  const directory=join(output,`authority-${cards}-${observers}`);mkdirSync(directory,{mode:0o700});
  const authority=createFixedTimeDurableRunAuthority({authorityDirectory:directory,hostIdentityAdapter:fixedHostIdentity("boot-a",`owner-${cards}`),declaredCapacity:16});authorities.push(authority);
  const owner=createFlowRuntime({runAuthority:authority});
  const prepared=prepare(owner,cards,`measurement-${cards}`),runId=launch(owner,prepared);
  for(let i=0;i<Math.max(0,cards-plan.workload.complete_all_but);i++) action(owner,runId,"checkpoint_decision");
  const db=new DatabaseSync(join(directory,"authority.sqlite"),{readOnly:true});
  const eventCounts=db.prepare("SELECT stream_kind, count(*) AS streams, sum(head_sequence) AS events FROM authority_streams GROUP BY stream_kind").all();db.close();
   const inspectors=Array.from({length:observers},(_,i)=>createFixedTimeDurableRunAuthority({authorityDirectory:directory,access:"inspect",hostIdentityAdapter:fixedHostIdentity("boot-a",`inspect-${i}`)}));
   const runtimes=inspectors.map(a=>createFlowRuntime({runAuthority:a}));
   const samples=[];for(let i=0;i<plan.workload.warm_query_samples;i++){const before=performance.now();check(runtimes[0].query({run_id:runId}).run_id===runId,"query mismatch");samples.push(performance.now()-before);}
   const watchers=runtimes.map(runtime=>runtime.watch({run_id:runId})),last=[],drains=[];let watchError=null;
   for(const [index,watcher] of watchers.entries()) drains.push((async()=>{try{for await(const p of watcher)last[index]=p;}catch(error){watchError={code:error.code,message:error.message};}})());
   await sleep(50);const before=metrics();await sleep(plan.workload.idle_seconds_per_case*1000);const idle=delta(before,metrics());
   const control={admission:[],cancellation:[],update_detection:[]};
   // Exact accepted control requests are prepared before admission timing.
   // Commands use a freshly queried legal action; completion is not inferred from acceptance.
   const next=prepare(owner,1,`control-${cards}-${observers}`);let started=performance.now();
   const controlRun=launch(owner,next);control.admission.push(performance.now()-started);
   control.cancellation.push(action(owner,controlRun,"cancel"));
   if(cards===plan.workload.checkpoint_cards.at(-1)) {
    started=performance.now();control.cancellation.push(action(owner,runId,"cancel"));
    const expected=owner.query({run_id:runId}).watermark;
    while(last.some(p=>p?.watermark!==expected)) {check(performance.now()-started<5000,"watch failed to reach exact final full-query watermark");await sleep(1);}
    control.update_detection.push(performance.now()-started);
    for(let i=1;i<plan.workload.control_admission_cancel_samples;i++) {
     const next=prepare(owner,1,`control-${cards}-${observers}-${i}`);const start=performance.now();const id=launch(owner,next);control.admission.push(performance.now()-start);control.cancellation.push(action(owner,id,"cancel"));
    }
   }
   await Promise.all(watchers.map(w=>w.return()));await Promise.all(drains);inspectors.forEach(a=>a.close());
   check(watchError===null,"watch failed "+JSON.stringify(watchError));
   const fixtureBytes=diskBytes(directory);check(diskBytes(output)<plan.bounds.fixture_bytes,"total fixture byte cap");
   const row={cards,observers,run_id:runId,event_counts:eventCounts,attempt_count:owner.query({run_id:runId}).attempts.length,accepted_prepared_bytes:Buffer.byteLength(JSON.stringify(prepared)),accepted_prompt_bytes:prepared.graph.cards.reduce((sum,card)=>sum+Buffer.byteLength(card.inputs.prompt),0),prompt_padding_bytes:cards*plan.workload.accepted_prompt_bytes_per_card,fixture_bytes:fixtureBytes,warm_query_descriptive:stats(samples),idle,control,elapsed_ms:performance.now()-began};
   results.push(row);writeFileSync(join(output,"progress.json"),JSON.stringify(results,null,2)+"\n");
  }
 }
 const primitive=createProjectionWatcher({initialProjection:{watermark:"initial"},close(){}});
 for(let i=0;i<plan.workload.slow_consumer_burst_frames;i++) primitive.publish({watermark:`watermark-${i}`,payload:"x".repeat(1024)});
 let retained=0,primitiveError=null;
 try{for(let i=0;i<=plan.workload.slow_consumer_burst_frames;i++){const item=await primitive.next();if(item.done)break;retained++;}}catch(error){primitiveError={code:error.code,message:error.message};}
 await primitive.return();
 const socketErrors=[];let peerClosed;const peerClosedPromise=new Promise(resolve=>{peerClosed=resolve;});
 const socketRoot=mkdtempSync("/tmp/flow-observe-socket-"),socketPath=join(socketRoot,"s"),server=createServer(socket=>{
  socket.once("close",peerClosed);socket.on("error",error=>{socketErrors.push(error.code ?? "owned_socket_error");});
  let buffer="";socket.on("data",chunk=>{buffer+=chunk.toString();if(!buffer.includes("\n"))return;const request=JSON.parse(buffer.split("\n")[0]);socket.removeAllListeners("data");
   for(let i=0;i<plan.workload.slow_consumer_burst_frames;i++)socket.write(JSON.stringify(responseFrame({operation:"watch",requestId:request.request_id,done:false,sequence:i,result:{watermark:`watermark-${i}`,payload:"x".repeat(1024)}}))+"\n");
   socket.end(JSON.stringify(responseFrame({operation:"watch",requestId:request.request_id,done:true,sequence:plan.workload.slow_consumer_burst_frames}))+"\n");});});
 await new Promise(resolve=>server.listen(socketPath,resolve));const watcher=watchFlowTransport({socketPath,request:{}});await peerClosedPromise;
 let transportRetained=0,transportError=null;try{for await(const item of watcher)transportRetained++;}catch(error){transportError={code:error.code,message:error.message};}
 await watcher.return();await new Promise(resolve=>server.close(resolve));rmSync(socketRoot,{recursive:true,force:true});
 outcome={schema:"flow.observation-linux-measurement/v1",measurement_mode:socketOnly?"socket-only":"full",host:{platform:process.platform,arch:process.arch,node:process.version,kernel:os.release(),cpu:os.cpus()[0]?.model,available_parallelism:os.availableParallelism()},plan_sha256:hash(readFileSync(join(output,"measurement-plan.json"))),results,slow_consumer:{published:plan.workload.slow_consumer_burst_frames,primitive_retained:retained,primitive_error:primitiveError,transport_retained:transportRetained,transport_error:transportError,owned_socket_errors:socketErrors},elapsed_ms:performance.now()-began,scope:plan.scope};
 writeFileSync(join(output,"report.json"),JSON.stringify(outcome,null,2)+"\n");console.log(JSON.stringify({report:join(output,"report.json"),sha256:hash(readFileSync(join(output,"report.json"))),elapsed_ms:outcome.elapsed_ms}));
} finally { for(const authority of authorities.reverse())authority.close(); }
