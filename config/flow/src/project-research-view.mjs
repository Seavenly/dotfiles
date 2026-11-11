import { validateResearchSourcePacket } from "../../../tools/flow/src/research-source-packet.mjs";
import { acceptedDelegateEvidenceEntry } from "../../../tools/flow/src/delegate-evidence.mjs";
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
function acceptedResearchAttempt(run, cardId) {
 const attempts=(run.delegate_attempts??[]).filter(attempt=>attempt.card_id===cardId);
 if(!attempts.length)return null;
 if(attempts.length!==1)failRun('Research delegate attempt is ambiguous; inspect exact evidence.','research_report_changed',1);
 const attempt=attempts[0];
 if(attempt.status!=='accepted')return null;
 const effects=(run.effects??[]).filter(item=>item.effect_id===attempt.effect_id);
 if(effects.length!==1)failRun('Research delegate effect is missing or ambiguous.','research_report_changed',1);
 const effect=effects[0],card=run.active_plan?.cards?.find(item=>item.id===cardId);
 if(!card||card.inputs?.task_inputs?.flow!=='spike/v2'||digest(card.route)!==digest(effect.route_binding)||digest(attempt.route_binding)!==digest(effect.route_binding)||digest(attempt.evidence?.route_binding)!==digest(effect.route_binding)||effect.run_id!==run.run_id||effect.card_id!==cardId||effect.attempt_id!==attempt.attempt_id||effect.status!=='succeeded'||effect.effect_kind!=='delegate'||
    !effect.idempotency_key||!/^sha256:[a-f0-9]{64}$/.test(effect.source_authority_watermark??'')||
    effect.receipt?.effect_id!==effect.effect_id||effect.receipt?.idempotency_key!==effect.idempotency_key||effect.receipt?.outcome!=='succeeded'||
    digest(effect.receipt.provider_receipt)!==digest(attempt.evidence)||attempt.evidence?.attempt_id!==attempt.attempt_id||attempt.evidence.card_id!==cardId)failRun('Public research evidence no longer binds its exact run/card/attempt.','research_report_changed',1);
 return {attempt,effect};
}
/** Reconstruct only the shared host projection from exact public admitted receipts.
 * effect_intents is internal and is deliberately not a public dependency. */
export function readResearchReport(run,packet) {
 const synthesis=acceptedResearchAttempt(run,'spike-synthesis');if(!synthesis)return null;
 const sourcePacket=run.active_plan?.cards?.find(card=>card.id==='spike-research')?.inputs?.task_inputs?.packet;
 if(!validateResearchSourcePacket(packet)||digest(sourcePacket)!==digest(packet))failRun('Research run does not bind the retained exact source packet.','research_report_changed',1);
 const research=acceptedResearchAttempt(run,'spike-research');
 if(!research)failRun('Accepted researcher evidence is missing.','research_report_changed',1);
 const identity={schema:'flow.authority-materialized-evidence/v1',accepted_delegates:[acceptedDelegateEvidenceEntry('spike-research',research.attempt,research.effect)]};
 const envelope={...identity,evidence_digest:digest(identity)};
 const output=synthesis.attempt.evidence.validated_output;
 if(!validateResearchOutput(output,{delegate_input:{task_inputs:{packet}},authority_materialized_evidence:envelope},REPORT_SCHEMA))failRun('Research report does not bind the exact supplied sources and authority-created researcher proof.','research_report_changed',1);
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
