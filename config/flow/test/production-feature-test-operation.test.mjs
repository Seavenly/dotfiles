import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as production from "../src/production-feature-operations.mjs";
import { digest, freezeCanonical } from "../../../tools/flow/src/canonical.mjs";
import { FEATURE_OPERATION_CONTRACTS, validateFeatureTestReceipt, validateFeatureVerificationReceipt } from "../../../tools/flow/src/feature-flow.mjs";

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "flow-feature-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-c", "diff.autoRefreshIndex=false", "-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Check Fixture"); git("config", "user.email", "check@example.test");
  writeFileSync(join(root, "feature.txt"), options.initial ?? "before\n");
  writeFileSync(join(root, "health.mjs"), options.health ?? 'import test from "node:test"; import assert from "node:assert/strict"; test("positive control", () => assert.equal(2 + 2, 4));\n');
  writeFileSync(join(root, "acceptance.mjs"), options.acceptance ?? 'import test from "node:test"; import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; test("desired behavior", () => assert.equal(readFileSync("feature.txt", "utf8"), "after\\n"));\n');
  git("add", "."); git("commit", "--quiet", "-m", "committed acceptance prerequisite");
  const facts = () => ({ ref: "refs/heads/main", commit_sha: git("rev-parse", "HEAD"), tree_sha: git("rev-parse", "HEAD^{tree}"), clean: git("status", "--porcelain") === "" });
  const workspace = { schema: "flow.feature-workspace-binding/v1", subject_id: "workspace:check", generation: 1, mutation_epoch: 1, fingerprint: digest({ git: facts() }), git: facts(), path: root };
  const brief = { schema: "flow.feature-brief/v1", id: "brief:check", summary: "Change feature output", acceptance: ["feature.txt contains after"] };
  const config = {
    schema: "flow.production-feature-test-check/v1", check_id: "check:feature",
    executable: { path: realpathSync(process.execPath), version: process.version, sha256: sha(readFileSync(process.execPath)) },
    health: { path: "health.mjs", sha256: sha(readFileSync(join(root, "health.mjs"))), case_name: "positive control" },
    acceptance: { path: "acceptance.mjs", sha256: sha(readFileSync(join(root, "acceptance.mjs"))), case_name: "desired behavior" },
    pinned_files: [], criteria: brief.acceptance,
    expected_failure: { code: "ERR_ASSERTION", operator: "strictEqual", expected: "after\n", actual: "before\n" },
    environment: { PATH: "/usr/bin:/bin" }, limits: { timeout_ms: options.timeout_ms ?? 2000, max_output_bytes: 64 * 1024 },
  };
  return { root, git, facts, workspace, brief, config };
}

test("registered committed check selection pins the real check without executing its probe", (t) => {
  const f = fixture(t);
  assert.equal(typeof production.resolveProductionFeatureTestSelection, "function");
  const selected = production.resolveProductionFeatureTestSelection({ checkId: f.config.check_id, brief: f.brief, workspace: f.workspace, featureTestCheck: f.config });
  assert.equal(selected.slice.mode, "test");
  assert.deepEqual(selected.slice.acceptance, f.brief.acceptance);
  assert.equal(selected.slice.test.environment_status, "healthy");
  assert.equal(selected.slice.test.environment_fingerprint, selected.checkBinding.fingerprint);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(JSON.stringify(selected).includes(f.root), false);
  assert.equal(f.git("status", "--porcelain"), "");
});

function operationFixture(t, options) {
  const f = fixture(t, options);
  const selected = production.resolveProductionFeatureTestSelection({ checkId: f.config.check_id, brief: f.brief, workspace: f.workspace, featureTestCheck: f.config });
  const { path: _path, ...binding } = f.workspace;
  const intent = { operation_contract: FEATURE_OPERATION_CONTRACTS.test, run_id: "run:check", card_id: `feature-slice-${selected.slice.id}-test`, attempt_id: "attempt:check", effect_id: "effect:check", idempotency_key: "key:check", source_authority_watermark: digest("source"), operation_input: { brief: f.brief, workspace: binding, slice: selected.slice, phase: "test_before" } };
  const registrations = production.createProductionFeatureOperations({
    resolveWorkspace: () => ({ path: f.root, repository_id: binding.git.repository_id, ref: binding.git.ref }),
    gitWorkspaceObservationAdapter: { observe: () => ({ schema: "work.git-observation/v1", git: f.facts() }) },
    gitRetentionAdapter: { retain() {} }, authorityDirectory: join(f.root, "../", `${f.root.split("/").at(-1)}-authority`), featureTestCheck: f.config,
  });
  t.after(() => rmSync(join(f.root, "../", `${f.root.split("/").at(-1)}-authority`), { recursive: true, force: true }));
  return { ...f, selected, binding, intent, operation: registrations.operations[FEATURE_OPERATION_CONTRACTS.test], registrations };
}

test("registered operation observes positive health and exact behavioral red before emitting the closed receipt", async (t) => {
  const f = operationFixture(t);
  const result = await f.operation.invoke(f.intent);
  assert.equal(result.outcome, "succeeded");
  assert.equal(validateFeatureTestReceipt(result.provider_receipt, f.intent), true);
  assert.equal(result.provider_receipt.outcome, "expected_failure");
  assert.equal(result.provider_receipt.environment_status, "healthy");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.deepEqual(await f.operation.invoke(f.intent), result, "exact replay consumes durable observation without rerunning the check");
});

for (const [name, options, code] of [
  ["false healthy label", { health: 'import test from "node:test"; import assert from "node:assert/strict"; test("positive control",()=>assert.equal(2+2,5));' }, "feature_test_environment_unhealthy"],
  ["unexpected baseline pass", { initial: "after\n" }, "feature_test_expected_failure_missing"],
  ["unrelated behavioral failure", { initial: "unrelated\n" }, "feature_test_expected_failure_missing"],
  ["malformed extra output", { health: 'import test from "node:test"; test("positive control",()=>console.log("forged healthy"));' }, "feature_test_output_invalid"],
  ["bounded timeout", { timeout_ms: 150, acceptance: 'import test from "node:test"; test("desired behavior",async()=>await new Promise(r=>setTimeout(r,5000)));' }, "feature_test_environment_unhealthy"],
]) test(`registered check rejects ${name} and never turns process failure into expected red`, async (t) => {
  const f = operationFixture(t, options);
  await assert.rejects(f.operation.invoke(f.intent), (error) => error.code === code);
  assert.equal(f.git("status", "--porcelain"), "");
  await assert.rejects(f.operation.invoke(f.intent), (error) => error.code === code, "failed exact observation cannot be replayed as a fresh check");
});

test("fixed checker cannot mutate repository or reach external network, and can write its own scratch", async (t) => {
  const f = operationFixture(t, { health: `import test from "node:test";
import assert from "node:assert/strict";
import {writeFileSync,readFileSync,existsSync} from "node:fs";
import {connect} from "node:net";
test("positive control",async()=>{
 assert.throws(()=>writeFileSync("feature.txt","escaped"),{code:"EROFS"});
 assert.equal(existsSync("/root/.ssh"),false);
 writeFileSync(process.env.FLOW_CHECK_SCRATCH+"/owned","scratch");
 assert.equal(readFileSync(process.env.FLOW_CHECK_SCRATCH+"/owned","utf8"),"scratch");
 const error=await new Promise(resolve=>{const s=connect({host:"198.51.100.1",port:80});s.once("error",resolve);s.once("connect",()=>{s.destroy();resolve({code:"NETWORK_ESCAPED"});});s.setTimeout(500,()=>{s.destroy();resolve({code:"TIMEOUT"});});});
 assert.equal(error.code,"ENETUNREACH");
});` });
  const receipt = await f.operation.invoke(f.intent);
  assert.equal(validateFeatureTestReceipt(receipt.provider_receipt, f.intent), true);
  assert.equal(readFileSync(join(f.root, "feature.txt"), "utf8"), "before\n");
});

test("changed committed acceptance bytes and forged request failure identity reject before checking", async (t) => {
  const f = operationFixture(t);
  const forged = structuredClone(f.intent); forged.operation_input.slice.test.intended_failure = "caller-fabricated expected red";
  await assert.rejects(f.operation.invoke(forged), { code: "feature_test_check_drift" });
  writeFileSync(join(f.root, "acceptance.mjs"), 'import test from "node:test"; test("desired behavior",()=>{});');
  f.git("add", "acceptance.mjs"); f.git("commit", "--quiet", "-m", "weakened check");
  await assert.rejects(f.operation.invoke(f.intent), { code: "feature_test_check_drift" });
});

function verificationIntent(f, red) {
  const slice = f.selected.slice;
  const selection = { schema: "flow.feature-test-selection/v1", slices: [{ id: slice.id, acceptance: slice.acceptance, ...slice.test }] };
  delete selection.slices[0].schema;
  const testSelection = { ...selection, fingerprint: digest(selection) };
  return { ...f.intent, operation_contract: FEATURE_OPERATION_CONTRACTS.verify, card_id: "feature-slice-verify", effect_id: "effect:verify", attempt_id: "attempt:verify", idempotency_key: "key:verify", operation_input: {
    brief: f.brief, workspace: f.binding, phase: "slice_verify", slice, test_selection: testSelection,
    operation_evidence_card_ids: [f.intent.card_id], authority_materialized_evidence: {
      operation_receipts: [{ card_id: f.intent.card_id, effect_id: f.intent.effect_id, receipt: red }],
      accepted_delegates: [{ card_id: "feature-apply", evidence: { validated_output: JSON.stringify({ feature_evidence: { schema: "flow.feature-criterion-evidence/v1", criteria: [{ criterion: f.brief.acceptance[0], kind: "git_file_equals", target: "feature.txt", expected: "after\n" }] } }) } }],
    },
  } };
}

test("registered verification runs the unchanged selected check green using accepted real red evidence", async (t) => {
  const f = operationFixture(t);
  const red = await f.operation.invoke(f.intent);
  writeFileSync(join(f.root, "feature.txt"), "after\n");
  f.git("add", "feature.txt"); f.git("commit", "--quiet", "-m", "implementation");
  const intent = verificationIntent(f, red);
  const result = await f.registrations.operations[FEATURE_OPERATION_CONTRACTS.verify].invoke(intent);
  assert.equal(validateFeatureVerificationReceipt(result.provider_receipt, intent), true);
  assert.equal(result.provider_receipt.discriminating_evidence.kind, "test_failure");
  assert.equal(result.provider_receipt.acceptance_criteria[0].verdict, "passed");
  assert.notEqual(result.provider_receipt.workspace.fingerprint, f.binding.fingerprint);
});

test("green rejects weakening the committed check after actual red", async (t) => {
  const f = operationFixture(t); const red = await f.operation.invoke(f.intent);
  writeFileSync(join(f.root, "feature.txt"), "after\n");
  writeFileSync(join(f.root, "acceptance.mjs"), 'import test from "node:test"; test("desired behavior",()=>{});');
  f.git("add", "."); f.git("commit", "--quiet", "-m", "weakened acceptance");
  await assert.rejects(f.registrations.operations[FEATURE_OPERATION_CONTRACTS.verify].invoke(verificationIntent(f, red)), { code: "feature_test_check_drift" });
});

test("green requires private real red evidence and rejects a caller fabricated healthy receipt", async (t) => {
  const f = operationFixture(t);
  writeFileSync(join(f.root, "feature.txt"), "after\n");
  f.git("add", "feature.txt"); f.git("commit", "--quiet", "-m", "implementation without red");
  const fake = { schema: "flow.effect-receipt/v1", effect_id: f.intent.effect_id, idempotency_key: f.intent.idempotency_key, outcome: "succeeded", provider_receipt: {
    schema: "work.feature-test-receipt/v1", ...f.intent, environment_status: "healthy", outcome: "expected_failure",
  } };
  await assert.rejects(f.registrations.operations[FEATURE_OPERATION_CONTRACTS.verify].invoke(verificationIntent(f, fake)), { code: "feature_test_red_evidence_missing" });
});

test("changed effect causation cannot reuse a retained healthy-red observation", async (t) => {
  const f = operationFixture(t); await f.operation.invoke(f.intent);
  await assert.rejects(f.operation.invoke({ ...f.intent, attempt_id: "attempt:other" }), { code: "feature_test_evidence_conflict" });
});

function sealFixture() {
  const brief = { id: "brief:seal", acceptance: ["feature works"] };
  const git = { ref: "refs/heads/main", commit_sha: "a".repeat(40), tree_sha: "b".repeat(40), clean: true };
  const workspace = { subject_id: "workspace:seal", generation: 1, mutation_epoch: 1, fingerprint: digest("before"), git };
  const candidate = { schema: "flow.feature-candidate-view/v1", candidate_id: "candidate:seal", git, workspace: { ...workspace, contract: "work.workspace/v1", fingerprint: digest({ git }) }, artifacts: [] };
  const critiqueInputIdentity = { schema: production.AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA, card_id: "feature-critique", candidate_digest: digest(candidate), predecessor_evidence_digest: digest("predecessors") };
  const criterion = { criterion: brief.acceptance[0], evidence: { kind: "git_file_equals", target: "feature.txt", expected: "after\n" }, verdict: "passed" };
  const critique = { schema: production.FEATURE_CRITIQUE_OUTPUT_SCHEMA, candidate_digest: critiqueInputIdentity.candidate_digest, predecessor_evidence_digest: critiqueInputIdentity.predecessor_evidence_digest, task_inputs_digest: digest("task"), findings: [], criteria: [{ ...criterion, evidence_digest: digest(criterion) }] };
  const testSelection = { schema: "flow.feature-test-selection/v1", fingerprint: digest("selection"), slices: [] };
  const entry = (cardId, independent) => {
    const identity = { schema: "work.feature-verification-receipt/v1", brief_id: brief.id, operation_contract: FEATURE_OPERATION_CONTRACTS.verify, effect_id: `effect:${cardId}`, attempt_id: `attempt:${cardId}`, idempotency_key: `key:${cardId}`, source_authority_watermark: digest(cardId), selected_evidence_fingerprint: testSelection.fingerprint, workspace: { ...workspace, fingerprint: digest({ git }) }, acceptance_criteria: [{ criterion: brief.acceptance[0], verdict: "passed", evidence_digest: digest("green") }], discriminating_evidence: { schema: "flow.feature-discriminating-evidence/v1", kind: "test_failure", selected_fingerprint: testSelection.fingerprint, post_mutation_fingerprint: digest({ git }), distinguished: true, test_failures: [] }, ...(independent ? { independent_critique_digest: digest(critique) } : {}) };
    const providerReceipt = { ...identity, receipt_digest: digest(identity), self_digest: digest(identity) };
    return { card_id: cardId, effect_id: identity.effect_id, attempt_id: identity.attempt_id, idempotency_key: identity.idempotency_key, source_authority_watermark: identity.source_authority_watermark, receipt: { schema: "flow.effect-receipt/v1", effect_id: identity.effect_id, idempotency_key: identity.idempotency_key, outcome: "succeeded", provider_receipt: providerReceipt } };
  };
  const slice = entry("feature-slice-check-verify", false);
  const final = entry("feature-verify", true);
  const intent = { operation_contract: FEATURE_OPERATION_CONTRACTS.seal, effect_id: "effect:seal", attempt_id: "attempt:seal", idempotency_key: "key:seal", source_authority_watermark: digest("seal"), operation_input: { brief, workspace, phase: "seal", independent_critique: true, test_selection: testSelection, publication: {}, authority_materialized_candidate: candidate, authority_materialized_critique_binding: { card_id: "feature-critique" }, authority_materialized_critique_input: { ...critiqueInputIdentity, binding_digest: digest(critiqueInputIdentity) }, authority_materialized_evidence: { operation_receipts: [slice, final], accepted_delegates: [{ card_id: "feature-critique", evidence: { validated_output: JSON.stringify(freezeCanonical({ schema: "flow.delegate-evidence/v1", observation: "independent critique", feature_critique: critique })) } }] } } };
  intent.operation_input.authority_materialized_result_bindings = [{ producer_card_id: "feature-verify", output_contract: "verification_receipt", expected_schema: "work.feature-verification-receipt/v1", observed_schema: "work.feature-verification-receipt/v1", attempt_id: final.attempt_id, provenance: { effect_id: final.effect_id, attempt_id: final.attempt_id, idempotency_key: final.idempotency_key, source_authority_watermark: final.source_authority_watermark }, content: final.receipt.provider_receipt, content_digest: digest(final.receipt.provider_receipt) }];
  let retentions = 0;
  const registrations = production.createProductionFeatureOperations({ resolveWorkspace: () => ({ path: "/unused", repository_id: "repo:seal" }), gitWorkspaceObservationAdapter: { observe() { throw new Error("seal must use materialized evidence"); } }, gitRetentionAdapter: { retain() { retentions += 1; return { retained: true }; } } });
  return { intent, slice, final, operation: registrations.operations[FEATURE_OPERATION_CONTRACTS.seal], retentions: () => retentions };
}

test("seal joins the explicit final verification when a slice verification precedes it", async () => {
  for (const reverse of [false, true]) {
    const f = sealFixture();
    if (reverse) f.intent.operation_input.authority_materialized_evidence.operation_receipts.reverse();
    const result = await f.operation.invoke(f.intent);
    assert.deepEqual(result.provider_receipt.review_candidate.verification, f.final.receipt.provider_receipt);
    assert.equal(f.retentions(), 1);
  }
});

test("seal rejects missing, ambiguous, malformed or misbound final verification before retention", async () => {
  for (const kind of ["missing", "ambiguous", "malformed", "misbound", "ambiguous binding", "malformed collection", "malformed bindings", "wrong candidate"]) {
    const f = sealFixture();
    const receipts = f.intent.operation_input.authority_materialized_evidence.operation_receipts;
    if (kind === "missing") receipts.pop();
    if (kind === "ambiguous") receipts.push(structuredClone(f.final));
    if (kind === "malformed") f.final.receipt.provider_receipt.attempt_id = "attempt:wrong";
    if (kind === "misbound") f.intent.operation_input.authority_materialized_result_bindings[0].provenance.effect_id = "effect:wrong";
    if (kind === "ambiguous binding") f.intent.operation_input.authority_materialized_result_bindings.push(structuredClone(f.intent.operation_input.authority_materialized_result_bindings[0]));
    if (kind === "malformed collection") f.intent.operation_input.authority_materialized_evidence.operation_receipts = {};
    if (kind === "malformed bindings") f.intent.operation_input.authority_materialized_result_bindings = {};
    if (kind === "wrong candidate") f.intent.operation_input.authority_materialized_candidate.git = { ...f.intent.operation_input.authority_materialized_candidate.git, commit_sha: "c".repeat(40) };
    await assert.rejects(f.operation.invoke(f.intent), { code: "feature_seal_verification_invalid" });
    assert.equal(f.retentions(), 0, kind);
  }
});

// The public checker-window takeover test exercises real authority adoption.
test("adoption fence fields preserve the same actual retired check evidence", async (t) => {
  const f = operationFixture(t);
  const original = { ...f.intent, authority_epoch: 1, authority_boot_id: "boot:same" };
  const actual = await f.operation.invoke(original);
  const adopted = { ...original, authority_epoch: 2 };
  assert.deepEqual(await f.operation.invoke(adopted), actual);
  for (const [key, value] of [["run_id", "run:other"], ["attempt_id", "attempt:other"], ["source_authority_watermark", digest("other")]]) {
    await assert.rejects(f.operation.invoke({ ...adopted, [key]: value }), { code: "feature_test_evidence_conflict" });
  }
});

test("an adopted intent with a live retained worker stays unknown and never creates a second checker", async (t) => {
  const f = operationFixture(t, { timeout_ms: 3000, health: 'import test from "node:test"; import assert from "node:assert/strict"; test("positive control", async () => { await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(2 + 2, 4); });\n' });
  const original = { ...f.intent, authority_epoch: 1, authority_boot_id: "boot:same" };
  const pending = f.operation.invoke(original);
  const checks = join(f.root, "../", `${f.root.split("/").at(-1)}-authority`, "feature-test-checks");
  const roots = readdirSync(checks);
  assert.equal(roots.length, 1);
  const reservation = readFileSync(join(checks, roots[0], "reservation.json"));
  await assert.rejects(f.operation.invoke({ ...original, authority_epoch: 2 }), { code: "feature_test_outcome_unknown" });
  assert.deepEqual(readdirSync(checks), roots);
  assert.deepEqual(readFileSync(join(checks, roots[0], "reservation.json")), reservation);
  const result = await pending;
  const terminal = readFileSync(join(checks, roots[0], "terminal.json"));
  assert.equal(JSON.parse(terminal).retired, true);
  assert.equal(JSON.parse(terminal).proof, "linux_subreaper_echild");
  assert.deepEqual(await f.operation.invoke({ ...original, authority_epoch: 2 }), result);
  assert.deepEqual(readFileSync(join(checks, roots[0], "terminal.json")), terminal);
});

test("a stale accepted-red temp cannot poison exact retired-terminal adoption", async (t) => {
  const f = operationFixture(t);
  const original = { ...f.intent, authority_epoch: 1, authority_boot_id: "boot:same" };
  const result = await f.operation.invoke(original);
  const checks = join(f.root, "../", `${f.root.split("/").at(-1)}-authority`, "feature-test-checks");
  const roots = readdirSync(checks);
  assert.equal(roots.length, 1);
  const root = join(checks, roots[0]);
  const reservation = readFileSync(join(root, "reservation.json"));
  const terminal = readFileSync(join(root, "terminal.json"));
  assert.equal(JSON.parse(terminal).retired, true);
  const stale = Buffer.from('{"intent":');
  writeFileSync(join(root, "accepted-red.json.new"), stale, { flag: "wx", mode: 0o600 });
  assert.deepEqual(await f.operation.invoke({ ...original, authority_epoch: 2 }), result);
  assert.deepEqual(readFileSync(join(root, "accepted-red.json.new")), stale);
  assert.deepEqual(readFileSync(join(root, "reservation.json")), reservation);
  assert.deepEqual(readFileSync(join(root, "terminal.json")), terminal);
  assert.deepEqual(readdirSync(checks), roots);
  t.diagnostic(JSON.stringify({
    same_effect: original.effect_id,
    original_epoch: original.authority_epoch,
    adopted_epoch: 2,
    checker_roots: roots.length,
    reservation_sha256: sha(reservation),
    terminal_sha256: sha(terminal),
    stale_sha256: sha(stale),
    retirement_proof: JSON.parse(terminal).proof,
    terminal_retired: JSON.parse(terminal).retired,
  }));
});
