#!/usr/bin/env node
// render-review.js — render review-flow output as review.md and the draft
// payload. The HTML overview is written separately by the explainer agent.
//
// Reads:
//   <run_dir>/brief.md             (since_sha marks a delta re-review)
//   <run_dir>/out/comments.json
//   <run_dir>/out/orientation.md   (optional)
//   <run_dir>/out/findings/<lens>.json, repo-rules/manifest.json,
//     ci-annotations.json, unreviewable.json   (optional; the Coverage
//     section, local report only, never in the draft)
//
// Writes:
//   <run_dir>/out/review.md          — LOCAL report: every finding, each marked
//                                      "in draft" or "local only: <reason>"
//   <run_dir>/out/draft-review.json  — author-facing payload, ONLY when the
//                                      publication gate passes; otherwise
//   <run_dir>/out/draft-blocked.json — why no draft was written
//
// comments.json is the full validated set (no caps); this script owns the
// policy cut, and the cut applies to the DRAFT only. The local report always
// shows everything, so an urgency floor or a cap never works as a silent
// strike. Draft selection, in order: pre-existing findings are local only;
// the urgency floor; per-tier caps; then the global max_comments budget, which
// criticals and importants are exempt from.
//
// Per-finding fields: id, path, line, side, tier, lens, body (author-facing),
// evidence (local only — never posted), confidence (0-1, optional),
// pre_existing (bool, optional), draft (false = hold out of the draft).
//
// Set-level fields from the workflow (optional; absent = full):
//   depth           — "quick": one reviewer, criticals and importants only, and
//                     Codex as its only audit; shown in review.md, never posted
//   escalate        — quick only: why the PR deserves a full review, or null
//
// Set-level fields written after the Claude passes (all optional):
//   decisions[]     — judgment calls for the human; local only, never posted
//   cross_check     — Codex cross-check status and counts
//   contested[]     — {finding, rebuttal, evidence, resolution}: findings Codex
//                     disputed. resolution "restore" puts the finding back in
//                     the running; "strike" keeps it out; null keeps it out AND,
//                     for a critical/important, blocks the draft until decided
//   codex_raised[]  — findings only Codex raised; local only until the human
//                     moves one into inline/general

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TIER_ORDER = ["critical", "important", "recommended", "nit"];
const TIER_TITLES = {
  critical: "Critical",
  important: "Important",
  recommended: "Recommended",
  nit: "Nits",
};
const URGENCY_TIERS = {
  hotfix: ["critical"],
  fast: ["critical", "important"],
  standard: TIER_ORDER,
};
const POSTURE_LABEL = {
  do_not_merge: "do not merge",
  merge_after_fixes: "merge after fixes",
  merge_ready_with_followups: "merge ready with follow-ups",
};

function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: render-review.js <run_dir>");
    process.exit(2);
  }

  // Map a docker-visible path to a clickable host file:// URL. The default
  // mirrors the standard at-* worker mount (/workspace -> host home dir); both
  // ends are env-overridable so the mapping stays out of the committed script.
  const hostFileUrl = (p) => {
    const containerPrefix =
      process.env.AGENT_TEAMS_CONTAINER_PREFIX || "/workspace";
    const hostPrefix =
      process.env.AGENT_TEAMS_HOST_PREFIX || os.homedir();
    const hostPath = p.startsWith(containerPrefix)
      ? hostPrefix + p.slice(containerPrefix.length)
      : p;
    return "file://" + encodeURI(hostPath);
  };

  const briefPath = path.join(runDir, "brief.md");
  const commentsPath = path.join(runDir, "out", "comments.json");
  const orientationPath = path.join(runDir, "out", "orientation.md");
  const reviewMdPath = path.join(runDir, "out", "review.md");
  const draftPath = path.join(runDir, "out", "draft-review.json");

  const draftBlockedPath = path.join(runDir, "out", "draft-blocked.json");

  // A draft from an earlier render must never survive a failed one: remove it
  // before doing anything else, and write the new one only after the gate.
  for (const p of [draftPath, draftBlockedPath]) fs.rmSync(p, { force: true });

  const brief = parseFrontmatter(fs.readFileSync(briefPath, "utf8"));
  const comments = JSON.parse(fs.readFileSync(commentsPath, "utf8"));
  const orientation = fs.existsSync(orientationPath)
    ? trimOrientation(fs.readFileSync(orientationPath, "utf8"))
    : null;
  const coverage = loadCoverage(runDir, brief);

  const urgency =
    (brief.config && brief.config.urgency) || comments.urgency || "standard";
  const perTierCaps = (brief.config && brief.config.per_tier_caps) || {
    critical: null,
    important: null,
    recommended: 10,
    nit: 3,
  };
  const maxComments = (brief.config && brief.config.max_comments) || 20;

  // General (non-anchorable) findings obey the same policy and share the same
  // budget, but never become inline code comments — they render into a body
  // section and the posted review body.
  // Contested findings the human restored rejoin the set; the rest stay out.
  const contested = comments.contested || [];
  const restored = contested.filter((x) => x.resolution === "restore").map((x) => x.finding);
  const unresolvedSevere = contested.filter(
    (x) => !x.resolution && ["critical", "important"].includes(x.finding.tier)
  );

  const policy = applyPolicy(
    [...(comments.inline || []), ...restored.filter((f) => f.kind !== "general")],
    [...(comments.general || []), ...restored.filter((f) => f.kind === "general")],
    urgency,
    perTierCaps,
    maxComments
  );

  const ctx = {
    prNumber: brief.pr_number,
    prTitle: brief.pr_title || `(PR #${brief.pr_number})`,
    repo: brief.repo || null,
    headSha: brief.head_sha || null,
    urgency,
    posture: comments.posture,
    postureLabel: POSTURE_LABEL[comments.posture] || comments.posture,
    postureRationale: comments.posture_rationale || null,
    cluster: comments.cluster || null,
    orientation,
    coverage,
    replay: brief.replay === true ? brief.comparison || true : null,
    since: brief.since_sha ? { sha: String(brief.since_sha), at: String(brief.since_reviewed_at || "") } : null,
    quick: comments.depth === "quick",
    escalate: comments.escalate || null,
    // Local report: every finding by tier, each carrying `excluded` (null when
    // it is in the draft). Draft: only the included subset.
    all: policy.all,
    generalAll: policy.generalAll,
    preExisting: policy.preExisting,
    kept: policy.kept,
    generalKept: policy.generalKept,
    excludedCounts: policy.excludedCounts,
    totalFindings: policy.totalFindings,
    totalKept: policy.totalKept,
    maxComments,
    perTierCaps,
    decisions: comments.decisions || [],
    crossCheck: comments.cross_check || null,
    contested,
    codexRaised: comments.codex_raised || [],
    draftBlocked: null,
  };
  // The verdict was set by the Claude passes. If the cross-check moved a
  // critical/important, say so rather than presenting a stale verdict as final.
  const cc = ctx.crossCheck;
  ctx.postureCaveat =
    cc && cc.status === "applied" && cc.posture_affected
      ? `posture set before the Codex cross-check, which changed or contested ${cc.severe_changes} critical/important finding(s); re-derive it if you accept those changes`
      : null;

  // Publication gate. Anything that fails here means NO draft payload exists —
  // the local report still renders so the problem can be fixed at the source
  // (comments.json) and re-rendered.
  const draft = renderDraft(ctx);
  const secretHits = scanForSecrets(draft);
  if (unresolvedSevere.length > 0) {
    ctx.draftBlocked = {
      reason: `${unresolvedSevere.length} contested critical/important finding(s) need your call`,
      fix: "Decide each one: set its `contested[].resolution` to `restore` or `strike` in comments.json, then re-render.",
      hits: unresolvedSevere.map((x) => ({
        where: `${x.finding.id} (${x.finding.path || "general"}${x.finding.line ? `:${x.finding.line}` : ""})`,
        pattern: `set contested[].resolution to "restore" or "strike" in comments.json`,
      })),
    };
  } else if (secretHits.length > 0) {
    ctx.draftBlocked = {
      reason: "possible secret in author-facing text",
      fix: "Edit the finding in comments.json to describe where the secret is, never quote it, then re-render.",
      hits: secretHits,
    };
  }

  fs.writeFileSync(reviewMdPath, renderMarkdown(ctx));
  if (ctx.draftBlocked) {
    fs.writeFileSync(draftBlockedPath, JSON.stringify(ctx.draftBlocked, null, 2));
  } else {
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  }

  // Stdout for the lead to copy into the wrap-up message.
  process.stdout.write(
    JSON.stringify({
      review_md: reviewMdPath,
      draft_review: ctx.draftBlocked ? null : draftPath,
      draft_blocked: ctx.draftBlocked,
      review_md_url: hostFileUrl(reviewMdPath),
      counts: tierCounts(policy.all),
      draft_counts: tierCounts(policy.kept),
      general_counts: tierCounts(policy.generalKept),
      pre_existing: policy.preExisting.length,
      total_findings: policy.totalFindings,
      draft_total: policy.totalKept,
      excluded: policy.excludedCounts,
      coverage_gaps: coverageGaps(ctx.coverage),
    }) + "\n"
  );
}

// ---------- policy ----------

const EXCLUDE_LABEL = {
  manual: () => "held back by the reviewer",
  urgency: (ctx) => `below the \`${ctx.urgency}\` urgency floor`,
  tier_cap: (ctx, tier) => `over the ${tier} cap (${ctx.perTierCaps[tier]})`,
  budget: (ctx) => `over the max_comments budget (${ctx.maxComments})`,
};

// Decides which findings go in the draft. Nothing is removed: every finding is
// returned in `all`/`generalAll` with `excluded` set to a reason code or null.
function applyPolicy(inline, general, urgency, perTierCaps, maxComments) {
  const allowed = URGENCY_TIERS[urgency] || TIER_ORDER;
  const tag = (list, kind) =>
    list.map((c) => ({ ...c, kind, excluded: null }));
  const findings = [...tag(inline, "inline"), ...tag(general, "general")];

  // Pre-existing bugs are real but not this PR's doing: local only, and they
  // never count toward the draft or the posture.
  const preExisting = findings.filter((c) => c.pre_existing);
  const candidates = findings.filter((c) => !c.pre_existing && TIER_ORDER.includes(c.tier));

  // Within a tier, higher-confidence findings win the caps. Missing
  // confidence sorts as neutral; the sort is stable so critic order is the
  // tie-break.
  const conf = (c) => (typeof c.confidence === "number" ? c.confidence : 0.5);
  const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
  for (const c of candidates) byTier[c.tier].push(c);
  for (const t of TIER_ORDER) byTier[t].sort((a, b) => conf(b) - conf(a));

  // Criticals and importants are exempt from the budget, so it is spent on
  // them first and the remainder goes to lower tiers in tier order.
  let budget = maxComments;
  for (const tier of TIER_ORDER) {
    const exempt = tier === "critical" || tier === "important";
    const cap = perTierCaps[tier];
    let inTier = 0;
    for (const c of byTier[tier]) {
      if (c.draft === false) c.excluded = "manual";
      else if (!allowed.includes(tier)) c.excluded = "urgency";
      else if (cap != null && inTier >= cap) c.excluded = "tier_cap";
      else if (!exempt && budget <= 0) c.excluded = "budget";
      else {
        inTier++;
        budget--;
      }
    }
  }

  const split = (kind, keep) =>
    Object.fromEntries(
      TIER_ORDER.map((t) => [
        t,
        byTier[t].filter((c) => c.kind === kind && (!keep || !c.excluded)),
      ])
    );
  const all = split("inline", false);
  const generalAll = split("general", false);
  const kept = split("inline", true);
  const generalKept = split("general", true);

  const excludedCounts = {};
  for (const c of candidates) {
    if (!c.excluded) continue;
    excludedCounts[c.excluded] = excludedCounts[c.excluded] || {};
    excludedCounts[c.excluded][c.tier] = (excludedCounts[c.excluded][c.tier] || 0) + 1;
  }

  const count = (m) => TIER_ORDER.reduce((n, t) => n + m[t].length, 0);
  return {
    all,
    generalAll,
    preExisting,
    kept,
    generalKept,
    excludedCounts,
    totalFindings: candidates.length,
    totalKept: count(kept) + count(generalKept),
  };
}

// The opening line: findings by tier (only tiers present), or plainly none.
// `scope` names the urgency floor, so an empty hotfix draft doesn't claim more.
function countLine(inline, general, scope) {
  const n = (t) => inline[t].length + general[t].length;
  const total = TIER_ORDER.reduce((sum, t) => sum + n(t), 0);
  if (!total) return `**No ${scope}issues found.**`;
  const parts = TIER_ORDER.filter(n).map((t) => `${n(t)} ${t}${t === "nit" && n(t) > 1 ? "s" : ""}`);
  return `**${total} finding${total > 1 ? "s" : ""}:** ${parts.join(", ")}.`;
}

function tierCounts(byTier) {
  return Object.fromEntries(TIER_ORDER.map((t) => [t, byTier[t].length]));
}

function excludedNote(ctx, c) {
  return c.excluded ? EXCLUDE_LABEL[c.excluded](ctx, c.tier) : null;
}

function crossCheckLine(cc) {
  if (!cc) return null;
  if (cc.status !== "applied") return `⚠ Codex cross-check ${cc.status}: ${cc.reason}`;
  return `Codex cross-check (${cc.model}, ${cc.effort}, ${cc.duration_s}s): kept ${cc.kept}, strengthened ${cc.strengthened}, down-tiered ${cc.down_tiered}, contested ${cc.struck}, raised ${cc.raised}${cc.unreviewed ? `, ${cc.unreviewed} not reviewed` : ""}.`;
}

function crossCheckNote(c) {
  const x = c.cross_check;
  if (!x || x.disposition === "keep") return null;
  const moved = x.from_tier ? ` (${x.from_tier} → ${c.tier})` : "";
  return `Codex ${x.disposition.replace("_", "-")}${moved}: ${x.rationale}`;
}

// ---------- publication gate ----------

// Deterministic, conservative patterns for credentials that must never reach
// a PR. A hit blocks the draft; the fix is to edit the finding in
// comments.json (describe the secret's location, never quote it) and
// re-render. Patterns are deliberately specific to keep false blocks rare.
const SECRET_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    "credential assignment",
    /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  ],
];

function scanForSecrets(draft) {
  const fields = [["review body", draft.body]];
  draft.comments.forEach((c) =>
    fields.push([`inline comment at ${c.path}:${c.line}`, c.body])
  );
  const hits = [];
  for (const [where, text] of fields) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(text || "")) hits.push({ where, pattern: name });
    }
  }
  return hits;
}

// The orientation agent sometimes prefixes its answer with working notes
// ("I have enough context now…"). Keep only the templated section.
function trimOrientation(raw) {
  const text = raw.trim();
  const i = text.indexOf("## Orientation");
  return i > 0 ? text.slice(i) : text;
}

// ---------- markdown ----------

function renderMarkdown(ctx) {
  const out = [];
  out.push(`# Review of PR #${ctx.prNumber}: ${ctx.prTitle}\n`);
  out.push(countLine(ctx.all, ctx.generalAll, ""), "");
  const since = ctx.since
    ? `  ·  *re-review since \`${ctx.since.sha.slice(0, 10)}\` (your review of ${ctx.since.at.slice(0, 10)})*`
    : "";
  out.push(
    `**Verdict: ${ctx.postureLabel}**  ·  *urgency: ${ctx.urgency}*${ctx.quick ? "  ·  *depth: quick*" : ""}${since}`
  );
  if (ctx.postureRationale) out.push(ctx.postureRationale);
  if (ctx.postureCaveat) out.push(`_⚠ ${ctx.postureCaveat}._`);
  out.push("");

  if (ctx.replay) {
    out.push(`> **Replay** of frozen revisions${typeof ctx.replay === "string" ? ` \`${ctx.replay}\`` : ""}: a manual regression run. Posting is disabled.`);
    out.push("");
  }
  if (ctx.quick) {
    out.push("> **Quick review:** one reviewer across every lens, criticals and importants only; the Codex cross-check is its only audit, and posting requires it.");
    if (ctx.escalate) out.push(`> **Consider a full review:** ${ctx.escalate}`);
    out.push("");
  }
  const gaps = coverageGaps(ctx.coverage);
  if (gaps.length) {
    out.push(`> **Coverage gaps:** ${gaps.join("; ")}. See Coverage below.`);
    out.push("");
  }

  if (ctx.draftBlocked) {
    out.push(`> **⚠ Draft blocked: ${ctx.draftBlocked.reason}.** No \`draft-review.json\` was written.`);
    for (const h of ctx.draftBlocked.hits) {
      out.push(`> - ${h.where}: ${h.pattern}`);
    }
    out.push(`> ${ctx.draftBlocked.fix}`);
    out.push("");
  }

  const ccLine = crossCheckLine(ctx.crossCheck);
  if (ccLine) out.push(`_${ccLine}_`);

  out.push(
    `_Local report: all ${ctx.totalFindings} finding(s); ${ctx.totalKept} go in the draft. Findings marked **local only** are not posted._`
  );
  if (ctx.urgency !== "standard") {
    const scope =
      ctx.urgency === "hotfix"
        ? "criticals only"
        : "criticals + importants only";
    out.push(`_Urgency **${ctx.urgency}**: the draft carries ${scope}._`);
  }
  out.push("");

  if (ctx.orientation) {
    out.push(ctx.orientation);
    out.push("");
  }

  if (ctx.decisions.length > 0) {
    out.push(`## Decisions for you (${ctx.decisions.length})\n`);
    out.push("_Judgment calls, not defects. Local only; never posted._\n");
    for (const d of ctx.decisions) out.push(`- ${d}`);
    out.push("");
  }

  if (ctx.cluster) {
    out.push("## The through-line");
    out.push(ctx.cluster);
    out.push("");
  }

  const mdLoc = (c) => {
    if (!c.path) return "";
    if (!c.line) return `\`${c.path}\``;
    const gh = ctx.headSha && ctx.repo
      ? ` ([github](https://github.com/${ctx.repo}/blob/${ctx.headSha}/${c.path}#L${c.line}))`
      : "";
    return `\`${c.path}:${c.line}\`${gh}`;
  };
  const mdFinding = (c, head) => {
    const note = excludedNote(ctx, c);
    out.push(head + (note ? `  ·  _local only: ${note}_` : ""));
    out.push("");
    out.push(c.body);
    out.push("");
    if (c.evidence) {
      out.push(`> _Evidence (local only):_ ${c.evidence.replace(/\n/g, "\n> ")}`);
      out.push("");
    }
    const cx = crossCheckNote(c);
    if (cx) {
      out.push(`> _${cx}_`);
      out.push("");
    }
    out.push("---");
    out.push("");
  };
  const lensTag = (c) => (c.lens ? ` — [${c.lens}]` : "");
  const inDraft = (list) => list.filter((c) => !c.excluded).length;

  for (const tier of TIER_ORDER) {
    const list = ctx.all[tier];
    if (list.length === 0) continue;
    out.push(`## ${TIER_TITLES[tier]} (${list.length}, ${inDraft(list)} in draft)\n`);
    for (const c of list) mdFinding(c, `**${mdLoc(c)}**${lensTag(c)}`);
  }

  // General (non-anchorable) findings — real issues that don't sit on a diff
  // line, so they are body prose here and in the posted review, never inline.
  const generalFlat = TIER_ORDER.flatMap((t) => ctx.generalAll[t]);
  if (generalFlat.length > 0) {
    out.push(`## General comments (${generalFlat.length}, ${inDraft(generalFlat)} in draft)\n`);
    out.push(
      "_Not anchored to a diff line — whole-file / absent-code / outside-the-hunk findings._\n"
    );
    for (const c of generalFlat) {
      const loc = mdLoc(c);
      mdFinding(c, `**[${c.tier}]**${lensTag(c)}${loc ? ` ${loc}` : ""}`);
    }
  }

  if (ctx.preExisting.length > 0) {
    out.push(`## Pre-existing (${ctx.preExisting.length}, local only)\n`);
    out.push("_Real issues this PR did not introduce. Never posted, never counted toward the verdict; file separately if worth fixing._\n");
    for (const c of ctx.preExisting) {
      const loc = mdLoc(c);
      mdFinding({ ...c, excluded: null }, `**[${c.tier}]**${lensTag(c)}${loc ? ` ${loc}` : ""}`);
    }
  }

  if (ctx.contested.length > 0) {
    out.push(`## Contested by Codex (${ctx.contested.length}, not in draft unless restored)\n`);
    out.push("_The Claude passes kept these; Codex says the premise is false. Set `resolution` to `restore` or `strike` in comments.json and re-render._\n");
    for (const x of ctx.contested) {
      const c = x.finding;
      const loc = mdLoc(c);
      out.push(`**[${c.tier}] ${c.id}**${lensTag(c)}${loc ? ` ${loc}` : ""}  ·  _resolution: ${x.resolution || "undecided"}_`);
      out.push("");
      out.push(`**Claim:** ${c.body}`);
      out.push("");
      out.push(`**Codex:** ${x.rebuttal}`);
      if (x.evidence) out.push(`\n> _Codex evidence:_ ${x.evidence}`);
      out.push("");
      out.push("---");
      out.push("");
    }
  }

  if (ctx.codexRaised.length > 0) {
    out.push(`## Raised by Codex (${ctx.codexRaised.length}, unverified, local only)\n`);
    out.push("_Only Codex found these and nothing has checked them. To post one, verify it and move it into `inline` or `general` in comments.json._\n");
    for (const c of ctx.codexRaised) {
      const loc = mdLoc(c);
      mdFinding({ ...c, excluded: null }, `**[${c.tier}] ${c.id}**${loc ? ` ${loc}` : ""}`);
    }
  }

  if (ctx.coverage) out.push(...coverageMarkdown(ctx.coverage), "");

  const capLines = capReportLines(ctx);
  if (capLines.length > 0) {
    out.push("## Cap report\n");
    out.push(`- draft: ${ctx.totalKept} of ${ctx.totalFindings} finding(s); \`max_comments\` ${ctx.maxComments} (criticals and importants exempt)`);
    for (const l of capLines) out.push(`- ${l}`);
    out.push("");
  }

  return out.join("\n");
}

// One line per (reason, tier) with a non-zero exclusion count.
function capReportLines(ctx) {
  const lines = [];
  for (const [reason, byTier] of Object.entries(ctx.excludedCounts)) {
    for (const tier of TIER_ORDER) {
      if (byTier[tier]) {
        lines.push(`${byTier[tier]} \`${tier}\` kept local: ${EXCLUDE_LABEL[reason](ctx, tier)}`);
      }
    }
  }
  return lines;
}

// ---------- github reviews api payload ----------

function renderDraft(ctx) {
  // Body mirrors the rendered review header so the PR conversation gets
  // verdict + rationale + urgency note + orientation + through-line.
  // Inline comments are the post-cap set, tagged with tier + lens.
  // `event` is intentionally omitted → GitHub treats this as PENDING and
  // the user must submit (or discard) from the GH UI.
  const bodyParts = [];
  const floor = { hotfix: "critical ", fast: "critical or important " }[ctx.urgency] || "";
  bodyParts.push(countLine(ctx.kept, ctx.generalKept, floor));
  bodyParts.push(`**Verdict: ${ctx.postureLabel}**  ·  *urgency: ${ctx.urgency}*`);
  if (ctx.postureRationale) bodyParts.push(ctx.postureRationale);

  if (ctx.urgency !== "standard") {
    const scope =
      ctx.urgency === "hotfix"
        ? "criticals only"
        : "criticals + importants only";
    bodyParts.push(
      `> _Urgency was set to **${ctx.urgency}**, so this review reports ${scope}._`
    );
  }

  // Orientation, decisions, contested and Codex-raised findings are for the
  // human reviewer; none of them go to the author.
  if (ctx.cluster) {
    bodyParts.push(`## The through-line\n${ctx.cluster}`);
  }

  // General (non-anchorable) findings go in the review BODY, never as inline
  // comments — an inline comment off a diff line 422s the whole review.
  // `id` markers are invisible on GitHub; they let a follow-up review map a
  // posted comment back to the finding it came from.
  const idMarker = (c) => (c.id ? `\n\n<!-- review-flow:${c.id} -->` : "");

  const generalFlat = TIER_ORDER.flatMap((t) => ctx.generalKept[t]);
  if (generalFlat.length > 0) {
    const gLines = ["## General comments"];
    for (const c of generalFlat) {
      const lensTag = c.lens ? ` [${c.lens}]` : "";
      const loc = c.path ? ` \`${c.path}${c.line ? `:${c.line}` : ""}\`` : "";
      gLines.push(`- **[${c.tier}]**${lensTag}${loc} — ${c.body}${idMarker(c)}`);
    }
    bodyParts.push(gLines.join("\n"));
  }

  // No cap report here: which findings stayed local is the reviewer's
  // business, not the author's. It lives in review.md.

  const comments = [];
  for (const tier of TIER_ORDER) {
    for (const c of ctx.kept[tier]) {
      const lensTag = c.lens ? ` [${c.lens}]` : "";
      comments.push({
        path: c.path,
        line: c.line,
        side: c.side || "RIGHT",
        body: `**[${tier}]**${lensTag}\n\n${c.body}${idMarker(c)}`,
      });
    }
  }

  return {
    // Pin the review to the reviewed snapshot. If the head has moved, GitHub
    // anchors against this commit instead of silently re-mapping lines.
    ...(ctx.headSha ? { commit_id: ctx.headSha } : {}),
    body: bodyParts.join("\n\n"),
    comments,
    // event omitted on purpose — leaves the review in PENDING state.
  };
}

// ---------- coverage (local report only) ----------

const COVERAGE_STATUS = {
  checked: "checked",
  partial: "partial",
  not_applicable: "not applicable",
  not_checked: "not checked",
};

// Per-lens coverage from out/findings/<lens>.json plus the prep records (repo
// rules, CI annotations, changed-file census). null when none of them exist
// (runs from before coverage was recorded), so older reports are unchanged.
function loadCoverage(runDir, brief) {
  const outDir = path.join(runDir, "out");
  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  };
  const findingsDir = path.join(outDir, "findings");
  const byLens = {};
  if (fs.existsSync(findingsDir)) {
    for (const f of fs.readdirSync(findingsDir).filter((x) => x.endsWith(".json"))) {
      const j = readJson(path.join(findingsDir, f));
      if (j) byLens[j.lens || f.replace(/\.json$/, "")] = j;
    }
  }
  const census = readJson(path.join(outDir, "unreviewable.json"));
  const rules = readJson(path.join(outDir, "repo-rules", "manifest.json"));
  const ci = readJson(path.join(outDir, "ci-annotations.json"));
  // unreviewable.json is written by every prep that records coverage, so its
  // presence says a missing rules or CI record means "unavailable".
  const prepRecorded = Boolean(census);
  if (!Object.keys(byLens).length && !prepRecorded && !rules && !ci) return null;

  let configured = brief.config && brief.config.reviewer_lenses;
  if (typeof configured === "string") configured = configured.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(configured)) configured = [];
  const lensNames = [...new Set([...configured, ...Object.keys(byLens)])];
  const lenses = lensNames.map((lens) => {
    const j = byLens[lens];
    if (!j) return { lens, status: "not run", basis: "The reviewer returned nothing; this lens was not reviewed.", gap: true };
    const cov = j.coverage;
    if (!cov || !cov.status) return { lens, status: "not reported", basis: "The reviewer returned no coverage record.", gap: false };
    return {
      lens,
      status: COVERAGE_STATUS[cov.status] || cov.status,
      basis: cov.basis || "",
      gap: cov.status === "not_checked" || cov.status === "partial",
    };
  });
  return { lenses, rules, rulesMissing: prepRecorded && !rules, ci, ciMissing: prepRecorded && !ci, census };
}

// Lenses with the same status and basis share one row.
function coverageRows(cov) {
  const rows = [];
  for (const l of cov.lenses) {
    const row = rows.find((r) => r.status === l.status && r.basis === l.basis);
    if (row) row.lenses.push(l.lens);
    else rows.push({ lenses: [l.lens], status: l.status, basis: l.basis });
  }
  return rows;
}

function coverageNotes(cov) {
  const notes = [];
  const short = (sha) => (sha ? `\`${sha.slice(0, 10)}\`` : "base");
  if (cov.rules) {
    const files = cov.rules.files.length ? cov.rules.files.map((f) => `\`${f}\``).join(", ") : "no rule files exist there";
    notes.push(`Repo rules from base ${short(cov.rules.base_sha)}: ${files}.` +
      (cov.rules.changed_by_pr.length ? ` The PR edits ${cov.rules.changed_by_pr.map((f) => `\`${f}\``).join(", ")}; reviewed as content, not rules.` : ""));
  } else if (cov.rulesMissing) {
    notes.push("Repo rules: unavailable (the base revision could not be read); reviewed without repo rules.");
  }
  if (cov.ci) {
    const n = cov.ci.annotations.length;
    notes.push(`CI annotations on this head: ${n || "none"} on changed files${n ? " (given to reviewers)" : ""}` +
      (cov.ci.dropped ? `, ${cov.ci.dropped} elsewhere or over the cap left out` : "") +
      (cov.ci.failed_runs ? `, ${cov.ci.failed_runs} check run(s) unreadable` : "") + ".");
  } else if (cov.ciMissing) {
    notes.push("CI annotations: not fetched.");
  }
  if (cov.census) {
    const c = cov.census;
    const listed = c.listed != null ? `${c.listed} changed file(s) listed` : "changed-file list unavailable";
    notes.push(c.files.length
      ? `Changed files: ${listed}; ${c.files.length} not reviewable from the diff: ${c.files.map((f) => `\`${f.path}\`: ${f.reason}`).join("; ")}.`
      : `Changed files: ${listed}, all with a patch in the diff.`);
    if (!c.list_complete) notes.push(`Changed-file list incomplete: ${c.note}.`);
  }
  return notes;
}

// Short phrases for the header callout; empty when coverage is complete.
function coverageGaps(cov) {
  if (!cov) return [];
  const gaps = [];
  const notRun = cov.lenses.filter((l) => l.status === "not run").map((l) => l.lens);
  const partial = cov.lenses.filter((l) => l.gap && l.status !== "not run").map((l) => l.lens);
  if (notRun.length) gaps.push(`lens not run: ${notRun.join(", ")}`);
  if (partial.length) gaps.push(`partial or unchecked: ${partial.join(", ")}`);
  if (cov.census && cov.census.files.length) gaps.push(`${cov.census.files.length} changed file(s) not reviewable from the diff`);
  if (cov.census && !cov.census.list_complete) gaps.push("changed-file list incomplete");
  if (cov.rulesMissing) gaps.push("repo rules unavailable");
  return gaps;
}

function coverageMarkdown(cov) {
  const cell = (t) => String(t).replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const out = ["## Coverage (local only)", ""];
  const rows = coverageRows(cov);
  if (rows.length) {
    out.push("| Lens | Status | Basis |", "|---|---|---|");
    for (const r of rows) out.push(`| ${r.lenses.join(", ")} | ${r.status} | ${cell(r.basis)} |`);
    out.push("");
  }
  for (const n of coverageNotes(cov)) out.push(`- ${n}`);
  return out;
}

// ---------- helpers ----------

// Minimal YAML frontmatter parser. Supports scalars and one level of
// nested objects (e.g. `config: \n  urgency: standard`). Quoted strings
// have their quotes stripped. Arrays are ignored (none of the keys we
// read are arrays). Comments (`# ...`) and blank lines are skipped.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split("\n");
  const root = {};
  const stack = [{ obj: root, indent: -1 }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.trim().startsWith("#")) continue;
    if (line.trim().startsWith("- ")) continue; // skip list items

    const indent = line.match(/^ */)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const valRaw = trimmed.slice(colon + 1).trim();
    const parent = stack[stack.length - 1].obj;

    if (valRaw === "") {
      const child = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
    } else {
      parent[key] = parseScalar(valRaw);
    }
  }
  return root;
}

function parseScalar(s) {
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  const q = s.match(/^"((?:[^"\\]|\\.)*)"$/) || s.match(/^'([^']*)'$/);
  if (q) return q[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return s;
}

main();
