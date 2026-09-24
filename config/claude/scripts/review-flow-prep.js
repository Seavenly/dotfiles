#!/usr/bin/env node
// review-flow-prep.js — everything /review-flow does before launching the
// workflow, as code rather than prose the host has to re-read each run.
//
//   node review-flow-prep.js <pr> [--repo owner/name] [--urgency hotfix|fast|standard]
//        [--max-comments N] [--lenses a,b,c] [--prepare-draft] [--no-codex]
//        [--diagrams] [--focus "text"] [--allow-closed]
//
// Pins one snapshot (head SHA, base SHA, diff digest, checkout SHA) so every
// later step reviews, renders and posts against the same comparison; clones
// that exact SHA detached (`gh pr checkout` fails in a shallow clone); writes
// the stated intent, prior review conversation and brief; and prints one JSON
// object: { runDir, launchArgs, confirm, warnings }.
//
// Exit codes: 0 ok · 2 usage · 3 PR not open (re-run with --allow-closed) ·
// 4 gh failure.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pr = (argv.find((x) => /^#?\d+$/.test(x)) || "").replace("#", "");
  if (!pr) fail(2, "usage: review-flow-prep.js <pr> [flags]");

  const defaults = readReviewDefaults(path.join(__dirname, "..", "defaults.yaml"));
  const urgency = opt("urgency") || (flag("hotfix") && "hotfix") || (flag("fast") && "fast") || defaults.urgency || "standard";
  if (!["hotfix", "fast", "standard"].includes(urgency)) fail(2, `unknown urgency: ${urgency}`);
  const config = {
    urgency,
    max_comments: Number(opt("max-comments") || defaults.max_comments || 20),
    per_tier_caps: defaults.per_tier_caps || { critical: null, important: null, recommended: 10, nit: 3 },
    reviewer_lenses: opt("lenses") ? opt("lenses").split(",") : defaults.reviewer_lenses,
    prepare_draft: flag("prepare-draft"),
    codex: flag("no-codex") ? false : defaults.codex_cross_check !== false,
    diagrams: flag("diagrams") || defaults.diagrams === true,
  };
  const focus = opt("focus") || null;
  const warnings = [];

  const repo = opt("repo") || gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const [owner, name] = repo.split("/");
  const meta = JSON.parse(
    gh(["pr", "view", pr, "--repo", repo, "--json",
      "title,body,state,url,baseRefName,headRefName,headRefOid,baseRefOid,closingIssuesReferences"])
  );
  if (meta.state !== "OPEN" && !flag("allow-closed")) {
    fail(3, `PR #${pr} is ${meta.state}; confirm with the user, then re-run with --allow-closed`);
  }

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const runId = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-pr-${pr}`;
  const runDir = path.join(os.homedir(), ".agent-teams", "runs", runId);
  const outDir = path.join(runDir, "out");
  const repoDir = path.join(runDir, "repo");
  fs.mkdirSync(path.join(outDir, "findings"), { recursive: true });
  if (config.diagrams) fs.mkdirSync(path.join(outDir, "diagrams"), { recursive: true });

  // Diff + head, re-read until stable: a push between the reads would pair a
  // diff with the wrong SHA.
  let headSha, baseSha, diff, stable = false;
  for (let i = 0; i < 3 && !stable; i++) {
    const before = gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]);
    diff = gh(["pr", "diff", pr, "--repo", repo], { raw: true });
    const after = JSON.parse(gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid,baseRefOid"]));
    headSha = after.headRefOid;
    baseSha = after.baseRefOid;
    stable = before === headSha;
  }
  if (!stable) fail(4, `PR #${pr} head changed on every read (someone is pushing); try again once it settles`);
  fs.writeFileSync(path.join(outDir, "pr.diff"), diff);

  // Checkout of exactly that SHA.
  fs.mkdirSync(repoDir, { recursive: true });
  const cloneLog = [];
  const step = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    cloneLog.push(`$ ${cmd} ${args.join(" ")}\n${r.stdout || ""}${r.stderr || ""}`);
    return r.status === 0;
  };
  const cloned =
    step("gh", ["repo", "clone", repo, ".", "--", "--depth=50", "--no-tags", "--quiet"], repoDir) &&
    step("git", ["fetch", "-q", "--depth=50", "origin", headSha], repoDir) &&
    step("git", ["checkout", "-q", "--detach", headSha], repoDir);
  fs.writeFileSync(path.join(outDir, "clone.log"), cloneLog.join("\n"));
  const checkoutSha = cloned ? tryRun("git", ["-C", repoDir, "rev-parse", "HEAD"]) : null;
  const haveCheckout = checkoutSha === headSha;
  if (!haveCheckout) warnings.push("no checkout — diff-only review; absence and mechanism claims are lower confidence (see out/clone.log)");

  const crypto = require("node:crypto");
  fs.writeFileSync(
    path.join(outDir, "snapshot.json"),
    JSON.stringify({
      head_sha: headSha,
      base_sha: baseSha,
      diff_sha256: crypto.createHash("sha256").update(diff).digest("hex"),
      checkout_sha: checkoutSha,
      fetched_at: new Date().toISOString(),
    }, null, 2)
  );

  // Stated intent, labelled by source so agents know what the author wrote.
  const jiraKeys = [...new Set(
    [meta.title, meta.headRefName, meta.body || ""].join("\n").match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []
  )];
  const issues = ((meta.closingIssuesReferences || [])).map((i) => `- #${i.number} ${i.title || ""}`.trim());
  fs.writeFileSync(
    path.join(outDir, "pr-body.md"),
    [
      `# Stated intent for PR #${pr}`,
      "## PR description (author)",
      (meta.body || "").trim() || "no description",
      "## Linked issues",
      issues.length ? issues.join("\n") : "none",
      "## Ticket keys found in title, branch or description",
      jiraKeys.length ? jiraKeys.join(", ") : "none",
      "",
    ].join("\n\n")
  );

  // Prior review conversation. null means "not fetched or empty"; agents treat
  // that as unknown overlap, never as a clean slate.
  const priorPath = path.join(outDir, "prior-review.json");
  let priorReviewPath = null;
  const prior = tryRun("gh", ["api", "graphql", "-f", `query=${PRIOR_QUERY}`,
    "-F", `owner=${owner}`, "-F", `repo=${name}`, "-F", `num=${pr}`,
    "--jq", ".data.repository.pullRequest"]);
  let p = null;
  try { p = prior ? JSON.parse(prior) : null; } catch { p = null; }
  if (p) {
    const has = ["reviewThreads", "comments", "reviews"].some((k) => p[k] && p[k].nodes && p[k].nodes.length);
    if (has) {
      fs.writeFileSync(priorPath, JSON.stringify(p, null, 2));
      priorReviewPath = priorPath;
    }
  } else {
    warnings.push("prior review conversation could not be fetched; overlap with existing threads is unknown");
  }

  const guide = haveCheckout
    ? ["REVIEW.md", ".github/REVIEW.md"].map((f) => path.join(repoDir, f)).find((f) => fs.existsSync(f)) || null
    : null;

  if (config.codex) {
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      warnings.push(`Codex cross-check will be skipped: ${probe.error ? "codex not found" : "not logged in (run `codex login`)"}`);
    }
  }

  const yamlStr = (s) => JSON.stringify(String(s));
  fs.writeFileSync(
    path.join(runDir, "brief.md"),
    `---
type: review
created: ${new Date().toISOString()}
run_id: ${runId}
pr_number: ${pr}
pr_title: ${yamlStr(meta.title)}
repo: ${repo}
pr_url: ${meta.url}
base_ref: ${meta.baseRefName}
head_ref: ${meta.headRefName}
head_sha: ${headSha}
base_sha: ${baseSha}
config:
  urgency: ${config.urgency}
  max_comments: ${config.max_comments}
  per_tier_caps:
${Object.entries(config.per_tier_caps).map(([k, v]) => `    ${k}: ${v === null ? "null" : v}`).join("\n")}
  reviewer_lenses: [${config.reviewer_lenses.join(", ")}]
  prepare_draft: ${config.prepare_draft}
  codex: ${config.codex}
  diagrams: ${config.diagrams}
focus: ${focus ? yamlStr(focus) : "null"}
---

# Review brief
PR #${pr}: ${meta.title}
Stated intent: out/pr-body.md
${focus ? `Focus: ${focus}` : ""}
`
  );

  const draftScope = { hotfix: "criticals only", fast: "criticals + importants", standard: "all tiers (caps apply)" }[urgency];
  process.stdout.write(
    JSON.stringify({
      runDir,
      launchArgs: {
        runDir, outDir,
        repoDir: haveCheckout ? repoDir : null,
        diffPath: path.join(outDir, "pr.diff"),
        briefPath: path.join(runDir, "brief.md"),
        prBodyPath: path.join(outDir, "pr-body.md"),
        priorReviewPath,
        reviewGuidePath: guide,
        prNumber: Number(pr), prTitle: meta.title, repo, prUrl: meta.url, headSha,
        urgency, maxComments: config.max_comments,
        lenses: config.reviewer_lenses,
        diagrams: config.diagrams, focus,
      },
      codex: config.codex,
      prepareDraft: config.prepare_draft,
      confirm: `PR #${pr} "${meta.title}" @ ${headSha.slice(0, 10)} · urgency ${urgency}: draft carries ${draftScope}; local report shows everything · codex ${config.codex ? "on" : "off"}`,
      warnings,
    }, null, 2) + "\n"
  );
}

const PRIOR_QUERY = `query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$num){
    reviewThreads(first:100){ nodes{ isResolved isOutdated path line
      comments(first:50){ nodes{ author{login} createdAt body } } } }
    comments(first:100){ nodes{ author{login} createdAt body } }
    reviews(first:50){ nodes{ author{login} submittedAt state body } } } } }`;

function gh(args, { raw = false } = {}) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return raw ? out : out.trim();
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().trim();
    if (/auth|login/i.test(msg)) fail(4, "gh is not authenticated; run `gh auth login`");
    fail(4, `gh ${args.slice(0, 2).join(" ")} failed: ${msg.split("\n")[0]}`);
  }
}

function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fail(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

// Minimal reader for the `review_flow:` block of defaults.yaml: scalars, one
// nested map (per_tier_caps) and one list (reviewer_lenses). Avoids a YAML
// dependency for a file this script controls the shape of.
function readReviewDefaults(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out = {};
  let inBlock = false, key = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) { inBlock = line.startsWith("review_flow:"); key = null; continue; }
    if (!inBlock || !line.trim()) continue;
    const m2 = line.match(/^ {2}(\w+):\s*(.*)$/);
    if (m2) {
      key = m2[1];
      out[key] = m2[2] === "" ? undefined : scalar(m2[2]);
      continue;
    }
    const item = line.match(/^ {4}- (\S+)/);
    if (item && key) { (out[key] = Array.isArray(out[key]) ? out[key] : []).push(item[1]); continue; }
    const m4 = line.match(/^ {4}(\w+):\s*(.*)$/);
    if (m4 && key) { (out[key] = out[key] && typeof out[key] === "object" ? out[key] : {})[m4[1]] = scalar(m4[2]); }
  }
  return out;
}

function scalar(s) {
  s = s.trim();
  if (s === "null") return null;
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+$/.test(s)) return Number(s);
  return s.replace(/^["']|["']$/g, "");
}

main();
