import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createHash } from "node:crypto";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT as trust } from "../src/supervised-native-trust.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("public review explains explicitly selected lenses and bounded parallel execution without starting work", t => {
  const root = mkdtempSync(join(tmpdir(), "flow-parallel-review-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), LANG: "C.UTF-8" };
  const result = spawnSync(process.execPath, [cli, "review", "--help"], {
    env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /--lens/u);
  assert.match(result.stdout, /--parallel/u);
  assert.match(result.stdout, /security/u);
  assert.match(result.stdout, /correctness/u);
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
});

test("public review rejects invalid or mutable lens policy before selecting a client", t => {
  const root = mkdtempSync(join(tmpdir(), "flow-parallel-review-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), LANG: "C.UTF-8" };
  for (const args of [
    ["--lens", "security", "--lens", "security"],
    ["--lens", "arbitrary"],
    ["--parallel", "3"],
    ["--parallel", "1.5"],
    ["--parallel", "2"],
    ["--lens", "security", "--parallel", "2"],
    ["--attach", `run:${"a".repeat(64)}`, "--lens", "correctness"],
    ["--cancel", `run:${"a".repeat(64)}`, "--parallel", "2"],
  ]) {
    const result = spawnSync(process.execPath, [cli, "review", ...args], {
      env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /lens|parallel|saved policy/iu);
    assert.doesNotMatch(result.stderr, /Git project|initialize|repository path/iu);
  }
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
});

// The real public frontend uses a genuine generated-client format whose original
// runtime is an owned controlled transport. No native CLI, real owner, authority
// database or qualification is exercised by these reduced protocol fixtures.
function reviewFixture(t, { capable = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flow-parallel-review-fixture-"));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", TERM: "dumb" };
  const repository = join(root, "project"), runtime = join(root, "original-runtime");
  mkdirSync(repository);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Parallel review fixture"]); git(["config", "user.email", "review@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]); git(["config", "commit.gpgSign", "false"]);
  writeFileSync(join(repository, "measurements.txt"), "Measurements retain their order.\n");
  git(["add", "."]); git(["commit", "-qm", "Existing behavior"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "measurements.txt"), "Signed measurements stay ordered.\n");
  git(["add", "."]); git(["commit", "-qm", "Exact retained candidate"]);
  const head = git(["rev-parse", "HEAD"]).trim(), tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  mkdirSync(join(runtime, "tools/flow/src"), { recursive: true }); mkdirSync(join(runtime, "config/flow/src"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../../../tools/flow/src/canonical.mjs", import.meta.url)), join(runtime, "tools/flow/src/canonical.mjs"));
  if (capable) writeFileSync(join(runtime, "tools/flow/src/read-only-sibling-policy.mjs"), "// Controlled capability marker; never executed.\n");
  const profile = join(env.XDG_STATE_HOME, "flow-local", digest(repository).slice(7, 31));
  const directory = join(profile, "clients", "verify"), authority = join(profile, "authority");
  mkdirSync(join(directory, "requests", "existing"), { recursive: true }); mkdirSync(join(directory, "receipts")); mkdirSync(authority);
  const marker = join(root, "native-or-version-executed"), executable = join(root, "never-execute-codex");
  writeFileSync(executable, `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 99\n`, { mode: 0o700 });
  const gitIdentity = { author: { name: "Review fixture", email: "review@example.invalid" }, committer: { name: "Review fixture", email: "review@example.invalid" } };
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtime, node: realpathSync(process.execPath),
    executable: { path: executable, sha256: `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}` }, execution_trust: trust, git_identity: gitIdentity };
  const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  save(join(profile, "profile.json"), { identity, initial_check_digest: null });
  const generated = writeFeatureClient({ directory, runtimeRoot: runtime, workspace: repository, executionTrust: "supervised-native-cli", codexExecutable: executable,
    localStateHome: env.XDG_STATE_HOME, authorityDirectory: authority, gitIdentity });
  save(join(directory, "pilot.json"), { directory, runtime_root: runtime, ...generated, local_client: identity, execution_trust: trust });
  save(join(directory, "requests/existing/prepare-request.json"), { schema: "flow.feature-preparation-request/v1", repository, execution_trust: trust,
    brief: { schema: "flow.feature-brief/v1", id: "review-fixture", summary: "Explain signed measurements", acceptance: ["Measurements stay ordered"] }, mode: "verify" });
  const runtimeCli = join(runtime, "config/flow/src/cli.mjs");
  const run = args => spawnSync(process.execPath, [cli, "review", "--repository", repository, ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  const pinned = [join(profile, "profile.json"), join(directory, "pilot.json"), join(directory, "flow"), join(directory, "trusted-owner.mjs"), executable];
  const pins = pinned.map(path => readFileSync(path));
  t.after(() => {
    try {
    pinned.forEach((path, index) => assert.deepEqual(readFileSync(path), pins[index]));
    assert.equal(existsSync(marker), false); assert.equal(git(["status", "--porcelain"]), ""); assert.equal(git(["rev-parse", "HEAD"]).trim(), head);
    for (const name of ["owner.json", "authority.sqlite", "direct-tasks"]) assert.equal(existsSync(join(authority, name)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const f = { root, env, repository, runtime, runtimeCli, directory, authority, base, head, tree, git, run, save };
  const stateFile = installControlledTransport(f, { directory });
  return { ...f, stateFile, state: () => JSON.parse(readFileSync(stateFile)), change: values => save(stateFile, { ...JSON.parse(readFileSync(stateFile)), ...values }) };
}

function installControlledTransport(f, setup) {
  const stateFile = join(f.root, "transport-state.json");
  writeFileSync(stateFile, JSON.stringify({ started: false, launched: false, launches: 0, preparations: 0, review_requests: 0, calls: [], mode: "active", capacity: 2 }));
  writeFileSync(f.runtimeCli, `import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../../tools/flow/src/canonical.mjs';
const stateFile=${JSON.stringify(stateFile)},state=JSON.parse(readFileSync(stateFile)),args=process.argv.slice(2);
const directory=${JSON.stringify(setup.directory)},repository=${JSON.stringify(f.repository)};
const load=p=>JSON.parse(readFileSync(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const producer='run:'+'1'.repeat(64),candidateId='candidate:'+'3'.repeat(64),fingerprint='sha256:'+'d'.repeat(64),watermark='sha256:'+'e'.repeat(64);
const git={clean:true,commit_sha:${JSON.stringify(f.head)},tree_sha:${JSON.stringify(f.tree)},ref:'refs/heads/main'};
const candidate={schema:'work.review-candidate/v1',candidate_id:candidateId,candidate_fingerprint:fingerprint,git};
const candidateProjection={schema:'work.review-candidate-projection/v1',contract:'work.review/v1',subject_id:candidateId,status:'sealed',candidate,candidate_fingerprint:fingerprint,watermark,generation:1,workspace:{subject_id:'workspace:fixture',generation:1,mutation_epoch:1,fingerprint:'sha256:'+'a'.repeat(64)}};
if(args[0]==='local'&&args[1]==='review-request'){
 const chosen=[];for(let i=4;i<args.length;i++)if(args[i]==='--lens')chosen.push(args[++i]);
 if(!state.ignore_execution&&(chosen.length||args.includes('--parallel'))){state.lenses=chosen.length?chosen:['security'];state.execution={schema:'flow.read-only-sibling-policy/v1',max_in_flight:Number(args[args.indexOf('--parallel')+1]??1),card_ids:state.lenses.map(lens=>'review-lens-'+lens)};}
}
const lenses=state.lenses??['security'];
const description=role=>({schema:'flow.execution-description/v1',launch:{harness:'codex',role,capability:'read-only',model:'gpt-6.1-sol',effort:'high'},backend:{executable:{path:'/fixture/official-codex',version:'codex-cli 0.166.0',sha256:'sha256:'+'f'.repeat(64)}},effective_authority:{workspace:'read-only',approval:'never'}});
const graph={...(state.execution?{execution_policy:state.execution}:{}),cards:[...lenses.map(lens=>({id:'review-lens-'+lens,dependencies:[],executor:{kind:'delegate'},inputs:{description:description('lens:'+lens)}})),{id:'review-critic',dependencies:lenses.map(lens=>'review-lens-'+lens),executor:{kind:'delegate'},inputs:{description:description('critic')}},{id:'review-record',dependencies:['review-critic'],executor:{kind:'operation',contract:'flow.operation/review-record/v1'}}]};
const bundle=digest(graph),reviewRun='run:'+bundle.slice(7);
const finding={schema:'flow.review-finding/v1',finding_id:'finding:'+'9'.repeat(64),source:'lens',lens:'security',urgency:'medium',classification:'non_blocking',summary:'Explain rejected measurements',detail:'Invalid measurements need an actionable diagnostic.',location:{path:'measurements.txt',line:1}};
const summary={schema:'flow.review-summary/v1',candidate_fingerprint:fingerprint,enabled_lenses:lenses,findings:[finding],rendered_findings:[finding],coverage:{complete:true,lenses:lenses.map(lens=>({lens,status:'produced'})),critic:{status:'produced'}},posture:'findings',merge_ready:false};
const receipt={schema:'flow.review-receipt/v1',review_id:'review:'+'8'.repeat(64),candidate_fingerprint:fingerprint,lifecycle_generation:1,review_authority_watermark:watermark,summary};
const producerProjection={schema:'flow.run-projection/v1',run_id:producer,phase:'succeeded',progress:'completed',watermark:'sha256:'+'2'.repeat(64),review_candidate_reference:{candidate_id:candidateId,candidate_fingerprint:fingerprint},cards:[],effects:[{effect_id:'effect:commit',status:'completed',operation_contract:'flow.operation/feature-direct-commit/v1',receipt:{provider_receipt:{schema:'flow.git-candidate-commit-receipt/v1',old_commit_sha:${JSON.stringify(f.base)},...git}}},{effect_id:'effect:project-check',status:'succeeded',operation_contract:'flow.operation/project-check/v2',receipt:{provider_receipt:{schema:'work.project-check-receipt/v2',outcome:'passed',exit_code:0,candidate:git}}}],active_plan:{cards:[{id:'feature-project-check',executor:{kind:'operation',contract:'flow.operation/project-check/v2'}}]},views:{trust:{trust_posture:{execution_contract:'flow.supervised-native-cli/v1',verification_scope:'Registered project command GREEN-only'}}}};
state.calls.push(args);
let result;
switch(args[0]) {
case 'status':result={schema:'flow.owner-status/v1',state:state.started?'running':'stopped',runner:{delegates:{capacity:state.capacity}}};break;
case 'start':if(args.includes('--delegate-capacity')&&state.capacity<Number(args[args.indexOf('--delegate-capacity')+1])){result={schema:'flow.rejection/v1',code:'owner_delegate_capacity_insufficient',reason:'Original owner capacity is insufficient; stop this exact owned client when settled, then start --delegate-capacity 2 --json'};break;}state.started=true;result={schema:'flow.owner-status/v1',state:'running',runner:{delegates:{capacity:state.capacity}}};break;
case 'stop':state.started=false;result={schema:'flow.owner-status/v1',state:'stopped'};break;
case 'local':{
 if(args[1]==='review-request'){
  state.review_requests++;
  const folder=mkdtempSync(join(directory,'receipts','review-controlled-'));
  const facts={schema:'flow.review-preparation-facts/v1',candidate:{candidate_id:candidateId,candidate_fingerprint:fingerprint},source_run:{run_id:producer,watermark:producerProjection.watermark},route:{bindings:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>({card_id:c.id,description:c.inputs.description,route:{schema:'flow.delegate-route-binding/v1',agent_id:'agent:'+c.id}}))}};
  const request={schema:'flow.predefined-flow-selection/v1',definition:'review/v1',inputs:{schema:'flow.review-request/v1',target:{schema:'flow.review-local-candidate/v1',candidate,candidate_fingerprint:fingerprint,candidate_authority_watermark:watermark,lifecycle_generation:1},lenses,...(state.execution?{execution:state.execution}:{}),preparation_facts:facts,delegation:{schema:'flow.review-delegation-bindings/v1'}},execution_trust:load(join(directory,'pilot.json')).execution_trust};
  for(const [name,value] of Object.entries({'completed-run':producerProjection,candidate:candidateProjection,'preparation-facts':facts,'prepare-request':request}))save(join(folder,name+'.json'),value);
  result={status:'request_only',directory:folder,request:join(folder,'prepare-request.json')};
 }else if(args[1]==='inspect-prepared'){
  const p=load(args[2]);result={status:'inspection_only',prepared_file:args[2],bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest,definition:'review/v1',mode:'local_review',trust_posture:p.trust_posture,requested_authority:p.requested_authority,limits:p.explicit_facts.limits,...(state.execution?{execution_policy:state.execution}:{}),routes:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>({card_id:c.id,launch:c.inputs.description.launch,executable:c.inputs.description.backend.executable,requested_permissions:c.inputs.description.effective_authority}))};
 }else if(args[1]==='accept-prepared'){
  const p=load(args[3]),folder=mkdtempSync(join(directory,'receipts','accepted-')),request=join(folder,'launch-request.json');save(request,{prepared:p,confirmation:{schema:'flow.predefined-flow-confirmation-decision/v1',decision:'accept',bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest},closed_facts:{schema:'flow.closed-fact-observation/v1',bundle_digest:p.bundle_digest,facts:p.explicit_facts},execution_trust:load(join(directory,'pilot.json')).execution_trust});result={status:'launch_request_only',directory:folder,request};
 }else throw Error('Unknown local command');break;}
case 'prepare':{state.preparations++;const request=input(),confirmation={target:request.inputs.target,lenses,...(state.execution?{execution:state.execution}:{}),routes:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>c.inputs.description),limits:request.inputs.limits??{max_elapsed_seconds:600,max_revisions:0},trust:'supervised-native-cli'};result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:'review/v1'},bundle_digest:bundle,graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:confirmation.limits},selection:request,trust_posture:{execution_contract:'flow.supervised-native-cli/v1',independent_startup_enforcement:false},requested_authority:{workspace:'read-only',publication:false}};break;}
case 'launch':state.launched=true;state.launches++;if(state.lose_reply&&!state.reply_lost){state.reply_lost=true;save(stateFile,state);process.exit(99);}result={schema:'flow.launch-receipt/v1',run_id:reviewRun};break;
case 'command':state.mode='cancelled';state.decisions=(state.decisions??0)+1;result={schema:'flow.command-receipt/v1',run_id:reviewRun,outcome:'accepted'};break;
case 'query':{
 const q=input();
 if(q.query==='review_preparation_facts'){result={schema:'flow.review-preparation-facts/v1',candidate:{candidate_id:candidateId,candidate_fingerprint:fingerprint}};break;}
 if(q.contract==='work.review/v1'){
  result=q.subject_id===candidateId?candidateProjection:{schema:'flow.review-projection/v1',contract:'work.review/v1',subject_id:receipt.review_id,review_id:receipt.review_id,status:'automated_completed',current:true,evidence_currency:'current',candidate,candidate_fingerprint:fingerprint,lifecycle_generation:1,candidate_authority_watermark:watermark,source_run_id:reviewRun,operation_contract:'flow.operation/review-record/v1',operation_effect_id:'effect:review-record',operation_attempt_id:reviewRun+':review-record:attempt:1',operation_idempotency_key:'operation:review-record',summary,coverage:summary.coverage,findings:summary.findings,approval:'not_requested',merge_ready:false};break;
 }
 if(!q.run_id){result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:[producer,...(state.launched?[reviewRun]:[])]};break;}
 if(q.run_id===producer){result=producerProjection;break;}
 if(!state.launched){result={schema:'flow.rejection/v1',code:'unknown_run'};break;}
 if(state.mode==='transport_failure'){save(stateFile,state);process.exit(99);}
 const done=state.mode==='complete',cancelled=state.mode==='cancelled';result={schema:'flow.run-projection/v1',run_id:reviewRun,bundle_digest:bundle,definition_id:'review/v1',phase:done?'succeeded':cancelled?'cancelled':'active',progress:done?'completed':'executing',watermark:'sha256:'+'7'.repeat(64),sequence:done?20:10,active_plan:graph,cards:graph.cards.map(c=>({id:c.id,status:done?'completed':c.id.startsWith('review-lens-')?'executing':'pending'})),effects:done?[{effect_id:'effect:review-record',run_id:reviewRun,card_id:'review-record',attempt_id:reviewRun+':review-record:attempt:1',idempotency_key:'operation:review-record',status:'succeeded',operation_contract:'flow.operation/review-record/v1',receipt:{provider_receipt:receipt}}]:cancelled?lenses.map(lens=>({effect_id:'unresolved:'+lens,card_id:'review-lens-'+lens,status:'reconciling'})):[],blocks:[],legal_actions:done||cancelled?[]:[{schema:'flow.command/v1',type:'cancel',run_id:reviewRun,expected_watermark:'sha256:'+'7'.repeat(64)}],resource_dispositions:[]};break;
}
default:throw Error('Unexpected controlled transport '+args[0]);
}
if(args[0]==='prepare'&&state.omit_prepared_policy){delete result.graph.execution_policy;result.plan_fingerprint=digest(result.graph);}
save(stateFile,state);process.stdout.write(JSON.stringify(result)+'\\n');
`);
  return stateFile;
}

function jsonRecords(text) {
  try { return [JSON.parse(text)]; }
  catch { return text.split("\n").filter(Boolean).map(line => JSON.parse(line)); }
}

function terminalReview(f, args, steps) {
  const driver = `import errno,json,os,pty,select,signal,subprocess,sys,time
master,slave=pty.openpty()
child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
steps=json.loads(sys.argv[2]);output=bytearray();answered=0;cursor=0;deadline=time.monotonic()+25;timed_out=False
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try: chunk=os.read(master,65536)
   except OSError as error:
    if error.errno==errno.EIO: break
    raise
   if not chunk: break
   output.extend(chunk)
   if len(output)>1048576: raise RuntimeError('terminal_output_limit')
   if answered<len(steps):
    step=steps[answered];prompt=step['prompt'].encode();position=output.find(prompt,cursor)
    if position>=0:
     if step.get('interrupt'): os.kill(child.pid,signal.SIGINT)
     else: os.write(master,step['answer'].encode())
     cursor=position+len(prompt);answered+=1
 else: timed_out=True
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL);child.wait()
 os.close(master)
print(json.dumps({'exit':child.wait(),'output':output.decode(errors='replace'),'answered':answered,'timed_out':timed_out}))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)], {
    env: { ...f.env, TERM: "xterm-256color" }, cwd: f.root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.timed_out, false, terminal.output);
  assert.equal(terminal.answered, steps.length, terminal.output);
  return terminal;
}

test("omitted flags preserve the original security-only request, preview and bridge invocation", t => {
  const f = reviewFixture(t, { capable: false }), observed = f.run(["--json"]);
  assert.equal(observed.status, 0, observed.stdout + observed.stderr);
  const preview = jsonRecords(observed.stdout).find(value => value.schema === "flow.project-review-preview/v1");
  const request = JSON.parse(readFileSync(preview.request)), intent = JSON.parse(readFileSync(join(dirname(dirname(preview.request)), "intent.json")));
  assert.equal(Object.hasOwn(preview, "execution"), false); assert.equal(Object.hasOwn(intent, "execution"), false);
  assert.equal(Object.hasOwn(request.inputs, "execution"), false); assert.deepEqual(request.inputs.lenses, ["security"]);
  const bridge = f.state().calls.find(args => args[0] === "local" && args[1] === "review-request");
  assert.deepEqual(bridge, ["local", "review-request", f.directory, `run:${"1".repeat(64)}`]);
  assert.equal(f.state().launches, 0);
});

test("explicit two-lens preview binds exact roles and bounds, and real PTY decline dispatches nothing", t => {
  const f = reviewFixture(t), choices = ["--lens", "correctness", "--lens", "security", "--parallel", "2"];
  const observed = f.run([...choices, "--json"]);
  assert.equal(observed.status, 0, observed.stdout + observed.stderr);
  const preview = jsonRecords(observed.stdout).find(value => value.schema === "flow.project-review-preview/v1");
  assert.deepEqual(preview.execution, { schema: "flow.project-review-execution/v1", lenses: ["security", "correctness"], parallel: 2, owner_delegate_capacity: 2 });
  assert.deepEqual(preview.inspection.execution_policy, { schema: "flow.read-only-sibling-policy/v1", max_in_flight: 2, card_ids: ["review-lens-security", "review-lens-correctness"] });
  assert.deepEqual(preview.inspection.routes.map(route => route.card_id), ["review-lens-security", "review-lens-correctness", "review-critic"]);
  assert.ok(preview.inspection.routes.every(route => route.launch.capability === "read-only"));
  const declined = terminalReview(f, ["review", "--repository", f.repository, ...choices], [{ prompt: "Launch this exact supervised review? [y/N]", answer: "n\n" }]);
  assert.equal(declined.exit, 0, declined.output);
  assert.match(declined.output, /Selected lenses: security, correctness/u);
  assert.match(declined.output, /concurrency: 2; total native attempts: 3/u);
  assert.match(declined.output, /owner delegate capacity: 2/u);
  assert.match(declined.output, /600 seconds/u);
  const state = f.state();
  assert.equal(state.launches, 0); assert.equal(state.preparations, 1); assert.equal(state.review_requests, 1);
  assert.ok(state.calls.some(args => JSON.stringify(args) === JSON.stringify(["start", "--delegate-capacity", "2", "--json"])));
});

test("explicit selection refuses an old runtime, insufficient original owner or unsupported bridge without preparation or launch", t => {
  const choices = ["--lens", "security", "--lens", "correctness", "--parallel", "2", "--json"];
  const old = reviewFixture(t, { capable: false }), unsupported = old.run(choices);
  assert.equal(unsupported.status, 1, unsupported.stdout + unsupported.stderr);
  assert.match(unsupported.stderr, /original.*runtime|runtime.*explicit/iu);
  assert.match(unsupported.stderr, /upgrade-runtime yes/u);
  assert.deepEqual(old.state().calls, []);
  const small = reviewFixture(t); small.change({ capacity: 1, started: true });
  const refused = small.run(choices);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /capacity/iu);
  assert.equal(small.state().review_requests, 0); assert.equal(small.state().preparations, 0); assert.equal(small.state().launches, 0);
  assert.ok(small.state().calls.every(args => args[0] !== "stop"));
  const incompatible = reviewFixture(t); incompatible.change({ ignore_execution: true });
  const mismatch = incompatible.run(choices);
  assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
  assert.match(mismatch.stderr, /exact selected lenses|policy/iu);
  assert.equal(incompatible.state().preparations, 0); assert.equal(incompatible.state().launches, 0);
});

test("a prepared graph that drops selected execution policy cannot be shown as confirmable", t => {
  const f = reviewFixture(t); f.change({ omit_prepared_policy: true });
  const result = f.run(["--lens", "security", "--lens", "correctness", "--parallel", "2", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /prepared.*policy|policy.*prepared/iu);
  assert.equal(f.state().launches, 0);
});

const twoLenses = ["--lens", "security", "--lens", "correctness"];
const previewFrom = result => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const preview = jsonRecords(result.stdout).find(value => value.schema === "flow.project-review-preview/v1");
  assert.ok(preview, result.stdout); return preview;
};

test("serial two-lens choice has a distinct confirmation and cannot reuse parallel confirmation", t => {
  const f = reviewFixture(t), single = previewFrom(f.run(["--lens", "correctness", "--json"]));
  assert.deepEqual(single.execution.lenses, ["correctness"]); assert.equal(single.execution.parallel, 1);
  assert.deepEqual(single.inspection.routes.map(route => route.card_id), ["review-lens-correctness", "review-critic"]);
  const parallel = previewFrom(f.run([...twoLenses, "--parallel", "2", "--json"]));
  const serial = previewFrom(f.run([...twoLenses, "--parallel", "1", "--json"]));
  assert.notEqual(serial.selection_digest, parallel.selection_digest);
  assert.notEqual(serial.confirmation_digest, parallel.confirmation_digest);
  assert.equal(serial.execution.parallel, 1);
  assert.equal(serial.inspection.execution_policy.max_in_flight, 1);
  const before = f.state().calls.length;
  const changed = f.run([...twoLenses, "--parallel", "1", "--confirm", parallel.confirmation_digest, "--json"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stderr, /exact confirmation.*policy|selected policy/iu);
  assert.equal(f.state().calls.length, before);
  assert.equal(f.state().launches, 0);
});

test("lost launch reply and repeated confirmation adopt one exact two-lens review with retained findings", t => {
  const f = reviewFixture(t), selected = [...twoLenses, "--parallel", "2"], preview = previewFrom(f.run([...selected, "--json"]));
  f.change({ lose_reply: true, mode: "complete" });
  const confirm = [...selected, "--confirm", preview.confirmation_digest, "--no-follow", "--json"];
  for (let index = 0; index < 2; index++) {
    const result = f.run(confirm); assert.equal(result.status, 0, result.stdout + result.stderr);
    const final = jsonRecords(result.stdout).find(value => value.schema === "flow.project-review-result/v1");
    assert.equal(final.run_id, preview.run_id);
  }
  const attached = f.run(["--attach", preview.run_id, "--json"]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const final = jsonRecords(attached.stdout).find(value => value.schema === "flow.project-review-result/v1");
  assert.equal(final.status, "succeeded");
  assert.equal(final.coverage.complete, true); assert.deepEqual(final.coverage.lenses.map(value => value.lens), ["security", "correctness"]);
  assert.equal(final.findings.length, 1); assert.match(final.findings[0].summary, /rejected measurements/u);
  assert.equal(final.guided_approval_granted, false); assert.equal(final.approval, "not_requested"); assert.equal(final.merge_ready, false);
  assert.equal(final.project_checks_rerun, false);
  assert.equal(f.state().launches, 1); assert.equal(f.state().preparations, 1); assert.equal(f.state().review_requests, 1);
});

test("real PTY yes then Ctrl-C detaches; saved attachment and exact cancel retain unresolved siblings honestly", t => {
  const f = reviewFixture(t), selected = [...twoLenses, "--parallel", "2"], preview = previewFrom(f.run([...selected, "--json"]));
  const detached = terminalReview(f, ["review", "--repository", f.repository, ...selected], [
    { prompt: "Launch this exact supervised review? [y/N]", answer: "y\n" },
    { prompt: "review-lens-correctness: executing", interrupt: true },
  ]);
  assert.equal(detached.exit, 130, detached.output);
  assert.match(detached.output, /not cancelled|not cancel|continues/iu);
  assert.ok(detached.output.includes(preview.run_id));
  const wrong = f.run(["--attach", preview.run_id, "--action", `sha256:${"0".repeat(64)}`, "--json"]);
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /no longer offered|fresh choices/iu);
  assert.equal(f.state().decisions ?? 0, 0);
  const attached = f.run(["--attach", preview.run_id, "--no-follow", "--json"]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const result = f.run(["--cancel", preview.run_id, "--no-follow", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const final = jsonRecords(result.stdout).find(value => value.schema === "flow.project-review-result/v1");
  assert.equal(final.run_id, preview.run_id); assert.equal(final.phase, "cancelled"); assert.equal(final.status, "detached");
  assert.deepEqual(final.unresolved_effects, ["unresolved:security", "unresolved:correctness"]);
  assert.equal(final.guided_approval_granted, false); assert.equal(final.merge_ready, false);
  assert.equal(f.state().decisions, 1); assert.equal(f.state().launches, 1); assert.equal(f.state().preparations, 1);
});
