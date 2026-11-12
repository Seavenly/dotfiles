import { validateResearchSourcePacket } from "../../../tools/flow/src/research-source-packet.mjs";
import { acceptedDelegateEvidenceEntry } from "../../../tools/flow/src/delegate-evidence.mjs";
import { digest } from '../../../tools/flow/src/canonical.mjs';
import { validateResearchOutput, REPORT_SCHEMA } from '../../../tools/flow/src/research-flow.mjs';
import * as deepResearch from '../../../tools/flow/src/deep-research-contract.mjs';
import { readDeepResearchReport } from '../../../tools/flow/src/deep-research-report.mjs';
import { quoteShell } from '../scripts/feature-client-files.mjs';
import { failRun } from './project-run-state.mjs';
import { projectRunFacts, runDecisionActions, terminalText } from './project-run-view.mjs';
export const researchAttachCommand=(selection,id)=>`flow-supervised research --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --attach ${quoteShell(id)}`;
export const researchConfirmCommand=(selection,confirmation)=>`flow-supervised research --repository ${quoteShell(selection.repository)} --client ${quoteShell(selection.directory)} --confirm ${quoteShell(confirmation)}`;
export function renderResearchPreview(preview) {
 const roles=(preview.inspection.routes??[]).flatMap(route=>[`  ${route.card_id}: ${route.launch?.harness} / ${route.launch?.model} / ${route.launch?.effort}`,`    Requested permission: ${route.launch?.capability}; executable: ${route.executable?.path??'inspect full confirmation'}`,`    Executable identity: ${route.executable?.version??'not supplied'} ${route.executable?.sha256??''}`]);
 if(preview.deep)return renderDeepPreview(preview,roles);
 return ['Prepared supervised quick research',`Project: ${preview.repository}`,`Question: ${preview.packet.question.text}`,`Source packet: ${preview.packet.packet_digest}`,'Supplied sources (snapshotted bytes, never fetched):',...preview.source_provenance.flatMap((source,index)=>[`  ${preview.packet.sources[index].id}: ${source.path}`,`    ${source.size_bytes} bytes; ${source.digest}`]),'Distinct researcher and synthesizer:',...roles,
 `Overall prepared-run budget: ${preview.inspection.limits?.max_elapsed_seconds??preview.policy.max_elapsed_seconds} seconds; one attempt per role; zero revisions. No independent per-role timer guarantee.`,
 'Trust: operator-supervised official CLI requested read-only permissions and ambient startup. Independent filesystem/network enforcement is not claimed.',
 'Source text is untrusted supplied evidence, not fetched or independently authenticated. Report assurance is lower; residual gaps remain.',`Authority: ${preview.authority_directory}`,`Full exact confirmation and source packet: ${preview.prepared_file}`,`Confirmation digest: ${preview.confirmation_digest}`,preview.recovery_disclosure,
 'No prototype, project test, candidate, review, approval or publication is authorized.',''].map(terminalText).join('\n');
}

function renderDeepPreview(preview,roles) {
 const bounds=preview.inspection.deep;
 return ['Prepared supervised deep research',`Project: ${preview.repository}`,`Confirmed original question: ${preview.packet.question.text}`,`Immutable source packet: ${preview.packet.packet_digest}`,
  'Supplied sources (snapshotted bytes, never fetched):',...preview.source_provenance.flatMap((source,index)=>[`  ${preview.packet.sources[index].id}: ${source.path}`,`    ${source.size_bytes} bytes; ${source.digest}`]),
  'Two fixed investigation angles:',...preview.deep.angles.map(angle=>`  ${angle.angle_id}: ${angle.text}`),
  `Confirmed angle concurrency: ${preview.deep.parallel}; observed original owner runner delegate capacity: ${preview.owner_delegate_capacity}`,
  `Total cycles: ${preview.deep.max_cycles} (initial investigation plus at most ${preview.deep.max_cycles-1} revision cycle); maximum native attempts: ${bounds.max_native_attempts}; one attempt per card, no automatic retries.`,
  `Actual initial graph: ${bounds.initial_graph_cards} cards, including the angle delegates, critic, registered cycle decision and checkpoint. Maximum retained graph: ${bounds.max_graph_cards} cards.`,
  `Whole revision-cycle cost: one affected angle plus fresh critic/decision/checkpoint = ${bounds.whole_cycle_cards.one_angle} cards; both angles = ${bounds.whole_cycle_cards.both_angles} cards. No partial cycle is admitted.`,
  ...(preview.inspection.requested_authority?.mutations?.includes('flow.research-cycle/v1')?['Internal read-only cycle decisions are included; they grant no external mutation, Git change or publication.']:[]),
  'All confirmed native routes (future routes execute only if a whole remaining cycle is admitted):',...roles,
  `Shared original run budget: ${preview.inspection.limits?.max_elapsed_seconds??preview.policy.max_elapsed_seconds} seconds, across investigation, decisions and all cycles. Attach and scope approval do not reset it. No independent per-role timer guarantee.`,
  'A fresh critic receives the complete retained angle evidence and settled terminal dispositions. Operational failure stays blocked; a semantic cycle cap can finish with findings and residual gaps.',
  'Only scope-preserving revisions covered by this confirmation may advance automatically. Widening the question requires an exact same-run checkpoint; sources and the two angles stay fixed.',
  'Trust: operator-supervised official CLI requested read-only permissions and ambient startup. Independent filesystem/network enforcement is not claimed.',
  'Supplied bytes are not fetched or independently authenticated. Assurance remains lower; research grants no external mutation, prototype, candidate, approval or publication authority.',
  `Authority: ${preview.authority_directory}`,`Full exact confirmation: ${preview.prepared_file}`,`Confirmation digest: ${preview.confirmation_digest}`,preview.recovery_disclosure,''].map(terminalText).join('\n');
}

/** Present the exact current scope proposal before the generic fresh-action confirmation. */
export function renderResearchScopeCheckpoint(run,action,selection) {
 const proposal=run.deep_research?.scope_proposal;
 if(!selection.deep||!proposal||action.type!=='checkpoint_decision'||action.command.checkpoint_id!==proposal.checkpoint_id)return null;
 const replacement=deepResearch.researchQuestion(proposal.new_question?.text);
 if(proposal.unchanged_packet_digest!==selection.packet.packet_digest||digest(proposal.angle_ids??null)!==digest(selection.deep.angles.map(angle=>angle.angle_id))||
    proposal.old_question?.id!==run.deep_research.scope?.question_id||proposal.old_question?.text!==run.deep_research.scope?.text||
    !replacement||digest(replacement)!==digest(proposal.new_question))
  failRun('The scope checkpoint does not bind the fixed sources, angles and exact safe replacement question. No decision was submitted.','deep_research_scope_changed',1);
 return ['Same-run research scope checkpoint',`Run: ${run.run_id}`,`Current authority watermark: ${JSON.stringify(run.watermark)}`,`Checkpoint: ${proposal.checkpoint_id}`,
  `Original question: ${selection.packet.question.text}`,`Current question: ${proposal.old_question.text}`,`Proposed replacement question: ${proposal.new_question.text}`,
  `Unchanged supplied source packet: ${proposal.unchanged_packet_digest}`,'Unchanged investigation angles:',...selection.deep.angles.map(angle=>`  ${angle.angle_id}: ${angle.text}`),
  `Remaining original elapsed budget: ${proposal.remaining_elapsed_seconds} seconds; remaining total cycles: ${proposal.remaining_cycles}. Neither budget resets.`,
  `Whole next cycle: both angles plus a fresh critic (${proposal.next_cycle_attempts} native attempts), with its registered decision and checkpoint. Approval reserves all of it before dispatch.`,
  'Approve only this exact safe replacement question. Decline retains the original scope and its honest findings; no scope is silently widened.',
  `Selected action: ${action.label} [${action.digest}]`,''].map(terminalText).join('\n');
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
 if(selection.deep)return summarizeDeepResearch(run,{selection,status,projectionFile});
 const facts=projectRunFacts(run),report=readResearchReport(run,selection.packet);
 return {schema:'flow.project-research-result/v1',status:status==='completed'?report?'succeeded':'blocked':status,run_id:run.run_id,phase:run.phase,question:selection.packet.question,packet_digest:selection.packet.packet_digest,report,
  research_evidence_digest:report?.research_evidence_digest??null,client:selection.client,runtime_root:selection.runtime_root,retained_directory:selection.retained_directory,projection_file:projectionFile,
  unresolved_effects:facts.unresolved_effects,quarantined_effects:facts.quarantined_effects,workspace_settlement:facts.workspace_settlement,legal_actions:runDecisionActions(run),reattach_command:researchAttachCommand(selection,run.run_id)};
}
function summarizeDeepResearch(run,{selection,status,projectionFile}) {
 const facts=projectRunFacts(run),report=readDeepResearchReport(run,selection.packet,selection.deep),progress=run.deep_research??null;
 return {schema:'flow.project-deep-research-result/v1',status:status==='completed'?report&&!progress?.operationally_blocked?'succeeded':'blocked':status,run_id:run.run_id,phase:run.phase,
  original_question:selection.packet.question,question:progress?.scope?{id:progress.scope.question_id,text:progress.scope.text}:selection.packet.question,packet_digest:selection.packet.packet_digest,deep:selection.deep,deep_research:progress,report,
  client:selection.client,runtime_root:selection.runtime_root,retained_directory:selection.retained_directory,projection_file:projectionFile,
  unresolved_effects:facts.unresolved_effects,quarantined_effects:facts.quarantined_effects,workspace_settlement:facts.workspace_settlement,legal_actions:runDecisionActions(run),reattach_command:researchAttachCommand(selection,run.run_id)};
}
export function renderResearchResult(result) {
 if(result.schema==='flow.project-deep-research-result/v1')return renderDeepResult(result);
 const report=result.report;
 return ['Quick research result',`Result: ${result.status}; phase: ${result.phase}`,`Run: ${result.run_id}`,`Question: ${result.question.text}`,`Source packet: ${result.packet_digest}`,
 ...(report?[`Assurance: ${report.assurance}`,`Answer: ${report.answer}`,'Exact source citations:',...report.citations.map(cite=>`  ${cite.source_id} ${cite.digest}`),`Host researcher proof: ${report.research_evidence_digest}`,...report.findings.map(item=>`Finding: ${item}`),...report.residual_gaps.map(item=>`Residual gap: ${item}`)]:['No validated complete report is available; retain exact evidence.']),
 ...result.unresolved_effects.map(id=>`Unresolved effect: ${id}`),...result.quarantined_effects.map(id=>`Quarantined effect: ${id}`),...result.workspace_settlement.map(item=>`Workspace ${item.claim?.id??'unknown'}: ${JSON.stringify(item.disposition)}`),
 ...(result.status==='detached'?['Durable work continues; detachment did not cancel it.']:[]),`Retained evidence: ${result.retained_directory}`,`Reattach: ${result.reattach_command}`,'Research grants no candidate, human approval, mutation or publication authority.',''].map(terminalText).join('\n');
}
function renderDeepResult(result) {
 const report=result.report,progress=result.deep_research;
 const disposition=value=>value!==null&&typeof value==='object'?JSON.stringify(value):String(value);
 return ['Deep research result',`Result: ${result.status}; run phase: ${result.phase}`,`Run: ${result.run_id}`,`Original confirmed question: ${result.original_question.text}`,`Effective question: ${result.question.text}`,`Immutable source packet: ${result.packet_digest}`,
  `Cycle: ${progress?.cycle??'not observed'}; confirmed total-cycle limit: ${result.deep.max_cycles}; confirmed concurrency: ${result.deep.parallel}`,
  ...(progress?.angles??[]).map(angle=>`Angle ${angle.angle_id}: ${angle.text}; cycle ${angle.cycle}; status ${angle.status}`),
  ...(progress?.history??[]).map(entry=>`Retained disposition ${entry.angle_id??entry.card_id??'inspect exact projection'}: ${disposition(entry.disposition??entry.status??entry.schema)}; cycle ${entry.cycle??'see evidence'}`),
  ...(progress?.operationally_blocked?['Operational or authority failure blocks successful research; a diagnostic critic does not turn it into a complete report.']:[]),
  ...(report?[`Assurance: ${report.assurance}`,`Answer: ${report.answer}`,`Cycles used: ${report.cycles_used} of ${report.max_cycles}; semantic cycle cap exhausted: ${report.cap_exhausted}`,'Exact source citations:',...report.citations.map(cite=>`  ${cite.source_id} ${cite.digest}`),`Complete retained-evidence identity: ${report.retained_evidence_digest}`,...report.findings.map(item=>`Finding: ${item}`),...report.residual_gaps.map(item=>`Residual gap: ${item}`)]:['No validated complete deep report is available; retain exact angle dispositions and authority evidence.']),
  ...(progress?.scope_proposal?[`Scope decision awaits explicit approval or decline: ${progress.scope_proposal.old_question.text} -> ${progress.scope_proposal.new_question.text}`,`Remaining original budget: ${progress.scope_proposal.remaining_elapsed_seconds} seconds and ${progress.scope_proposal.remaining_cycles} cycles; next whole cycle costs ${progress.scope_proposal.next_cycle_attempts} native attempts.`]:[]),
  ...result.unresolved_effects.map(id=>`Unresolved effect: ${id}`),...result.quarantined_effects.map(id=>`Quarantined effect: ${id}`),...result.workspace_settlement.map(item=>`Workspace ${item.claim?.id??'unknown'}: ${JSON.stringify(item.disposition)}`),
  ...(result.status==='detached'?['Durable work continues; detachment did not cancel it.']:[]),`Retained evidence: ${result.retained_directory}`,`Reattach: ${result.reattach_command}`,
  'Research covers supplied bytes with lower assurance. It grants no candidate, human approval, external mutation, fetch or publication authority.',''].map(terminalText).join('\n');
}
