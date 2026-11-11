import { digest } from '../../../tools/flow/src/canonical.mjs';
import { validateResearchOutput, REPORT_SCHEMA } from '../../../tools/flow/src/research-flow.mjs';
import { quoteShell } from '../scripts/feature-client-files.mjs';
import { failRun } from './project-run-state.mjs';
import { projectRunFacts, runDecisionActions, terminalText } from './project-run-view.mjs';
export const researchAttachCommand=(selection,id)=>`flow-supervised research --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --attach ${quoteShell(id)}`;
export const researchConfirmCommand=(selection,confirmation)=>`flow-supervised research --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --confirm ${quoteShell(confirmation)}`;
export function renderResearchPreview(preview) {
 const roles=(preview.inspection.routes??[]).flatMap(route=>[`  ${route.card_id}: ${route.launch?.harness} / ${route.launch?.model} / ${route.launch?.effort}`,`    Requested permission: ${route.launch?.capability}; executable: ${route.executable?.path??'inspect full confirmation'}`,`    Executable identity: ${route.executable?.version??'not supplied'} ${route.executable?.sha256??''}`]);
 return ['Prepared supervised quick research',`Project: ${preview.repository}`,`Question: ${preview.packet.question.text}`,`Source packet: ${preview.packet.packet_digest}`,'Supplied sources (snapshotted bytes, never fetched):',...preview.source_provenance.flatMap((source,index)=>[`  ${preview.packet.sources[index].id}: ${source.path}`,`    ${source.size_bytes} bytes; ${source.digest}`]),'Distinct researcher and synthesizer:',...roles,
 `Overall prepared-run budget: ${preview.inspection.limits?.max_elapsed_seconds??preview.policy.max_elapsed_seconds} seconds; one attempt per role; zero revisions. No independent per-role timer guarantee.`,
 'Trust: operator-supervised official CLI requested read-only permissions and ambient startup. Independent filesystem/network enforcement is not claimed.',
 'Source text is untrusted supplied evidence, not fetched or independently authenticated. Report assurance is lower; residual gaps remain.',`Authority: ${preview.authority_directory}`,`Full exact confirmation and source packet: ${preview.prepared_file}`,`Confirmation digest: ${preview.confirmation_digest}`,preview.recovery_disclosure,
 'No prototype, project test, candidate, review, approval or publication is authorized.',''].map(terminalText).join('\n');
}
export function readResearchReport(run,packet) {
 const matches=(run.delegate_attempts??[]).filter(attempt=>attempt.card_id==='spike-synthesis'&&attempt.status==='accepted');
 if(!matches.length)return null;
 if(matches.length!==1)failRun('Research synthesis attempt is ambiguous; inspect exact evidence.','research_report_changed',1);
 const attempt=matches[0],effect=run.effects?.find(item=>item.effect_id===attempt.effect_id),intent=run.effect_intents?.find(item=>item.effect_id===attempt.effect_id);
 if(!effect||effect.run_id!==run.run_id||effect.card_id!=='spike-synthesis'||effect.attempt_id!==attempt.attempt_id||effect.status!=='succeeded'||effect.effect_kind!=='delegate'||!intent||intent.run_id!==run.run_id||intent.card_id!==effect.card_id||intent.attempt_id!==effect.attempt_id||intent.idempotency_key!==effect.idempotency_key||digest(effect.receipt?.provider_receipt)!==digest(attempt.evidence)||attempt.evidence?.attempt_id!==attempt.attempt_id||attempt.evidence.card_id!==effect.card_id)failRun('Public research evidence no longer binds its exact run/card/attempt.','research_report_changed',1);
 const output=attempt.evidence.validated_output;
 if(!validateResearchOutput(output,{delegate_input:{task_inputs:{packet}},authority_materialized_evidence:intent.delegate_input?.authority_materialized_evidence},REPORT_SCHEMA))failRun('Research report does not bind the exact supplied sources and authority-created researcher proof.','research_report_changed',1);
 return JSON.parse(output);
}
export function summarizeProjectResearch(run,{selection,status,projectionFile}) {
 const facts=projectRunFacts(run),report=readResearchReport(run,selection.packet);
 return {schema:'flow.project-research-result/v1',status:status==='completed'?report?'succeeded':'blocked':status,run_id:run.run_id,phase:run.phase,question:selection.packet.question,packet_digest:selection.packet.packet_digest,report,
  research_evidence_digest:report?.research_evidence_digest??null,client:selection.client,runtime_root:selection.runtime_root,retained_directory:selection.retained_directory,projection_file:projectionFile,
  unresolved_effects:facts.unresolved_effects,quarantined_effects:facts.quarantined_effects,workspace_settlement:facts.workspace_settlement,legal_actions:runDecisionActions(run),reattach_command:researchAttachCommand(selection,run.run_id)};
}
export function renderResearchResult(result) {
 const report=result.report;
 return ['Quick research result',`Result: ${result.status}; phase: ${result.phase}`,`Run: ${result.run_id}`,`Question: ${result.question.text}`,`Source packet: ${result.packet_digest}`,
 ...(report?[`Assurance: ${report.assurance}`,`Answer: ${report.answer}`,'Exact source citations:',...report.citations.map(cite=>`  ${cite.source_id} ${cite.digest}`),`Host researcher proof: ${report.research_evidence_digest}`,...report.findings.map(item=>`Finding: ${item}`),...report.residual_gaps.map(item=>`Residual gap: ${item}`)]:['No validated complete report is available; retain exact evidence.']),
 ...result.unresolved_effects.map(id=>`Unresolved effect: ${id}`),...result.quarantined_effects.map(id=>`Quarantined effect: ${id}`),...result.workspace_settlement.map(item=>`Workspace ${item.claim?.id??'unknown'}: ${JSON.stringify(item.disposition)}`),
 ...(result.status==='detached'?['Durable work continues; detachment did not cancel it.']:[]),`Retained evidence: ${result.retained_directory}`,`Reattach: ${result.reattach_command}`,'Research grants no candidate, human approval, mutation or publication authority.',''].map(terminalText).join('\n');
}
