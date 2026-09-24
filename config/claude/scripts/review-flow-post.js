#!/usr/bin/env node
// review-flow-post.js — post a review-flow draft as a PENDING GitHub review,
// behind the gates that protect a published review's credibility.
//
//   node review-flow-post.js <run_dir> [--dry-run]
//
// Gates, all re-checked at post time (the user may ask to post long after the
// render):
//   1. a draft exists (no draft-blocked.json, no failed render)
//   2. the PR head still equals the reviewed snapshot; a moved head can
//      invalidate findings in ways a per-finding patch can't see
//   3. no pending review by the current user already exists (GitHub allows
//      one; deleting it to repost resurrects comments the user struck)
//   4. every inline comment anchors to a line in the diff; GitHub rejects the
//      whole review over one bad anchor, so unanchorable comments are folded
//      into the body as `file:line — note`
// `event` stays omitted, so the review is PENDING until the user submits it.
//
// Exit codes: 0 posted (or dry-run passed) · 2 usage · 3 no draft ·
// 4 head moved · 5 pending review exists · 6 POST failed.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function main() {
  const argv = process.argv.slice(2);
  const runDir = argv.find((x) => !x.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  if (!runDir) done(2, { error: "usage: review-flow-post.js <run_dir> [--dry-run]" });
  const outDir = path.join(runDir, "out");
  const draftPath = path.join(outDir, "draft-review.json");
  const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
  const field = (k) => (brief.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) || [])[1];
  const repo = field("repo");
  const pr = field("pr_number");

  // 1. Draft exists.
  if (fs.existsSync(path.join(outDir, "draft-blocked.json"))) {
    const b = JSON.parse(fs.readFileSync(path.join(outDir, "draft-blocked.json"), "utf8"));
    done(3, { error: `draft blocked: ${b.reason}`, hits: b.hits, fix: b.fix });
  }
  if (!fs.existsSync(draftPath)) done(3, { error: "no draft-review.json; render first (a failed render means no draft)" });
  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));

  // 2. Head drift.
  const snapshot = JSON.parse(fs.readFileSync(path.join(outDir, "snapshot.json"), "utf8"));
  const live = gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]);
  if (live !== snapshot.head_sha) {
    const log = gh(["api", `repos/${repo}/compare/${snapshot.head_sha}...${live}`, "--jq", ".commits[].commit.message | split(\"\\n\")[0]"], true);
    done(4, {
      error: "PR head moved since the review; do not post — offer a fresh run",
      reviewed: snapshot.head_sha,
      live,
      new_commits: log ? log.split("\n").filter(Boolean) : "unavailable",
    });
  }

  // 3. Existing pending review.
  const me = gh(["api", "user", "-q", ".login"]);
  const pending = gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/reviews`,
    "--jq", `.[] | select(.state == "PENDING" and .user.login == "${me}") | .html_url`], true);
  if (pending) {
    done(5, { error: "you already have a pending review on this PR; submit, discard or edit it in GitHub first", pending_review: pending.split("\n")[0] });
  }

  // 4. Anchors.
  const anchors = diffAnchors(fs.readFileSync(path.join(outDir, "pr.diff"), "utf8"));
  const ok = [];
  const folded = [];
  for (const c of draft.comments) {
    const side = c.side || "RIGHT";
    const lines = anchors[c.path] && anchors[c.path][side];
    if (lines && lines.has(c.line)) ok.push(c);
    else folded.push(c);
  }
  // The draft must be pinned to the reviewed snapshot, whatever the renderer wrote.
  if (draft.commit_id && draft.commit_id !== snapshot.head_sha) {
    done(3, { error: "draft commit_id differs from the reviewed snapshot; re-render from this run's brief", draft_commit: draft.commit_id, snapshot: snapshot.head_sha });
  }
  const payload = { ...draft, commit_id: snapshot.head_sha, comments: ok };
  if (folded.length) {
    payload.body +=
      "\n\n## Comments outside the diff\n" +
      folded.map((c) => `- \`${c.path}:${c.line}\` — ${c.body.replace(/\n+/g, " ")}`).join("\n");
  }
  const postedPath = path.join(outDir, "draft-review.posted.json");
  fs.writeFileSync(postedPath, JSON.stringify(payload, null, 2));

  const summary = { inline: ok.length, folded_into_body: folded.length, commit_id: payload.commit_id, payload: postedPath };
  if (dryRun) done(0, { dry_run: true, ...summary });

  const res = spawnSync("gh", ["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", postedPath], { encoding: "utf8" });
  if (res.status !== 0) {
    fs.writeFileSync(path.join(outDir, "draft-error.log"), `${res.stdout}\n${res.stderr}`);
    done(6, { error: "POST failed; see out/draft-error.log", ...summary });
  }
  const url = JSON.parse(res.stdout).html_url;
  fs.writeFileSync(path.join(outDir, "draft-url.txt"), url + "\n");
  done(0, { posted: url, ...summary });
}

// {path: {RIGHT: Set(new-side lines in hunks), LEFT: Set(old-side lines)}}
function diffAnchors(diff) {
  const out = {};
  const ensure = (f) => (out[f] = out[f] || { RIGHT: new Set(), LEFT: new Set() });
  let file = null, inHeader = false, oldLn = 0, newLn = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { inHeader = true; file = null; continue; }
    if (inHeader) {
      // Headers only between `diff --git` and the first hunk, so a removed
      // line that itself starts with "-- " is never mistaken for one. A
      // deleted file keeps its old path; everything else uses the new path.
      if (line.startsWith("--- ") && line.slice(4).trim() !== "/dev/null") file = line.slice(4).trim().replace(/^a\//, "");
      if (line.startsWith("+++ ") && line.slice(4).trim() !== "/dev/null") file = line.slice(4).trim().replace(/^b\//, "");
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { inHeader = false; oldLn = Number(h[1]); newLn = Number(h[2]); if (file) ensure(file); continue; }
    if (inHeader || !file || line.startsWith("\\")) continue;
    if (line.startsWith("+")) out[file].RIGHT.add(newLn++);
    else if (line.startsWith("-")) out[file].LEFT.add(oldLn++);
    else if (line.startsWith(" ")) { out[file].RIGHT.add(newLn++); out[file].LEFT.add(oldLn++); }
  }
  return out;
}

function gh(args, soft = false) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    if (soft) return "";
    done(6, { error: `gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || "").trim().split("\n")[0]}` });
  }
  return r.stdout.trim();
}

function done(code, obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

main();
