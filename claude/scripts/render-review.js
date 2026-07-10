#!/usr/bin/env node
// render-review.js — render review-flow output as review.md + review.html.
//
// Reads:
//   <run_dir>/brief.md
//   <run_dir>/out/comments.json
//   <run_dir>/out/orientation.md   (optional)
//
// Writes:
//   <run_dir>/out/review.md
//   <run_dir>/out/review.html
//
// Applies the urgency floor and per-tier caps from brief.config at render
// time. Critic's comments.json is the full validated set (no caps); this
// script owns the policy cut.

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
  const diagramsDir = path.join(runDir, "out", "diagrams");
  const reviewMdPath = path.join(runDir, "out", "review.md");
  const reviewHtmlPath = path.join(runDir, "out", "review.html");
  const draftPath = path.join(runDir, "out", "draft-review.json");

  const brief = parseFrontmatter(fs.readFileSync(briefPath, "utf8"));
  const comments = JSON.parse(fs.readFileSync(commentsPath, "utf8"));
  const orientation = fs.existsSync(orientationPath)
    ? fs.readFileSync(orientationPath, "utf8").trim()
    : null;
  const diagrams = loadDiagrams(diagramsDir);

  const urgency =
    (brief.config && brief.config.urgency) || comments.urgency || "standard";
  const perTierCaps = (brief.config && brief.config.per_tier_caps) || {
    critical: null,
    important: null,
    recommended: 10,
    nit: 3,
  };
  const maxComments = (brief.config && brief.config.max_comments) || 20;

  const policy = applyPolicy(comments.inline || [], urgency, perTierCaps);
  // General (non-anchorable) findings obey the same urgency floor + per-tier
  // caps, but never become inline code comments — they render into a body
  // section and the posted review body.
  const generalPolicy = applyPolicy(comments.general || [], urgency, perTierCaps);

  const ctx = {
    prNumber: brief.pr_number,
    prTitle: brief.pr_title || `(PR #${brief.pr_number})`,
    prUrl: brief.pr_url || null,
    repo: brief.repo || null,
    headSha: brief.head_sha || null,
    baseRef: brief.base_ref || null,
    headRef: brief.head_ref || null,
    urgency,
    posture: comments.posture,
    postureLabel: POSTURE_LABEL[comments.posture] || comments.posture,
    postureRationale: comments.posture_rationale || null,
    cluster: comments.cluster || null,
    orientation,
    diagrams,
    kept: policy.kept,
    droppedByUrgency: policy.droppedByUrgency,
    droppedByCap: policy.droppedByCap,
    totalKept: policy.totalKept,
    generalKept: generalPolicy.kept,
    generalTotalKept: generalPolicy.totalKept,
    maxComments,
    perTierCaps,
  };

  fs.writeFileSync(reviewMdPath, renderMarkdown(ctx));
  fs.writeFileSync(reviewHtmlPath, renderHtml(ctx));
  fs.writeFileSync(draftPath, JSON.stringify(renderDraft(ctx), null, 2));

  // Stdout for the lead to copy into the wrap-up message.
  process.stdout.write(
    JSON.stringify({
      review_md: reviewMdPath,
      review_html: reviewHtmlPath,
      draft_review: draftPath,
      review_md_url: hostFileUrl(reviewMdPath),
      review_html_url: hostFileUrl(reviewHtmlPath),
      file_url: hostFileUrl(reviewHtmlPath),
      counts: tierCounts(policy.kept),
      total: policy.totalKept,
      general_counts: tierCounts(generalPolicy.kept),
      general_total: generalPolicy.totalKept,
    }) + "\n"
  );
}

// ---------- policy ----------

function applyPolicy(inline, urgency, perTierCaps) {
  const allowed = URGENCY_TIERS[urgency] || TIER_ORDER;

  const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
  for (const c of inline) {
    if (byTier[c.tier]) byTier[c.tier].push(c);
  }

  const kept = {};
  const droppedByUrgency = {};
  const droppedByCap = {};

  for (const tier of TIER_ORDER) {
    if (!allowed.includes(tier)) {
      droppedByUrgency[tier] = byTier[tier].length;
      kept[tier] = [];
      continue;
    }
    const cap = perTierCaps[tier];
    if (cap != null && byTier[tier].length > cap) {
      droppedByCap[tier] = byTier[tier].length - cap;
      kept[tier] = byTier[tier].slice(0, cap);
    } else {
      kept[tier] = byTier[tier];
    }
  }

  const totalKept = TIER_ORDER.reduce((n, t) => n + kept[t].length, 0);
  return { kept, droppedByUrgency, droppedByCap, totalKept };
}

function tierCounts(kept) {
  return Object.fromEntries(TIER_ORDER.map((t) => [t, kept[t].length]));
}

// ---------- diagrams ----------

function loadDiagrams(diagramsDir) {
  // Returns { skipped: string | null, callChain, flowchart, sequence }.
  // Each rendered field is { svg?, mmd?, err? } — preferring svg, falling
  // back to mmd source if rendering failed. null overall if the directory
  // doesn't exist (diagrammer wasn't spawned, e.g., hotfix runs).
  if (!fs.existsSync(diagramsDir)) return null;

  const skippedPath = path.join(diagramsDir, "skipped.txt");
  if (fs.existsSync(skippedPath)) {
    return { skipped: fs.readFileSync(skippedPath, "utf8").trim() };
  }

  const result = { skipped: null };

  const callChainPath = path.join(diagramsDir, "call-chain.txt");
  if (fs.existsSync(callChainPath)) {
    result.callChain = fs.readFileSync(callChainPath, "utf8").trimEnd();
  }

  for (const name of ["flowchart", "sequence"]) {
    const svg = path.join(diagramsDir, `${name}.svg`);
    const mmd = path.join(diagramsDir, `${name}.mmd`);
    const err = path.join(diagramsDir, `${name}.err`);
    const entry = {};
    if (fs.existsSync(svg)) entry.svg = fs.readFileSync(svg, "utf8");
    if (fs.existsSync(mmd)) entry.mmd = fs.readFileSync(mmd, "utf8");
    if (fs.existsSync(err)) entry.err = fs.readFileSync(err, "utf8");
    if (entry.svg || entry.mmd) result[name] = entry;
  }

  return result;
}

// ---------- markdown ----------

function renderMarkdown(ctx) {
  const out = [];
  out.push(`# Review of PR #${ctx.prNumber}: ${ctx.prTitle}\n`);
  out.push(
    `**Verdict: ${ctx.postureLabel}**  ·  *urgency: ${ctx.urgency}*`
  );
  if (ctx.postureRationale) out.push(ctx.postureRationale);
  out.push("");

  if (ctx.urgency !== "standard") {
    const scope =
      ctx.urgency === "hotfix"
        ? "criticals only"
        : "criticals + importants only";
    out.push(
      `> _Urgency was set to **${ctx.urgency}**, so this review reports ${scope}. Re-run with \`--urgency standard\` for a deeper pass._`
    );
    out.push("");
  }

  if (ctx.orientation) {
    out.push(ctx.orientation);
    out.push("");
  }

  if (ctx.diagrams && !ctx.diagrams.skipped) {
    out.push("## Call chain");
    out.push("");
    if (ctx.diagrams.callChain) {
      out.push("```");
      out.push(ctx.diagrams.callChain);
      out.push("```");
      out.push("");
    }
    for (const kind of ["flowchart", "sequence"]) {
      const d = ctx.diagrams[kind];
      if (!d) continue;
      out.push(`### ${kind === "flowchart" ? "Flowchart" : "Sequence diagram"}`);
      out.push("");
      if (d.svg && !d.mmd) {
        out.push(`_Rendered SVG at \`out/diagrams/${kind}.svg\`._`);
        out.push("");
      } else if (d.svg) {
        out.push(`_Rendered SVG at \`out/diagrams/${kind}.svg\`; Mermaid source below._`);
        out.push("");
        out.push("```mermaid");
        out.push(d.mmd.trimEnd());
        out.push("```");
        out.push("");
      } else if (d.mmd) {
        const errLine = d.err ? ` Error: ${d.err.split("\n")[0]}` : "";
        out.push(`_Render failed — showing Mermaid source.${errLine}_`);
        out.push("");
        out.push("```mermaid");
        out.push(d.mmd.trimEnd());
        out.push("```");
        out.push("");
      }
    }
  }

  if (ctx.cluster) {
    out.push("## The through-line");
    out.push(ctx.cluster);
    out.push("");
  }

  for (const tier of TIER_ORDER) {
    const list = ctx.kept[tier];
    if (list.length === 0) continue;
    out.push(`## ${TIER_TITLES[tier]} (${list.length})\n`);
    for (const c of list) {
      const lensTag = c.lens ? ` — [${c.lens}]` : "";
      const ghLink = ctx.headSha && ctx.repo
        ? ` ([github](https://github.com/${ctx.repo}/blob/${ctx.headSha}/${c.path}#L${c.line}))`
        : "";
      out.push(`**\`${c.path}:${c.line}\`**${lensTag}${ghLink}`);
      out.push("");
      out.push(c.body);
      out.push("");
      out.push("---");
      out.push("");
    }
  }

  // General (non-anchorable) findings — real issues that don't sit on a diff
  // line, so they are body prose here and in the posted review, never inline.
  const generalFlat = TIER_ORDER.flatMap((t) => (ctx.generalKept[t] || []));
  if (generalFlat.length > 0) {
    out.push(`## General comments (${generalFlat.length})\n`);
    out.push(
      "_Not anchored to a diff line — whole-file / absent-code / outside-the-hunk findings._\n"
    );
    for (const tier of TIER_ORDER) {
      for (const c of ctx.generalKept[tier] || []) {
        const lensTag = c.lens ? ` — [${c.lens}]` : "";
        const loc = c.path
          ? (c.line
              ? (ctx.headSha && ctx.repo
                  ? `\`${c.path}:${c.line}\` ([github](https://github.com/${ctx.repo}/blob/${ctx.headSha}/${c.path}#L${c.line}))`
                  : `\`${c.path}:${c.line}\``)
              : `\`${c.path}\``)
          : "";
        out.push(`**[${tier}]**${lensTag}${loc ? ` ${loc}` : ""}`);
        out.push("");
        out.push(c.body);
        out.push("");
        out.push("---");
        out.push("");
      }
    }
  }

  const hadDrops =
    anyPositive(ctx.droppedByUrgency) || anyPositive(ctx.droppedByCap);
  if (hadDrops) {
    out.push("## Cap report\n");
    out.push(
      `- \`max_comments\`: ${ctx.maxComments}, included: ${ctx.totalKept}`
    );
    for (const tier of TIER_ORDER) {
      if (ctx.droppedByUrgency[tier]) {
        out.push(
          `- dropped ${ctx.droppedByUrgency[tier]} \`${tier}\` finding(s) by urgency floor (\`${ctx.urgency}\`)`
        );
      }
      if (ctx.droppedByCap[tier]) {
        out.push(
          `- dropped ${ctx.droppedByCap[tier]} \`${tier}\` finding(s) by per-tier cap (${ctx.perTierCaps[tier]})`
        );
      }
    }
    out.push("");
  }

  return out.join("\n");
}

// ---------- github reviews api payload ----------

function renderDraft(ctx) {
  // Body mirrors the rendered review header so the PR conversation gets
  // verdict + rationale + urgency note + orientation + through-line.
  // Inline comments are the post-cap set, tagged with tier + lens.
  // `event` is intentionally omitted → GitHub treats this as PENDING and
  // the user must submit (or discard) from the GH UI.
  const bodyParts = [];
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

  if (ctx.orientation) bodyParts.push(ctx.orientation);
  if (ctx.cluster) {
    bodyParts.push(`## The through-line\n${ctx.cluster}`);
  }

  // General (non-anchorable) findings go in the review BODY, never as inline
  // comments — an inline comment off a diff line 422s the whole review.
  const generalFlat = TIER_ORDER.flatMap((t) => (ctx.generalKept[t] || []));
  if (generalFlat.length > 0) {
    const gLines = ["## General comments"];
    for (const tier of TIER_ORDER) {
      for (const c of ctx.generalKept[tier] || []) {
        const lensTag = c.lens ? ` [${c.lens}]` : "";
        const loc = c.path ? ` \`${c.path}${c.line ? `:${c.line}` : ""}\`` : "";
        gLines.push(`- **[${tier}]**${lensTag}${loc} — ${c.body}`);
      }
    }
    bodyParts.push(gLines.join("\n"));
  }

  const dropNotes = capDropSummary(ctx);
  if (dropNotes) bodyParts.push(dropNotes);

  const comments = [];
  for (const tier of TIER_ORDER) {
    for (const c of ctx.kept[tier]) {
      const lensTag = c.lens ? ` [${c.lens}]` : "";
      comments.push({
        path: c.path,
        line: c.line,
        side: c.side || "RIGHT",
        body: `**[${tier}]**${lensTag}\n\n${c.body}`,
      });
    }
  }

  return {
    body: bodyParts.join("\n\n"),
    comments,
    // event omitted on purpose — leaves the review in PENDING state.
  };
}

function capDropSummary(ctx) {
  const lines = [];
  for (const tier of TIER_ORDER) {
    if (ctx.droppedByUrgency[tier]) {
      lines.push(
        `- ${ctx.droppedByUrgency[tier]} \`${tier}\` finding(s) dropped by urgency floor (\`${ctx.urgency}\`)`
      );
    }
    if (ctx.droppedByCap[tier]) {
      lines.push(
        `- ${ctx.droppedByCap[tier]} \`${tier}\` finding(s) dropped by per-tier cap (${ctx.perTierCaps[tier]})`
      );
    }
  }
  if (lines.length === 0) return null;
  return `<details><summary>Cap report — ${lines.length} note(s)</summary>\n\n${lines.join("\n")}\n</details>`;
}

// ---------- html ----------

function renderHtml(ctx) {
  const ghBlobBase =
    ctx.headSha && ctx.repo
      ? `https://github.com/${ctx.repo}/blob/${ctx.headSha}`
      : null;
  const prFilesUrl = ctx.prUrl ? `${ctx.prUrl}/files` : null;

  const cards = (tier) =>
    ctx.kept[tier]
      .map((c, i) => renderCard(c, i, tier, ghBlobBase, prFilesUrl))
      .join("\n");

  const tierSections = TIER_ORDER.filter((t) => ctx.kept[t].length > 0)
    .map(
      (t) => `
    <section class="tier-section tier-${t}" id="tier-${t}">
      <h2 class="tier-title"><span class="tier-title-bar"></span>${TIER_TITLES[t]} <span class="count">${ctx.kept[t].length}</span></h2>
      ${cards(t)}
    </section>`
    )
    .join("");

  const urgencyCallout =
    ctx.urgency !== "standard"
      ? `<div class="urgency-callout">Urgency: <strong>${escapeHtml(ctx.urgency)}</strong> — reports ${ctx.urgency === "hotfix" ? "criticals only" : "criticals + importants only"}. Re-run with <code>--urgency standard</code> for a deeper pass.</div>`
      : "";

  const orientationBlock = ctx.orientation
    ? `<section class="orientation">${renderOrientationHtml(ctx.orientation)}</section>`
    : "";

  const diagramsBlock = renderDiagramsHtml(ctx.diagrams);
  const lightboxMarkup = diagramsBlock ? renderLightbox() : "";

  const clusterBlock = ctx.cluster
    ? `<section class="through-line"><h2>The through-line</h2><div>${renderInlineMd(ctx.cluster)}</div></section>`
    : "";

  const capReportBlock = renderCapReportHtml(ctx);

  // General (non-anchorable) findings: real issues not on a diff line. Shown
  // as a distinct section so they read as body prose, not inline anchors.
  const generalFlat = TIER_ORDER.flatMap((t) => (ctx.generalKept[t] || []));
  const generalBlock = generalFlat.length
    ? `<section class="tier-section general-section" id="general">
      <h2 class="tier-title"><span class="tier-title-bar"></span>General comments <span class="count">${generalFlat.length}</span></h2>
      <p class="general-note">Not anchored to a diff line — whole-file / absent-code / outside-the-hunk findings.</p>
      ${TIER_ORDER.flatMap((t) => (ctx.generalKept[t] || []).map((c, i) => renderCard(c, i, t, ghBlobBase, prFilesUrl))).join("\n")}
    </section>`
    : "";

  const prHref = ctx.prUrl
    ? `<a href="${escapeHtml(ctx.prUrl)}" class="pr-anchor">#${ctx.prNumber}</a>`
    : `#${ctx.prNumber}`;

  const metaParts = [];
  if (ctx.baseRef && ctx.headRef) {
    metaParts.push(
      `<span class="meta-item"><code>${escapeHtml(ctx.baseRef)}</code> ← <code>${escapeHtml(ctx.headRef)}</code></span>`
    );
  }
  metaParts.push(
    `<span class="meta-item">urgency: <strong>${escapeHtml(ctx.urgency)}</strong></span>`
  );
  const metaBar = metaParts.length
    ? `<div class="pr-meta">${metaParts.join('<span class="meta-sep">·</span>')}</div>`
    : "";

  const tierNav = renderTierNav(ctx);

  const hasPreamble = Boolean(orientationBlock || diagramsBlock);

  const bodyContent = hasPreamble
    ? `
  <div class="layout-grid">
    <aside class="preamble-col">
      ${orientationBlock}
      ${diagramsBlock}
    </aside>
    <div class="comments-col">
      ${clusterBlock}
      ${tierSections}
      ${generalBlock}
      ${capReportBlock}
    </div>
  </div>`
    : `
  ${clusterBlock}
  ${tierSections}
  ${generalBlock}
  ${capReportBlock}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review of PR #${ctx.prNumber}: ${escapeHtml(ctx.prTitle)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="page-head">
    <h1>Review of PR ${prHref}: ${escapeHtml(ctx.prTitle)}</h1>
    ${metaBar}
    <div class="verdict verdict-${ctx.posture}">
      <span class="verdict-label">${escapeHtml(ctx.postureLabel)}</span>
      <span class="urgency-pill">urgency: ${escapeHtml(ctx.urgency)}</span>
    </div>
    ${ctx.postureRationale ? `<p class="rationale">${renderInlineMd(ctx.postureRationale)}</p>` : ""}
    ${urgencyCallout}
    ${tierNav}
  </header>${bodyContent}
</main>
${lightboxMarkup}
</body>
</html>`;
}

// Full-screen diagram viewer. Markup + vanilla-JS wiring as a single string
// (no build step, no deps). The clicked SVG is MOVED into the modal and moved
// back on close, so there are never two elements sharing a Mermaid id (which
// would break url(#marker) arrowhead refs). Closes on ✕, backdrop click, Esc.
function renderLightbox() {
  return `<div class="lightbox" id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Diagram viewer">
  <div class="lightbox-content">
    <button type="button" class="lightbox-close" aria-label="Close diagram viewer">&#x2715;</button>
  </div>
</div>
<script>
(function () {
  var box = document.getElementById('lightbox');
  if (!box) return;
  var content = box.querySelector('.lightbox-content');
  var current = null, origParent = null, origNext = null;
  function open(svg) {
    origParent = svg.parentNode;
    origNext = svg.nextSibling;
    current = svg;
    content.appendChild(svg);
    box.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function close() {
    if (!current) return;
    if (origNext) { origParent.insertBefore(current, origNext); }
    else { origParent.appendChild(current); }
    current = null;
    box.hidden = true;
    document.body.style.overflow = '';
  }
  var triggers = document.querySelectorAll('[data-lightbox]');
  for (var i = 0; i < triggers.length; i++) {
    triggers[i].addEventListener('click', function () {
      var svg = this.querySelector('svg.mermaid-svg');
      if (svg) open(svg);
    });
  }
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  box.querySelector('.lightbox-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !box.hidden) close();
  });
})();
</script>`;
}

function renderTierNav(ctx) {
  const items = TIER_ORDER.filter((t) => ctx.kept[t].length > 0).map(
    (t) =>
      `<a href="#tier-${t}" class="tier-nav-item tier-nav-${t}"><span class="tier-nav-count">${ctx.kept[t].length}</span> ${TIER_TITLES[t].toLowerCase()}</a>`
  );
  if (items.length === 0) return "";
  return `<nav class="tier-nav" aria-label="Jump to tier">${items.join("")}</nav>`;
}

function renderDiagramsHtml(diagrams) {
  if (!diagrams) return ""; // diagrammer wasn't spawned (e.g., hotfix)
  if (diagrams.skipped) return ""; // diagrammer skipped explicitly

  const blocks = [];

  if (diagrams.callChain) {
    blocks.push(
      `<div class="diagram-block diagram-text"><h3>Call chain</h3><pre><code>${escapeHtml(diagrams.callChain)}</code></pre></div>`
    );
  }

  for (const kind of ["flowchart", "sequence"]) {
    const d = diagrams[kind];
    if (!d) continue;
    const title = kind === "flowchart" ? "Flowchart" : "Sequence diagram";
    let body;
    if (d.svg) {
      body = inlineSvg(d.svg, title);
    } else if (d.mmd) {
      const errNote = d.err
        ? `<p class="diagram-error">Render failed — showing source. ${escapeHtml(d.err.split("\n")[0])}</p>`
        : "";
      body = `${errNote}<pre><code>${escapeHtml(d.mmd.trimEnd())}</code></pre>`;
    } else {
      continue;
    }
    blocks.push(
      `<div class="diagram-block diagram-${kind}"><h3>${title}</h3>${body}</div>`
    );
  }

  if (blocks.length === 0) return "";
  return `<section class="diagrams"><h2>Call chain</h2>${blocks.join("")}</section>`;
}

let svgCounter = 0;

// =============================================================================
// MERMAID-CLI INLINING — KNOWN GOTCHAS, DO NOT RE-LEARN THE HARD WAY
// =============================================================================
//
// 1. Mermaid hard-codes id="my-svg" on every emitted SVG and references it
//    from embedded <style> rules: "#my-svg p { margin: 0 }",
//    "#my-svg .nodeLabel {...}", etc. Duplicate IDs across multiple SVGs in
//    one HTML document are invalid AND functionally broken (browsers resolve
//    url(#id) refs to the first match, and CSS scoping collides).
//
//    DO NOT rename only the id="..." attribute — that orphans every
//    "#my-svg" selector in the embedded CSS. With "#my-svg p { margin: 0 }"
//    no longer matching, the browser applies default <p> margins which push
//    label text outside the foreignObject viewport, producing empty-looking
//    boxes. Rename every occurrence of "my-svg" in the SVG instead, so the
//    element id and all CSS/marker references update together.
//
// 2. Mermaid v11 dropped the htmlLabels: false flowchart option. All labels
//    render as <foreignObject> containing HTML <div><p>. Setting htmlLabels:
//    false in mermaid.config.json is silently ignored. Don't rely on it.
//
// 3. HTML labels have a hardcoded max-width: 200px and wrap longer content.
//    Wrapping triggers a Mermaid bounding-box miscalculation that clips the
//    wrapped lines. Don't try to "fix" via CSS injection — Mermaid measures
//    the rect at render time, before our CSS applies. The reliable mitigation
//    is in the agent prompt: keep labels short (≤24 chars in diagrammer.md).
//
// 4. <br/> inside a node label has the same wrap-clip bug as auto-wrap.
//    Single-line labels only.
//
// =============================================================================

function inlineSvg(svg, title = "diagram") {
  // mermaid-cli emits an SVG with:
  //   - <?xml ?> prolog — invalid inside an HTML body, strip it
  //   - width/height attributes — pin intrinsic size. We KEEP these (do NOT
  //     strip them). They give the SVG an intrinsic size so the CSS constraint
  //     algorithm can scale it down to fit within BOTH max-width and
  //     max-height while preserving aspect ratio. Stripping them left only the
  //     viewBox, which forced the SVG to fill the column width and balloon
  //     vertically for tall diagrams (flowchart TD) — and shrink wide ones
  //     (sequence) down to an unreadable strip. `.mermaid-svg` CSS overrides
  //     the attributes (CSS beats presentation attrs) so responsive scaling
  //     still works; the attrs only supply the intrinsic ratio + size.
  //   - id="my-svg" hard-coded + embedded CSS scoped to it — see gotcha
  //     #1 above. Solution: rename every occurrence of "my-svg".
  let s = svg.replace(/^<\?xml[^>]*\?>\s*/i, "");
  const uniqueId = `mermaid-${++svgCounter}`;
  // Replace all occurrences of `my-svg`, including suffixed forms like
  // `my-svg_flowchart-v2-pointEnd` (marker IDs that Mermaid scopes by
  // prefix). Word-boundary on the right would miss these because `_` is
  // a word character. Use a negative-lookahead-style char class to
  // exclude letters/digits before the prefix (don't munge identifiers
  // that happen to end in "my-svg").
  s = s.replace(/(^|[^A-Za-z0-9-])my-svg/g, `$1${uniqueId}`);
  // If the original lacked any id at all, add one (rare; defensive).
  if (!/\sid=/.test(s.slice(0, 200))) {
    s = s.replace(/<svg /i, `<svg id="${uniqueId}" `);
  }
  s = s.replace(/<svg /i, '<svg class="mermaid-svg" ');
  // The wrapper is a real <button> so the diagram is keyboard-focusable and
  // opens the full-screen lightbox (wired by the inline script near </body>).
  return `<button type="button" class="diagram-svg-wrap" data-lightbox aria-label="Enlarge ${escapeHtml(title)}"><span class="diagram-expand-hint" aria-hidden="true">⤢ Click to enlarge</span>${s}</button>`;
}

function renderCard(c, idx, tier, ghBlobBase, prFilesUrl) {
  const anchor = `c-${tier}-${idx}`;
  const fileLabel = `${c.path}:${c.line}`;
  const fileLink = ghBlobBase
    ? `<a href="${ghBlobBase}/${c.path}#L${c.line}" class="file-link" target="_blank" rel="noopener">${escapeHtml(fileLabel)}</a>`
    : `<code class="file-link">${escapeHtml(fileLabel)}</code>`;
  const prLink = prFilesUrl
    ? `<a href="${prFilesUrl}" class="pr-link" target="_blank" rel="noopener" title="View PR Files Changed">↗ in PR</a>`
    : "";
  const lensTag = c.lens
    ? `<span class="lens lens-${escapeHtml(c.lens)}">${escapeHtml(c.lens)}</span>`
    : "";
  return `
    <article class="card card-${tier}" id="${anchor}">
      <header class="card-head">
        <span class="tier-pill">${tier}</span>
        ${lensTag}
        <span class="loc">${fileLink}</span>
        ${prLink}
        <a href="#${anchor}" class="anchor" title="Link to this comment">#</a>
      </header>
      <div class="card-body">${renderInlineMd(c.body)}</div>
    </article>`;
}

function renderOrientationHtml(md) {
  // Orientation has a tightly constrained format (## headings, **bold**
  // sentences, - bullet list, optional fenced code blocks for call-chain
  // diagrams, optional inline `code`). We render it line-by-line rather
  // than pulling in a markdown library.
  const lines = md.split("\n");
  const out = [];
  let inList = false;
  let inFence = false;
  let fenceBuf = [];

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    // Inside a fenced code block: capture verbatim until the closing fence.
    if (inFence) {
      if (raw.trimStart().startsWith("```")) {
        out.push(
          `<pre class="call-chain"><code>${escapeHtml(fenceBuf.join("\n"))}</code></pre>`
        );
        fenceBuf = [];
        inFence = false;
      } else {
        fenceBuf.push(raw);
      }
      continue;
    }

    const line = raw.replace(/\s+$/, "");

    if (line.trimStart().startsWith("```")) {
      closeList();
      inFence = true;
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInlineMd(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${renderInlineMd(line)}</p>`);
    }
  }
  closeList();
  // Trailing unclosed fence — render what we have rather than dropping it.
  if (inFence && fenceBuf.length) {
    out.push(
      `<pre class="call-chain"><code>${escapeHtml(fenceBuf.join("\n"))}</code></pre>`
    );
  }
  return out.join("\n");
}

function renderInlineMd(text) {
  // Tiny inline-markdown converter for the subset we expect inside
  // comment bodies and orientation prose: `code`, **bold**, *italic*,
  // [text](url). HTML-escape first, then apply transforms. Code spans
  // are processed first so we don't double-transform their content.
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`
  );
  return s;
}

function renderCapReportHtml(ctx) {
  if (!anyPositive(ctx.droppedByUrgency) && !anyPositive(ctx.droppedByCap)) {
    return "";
  }
  const rows = [
    `<li>max_comments: ${ctx.maxComments}, included: ${ctx.totalKept}</li>`,
  ];
  for (const tier of TIER_ORDER) {
    if (ctx.droppedByUrgency[tier]) {
      rows.push(
        `<li>dropped ${ctx.droppedByUrgency[tier]} <code>${tier}</code> finding(s) by urgency floor (<code>${escapeHtml(ctx.urgency)}</code>)</li>`
      );
    }
    if (ctx.droppedByCap[tier]) {
      rows.push(
        `<li>dropped ${ctx.droppedByCap[tier]} <code>${tier}</code> finding(s) by per-tier cap (${ctx.perTierCaps[tier]})</li>`
      );
    }
  }
  return `<footer class="cap-report"><h3>Cap report</h3><ul>${rows.join("")}</ul></footer>`;
}

// ---------- helpers ----------

function anyPositive(obj) {
  return Object.values(obj).some((n) => n > 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

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

const CSS = `
  :root {
    --bg: #0b0c0e;
    --panel: #16181c;
    --panel-2: #1c1f24;
    --text: #e8eaed;
    --muted: #9aa1a9;
    --border: #2a2d33;
    --border-strong: #3a3d44;
    --link: #7eb6ff;
    --critical: #f87171;
    --important: #fbbf24;
    --recommended: #38bdf8;
    --nit: #9ca3af;
    --critical-bg: rgba(248, 113, 113, 0.08);
    --important-bg: rgba(251, 191, 36, 0.06);
    --recommended-bg: rgba(56, 189, 248, 0.06);
    --nit-bg: var(--panel);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fafaf9;
      --panel: #ffffff;
      --panel-2: #f5f5f4;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e7e5e4;
      --border-strong: #d6d3d1;
      --link: #1d4ed8;
      --critical: #dc2626;
      --important: #d97706;
      --recommended: #0284c7;
      --nit: #6b7280;
      --critical-bg: #fff1f2;
      --important-bg: #fff7ed;
      --recommended-bg: #f0f9ff;
      --nit-bg: #f5f5f4;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-padding-top: 24px; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 15.5px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  code, .file-link, .pr-anchor { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { max-width: 940px; margin: 0 auto; padding: 56px 36px 120px; }
  .page-head { margin-bottom: 40px; }
  .layout-grid { display: grid; grid-template-columns: 1fr; gap: 40px; }

  /* Two-column layout kicks in at 1100px. The right column is the
     reading column (comments) — prose-heavy, benefits from a bounded
     width for readability. The left column is the visual column
     (orientation + diagrams) — flexes wider on bigger viewports so
     diagrams have more room.

     1100-1500px: balanced ratio; both columns still tight, fluid split.
     1500px+:     right column locks to a max reading width; left
                  swallows all extra space.
     2100px+:     larger overall max-width for ultrawides. */
  @media (min-width: 1100px) {
    main { max-width: 1320px; }
    .layout-grid {
      grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
      gap: 48px;
    }
  }
  @media (min-width: 1500px) {
    main { max-width: 1700px; padding-inline: 48px; }
    .layout-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 720px);
      gap: 64px;
    }
  }
  @media (min-width: 2100px) {
    main { max-width: 2100px; padding-inline: 56px; }
  }
  .preamble-col, .comments-col { min-width: 0; }
  /* Tighter section margins inside columns — they don't compete with
     unrelated content vertically and breathe via the gap between cols. */
  .layout-grid .orientation { margin-top: 0; margin-bottom: 32px; }
  .layout-grid .diagrams { margin-top: 0; margin-bottom: 32px; }
  .layout-grid .through-line { margin-top: 0; margin-bottom: 32px; }
  .layout-grid .tier-section:first-of-type { margin-top: 0; }
  .page-head h1 { font-size: 28px; font-weight: 600; margin: 0 0 12px; line-height: 1.25; letter-spacing: -0.01em; }
  .pr-anchor { color: var(--link); font-size: 0.85em; }
  .pr-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  .pr-meta code { background: var(--panel-2); padding: 2px 7px; border-radius: 3px; color: var(--muted); }
  .pr-meta .meta-item strong { color: var(--text); font-weight: 600; }
  .pr-meta .meta-sep { color: var(--border-strong); }
  .verdict { display: inline-flex; align-items: center; gap: 16px; padding: 14px 20px; border-radius: 10px; font-size: 16px; border: 1px solid var(--border); background: var(--panel); }
  .verdict-do_not_merge { background: var(--critical-bg); border-color: var(--critical); }
  .verdict-merge_after_fixes { background: var(--important-bg); border-color: var(--important); }
  .verdict-merge_ready_with_followups { background: var(--nit-bg); border-color: var(--border-strong); }
  .verdict-label { font-weight: 700; font-size: 17px; text-transform: capitalize; letter-spacing: -0.005em; }
  .urgency-pill { color: var(--muted); font-size: 13px; padding-left: 16px; border-left: 1px solid var(--border-strong); }
  .rationale { color: var(--text); margin: 18px 0 0; font-size: 15.5px; line-height: 1.65; max-width: 70ch; }
  .urgency-callout { margin: 20px 0 0; padding: 12px 16px; background: var(--panel-2); border-left: 3px solid var(--important); border-radius: 4px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .urgency-callout code { background: transparent; padding: 0; }
  .tier-nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 28px 0 0; padding-top: 24px; border-top: 1px solid var(--border); }
  .tier-nav-item { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); color: var(--muted); font-size: 13px; text-transform: capitalize; }
  .tier-nav-item:hover { text-decoration: none; border-color: var(--border-strong); color: var(--text); }
  .tier-nav-count { font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
  .tier-nav-critical:hover { border-color: var(--critical); color: var(--critical); }
  .tier-nav-critical .tier-nav-count { color: var(--critical); }
  .tier-nav-important:hover { border-color: var(--important); color: var(--important); }
  .tier-nav-important .tier-nav-count { color: var(--important); }
  .tier-nav-recommended:hover { border-color: var(--recommended); color: var(--recommended); }
  .tier-nav-recommended .tier-nav-count { color: var(--recommended); }
  .tier-nav-nit:hover { border-color: var(--nit); color: var(--text); }
  .orientation { margin: 44px 0; padding: 28px 32px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; line-height: 1.75; }
  .orientation h2 { margin: 0 0 16px; font-size: 17px; font-weight: 600; }
  .orientation ul { padding-left: 22px; margin: 12px 0; }
  .orientation li { margin: 8px 0; line-height: 1.65; }
  .orientation p { margin: 12px 0; }
  .orientation strong { color: var(--text); font-weight: 600; }
  .orientation code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px; }
  .orientation .call-chain { margin: 16px 0 8px; padding: 16px 20px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; line-height: 1.55; }
  .orientation .call-chain code { background: transparent; padding: 0; font-size: 12.5px; color: var(--text); display: block; white-space: pre; }
  .diagrams { margin: 44px 0; padding: 28px 32px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .diagrams > h2 { margin: 0 0 20px; font-size: 17px; font-weight: 600; }
  .diagram-block { margin: 24px 0; }
  .diagram-block:first-of-type { margin-top: 0; }
  .diagram-block > h3 { margin: 0 0 12px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .diagram-block pre { margin: 0; padding: 16px 20px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; line-height: 1.55; }
  .diagram-block pre code { background: transparent; padding: 0; font-size: 12.5px; color: var(--text); display: block; white-space: pre; }
  .diagram-svg-wrap { display: block; width: 100%; position: relative; padding: 20px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow: auto; text-align: center; cursor: zoom-in; font: inherit; color: inherit; -webkit-appearance: none; appearance: none; }
  .diagram-svg-wrap:hover { border-color: var(--border-strong); }
  .diagram-svg-wrap:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  .diagram-expand-hint { position: absolute; top: 8px; right: 10px; z-index: 1; padding: 3px 8px; font-size: 11px; letter-spacing: 0.03em; color: var(--muted); background: var(--panel); border: 1px solid var(--border); border-radius: 4px; opacity: 0; transition: opacity 0.12s ease; pointer-events: none; }
  .diagram-svg-wrap:hover .diagram-expand-hint, .diagram-svg-wrap:focus-visible .diagram-expand-hint { opacity: 1; }
  /* Keep intrinsic width/height attributes on the SVG; constrain by BOTH
     dimensions so tall flowcharts can't run away vertically and wide
     sequence diagrams still fit. width/height:auto lets the constraint
     algorithm preserve aspect ratio. */
  .mermaid-svg { max-width: 100%; max-height: 60vh; width: auto; height: auto; display: block; margin: 0 auto; }
  /* Lightbox — click a diagram to view it fit-to-screen. The clicked SVG is
     MOVED into the modal (not cloned) to avoid duplicate ids / broken marker
     refs, then moved back on close. */
  .lightbox { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 3vmin; background: rgba(0,0,0,0.78); }
  .lightbox[hidden] { display: none; }
  .lightbox-content { position: relative; max-width: 96vw; max-height: 94vh; overflow: auto; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px; padding: 28px; box-shadow: 0 24px 64px rgba(0,0,0,0.5); }
  .lightbox-content .mermaid-svg { max-width: 90vw; max-height: 86vh; width: auto; height: auto; }
  .lightbox-close { position: absolute; top: 10px; right: 10px; z-index: 2; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1; color: var(--text); background: var(--panel); border: 1px solid var(--border-strong); border-radius: 6px; cursor: pointer; }
  .lightbox-close:hover { border-color: var(--link); color: var(--link); }
  .diagram-error { margin: 0 0 12px; font-size: 12px; color: var(--important); }
  .through-line { margin: 44px 0; padding: 22px 28px; background: var(--panel-2); border-left: 3px solid var(--link); border-radius: 4px; line-height: 1.7; }
  .through-line h2 { font-size: 12px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .through-line div { margin: 0; font-size: 15px; }
  .through-line code { background: var(--bg); padding: 1px 5px; border-radius: 3px; }
  .tier-section { margin: 56px 0 32px; scroll-margin-top: 16px; }
  .tier-title { font-size: 22px; font-weight: 600; margin: 0 0 20px; padding: 14px 0 12px; display: flex; align-items: baseline; gap: 12px; position: sticky; top: 0; background: var(--bg); z-index: 5; border-bottom: 1px solid var(--border); letter-spacing: -0.01em; }
  .tier-title-bar { display: inline-block; width: 4px; height: 22px; border-radius: 2px; align-self: center; background: var(--muted); }
  .tier-title .count { font-size: 14px; color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
  .tier-critical .tier-title { color: var(--critical); }
  .tier-critical .tier-title-bar { background: var(--critical); }
  .tier-important .tier-title { color: var(--important); }
  .tier-important .tier-title-bar { background: var(--important); }
  .tier-recommended .tier-title { color: var(--recommended); }
  .tier-recommended .tier-title-bar { background: var(--recommended); }
  .tier-nit .tier-title { color: var(--nit); }
  .tier-nit .tier-title-bar { background: var(--nit); }
  .card { background: var(--panel); border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; margin: 16px 0; padding: 20px 24px; scroll-margin-top: 80px; }
  .card-critical { border-left-color: var(--critical); background: var(--critical-bg); }
  .card-important { border-left-color: var(--important); background: var(--important-bg); }
  .card-recommended { border-left-color: var(--recommended); background: var(--recommended-bg); }
  .card-nit { border-left-color: var(--nit); }
  .card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; font-size: 13px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .tier-pill { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 3px 8px; border-radius: 3px; background: var(--panel-2); color: var(--muted); }
  .card-critical .tier-pill { background: var(--critical); color: #1a0707; }
  .card-important .tier-pill { background: var(--important); color: #1a1207; }
  .card-recommended .tier-pill { background: var(--recommended); color: #07111a; }
  .lens { font-size: 11px; padding: 3px 8px; border-radius: 3px; background: var(--panel-2); border: 1px solid var(--border); color: var(--muted); text-transform: lowercase; letter-spacing: 0.02em; }
  .loc { flex: 1; min-width: 0; }
  .file-link { color: var(--link); }
  .pr-link { font-size: 12px; color: var(--muted); padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; }
  .pr-link:hover { color: var(--text); border-color: var(--border-strong); text-decoration: none; }
  .anchor { color: var(--muted); font-size: 14px; opacity: 0; transition: opacity 0.12s; padding: 0 4px; }
  .card:hover .anchor { opacity: 1; }
  .anchor:hover { color: var(--link); text-decoration: none; }
  .card-body { font-size: 15px; line-height: 1.75; }
  .card-body code { background: var(--panel-2); padding: 1px 6px; border-radius: 3px; font-size: 0.88em; }
  .card-body strong { color: var(--text); font-weight: 600; }
  .card-body em { color: var(--text); font-style: italic; }
  .cap-report { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; line-height: 1.7; }
  .cap-report h3 { font-size: 12px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .cap-report ul { padding-left: 20px; margin: 0; }
  .cap-report li { margin: 4px 0; }
  .cap-report code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px; }
  @media (max-width: 720px) {
    main { padding: 32px 20px 80px; }
    .page-head h1 { font-size: 22px; }
    .orientation, .through-line, .diagrams { padding: 20px 22px; }
    .card { padding: 16px 18px; }
    .tier-title { position: static; }
  }
`;

main();
