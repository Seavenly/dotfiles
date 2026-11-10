import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { digest } from "../../../tools/flow/src/canonical.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT as trust } from "../src/supervised-native-trust.mjs";

const selectedRun = `run:${"a".repeat(64)}`, separateReview = `run:${"b".repeat(64)}`;
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function snapshot(root) {
  const rows = {};
  const visit = (path, relative) => {
    const stat = lstatSync(path), row = { mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) row.link = readlinkSync(path);
    else if (stat.isFile()) row.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    else if (stat.isDirectory()) {
      row.type = "directory"; rows[relative] = row;
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    } else row.type = "other";
    rows[relative] = row;
  };
  visit(root, "."); return rows;
}

function privateUsage(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-usage-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "state", "config"]) mkdirSync(join(root, name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FLOW_") && !name.startsWith("DOTFILES_") && !["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const run = args => spawnSync(process.execPath, [cli, "usage", ...args], { env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  return { root, env, run };
}

test("public usage help describes run-scoped read-only measurements without creating state", t => {
  const f = privateUsage(t), before = snapshot(f.root), result = f.run(["--help"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /flow-supervised usage/u);
  assert.match(result.stdout, /--run/u);
  assert.match(result.stdout, /read.only|no owner|without start/iu);
});


test("usage requires an exact run and refuses lifecycle-shaped arguments without writing state", t => {
  const f = privateUsage(t), before = snapshot(f.root);
  for (const args of [[], ["--run", selectedRun, "--confirm", "sha256:unused"], ["--run", selectedRun, "--cancel", selectedRun]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr); assert.deepEqual(snapshot(f.root), before);
  }
});

// This fixture materializes the real generated-client format through its pure
// writer. Static identities and a reduced query transport prove frontend reads,
// never native compatibility, an authority database or lifecycle execution.
function recordedUsage(t) {
  const f = privateUsage(t), repository = join(f.root, "project"), runtime = join(f.root, "original-runtime");
  mkdirSync(repository); execFileSync("/usr/bin/git", ["init", "-q", repository], { env: f.env });
  mkdirSync(join(runtime, "config/flow/src"), { recursive: true });
  const state = f.env.XDG_STATE_HOME, profile = join(state, "flow-local", digest(repository).slice(7, 31));
  const directory = join(profile, "clients", "verify"), authority = join(profile, "authority");
  mkdirSync(join(directory, "requests", "existing"), { recursive: true }); mkdirSync(join(directory, "receipts")); mkdirSync(authority);
  const versionMarker = join(f.root, "version-command-executed"), executable = join(f.root, "never-execute-codex");
  writeFileSync(executable, `#!/bin/sh\nprintf unexpected > '${versionMarker}'\nexit 99\n`, { mode: 0o700 });
  const gitIdentity = { author: { name: "Usage fixture", email: "usage@example.invalid" }, committer: { name: "Usage fixture", email: "usage@example.invalid" } };
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtime, node: realpathSync(process.execPath),
    executable: { path: executable, sha256: `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}` }, execution_trust: trust, git_identity: gitIdentity };
  const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  save(join(profile, "profile.json"), { identity, initial_check_digest: null });
  const generated = writeFeatureClient({ directory, runtimeRoot: runtime, workspace: repository, executionTrust: "supervised-native-cli", codexExecutable: executable,
    localStateHome: state, authorityDirectory: authority, gitIdentity });
  save(join(directory, "pilot.json"), { directory, runtime_root: runtime, ...generated, local_client: identity, execution_trust: trust });
  save(join(directory, "requests/existing/prepare-request.json"), { schema: "flow.feature-preparation-request/v1", repository, execution_trust: trust,
    brief: { schema: "flow.feature-brief/v1", id: "usage-fixture", summary: "Inspect existing measurements", acceptance: ["Measurements remain ordered"] }, mode: "verify" });
  // The regular presence sentinel selects stopped query transport only. No
  // SQLite file is opened and no real authority or owner receives this marker.
  writeFileSync(join(authority, "authority.sqlite"), "Controlled original-client query transport only.\n");
  const inputs = join(f.root, "query-inputs.json"), trace = join(f.root, "query-trace.jsonl"), forbidden = join(f.root, "forbidden-lifecycle");
  const projection = id => ({ schema: "flow.run-projection/v1", run_id: id, phase: "succeeded", sequence: 1, watermark: { stream: id, sequence: 1 },
    cards: [], effects: [], resource_dispositions: [], active_plan: { cards: [] }, private_note: "owned-synthetic-private-note" });
  const config = { [selectedRun]: projection(selectedRun), [separateReview]: projection(separateReview) };
  const configure = values => { Object.assign(config, values); save(inputs, config); };
  configure({}); writeFileSync(trace, "");
  writeFileSync(join(runtime, "config/flow/src/cli.mjs"), `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
if(!['query','status'].includes(args[0])){writeFileSync(${JSON.stringify(forbidden)},JSON.stringify(args));throw Error('Lifecycle command forbidden in usage fixture');}
const runs=JSON.parse(readFileSync(${JSON.stringify(inputs)}));let result;
if(args[0]==='status')result={schema:'flow.owner-status/v1',state:'stopped'};
else{const query=JSON.parse(args[args.indexOf('--input')+1]??'{}');result=query.run_id?runs[query.run_id]??{schema:'flow.rejection/v1',code:'unknown_run'}:{schema:'flow.run-index-projection/v1',authority_schema:{status:'compatible'},runs:Object.keys(runs).sort(),watermark:{stream:'runs',sequence:1}};}
process.stdout.write(JSON.stringify(result)+'\\n');
`);
  const protectedTrees = () => ({ repository: snapshot(repository), state: snapshot(state), runtime: snapshot(runtime), home: snapshot(f.env.HOME), configuration: snapshot(f.env.XDG_CONFIG_HOME), inputs: snapshot(inputs), executable: snapshot(executable) });
  const calls = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const assertReadOnly = before => {
    assert.deepEqual(protectedTrees(), before); assert.equal(readFileSync(trace, "utf8").includes('"start"'), false);
    assert.ok(calls().every(args => ["query", "status"].includes(args[0])));
    for (const path of [forbidden, versionMarker]) assert.equal(existsSync(path), false);
  };
  return { ...f, repository, runtime, directory, authority, config, configure, projection, trace, calls, protectedTrees, assertReadOnly, save };
}

test("unknown exact runs and outside clients refuse without lifecycle work or replacement state", t => {
  const f = recordedUsage(t), outside = join(f.root, "outside-client"), marker = join(f.root, "outside-command-executed");
  mkdirSync(outside); writeFileSync(join(outside, "flow"), `#!/bin/sh\nprintf unexpected > '${marker}'\n`, { mode: 0o700 });
  let before = f.protectedTrees();
  const unknownClient = f.run(["--run", selectedRun, "--repository", f.repository, "--client", outside, "--json"]);
  assert.equal(unknownClient.status, 2, unknownClient.stdout + unknownClient.stderr); assert.equal(existsSync(marker), false); f.assertReadOnly(before);
  f.configure({ [selectedRun]: { schema: "flow.rejection/v1", code: "unknown_run" } });
  before = f.protectedTrees(); const unknownRun = f.run(["--run", selectedRun, "--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(unknownRun.status, 1, unknownRun.stdout + unknownRun.stderr);
  const report = JSON.parse(unknownRun.stdout); assert.equal(report.schema, "flow.project-usage/v1");
  assert.equal(report.root_run_id, selectedRun); assert.equal(report.complete, false); assert.ok(report.diagnostics.length);
});

function recordCodexAttempt(f) {
  const attemptId = `${selectedRun}:feature-apply:attempt:1`, effectId = "effect:usage-writer", cardId = "feature-apply";
  const taskId = `task:${createHash("sha256").update(attemptId).digest("hex")}`;
  const directory = join(f.authority, "direct-tasks", taskId.slice(5)); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hashBytes = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const input = "Owned synthetic input; private-input-marker must not be rendered.\n";
  const output = [
    { type: "thread.started", thread_id: "fixture-session", private_field: "private-event-marker" },
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 }, private_field: "private-usage-marker" },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const outputContract = { schema: {} }, identity = { schema: "flow.task-invocation/v1", task_id: taskId, caller_key: attemptId,
    run_id: selectedRun, card_id: cardId, attempt_id: attemptId, effect_id: effectId, input_sha256: hashBytes(input),
    description: { backend: { contract: "flow.direct-task/v1", id: "direct", harness: "codex", executable: { version: "codex-cli 0.166.0" } }, launch: { model: "gpt-6.1-sol" } },
    output_contract: outputContract, output_schema_bytes: "{}", output_contract_digest: digest(outputContract), process_containment: "linux_subreaper" };
  const descriptor = { ...identity, descriptor_digest: digest(identity) };
  const worker = { schema: "flow.task-process/v1", descriptor_digest: descriptor.descriptor_digest, containment: "linux_subreaper",
    identity: { pid: 123, start: "1", boot: "fixture", group: 123 }, child: { pid: 124, start: "2", boot: "fixture", group: 124 } };
  const terminal = { schema: "flow.task-terminal-receipt/v1", descriptor_digest: descriptor.descriptor_digest, input_sha256: descriptor.input_sha256,
    stdout_sha256: hashBytes(output), stderr_sha256: hashBytes(""), tree_retired: true, worker_identity: worker.identity, child_identity: worker.child, exit_code: 0, cancelled: false };
  f.save(join(directory, "descriptor.json"), descriptor); f.save(join(directory, "worker.json"), worker); f.save(join(directory, "receipt.json"), terminal);
  writeFileSync(join(directory, "input.bin"), input, { mode: 0o600 }); writeFileSync(join(directory, "output-schema.json"), "{}", { mode: 0o600 });
  writeFileSync(join(directory, "stdout.bin"), output, { mode: 0o600 }); writeFileSync(join(directory, "stderr.bin"), "", { mode: 0o600 });
  const proof = { schema: "flow.task-settlement-proof/v1", classification: "exact_task_correlation", descriptor_digest: descriptor.descriptor_digest,
    input_sha256: descriptor.input_sha256, output_contract_digest: descriptor.output_contract_digest, stdout_sha256: terminal.stdout_sha256,
    terminal_receipt_digest: digest(terminal), native_session: "fixture-session" };
  const effect = { effect_kind: "delegate", run_id: selectedRun, card_id: cardId, attempt_id: attemptId, effect_id: effectId,
    invocation_started: true, status: "succeeded", receipt: { provider_receipt: { turn_id: taskId,
      settlement_proof: { ...proof, record_sha256: digest(proof) }, terminal_disposition: { resource: { type: "direct_task", id: taskId }, terminal_receipt_digest: digest(terminal), retired: true } } } };
  const run = { ...f.projection(selectedRun), effects: [effect], subruns: [] };
  f.configure({ [selectedRun]: run });
  return { directory, taskId, attemptId, descriptor, terminal };
}

test("public usage reports exact recorded metrics and unknown billing without including a separate review or private payload", t => {
  const f = recordedUsage(t), task = recordCodexAttempt(f), before = f.protectedTrees();
  const result = f.run(["--run", selectedRun, "--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.schema, "flow.project-usage/v1"); assert.equal(report.root_run_id, selectedRun);
  assert.equal(report.complete, true); assert.equal(report.observation, "inspect_only"); assert.equal(report.attempts.length, 1);
  const attempt = report.attempts[0]; assert.equal(attempt.run_id, selectedRun); assert.equal(attempt.task_id, task.taskId); assert.equal(attempt.attempt_id, task.attemptId);
  assert.equal(attempt.harness, "codex"); assert.equal(attempt.model.requested, "gpt-6.1-sol"); assert.equal(attempt.model.reported, null);
  assert.equal(attempt.status, "reported");
  assert.deepEqual(attempt.metrics, { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, turns: 1 });
  assert.equal(report.cost.billing, null); assert.equal(report.cost.pricing_date, null); assert.equal(report.cost.pricing_table_version, null); assert.equal(report.cost.known_list_cost_usd, null);
  assert.ok(attempt.provenance.stdout_sha256); assert.ok(attempt.provenance.terminal_receipt_digest);
  assert.doesNotMatch(result.stdout, /private-(?:input|event|usage)-marker|owned-synthetic-private-note/u);
  assert.ok(f.calls().every(args => !args.join(" ").includes(separateReview)));
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test("missing recorded output remains unavailable rather than invented zero usage or exact billing", t => {
  const f = recordedUsage(t), task = recordCodexAttempt(f); rmSync(join(task.directory, "stdout.bin"));
  const before = f.protectedTrees(), result = f.run(["--run", selectedRun, "--repository", f.repository, "--json"]);
  f.assertReadOnly(before); assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.complete, false); assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].status, "unavailable"); assert.equal(report.attempts[0].metrics.input_tokens, null);
  assert.equal(report.cost.billing, null); assert.equal(report.cost.known_list_cost_usd, null); assert.ok(report.diagnostics.length);
});

function terminalUsage(f) {
  const driver = `import errno,json,os,pty,select,subprocess,sys,time
master,slave=pty.openpty();child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
output=bytearray();deadline=time.monotonic()+20;timed_out=False
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
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", driver, JSON.stringify([process.execPath, cli, "usage", "--repository", f.repository, "--run", selectedRun])], {
    env: { ...f.env, TERM: "xterm-256color" }, cwd: f.root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
}

test("actual terminal usage is readable, historical and noninteractive with billing honestly unknown", t => {
  const f = recordedUsage(t); recordCodexAttempt(f); const before = f.protectedTrees(), terminal = terminalUsage(f);
  f.assertReadOnly(before); assert.equal(terminal.exit, 0, terminal.output); assert.equal(terminal.timed_out, false);
  assert.ok(terminal.output.includes(selectedRun)); assert.match(terminal.output, /codex/u); assert.match(terminal.output, /gpt-6\.1-sol/u);
  for (const metric of ["100", "60", "20"]) assert.ok(terminal.output.includes(metric), terminal.output);
  assert.match(terminal.output, /historical|inspect.only/iu); assert.match(terminal.output, /billing[^\r\n]*(?:unknown|unavailable|not reported|not available)/iu);
  assert.doesNotMatch(terminal.output, /\[y\/N\]|Choice number|private-(?:input|event|usage)-marker/u);
  t.diagnostic(`Controlled read-only usage terminal transcript:\n${terminal.output}`);
});
