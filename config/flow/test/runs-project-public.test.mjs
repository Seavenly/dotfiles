import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const source = fileURLToPath(new URL("../../../", import.meta.url));
const linux = { skip: process.platform !== "linux" && "Fixture initialization uses registered Linux project checks" };
const featureId = `run:${"a".repeat(64)}`, reviewId = `run:${"b".repeat(64)}`, manualId = `run:${"c".repeat(64)}`;

function privateState(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-runs-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const invoke = (args, selectedCli = cli) => spawnSync(process.execPath, [selectedCli, ...args], { env, cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return { root, env, invoke, run: args => invoke(["runs", ...args]) };
}

function snapshot(root) {
  const result = {};
  const visit = (path, relative) => {
    const stat = lstatSync(path), item = { mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) item.link = readlinkSync(path);
    else if (stat.isFile()) item.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    else if (stat.isDirectory()) {
      item.type = "directory"; result[relative] = item;
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    } else item.type = "other";
    result[relative] = item;
  };
  visit(root, "."); return result;
}

test("public runs help describes the read-only inventory without creating local state", t => {
  const f = privateState(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /flow-supervised runs/u);
  assert.match(result.stdout, /read.only|without starting|starts no owner|No owner start/iu);
});

test("an uninitialized project has an honest empty inventory and plain init guidance", t => {
  const f = privateState(t), repository = join(f.root, "project"); mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q", repository], { env: f.env });
  const before = snapshot(f.root), result = f.run(["--repository", repository, "--json"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, "flow.project-runs/v1"); assert.equal(value.status, "uninitialized");
  assert.deepEqual(value.attempts, []); assert.deepEqual(value.clients, []);
  const human = f.run(["--repository", repository]);
  assert.equal(human.status, 0, human.stdout + human.stderr); assert.match(human.stdout, /flow-supervised init/u);
  assert.deepEqual(snapshot(f.root), before);
});

test("invalid project selections and lifecycle-shaped flags refuse without creating state", t => {
  const f = privateState(t), before = snapshot(f.root);
  for (const args of [["--repository", join(f.root, "absent"), "--json"], ["--confirm", `sha256:${"a".repeat(64)}`], ["--cancel", "run:unknown"]]) {
    const result = f.run(args); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(snapshot(f.root), before);
  }
});

function jsonRecords(result) {
  try { return [JSON.parse(result.stdout)]; }
  catch { return result.stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
}

function initializedInventory(t, { title = "Inspect signed measurements" } = {}) {
  const f = privateState(t), repository = join(f.root, "project"), runtime = join(f.root, "original-runtime");
  mkdirSync(repository);
  writeFileSync(join(repository, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test sum.test.mjs" } }));
  writeFileSync(join(repository, "sum.test.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync("project-command-executed", "unexpected");\n');
  const git = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", repository, ...args], { env: f.env, encoding: "utf8", timeout: 10000 });
  git(["init", "-q", "--initial-branch=main"]); git(["config", "user.name", "Inventory fixture"]); git(["config", "user.email", "inventory@example.invalid"]);
  git(["add", "."]); git(["commit", "-qm", "Existing project suite"]); const base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "measurements.txt"), "Signed measurements stay ordered.\n"); git(["add", "."]); git(["commit", "-qm", "Owned retained candidate fixture"]);
  const head = git(["rev-parse", "HEAD"]).trim(), tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  cpSync(source, runtime, { recursive: true, filter: path => !path.slice(source.length).split("/").some(part => [".git", "node_modules"].includes(part)) });
  for (const part of ["config/flow", "tools/flow", "config/agent-flow"]) symlinkSync(join(source, part, "node_modules"), join(runtime, part, "node_modules"));
  const runtimeCli = join(runtime, "config/flow/src/cli.mjs"), codex = join(f.root, "version-only-codex");
  writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "codex-cli 0.166.0"; exit 0; }\nexit 99\n', { mode: 0o700 });
  const args = ["init", "--repository", repository, "--summary", title, "--acceptance", "The original suite passes", "--codex-executable", codex, "--json"];
  const selected = f.invoke(args, runtimeCli); assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const applied = f.invoke([...args, "--confirm", JSON.parse(selected.stdout).confirmation_digest], runtimeCli); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const setup = JSON.parse(applied.stdout), pilot = JSON.parse(readFileSync(join(setup.directory, "pilot.json"), "utf8"));
  const configPath = join(f.root, "transport-config.json"), trace = join(f.root, "transport-trace.jsonl"), forbidden = join(f.root, "forbidden-lifecycle");
  writeFileSync(trace, "");
  const config = { setup: true, owner_state: "stopped", projections: {}, review_record: null, launch_reply_lost: false };
  const configure = changes => { Object.assign(config, changes); writeFileSync(configPath, JSON.stringify(config)); };
  configure({});
  // Only the original client's owned external CLI transport is replaced. These
  // reduced fixtures test overview behavior, not native or authority semantics.
  writeFileSync(runtimeCli, `import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path'; import {digest} from '../../../tools/flow/src/canonical.mjs';
const configPath=${JSON.stringify(configPath)},trace=${JSON.stringify(trace)},forbidden=${JSON.stringify(forbidden)};
const state=JSON.parse(readFileSync(configPath)),args=process.argv.slice(2);appendFileSync(trace,JSON.stringify(args)+'\\n');
const load=p=>JSON.parse(readFileSync(p)),input=()=>args.includes('--input-file')?load(args[args.indexOf('--input-file')+1]):JSON.parse(args[args.indexOf('--input')+1]??'{}');
const featureId=${JSON.stringify(featureId)},reviewId=${JSON.stringify(reviewId)},directory=${JSON.stringify(setup.directory)},repository=${JSON.stringify(repository)};
const fingerprint='sha256:'+'e'.repeat(64),candidateId='candidate:'+'d'.repeat(64),watermark='sha256:'+'f'.repeat(64);
const git={clean:true,commit_sha:${JSON.stringify(head)},tree_sha:${JSON.stringify(tree)},ref:'refs/heads/main'};
const candidate={schema:'work.review-candidate/v1',candidate_id:candidateId,candidate_fingerprint:fingerprint,git};
const candidateProjection={schema:'work.review-candidate-projection/v1',subject_id:candidateId,status:'sealed',candidate,candidate_fingerprint:fingerprint,generation:1,watermark};
if(!state.setup&&!['status','query'].includes(args[0])){writeFileSync(forbidden,JSON.stringify(args));throw Error('Overview attempted lifecycle work');}
let result;
switch(args[0]){
case 'status':result={schema:'flow.owner-status/v1',state:state.owner_state};break;
case 'start':state.owner_state='running';result={schema:'flow.owner-status/v1',state:'running'};break;
case 'prepare':{const request=input(),review=request.definition==='review/v1',confirmation={brief:request.brief??null,check:'Registered GREEN-only suite'};
 const graph={cards:review?[{id:'review-lens-security',executor:{kind:'delegate'}},{id:'review-critic',executor:{kind:'delegate'}},{id:'review-record',executor:{kind:'operation',contract:'flow.operation/review-record/v1'}}]:[{id:'feature-apply',executor:{kind:'delegate'}},{id:'feature-project-check',executor:{kind:'operation',contract:'flow.operation/project-check/v2'}},{id:'feature-critique',executor:{kind:'delegate'}}]};
 result={schema:'flow.prepared-run/v1',kind:'predefined',definition:{id:review?'review/v1':'feature/v1'},bundle_digest:'sha256:'+(review?'b':'a').repeat(64),graph,plan_fingerprint:digest(graph),confirmation,confirmation_digest:digest(confirmation),explicit_facts:{limits:{max_elapsed_seconds:600,max_revisions:0}},selection:{inputs:{brief:request.brief}},trust_posture:{execution_contract:'flow.supervised-native-cli/v1'},requested_authority:{}};break;}
case 'local':if(args[1]==='inspect-prepared'){const p=load(args[2]);result={brief:p.confirmation.brief,limits:p.explicit_facts.limits,trust_posture:p.trust_posture};}
 else if(args[1]==='accept-prepared'){const p=load(args[3]),root=join(directory,'receipts','controlled-launch');mkdirSync(root,{recursive:true});const request=join(root,'launch-request.json');writeFileSync(request,JSON.stringify({prepared:p,confirmation:{confirmation_digest:p.confirmation_digest}}));result={request};}
 else if(args[1]==='review-request'){const root=join(directory,'receipts','review-controlled');mkdirSync(root,{recursive:true});const request=join(root,'prepare-request.json');writeFileSync(request,JSON.stringify({schema:'flow.predefined-flow-selection/v1',definition:'review/v1',inputs:{target:{schema:'flow.review-local-candidate/v1',candidate,candidate_fingerprint:fingerprint,lifecycle_generation:1,candidate_authority_watermark:watermark},preparation_facts:{source_run:{run_id:featureId}},limits:{max_elapsed_seconds:600,max_revisions:0}},execution_trust:${JSON.stringify(pilot.execution_trust)}}));result={status:'request_only',directory:root,request};}else throw Error('Unexpected local fixture command');break;
case 'launch':if(state.launch_reply_lost)throw Error('controlled lost reply without admission');result={schema:'flow.launch-receipt/v1',run_id:input().prepared.bundle_digest.replace('sha256:','run:')};break;
case 'query':{const q=input();if(q.subject_id===candidateId){result=candidateProjection;break;}if(q.subject_id&&state.review_record){result=state.review_record;break;}
 if(q.run_id){result=state.projections[q.run_id]??{schema:'flow.rejection/v1',code:'unknown_run'};break;}
 result={schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:Object.keys(state.projections).sort(),watermark:'fixture-index:1'};break;}
default:throw Error('Unexpected fixture command '+args[0]);
}
if(state.setup)writeFileSync(configPath,JSON.stringify(state));process.stdout.write(JSON.stringify(result)+'\\n');
`);
  const records = result => { assert.equal(result.status, 0, result.stdout + result.stderr); return jsonRecords(result); };
  const preview = records(f.invoke(["run", "--repository", repository, "--request", setup.request, "--json"])).find(value => value.schema === "flow.project-run-preview/v1");
  assert.ok(preview); configure({ owner_state: "stopped", setup: false }); writeFileSync(trace, "");
  const protectedTrees = () => ({ project: snapshot(repository), state: snapshot(f.env.XDG_STATE_HOME), runtime: snapshot(runtime), home: snapshot(f.env.HOME), configuration: snapshot(f.env.XDG_CONFIG_HOME), transport_inputs: snapshot(configPath) });
  const calls = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const assertReadOnly = before => {
    assert.deepEqual(protectedTrees(), before); assert.equal(existsSync(forbidden), false);
    assert.ok(calls().every(args => ["status", "query"].includes(args[0])));
    assert.equal(existsSync(join(repository, "project-command-executed")), false); assert.equal(git(["status", "--porcelain"]), "");
  };
  const projection = (runId, phase = "succeeded") => ({ schema: "flow.run-projection/v1", run_id: runId, bundle_digest: runId.replace("run:", "sha256:"), phase,
    watermark: "fixture-run:1", sequence: 1, cards: [], effects: [], resource_dispositions: [], active_plan: { cards: [] } });
  // The owned original-client transport supplies protocol facts. This regular
  // marker selects that transport branch; it is not a real authority database
  // and is never inspected as authority evidence or given to a real owner.
  const enableHistoryTransport = () => writeFileSync(join(pilot.environment.FLOW_AUTHORITY_DIRECTORY, "authority.sqlite"), "Controlled read-only query transport fixture only.\n");
  return { ...f, repository, runtime, runtimeCli, setup, pilot, config, configure, trace, records, preview, protectedTrees, calls, assertReadOnly, projection, git, base, head, tree, enableHistoryTransport };
}

test("stopped-owner prepared overview retains its exact confirmation and never starts or submits work", linux, t => {
  const f = initializedInventory(t), before = f.protectedTrees();
  const result = f.run(["--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout), attempt = value.attempts.find(item => item.kind === "feature" && item.intended_run_id === featureId);
  assert.ok(attempt); assert.equal(attempt.state, "prepared");
  assert.ok(attempt.next_commands.some(item => item.command.includes(f.setup.request) && item.command.includes(f.preview.confirmation_digest)));
  assert.ok(f.calls().every(args => !args.includes("--refresh")));
});

test("an accepted intent with a lost reply remains uncertain and is never retried by overview", linux, t => {
  const f = initializedInventory(t);
  f.configure({ setup: true, owner_state: "running", launch_reply_lost: true });
  const lost = f.invoke(["run", "--repository", f.repository, "--request", f.setup.request, "--confirm", f.preview.confirmation_digest, "--no-follow", "--json"]);
  assert.equal(lost.status, 1, lost.stdout + lost.stderr);
  assert.equal(existsSync(join(dirname(f.preview.prepared_file), "accepted.json")), true);
  f.configure({ setup: false, owner_state: "stopped" }); writeFileSync(f.trace, "");
  const before = f.protectedTrees(), result = f.run(["--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout), attempt = value.attempts.find(item => item.intended_run_id === featureId);
  assert.equal(value.status, "attention"); assert.equal(value.complete, true);
  assert.ok(attempt); assert.equal(attempt.state, "accepted_unknown");
  assert.match(JSON.stringify(attempt.attention), /accepted|admission|unknown|uncertain/iu);
  assert.ok(attempt.next_commands.every(item => !item.command.includes("--confirm") && !item.command.includes("--refresh")));
});

test("stopped manual cancelled history prints original inspection rather than invented guided ownership or settlement", linux, t => {
  const f = initializedInventory(t), manual = f.projection(manualId, "cancelled");
  manual.effects = [{ effect_id: "effect:external", status: "unresolved" }];
  manual.resource_dispositions = [{ disposition: "quarantined", claim: { id: "workspace:held", generation: 1, mutation_epoch: 1 } }];
  f.configure({ projections: { [manualId]: manual } }); f.enableHistoryTransport();
  const before = f.protectedTrees(), result = f.run(["--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout), attempt = value.attempts.find(item => item.run_id === manualId);
  assert.ok(attempt); assert.equal(attempt.kind, "manual"); assert.equal(attempt.phase, "cancelled");
  assert.equal(attempt.observation, "inspect_only"); assert.match(JSON.stringify(attempt.attention), /unresolved|quarantin/iu);
  assert.ok(attempt.next_commands.some(item => item.command.includes(f.setup.client) && item.command.includes("query") && item.command.includes(manualId)));
  assert.ok(attempt.next_commands.every(item => !item.command.includes("--attach")));
});

test("stopped exact independent review retains findings and human state without granting approval", linux, t => {
  const f = initializedInventory(t), fingerprint = `sha256:${"e".repeat(64)}`, candidateId = `candidate:${"d".repeat(64)}`, watermark = `sha256:${"f".repeat(64)}`;
  const producer = f.projection(featureId), candidateGit = { clean: true, commit_sha: f.head, tree_sha: f.tree, ref: "refs/heads/main" };
  producer.review_candidate_reference = { candidate_id: candidateId, candidate_fingerprint: fingerprint };
  producer.cards = [{ id: "feature-project-check", status: "completed" }, { id: "feature-critique", status: "completed" }];
  producer.active_plan.cards = [{ id: "feature-project-check", executor: { contract: "flow.operation/project-check/v2" } }];
  producer.effects = [
    { operation_contract: "flow.operation/feature-direct-commit/v1", status: "succeeded", receipt: { provider_receipt: { schema: "flow.git-candidate-commit-receipt/v1", old_commit_sha: f.base, ...candidateGit } } },
    { operation_contract: "flow.operation/project-check/v2", status: "succeeded", receipt: { provider_receipt: { schema: "work.project-check-receipt/v2", outcome: "passed", exit_code: 0, candidate: candidateGit } } },
  ];
  f.configure({ setup: true, projections: { [featureId]: producer } });
  const prepared = f.records(f.invoke(["review", "--repository", f.repository, "--client", f.setup.directory, "--producer", featureId, "--json"]));
  const preview = prepared.find(value => value.schema === "flow.project-review-preview/v1"); assert.ok(preview);
  const effectId = "effect:exact-review-record", attemptId = "attempt:exact-review-record", idempotencyKey = "operation:exact-review-record", recordId = "review:exact-record";
  const finding = { id: "finding:units", lens: "security", urgency: "medium", classification: "non_blocking", summary: "Explain rejected measurement units", detail: "Document which units are supported.", location: { path: "measurements.txt", line: 1 } };
  const coverage = { complete: true, lenses: [{ lens: "security", status: "produced" }], critic: { status: "produced" } };
  const approval = { status: "not_requested", reason: { code: "automated_review_is_not_human_approval" } };
  const humanStatus = { status: "pending", reason: { code: "human_decision_required" } }, integration = { status: "not_integrated", reason: { code: "no_publication_requested" } };
  const summary = { candidate_fingerprint: fingerprint, coverage, posture: "findings", findings: [finding], merge_ready: false };
  const receipt = { schema: "flow.review-receipt/v1", review_id: recordId, candidate_fingerprint: fingerprint, lifecycle_generation: 1, review_authority_watermark: watermark, summary };
  const review = f.projection(reviewId);
  review.effects = [{ effect_id: effectId, run_id: reviewId, attempt_id: attemptId, idempotency_key: idempotencyKey, operation_contract: "flow.operation/review-record/v1", status: "succeeded", receipt: { provider_receipt: receipt } }];
  const record = { schema: "flow.review-projection/v1", contract: "work.review/v1", subject_id: recordId, source_run_id: reviewId,
    operation_contract: "flow.operation/review-record/v1", operation_effect_id: effectId, operation_attempt_id: attemptId, operation_idempotency_key: idempotencyKey,
    candidate: { candidate_id: candidateId }, candidate_fingerprint: fingerprint, lifecycle_generation: 1, candidate_authority_watermark: watermark,
    status: "automated_completed", current: true, evidence_currency: "current", summary, coverage, posture: "findings", findings: [finding],
    approval, human_status: humanStatus, integration, merge_ready: false, watermark };
  f.configure({ setup: false, owner_state: "stopped", projections: { [featureId]: producer, [reviewId]: review }, review_record: record });
  f.enableHistoryTransport(); writeFileSync(f.trace, "");
  const before = f.protectedTrees(), result = f.run(["--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 0, result.stdout + result.stderr);
  const inventory = JSON.parse(result.stdout), featureRow = inventory.attempts.find(item => item.run_id === featureId), reviewRow = inventory.attempts.find(item => item.run_id === reviewId);
  assert.ok(featureRow); assert.ok(reviewRow); assert.equal(reviewRow.kind, "review");
  assert.deepEqual(featureRow.separate_review_run_ids, [reviewId]); assert.equal(featureRow.candidate.id, candidateId);
  assert.equal(featureRow.checks.outcome, "passed"); assert.equal(featureRow.critique, "completed");
  assert.equal(reviewRow.producer_run_id, featureId); assert.equal(reviewRow.review.review_id, recordId);
  assert.equal(reviewRow.review.posture, "findings"); assert.equal(reviewRow.review.finding_count, 1); assert.equal(reviewRow.review.coverage.complete, true);
  assert.equal(reviewRow.checks.outcome, "passed"); assert.equal(reviewRow.checks.rerun, false);
  assert.deepEqual(reviewRow.review.approval, approval); assert.deepEqual(reviewRow.review.human_status, humanStatus); assert.deepEqual(reviewRow.review.integration, integration);
  const human = f.run(["--repository", f.repository]); f.assertReadOnly(before); assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /findings 1/u); assert.match(human.stdout, /human_decision_required/u); assert.doesNotMatch(human.stdout, /\[object Object\]/u);
});

test("outside client selection and profile aliases cannot execute commands or retarget retained state", linux, t => {
  const f = initializedInventory(t), outside = join(f.root, "outside-client"), marker = join(f.root, "outside-command-executed");
  mkdirSync(outside); writeFileSync(join(outside, "flow"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  let before = f.protectedTrees();
  const unknown = f.run(["--repository", f.repository, "--client", outside, "--json"]);
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr); assert.equal(existsSync(marker), false); f.assertReadOnly(before);
  const profile = join(f.setup.directory, "../../profile.json"), retained = join(f.root, "unrelated-owned-profile.json");
  writeFileSync(retained, readFileSync(profile)); rmSync(profile); symlinkSync(retained, profile);
  before = f.protectedTrees(); const alias = f.run(["--repository", f.repository, "--json"]);
  assert.equal(alias.status, 1, alias.stdout + alias.stderr);
  const value = JSON.parse(alias.stdout); assert.equal(value.complete, false); assert.ok(value.diagnostics.length);
  assert.equal(existsSync(marker), false); f.assertReadOnly(before);
});

function terminalInventory(f) {
  const driver = `import errno,json,os,pty,select,subprocess,sys,time
master,slave=pty.openpty();child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
output=bytearray();deadline=time.monotonic()+25;timed_out=False
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.1)[0]:
   try:chunk=os.read(master,65536)
   except OSError as error:
    if error.errno==errno.EIO:break
    raise
   if not chunk:break
   output.extend(chunk)
   if len(output)>262144:raise RuntimeError('terminal output limit')
  elif child.poll() is not None:break
 else:timed_out=True
finally:
 if child.poll() is None:child.kill()
 child.wait(timeout=5);os.close(master)
print(json.dumps(dict(exit=child.returncode,output=output.decode('utf-8','replace'),timed_out=timed_out)))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, cli, "runs", "--repository", f.repository])], {
    env: { ...f.env, TERM: "xterm-256color" }, cwd: f.root, encoding: "utf8", timeout: 35000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
}

test("real terminal overview is readable, escaped and noninteractive with original resume commands", linux, t => {
  const f = initializedInventory(t, { title: "Inspect \u001b[2Jsigned measurements" }), before = f.protectedTrees();
  const terminal = terminalInventory(f);
  f.assertReadOnly(before); assert.equal(terminal.timed_out, false); assert.equal(terminal.exit, 0, terminal.output);
  assert.ok(terminal.output.includes(f.setup.request)); assert.ok(terminal.output.includes(f.preview.confirmation_digest));
  assert.match(terminal.output, /prepared|confirmation/iu); assert.doesNotMatch(terminal.output, /\u001b\[2J/u);
  assert.match(terminal.output, /\\u001b|\\x1b/u); assert.doesNotMatch(terminal.output, /\[y\/N\]|Task number:|Choice number/u);
  t.diagnostic(`Controlled read-only terminal transcript:\n${terminal.output}`);
});
