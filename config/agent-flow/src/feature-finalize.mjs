import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadCompletedEvidence } from "./completed-evidence.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFile = promisify(execFileCallback);

export async function finalizeFeature({
  adapter = null,
  env = process.env,
  now = () => new Date(),
  registerReview = defaultRegisterReview,
  runId,
}) {
  const { manifest: run, runDirectory } = await loadRunManifest({ runId, env });
  if (run.identity.flow !== "feature") throw new Error(`${runId} is not a feature run`);
  await verifySealedInputs(run);
  const featureInput = run.inputs.find(
    ({ kind, name }) => kind === "brief" && name === "feature.json",
  );
  if (!featureInput) throw new Error("feature run omits its sealed feature manifest");
  const feature = JSON.parse(await readFile(featureInput.sealed_path, "utf8"));
  const featureValidation = await validateContract(feature);
  if (!featureValidation.valid) throw new Error("sealed feature manifest is invalid");
  const worktree = run.identity.repository.worktree;
  if (!worktree) throw new Error("feature run has no worktree");
  const [head, branch, status] = await Promise.all([
    git(worktree, "rev-parse", "HEAD"),
    git(worktree, "symbolic-ref", "--short", "HEAD"),
    git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
  ]);
  if (branch !== feature.branch) throw new Error("feature worktree is on the wrong branch");
  if (status !== "") throw new Error("feature worktree must be clean before finalization");
  await assertAncestor(worktree, feature.base.sha, head);
  if (head === feature.base.sha) throw new Error("feature finalization requires a new commit");

  const artifacts = run.identity.artifact_directory;
  const materialization = JSON.parse(
    await readFile(join(runDirectory, "materialization.json"), "utf8"),
  );
  const resolvedAdapter = adapter ?? new HermesAdapter({ board: run.identity.board });
  const paths = {
    summary: join(artifacts, "review-summary.md"),
    verification: join(artifacts, "verification.json"),
    journal: join(artifacts, "journal.md"),
    automated: join(artifacts, "automated-review.json"),
  };
  await Promise.all([paths.summary, paths.journal, paths.automated].map(requireRegularFile));
  await executeVerification({
    commands: feature.verification,
    head,
    path: paths.verification,
    worktree,
  });
  const evidence = await Promise.all([
    loadCompletedEvidence({
      adapter: resolvedAdapter,
      evidencePath: join(artifacts, "validations", "validate-handoff--independent-critic.json"),
      manifest: run, materialization, requirePassed: true,
      stage: "independent-critic", validationStage: "validate-handoff:independent-critic",
    }),
    loadCompletedEvidence({
      adapter: resolvedAdapter,
      evidencePath: join(artifacts, "validations", "validate-handoff--review-summary.json"),
      manifest: run, materialization,
      stage: "review-summary", validationStage: "validate-handoff:review-summary",
    }),
  ]);
  const snapshots = new Map(evidence.flatMap(({ artifacts: items }) =>
    items.map(({ snapshot, sourcePath }) => [sourcePath, snapshot])
  ));
  const automatedPath = requiredSnapshot(snapshots, paths.automated);
  const summaryPath = requiredSnapshot(snapshots, paths.summary);
  const journalPath = requiredSnapshot(snapshots, paths.journal);
  const automated = JSON.parse(await readFile(automatedPath, "utf8"));
  if (
    automated.passed !== true ||
    automated.reviewed_head_sha !== head ||
    (automated.blocking_findings?.length ?? 0) > 0
  ) {
    throw new Error("independent automated review has blocking findings");
  }
  const rootTask = materialization.tasks?.["feature-root"];
  if (typeof rootTask !== "string") throw new Error("feature materialization omits its root task");

  const review = {
    schema: "agent-flow.local-review/v1",
    run_id: feature.run_id,
    flow: "feature",
    summary: feature.summary,
    created_at: now().toISOString(),
    repo: run.identity.repository.path,
    worktree,
    base: structuredClone(feature.base),
    head: { branch: feature.branch, sha: head },
    kanban: { board: run.identity.board, tenant: run.identity.tenant, task: rootTask },
    external_ref: feature.external_ref,
    artifacts: {
      review_summary: summaryPath,
      verification: paths.verification,
      journal: journalPath,
      automated_findings: automatedPath,
      diagram: null,
    },
    automated_review: {
      status: "passed",
      reviewed_head_sha: head,
      findings_path: automatedPath,
      urgency: "standard",
      max_comments: 20,
      per_tier_caps: { critical: 20, important: 20, recommended: 20, nit: 0 },
    },
    review: {
      status: "review_ready",
      session_slug: null,
      reviewed_head_sha: null,
      consumed_comment_ids: [],
      generation: 0,
      events: [],
      comment_dispositions: [],
      integration_receipts: [],
    },
  };
  const validation = await validateContract(review);
  if (!validation.valid) {
    throw new Error(`generated local review is invalid: ${validation.errors[0]?.message}`);
  }
  const reviewManifestPath = join(artifacts, "review.json");
  await atomicWrite(reviewManifestPath, review);
  await registerReview(reviewManifestPath);
  return { headSha: head, reviewManifestPath, runId };
}

async function verifySealedInputs(run) {
  const graphBytes = await readFile(run.graph.sealed_path);
  if (sha256(graphBytes) !== run.graph.sha256) throw new Error("sealed feature graph changed");
  for (const input of run.inputs) {
    if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
      throw new Error(`sealed feature input changed: ${input.kind}/${input.name}`);
    }
  }
}

async function executeVerification({ commands, head, path, worktree }) {
  const results = [];
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    try {
      const { stdout, stderr } = await execFile(command.argv[0], command.argv.slice(1), {
        cwd: worktree,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      results.push({ argv: command.argv, exit_code: 0, started_at: startedAt, stderr, stdout });
    } catch (error) {
      results.push({
        argv: command.argv,
        exit_code: Number.isInteger(error.code) ? error.code : 1,
        started_at: startedAt,
        stderr: error.stderr ?? error.message,
        stdout: error.stdout ?? "",
      });
      await atomicWrite(path, { passed: false, reviewed_head_sha: head, results });
      throw new Error(`final verification failed: ${command.argv.join(" ")}`);
    }
  }
  const document = { passed: true, reviewed_head_sha: head, results };
  await atomicWrite(path, document);
  return document;
}

function requiredSnapshot(snapshots, sourcePath) {
  const snapshot = snapshots.get(sourcePath);
  if (!snapshot) throw new Error(`validated evidence omits ${sourcePath}`);
  return snapshot;
}

async function defaultRegisterReview(path) {
  await execFile("tuicr-reviews", ["add", "--manifest", path]);
}

async function requireRegularFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`required feature artifact is not a file: ${path}`);
}

async function assertAncestor(repository, ancestor, descendant) {
  try {
    await execFile("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]);
  } catch (error) {
    if (error.code === 1) throw new Error("feature head does not descend from its pinned base");
    throw error;
  }
}

async function atomicWrite(path, document) {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let renamed = false;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
