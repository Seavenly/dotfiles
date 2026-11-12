import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { readResearchSourcePacket } from './research-source-files.mjs';
import { validateResearchSourcePacket } from '../../../tools/flow/src/research-source-packet.mjs';
import { validateDeepResearchSelection } from '../../../tools/flow/src/deep-research-contract.mjs';
import { failRun, loadRetainedPreview, readRunJson, retainRunJson } from './project-run-state.mjs';
import { requirePublic } from './project-session.mjs';

export function researchPolicy(options,deep=options.deep) {
 const seconds=Number(options['--timeout-seconds']??600);
 if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600) failRun('Use --timeout-seconds 1..3600 for the overall run, not per-role timers.');
 return {max_elapsed_seconds:seconds,max_revisions:deep?deep.max_cycles-1:0};
}

/** A local capability check only refuses unsupported old clients; it grants no authority. */
export function requireDeepResearchRuntime(client) {
 const module=join(client.runtime_root,'tools/flow/src/deep-research-flow.mjs');
 let supported=false;
 try { supported=lstatSync(module).isFile()&&realpathSync(module)===resolve(module); }
 catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
 if(!supported)failRun('The selected original runtime cannot prepare deep research. Preserve its exact client and history. Use the stopped, settled explicit init --purpose research --upgrade-runtime yes procedure, then select the returned --client DIRECTORY. No owner or runtime was changed.','deep_research_runtime_unsupported',1);
}

export function validateDeepResearchPreview(selection,retained) {
 if(!selection.deep)return;
 const deep=selection.deep,prepared=retained.prepared,inspection=retained.preview.inspection,metadata=prepared.graph?.deep_research;
 if(digest(prepared.selection?.inputs?.deep??null)!==digest(deep)||digest(metadata?.deep??null)!==digest(deep)||digest(metadata?.packet??null)!==digest(selection.packet)||
    digest(inspection.deep?.selection??null)!==digest(deep)||inspection.deep?.source_packet_digest!==selection.packet.packet_digest||
    inspection.deep?.initial_graph_cards!==prepared.graph.cards.length||inspection.deep.initial_graph_cards!==5||
    inspection.deep.max_graph_cards!==deep.max_cycles*5||inspection.deep.max_native_attempts!==deep.max_cycles*3||
    inspection.deep.whole_cycle_cards?.one_angle!==4||inspection.deep.whole_cycle_cards?.both_angles!==5||
    inspection.routes?.length!==deep.max_cycles*3||prepared.explicit_facts?.limits?.max_elapsed_seconds!==selection.policy.max_elapsed_seconds||
    prepared.explicit_facts?.limits?.max_revisions!==deep.max_cycles-1||
    digest(prepared.requested_authority?.mutations??null)!==digest(['flow.research-cycle/v1'])||prepared.requested_authority?.capabilities?.length!==0)
  failRun('The prepared deep research does not bind the exact selected source packet, angles, whole-cycle costs and remaining bounds. Preserve it for inspection; nothing was launched.','deep_research_preparation_changed',1);
}
function canonicalDirectory(path) {
 for(let current=resolve(path);;current=dirname(current)) {
  let stat;try{stat=lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)) failRun('Retained research paths must remain canonical private directories; aliases are unsupported.','research_intent_changed',1);
  if(dirname(current)===current)break;
 }
}
export function researchSelection(client,packet,sourceProvenance,policy,{create=false,deep}={}) {
 if(deep!==undefined&&!validateDeepResearchSelection(deep)||!validateResearchSourcePacket(packet)||policy.max_revisions!==(deep?deep.max_cycles-1:0)||!Number.isSafeInteger(policy.max_elapsed_seconds)||policy.max_elapsed_seconds<1||policy.max_elapsed_seconds>3600) failRun('Retained research packet, angles or policy changed.','research_intent_changed',1);
 const identity={schema:'flow.project-research-intent/v1',repository:client.repository,profile:client.profile,directory:client.directory,client:client.client,authority_directory:client.authority_directory,runtime_root:client.runtime_root,node:client.node,client_digest:client.client_digest,pilot_digest:client.pilot_digest,packet,source_provenance:sourceProvenance,policy,...(deep?{deep}:{})};
 const intentDirectory=join(client.directory,'receipts','guided-research',digest(identity).slice(7)),intent=join(intentDirectory,'intent.json');
 canonicalDirectory(intentDirectory);
 if(create){mkdirSync(intentDirectory,{recursive:true,mode:0o700});if(existsSync(intent)){if(digest(readRunJson(intent))!==digest(identity))failRun('Retained research intent changed.','research_intent_changed',1);}else retainRunJson(intent,identity);}
 return {...client,...identity,selection_digest:digest(identity),intent_directory:intentDirectory,retained_directory:join(intentDirectory,'session'),request:join(intentDirectory,'session','prepare-request.json'),frontend_command:'research',preview_schema:'flow.project-research-preview/v1'};
}
export function researchIntents(client) {
 const root=join(client.directory,'receipts','guided-research');
 if(!existsSync(root))return [];
 canonicalDirectory(root); const stream=opendirSync(root),names=[];
 try{for(;;){const entry=stream.readSync();if(!entry)break;if(names.length>=128)failRun('Research intent limit reached; select and inspect original retained evidence.','research_intent_limit',1);names.push(entry.name);}}finally{stream.closeSync();}
 return names.sort().map(name=>{
  if(!/^[a-f0-9]{64}$/.test(name))failRun('Unknown retained research intent.','research_intent_changed',1);
  const intent=readRunJson(join(root,name,'intent.json'));
  const selection=researchSelection(client,intent.packet,intent.source_provenance,intent.policy,{deep:intent.deep});
  if(selection.intent_directory!==join(root,name)||digest(intent)!==selection.selection_digest)failRun('Research/client binding changed.','research_intent_changed',1);
  return selection;
 });
}
export function findResearchSession(clients,{runId,confirmation}) {
 const found=[];
 for(const client of clients)for(const selection of researchIntents(client)) {
  const path=join(selection.retained_directory,'preview.json');if(!existsSync(path))continue;
  const preview=readRunJson(path);
  if(runId&&preview.run_id!==runId||confirmation&&preview.confirmation_digest!==confirmation)continue;
  found.push({selection,retained:loadRetainedPreview(selection)});
 }
 if(found.length!==1)failRun('Select the original --client and exact retained research run or confirmation. No owner was started.','research_session_required',1);
 return found[0];
}
/** Called before every actual send, including a durable accepted-intent retry. */
export function revalidateResearchSources(selection) {
 const result=readResearchSourcePacket({question:selection.packet.question.text,sources:selection.source_provenance.map(item=>item.path)});
 if(digest(result.packet)!==digest(selection.packet)||digest(result.provenance)!==digest(selection.source_provenance))failRun('Source bytes changed after preview. Preserve accepted work; refresh only a proven unlaunched intent.','research_source_changed',1);
}
export async function materializeResearchRequest(selection,{call}={}) {
 let capacity;
 if(selection.deep) {
  const status=requirePublic(await call(selection,['status','--json']),'Original owner capacity');
  capacity=status.runner?.delegates?.capacity;
  if(status.state!=='running'||!Number.isSafeInteger(capacity)||capacity<selection.deep.parallel)failRun('The original owner does not expose enough runner delegate capacity for the selected deep research. Stop it only after its original work settles, then explicitly start that exact client with --delegate-capacity 2. No live owner was resized.','owner_delegate_capacity_insufficient',1);
 }
 mkdirSync(selection.retained_directory,{mode:0o700});
 retainRunJson(selection.request,{schema:selection.deep?'flow.deep-research-preparation-request/v1':'flow.research-preparation-request/v1',repository:selection.repository,packet:selection.packet,limits:selection.policy,execution_trust:selection.pilot.execution_trust,...(selection.deep?{deep:selection.deep}:{})});
 return {packet:selection.packet,source_provenance:selection.source_provenance,policy:selection.policy,...(selection.deep?{deep:selection.deep,owner_delegate_capacity:capacity}:{})};
}
