import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlowRuntime, closeFlowRuntime } from "../src/runtime.mjs";
import { readResearchSourcePacket } from "../src/research-source-files.mjs";
import { createDeepResearchSelection } from "../../../tools/flow/src/deep-research-contract.mjs";
import { readDeepResearchReport, readDeepCycleReceipt } from "../../../tools/flow/src/deep-research-report.mjs";
import { isAutomaticDeepContinuation } from "../../../tools/flow/src/deep-research-continuation.mjs";

const trust = { schema: "flow.supervised-native-cli/v1", acknowledgment: "trust-official-cli-permissions" };
// An owned deterministic public-wire executable, never official/native qualification.
const wire = `#!/usr/bin/python3 -I
import json,sys,pathlib,time
if sys.argv[1:]==['--version']:print('codex-cli 0.166.0');sys.exit(0)
root=pathlib.Path(__file__).parent; scenario=json.loads((root/'scenario.json').read_text())
envelope=json.load(sys.stdin);task=envelope['task_inputs'];role=task['role'];cycle=task['cycle']
card=('deep-angle-'+task['angle']['angle_id'].split(':')[1] if role=='angle' else 'deep-critic')+'-cycle-'+str(cycle)
(root/('started-'+card)).write_text('started')
if scenario.get('hold_initial') and role=='angle' and cycle==1:
 end=time.monotonic()+8
 while not (root/('release-'+card)).exists():
  if time.monotonic()>end:sys.exit(19)
  time.sleep(.01)
if scenario.get('fail_angle') is not None and scenario.get('fail_angle')==task.get('angle',{}).get('angle_id') and cycle==1:sys.exit(17)
out={'schema':'flow.deep-research-'+('angle' if role=='angle' else 'critic')+'-output/v1','question_id':task['question']['id'],'cycle':cycle,'answer':'Supplied notifications are hints; verify exact authoritative state.','assurance':'lower','citations':[{'source_id':s['id'],'digest':s['digest']} for s in task['packet']['sources']],'findings':['Delivery scope is narrower than an integrity guarantee.'],'residual_gaps':['Real host notification behavior has not been measured.']}
if role=='angle':out['angle_id']=task['angle']['angle_id']
else:
 out['retained_evidence_digest']=envelope['predecessor_evidence']['evidence_digest'];out['revise_angles']=scenario.get('revise_angles',[]) if cycle==1 else []
 out['proposed_question']=scenario.get('proposed_question') if cycle==1 else None
if scenario.get('max_output'):
 out['answer']='A';out['findings']=['F'*200]*8;out['residual_gaps']=['G'*200]*8
 size=lambda:len(json.dumps(out,separators=(',',':'),ensure_ascii=False).encode())
 while size()>8192:
  out['findings']=[x[:-8] for x in out['findings']];out['residual_gaps']=[x[:-8] for x in out['residual_gaps']]
 out['answer']='A'*min(4096,8192-size()+1)
message=json.dumps({'output_json':json.dumps(out,separators=(',',':'),ensure_ascii=False)},separators=(',',':'),ensure_ascii=False)
target=pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]);target.write_text(message)
(target.parent/'observed-input.json').write_text(json.dumps(envelope))
for e in [{'type':'thread.started','thread_id':'fixture-'+card},{'type':'turn.started'},{'type':'item.completed','item':{'id':'final','type':'agent_message','text':message}},{'type':'turn.completed','usage':{}}]:print(json.dumps(e),flush=True)
`;

function fixture(t, scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "deep-direct-"));
  let runtime;
  t.after(() => { if (runtime) closeFlowRuntime(runtime); rmSync(root, { recursive: true, force: true }); });
  const repository = join(root, "repository"), home = join(root, "home"); mkdirSync(repository); mkdirSync(home);
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-C", repository, ...args],
    { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
  git(["init", "-q", "--initial-branch=main"]); writeFileSync(join(repository, "file"), "unchanged\n"); git(["add", "."]); git(["commit", "-qm", "fixture"]);
  const before = git(["rev-parse", "HEAD"]), files = [];
  for (let index = 0; index < (scenario.maximum ? 4 : 1); index++) {
    const path = join(root, `source-${index}`); writeFileSync(path, scenario.maximum ? (`Source ${index}. Stable observation with unresolved comparison.\n`).repeat(800).slice(0, 32768) : "Notifications are advisory hints. Re-query authoritative state.\n"); files.push(path);
  }
  const { packet } = readResearchSourcePacket({ question: scenario.maximum ? "Q".repeat(4096) : "Which notification guarantees require independent verification?", sources: files });
  const deep = createDeepResearchSelection({ angles: scenario.maximum ? ["A".repeat(1024), "B".repeat(1024)] : ["Delivery guarantees", "Integrity limitations"], max_cycles: scenario.max_cycles ?? 2 });
  const executable = join(root, "codex-wire-fixture"); writeFileSync(executable, wire, { mode: 0o700 }); writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
  const authority = join(root, "authority"); runtime = createFlowRuntime({ env: { HOME: home, PATH: "/usr/bin:/bin", FLOW_CODEX_EXECUTABLE: executable,
    FLOW_EXECUTION_TRUST: "supervised-native-cli", FLOW_REPOSITORY_ROOT: repository }, authorityDirectory: authority, autonomous: false });
  return { root, repository, authority, runtime, packet, deep, git, before, maximum: scenario.maximum === true };
}

async function launch(f) {
  const prepared = await f.runtime.prepare({ schema: "flow.deep-research-preparation-request/v1", repository: f.repository, packet: f.packet, deep: f.deep,
    limits: { max_elapsed_seconds: f.maximum ? 300 : 60, max_revisions: f.deep.max_cycles - 1 }, execution_trust: trust });
  assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
  const launched = await f.runtime.launch({ prepared, execution_trust: trust, confirmation: { schema: "flow.predefined-flow-confirmation-decision/v1", decision: "accept",
    bundle_digest: prepared.bundle_digest, confirmation_digest: prepared.confirmation_digest }, closed_facts: { schema: "flow.closed-fact-observation/v1", bundle_digest: prepared.bundle_digest, facts: prepared.explicit_facts } });
  assert.ok(launched.run_id, JSON.stringify(launched)); return launched.run_id;
}

async function observe(f, id, { stopAtScope = false, until = run => run.phase === "succeeded" } = {}) {
  let run;
  const deadline = Date.now() + (f.maximum ? 180000 : 12000);
  for (let count = 0; count < (f.maximum ? 2000 : 400) && Date.now() < deadline; count++) {
    run = await f.runtime.query({ run_id: id });
    if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS && count % 20 === 0) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, "last-projection.json"), JSON.stringify(run, null, 2));
    if (until(run) || stopAtScope && run.deep_research?.scope_proposal) return run;
    const action = run.legal_actions.find(action => ["delegate_execute", "operation_execute", "recovery"].includes(action.type) || isAutomaticDeepContinuation(run, action));
    if (action) { const receipt = await f.runtime.command(action); assert.notEqual(receipt.schema, "flow.rejection/v1", JSON.stringify(receipt)); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return run;
}

test("public production deep research completes a coalesced whole revision cycle over retained evidence", { skip: process.platform !== "linux", timeout: 25000 }, async t => {
  const f = fixture(t, { revise_angles: ["angle:1", "angle:1", "angle:2"] }), id = await launch(f), run = await observe(f, id);
  if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, "production-cycle-projection.json"), JSON.stringify(run, null, 2));
  assert.equal(run.phase, "succeeded", JSON.stringify(run)); assert.equal(run.delegate_attempts.length, 6);
  assert.equal(run.revisions.length, 1); assert.equal(run.revisions[0].changes.add_cards.length, 5);
  const report = readDeepResearchReport(run, f.packet, f.deep); assert.equal(report.cycles_used, 2); assert.equal(report.assurance, "lower");
  assert.equal(run.deep_research.history.length, 6); assert.equal(Object.hasOwn(run, "effect_intents"), false);
  const tasks = readdirSync(join(f.authority, "direct-tasks")); assert.equal(tasks.length, 6);
  const observed = tasks.map(task => { const path = join(f.authority, "direct-tasks", task); assert.equal(JSON.parse(readFileSync(join(path, "receipt.json"))).tree_retired, true); return JSON.parse(readFileSync(join(path, "observed-input.json"))); });
  const critic = observed.find(input => input.task_inputs.role === "critic" && input.task_inputs.cycle === 2);
  assert.equal(critic.predecessor_evidence.entries.length, 5); assert.equal(new Set(critic.predecessor_evidence.entries.map(entry => entry.card_id)).size, 5);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.before); assert.equal(f.git(["status", "--porcelain"]), "");
});

for (const decision of ["approve", "decline"]) test(`public same-run scope checkpoint ${decision} binds a safe replacement question and the original deadline`, { skip: process.platform !== "linux", timeout: 25000 }, async t => {
  const replacement = "How should independent verification protect consumers across connections?";
  const f = fixture(t, { proposed_question: replacement }), id = await launch(f);
  const before = await observe(f, id, { stopAtScope: true });
  if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, `scope-${decision}-before.json`), JSON.stringify(before, null, 2));
  const proposal = before.deep_research.scope_proposal;
  assert.ok(proposal, JSON.stringify(before)); assert.equal(proposal.new_question.text, replacement);
  assert.equal(proposal.old_question.text, f.packet.question.text); assert.equal(proposal.unchanged_packet_digest, f.packet.packet_digest);
  assert.deepEqual(proposal.angle_ids, ["angle:1", "angle:2"]); assert.equal(proposal.next_cycle_attempts, 3);
  assert.ok(proposal.remaining_elapsed_seconds > 0 && proposal.remaining_elapsed_seconds < 60);
  assert.equal(proposal.original_elapsed_limit, 60); assert.equal(proposal.remaining_cycles, 1);
  const action = before.legal_actions.find(action => action.type === "checkpoint_decision" && action.decision === decision);
  assert.ok(action); assert.equal(isAutomaticDeepContinuation(before, action), false);
  const stale = await f.runtime.command({ ...action, expected_watermark: "sha256:" + "0".repeat(64) });
  assert.equal(stale.code, "stale_authority_watermark");
  const accepted = await f.runtime.command(action); assert.notEqual(accepted.schema, "flow.rejection/v1", JSON.stringify(accepted));
  const duplicate = await f.runtime.command(action); assert.equal(duplicate.schema, "flow.rejection/v1");
  const run = await observe(f, id);
  if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, `scope-${decision}-after.json`), JSON.stringify(run, null, 2));
  assert.equal(run.phase, "succeeded", JSON.stringify(run));
  const report = readDeepResearchReport(run, f.packet, f.deep); assert.ok(report);
  assert.equal(report.question.text, decision === "approve" ? replacement : f.packet.question.text);
  assert.equal(run.delegate_attempts.length, decision === "approve" ? 6 : 3);
  assert.equal(run.active_plan.deep_research.packet.question.text, f.packet.question.text);
  assert.equal(run.deep_research.scope.original_question_id, f.packet.question.id);
  assert.equal(run.execution_time.max_elapsed_seconds, 60);
  const second = run.active_plan.cards.filter(card => card.inputs?.task_inputs?.role === "angle" && card.inputs.task_inputs.cycle === 2);
  assert.equal(second.length, decision === "approve" ? 2 : 0);
  for (const card of second) { assert.equal(card.inputs.task_inputs.question.text, replacement); assert.equal(card.inputs.task_inputs.packet.question.text, f.packet.question.text); }
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("a positively retired failed angle reaches the diagnostic critic but can never complete or revise", { skip: process.platform !== "linux", timeout: 25000 }, async t => {
  const f = fixture(t, { fail_angle: "angle:2", revise_angles: ["angle:2"] }), id = await launch(f);
  const run = await observe(f, id, { until: run => run.effects.some(effect => effect.card_id === "deep-decision-cycle-1" && effect.receipt) });
  if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, "failed-angle-projection.json"), JSON.stringify(run, null, 2));
  assert.equal(run.delegate_attempts.length, 3, JSON.stringify(run));
  assert.equal(run.phase, "active"); assert.equal(run.deep_research.operationally_blocked, true);
  assert.equal(readDeepResearchReport(run, f.packet, f.deep), null); assert.equal(run.revisions.length, 0);
  assert.ok(!run.legal_actions.some(action => action.type === "revision_decision" || action.type === "checkpoint_decision"));
  assert.equal(run.deep_research.history.find(entry => entry.angle_id === "angle:2").disposition, "operational_failure");
  assert.equal(run.deep_research.history.length, 3);
});

test("maximum question, angles, sources and retained native outputs cross both full-cycle materialization seams", { skip: process.platform !== "linux", timeout: 240000 }, async t => {
  const f = fixture(t, { maximum: true, max_output: true, revise_angles: ["angle:1", "angle:2"] }), id = await launch(f);
  const ready = await observe(f, id, { until: run => run.cards.find(card => card.id === "deep-decision-cycle-2")?.status === "ready" });
  const action = ready.legal_actions.find(action => action.type === "operation_execute" && action.card_id === "deep-decision-cycle-2");
  assert.ok(action, JSON.stringify(ready.cards));
  const accepted = await f.runtime.command(action); assert.notEqual(accepted.schema, "flow.rejection/v1", JSON.stringify(accepted));
  const run = await observe(f, id, { until: run => run.effects.some(effect => effect.card_id === "deep-decision-cycle-2" && effect.receipt) });
  if (process.env.FLOW_DEEP_FIXTURE_RECEIPTS) writeFileSync(join(process.env.FLOW_DEEP_FIXTURE_RECEIPTS, "maximum-projection.json"), JSON.stringify(run, null, 2));
  assert.equal(run.cards.find(card => card.id === "deep-decision-cycle-2").status, "completed");
  assert.equal(run.delegate_attempts.length, 6); assert.ok(readDeepResearchReport(run, f.packet, f.deep));
  assert.equal(readDeepCycleReceipt(run, 2).operationally_blocked, false);
  assert.equal(Buffer.byteLength(f.packet.question.text), 4096); assert.equal(f.packet.sources.reduce((sum, source) => sum + source.size_bytes, 0), 131072);
  const outputs = run.delegate_attempts.map(attempt => attempt.validated_output); assert.ok(outputs.every(output => Buffer.byteLength(output) === 8192));
  const tasks = readdirSync(join(f.authority, "direct-tasks"));
  assert.ok(tasks.every(task => JSON.parse(readFileSync(join(f.authority, "direct-tasks", task, "receipt.json"))).tree_retired === true));
  const inputs = tasks.map(task => JSON.parse(readFileSync(join(f.authority, "direct-tasks", task, "observed-input.json"))));
  const critic = inputs.find(input => input.task_inputs.role === "critic" && input.task_inputs.cycle === 2);
  assert.equal(critic.predecessor_evidence.entries.length, 5);
  assert.equal(critic.predecessor_evidence.input_safety_policy_id, "flow.research-input-safety-policy/v1");
  const decision = run.active_plan.cards.find(card => card.id === "deep-decision-cycle-2");
  assert.equal(decision.inputs.deep_terminal_card_ids.length, 6);
});
