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
  const root = mkdtempSync(join(tmpdir(), "flow-run-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config", "authority", "tmp"]) mkdirSync(join(root, name));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb",
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    FLOW_AUTHORITY_DIRECTORY: join(root, "authority"), TMPDIR: join(root, "tmp") };
  const run = (args, selectedCli = cli) => spawnSync(process.execPath, [selectedCli, ...args], { env, cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  return { root, env, run };
}

function initializedProject(t, { controlledRuntime = false } = {}) {
  const f = privateProjectState(t), repository = join(f.root, "project");
  mkdirSync(repository);
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "run-project-fixture", private: true, scripts: { test: "node --test sum.test.mjs" } }));
  writeFileSync(join(repository, "sum.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("signed sum", () => assert.equal(2 - 3 + 7, 6));\n');
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env: f.env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Run public fixture"]); git(["config", "user.email", "run-fixture@example.invalid"]);
  git(["config", "core.hooksPath", "/dev/null"]); git(["config", "commit.gpgSign", "false"]);
  git(["add", "."]); git(["commit", "-qm", "Existing ordinary suite"]);
  let runtimeCli = cli;
  if (controlledRuntime) {
    const runtime = join(f.root, "controlled-runtime");
    cpSync(source, runtime, { recursive: true,
      filter: path => !path.slice(source.length).split("/").some(part => [".git", "node_modules"].includes(part)) });
    for (const part of ["config/flow", "tools/flow", "config/agent-flow"]) symlinkSync(join(source, part, "node_modules"), join(runtime, part, "node_modules"));
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
  return { ...f, repository, runtimeCli, initialize, git };
}

function assertNoOwner(setup) {
  const pilot = JSON.parse(readFileSync(join(setup.directory, "pilot.json"), "utf8"));
  const authority = pilot.environment.FLOW_AUTHORITY_DIRECTORY;
  for (const file of ["owner.json", "authority.sqlite", "runs.sqlite"]) assert.equal(existsSync(join(authority, file)), false, file);
}

test("public run help explains confirmation, attachment and cancellation without starting work", t => {
  const f = privateProjectState(t), result = f.run(["run", "--help"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /--confirm/u);
  assert.match(result.stdout, /--attach/u);
  assert.match(result.stdout, /--cancel/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.equal(existsSync(join(f.env.FLOW_AUTHORITY_DIRECTORY, "owner.json")), false);
  assert.equal(existsSync(join(f.env.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite")), false);
});

test("public run refuses missing setup and invalid repository before starting an owner", t => {
  const f = privateProjectState(t), repository = join(f.root, "repository"); mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q", repository], { env: f.env });
  const missing = f.run(["run", "--repository", repository, "--json"]);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr); assert.match(missing.stderr, /init/u);
  const invalid = f.run(["run", "--repository", join(f.root, "absent"), "--json"]);
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /Git project|repository/u);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME, "flow-local")), false);
  assert.deepEqual(readFileSync(join(repository, ".git/config"), "utf8").includes("flow"), false);
});

test("public run requires exact retained request selection and refuses ambiguity without starting work", { skip: process.platform !== "linux" }, t => {
  const f = initializedProject(t), first = f.initialize("Handle signed measurements"), second = f.initialize("Handle empty measurements");
  assert.equal(first.client, second.client); assert.notEqual(first.request, second.request);
  const ambiguous = f.run(["run", "--repository", f.repository, "--json"]);
  assert.equal(ambiguous.status, 2, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stderr, /Several.*requests/u); assert.match(ambiguous.stderr, /--request/u);
  assert.ok(ambiguous.stderr.includes(first.request)); assert.ok(ambiguous.stderr.includes(second.request));
  const outside = join(f.root, "outside-request.json"); writeFileSync(outside, readFileSync(first.request));
  const refused = f.run(["run", "--repository", f.repository, "--request", outside, "--json"]);
  assert.equal(refused.status, 2); assert.match(refused.stderr, /not a retained request/u);
  assertNoOwner(first); assert.equal(f.git(["status", "--porcelain=v1"]), "");
});

// The real generated client points at an owned runtime copy. Only its external
// CLI transport is replaced; these fixtures prove frontend interaction, not
// native execution, authority retirement, or production lifecycle semantics.
function installControlledTransport(f) {
  const stateFile = join(f.root, "transport-state.json");
  writeFileSync(stateFile, JSON.stringify({ started: false, launched: false, launches: 0, preparations: 0, commands: [], mode: "active" }));
  writeFileSync(f.runtimeCli, `import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {digest} from "../../../tools/flow/src/canonical.mjs";
const path=${JSON.stringify(stateFile)}, state=JSON.parse(readFileSync(path)),args=process.argv.slice(2);
const load=p=>JSON.parse(readFileSync(p));
const input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const runId='run:'+'b'.repeat(64);
const graph={cards:[{id:'feature-apply',executor:{kind:'delegate'},inputs:{}},{id:'feature-project-check',executor:{kind:'operation'}},{id:'feature-critique',executor:{kind:'delegate'},inputs:{}}]};
const command={schema:'flow.command/v1',type:'checkpoint_decision',run_id:runId,checkpoint_id:'inspect-candidate',decision:'approve',expected_watermark:{sequence:12}};
let result;
switch(args[0]) {
case 'status':result={state:state.started?'running':'stopped'};break;
case 'start':state.started=true;result={state:'running'};break;
case 'prepare':{state.preparations++;const request=input(),confirmation={brief:request.brief,check:'Registered GREEN-only suite'};result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:'fixture-feature'},bundle_digest:'sha256:'+'b'.repeat(64),graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:{max_elapsed_seconds:690}},selection:{inputs:{brief:request.brief}},trust_posture:{execution_contract:'flow.supervised-native-cli/v1'},requested_authority:{}};break;}
case 'local':if(args[1]==='inspect-prepared'){const p=load(args[2]);result={brief:p.confirmation.brief,limits:p.explicit_facts.limits,trust_posture:p.trust_posture};}else{const p=load(args[3]),directory=join(args[2],'receipts','controlled');mkdirSync(directory,{recursive:true});const request=join(directory,'launch-request.json');writeFileSync(request,JSON.stringify({prepared:p,confirmation:{confirmation_digest:p.confirmation_digest}}));result={request};}break;
case 'launch':state.launched=true;state.launches++;result={schema:'flow.launch-receipt/v1',run_id:runId};break;
case 'query':{const q=input();if(q.contract){result={status:'sealed',subject_id:'candidate:fixture',candidate_fingerprint:'sha256:'+'d'.repeat(64),candidate:{git:{commit_sha:'c'.repeat(40),ref:'refs/heads/feature'}}};break;}if(!q.run_id){result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:state.launched?[runId]:[]};break;}if(!state.launched){result={schema:'flow.rejection/v1',code:'unknown_run'};break;}const done=state.mode==='done';result={schema:'flow.run-projection/v1',run_id:runId,bundle_digest:'sha256:'+'b'.repeat(64),sequence:done?13:12,watermark:{sequence:done?13:12},phase:done?'succeeded':'active',progress:state.mode==='decision'?'blocked':'running',cards:[{id:'feature-apply',status:done?'completed':'executing'},{id:'feature-critique',status:done?'completed':'pending'}],effects:[],active_plan:graph,legal_actions:state.mode==='decision'?[command]:[],resource_dispositions:[],...(done?{review_candidate_reference:{candidate_id:'candidate:fixture'}}:{})};break;}
case 'command':state.commands.push(input());state.mode='done';result={schema:'flow.command-receipt/v1',run_id:runId};break;
default:throw Error('Unexpected controlled transport command '+args[0]);
}
writeFileSync(path,JSON.stringify(state));process.stdout.write(JSON.stringify(result)+'\\n');
`);
  return stateFile;
}

function terminalRun(f, args, steps) {
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
  except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL)
 child.wait();os.close(master)
print(json.dumps({'status':child.returncode,'output':output.decode('utf8','replace'),'answered':answered,'timed_out':timed_out}))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)], {
    env: f.env, cwd: f.root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.timed_out, false, terminal.output);
  assert.equal(terminal.answered, steps.length, terminal.output);
  return terminal;
}

test("rendered public confirmation detaches on Ctrl-C, reattaches the same run, and confirms a fresh decision", { skip: process.platform !== "linux" }, t => {
  const f = initializedProject(t, { controlledRuntime: true }), setup = f.initialize("Handle empty measurements");
  const stateFile = installControlledTransport(f);
  const selected = ["run", "--repository", f.repository, "--request", setup.request];
  const detached = terminalRun(f, selected, [
    { prompt: "Launch this exact supervised task? [y/N]", answer: "yes\n" },
    { prompt: "feature-apply: executing", interrupt: true },
  ]);
  assert.equal(detached.status, 130, detached.output);
  assert.match(detached.output, /Prepared supervised task/u); assert.match(detached.output, /690/u);
  assert.match(detached.output, /--attach/u); assert.match(detached.output, /Result: detached \(run phase active\)/u);
  const runId = "run:" + "b".repeat(64);
  const attached = f.run([...selected, "--attach", runId, "--no-follow", "--json"]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  assert.equal(JSON.parse(attached.stdout.trim().split("\n").at(-1)).run_id, runId);
  let state = JSON.parse(readFileSync(stateFile));
  assert.equal(state.launches, 1); assert.equal(state.preparations, 1); assert.deepEqual(state.commands, []);
  state.mode = "decision"; writeFileSync(stateFile, JSON.stringify(state));
  const decided = terminalRun(f, [...selected, "--attach", runId], [
    { prompt: "Choice number, or Enter to detach:", answer: "1\n" },
    { prompt: "Submit this exact decision? [y/N]", answer: "yes\n" },
  ]);
  assert.equal(decided.status, 0, decided.output);
  assert.match(decided.output, /Current authority choices/u); assert.match(decided.output, /inspect-candidate/u);
  assert.match(decided.output, /Result: succeeded/u);
  state = JSON.parse(readFileSync(stateFile));
  assert.equal(state.launches, 1); assert.equal(state.preparations, 1);
  assert.equal(state.commands.length, 1); assert.equal(state.commands[0].checkpoint_id, "inspect-candidate");
  assert.deepEqual(state.commands[0].expected_watermark, { sequence: 12 });
  assertNoOwner(setup); assert.equal(f.git(["status", "--porcelain=v1"]), "");
});
