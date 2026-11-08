import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  inspectReviewHealth,
  isLegalReviewTransition,
  recordReviewComments,
  transitionReview,
} from "../src/review-manifest.mjs";
import { runCli } from "../src/cli-command.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const execFile = promisify(execFileCallback);

test("review lifecycle declares every legal edge explicitly", () => {
  const legal = new Set([
    "review_ready:reviewing",
    "review_ready:integrated",
    "reviewing:changes_requested",
    "reviewing:approved",
    "changes_requested:review_ready",
    "approved:reviewing",
    "approved:integrated",
    "integrated:archived",
  ]);
  const states = [
    "review_ready",
    "reviewing",
    "changes_requested",
    "approved",
    "integrated",
    "archived",
  ];
  for (const from of states) {
    for (const to of states) {
      assert.equal(
        isLegalReviewTransition(from, to),
        legal.has(`${from}:${to}`),
        `${from} -> ${to}`,
      );
    }
  }
});

test("review transitions are atomic, generation-checked, and audited", async (t) => {
  const fixture = await reviewFixture(t);
  const result = await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    now: () => new Date("2026-07-15T12:00:00Z"),
    reason: "Opened the interactive review",
    sessionSlug: "local/session-1",
    to: "reviewing",
  });

  assert.equal(result.changed, true);
  assert.equal(result.manifest.review.generation, 1);
  assert.equal(result.manifest.review.status, "reviewing");
  assert.equal(result.manifest.review.session_slug, "local/session-1");
  assert.deepEqual(result.manifest.review.events[0], {
    actor: "operator",
    comment_ids: [],
    evidence: {
      path: fixture.evidencePath,
      sha256: result.manifest.review.events[0].evidence.sha256,
    },
    from: "review_ready",
    generation: 1,
    head_sha: fixture.head,
    integration_receipt: null,
    kind: "transition",
    prior_generation: 0,
    reason: "Opened the interactive review",
    recorded_at: "2026-07-15T12:00:00.000Z",
    to: "reviewing",
  });
  assert.equal((await validateContract(result.manifest)).valid, true);

  await assert.rejects(
    transitionReview({
      actor: "operator",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 0,
      manifestPath: fixture.manifestPath,
      reason: "Stale writer",
      to: "changes_requested",
    }),
    /expected generation 0, found 1/,
  );
});

test("schema validation rejects unaudited approval and broken generation history", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  const unaudited = structuredClone(fixture.manifest);
  unaudited.review.status = "approved";
  unaudited.review.reviewed_head_sha = fixture.head;
  assert.equal((await validateContract(unaudited)).valid, false);

  const transitioned = await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  transitioned.manifest.review.events[0].prior_generation = 7;
  assert.equal((await validateContract(transitioned.manifest)).valid, false);

  const revisionAlias = structuredClone(fixture.manifest);
  revisionAlias.head.branch = fixture.head;
  assert.equal((await validateContract(revisionAlias)).valid, false);
});

test("durable history binds the current head, approval head, comments, and receipts", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  const approved = await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    readComments: async () => [],
    reason: "Approved",
    to: "approved",
  });

  const wrongLatestHead = structuredClone(approved.manifest);
  wrongLatestHead.review.events.at(-1).head_sha = fixture.base;
  assert.equal((await validateContract(wrongLatestHead)).valid, false);

  const wrongApprovalHead = structuredClone(approved.manifest);
  wrongApprovalHead.review.events.at(-1).head_sha = fixture.base;
  wrongApprovalHead.head.sha = fixture.base;
  wrongApprovalHead.automated_review.reviewed_head_sha = fixture.base;
  assert.equal((await validateContract(wrongApprovalHead)).valid, false);
});

test("review lifecycle rejects illegal transitions and concurrent writers", async (t) => {
  const fixture = await reviewFixture(t);
  await assert.rejects(
    transitionReview({
      actor: "operator",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 0,
      manifestPath: fixture.manifestPath,
      reason: "Skip review",
      to: "approved",
    }),
    /illegal review transition/,
  );

  const attempts = await Promise.allSettled([
    transitionReview({
      actor: "one",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 0,
      manifestPath: fixture.manifestPath,
      reason: "Open one",
      sessionSlug: "session-one",
      to: "reviewing",
    }),
    transitionReview({
      actor: "two",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 0,
      manifestPath: fixture.manifestPath,
      reason: "Open two",
      sessionSlug: "session-two",
      to: "reviewing",
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const persisted = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(persisted.review.generation, 1);
  assert.equal(persisted.review.events.length, 1);
});

test("approval is bound to one current head and branch drift is visible", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  const approved = await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    reason: "Review complete",
    readComments: async () => [],
    to: "approved",
  });
  assert.equal(approved.manifest.review.reviewed_head_sha, fixture.head);
  assert.equal((await inspectReviewHealth(approved.manifest)).health, "current");

  await writeFile(join(fixture.worktree, "file.txt"), "changed again\n");
  await git(fixture.worktree, "add", "file.txt");
  await git(fixture.worktree, "commit", "-m", "branch moved");
  assert.equal((await inspectReviewHealth(approved.manifest)).health, "head_mismatch");

  const changed = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  changed.head.sha = await revParse(fixture.worktree, "HEAD");
  await writeFile(fixture.manifestPath, `${JSON.stringify(changed, null, 2)}\n`);
  assert.equal((await inspectReviewHealth(changed)).health, "head_mismatch");
});

test("a revision head change invalidates automated review before returning review_ready", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    reason: "Requested changes",
    to: "changes_requested",
  });
  await writeFile(join(fixture.worktree, "file.txt"), "revised feature\n");
  await git(fixture.worktree, "commit", "-am", "revise feature");
  const revisedHead = await revParse(fixture.worktree, "HEAD");
  const ready = await transitionReview({
    actor: "builder",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 2,
    headSha: revisedHead,
    manifestPath: fixture.manifestPath,
    reason: "Verified revision is ready",
    to: "review_ready",
  });
  assert.equal(ready.manifest.head.sha, revisedHead);
  assert.equal(ready.manifest.automated_review.status, "pending");
  assert.equal(ready.manifest.automated_review.reviewed_head_sha, null);
  assert.equal(ready.manifest.review.reviewed_head_sha, null);
});

test("new live tuicr comments block approval until their stable IDs are consumed", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  await assert.rejects(
    transitionReview({
      actor: "operator",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 1,
      manifestPath: fixture.manifestPath,
      readComments: async () => [{ id: "late-issue", comment_type: "issue" }],
      reason: "Attempt approval",
      to: "approved",
    }),
    /unconsumed tuicr comment late-issue/,
  );
});

test("late issue comments reopen approval and require a genuinely new reviewed head", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    readComments: async () => [],
    reason: "Approved current head",
    to: "approved",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 2,
    manifestPath: fixture.manifestPath,
    reason: "A late issue appeared",
    sessionSlug: "session-two",
    to: "reviewing",
  });
  const commentsPath = join(fixture.directory, "late-comments.json");
  const issue = [{ id: "late-issue", comment_type: "issue" }];
  await writeFile(commentsPath, `${JSON.stringify({
    schema: "agent-flow.review-comment-dispositions/v1",
    run_id: fixture.manifest.run_id,
    session_slug: "session-two",
    head_sha: fixture.head,
    comments: [{
      id: "late-issue",
      comment_type: "issue",
      disposition: "implemented",
      reason: "Will be verified in a new head",
      evidence_path: fixture.evidencePath,
    }],
  })}\n`);
  await recordReviewComments({
    actor: "builder",
    commentsPath,
    evidencePath: fixture.evidencePath,
    expectedGeneration: 3,
    manifestPath: fixture.manifestPath,
    readComments: async () => issue,
    reason: "Recorded the late issue",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 4,
    manifestPath: fixture.manifestPath,
    reason: "Requested a revision",
    to: "changes_requested",
  });
  await assert.rejects(
    transitionReview({
      actor: "builder",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 5,
      headSha: fixture.head,
      manifestPath: fixture.manifestPath,
      reason: "Tried to reuse the same head",
      to: "review_ready",
    }),
    /issue comments require a new head/,
  );
  await writeFile(join(fixture.worktree, "file.txt"), "late issue fixed\n");
  await git(fixture.worktree, "commit", "-am", "fix late issue");
  const revisedHead = await revParse(fixture.worktree, "HEAD");
  const ready = await transitionReview({
    actor: "builder",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 5,
    headSha: revisedHead,
    manifestPath: fixture.manifestPath,
    reason: "Revision verified",
    to: "review_ready",
  });
  assert.equal(ready.manifest.review.reviewed_head_sha, null);
  assert.equal(ready.manifest.automated_review.status, "pending");
});

test("missing worktrees remain broken and block integration", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await rm(fixture.worktree, { recursive: true });
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal((await inspectReviewHealth(manifest)).health, "missing_worktree");
  await mkdir(fixture.worktree);
  assert.equal((await inspectReviewHealth(manifest)).health, "missing_worktree");
  await assert.rejects(
    transitionReview({
      actor: "operator",
      evidencePath: fixture.evidencePath,
      expectedGeneration: 0,
      integrationReceiptPath: fixture.evidencePath,
      manifestPath: fixture.manifestPath,
      reason: "Cannot integrate",
      to: "integrated",
    }),
    /missing_worktree|integration receipt/,
  );
});

test("comment dispositions are durable, stable-ID based, and idempotent", async (t) => {
  const fixture = await reviewFixture(t);
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  const commentsPath = join(fixture.directory, "comments.json");
  const liveComments = [
    { id: "comment-1", comment_type: "suggestion" },
    { id: "comment-2", comment_type: "praise" },
  ];
  await writeFile(commentsPath, `${JSON.stringify({
    schema: "agent-flow.review-comment-dispositions/v1",
    run_id: fixture.manifest.run_id,
    session_slug: "session-one",
    head_sha: fixture.head,
    comments: [
      {
        id: "comment-1",
        comment_type: "suggestion",
        disposition: "implemented",
        reason: "Applied in the reviewed head",
        evidence_path: fixture.evidencePath,
      },
      {
        id: "comment-2",
        comment_type: "praise",
        disposition: "no_action",
        reason: "No action required",
        evidence_path: fixture.evidencePath,
      },
    ],
  }, null, 2)}\n`);
  const first = await recordReviewComments({
    actor: "builder",
    commentsPath,
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    now: () => new Date("2026-07-15T13:00:00Z"),
    readComments: async () => liveComments,
    reason: "Dispositioned saved tuicr comments",
  });
  assert.equal(first.manifest.review.generation, 2);
  assert.deepEqual(first.manifest.review.consumed_comment_ids, ["comment-1", "comment-2"]);
  assert.equal(first.manifest.review.comment_dispositions.length, 2);

  const duplicateHistory = structuredClone(first.manifest);
  duplicateHistory.review.generation = 3;
  duplicateHistory.review.events.push({
    ...structuredClone(duplicateHistory.review.events.at(-1)),
    generation: 3,
    prior_generation: 2,
  });
  assert.equal((await validateContract(duplicateHistory)).valid, false);

  const duplicate = await recordReviewComments({
    actor: "builder",
    commentsPath,
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    readComments: async () => liveComments,
    reason: "Retry after uncertain response",
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.manifest.review.generation, 2);

  const alternateEvidence = join(fixture.directory, "alternate-evidence.txt");
  await writeFile(alternateEvidence, "durable evidence\n");
  const changedEvidence = JSON.parse(await readFile(commentsPath, "utf8"));
  changedEvidence.comments[0].evidence_path = alternateEvidence;
  await writeFile(commentsPath, `${JSON.stringify(changedEvidence, null, 2)}\n`);
  await assert.rejects(
    recordReviewComments({
      actor: "builder",
      commentsPath,
      evidencePath: fixture.evidencePath,
      expectedGeneration: 2,
      manifestPath: fixture.manifestPath,
      readComments: async () => liveComments,
      reason: "Retry with substituted evidence",
    }),
    /conflicting disposition for comment comment-1/,
  );

  changedEvidence.comments[0].evidence_path = join(fixture.directory, "missing.txt");
  await writeFile(commentsPath, `${JSON.stringify(changedEvidence, null, 2)}\n`);
  await assert.rejects(
    recordReviewComments({
      actor: "builder",
      commentsPath,
      evidencePath: fixture.evidencePath,
      expectedGeneration: 2,
      manifestPath: fixture.manifestPath,
      readComments: async () => liveComments,
      reason: "Retry with missing evidence",
    }),
    /ENOENT|cannot open|no such file/i,
  );

  const conflicting = changedEvidence;
  conflicting.comments[0].evidence_path = fixture.evidencePath;
  conflicting.comments[0].disposition = "declined";
  await writeFile(commentsPath, `${JSON.stringify(conflicting, null, 2)}\n`);
  await assert.rejects(
    recordReviewComments({
      actor: "builder",
      commentsPath,
      evidencePath: fixture.evidencePath,
      expectedGeneration: 2,
      manifestPath: fixture.manifestPath,
      readComments: async () => liveComments,
      reason: "Conflicting retry",
    }),
    /conflicting disposition for comment comment-1/,
  );
});

test("agent-flow exposes transition and comment recording through explicit commands", async (t) => {
  const fixture = await reviewFixture(t);
  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(await runCli([
    "review", "transition",
    "--manifest", fixture.manifestPath,
    "--to", "reviewing",
    "--expected-generation", "0",
    "--actor", "operator",
    "--reason", "Opened review",
    "--evidence", fixture.evidencePath,
    "--session-slug", "session-one",
  ], {
    readReviewComments: async () => [],
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 0);
  assert.match(stdout.value(), /reviewing generation 1/);
  assert.equal(stderr.value(), "");

  const commentsPath = join(fixture.directory, "cli-comments.json");
  await writeFile(commentsPath, `${JSON.stringify({
    schema: "agent-flow.review-comment-dispositions/v1",
    run_id: fixture.manifest.run_id,
    session_slug: "session-one",
    head_sha: fixture.head,
    comments: [{
      id: "cli-note",
      comment_type: "note",
      disposition: "acknowledged",
      reason: "Recorded the requested context",
      evidence_path: fixture.evidencePath,
    }],
  })}\n`);
  assert.equal(await runCli([
    "review", "record-comments",
    "--manifest", fixture.manifestPath,
    "--comments", commentsPath,
    "--expected-generation", "1",
    "--actor", "builder",
    "--reason", "Saved dispositions",
    "--evidence", fixture.evidencePath,
  ], {
    readReviewComments: async () => [{ id: "cli-note", comment_type: "note" }],
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 0);
  assert.match(stdout.value(), /comments generation 2/);
});

test("integration requires a receipt proven against Git and is recoverable", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    reason: "Approved current head",
    readComments: async () => [],
    to: "approved",
  });

  await git(fixture.repo, "merge", "--no-ff", "feature", "-m", "integrate");
  const integratedCommit = await revParse(fixture.repo, "main");
  const integratedTree = await revParse(fixture.repo, "main^{tree}");
  const receiptPath = join(fixture.directory, "integration-receipt.json");
  const receipt = {
    schema: "agent-flow.integration-receipt/v1",
    receipt_id: "receipt-1",
    review_run_id: fixture.manifest.run_id,
    repository: fixture.repo,
    reviewed_head_sha: fixture.head,
    approved_assembly_sha: null,
    target_ref: "refs/heads/main",
    resulting_commit_sha: integratedCommit,
    resulting_tree_sha: integratedTree,
    actor: "integrator",
    integrated_at: "2026-07-15T14:00:00Z",
  };
  assert.equal((await validateContract(receipt)).valid, true);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  await writeFile(join(fixture.repo, "follow-up.txt"), "target advanced\n");
  await git(fixture.repo, "add", "follow-up.txt");
  await git(fixture.repo, "commit", "-m", "advance target after receipt");

  await assert.rejects(
    transitionReview({
      actor: "integrator",
      evidencePath: receiptPath,
      expectedGeneration: 2,
      integrationReceiptPath: receiptPath,
      manifestPath: fixture.manifestPath,
      persistManifest: async () => { throw new Error("simulated manifest write failure"); },
      readComments: async () => [],
      reason: "Git integration completed",
      to: "integrated",
    }),
    /simulated manifest write failure/,
  );
  assert.equal(
    JSON.parse(await readFile(fixture.manifestPath, "utf8")).review.status,
    "approved",
  );

  const integrated = await transitionReview({
    actor: "integrator",
    evidencePath: receiptPath,
    expectedGeneration: 2,
    integrationReceiptPath: receiptPath,
    manifestPath: fixture.manifestPath,
    readComments: async () => [],
    reason: "Git integration completed",
    to: "integrated",
  });
  assert.equal(integrated.manifest.review.status, "integrated");
  assert.equal(integrated.manifest.review.integration_receipts.length, 1);

  const forgedReceiptReference = structuredClone(integrated.manifest);
  forgedReceiptReference.review.integration_receipts[0].path = fixture.evidencePath;
  assert.equal((await validateContract(forgedReceiptReference)).valid, false);

  const duplicate = await transitionReview({
    actor: "integrator",
    evidencePath: receiptPath,
    expectedGeneration: 2,
    integrationReceiptPath: receiptPath,
    manifestPath: fixture.manifestPath,
    reason: "Recover response after manifest write",
    to: "integrated",
  });
  assert.equal(duplicate.changed, false);

  const archived = await transitionReview({
    actor: "operator",
    evidencePath: receiptPath,
    expectedGeneration: 3,
    manifestPath: fixture.manifestPath,
    reason: "Review artifacts retained",
    to: "archived",
  });
  assert.equal(archived.manifest.review.status, "archived");
});

test("an invalid receipt never advances the manifest", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  const receiptPath = join(fixture.directory, "bad-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema: "agent-flow.integration-receipt/v1",
    receipt_id: "receipt-bad",
    review_run_id: fixture.manifest.run_id,
    repository: fixture.repo,
    reviewed_head_sha: fixture.head,
    approved_assembly_sha: null,
    target_ref: "refs/heads/feature",
    resulting_commit_sha: fixture.head,
    resulting_tree_sha: await revParse(fixture.repo, `${fixture.head}^{tree}`),
    actor: "integrator",
    integrated_at: "2026-07-15T14:00:00Z",
  }, null, 2)}\n`);
  await assert.rejects(
    transitionReview({
      actor: "integrator",
      evidencePath: receiptPath,
      expectedGeneration: 0,
      integrationReceiptPath: receiptPath,
      manifestPath: fixture.manifestPath,
      reason: "Attempt before Git success",
      to: "integrated",
    }),
    /receipt|target|tree|ancestor/,
  );
  const persisted = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(persisted.review.status, "review_ready");
  assert.equal(persisted.review.generation ?? 0, 0);
});

test("review_ready integrates directly only with optional human review and a valid receipt", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed" });
  await git(fixture.repo, "merge", "--no-ff", fixture.head, "-m", "integrate directly");
  const receiptPath = join(fixture.directory, "direct-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema: "agent-flow.integration-receipt/v1",
    receipt_id: "receipt-direct",
    review_run_id: fixture.manifest.run_id,
    repository: fixture.repo,
    reviewed_head_sha: fixture.head,
    approved_assembly_sha: null,
    target_ref: "refs/heads/main",
    resulting_commit_sha: await revParse(fixture.repo, "main"),
    resulting_tree_sha: await revParse(fixture.repo, "main^{tree}"),
    actor: "integrator",
    integrated_at: "2026-07-15T15:00:00Z",
  }, null, 2)}\n`);
  const result = await transitionReview({
    actor: "integrator",
    evidencePath: receiptPath,
    expectedGeneration: 0,
    integrationReceiptPath: receiptPath,
    manifestPath: fixture.manifestPath,
    reason: "Human review was optional",
    to: "integrated",
  });
  assert.equal(result.manifest.review.status, "integrated");
  assert.equal(result.manifest.review.reviewed_head_sha, null);
});

test("receipt reconciliation supports a review and target in one checkout", async (t) => {
  const fixture = await reviewFixture(t, { automated: "passed", sameCheckout: true });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 0,
    manifestPath: fixture.manifestPath,
    reason: "Opened review",
    sessionSlug: "session-one",
    to: "reviewing",
  });
  await transitionReview({
    actor: "operator",
    evidencePath: fixture.evidencePath,
    expectedGeneration: 1,
    manifestPath: fixture.manifestPath,
    readComments: async () => [],
    reason: "Approved",
    to: "approved",
  });
  await git(fixture.repo, "switch", "main");
  await git(fixture.repo, "merge", "--no-ff", fixture.head, "-m", "integrate");
  const receiptPath = join(fixture.directory, "same-checkout-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema: "agent-flow.integration-receipt/v1",
    receipt_id: "same-checkout",
    review_run_id: fixture.manifest.run_id,
    repository: fixture.repo,
    reviewed_head_sha: fixture.head,
    approved_assembly_sha: null,
    target_ref: "refs/heads/main",
    resulting_commit_sha: await revParse(fixture.repo, "main"),
    resulting_tree_sha: await revParse(fixture.repo, "main^{tree}"),
    actor: "integrator",
    integrated_at: "2026-07-15T16:00:00Z",
  })}\n`);
  const result = await transitionReview({
    actor: "integrator",
    evidencePath: receiptPath,
    expectedGeneration: 2,
    integrationReceiptPath: receiptPath,
    manifestPath: fixture.manifestPath,
    readComments: async () => [],
    reason: "Reconciled the shared checkout",
    to: "integrated",
  });
  assert.equal(result.manifest.review.status, "integrated");
});

async function reviewFixture(t, { automated = "pending", sameCheckout = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-review-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const worktree = sameCheckout ? repo : join(directory, "worktree");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "file.txt"), "base\n");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "-m", "base");
  const base = await revParse(repo, "HEAD");
  await git(repo, "branch", "feature");
  if (sameCheckout) await git(repo, "switch", "feature");
  else await git(repo, "worktree", "add", worktree, "feature");
  await writeFile(join(worktree, "file.txt"), "feature\n");
  await git(worktree, "commit", "-am", "feature");
  const head = await revParse(worktree, "HEAD");
  const evidencePath = join(directory, "evidence.txt");
  await writeFile(evidencePath, "durable evidence\n");
  const manifest = {
    schema: "agent-flow.local-review/v1",
    run_id: "feature-review-1",
    flow: "feature",
    summary: "Review the feature",
    created_at: "2026-07-15T11:00:00Z",
    repo,
    worktree,
    base: { branch: "main", sha: base },
    head: { branch: "feature", sha: head },
    kanban: { board: "reviews", tenant: "feature-review-1", task: "t_feature" },
    external_ref: null,
    artifacts: {
      review_summary: evidencePath,
      verification: evidencePath,
      journal: evidencePath,
      automated_findings: null,
      diagram: null,
    },
    automated_review: {
      status: automated,
      reviewed_head_sha: automated === "passed" ? head : null,
      findings_path: null,
      urgency: "standard",
      max_comments: 20,
      per_tier_caps: { critical: 20, important: 20, recommended: 20, nit: 0 },
    },
    review: {
      status: "review_ready",
      session_slug: null,
      reviewed_head_sha: null,
      consumed_comment_ids: [],
    },
  };
  const manifestPath = join(directory, "review.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { base, directory, evidencePath, head, manifest, manifestPath, repo, worktree };
}

async function git(cwd, ...args) {
  return execFile("git", ["-C", cwd, ...args]);
}

async function revParse(cwd, revision) {
  return (await git(cwd, "rev-parse", revision)).stdout.trim();
}

function captureStream() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}
