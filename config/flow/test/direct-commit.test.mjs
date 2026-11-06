import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import fs, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createProductionDirectCommitOperation } from "../src/production-direct-commit.mjs";
import { attachWorkAuthorities } from "../../../tools/flow/src/work-authority.mjs";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { dispatchRegisteredEffect } from "../../../tools/flow/src/operation-effects.mjs";
import { FEATURE_DIRECT_COMMIT_CONTRACT } from "../../../tools/flow/src/feature-flow.mjs";

async function fixture(t, onBoundary, { globalIdentity = false, attributes = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flow-direct-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository"); await mkdir(repository);
  const home = join(root, "home"); await mkdir(join(home, ".config", "dotfiles"), { recursive: true });
  await writeFile(join(home, ".gitconfig"), globalIdentity ? await readFile(new URL("../../git/config", import.meta.url)) : "", { mode: 0o600 });
  if (globalIdentity) await writeFile(join(home, ".config", "dotfiles", "git.local"), '[user]\n name = Private Global Fixture\n email = private-global@example.test\n', { mode: 0o600 });
  const env = { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const git = (args) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repository, ...args], { encoding: "utf8", env }).trim();
  git(["init", "--quiet", "--initial-branch", "main"]);
  if (!globalIdentity) { git(["config", "user.name", "Flow Fixture"]); git(["config", "user.email", "flow@example.test"]); }
  await writeFile(join(repository, "feature.txt"), "before\n");
  if (attributes !== null) await writeFile(join(repository, ".gitattributes"), attributes);
  git(["add", "."]); git(["commit", "--quiet", "-m", "initial"]);
  const initial = git(["rev-parse", "HEAD"]);
  const facts = { clean: true, ref: "refs/heads/main", commit_sha: initial, tree_sha: git(["rev-parse", "HEAD^{tree}"]) };
  const workspace = { subject_id: "workspace:fixture", generation: 1, mutation_epoch: 0, fingerprint: digest({ git: facts }), git: facts };
  const current = { ...workspace, claims: [{ holder: "run:fixture", operations: ["feature-direct-commit"] }] };
  const run = { capability_bindings: [{ capability: "repository:write", card_ids: ["feature-direct-commit"] }] };
  const authority = { query: () => run };
  attachWorkAuthorities(authority, { workspace: { schema: "work.workspace-authority/v1", query: () => current },
    artifact: { schema: "work.artifact-authority/v1" }, review: { schema: "work.review-authority/v1" }, handoff: { schema: "flow.resource-handoff-authority/v1" } });
  const options = { resolveWorkspace: () => ({ path: repository }), authorityDirectory: join(root, "authority"), authority: () => authority, onBoundary, env };
  const intent = { run_id: "run:fixture", card_id: "feature-direct-commit", attempt_id: "attempt:fixture", effect_id: "effect:fixture", idempotency_key: "commit:fixture",
    operation_input: { workspace, permitted_paths: ["."], authority_materialized_result_bindings: [{ producer_card_id: "feature-apply", content: {
      settlement_proof: { schema: "flow.task-settlement-proof/v1" }, terminal_disposition: { proof: "linux_subreaper_echild" } } }] } };
  await writeFile(join(repository, "feature.txt"), "after\n");
  return { root, home, repository, git, initial, current, run, intent, options, operation: createProductionDirectCommitOperation(options) };
}

for (const output of ["paths", "attributes"]) test(`direct commit accepts more than 1 MiB of ${output} from an ordinary repository`, async (t) => {
  const f = await fixture(t, undefined, { attributes: output === "attributes" ? "* text=auto eol=lf\n" : null });
  const prefix = "file-" + "x".repeat(output === "paths" ? 180 : 90);
  for (let index = 0; index < 6000; index += 1) writeFileSync(join(f.repository, `${prefix}-${index}.txt`), "fixture\n");
  const inspect = (args, options = {}) => execFileSync("/usr/bin/git", ["-C", f.repository, ...args], {
    env: f.options.env, maxBuffer: 64 * 1024 * 1024, ...options,
  });
  const paths = inspect(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const attributes = inspect(["check-attr", "--all", "-z", "--stdin"], { input: paths });
  assert.ok((output === "paths" ? paths : attributes).length > 1024 * 1024);
  if (output === "attributes") assert.ok(paths.length < 1024 * 1024, "attribute expansion is a separate bound");
  t.diagnostic(JSON.stringify({ root: f.root, path_bytes: paths.length, attribute_bytes: attributes.length }));
  const receipt = await f.operation.invoke(f.intent);
  assert.equal(receipt.outcome, "succeeded");
  assert.notEqual(receipt.provider_receipt.commit_sha, f.initial);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(f.git(["show", `HEAD:${prefix}-5999.txt`]), "fixture");
  const recovered = createProductionDirectCommitOperation(f.options).reconcile(f.intent);
  assert.equal(recovered.presence, "present");
  assert.equal(recovered.provider_observation.commit_sha, receipt.provider_receipt.commit_sha);
});

async function dispatchedFailure(f) {
  const intent = { ...f.intent, operation_contract: FEATURE_DIRECT_COMMIT_CONTRACT, classification: "reconcilable" };
  return new Promise((resolve) => dispatchRegisteredEffect(intent, { [FEATURE_DIRECT_COMMIT_CONTRACT]: f.operation }, {
    async invokeEffect(effectiveIntent, { invoke }) {
      try { await invoke(effectiveIntent); resolve(null); }
      catch (error) { resolve(error.provider_observation); }
    },
  }));
}

for (const command of ["ls-files", "check-attr"]) for (const code of ["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
  test(`direct commit rejects bounded ${command} overflow ${code} before mutation with a safe public diagnostic`, async (t) => {
    const f = await fixture(t);
    const objects = f.git(["count-objects", "-v"]), index = await readFile(join(f.repository, ".git", "index"));
    const original = childProcess.execFileSync;
    const mock = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
      if (args.includes(command)) throw Object.assign(new Error("private injected process detail"), { code });
      return original(file, args, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.operation.invoke(f.intent), { code: "candidate_commit_repository_too_large" });
      const failure = await dispatchedFailure(f);
      assert.equal(failure.status, "operation_failure");
      assert.equal(failure.rejection_code, "candidate_commit_repository_too_large");
      assert.equal(failure.provider_detail.rejection_code, "candidate_commit_repository_too_large");
      assert.ok(!JSON.stringify(failure).includes("private injected process detail"));
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await assert.rejects(readdir(join(f.options.authorityDirectory, "candidate-commits")), { code: "ENOENT" });
    assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
    assert.equal(f.git(["count-objects", "-v"]), objects);
    assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
    assert.equal(f.operation.reconcile(f.intent).presence, "indeterminate");
    assert.equal(f.operation.reconcile(f.intent).provider_observation.reason, "commit_record_missing");
  });
}

for (const command of ["ls-files", "check-attr"]) test(`direct commit keeps ${command} overflow during exact-record observation indeterminate`, async (t) => {
  const f = await fixture(t);
  const receipt = await f.operation.invoke(f.intent);
  const objects = f.git(["count-objects", "-v"]), index = await readFile(join(f.repository, ".git", "index"));
  const original = childProcess.execFileSync;
  const mock = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (args.includes(command)) throw Object.assign(new Error("private injected process detail"), { code: "ENOBUFS" });
    return original(file, args, options);
  });
  syncBuiltinESMExports();
  try {
    const observed = f.operation.reconcile(f.intent);
    assert.equal(observed.presence, "indeterminate");
    assert.equal(observed.causation, null);
    assert.equal(observed.provider_observation.rejection_code, "candidate_commit_repository_too_large");
    assert.ok(!JSON.stringify(observed).includes("private injected process detail"));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(f.git(["rev-parse", "HEAD"]), receipt.provider_receipt.commit_sha);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
  assert.equal(f.operation.reconcile(f.intent).presence, "present");
});

test("direct commit does not misclassify a non-overflow enumeration failure", async (t) => {
  const f = await fixture(t);
  const original = childProcess.execFileSync;
  const failure = Object.assign(new Error("injected Git I/O failure"), { code: "EIO" });
  const mock = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (args.includes("ls-files")) throw failure;
    return original(file, args, options);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.operation.invoke(f.intent), (error) => error === failure); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(readdir(join(f.options.authorityDirectory, "candidate-commits")), { code: "ENOENT" });
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
});

test("direct commit preserves private global-only author and committer identity", async (t) => {
  const f = await fixture(t, undefined, { globalIdentity: true });
  assert.throws(() => f.git(["config", "--local", "--get", "user.name"]));
  assert.throws(() => f.git(["config", "--local", "--get", "user.email"]));
  assert.equal((await f.operation.invoke(f.intent)).outcome, "succeeded");
  assert.deepEqual(f.git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"]).split("\0"), ["Private Global Fixture", "private-global@example.test", "Private Global Fixture", "private-global@example.test"]);
});

for (const boundary of ["after_ref_cas", "before_index_publish"]) test(`direct commit fences real concurrent staging at final index publication ${boundary}`, async (t) => {
  let f, staged = false, lockError;
  f = await fixture(t, (stage) => {
    if (stage !== boundary) return;
    writeFileSync(join(f.repository, "feature.txt"), "concurrent selected\n");
    try { f.git(["add", "feature.txt"]); staged = true; assert.equal(f.git(["show", ":feature.txt"]), "concurrent selected"); }
    catch (error) { lockError = error; }
    finally { writeFileSync(join(f.repository, "feature.txt"), "after\n"); }
  });
  let result, failure;
  try { result = await f.operation.invoke(f.intent); } catch (error) { failure = error; }
  if (staged) {
    assert.equal(f.git(["show", ":feature.txt"]), "concurrent selected", "publication must preserve a completed concurrent staged selection");
    assert.match(failure?.message ?? "", /candidate_commit_(git_fence_changed|outcome_uncertain)/u);
  } else {
    assert.match(lockError?.message ?? "", /index\.lock/u);
    assert.equal(result?.outcome, "succeeded");
    assert.equal(f.git(["show", ":feature.txt"]), "after");
  }
});

test("direct commit freezes configured roles and ignores ambient author overrides", async (t) => {
  let f;
  f = await fixture(t, (stage) => {
    if (stage === "before_ref_cas") {
      f.git(["config", "--global", "author.name", "Later Author"]);
      f.git(["config", "--global", "committer.email", "later@example.test"]);
    }
  }, { globalIdentity: true });
  f.git(["config", "--global", "author.name", "Approved Author"]);
  f.git(["config", "--global", "author.email", "author@example.test"]);
  f.git(["config", "--global", "committer.name", "Approved Committer"]);
  f.git(["config", "--global", "committer.email", "committer@example.test"]);
  f.options.env.GIT_AUTHOR_NAME = "Unapproved Ambient Author";
  f.options.env.GIT_COMMITTER_EMAIL = "ambient@example.test";
  const receipt = await f.operation.invoke(f.intent);
  assert.deepEqual(f.git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"]).split("\0"), ["Approved Author", "author@example.test", "Approved Committer", "committer@example.test"]);
  const recovered = createProductionDirectCommitOperation({ ...f.options, onBoundary: undefined });
  assert.equal(recovered.reconcile(f.intent).presence, "present");
  assert.deepEqual(await recovered.invoke(f.intent), receipt);
});

for (const value of ["", "Unusable\nAuthor", "Unusable <Author>"]) test(`direct commit rejects invalid configured identity ${JSON.stringify(value)} before object mutation`, async (t) => {
  const f = await fixture(t);
  f.git(["config", "user.name", value]);
  const objects = f.git(["count-objects", "-v"]);
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_author_identity_unproven/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  await assert.rejects(readdir(join(f.root, "authority", "candidate-commits")), { code: "ENOENT" });
});

test("direct commit preserves a foreign ordinary index lock", async (t) => {
  const f = await fixture(t);
  const lock = join(f.repository, ".git", "index.lock");
  await writeFile(lock, "foreign lock owner\n");
  const objects = f.git(["count-objects", "-v"]);
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_index_locked/u);
  assert.equal(await readFile(lock, "utf8"), "foreign lock owner\n");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
});

test("direct commit publishes only the exact linked worktree index", async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, "linked");
  f.git(["worktree", "add", "--quiet", "-b", "candidate", linked, f.initial]);
  const git = (args) => f.git(["-C", linked, ...args]);
  const mainIndex = await readFile(join(f.repository, ".git", "index"));
  const facts = { ...f.intent.operation_input.workspace.git, ref: "refs/heads/candidate" };
  const workspace = { ...f.intent.operation_input.workspace, git: facts, fingerprint: digest({ git: facts }) };
  f.intent.operation_input.workspace = workspace; Object.assign(f.current, workspace);
  await writeFile(join(linked, "feature.txt"), "after\n");
  const operation = createProductionDirectCommitOperation({ ...f.options, resolveWorkspace: () => ({ path: linked }) });
  assert.equal((await operation.invoke(f.intent)).outcome, "succeeded");
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(git(["show", ":feature.txt"]), "after");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), mainIndex);
});

test("direct commit retains a crash lock and never repairs the ordinary index during reconciliation", async (t) => {
  const f = await fixture(t);
  const index = await readFile(join(f.repository, ".git", "index"));
  const source = `
    import { createProductionDirectCommitOperation } from ${JSON.stringify(new URL("../src/production-direct-commit.mjs", import.meta.url).href)};
    import { attachWorkAuthorities } from ${JSON.stringify(new URL("../../../tools/flow/src/work-authority.mjs", import.meta.url).href)};
    const intent = ${JSON.stringify(f.intent)};
    const authority = { query: () => (${JSON.stringify(f.run)}) };
    attachWorkAuthorities(authority, { workspace: { schema: "work.workspace-authority/v1", query: () => (${JSON.stringify(f.current)}) }, artifact: { schema: "work.artifact-authority/v1" }, review: { schema: "work.review-authority/v1" }, handoff: { schema: "flow.resource-handoff-authority/v1" } });
    await createProductionDirectCommitOperation({ resolveWorkspace: () => ({ path: ${JSON.stringify(f.repository)} }), authorityDirectory: ${JSON.stringify(f.options.authorityDirectory)}, authority: () => authority, onBoundary: stage => { if (stage === "after_ref_cas") process.kill(process.pid, "SIGKILL"); } }).invoke(intent);
  `;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", source], { env: f.options.env, timeout: 10000 }), { signal: "SIGKILL" });
  assert.notEqual(f.git(["rev-parse", "HEAD"]), f.initial);
  const lock = join(f.repository, ".git", "index.lock");
  const lockBytes = await readFile(lock);
  const objects = f.git(["count-objects", "-v"]);
  assert.equal(f.operation.reconcile(f.intent).presence, "indeterminate");
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_outcome_uncertain/u);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
  assert.deepEqual(await readFile(lock), lockBytes);
  assert.equal(f.git(["count-objects", "-v"]), objects);
});

test("direct commit keeps a missing commit record unknown without replay", async (t) => {
  const f = await fixture(t);
  const key = digest({ effect_id: f.intent.effect_id, idempotency_key: f.intent.idempotency_key }).slice(7);
  await mkdir(join(f.options.authorityDirectory, "candidate-commits", key), { recursive: true });
  const objects = f.git(["count-objects", "-v"]);
  const index = await readFile(join(f.repository, ".git", "index"));
  assert.equal(f.operation.reconcile(f.intent).presence, "indeterminate");
  await assert.rejects(f.operation.invoke(f.intent), { code: "EEXIST" });
  assert.equal(f.operation.reconcile(f.intent).presence, "indeterminate");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
});

test("direct commit requires durable publication of new and retained authority ancestors before mutation", async (t) => {
  const f = await fixture(t);
  const operation = createProductionDirectCommitOperation({ ...f.options, authorityDirectory: join(f.root, "first", "second", "authority") });
  const originalSync = fs.fsyncSync;
  const parent = fs.statSync(f.root);
  let parentFailures = 0;
  const mock = t.mock.method(fs, "fsyncSync", (fd) => {
    const directory = fs.fstatSync(fd);
    if (directory.dev === parent.dev && directory.ino === parent.ino) {
      parentFailures += 1;
      const error = new Error("injected parent directory fsync failure"); error.code = "EIO"; throw error;
    }
    return originalSync(fd);
  });
  syncBuiltinESMExports();
  const objects = f.git(["count-objects", "-v"]);
  const index = await readFile(join(f.repository, ".git", "index"));
  try {
    await assert.rejects(operation.invoke(f.intent), { code: "EIO" });
    await assert.rejects(operation.invoke(f.intent), { code: "EEXIST" });
    assert.equal(operation.reconcile(f.intent).presence, "indeterminate");
    const nextIntent = { ...f.intent, effect_id: "effect:distinct", idempotency_key: "commit:distinct" };
    await assert.rejects(operation.invoke(nextIntent), { code: "EIO" });
  }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(parentFailures, 2);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
  assert.equal(operation.reconcile(f.intent).presence, "indeterminate");
});

for (const path of ["feature.txt", "untracked.txt"]) test(`direct commit rejects global-only filter attributes for ${path}`, async (t) => {
  const f = await fixture(t, undefined, { attributes: `${path} filter=external\n` });
  if (path === "untracked.txt") await writeFile(join(f.repository, path), "raw changed bytes\n");
  const marker = join(f.root, "filter-executed");
  f.git(["config", "--global", "filter.external.clean", `touch ${marker}; cat`]);
  f.git(["config", "--global", "filter.external.required", "true"]);
  const objects = f.git(["count-objects", "-v"]);
  const index = await readFile(join(f.repository, ".git", "index"));
  let failure;
  try {
    await f.operation.invoke(f.intent);
    assert.equal(f.git(["show", `HEAD:${path}`]), path === "feature.txt" ? "after" : "raw changed bytes");
  } catch (error) { failure = error; }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.match(failure?.message ?? "operation committed raw content through the missing global driver", /candidate_commit_external_filter_unsupported/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
});

test("direct commit rejects a defined negative filter rather than guessing sentinel identity", async (t) => {
  const f = await fixture(t, undefined, { attributes: "feature.txt -filter\n" });
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_external_filter_unsupported/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
});

for (const boundary of ["claim", "grant", "ref", "index"]) {
  test(`direct commit rejects ${boundary} drift before Git mutation`, async (t) => {
    const f = await fixture(t);
    if (boundary === "claim") f.current.claims = [];
    if (boundary === "grant") f.run.capability_bindings = [];
    if (boundary === "ref") f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    if (boundary === "index") f.git(["add", "feature.txt"]);
    const objectsBefore = f.git(["count-objects", "-v"]);
    await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_(claim_unproven|grant_unproven|git_fence_changed)/u);
    assert.equal(f.git(["rev-parse", "refs/heads/main"]), f.initial);
    assert.equal(f.git(["count-objects", "-v"]), objectsBefore);
  });
}

for (const boundary of ["before_ref_cas", "after_ref_cas"]) {
  test(`direct commit interrupted ${boundary} keeps one durable commit identity and never replays`, async (t) => {
    const f = await fixture(t, (stage) => { if (stage === boundary) throw new Error("injected_interruption"); });
    await assert.rejects(f.operation.invoke(f.intent), /injected_interruption/u);
    const [key] = await readdir(join(f.root, "authority", "candidate-commits"));
    const record = JSON.parse(await readFile(join(f.root, "authority", "candidate-commits", key, "intent.json"), "utf8"));
    const head = f.git(["rev-parse", "HEAD"]);
    assert.equal(head, boundary === "before_ref_cas" ? f.initial : record.commit_sha);
    const objects = f.git(["count-objects", "-v"]);
    const recovered = createProductionDirectCommitOperation({ ...f.options, onBoundary: undefined });
    assert.equal(recovered.reconcile(f.intent).presence, "indeterminate");
    await assert.rejects(recovered.invoke(f.intent), /candidate_commit_outcome_uncertain/u);
    assert.equal(f.git(["rev-parse", "HEAD"]), head);
    assert.equal(f.git(["count-objects", "-v"]), objects);
    if (boundary === "after_ref_cas") {
      // Explicitly restoring the ordinary index allows exact observation of
      // the existing commit; recovery never constructs another one.
      f.git(["read-tree", record.commit_sha]);
      const observed = recovered.reconcile(f.intent);
      assert.equal(observed.presence, "present");
      assert.equal(observed.provider_observation.commit_sha, record.commit_sha);
    }
  });
}

test("direct commit ignores ambient Git redirection and disables signing/fsmonitor/hooks", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "unexpected-execution");
  f.git(["config", "commit.gpgsign", "true"]); f.git(["config", "gpg.program", `touch ${marker}`]);
  f.git(["config", "core.fsmonitor", `touch ${marker}`]);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, "foreign.git");
  try {
    const receipt = await f.operation.invoke(f.intent);
    assert.equal(receipt.outcome, "succeeded");
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const schema=JSON.parse(await readFile(new URL("../schemas/flow.git-candidate-commit-receipt.v1.schema.json",import.meta.url),"utf8"));
    const validate=new Ajv({strict:true}).compile(schema);
    assert.equal(validate(receipt.provider_receipt),true,JSON.stringify(validate.errors));
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.notEqual(f.git(["-c", "core.fsmonitor=false", "rev-parse", "HEAD"]), f.initial);
});

test("direct commit rejects configured clean/process filters before they can execute", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "filter-executed");
  f.git(["config", "filter.hostile.clean", `touch ${marker}; cat`]);
  await writeFile(join(f.repository, ".gitattributes"), "feature.txt filter=hostile\n");
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_external_filter_unsupported/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("direct commit preserves index drift completed before the final lock", async (t) => {
  let fixtureValue;
  const f = await fixture(t, (stage) => { if (stage === "before_ref_cas") fixtureValue.git(["add", "feature.txt"]); });
  fixtureValue = f;
  await assert.rejects(f.operation.invoke(f.intent), /candidate_commit_(git_fence_changed|outcome_uncertain)/u);
  assert.notEqual(f.git(["write-tree"]),f.intent.operation_input.workspace.git.tree_sha);
  assert.equal(f.git(["show", ":feature.txt"]), "after");
  assert.equal(f.git(["rev-parse", "HEAD"]),f.initial);
});

for (const kind of ["leading whitespace", "non-UTF8 bytes"]) test(`direct commit rejects an exact filter on a tracked pathname containing ${kind}`, async (t) => {
  const f = await fixture(t);
  const name = kind === "leading whitespace" ? Buffer.from("  leading.txt") : Buffer.from([0x80, 0x2d, 0x72, 0x61, 0x77, 0x2e, 0x74, 0x78, 0x74]);
  const path = Buffer.concat([Buffer.from(f.repository + "/"), name]);
  const pattern = kind === "leading whitespace" ? Buffer.from('"  leading.txt"') : name;
  await writeFile(path, "before\n");
  await writeFile(join(f.repository, ".gitattributes"), Buffer.concat([pattern, Buffer.from(" filter=external\n")]));
  f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "tracked raw pathname"]);
  const initial = f.git(["rev-parse", "HEAD"]);
  const git = { ...f.intent.operation_input.workspace.git, commit_sha: initial, tree_sha: f.git(["rev-parse", "HEAD^{tree}"]) };
  const workspace = { ...f.intent.operation_input.workspace, git, fingerprint: digest({ git }) };
  f.intent.operation_input.workspace = workspace; Object.assign(f.current, workspace);
  const inspect = (args, options = {}) => execFileSync("/usr/bin/git", ["-C", f.repository, ...args], { env: f.options.env, ...options });
  const listing = inspect(["ls-files", "--cached", "-z"]);
  if (kind === "leading whitespace") assert.deepEqual(listing.subarray(0, listing.indexOf(0)), name, "the first NUL-delimited path must retain its prefix");
  const attributes = inspect(["check-attr", "--all", "-z", "--stdin"], { input: listing });
  assert.ok(attributes.includes(Buffer.concat([name, Buffer.from("\0filter\0external\0")])), "Git must match the exact original pathname bytes");
  const marker = join(f.root, "filter-executed");
  f.git(["config", "--global", "filter.external.clean", `touch ${marker}; cat`]);
  f.git(["config", "--global", "filter.external.required", "true"]);
  await writeFile(path, "after\n");
  const objects = f.git(["count-objects", "-v"]), index = await readFile(join(f.repository, ".git", "index"));
  let failure;
  try { await f.operation.invoke(f.intent); } catch (error) { failure = error; }
  t.diagnostic(JSON.stringify({ root: f.root, pathname_hex: name.toString("hex"), before_commit: initial,
    after_commit: f.git(["rev-parse", "HEAD"]), index_unchanged: index.equals(await readFile(join(f.repository, ".git", "index"))) }));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.match(failure?.message ?? "operation committed raw content through a missed filter attribute", /candidate_commit_external_filter_unsupported/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), initial);
  assert.equal(f.git(["count-objects", "-v"]), objects);
  assert.deepEqual(await readFile(join(f.repository, ".git", "index")), index);
  await assert.rejects(readdir(join(f.options.authorityDirectory, "candidate-commits")), { code: "ENOENT" });
  assert.equal(f.operation.reconcile(f.intent).presence, "indeterminate");
  assert.equal(f.operation.reconcile(f.intent).provider_observation.reason, "commit_record_missing");
});

test("real unchanged writer work settles as a durable pre-CAS absence through the registered operation boundary", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "feature.txt"), "before\n");
  const beforeIndex = await readFile(join(f.repository, ".git/index"));
  const beforeObjects = f.git(["count-objects", "-v"]);
  const intent = { ...f.intent, operation_contract: FEATURE_DIRECT_COMMIT_CONTRACT, classification: "reconcilable" };
  const dispatched = await new Promise(resolve => dispatchRegisteredEffect(intent, { [FEATURE_DIRECT_COMMIT_CONTRACT]: f.operation }, {
    async invokeEffect(effectiveIntent, { invoke }) {
      try { resolve({ receipt: await invoke(effectiveIntent) }); }
      catch (error) { resolve({ failure: error.provider_observation }); }
    },
  }));
  assert.equal(dispatched.failure, undefined, JSON.stringify(dispatched));
  assert.equal(dispatched.receipt.outcome, "not_created");
  assert.equal(dispatched.receipt.provider_receipt.found, false);
  assert.equal(dispatched.receipt.provider_receipt.reason, "candidate_commit_no_change");
  assert.equal(dispatched.receipt.provider_receipt.proof, "pre_cas_unchanged_tree");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.deepEqual(await readFile(join(f.repository, ".git/index")), beforeIndex);
  assert.equal(f.git(["count-objects", "-v"]), beforeObjects);
  const dirs = await readdir(join(f.root, "authority/candidate-commits"));
  assert.equal(dirs.length, 1);
  const recordRoot = join(f.root, "authority/candidate-commits", dirs[0]);
  const records = await readdir(recordRoot);
  assert.ok(records.includes("no-change.json"));
  assert.ok(!records.includes("intent.json"));
  assert.ok(!records.includes("index-lock.json"));
  const recovered = createProductionDirectCommitOperation(f.options);
  assert.equal(recovered.reconcile(f.intent).presence, "absent");
  assert.deepEqual(await recovered.invoke(f.intent), dispatched.receipt);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initial);
  const absencePath = join(recordRoot, "no-change.json");
  const absenceBytes = await readFile(absencePath, "utf8");
  const absence = JSON.parse(absenceBytes);
  absence.old_commit_sha = "0".repeat(40);
  await writeFile(absencePath, JSON.stringify(absence));
  assert.equal(recovered.reconcile(f.intent).presence, "indeterminate", "changed absence bytes cannot prove that a commit was not made");
  await writeFile(absencePath, absenceBytes);
  await writeFile(join(f.repository, "feature.txt"), "external drift\n");
  assert.equal(recovered.reconcile(f.intent).presence, "indeterminate", "a valid absence marker cannot bless a changed workspace");
  await writeFile(join(f.repository, "feature.txt"), "before\n");
  await rm(absencePath);
  assert.equal(recovered.reconcile(f.intent).presence, "indeterminate", "unchanged HEAD and missing intent alone are not an absence witness");
});

for (const bad of [{ found: true, complete: true }, { complete: true }, { found: false }, { found: false, complete: false }]) {
  test(`registered no-commit outcome rejects incomplete or contradictory absence ${JSON.stringify(bad)}`, async () => {
    const intent = { run_id: "run:absence", card_id: "commit", attempt_id: "attempt:absence", effect_id: "effect:absence", idempotency_key: "key:absence", operation_contract: FEATURE_DIRECT_COMMIT_CONTRACT, classification: "reconcilable" };
    const registration = { classification: "reconcilable", observe() {}, async invoke() {
      return { schema: "flow.effect-receipt/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key, outcome: "not_created", provider_receipt: { schema: "flow.provider-observation/v1", ...bad } };
    } };
    const failure = await new Promise(resolve => dispatchRegisteredEffect(intent, { [FEATURE_DIRECT_COMMIT_CONTRACT]: registration }, {
      async invokeEffect(value, { invoke }) { try { await invoke(value); resolve(null); } catch (error) { resolve(error.provider_observation); } },
    }));
    assert.equal(failure.status, "invalid_output");
  });
}

test("a prepared commit identity remains exact despite host configuration drift and rejects a different binding", async t => {
  const f = await fixture(t);
  const identity = { author: { name: "Selected Author", email: "author@example.test" }, committer: { name: "Selected Committer", email: "committer@example.test" } };
  f.run.views = { operator: { trust_posture: { git_identity: identity } } };
  const operation = createProductionDirectCommitOperation({ ...f.options, gitIdentity: identity });
  const before = f.git(["rev-parse", "HEAD"]);
  f.run.views.operator.trust_posture.git_identity = { ...identity, author: { ...identity.author, name: "Other Author" } };
  await assert.rejects(operation.invoke(f.intent), /candidate_commit_author_identity_changed/u);
  assert.equal(f.git(["rev-parse", "HEAD"]), before);
  await assert.rejects(readdir(join(f.root, "authority/candidate-commits")), { code: "ENOENT" });
  f.run.views.operator.trust_posture.git_identity = identity;
  await writeFile(join(f.home, ".gitconfig"), '[user]\n name = Changed Global\n email = changed@example.test\n');
  const receipt = await operation.invoke(f.intent);
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(f.git(["show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD"]), "Selected Author|author@example.test|Selected Committer|committer@example.test");
});
