import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { digest } from "../../../tools/flow/src/canonical.mjs";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return { mode, link: readlinkSync(path) };
  if (stat.isDirectory()) return { mode, children: Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])) };
  return { mode, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

function privateResearch(t) {
  const root = realpathSync(mkdtempSync("/tmp/flow-research-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb",
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const call = args => spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  return { root, env, call, run: args => call(["research", ...args]) };
}

test("public research help accepts plain question and source selections without creating state", t => {
  const f = privateResearch(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const option of ["--question", "--source", "--confirm", "--attach", "--cancel"]) assert.ok(result.stdout.includes(option), option);
  assert.match(result.stdout, /research/iu);
});

function cleanProject(t) {
  const f = privateResearch(t), repository = join(f.root, "project"); mkdirSync(repository);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env: f.env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Research public fixture"]); git(["config", "user.email", "research@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]); git(["config", "commit.gpgSign", "false"]);
  writeFileSync(join(repository, "README.md"), "This existing project has no feature brief or project test.\n");
  git(["add", "."]); git(["commit", "-qm", "Existing research context"]);
  const source = join(f.root, "observations.txt"); writeFileSync(source, "Research observations describe finite uncertainty.\n");
  return { ...f, repository, source, git };
}

test("research refuses missing setup and lifecycle-shaped invalid selections without creating state", t => {
  const f = cleanProject(t), before = snapshot(f.root);
  for (const args of [[], ["--question"], ["--question", "Which evidence remains uncertain?", "--source", f.source, "--launch"],
    ["--repository", f.repository, "--question", "Which evidence remains uncertain?", "--source", f.source, "--json"]]) {
    const result = f.run(args); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(snapshot(f.root), before);
  }
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("public research-purpose setup previews without an invented feature brief, tests or executable calls", t => {
  const f = cleanProject(t), before = snapshot(f.root);
  // The running Node is an existing native-format metadata fixture only. This
  // unconfirmed preview must never execute it as Codex or claim compatibility.
  const result = f.call(["init", "--purpose", "research", "--repository", f.repository,
    "--codex-executable", realpathSync(process.execPath), "--json"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.schema, "flow.project-init-plan/v1");
  assert.equal(preview.status, "confirmation_required"); assert.equal(preview.writes_performed, false);
  assert.equal(preview.plan.purpose, "research"); assert.ok(preview.confirmation_digest);
  for (const name of ["brief", "recipe", "project_check"]) assert.ok(preview.plan[name] === null || preview.plan[name] === undefined, name);
});

// Metadata and CLI transport fixtures exercise the real public frontend and
// PTY. They prove no native execution, authority lifecycle or retirement.
function controlledResearch(t) {
  const f = cleanProject(t), runtime = join(f.root, "original-runtime");
  cpSync(sourceRoot, runtime, { recursive: true, filter: path => !path.slice(sourceRoot.length).split("/").some(part => [".git", "node_modules"].includes(part)) });
  for (const packagePath of ["config/flow", "tools/flow", "config/agent-flow"]) symlinkSync(join(sourceRoot, packagePath, "node_modules"), join(runtime, packagePath, "node_modules"));
  const profileRoot = join(f.env.XDG_STATE_HOME, "flow-local", digest(f.repository).slice(7, 31)), directory = join(profileRoot, "clients", "verify"), authority = join(profileRoot, "authority");
  mkdirSync(join(directory, "requests"), { recursive: true }); mkdirSync(join(directory, "receipts")); mkdirSync(authority, { mode: 0o700 });
  const executable = join(f.root, "never-execute-codex"), executed = join(f.root, "executable-was-invoked");
  writeFileSync(executable, `#!/bin/sh\nprintf unexpected > '${executed}'\nexit 99\n`, { mode: 0o700 });
  const trust = { schema: "flow.supervised-native-cli/v1", acknowledgment: "trust-official-cli-permissions" };
  const gitIdentity = { author: { name: "Research fixture", email: "research@example.invalid" }, committer: { name: "Research fixture", email: "research@example.invalid" } };
  const identity = { schema: "flow.local-client/v1", repository: f.repository, runtime_root: runtime, node: realpathSync(process.execPath), executable: { path: executable, sha256: `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}` }, execution_trust: trust, git_identity: gitIdentity };
  const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  save(join(profileRoot, "profile.json"), { identity, initial_check_digest: null });
  const generated = writeFeatureClient({ directory, runtimeRoot: runtime, workspace: f.repository, executionTrust: "supervised-native-cli", codexExecutable: executable, localStateHome: f.env.XDG_STATE_HOME, authorityDirectory: authority, gitIdentity });
  save(join(directory, "pilot.json"), { directory, runtime_root: runtime, ...generated, local_client: identity, execution_trust: trust });
  const stateFile = join(f.root, "transport-state.json"), launchLog = join(f.root, "launch-invocations.jsonl");
  writeFileSync(launchLog, "");
  save(stateFile, { started: false, preparations: 0, launches: 0, launched: false, mode: "active", calls: [], commands: [] });
  writeFileSync(join(runtime, "config/flow/src/cli.mjs"), `import {readFileSync,writeFileSync,mkdtempSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';import {digest} from '../../../tools/flow/src/canonical.mjs';import {validateDelegateEvidenceSafety} from '../../../tools/flow/src/evidence-safety.mjs';
const stateFile=${JSON.stringify(stateFile)},directory=${JSON.stringify(directory)},state=JSON.parse(readFileSync(stateFile)),args=process.argv.slice(2);
const load=p=>JSON.parse(readFileSync(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const id='run:'+'b'.repeat(64),bundle='sha256:'+'b'.repeat(64);
const description=role=>({schema:'flow.execution-description/v1',launch:{harness:'codex',role,capability:'read-only',model:'gpt-6.1-sol',effort:'high',trust_posture:'supervised-native-cli'},backend:{executable:{path:'/fixture/official-codex',version:'codex-cli 0.166.0',sha256:'sha256:'+'f'.repeat(64)}},effective_authority:{filesystem:'read-only',approvals:'never',network:'disabled'}});
const graph={cards:['spike-research','spike-synthesis'].map((card,index)=>({id:card,executor:{kind:'delegate'},dependencies:index?['spike-research']:[],inputs:{description:description(index?'synthesizer':'researcher')},limits:{max_attempts:1}}))};
function completedRun(){
 const packet=state.packet,research={schema:'flow.spike-research-evidence/v2',question_id:packet.question.id,answer:'The supplied observations describe finite uncertainty.',assurance:'lower',citations:packet.sources.map(source=>({source_id:source.id,digest:source.digest})),findings:['Observed evidence is descriptive, with unresolved limits.'],residual_gaps:['This packet contains no supported-host measurement.']};
 const researchOutput=JSON.stringify(research),safety=validateDelegateEvidenceSafety(researchOutput);if(!safety.accepted)throw Error('Unsafe controlled researcher fixture');
 const researchProof={schema:'flow.delegate-evidence/v1',card_id:'spike-research',attempt_id:id+':spike-research:attempt:1',validated_output:researchOutput,evidence_safety_receipt:safety.receipt,evidence_safety_binding:safety.binding};
 const identity={schema:'flow.authority-materialized-evidence/v1',accepted_delegates:[{card_id:'spike-research',effect_id:'effect:research',attempt_id:researchProof.attempt_id,idempotency_key:'delegate:research',source_authority_watermark:'sha256:'+'6'.repeat(64),evidence:researchProof}]},envelope={...identity,evidence_digest:digest(identity)};
 const report={...research,schema:'flow.spike-report/v2',answer:'Retain bounded observations and explicit residual uncertainty.',research_evidence_digest:state.mode==='forged_report'?'sha256:'+'0'.repeat(64):envelope.evidence_digest};
 const output=JSON.stringify(report),reportSafety=validateDelegateEvidenceSafety(output),attemptId=id+':spike-synthesis:attempt:1';if(!reportSafety.accepted)throw Error('Unsafe controlled synthesis fixture');
 const evidence={schema:'flow.delegate-evidence/v1',card_id:'spike-synthesis',attempt_id:attemptId,validated_output:output,evidence_safety_receipt:reportSafety.receipt,evidence_safety_binding:reportSafety.binding};
 return {schema:'flow.run-projection/v1',run_id:id,bundle_digest:bundle,definition_id:'spike/v2',phase:'succeeded',progress:'completed',watermark:'sha256:'+'8'.repeat(64),sequence:20,active_plan:graph,cards:graph.cards.map(card=>({id:card.id,status:'completed'})),effects:[{effect_id:'effect:synthesis',run_id:id,card_id:'spike-synthesis',attempt_id:attemptId,idempotency_key:'delegate:synthesis',effect_kind:'delegate',status:'succeeded',receipt:{provider_receipt:evidence}}],delegate_attempts:[{card_id:'spike-synthesis',attempt_id:attemptId,effect_id:'effect:synthesis',status:'accepted',evidence}],effect_intents:[{effect_id:'effect:synthesis',run_id:id,card_id:'spike-synthesis',attempt_id:attemptId,idempotency_key:'delegate:synthesis',effect_kind:'delegate',delegate_input:{task_inputs:{schema:'flow.delegate-task-inputs/v1',flow:'spike/v2',phase:'synthesis',role:'synthesizer',packet},authority_materialized_evidence:envelope}}],blocks:[],legal_actions:[],resource_dispositions:[]};
}
state.calls.push(args);let result;
switch(args[0]){
case 'status':result={schema:'flow.owner-status/v1',state:state.started?'running':'stopped'};break;
case 'start':state.started=true;result={schema:'flow.owner-status/v1',state:'running'};break;
case 'stop':state.started=false;result={schema:'flow.owner-status/v1',state:'stopped'};break;
case 'prepare':{state.preparations++;const request=input(),confirmation={packet:request.packet,limits:request.limits,routes:graph.cards.map(c=>c.inputs.description),trust:'supervised-native-cli'};state.packet=request.packet;result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:'spike/v2'},bundle_digest:bundle,graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:request.limits},selection:request,trust_posture:{execution_contract:'flow.supervised-native-cli/v1',independent_workspace_and_tool_network_enforcement:false},requested_authority:{commands:['cancel'],capabilities:[],mutations:[]}};break;}
case 'local':{
 if(args[1]==='inspect-prepared'){const p=load(args[2]);result={status:'inspection_only',definition:'spike/v2',prepared_file:args[2],bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest,trust_posture:p.trust_posture,requested_authority:p.requested_authority,limits:p.explicit_facts.limits,routes:graph.cards.map(c=>({card_id:c.id,launch:c.inputs.description.launch,executable:c.inputs.description.backend.executable,requested_permissions:c.inputs.description.effective_authority}))};}
 else if(args[1]==='accept-prepared'){const p=load(args[3]),folder=mkdtempSync(join(directory,'receipts','accepted-')),request=join(folder,'launch-request.json');save(request,{prepared:p,confirmation:{schema:'flow.predefined-flow-confirmation-decision/v1',decision:'accept',bundle_digest:p.bundle_digest,confirmation_digest:p.confirmation_digest},closed_facts:{schema:'flow.closed-fact-observation/v1',bundle_digest:p.bundle_digest,facts:p.explicit_facts},execution_trust:${JSON.stringify(trust)}});result={status:'launch_request_only',directory:folder,request};}
 else throw Error('Unexpected controlled local command');break;}
case 'launch':state.launches++;state.launched=true;appendFileSync(${JSON.stringify(launchLog)},JSON.stringify({run_id:id,bundle_digest:input().prepared.bundle_digest})+'\\n');if(state.mode==='lost_launch_reply'){save(stateFile,state);process.exit(99);}result={schema:'flow.launch-receipt/v1',run_id:id};break;
case 'query':{const q=input();if(!q.run_id){result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:state.launched?[id]:[]};break;}if(!state.launched){result={schema:'flow.rejection/v1',code:'unknown_run'};break;}if(['complete','forged_report'].includes(state.mode)){result=completedRun();break;}result={schema:'flow.run-projection/v1',run_id:id,bundle_digest:bundle,definition_id:'spike/v2',phase:state.mode==='cancelled'?'cancelled':'active',progress:'executing',watermark:'sha256:'+'7'.repeat(64),sequence:10,active_plan:graph,cards:graph.cards.map(c=>({id:c.id,status:c.id==='spike-research'?'executing':'pending'})),effects:[],delegate_attempts:[],effect_intents:[],blocks:[],legal_actions:[{schema:'flow.command/v1',type:'cancel',run_id:id,expected_watermark:'sha256:'+'7'.repeat(64)}],resource_dispositions:[]};break;}
case 'command':{const c=input();if(c.type!=='cancel'||c.run_id!==id||c.expected_watermark!=='sha256:'+'7'.repeat(64))throw Error('Only exact public cancel supported');state.commands.push(c);state.mode='cancelled';result={accepted:true};break;}
default:throw Error('Unexpected controlled transport '+args[0]);}
save(stateFile,state);process.stdout.write(JSON.stringify(result)+'\\n');
`);
  const syntax = spawnSync(process.execPath, ["--check", join(runtime, "config/flow/src/cli.mjs")], { env: f.env, encoding: "utf8", timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
  return { ...f, runtime, profileRoot, directory, authority, stateFile, launchLog, save, state: () => JSON.parse(readFileSync(stateFile)), executed, identity, trust, gitIdentity };
}

function records(text) {
  try { return [JSON.parse(text)]; } catch { return text.split("\n").filter(Boolean).map(line => JSON.parse(line)); }
}

function terminalResearch(f, args, steps) {
  const driver = `import errno,json,os,pty,select,signal,subprocess,sys,time
master,slave=pty.openpty();child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
steps=json.loads(sys.argv[2]);output=bytearray();answered=0;cursor=0;deadline=time.monotonic()+25;timed_out=False
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try:chunk=os.read(master,65536)
   except OSError as error:
    if error.errno==errno.EIO:break
    raise
   if not chunk:break
   output.extend(chunk)
   if len(output)>1048576:raise RuntimeError('terminal_output_limit')
   if answered<len(steps):
    step=steps[answered];prompt=step['prompt'].encode();position=output.find(prompt,cursor)
    if position>=0:
     if step.get('interrupt'):os.kill(child.pid,signal.SIGINT)
     else:os.write(master,step['answer'].encode())
     cursor=position+len(prompt);answered+=1
 else:timed_out=True
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 os.close(master)
print(json.dumps({'exit':child.wait(),'output':output.decode(errors='replace'),'answered':answered,'timed_out':timed_out}))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, cli, "research", ...args]), JSON.stringify(steps)], { env: { ...f.env, TERM: "xterm-256color" }, cwd: f.root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const terminal = JSON.parse(result.stdout); assert.equal(terminal.timed_out, false, terminal.output); assert.equal(terminal.answered, steps.length, terminal.output);
  return terminal;
}

test("public preview retains exact source bytes and cached terminal decline dispatches nothing", { skip: process.platform !== "linux" }, t => {
  const f = controlledResearch(t), content = "Résumé observations retain CRLF and their supplied uncertainty.\r\n";
  writeFileSync(f.source, content);
  const args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const response = f.run([...args, "--json"]); assert.equal(response.status, 0, response.stdout + response.stderr);
  const preview = records(response.stdout).find(value => value.schema === "flow.project-research-preview/v1"); assert.ok(preview, response.stdout);
  assert.equal(preview.packet.sources.length, 1); assert.equal(preview.packet.sources[0].content, content);
  const sourceDigest = createHash("sha256").update(Buffer.from(content)).digest("hex");
  assert.equal(preview.packet.sources[0].digest, `sha256:${sourceDigest}`); assert.equal(preview.packet.sources[0].uri, `urn:sha256:${sourceDigest}`);
  assert.equal(preview.packet.sources[0].size_bytes, Buffer.byteLength(content)); assert.equal(JSON.stringify(preview.packet).includes(f.root), false);
  const preparedBefore = readFileSync(preview.prepared_file), declined = terminalResearch(f, args, [{ prompt: "Launch this exact supervised research? [y/N]", answer: "n\n" }]);
  assert.equal(declined.exit, 0, declined.output); assert.match(declined.output, /Which observation tradeoffs remain uncertain/u);
  assert.match(declined.output, /researcher/iu); assert.match(declined.output, /synthesizer/iu); assert.match(declined.output, /supervised/iu); assert.match(declined.output, /600/u);
  assert.deepEqual(readFileSync(preview.prepared_file), preparedBefore); assert.equal(f.state().preparations, 1); assert.equal(f.state().launches, 0); assert.equal(existsSync(f.executed), false);
});

test("source drift and unsafe source contents cannot reuse confirmation or start native work", { skip: process.platform !== "linux" }, t => {
  const f = controlledResearch(t), args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const first = f.run([...args, "--json"]); assert.equal(first.status, 0, first.stdout + first.stderr);
  const preview = records(first.stdout).find(value => value.schema === "flow.project-research-preview/v1"); assert.ok(preview);
  writeFileSync(f.source, "Changed supplied research observations.\n");
  const changed = f.run([...args, "--confirm", preview.confirmation_digest, "--json"]); assert.notEqual(changed.status, 0, changed.stdout + changed.stderr);
  assert.equal(f.state().launches, 0);
  const unsafe = "password=owned-source-sentinel"; writeFileSync(f.source, unsafe);
  const calls = f.state().calls.length, rejected = f.run([...args, "--json"]);
  assert.notEqual(rejected.status, 0); assert.equal((rejected.stdout + rejected.stderr).includes(unsafe), false);
  assert.equal(f.state().calls.length, calls, "unsafe source must fail before owner start or transport"); assert.equal(f.state().launches, 0); assert.equal(existsSync(f.executed), false);
});

test("terminal confirmation detaches on interrupt then attaches and cancels the same research attempt", { skip: process.platform !== "linux" }, t => {
  const f = controlledResearch(t), args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const terminal = terminalResearch(f, args, [
    { prompt: "Launch this exact supervised research? [y/N]", answer: "y\n" },
    { prompt: "spike-research", interrupt: true },
  ]);
  assert.equal(terminal.exit, 130, terminal.output); assert.match(terminal.output, /attach/u); assert.match(terminal.output, /not cancel|continues/iu);
  const runId = `run:${"b".repeat(64)}`;
  const attached = f.run(["--repository", f.repository, "--attach", runId, "--no-follow", "--json"]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  assert.equal(records(attached.stdout).at(-1).run_id, runId);
  assert.equal(readFileSync(f.launchLog, "utf8").trim().split("\n").length, 1); assert.equal(f.state().preparations, 1);
  const cancelled = f.run(["--repository", f.repository, "--cancel", runId, "--json"]);
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  const result = records(cancelled.stdout).find(value => value.schema === "flow.project-research-result/v1");
  assert.ok(result, cancelled.stdout); assert.equal(result.phase, "cancelled"); assert.equal(result.status, "cancelled");
  assert.equal(f.state().commands.length, 1); assert.equal(f.state().commands[0].type, "cancel");
  assert.equal(f.state().commands[0].expected_watermark, `sha256:${"7".repeat(64)}`);
  assert.equal(f.state().preparations, 1); assert.equal(existsSync(f.executed), false);
});

function concurrentCall(t, f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "research", ...args], { env: f.env, cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Owned research frontend did not settle")); }, 15000);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill("SIGTERM"); });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill("SIGTERM"); });
    child.once("exit", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

test("a lost launch response and concurrent confirmations retain one immutable research run", { skip: process.platform !== "linux" }, async t => {
  const f = controlledResearch(t), args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const first = f.run([...args, "--json"]); assert.equal(first.status, 0, first.stdout + first.stderr);
  const preview = records(first.stdout).find(value => value.schema === "flow.project-research-preview/v1"); assert.ok(preview);
  const state = f.state(); state.mode = "lost_launch_reply"; f.save(f.stateFile, state);
  const confirmation = [...args, "--confirm", preview.confirmation_digest, "--no-follow", "--json"];
  const lost = f.run(confirmation); assert.ok([0, 1].includes(lost.status), lost.stdout + lost.stderr);
  const repeated = await Promise.all([concurrentCall(t, f, confirmation), concurrentCall(t, f, confirmation)]);
  for (const result of repeated) {
    if (result.status === 0) assert.equal(records(result.stdout).at(-1).run_id, `run:${"b".repeat(64)}`);
    else { assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stderr, /another|busy|submission|locked/iu); }
  }
  const launches = readFileSync(f.launchLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(launches, [{ run_id: `run:${"b".repeat(64)}`, bundle_digest: preview.bundle_digest }]);
  assert.equal(f.state().preparations, 1); assert.equal(existsSync(f.executed), false);
});

test("completed research displays findings and residual gaps but rejects forged researcher proof", { skip: process.platform !== "linux" }, t => {
  const f = controlledResearch(t), args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const first = f.run([...args, "--json"]); assert.equal(first.status, 0, first.stdout + first.stderr);
  const preview = records(first.stdout).find(value => value.schema === "flow.project-research-preview/v1");
  const accepted = f.run([...args, "--confirm", preview.confirmation_digest, "--no-follow", "--json"]); assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const state = f.state(); state.mode = "forged_report"; f.save(f.stateFile, state);
  const attach = ["--repository", f.repository, "--attach", `run:${"b".repeat(64)}`];
  const forged = f.run([...attach, "--json"]); assert.notEqual(forged.status, 0, forged.stdout + forged.stderr);
  assert.match(forged.stderr, /proof|evidence|report|source/iu);
  const after = f.state(); after.mode = "complete"; f.save(f.stateFile, after);
  const complete = f.run([...attach, "--json"]); assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  const result = records(complete.stdout).find(value => value.schema === "flow.project-research-result/v1"); assert.ok(result, complete.stdout);
  assert.equal(result.status, "succeeded"); assert.equal(result.phase, "succeeded"); assert.equal(result.packet_digest, preview.packet.packet_digest);
  assert.equal(result.report.assurance, "lower"); assert.equal(result.report.findings.length, 1); assert.equal(result.report.residual_gaps.length, 1);
  assert.deepEqual(result.report.citations, preview.packet.sources.map(source => ({ source_id: source.id, digest: source.digest })));
  assert.equal(result.research_evidence_digest, result.report.research_evidence_digest);
  assert.equal(result.candidate, undefined); assert.equal(result.review, undefined); assert.notEqual(result.approval, true);
  const rendered = f.run(attach); assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  assert.match(rendered.stdout, /Assurance: lower/u); assert.match(rendered.stdout, /Finding:/u); assert.match(rendered.stdout, /Residual gap:/u);
  assert.match(rendered.stdout, /no.*(?:candidate|approval)|never.*approval/iu);
  assert.equal(readFileSync(f.launchLog, "utf8").trim().split("\n").length, 1); assert.equal(existsSync(f.executed), false);
});

test("ambiguous retained clients require explicit selection and real terminal choice precedes decline", { skip: process.platform !== "linux" }, t => {
  const f = controlledResearch(t), secondRuntime = join(f.root, "second-runtime"); cpSync(f.runtime, secondRuntime, { recursive: true });
  const directory = join(f.profileRoot, "clients", `verify.runtime-${digest(secondRuntime).slice(7)}`);
  mkdirSync(join(directory, "requests"), { recursive: true }); mkdirSync(join(directory, "receipts"));
  const generated = writeFeatureClient({ directory, runtimeRoot: secondRuntime, workspace: f.repository, executionTrust: "supervised-native-cli", codexExecutable: f.identity.executable.path,
    localStateHome: f.env.XDG_STATE_HOME, authorityDirectory: f.authority, gitIdentity: f.gitIdentity });
  f.save(join(directory, "pilot.json"), { directory, runtime_root: secondRuntime, ...generated, local_client: { ...f.identity, runtime_root: secondRuntime }, execution_trust: f.trust });
  const args = ["--repository", f.repository, "--question", "Which observation tradeoffs remain uncertain?", "--source", f.source];
  const before = snapshot(f.env.XDG_STATE_HOME), refusal = f.run([...args, "--json"]);
  assert.equal(refusal.status, 2, refusal.stdout + refusal.stderr); assert.match(refusal.stderr, /--client/u);
  assert.deepEqual(snapshot(f.env.XDG_STATE_HOME), before); assert.equal(f.state().calls.length, 0);
  const selected = terminalResearch(f, args, [{ prompt: "Client number:", answer: "1\n" }, { prompt: "Launch this exact supervised research? [y/N]", answer: "n\n" }]);
  assert.equal(selected.exit, 0, selected.output); assert.match(selected.output, /Choose the exact initialized client/u);
  assert.equal(f.state().launches, 0); assert.equal(f.state().preparations, 1); assert.equal(existsSync(f.executed), false);
});
