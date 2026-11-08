import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const source = fileURLToPath(new URL("../../../", import.meta.url));

function privateProjectState(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-review-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config", "authority", "tmp"]) mkdirSync(join(root, name));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb",
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    FLOW_AUTHORITY_DIRECTORY: join(root, "authority"), TMPDIR: join(root, "tmp") };
  const run = (args, selectedCli = cli) => spawnSync(process.execPath, [selectedCli, ...args], {
    env, cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  return { root, env, run };
}

function assertNoOwner(directory) {
  for (const name of ["owner.json", "authority.sqlite", "runs.sqlite"]) {
    assert.equal(existsSync(join(directory, name)), false, name);
  }
}

test("public review help explains exact confirmation and continuation without starting work", t => {
  const { env, run } = privateProjectState(t), result = run(["review", "--help"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /--confirm/u);
  assert.match(result.stdout, /--attach/u);
  assert.match(result.stdout, /--cancel/u);
  assert.equal(existsSync(join(env.XDG_STATE_HOME, "flow-local")), false);
  assertNoOwner(env.FLOW_AUTHORITY_DIRECTORY);
});

test("public review identifies missing initialization and invalid repositories before starting work", t => {
  const f = privateProjectState(t), repository = join(f.root, "repository");
  mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q", repository], { env: f.env });
  const missing = f.run(["review", "--repository", repository, "--json"]);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /no retained local setup|init first|initialize.*project/iu);
  const invalid = f.run(["review", "--repository", join(f.root, "absent"), "--json"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Git project|repository/iu);
  assertNoOwner(f.env.FLOW_AUTHORITY_DIRECTORY);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
});

function initializedProject(t, { controlledRuntime = false } = {}) {
  const f = privateProjectState(t), repository = join(f.root, "project");
  mkdirSync(repository);
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "review-public-fixture", private: true, scripts: { test: "node --test measurements.test.mjs" } }));
  writeFileSync(join(repository, "measurements.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("signed measurements", () => assert.equal(2 - 3 + 7, 6));\n');
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env: f.env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Review public fixture"]);
  git(["config", "user.email", "review-fixture@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  git(["config", "commit.gpgSign", "false"]);
  git(["add", "."]); git(["commit", "-qm", "Existing ordinary suite"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "measurements.txt"), "Signed measurements stay ordered.\n");
  git(["add", "."]); git(["commit", "-qm", "Retained candidate for review"]);
  const head = git(["rev-parse", "HEAD"]).trim(), tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  let runtimeCli = cli;
  if (controlledRuntime) {
    const runtime = join(f.root, "controlled-runtime");
    cpSync(source, runtime, { recursive: true,
      filter: path => !path.slice(source.length).split("/").some(part => [".git", "node_modules"].includes(part)) });
    for (const part of ["config/flow", "tools/flow", "config/agent-flow"]) {
      symlinkSync(join(source, part, "node_modules"), join(runtime, part, "node_modules"));
    }
    runtimeCli = join(runtime, "config/flow/src/cli.mjs");
  }
  const codex = join(f.root, "version-only-codex");
  writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "codex-cli 0.166.0"; exit 0; }\nexit 99\n', { mode: 0o700 });
  const initialize = summary => {
    const args = ["init", "--repository", repository, "--summary", summary, "--acceptance", "The existing suite passes", "--kind", "npm", "--codex-executable", codex, "--json"];
    const preview = f.run(args, runtimeCli); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const applied = f.run([...args, "--confirm", JSON.parse(preview.stdout).confirmation_digest], runtimeCli);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    return JSON.parse(applied.stdout);
  };
  return { ...f, repository, git, initialize, runtimeCli, base, head, tree };
}

test("public review refuses an outside client without executing it or altering the retained project", { skip: process.platform !== "linux" }, t => {
  const f = initializedProject(t), first = f.initialize("Handle signed measurements"), second = f.initialize("Handle empty measurements");
  assert.equal(first.client, second.client);
  assert.notEqual(first.request, second.request);
  const outside = join(f.root, "outside-client"), sentinel = join(f.root, "unknown-client-was-executed");
  mkdirSync(outside);
  writeFileSync(join(outside, "flow"), `#!/bin/sh\nprintf unsafe > '${sentinel}'\nexit 99\n`, { mode: 0o700 });
  const result = f.run(["review", "--repository", f.repository, "--client", outside, "--json"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /client.*(?:retained|initialized)|(?:retained|initialized).*client/iu);
  assert.equal(existsSync(sentinel), false);
  const pilot = JSON.parse(readFileSync(join(first.directory, "pilot.json"), "utf8"));
  assertNoOwner(pilot.environment.FLOW_AUTHORITY_DIRECTORY);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

// These fixtures keep the real initialized client and top-level public CLI.
// Only the owned copy's external CLI transport is replaced. They exercise the
// frontend, not native execution, authority semantics or worker retirement.
function installControlledTransport(f, setup) {
  const stateFile = join(f.root, "transport-state.json");
  writeFileSync(stateFile, JSON.stringify({ started: false, launched: false, launches: 0, preparations: 0, review_requests: 0, calls: [], mode: "active" }));
  writeFileSync(f.runtimeCli, `import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../../tools/flow/src/canonical.mjs';
const stateFile=${JSON.stringify(stateFile)},state=JSON.parse(readFileSync(stateFile)),args=process.argv.slice(2);
const directory=${JSON.stringify(setup.directory)},repository=${JSON.stringify(f.repository)};
const load=p=>JSON.parse(readFileSync(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const producer='run:'+'1'.repeat(64),reviewRun='run:'+'b'.repeat(64),candidateId='candidate:'+'3'.repeat(64),fingerprint='sha256:'+'d'.repeat(64),watermark='sha256:'+'e'.repeat(64);
const git={commit_sha:${JSON.stringify(f.head)},tree_sha:${JSON.stringify(f.tree)},ref:'refs/heads/main'};
const candidate={schema:'flow.review-candidate/v1',candidate_id:candidateId,candidate_fingerprint:fingerprint,git,source_run_id:producer};
const candidateProjection={schema:'work.review-candidate-projection/v1',contract:'work.review/v1',subject_id:candidateId,status:'sealed',candidate,candidate_fingerprint:fingerprint,watermark,generation:1,workspace:{subject_id:'workspace:fixture',generation:1,mutation_epoch:1,fingerprint:'sha256:'+'a'.repeat(64)}};
const description=role=>({schema:'flow.execution-description/v1',launch:{harness:'codex',role,capability:'read-only',model:'gpt-6.1-sol',effort:'high'},backend:{executable:{path:'/fixture/official-codex',version:'codex-cli 0.166.0',sha256:'sha256:'+'f'.repeat(64)}},effective_authority:{workspace:'read-only',approval:'never'}});
const graph={cards:[{id:'review-lens-security',executor:{kind:'delegate'},inputs:{description:description('lens:security')}},{id:'review-critic',executor:{kind:'delegate'},inputs:{description:description('critic')}},{id:'review-record',executor:{kind:'operation',contract:'flow.operation/review-record/v1'}}]};
const finding={schema:'flow.review-finding/v1',finding_id:'finding:'+'9'.repeat(64),source:'lens',lens:'security',urgency:'medium',classification:'non_blocking',summary:'Explain rejected measurements',detail:'Invalid measurements need an actionable diagnostic.',location:{path:'measurements.txt',line:1}};
const summary={schema:'flow.review-summary/v1',candidate_fingerprint:fingerprint,enabled_lenses:['security'],findings:[finding],rendered_findings:[finding],coverage:{complete:true,lenses:[{lens:'security',status:'produced'}],critic:{status:'produced'}},posture:'findings',merge_ready:false};
const receipt={schema:'flow.review-receipt/v1',review_id:'review:'+'8'.repeat(64),candidate_fingerprint:fingerprint,lifecycle_generation:1,review_authority_watermark:watermark,summary};
const producerProjection={schema:'flow.run-projection/v1',run_id:producer,phase:'succeeded',progress:'completed',watermark:'sha256:'+'2'.repeat(64),review_candidate_reference:{candidate_id:candidateId,candidate_fingerprint:fingerprint},cards:[],effects:[{effect_id:'effect:commit',status:'completed',operation_contract:'flow.operation/feature-direct-commit/v1',receipt:{provider_receipt:{schema:'flow.git-candidate-commit-receipt/v1',old_commit_sha:${JSON.stringify(f.base)},...git}}}],active_plan:{cards:[{id:'feature-project-check',executor:{kind:'operation',contract:'flow.operation/project-check/v2'}}]},trust_posture:{execution_contract:'flow.supervised-native-cli/v1',verification_scope:'Registered project command GREEN-only'}};
state.calls.push(args);
let result;
switch(args[0]) {
case 'status':result={schema:'flow.owner-status/v1',state:state.started?'running':'stopped'};break;
case 'start':state.started=true;result={schema:'flow.owner-status/v1',state:'running'};break;
case 'stop':state.started=false;result={schema:'flow.owner-status/v1',state:'stopped'};break;
case 'local':{
 if(args[1]==='review-request'){
  state.review_requests++;
  const folder=mkdtempSync(join(directory,'receipts','controlled-review-'));
  const facts={schema:'flow.review-preparation-facts/v1',candidate:{candidate_id:candidateId,candidate_fingerprint:fingerprint},source_run:{run_id:producer,watermark:producerProjection.watermark},route:{bindings:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>({card_id:c.id,description:c.inputs.description,route:{schema:'flow.delegate-route-binding/v1',agent_id:'agent:'+c.id}}))}};
  const request={schema:'flow.predefined-flow-selection/v1',definition:'review/v1',inputs:{schema:'flow.review-request/v1',target:{schema:'flow.review-local-candidate/v1',candidate,candidate_fingerprint:fingerprint,candidate_authority_watermark:watermark,lifecycle_generation:1},lenses:['security'],preparation_facts:facts,delegation:{schema:'flow.review-delegation-bindings/v1'}},execution_trust:load(join(directory,'pilot.json')).execution_trust};
  for(const [name,value] of Object.entries({'completed-run':producerProjection,candidate:candidateProjection,'preparation-facts':facts,'prepare-request':request}))save(join(folder,name+'.json'),value);
  result={status:'request_only',directory:folder,request:join(folder,'prepare-request.json')};
 }else if(args[1]==='inspect-prepared'){
  const p=load(args[2]);result={status:'inspection_only',prepared_file:args[2],bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest,definition:'review/v1',mode:'local_review',trust_posture:p.trust_posture,requested_authority:p.requested_authority,limits:p.explicit_facts.limits,routes:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>({card_id:c.id,launch:c.inputs.description.launch,executable:c.inputs.description.backend.executable,requested_permissions:c.inputs.description.effective_authority}))};
 }else if(args[1]==='accept-prepared'){
  const p=load(args[3]),folder=mkdtempSync(join(directory,'receipts','accepted-')),request=join(folder,'launch-request.json');save(request,{prepared:p,confirmation:{schema:'flow.predefined-flow-confirmation-decision/v1',decision:'accept',bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest},closed_facts:{schema:'flow.closed-fact-observation/v1',bundle_digest:p.bundle_digest,facts:p.explicit_facts},execution_trust:load(join(directory,'pilot.json')).execution_trust});result={status:'launch_request_only',directory:folder,request};
 }else throw Error('Unknown local command');break;}
case 'prepare':{state.preparations++;const request=input(),confirmation={target:request.inputs.target,lenses:['security'],routes:graph.cards.filter(c=>c.executor.kind==='delegate').map(c=>c.inputs.description),limits:request.inputs.limits??{max_elapsed_seconds:600,max_revisions:0},trust:'supervised-native-cli'};result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:'review/v1'},bundle_digest:'sha256:'+'b'.repeat(64),graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:confirmation.limits},selection:request,trust_posture:{execution_contract:'flow.supervised-native-cli/v1',independent_startup_enforcement:false},requested_authority:{workspace:'read-only',publication:false}};break;}
case 'launch':state.launched=true;state.launches++;result={schema:'flow.launch-receipt/v1',run_id:reviewRun};break;
case 'query':{
 const q=input();
 if(q.query==='review_preparation_facts'){result={schema:'flow.review-preparation-facts/v1',candidate:{candidate_id:candidateId,candidate_fingerprint:fingerprint}};break;}
 if(q.contract==='work.review/v1'){
  result=q.subject_id===candidateId?candidateProjection:{schema:'flow.review-projection/v1',contract:'work.review/v1',subject_id:receipt.review_id,review_id:receipt.review_id,status:'current',current:true,candidate,candidate_fingerprint:fingerprint,source_run_id:reviewRun,summary,coverage:summary.coverage,findings:summary.findings,approval:'not_requested',merge_ready:false};break;
 }
 if(!q.run_id){result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:[producer,...(state.launched?[reviewRun]:[])]};break;}
 if(q.run_id===producer){result=producerProjection;break;}
 if(!state.launched){result={schema:'flow.rejection/v1',code:'unknown_run'};break;}
 if(state.mode==='transport_failure'){save(stateFile,state);process.exit(99);}
 const done=state.mode==='complete';result={schema:'flow.run-projection/v1',run_id:reviewRun,bundle_digest:'sha256:'+'b'.repeat(64),definition_id:'review/v1',phase:done?'succeeded':'active',progress:done?'completed':'executing',watermark:'sha256:'+'7'.repeat(64),sequence:done?20:10,active_plan:graph,cards:graph.cards.map(c=>({id:c.id,status:done?'completed':c.executor.kind==='delegate'?'executing':'pending'})),effects:done?[{effect_id:'effect:review-record',card_id:'review-record',status:'completed',operation_contract:'flow.operation/review-record/v1',receipt:{provider_receipt:receipt}}]:[],blocks:[],legal_actions:[],resource_dispositions:[]};break;
}
default:throw Error('Unexpected controlled transport '+args[0]);
}
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

test("public review previews the exact diff without dispatch, and PTY confirmation detaches then reattaches the same review with findings", { skip: process.platform !== "linux" }, t => {
  const f = initializedProject(t, { controlledRuntime: true });
  const setup = f.initialize("Explain signed measurements"), second = f.initialize("Explain empty measurements");
  assert.equal(setup.client, second.client);
  const stateFile = installControlledTransport(f, setup);
  const selected = ["review", "--repository", f.repository, "--json"];
  const previewResult = f.run(selected);
  assert.equal(previewResult.status, 0, previewResult.stdout + previewResult.stderr);
  const preview = jsonRecords(previewResult.stdout).find(record => record.schema === "flow.project-review-preview/v1");
  assert.ok(preview, previewResult.stdout);
  assert.equal(preview.producer_run_id, `run:${"1".repeat(64)}`);
  assert.equal(preview.comparison.base_commit_sha, f.base);
  assert.equal(preview.comparison.commit_sha, f.head);
  assert.equal(JSON.parse(readFileSync(stateFile)).launches, 0);
  const plain = ["review", "--repository", f.repository];
  const decline = terminalReview(f, plain, [{ prompt: "Launch this exact supervised review? [y/N]", answer: "n\n" }]);
  assert.equal(decline.exit, 0, decline.output);
  assert.match(decline.output, /Signed measurements stay ordered/u);
  assert.match(decline.output, /security/u);
  assert.match(decline.output, /gpt-6\.1-sol/u);
  assert.match(decline.output, /supervised/iu);
  assert.equal(JSON.parse(readFileSync(stateFile)).launches, 0);
  const detached = terminalReview(f, plain, [
    { prompt: "Launch this exact supervised review? [y/N]", answer: "y\n" },
    { prompt: "review-lens-security", interrupt: true },
  ]);
  assert.equal(detached.exit, 130, detached.output);
  assert.match(detached.output, /attach/u);
  assert.match(detached.output, /not cancelled|not cancel|continues/iu);
  const duplicate = f.run([...selected, "--confirm", preview.confirmation_digest, "--no-follow"]);
  assert.equal(duplicate.status, 0, duplicate.stdout + duplicate.stderr);
  const state = JSON.parse(readFileSync(stateFile));
  assert.equal(state.launches, 1); assert.equal(state.preparations, 1); assert.equal(state.review_requests, 1);
  state.mode = "complete"; writeFileSync(stateFile, JSON.stringify(state));
  const attached = f.run([...selected, "--attach", `run:${"b".repeat(64)}`]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const result = jsonRecords(attached.stdout).find(record => record.schema === "flow.project-review-result/v1");
  assert.ok(result, attached.stdout);
  assert.equal(result.run_id, `run:${"b".repeat(64)}`);
  assert.match(JSON.stringify(result.findings), /Explain rejected measurements/u);
  assert.match(JSON.stringify(result.findings), /medium/u);
  assert.equal(result.approval, "not_requested");
  assert.equal(result.merge_ready, false);
  assert.equal(result.inherited_checks.rerun, false);
  const rendered = f.run([...plain, "--attach", `run:${"b".repeat(64)}`]);
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  assert.match(rendered.stdout, /Explain rejected measurements/u);
  assert.match(rendered.stdout, /security/u);
  assert.match(rendered.stdout, /medium/u);
  assert.match(rendered.stdout, /approval.*not.requested|not.*human approv/iu);
  assert.equal(JSON.parse(readFileSync(stateFile)).launches, 1);
  assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

test("public review keeps exact attachment guidance when its follow transport fails after launch", { skip: process.platform !== "linux" }, t => {
  const f = initializedProject(t, { controlledRuntime: true }), setup = f.initialize("Explain rejected measurements");
  const stateFile = installControlledTransport(f, setup), selected = ["review", "--repository", f.repository, "--json"];
  const observed = f.run(selected); assert.equal(observed.status, 0, observed.stdout + observed.stderr);
  const preview = jsonRecords(observed.stdout).find(record => record.schema === "flow.project-review-preview/v1");
  assert.ok(preview, observed.stdout);
  const state = JSON.parse(readFileSync(stateFile)); state.mode = "transport_failure"; writeFileSync(stateFile, JSON.stringify(state));
  const failed = f.run([...selected, "--confirm", preview.confirmation_digest, "--follow-seconds", "1"]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /attach/u);
  assert.ok((failed.stdout + failed.stderr).includes(`run:${"b".repeat(64)}`), failed.stdout + failed.stderr);
  assert.equal(JSON.parse(readFileSync(stateFile)).launches, 1);
});
