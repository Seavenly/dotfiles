#!/usr/bin/env node
// feature-flow-codex-review.js - opt-in (--codex) final review of a finished
// feature-flow change by a different model family.
//
//   node feature-flow-codex-review.js <runDir> --base <sha> --head <sha>
//        [--model latest-sol|<slug>] [--effort E] [--timeout-sec N]
//
// Uses the same instructions as the Fable final reviewer (the body of
// agents/feature-critic.md, whose lenses a 2026-10-02 replay showed a thin
// final-review prompt could not match), pinned to one base and head. Codex runs
// read-only against the run worktree. The result is rejected when the
// worktree's HEAD is not the pinned head before and after the review, so
// findings always describe the change that was asked about.
//
// Fail-soft: prints one JSON object and exits 0 with status ok | failed |
// skipped; the workflow falls back to the Fable reviewer on anything but ok.
// Audit trail under <runDir>/out/final-review-codex/.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveCodexModel } = require("./codex-model");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "confidence", "title", "evidence", "failureScenario", "fixDirection"],
        properties: {
          severity: { type: "string", enum: ["critical", "important", "minor"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          evidence: { type: "string" },
          failureScenario: { type: "string" },
          fixDirection: { type: "string" },
        },
      },
    },
  },
};

function main() {
  const argv = process.argv.slice(2);
  const runDir = argv.find((x) => !x.startsWith("--"));
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const base = opt("base");
  const head = opt("head");
  if (!runDir || !base || !head) {
    process.stderr.write("usage: feature-flow-codex-review.js <runDir> --base <sha> --head <sha> [--model latest-sol|<slug>] [--effort E]\n");
    process.exit(2);
  }
  // A `latest-<family>` spec resolves after the login probe, so a missing
  // Codex is reported as such rather than as an unresolvable model.
  const requestedModel = opt("model", "latest-sol");
  let model = requestedModel;
  let effort = opt("effort", "medium");
  let modelSource = null;
  const timeoutSec = Number(opt("timeout-sec", 1800));
  const worktree = path.join(runDir, "worktree");
  const dir = path.join(runDir, "out", "final-review-codex");
  fs.mkdirSync(dir, { recursive: true });
  const resultPath = path.join(dir, "result.json");

  // An agent's shell call times out after ten minutes. --detach starts the
  // review in the background and prints { status: "running" }; --wait N
  // blocks up to N seconds (max 570) for the result.
  if (argv.includes("--detach")) {
    fs.rmSync(resultPath, { force: true });
    const rest = argv.filter((x) => x !== "--detach").map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
    spawnSync("/bin/sh", ["-c", `nohup '${process.execPath}' '${__filename}' ${rest} >/dev/null 2>&1 &`]);
    process.stdout.write(`${JSON.stringify({ status: "running", base, head })}\n`);
    process.exit(0);
  }
  if (argv.includes("--wait")) {
    const deadline = Date.now() + Math.min(Number(opt("wait", 540)), 570) * 1000;
    while (Date.now() < deadline) {
      if (fs.existsSync(resultPath)) {
        process.stdout.write(`${JSON.stringify(JSON.parse(fs.readFileSync(resultPath, "utf8")))}\n`);
        process.exit(0);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
    process.stdout.write(`${JSON.stringify({ status: "running", base, head })}\n`);
    process.exit(0);
  }

  const finish = (status, extra = {}) => {
    const result = { status, model, requestedModel, modelSource, effort, base, head, ...extra };
    fs.writeFileSync(`${resultPath}.tmp`, JSON.stringify(result));
    fs.renameSync(`${resultPath}.tmp`, resultPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  };
  const currentHead = () => spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 20000 });
  if (probe.error) return finish("skipped", { reason: `codex not runnable: ${probe.error.code || probe.error.message}` });
  if (probe.status !== 0) return finish("skipped", { reason: "codex not logged in (run `codex login`)" });
  const resolved = resolveCodexModel(requestedModel, effort);
  if (!resolved.model) return finish("skipped", { reason: `model resolution unavailable: ${resolved.reason}` });
  ({ model, effort, source: modelSource } = resolved);
  if (resolved.note) fs.writeFileSync(path.join(dir, "model-note.txt"), `${resolved.note}\n`);
  if (currentHead() !== head) return finish("failed", { reason: "worktree HEAD is not the pinned head" });

  const persona = fs.readFileSync(path.join(__dirname, "..", "agents", "feature-critic.md"), "utf8")
    .replace(/^---[\s\S]*?---\s*/, "");
  const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
  const planPath = path.join(runDir, "out", "plan.md");
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "(no plan)";
  const prompt = `${persona}

## This change

This is the final review: a fresh look at the complete change after the
in-flow review and its fixes. You get only the brief and the plan, not the
run's journal or earlier findings. The worktree is the current directory.
Review \`git diff ${base}..${head}\` (inspect it with git; the files at
${head} are checked out). Read any surrounding code you need.

## The brief

${brief}

## The plan

${plan}

Return JSON matching the output schema: a one-line summary and every finding.
`;
  const schemaPath = path.join(dir, "schema.json");
  const outPath = path.join(dir, "review.json");
  fs.writeFileSync(schemaPath, JSON.stringify(SCHEMA, null, 2));
  fs.writeFileSync(path.join(dir, "prompt.md"), prompt);
  fs.rmSync(outPath, { force: true });

  const started = Date.now();
  const res = spawnSync("codex", [
    "exec", "-m", model, "-c", `model_reasoning_effort="${effort}"`,
    "-s", "read-only", "-C", worktree, "--skip-git-repo-check", "--ephemeral",
    "--color", "never", "--output-schema", schemaPath, "-o", outPath, "-",
  ], { input: prompt, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  const durationSec = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(dir, "exec.log"), `${res.stdout || ""}\n--- stderr ---\n${res.stderr || ""}`);

  if (res.error && res.error.code === "ETIMEDOUT") return finish("failed", { reason: `timed out after ${timeoutSec}s`, durationSec });
  if (res.status !== 0) {
    const quota = /rate limit|usage limit|quota|429/i.test(`${res.stderr}${res.stdout}`);
    return finish("failed", { reason: quota ? "codex usage limit reached" : `codex exited ${res.status}; see exec.log`, durationSec });
  }
  if (currentHead() !== head) return finish("failed", { reason: "worktree HEAD moved during the review", durationSec });
  let review;
  try { review = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch { review = null; }
  if (!review || !Array.isArray(review.findings)) return finish("failed", { reason: "no valid review JSON; see exec.log", durationSec });
  return finish("ok", { summary: review.summary, findings: review.findings, durationSec });
}

main();
