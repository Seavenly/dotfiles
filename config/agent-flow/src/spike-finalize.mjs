import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadCompletedEvidence } from "./completed-evidence.mjs";
import { HermesAdapter } from "./hermes-adapter.mjs";
import { loadRunManifest } from "./run-manifest.mjs";
import { validateContract } from "./schema-validator.mjs";

const execFile = promisify(execFileCallback);

export async function finalizeSpike({ adapter = null, env = process.env, runId }) {
  const { manifest, runDirectory } = await loadRunManifest({ runId, env });
  if (manifest.identity.flow !== "spike") throw new Error(`${runId} is not a spike run`);
  await verifySealedInputs(manifest);
  const spike = JSON.parse(await readFile(requiredInput(manifest, "brief", "spike.json").sealed_path));
  const artifacts = manifest.identity.artifact_directory;
  const reportSourcePath = join(artifacts, "spike-report.md");
  await requireFile(reportSourcePath);
  const validationPath = join(artifacts, "validations", "validate-handoff--synthesis.json");
  const materialization = JSON.parse(await readFile(join(runDirectory, "materialization.json")));
  const evidence = await loadCompletedEvidence({
    adapter: adapter ?? new HermesAdapter({ board: manifest.identity.board }),
    evidencePath: validationPath, manifest, materialization,
    stage: "synthesis", validationStage: "validate-handoff:synthesis",
  });
  const reportPath = evidence.artifacts.find(({ sourcePath }) => sourcePath === reportSourcePath)?.snapshot;
  if (!reportPath) throw new Error("spike synthesis evidence does not bind the report");
  let prototype = null;
  if (spike.prototype) {
    const worktree = manifest.identity.repository.worktree;
    if (!worktree) throw new Error("prototype spike has no worktree");
    const head = await git(worktree, "rev-parse", "HEAD");
    const changed = (await git(worktree, "diff", "--name-only", `${spike.source.sha}..${head}`))
      .split("\n").filter(Boolean);
    const dirty = (await git(worktree, "status", "--porcelain=v1", "--untracked-files=all"))
      .split("\n").filter(Boolean).map((line) => line.slice(3));
    const outside = [...changed, ...dirty].filter((path) =>
      path !== spike.prototype.experiment_path &&
      !path.startsWith(`${spike.prototype.experiment_path}/`)
    );
    if (outside.length > 0) {
      throw new Error(`prototype wrote outside its approved experiment path: ${outside.join(", ")}`);
    }
    prototype = {
      experiment_path: join(worktree, spike.prototype.experiment_path),
      head_sha: head,
      worktree,
    };
  }
  let controller = { residual_gaps: [], retained_evidence: [] };
  try { controller = JSON.parse(await readFile(join(runDirectory, "spike-controller.json"))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let stuckSlices = [];
  try { stuckSlices = JSON.parse(await readFile(join(artifacts, "stuck-slices.json"))).stuck_slices ?? []; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const result = {
    schema: "agent-flow.spike-result/v1",
    run_id: runId,
    source_sha: spike.source.sha,
    report_path: reportPath,
    prototype,
    retained_evidence: controller.retained_evidence ?? [],
    residual_gaps: controller.residual_gaps ?? [],
    stuck_slices: stuckSlices,
  };
  const resultValidation = await validateContract(result);
  if (!resultValidation.valid) {
    throw new Error(`spike result is invalid: ${resultValidation.errors[0]?.message}`);
  }
  const resultPath = join(artifacts, "spike-result.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return { resultPath, runId };
}

async function verifySealedInputs(manifest) {
  if (sha256(await readFile(manifest.graph.sealed_path)) !== manifest.graph.sha256) {
    throw new Error("sealed spike graph changed");
  }
  for (const input of manifest.inputs) {
    if (sha256(await readFile(input.sealed_path)) !== input.sha256) {
      throw new Error(`sealed spike input changed: ${input.kind}/${input.name}`);
    }
  }
}

function requiredInput(manifest, kind, name) {
  const found = manifest.inputs.find((input) => input.kind === kind && input.name === name);
  if (!found) throw new Error(`spike run omits ${kind}/${name}`);
  return found;
}
async function requireFile(path) {
  if (!(await stat(path)).isFile()) throw new Error(`spike artifact is not a file: ${path}`);
}
async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
