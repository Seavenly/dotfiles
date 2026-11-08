#!/usr/bin/env node
// review-flow-prep.js — everything /review-flow does before launching the
// workflow, as code rather than prose the host has to re-read each run.
//
//   node review-flow-prep.js <pr> [--repo owner/name] [--urgency hotfix|fast|standard]
//        [--max-comments N] [--lenses a,b,c] [--prepare-draft] [--no-codex]
//        [--depth quick|full] [--focus "text"] [--allow-closed]
//        [--since-last-review] [--at-base <sha> --at-head <sha>]
//
// Pins one snapshot (head SHA, base SHA, diff digest, checkout SHA) so every
// later step reviews, renders and posts against the same comparison; clones
// that exact SHA detached (`gh pr checkout` fails in a shallow clone); writes
// the stated intent, prior review conversation and brief; and prints one JSON
// object: { runDir, launchArgs, confirm, warnings }.
//
// Also, all fail-soft (a warning, never a head-copy fallback):
//   out/repo-rules/      rule files (CLAUDE.md, AGENTS.md, REVIEW.md) as of the
//                        base revision. A PR that edits them is reviewed under
//                        the rules it proposes to change, never its own.
//   out/ci-annotations.json  check-run annotations on the reviewed head
//   out/unreviewable.json    changed files with no patch in the diff
// If `gh pr diff` fails (usually a diff too large for the API), the diff is
// computed from the clone against the merge base instead.
//
// Replay (--at-base/--at-head): a manual regression run against frozen
// revisions (review-flow-evals.md). The diff is `git diff <base> <head>` from
// the clone, prior review threads are withheld (they would leak the answer),
// and the brief is marked `replay: true`, which review-flow-post.js refuses.
//
// Delta re-review (--since-last-review): the comparison base is the commit of
// the current gh user's most recent submitted review (not an empty COMMENTED
// one, which is a thread reply); the head stays the PR
// head. out/delta.diff (that commit..head, limited to the PR's changed files)
// is the review scope; out/pr.diff stays the full PR diff, the context and
// the anchor set GitHub comments attach to. No such review, or a commit that
// is gone or no longer an ancestor of head (force-push, rebase): a full
// review with a warning.
//
// Exit codes: 0 ok · 2 usage · 3 PR not open (re-run with --allow-closed) ·
// 4 gh or git failure · 5 delta re-review with nothing new since that review.

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
  const depth = opt("depth") || defaults.depth || "full";
  if (!["quick", "full"].includes(depth)) fail(2, `unknown depth: ${depth} (quick or full)`);
  const config = {
    urgency,
    depth,
    max_comments: Number(opt("max-comments") || defaults.max_comments || 20),
    per_tier_caps: defaults.per_tier_caps || { critical: null, important: null, recommended: 10, nit: 3 },
    reviewer_lenses: opt("lenses") ? opt("lenses").split(",") : defaults.reviewer_lenses,
    prepare_draft: flag("prepare-draft"),
    codex: flag("no-codex") ? false : defaults.codex_cross_check !== false,
  };
  const focus = opt("focus") || null;
  const warnings = [];
  const atBase = opt("at-base"), atHead = opt("at-head");
  const replay = Boolean(atBase || atHead);
  if (replay && !(isSha(atBase) && isSha(atHead))) fail(2, "replay needs both --at-base and --at-head as full 40-character SHAs");
  if (replay && flag("since-last-review")) fail(2, "--since-last-review can't be combined with a replay (--at-base/--at-head)");
  if (replay && config.prepare_draft) {
    config.prepare_draft = false;
    warnings.push("replay run: --prepare-draft ignored; replay runs can never be posted");
  }

  const repo = opt("repo") || gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const [owner, name] = repo.split("/");
  const meta = JSON.parse(
    gh(["pr", "view", pr, "--repo", repo, "--json",
      "title,body,state,url,baseRefName,headRefName,headRefOid,baseRefOid,changedFiles,closingIssuesReferences"])
  );
  if (meta.state !== "OPEN" && !flag("allow-closed") && !replay) {
    fail(3, `PR #${pr} is ${meta.state}; confirm with the user, then re-run with --allow-closed`);
  }

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const runId = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-pr-${pr}${replay ? "-replay" : ""}`;
  const runDir = path.join(os.homedir(), ".agent-teams", "runs", runId);
  const outDir = path.join(runDir, "out");
  const repoDir = path.join(runDir, "repo");
  fs.mkdirSync(path.join(outDir, "findings"), { recursive: true });

  // Diff + head, re-read until stable: a push between the reads would pair a
  // diff with the wrong SHA. A failed `gh pr diff` (usually too large for the
  // API) leaves diff null; it is computed from the clone below.
  let headSha, baseSha, diff = null, diffError = null, stable = false;
  if (replay) {
    headSha = atHead;
    baseSha = atBase;
    stable = true;
  }
  for (let i = 0; i < 3 && !stable; i++) {
    const before = gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]);
    const got = ghSoft(["pr", "diff", pr, "--repo", repo]);
    diff = got.ok ? got.out : null;
    diffError = got.ok ? null : got.err;
    const after = JSON.parse(gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid,baseRefOid"]));
    headSha = after.headRefOid;
    baseSha = after.baseRefOid;
    stable = before === headSha;
  }
  if (!stable) fail(4, `PR #${pr} head changed on every read (someone is pushing); try again once it settles`);

  // Checkout of exactly that SHA, plus the base commit for the repo rules
  // (and, when needed, a locally computed diff).
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
  const haveBase = cloned &&
    (step("git", ["cat-file", "-e", `${baseSha}^{commit}`], repoDir) ||
      step("git", ["fetch", "-q", "--depth=1", "origin", baseSha], repoDir));
  const checkoutSha = cloned ? tryRun("git", ["-C", repoDir, "rev-parse", "HEAD"]) : null;
  const haveCheckout = checkoutSha === headSha;
  if (!haveCheckout) warnings.push("no checkout — diff-only review; absence and mechanism claims are lower confidence (see out/clone.log)");

  let diffSource = "gh";
  if (diff === null) {
    diffSource = "local";
    diff = haveCheckout && haveBase ? localDiff(repoDir, baseSha, headSha, !replay, step) : null;
    if (diff === null) {
      fs.writeFileSync(path.join(outDir, "clone.log"), cloneLog.join("\n"));
      fail(4, replay
        ? "replay needs a clone with both revisions; see out/clone.log"
        : `gh pr diff failed (${diffError}) and the diff could not be computed from a clone; see out/clone.log`);
    }
    if (!replay) warnings.push(`gh pr diff failed (${diffError}); the diff was computed from the clone against the merge base`);
  }
  fs.writeFileSync(path.join(outDir, "pr.diff"), diff);

  // Changed-file census: every changed file must have a patch in the diff, or
  // it is recorded as unreviewable rather than silently treated as reviewed.
  const census = changedFileCensus({ replay, repo, pr, repoDir, baseSha, headSha, diff, haveBase, haveCheckout, expected: meta.changedFiles });

  const delta = flag("since-last-review")
    ? deltaSinceLastReview({ repo, pr, repoDir, headSha, haveCheckout, diff, changed: census.changed, step, warnings })
    : null;
  fs.writeFileSync(path.join(outDir, "clone.log"), cloneLog.join("\n"));
  if (delta && delta.empty) {
    fs.rmSync(runDir, { recursive: true, force: true });
    fail(5, `nothing new to review: ${delta.empty}`);
  }
  const deltaPath = path.join(outDir, "delta.diff");
  if (delta) fs.writeFileSync(deltaPath, delta.diff);

  const crypto = require("node:crypto");
  const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
  fs.writeFileSync(
    path.join(outDir, "snapshot.json"),
    JSON.stringify({
      head_sha: headSha,
      base_sha: baseSha,
      diff_sha256: sha256(diff),
      diff_source: diffSource,
      checkout_sha: checkoutSha,
      ...(replay ? { replay: true, comparison: `${baseSha}..${headSha}` } : {}),
      ...(delta ? { delta: {
        since_sha: delta.sinceSha, since_reviewed_at: delta.reviewedAt, reviewer: delta.login,
        diff_sha256: sha256(delta.diff), files: delta.files, dropped_files: delta.dropped.length,
      } } : {}),
      fetched_at: new Date().toISOString(),
    }, null, 2)
  );
  const unreviewablePath = path.join(outDir, "unreviewable.json");
  const { changed: changedPaths, ...censusRecord } = census;
  fs.writeFileSync(unreviewablePath, JSON.stringify(censusRecord, null, 2));
  if (census.files.length) {
    warnings.push(`${census.files.length} changed file(s) have no patch in the diff (binary, too large or truncated) and are not reviewed from the diff: see out/unreviewable.json`);
  }
  if (!census.list_complete) warnings.push(`changed-file list is incomplete (${census.note}); coverage of the unlisted files is unknown`);

  // Repo rules from the base revision. Never fall back to the checkout's
  // copies: a PR that edits them would be reviewed under its own rules.
  const rules = haveBase ? extractRepoRules(repoDir, baseSha, changedPaths, path.join(outDir, "repo-rules")) : null;
  if (!rules) warnings.push("repo rules unavailable: the base revision could not be read, so the review runs without repo rules (the checkout's copies are not used)");
  if (rules && rules.changed_by_pr.length) warnings.push(`PR edits rule file(s) ${rules.changed_by_pr.join(", ")}; reviewing under the base-revision copies`);

  // CI annotations on the reviewed head (replay: the frozen head's own runs).
  const ci = fetchCiAnnotations(repo, headSha, census.list_complete ? new Set(changedPaths) : null);
  const ciPath = path.join(outDir, "ci-annotations.json");
  if (ci) fs.writeFileSync(ciPath, JSON.stringify(ci, null, 2));
  else warnings.push("CI annotations could not be fetched for this head; reviewers get none");

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
  // that as unknown overlap, never as a clean slate. A replay withholds it:
  // later review discussion would hand the reviewers the expected answer.
  const priorPath = path.join(outDir, "prior-review.json");
  let priorReviewPath = null;
  const prior = replay ? null : tryRun("gh", ["api", "graphql", "-f", `query=${PRIOR_QUERY}`,
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
  } else if (!replay) {
    warnings.push("prior review conversation could not be fetched; overlap with existing threads is unknown");
  }

  const guide = rules
    ? ["REVIEW.md", ".github/REVIEW.md"].filter((f) => rules.files.includes(f)).map((f) => path.join(rules.dir, f))[0] || null
    : null;

  // A quick set is audited only by Codex, so without it the run can't be posted.
  const unpostable = "; a quick review without the Codex audit cannot be posted";
  if (config.codex) {
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      warnings.push(`Codex cross-check will be skipped: ${probe.error ? "codex not found" : "not logged in (run `codex login`)"}${depth === "quick" ? unpostable : ""}`);
    }
  } else if (depth === "quick") {
    warnings.push(`depth quick with codex off${unpostable}`);
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
${replay ? `replay: true
comparison: ${baseSha}..${headSha}
` : ""}${delta ? `since_sha: ${delta.sinceSha}
since_reviewed_at: ${delta.reviewedAt}
` : ""}config:
  urgency: ${config.urgency}
  depth: ${config.depth}
  max_comments: ${config.max_comments}
  per_tier_caps:
${Object.entries(config.per_tier_caps).map(([k, v]) => `    ${k}: ${v === null ? "null" : v}`).join("\n")}
  reviewer_lenses: [${config.reviewer_lenses.join(", ")}]
  prepare_draft: ${config.prepare_draft}
  codex: ${config.codex}
focus: ${focus ? yamlStr(focus) : "null"}
---

# Review brief
PR #${pr}: ${meta.title}
Stated intent: out/pr-body.md
${focus ? `Focus: ${focus}` : ""}${replay ? `\nReplay of frozen revisions ${baseSha.slice(0, 10)}..${headSha.slice(0, 10)} (manual regression run; never posted).` : ""}${delta ? `\nDelta re-review: only the changes since ${delta.login}'s review of ${delta.reviewedAt.slice(0, 10)}, ${delta.sinceSha.slice(0, 10)}..${headSha.slice(0, 10)} (out/delta.diff); the full PR diff (out/pr.diff) is context.` : ""}
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
        repoRulesDir: rules ? rules.dir : null,
        repoRuleFiles: rules ? rules.files : [],
        ruleFilesChanged: rules ? rules.changed_by_pr : [],
        ciAnnotationsPath: ci && ci.annotations.length ? ciPath : null,
        unreviewablePath: census.files.length ? unreviewablePath : null,
        replay,
        delta: delta
          ? { sinceSha: delta.sinceSha, reviewedAt: delta.reviewedAt, path: deltaPath, scope: deltaScope({ ...delta, headSha, deltaPath }) }
          : null,
        prNumber: Number(pr), prTitle: meta.title, repo, prUrl: meta.url, headSha,
        urgency, depth, maxComments: config.max_comments,
        lenses: config.reviewer_lenses,
        focus,
      },
      codex: config.codex,
      prepareDraft: config.prepare_draft,
      confirm: `${replay ? `REPLAY ${baseSha.slice(0, 10)}..` : ""}${delta ? `RE-REVIEW since your review of ${delta.reviewedAt.slice(0, 10)}: ${delta.sinceSha.slice(0, 10)}..${headSha.slice(0, 10)}, ${delta.commits} new commit(s) touching ${delta.files} of ${census.changed.length} changed files · ` : ""}PR #${pr} "${meta.title}" @ ${headSha.slice(0, 10)} · depth ${depth}${depth === "quick" ? " (one reviewer, Codex audits)" : ""} · urgency ${urgency}: draft carries ${draftScope}; local report shows everything · codex ${config.codex ? "on" : "off"}${replay ? " · posting disabled" : ""}`,
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

// The delta base: the commit of the current gh user's most recent submitted
// review. An empty COMMENTED review is a thread reply or a single comment, not
// a review of the code, so it is skipped: an older base never skips code. null (a full review, with a warning) when there is none or it can't
// be used; { empty } when nothing the PR changes moved since it.
function deltaSinceLastReview({ repo, pr, repoDir, headSha, haveCheckout, diff, changed, step, warnings }) {
  const full = (why) => {
    warnings.push(`--since-last-review: ${why}; running a full review instead`);
    return null;
  };
  const me = tryRun("gh", ["api", "user", "-q", ".login"]);
  const out = me ? tryRun("gh", ["api", "--paginate", `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
    "--jq", ".[] | {login: .user.login, state, commit_id, submitted_at, body}"]) : null;
  if (out === null) return full("your reviews on this PR could not be read");
  const mine = out.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.login === me && r.state !== "PENDING" && r.submitted_at && r.commit_id);
  const last = mine
    .filter((r) => ["APPROVED", "CHANGES_REQUESTED"].includes(r.state) || (r.state === "COMMENTED" && (r.body || "").trim()))
    .sort((x, y) => x.submitted_at.localeCompare(y.submitted_at))
    .pop();
  if (!last) {
    return full(mine.length
      ? `${me}'s submitted reviews on this PR are only thread replies or single comments (COMMENTED with no body), none a review of the code`
      : `${me} has no submitted review on this PR`);
  }
  const since = last.commit_id, at = last.submitted_at;
  const which = `your review of ${at.slice(0, 10)} at ${since.slice(0, 10)}`;
  if (since === headSha) return { empty: `the PR head is still the commit of ${which}` };
  if (!haveCheckout) return full(`no checkout to compute the changes since ${which}`);

  const cmp = ghSoft(["api", `repos/${repo}/compare/${since}...${headSha}`, "--jq",
    "[.status, .ahead_by, ([.commits[] | select((.parents | length) > 1)] | length)] | @tsv"]);
  if (!cmp.ok) {
    return full(/404|not found/i.test(cmp.err)
      ? `the commit of ${which} is no longer in the repository (force-pushed away?)`
      : `could not compare ${which} with the PR head (${cmp.err})`);
  }
  const [status, aheadBy, merges] = cmp.out.trim().split("\t");
  if (status !== "ahead") return full(`the commit of ${which} is no longer an ancestor of the PR head (status ${status}): the branch was force-pushed or rebased since`);
  if (Number(merges)) warnings.push(`the ${aheadBy} new commits include ${merges} merge(s); delta hunks the full PR diff doesn't contain came from the merged branch`);

  const fetched = step("git", ["cat-file", "-e", `${since}^{commit}`], repoDir) ||
    step("git", ["fetch", "-q", "--depth=1", "origin", since], repoDir);
  const raw = fetched ? localDiff(repoDir, since, headSha, false, step) : null;
  if (raw === null) return full(`the changes since ${which} could not be computed from the clone (see out/clone.log)`);

  // Files the PR doesn't change (reverted since, or from a merged branch) are out of scope.
  const keep = new Set(changed);
  for (const b of diffBlocks(diff)) if (b.oldPath) keep.add(b.oldPath);
  const kept = [], dropped = [];
  for (const part of raw.split(/^(?=diff --git )/m).filter(Boolean)) {
    const b = diffBlocks(part)[0];
    if (b && !keep.has(b.path) && !(b.oldPath && keep.has(b.oldPath))) dropped.push(b.path);
    else kept.push(part);
  }
  if (!kept.length) {
    return { empty: `none of the PR's changes moved since ${which}${dropped.length ? ` (only ${dropped.length} file(s) the PR doesn't change did)` : ""}` };
  }
  if (dropped.length) warnings.push(`${dropped.length} file(s) changed since ${which} are not changed by the PR (reverted, or from a merged branch) and are left out of the delta: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}`);
  return { login: me, sinceSha: since, reviewedAt: at, commits: Number(aheadBy), diff: kept.join(""), files: kept.length, dropped };
}

// The one statement of a delta re-review's scope, injected into every
// reviewing prompt (lenses, quick reviewer, critic, verifier, Codex).
function deltaScope({ login, sinceSha, reviewedAt, headSha, deltaPath }) {
  const s = sinceSha.slice(0, 10);
  return `Delta re-review: ${login} already reviewed this PR at ${s} on ${reviewedAt.slice(0, 10)}. The changes since then (${s}..${headSha.slice(0, 10)}) are in ${deltaPath}; judge only those, and treat the rest of the PR as context. Raise an issue in earlier code only when the new commits make it worse or newly reachable. A delta hunk the full PR diff doesn't contain came from a merged branch, not the author. Don't repeat a point from the prior threads; where the new commits address one of ${login}'s open threads, that is not a finding. Anchor lines in the full PR diff, which is what review comments attach to.`;
}

const RULE_FILES = new Set(["CLAUDE.md", "AGENTS.md", "REVIEW.md"]);

// Rule files as of the base revision: root and .github/ REVIEW.md, plus every
// CLAUDE.md / AGENTS.md at the root or in a directory containing a changed
// file. Written under out/repo-rules/ with their repo paths. null on failure.
function extractRepoRules(repoDir, baseSha, changedPaths, dir) {
  const tree = tryRun("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", baseSha]);
  if (tree === null) return null;
  const dirs = new Set([""]);
  for (const p of changedPaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const files = tree.split("\n").filter((f) => {
    const base = path.posix.basename(f), d = path.posix.dirname(f) === "." ? "" : path.posix.dirname(f);
    if (base === "REVIEW.md") return f === "REVIEW.md" || f === ".github/REVIEW.md";
    return RULE_FILES.has(base) && dirs.has(d);
  });
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const f of files) {
    const r = spawnSync("git", ["-C", repoDir, "show", `${baseSha}:${f}`], { maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) continue;
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), r.stdout);
    written.push(f);
  }
  const changed_by_pr = changedPaths.filter((p) => RULE_FILES.has(path.posix.basename(p)));
  const manifest = { base_sha: baseSha, files: written, changed_by_pr };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, ...manifest };
}

// Changed files versus the patches present in the diff. The list comes from
// the REST files endpoint (paginated; GitHub caps it at 3000 files), or from
// git for a replay. A file with no hunk that isn't a pure rename, mode change
// or empty file had content nobody can review from the diff.
function changedFileCensus({ replay, repo, pr, repoDir, baseSha, headSha, diff, haveBase, haveCheckout, expected }) {
  const blocks = diffBlocks(diff);
  let listed = null, listComplete = true, note = null;
  if (replay) {
    const out = haveBase && haveCheckout
      ? tryRun("git", ["-C", repoDir, "-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", baseSha, headSha])
      : null;
    listed = out === null ? null : out.split("\n").filter(Boolean);
  } else {
    const out = tryRun("gh", ["api", "--paginate", `repos/${repo}/pulls/${pr}/files?per_page=100`, "--jq", ".[].filename"]);
    listed = out === null ? null : out.split("\n").filter(Boolean);
    if (listed && typeof expected === "number" && listed.length < expected) {
      listComplete = false;
      note = `GitHub listed ${listed.length} of ${expected} changed files`;
    }
  }
  if (listed === null) {
    listComplete = false;
    note = "the changed-file list could not be fetched; only the diff itself was checked";
  }
  // --no-renames lists a rename as delete + add; match either side.
  const inDiff = new Map();
  for (const b of blocks) {
    inDiff.set(b.path, b);
    if (b.oldPath) inDiff.set(b.oldPath, b);
  }
  const files = [];
  const seen = new Set();
  for (const b of blocks) {
    const reason = b.binary ? "binary" : !b.hunks && !b.benign ? "no patch in the diff" : null;
    if (reason && !seen.has(b.path)) { files.push({ path: b.path, reason }); seen.add(b.path); }
  }
  for (const f of listed || []) {
    if (!inDiff.has(f) && !seen.has(f)) { files.push({ path: f, reason: "missing from the diff (too large or truncated)" }); seen.add(f); }
  }
  const changed = [...new Set([...(listed || []), ...blocks.map((b) => b.path)])];
  return { source: replay ? "git" : "github", listed: listed ? listed.length : null, expected: replay ? null : expected ?? null, list_complete: listComplete, note, files, changed };
}

// One entry per `diff --git` block: its path, whether it has hunks, and
// whether a hunk-less block is explained (rename, mode change, empty file).
function diffBlocks(diff) {
  const blocks = [];
  let b = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    if (m) {
      b = { path: m[2], oldPath: m[1] !== m[2] ? m[1] : null, hunks: false, binary: false, benign: false };
      blocks.push(b);
      continue;
    }
    if (!b || b.hunks) continue;
    if (line.startsWith("@@ ")) b.hunks = true;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") b.binary = true;
    else if (/^(similarity index 100%|old mode |new mode |new file mode |deleted file mode )/.test(line)) b.benign = true;
    else if (line.startsWith("+++ ") && line.slice(4) !== "/dev/null") b.path = line.slice(4).replace(/^b\//, "");
  }
  return blocks;
}

// Check-run annotations on one commit, capped. Only annotations on changed
// files are kept when the list is complete; others can't bear on this diff.
// null when the check runs can't be fetched.
function fetchCiAnnotations(repo, sha, changed) {
  const MAX = 200, MSG = 500;
  const runsOut = tryRun("gh", ["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    "--jq", ".check_runs[] | {id, name, conclusion, count: .output.annotations_count}"]);
  if (runsOut === null) return null;
  const runs = runsOut.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const annotations = [];
  let dropped = 0, failedRuns = 0;
  for (const run of runs.filter((r) => r.count > 0)) {
    const out = tryRun("gh", ["api", "--paginate", `repos/${repo}/check-runs/${run.id}/annotations?per_page=100`,
      "--jq", ".[] | {path, line: .start_line, end_line, level: .annotation_level, title, message}"]);
    if (out === null) { failedRuns++; continue; }
    for (const l of out.split("\n").filter(Boolean)) {
      const x = JSON.parse(l);
      if ((changed && !changed.has(x.path)) || annotations.length >= MAX) { dropped++; continue; }
      annotations.push({ check: run.name, ...x, message: (x.message || "").slice(0, MSG) });
    }
  }
  return {
    head_sha: sha,
    fetched_at: new Date().toISOString(),
    runs: runs.map((r) => ({ name: r.name, conclusion: r.conclusion, annotations: r.count || 0 })),
    annotations,
    dropped,
    failed_runs: failedRuns,
    note: `capped at ${MAX}; only annotations on changed files are kept`,
  };
}

// The comparison as a diff from the clone, with prefixes and rename detection
// pinned so user git config can't change its shape. threeDot (a live PR) diffs
// from the merge base, as GitHub does, deepening the shallow clone to find it.
function localDiff(repoDir, baseSha, headSha, threeDot, step) {
  let from = baseSha;
  if (threeDot) {
    from = tryRun("git", ["-C", repoDir, "merge-base", baseSha, headSha]);
    for (const depth of [500, 5000]) {
      if (from) break;
      step("git", ["fetch", "-q", `--depth=${depth}`, "origin", baseSha, headSha], repoDir);
      from = tryRun("git", ["-C", repoDir, "merge-base", baseSha, headSha]);
    }
    if (!from) return null;
  }
  const r = spawnSync("git", ["-C", repoDir, "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "core.quotePath=false",
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/", from, headSha],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function isSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

// gh without exiting: { ok, out } or { ok: false, err }. Auth failures still exit.
function ghSoft(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) return { ok: true, out: r.stdout };
  const msg = (r.stderr || (r.error && r.error.message) || "").toString().trim();
  if (/auth|login/i.test(msg)) fail(4, "gh is not authenticated; run `gh auth login`");
  return { ok: false, err: msg.split("\n")[0] || `exit ${r.status}` };
}

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

// Codex builds its prompt with the same delta scope.
module.exports = { deltaScope };
if (require.main === module) main();
