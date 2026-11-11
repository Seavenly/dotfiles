import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { readResearchSourcePacket } from './research-source-files.mjs';
import { validateResearchSourcePacket } from '../../../tools/flow/src/research-source-packet.mjs';
import { failRun, loadRetainedPreview, readRunJson, retainRunJson } from './project-run-state.mjs';

export function researchPolicy(options) {
 const seconds=Number(options['--timeout-seconds']??600);
 if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600) failRun('Use --timeout-seconds 1..3600 for the overall run, not per-role timers.');
 return {max_elapsed_seconds:seconds,max_revisions:0};
}
function canonicalDirectory(path) {
 for(let current=resolve(path);;current=dirname(current)) {
  let stat;try{stat=lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)) failRun('Retained research paths must remain canonical private directories; aliases are unsupported.','research_intent_changed',1);
  if(dirname(current)===current)break;
 }
}
export function researchSelection(client,packet,sourceProvenance,policy,{create=false}={}) {
 if(!validateResearchSourcePacket(packet)||policy.max_revisions!==0||!Number.isSafeInteger(policy.max_elapsed_seconds)||policy.max_elapsed_seconds<1||policy.max_elapsed_seconds>3600) failRun('Retained research packet or policy changed.','research_intent_changed',1);
 const identity={schema:'flow.project-research-intent/v1',repository:client.repository,profile:client.profile,directory:client.directory,client:client.client,authority_directory:client.authority_directory,runtime_root:client.runtime_root,node:client.node,client_digest:client.client_digest,pilot_digest:client.pilot_digest,packet,source_provenance:sourceProvenance,policy};
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
  const selection=researchSelection(client,intent.packet,intent.source_provenance,intent.policy);
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
export async function materializeResearchRequest(selection) {
 mkdirSync(selection.retained_directory,{mode:0o700});
 retainRunJson(selection.request,{schema:'flow.research-preparation-request/v1',repository:selection.repository,packet:selection.packet,limits:selection.policy,execution_trust:selection.pilot.execution_trust});
 return {packet:selection.packet,source_provenance:selection.source_provenance,policy:selection.policy};
}
