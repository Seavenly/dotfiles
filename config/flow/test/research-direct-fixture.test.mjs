import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowRuntime, closeFlowRuntime } from '../src/runtime.mjs';
import { readResearchSourcePacket } from '../src/research-source-files.mjs';
import { readResearchReport } from '../src/project-research-view.mjs';
const trust={schema:'flow.supervised-native-cli/v1',acknowledgment:'trust-official-cli-permissions'};
// This bounded executable simulates the official wire format. It is not a
// native permission/model/version qualification or a provider request.
const executableFixture=`#!/usr/bin/python3 -I
import json,sys,pathlib
if sys.argv[1:] == ['--version']:
 print('codex-cli 0.166.0');sys.exit(0)
envelope=json.load(sys.stdin)
packet=envelope['task_inputs']['packet']
phase=envelope['task_inputs']['phase']
output={'schema':'flow.spike-research-evidence/v2' if phase=='research' else 'flow.spike-report/v2','question_id':packet['question']['id'],'answer':'Treat notifications as hints and verify authoritative state.','assurance':'lower','citations':[{'source_id':s['id'],'digest':s['digest']} for s in packet['sources']],'findings':[],'residual_gaps':['Cross-host behavior remains unmeasured.']}
if phase=='synthesis':output['research_evidence_digest']=envelope['predecessor_evidence']['evidence_digest']
message=json.dumps({'output_json':json.dumps(output,separators=(',',':'))},separators=(',',':'))
path=pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]);path.write_text(message)
(path.parent/'observed-input.json').write_text(json.dumps(envelope))
for event in [{'type':'thread.started','thread_id':'fixture-'+phase},{'type':'turn.started'},{'type':'item.completed','item':{'id':'final','type':'agent_message','text':message}},{'type':'turn.completed','usage':{}}]:print(json.dumps(event),flush=True)
`;
test('public production spike/v2 executes two bounded deterministic tasks and transfers accepted host evidence through unchanged direct receipts', {skip:process.platform!=='linux',timeout:15000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'research-direct-'));let runtime;
 t.after(()=>{if(runtime)closeFlowRuntime(runtime);rmSync(root,{recursive:true,force:true});});
 const repository=join(root,'repository'),home=join(root,'home');mkdirSync(repository);mkdirSync(home);
 const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test','-C',repository,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'});
 git(['init','-q','--initial-branch=main']);writeFileSync(join(repository,'file'),'unchanged\n');git(['add','.']);git(['commit','-qm','fixture']);
 const before=git(['rev-parse','HEAD']),source=join(root,'source');writeFileSync(source,'Notifications are advisory hints. Re-query authoritative state.\n');
 const {packet}=readResearchSourcePacket({question:'How should an observer use a notification?',sources:[source]});
 const executable=join(root,'codex-wire-fixture');writeFileSync(executable,executableFixture,{mode:0o700});
 const authority=join(root,'authority');runtime=createFlowRuntime({env:{HOME:home,PATH:'/usr/bin:/bin',FLOW_CODEX_EXECUTABLE:executable,FLOW_EXECUTION_TRUST:'supervised-native-cli',FLOW_REPOSITORY_ROOT:repository},authorityDirectory:authority,autonomous:false});
 const prepared=await runtime.prepare({schema:'flow.research-preparation-request/v1',repository,packet,execution_trust:trust});assert.equal(prepared.schema,'flow.prepared-run/v1',JSON.stringify(prepared));
 const launched=await runtime.launch({prepared,execution_trust:trust,confirmation:{schema:'flow.predefined-flow-confirmation-decision/v1',decision:'accept',bundle_digest:prepared.bundle_digest,confirmation_digest:prepared.confirmation_digest},closed_facts:{schema:'flow.closed-fact-observation/v1',bundle_digest:prepared.bundle_digest,facts:prepared.explicit_facts}});assert.ok(launched.run_id,JSON.stringify(launched));
 let run;
 for(let count=0;count<200;count++){
  run=await runtime.query({run_id:launched.run_id});if(run.phase==='succeeded'||run.phase==='failed')break;
  const action=run.legal_actions.find(action=>['delegate_execute','recovery'].includes(action.type));if(action)await runtime.command(action);
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(run.phase,'succeeded',JSON.stringify(run));assert.equal(run.delegate_attempts.length,2);
 assert.equal(Object.hasOwn(run,'effect_intents'),false);
 const report=readResearchReport(run,packet);assert.equal(report.assurance,'lower');assert.equal(report.residual_gaps.length,1);
 for (const change of [
  clone=>clone.delegate_attempts.push(structuredClone(clone.delegate_attempts.find(attempt=>attempt.card_id==='spike-research'))),
  clone=>clone.delegate_attempts.push({...clone.delegate_attempts.find(attempt=>attempt.card_id==='spike-research'),status:'quarantined'}),
  clone=>clone.delegate_attempts.push({...clone.delegate_attempts.find(attempt=>attempt.card_id==='spike-research'),status:'reserved'}),
  clone=>delete clone.effects.find(effect=>effect.card_id==='spike-research').source_authority_watermark,
  clone=>clone.effects.push(structuredClone(clone.effects.find(effect=>effect.card_id==='spike-synthesis'))),
  clone=>clone.active_plan.cards.find(card=>card.id==='spike-research').inputs.task_inputs.packet.sources[0].content+='changed'
 ]) { const clone=structuredClone(run);change(clone);assert.throws(()=>readResearchReport(clone,packet),/research|Research/); }

 const tasks=readdirSync(join(authority,'direct-tasks'));assert.equal(tasks.length,2);
 const observed=tasks.map(task=>{const directory=join(authority,'direct-tasks',task);const receipt=JSON.parse(readFileSync(join(directory,'receipt.json')));assert.equal(receipt.tree_retired,true);return JSON.parse(readFileSync(join(directory,'observed-input.json')));});
 const research=observed.find(item=>item.task_inputs.phase==='research'),synthesis=observed.find(item=>item.task_inputs.phase==='synthesis');
 assert.equal(research.task_inputs.packet.sources[0].content,packet.sources[0].content);assert.equal(synthesis.task_inputs.packet.sources[0].content,undefined);assert.equal(synthesis.predecessor_evidence.evidence_digest,report.research_evidence_digest);
 assert.equal(git(['rev-parse','HEAD']),before);assert.equal(git(['status','--porcelain']),'');
});
