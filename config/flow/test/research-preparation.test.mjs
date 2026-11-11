import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { executionDescription } from '../../../tools/flow/src/execution-contract.mjs';
import { readResearchSourcePacket } from '../../../tools/flow/src/research-source-packet.mjs';
import { materializeDelegateInputEnvelope } from '../../../tools/flow/src/delegate-input-envelope.mjs';
import { directOutputContract } from '../../../tools/flow/src/direct-output-contract.mjs';
import { createFlowRuntime, closeFlowRuntime } from '../src/runtime.mjs';
import { getWorkspaceAuthority } from '../../../tools/flow/src/work-authority.mjs';
import { flowRuntimeAuthority } from '../src/production-runtime.mjs';
const acknowledgment={schema:'flow.supervised-native-cli/v1',acknowledgment:'trust-official-cli-permissions'};
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'research-prep-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repository=join(root,'repository');mkdirSync(repository);writeFileSync(join(repository,'notes'),'Research fixture.\n');
 const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test','-C',repository,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'});
 git(['init','-q','--initial-branch=main']);git(['add','.']);git(['commit','-qm','fixture']);
 const files=[];for(let i=0;i<4;i++){const file=join(root,`source-${i}`);writeFileSync(file,(`Source ${i}: a stable bounded observation with unresolved comparison.\n`).repeat(400));files.push(file);}
 const {packet}=readResearchSourcePacket({question:'Which observation follows from supplied notes?',sources:files});
 const executable={path:'/usr/bin/true',version:'fixture-not-native-proof',sha256:'sha256:'+createHash('sha256').update(readFileSync('/usr/bin/true')).digest('hex')};
 const port={backend:'direct',contract:'flow.delegated-agent-port/v1',async describe(request){const description=executionDescription({callerMetadata:request.caller_metadata??{},launch:{harness:'codex',model:'fixture-model',effort:'high',...request.launch,trust_posture:'supervised-native-cli'},backend:{contract:'flow.direct-task/v1',id:'direct',harness:'codex',adapter:'codex',adapter_version:'2',executable,native_session_strategy:'fresh_ephemeral',trust_contract:'flow.supervised-native-cli/v1'}});return {status:'compatible',description};}};
 const runtime=createFlowRuntime({env:{FLOW_EXECUTION_TRUST:'supervised-native-cli',FLOW_REPOSITORY_ROOT:repository},authorityDirectory:join(root,'authority'),delegatedAgentPort:port,autonomous:false});t.after(()=>closeFlowRuntime(runtime));
 return {root,repository,packet,runtime,port};
}
test('public native quick preparation transfers more than legacy string/aggregate limits with exact read-only workspace and no model SHA',async t=>{
 const f=fixture(t),request={schema:'flow.research-preparation-request/v1',repository:f.repository,packet:f.packet,limits:{max_elapsed_seconds:600,max_revisions:0},execution_trust:acknowledgment};
 const prepared=await f.runtime.prepare(request);assert.equal(prepared.schema,'flow.prepared-run/v1',JSON.stringify(prepared));
 assert.equal(prepared.definition.id,'spike/v2');assert.deepEqual(prepared.requested_authority.mutations,[]);assert.equal(prepared.graph.cards.length,2);
 const workspace=prepared.selection.inputs.workspace;
 assert.equal(getWorkspaceAuthority({runAuthority:flowRuntimeAuthority(f.runtime)}).query({contract:'work.workspace/v1',subject_id:workspace.subject_id}).generation,workspace.generation);
 const [research,synthesis]=prepared.graph.cards;
 assert.equal(research.inputs.resource_references[0].access,'read_only');assert.equal(research.inputs.task_inputs.packet.sources[3].content,f.packet.sources[3].content);
 assert.equal(synthesis.inputs.task_inputs.packet.sources[0].content,undefined);assert.deepEqual(synthesis.inputs.delegate_evidence_card_ids,['spike-research']);
 const envelope=materializeDelegateInputEnvelope({attemptId:'attempt:fixture',inputKey:'input:fixture',sequence:1,inputKind:'initial',instructions:research.inputs.prompt,taskInputs:research.inputs.task_inputs,resourceReferences:[],executionAuthority:{schema:'flow.delegate-execution-authority/v1',owner:'RunAuthority',capability:'read-only',effective_authority_digest:research.inputs.description.comparison_keys.effective_authority,capability_envelope_ids:[]},outputRequirements:research.inputs.output_requirements});
 assert.equal(envelope.task_inputs.packet.packet_digest,f.packet.packet_digest);
 const output=directOutputContract({delegate_input:research.inputs,delegate_output_schemas:research.outputs});assert.equal('evidence_digest' in output.schema.properties,false);
 assert.equal((await f.runtime.query({})).runs.length,0);
});
test('public preparation refuses changed bytes and a widened route without native dispatch',async t=>{
 const f=fixture(t),request={schema:'flow.research-preparation-request/v1',repository:f.repository,packet:f.packet,execution_trust:acknowledgment};
 const changed=structuredClone(request);changed.packet.sources[0].content+='changed';
 assert.equal((await f.runtime.prepare(changed)).code,'invalid_research_request');
 request.routes={researcher:{harness:'codex',capability:'workspace-write-denied'},synthesizer:{harness:'codex',capability:'read-only'}};
 const rejected=await f.runtime.prepare(request);assert.equal(rejected.schema,'flow.rejection/v1');assert.equal((await f.runtime.query({})).runs.length,0);
});
