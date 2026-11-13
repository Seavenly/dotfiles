import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { createDeepResearchSelection } from '../../../tools/flow/src/deep-research-contract.mjs';
import { readResearchSourcePacket } from './research-source-files.mjs';
import { discoverInitializedClients, failRun } from './project-run-state.mjs';
import { runDecisionActions, terminalText } from './project-run-view.mjs';
import { callProjectClient, followProjectSession, input, ownerStart, preparePreview, requireRun, submitDecision, submitPrepared } from './project-session.mjs';
import { findResearchSession, materializeResearchRequest, researchPolicy, researchSelection, revalidateResearchSources, requireDeepResearchRuntime, validateDeepResearchPreview } from './project-research-state.mjs';
import { researchAttachCommand, researchConfirmCommand, renderResearchPreview, renderResearchResult, renderResearchScopeCheckpoint, summarizeProjectResearch } from './project-research-view.mjs';

export const RESEARCH_USAGE=`Usage:
  flow-supervised research --question TEXT --source FILE [--source FILE ...] [--json]
  flow-supervised research --mode deep --question TEXT --source FILE --angle TEXT --angle TEXT [--parallel 1|2] [--max-cycles 1|2] [--json]
  flow-supervised research --client DIRECTORY --confirm sha256:DIGEST [--json]
  flow-supervised research --client DIRECTORY --attach RUN_ID [--action sha256:DIGEST] [--json]
  flow-supervised research --client DIRECTORY --cancel RUN_ID [--json]

Select --repository PATH (default current Git project) and an exact --client
DIRECTORY when several initialized clients exist. Start a fresh project with
flow-supervised init --purpose research; no feature brief or project check is needed.
One question is at most 4 KiB; supply one through four regular UTF-8 sources of
at most 32 KiB each, 128 KiB total. Files are snapshotted and hashed, never fetched.
Existing safety policy rejects unsafe source contents without echoing them.
--timeout-seconds 1..3600 (default 600) selects the overall prepared-run limit;
one attempt per card. Quick research permits zero revisions. No per-role timer is promised.
--refresh explicitly replaces only a proven unlaunched preview, retaining history.
--follow-seconds 1..3600 (default 1800) bounds observation only; --no-follow detaches.
Ctrl-C detaches without cancelling. Reattach the SAME exact run. --action selects
only a fresh authority decision. Attach/cancel never changes source or run policy.
Deep research confirms exactly two distinct angles, each at most 1 KiB UTF-8.
Default deep bounds: parallel 2 and two total cycles (initial plus one revision),
at most six native attempts. Each cycle has a fresh gap critic. Scope widening
requires a fresh exact same-run checkpoint; original elapsed/cycle bounds remain.
Omit --mode for the unchanged quick researcher-and-synthesizer path.
Preview may start/reuse the original owner and recover already authorized work.
Launch requires explicit confirmation. No prototype, project test, candidate,
approval or publication is performed; lower-assurance reports retain residual gaps.
`;
export function parseResearchArguments(args) {
 const options={sources:[]},flags=new Set(['--json','--no-follow','--refresh','--help','-h']),values=new Set(['--repository','--client','--question','--source','--confirm','--attach','--cancel','--action','--follow-seconds','--timeout-seconds','--max-revisions','--mode','--angle','--parallel','--max-cycles']);
 for(let index=0;index<args.length;index++) {
  const flag=args[index];
  if(!flags.has(flag)&&!values.has(flag)||!['--source','--angle'].includes(flag)&&Object.hasOwn(options,flag))failRun(`Unknown or repeated research option: ${flag}`);
  const value=flags.has(flag)?true:args[++index];if(!value||typeof value==='string'&&value.startsWith('--'))failRun(`Missing value for ${flag}`);
  if(flag==='--source')options.sources.push(value);else if(flag==='--angle')(options.angles??=[]).push(value);else options[flag]=value;
 }
 if([options['--confirm'],options['--attach'],options['--cancel']].filter(Boolean).length>1||options['--refresh']&&(options['--confirm']||options['--attach']||options['--cancel']))failRun('Choose preview/refresh, confirm, attach or cancel separately.');
 if((options['--attach']||options['--cancel'])&&(options.sources.length||options['--question']||options['--timeout-seconds']||options['--max-revisions']||options['--mode']||options.angles||options['--parallel']||options['--max-cycles']))failRun('Attach/cancel uses the exact saved source packet and policy; omit mode/source/question/angle/cycle/policy flags.');
 if(options['--confirm']&&(options['--mode']||options.angles||options['--parallel']||options['--max-cycles']))failRun('Confirmation uses the saved exact mode, angles and cycle policy; omit new mode/angle/cycle flags.');
 if(options['--mode']!==undefined&&!['quick','deep'].includes(options['--mode']))failRun('Use --mode quick or --mode deep.');
 if(options['--mode']!=='deep'&&(options.angles||options['--parallel']||options['--max-cycles']))failRun('Use --mode deep with --angle, --parallel or --max-cycles.');
 if(options['--mode']==='deep'&&!options['--confirm']) {
  try { options.deep=createDeepResearchSelection({angles:options.angles,parallel:Number(options['--parallel']??2),max_cycles:Number(options['--max-cycles']??2)}); }
  catch(error){failRun(error.message,error.code,2);}
 }
 if(options['--action']&&!options['--attach'])failRun('Use --action with --attach RUN_ID.');
 for(const flag of ['--confirm','--action'])if(options[flag]&&!/^sha256:[a-f0-9]{64}$/.test(options[flag]))failRun(`Use exact ${flag} sha256 digest.`);
 for(const flag of ['--attach','--cancel'])if(options[flag]&&!/^run:[a-f0-9]{64}$/.test(options[flag]))failRun(`Use exact ${flag} RUN_ID.`);
 if(options['--max-revisions']!==undefined&&options['--max-revisions']!=='0')failRun('Quick research permits zero revisions only.');
 const seconds=Number(options['--follow-seconds']??1800);if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600)failRun('Use --follow-seconds 1..3600 for observation only.');
 researchPolicy(options);return options;
}
export async function researchProject(args,{env=process.env,cwd=process.cwd(),stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,callClient=callProjectClient}={}) {
 let prompts,interrupted=false,selection,intendedRunId;
 const onInterrupt=()=>{interrupted=true;prompts?.close();};process.on('SIGINT',onInterrupt);
 try {
  const options=parseResearchArguments(args);if(options['--help']||options['-h']){stdout.write(RESEARCH_USAGE);return 0;}
  const interactive=Boolean(stdin.isTTY&&stdout.isTTY&&!options['--json']);if(interactive)prompts=createInterface({input:stdin,output:stdout});
  const emit=value=>stdout.write(options['--json']?JSON.stringify(value)+'\n':value.schema==='flow.project-run-owner/v1'?terminalText(value.recovery_disclosure)+'\n':'');
  const call=(selected,args)=>callClient(selected,args,{env});
  const clients=discoverInitializedClients({repository:options['--repository'],client:options['--client'],env,cwd});
  let retained,runId=options['--attach']??options['--cancel'];
  if(runId||options['--confirm']) {
   ({selection,retained}=findResearchSession(clients,{runId,confirmation:options['--confirm']}));
   intendedRunId=retained.preview.run_id;
  } else {
   let client;
   if(clients.length===1)client=clients[0];else {
    if(!interactive)failRun('Several initialized clients exist. Select --client DIRECTORY; no owner was started.');
    stdout.write('Choose the exact initialized client:\n'+clients.map((item,index)=>`  ${index+1}. ${terminalText(item.directory)} [${terminalText(item.runtime_root)}]`).join('\n')+'\n');
    client=clients[Number(await prompts.question('Client number: '))-1];if(!client)failRun('Select one displayed client.');
   }
   if(options.deep)requireDeepResearchRuntime(client);
   else if(!existsSync(join(client.runtime_root,'tools/flow/src/research-flow.mjs')))failRun('The selected original client runtime does not support research. Use explicit init --purpose research --client DIRECTORY --upgrade-runtime yes under the stopped, settled procedure; original clients were not changed.','research_runtime_unsupported',1);
   if(interactive&&!options['--question'])options['--question']=(await prompts.question('What question should Flow research? ')).trim();
   const sources=readResearchSourcePacket({question:options['--question'],sources:options.sources,cwd});
   selection=researchSelection(client,sources.packet,sources.provenance,researchPolicy(options),{create:true,deep:options.deep});
   retained=await preparePreview(selection,{refresh:options['--refresh'],call,emit,materializeRequest:materializeResearchRequest});intendedRunId=retained.preview.run_id;
  }
  validateDeepResearchPreview(selection,retained);
  if(runId) {
   await ownerStart(selection,call,emit);
   const run=requireRun(await call(selection,input('query',{run_id:runId})),runId);
   if(run.bundle_digest!==retained.preview.bundle_digest)failRun('Research run differs from the exact retained bundle.','research_run_changed',1);
   if(options['--cancel']){const action=runDecisionActions(run).find(action=>action.type==='cancel');if(!action&&run.phase!=='cancelled')failRun('Cancellation is not currently offered. Reattach for fresh legal actions.','cancel_unavailable',1);if(action)await submitDecision(selection,runId,action.digest,call);}
   else if(options['--action'])await submitDecision(selection,runId,options['--action'],call);
  } else {
   if(options['--timeout-seconds']&&digest(researchPolicy(options,selection.deep))!==digest(selection.policy))failRun('Policy differs from the retained confirmation.','confirmation_changed',1);
   revalidateResearchSources(selection);
   if(options['--question']||options.sources.length){const current=readResearchSourcePacket({question:options['--question'],sources:options.sources,cwd});if(digest(current.packet)!==digest(selection.packet)||digest(current.provenance)!==digest(selection.source_provenance))failRun('Question or sources differ from the retained confirmation.','confirmation_changed',1);}
   if(!options['--confirm']) {
    if(options['--json'])emit(retained.preview);else stdout.write(renderResearchPreview(retained.preview));
    if(!interactive){if(!options['--json'])stdout.write(`Confirm with ${researchConfirmCommand(selection,retained.preview.confirmation_digest)}\n`);return 0;}
    if(!['y','yes'].includes((await prompts.question('Launch this exact supervised research? [y/N] ')).trim().toLowerCase())){stdout.write('No new research launched. The selected owner may remain available.\n');return 0;}
   }
   if(interrupted)return 130;
   const run=await submitPrepared(selection,retained,options['--confirm']??retained.preview.confirmation_digest,{call,emit,validateBeforeSend:()=>{validateDeepResearchPreview(selection,retained);revalidateResearchSources(selection);}});runId=run.run_id;
  }
  return await followProjectSession(selection,runId,{options,call,emit,interactive,prompts,stdout,isInterrupted:()=>interrupted,renderResult:renderResearchResult,renderDecisionContext:(run,action)=>renderResearchScopeCheckpoint(run,action,selection),finish:(run,context)=>summarizeProjectResearch(run,context)});
 } catch(error) {
  if(interrupted||error.code==='ERR_USE_AFTER_CLOSE')stderr.write('Detached. Durable work has not been cancelled.\n');else {stderr.write(terminalText(error.message)+'\n');for(const hint of error.hints??[])stderr.write(terminalText(hint)+'\n');}
  if(selection&&intendedRunId)stderr.write(`Retain exact research evidence. Reattach with ${researchAttachCommand(selection,intendedRunId)}\n`);
  return interrupted?130:error.exit??1;
 } finally {prompts?.close();process.removeListener('SIGINT',onInterrupt);}
}
