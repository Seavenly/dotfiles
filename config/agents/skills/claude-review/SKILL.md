---
name: claude-review
description: Run a Sol-led iterative review with a read-only Claude Code Opus 5.5 CLI reviewer at medium effort, then delegate accepted corrections and affected verification to native Sol agents at medium or high effort, or Luna agents at max effort with --luna. Use only when invoked as /claude-review or $claude-review.
argument-hint: "[--luna] [review context]"
disable-model-invocation: true
---

# Claude Review

Review a completed local candidate as the Sol primary agent. Sol owns scope,
guidance, authority, adjudication, and the final gate. Treat neither the Claude
review nor a workhorse handoff as proof; inspect the actual candidate state.

Accept an optional `--luna` flag before or after any review context. Reject a
repeated flag; preserve the remaining context for candidate and scope selection.
The flag selects native workhorses only. The Claude reviewer always uses
`claude-opus-5-5` at medium effort, including clarification and re-review.

Select and record the native workhorse model once per review:

- Without `--luna`, select the newest versioned Sol model advertised by the
  native sub-agent launch tool (currently `gpt-6.1-sol`), comparing numeric
  versions rather than model-name string order. Do not invent an unadvertised ID.
- With `--luna`, select exactly `gpt-6-luna` at `reasoning_effort: max` for every
  native task.
- For Sol, default to `reasoning_effort: medium` for bounded reconnaissance,
  straightforward corrections, tests, documentation, and running verification.
  Use `high` for complex debugging, changes requiring reasoning across
  interacting modules or invariants, and ambiguous-finding investigations.
  Choose `high` when complexity or risk is uncertain; mixed tasks use the
  highest effort their work requires. Suite size alone does not require high.

Pin the model and effort policy in the retained ledger across rounds and later
follow-ups. Record each native task's model ID, effort, and reason before launch.
If a medium-effort Sol task needs high effort, inspect current candidate state
and launch a new explicitly configured high-effort agent with bounded context
and retained evidence. Finish or stop the original agent before replacement;
preserve scope, candidate ownership, and the Claude response cap.

1. Pin the request or spec, repository guidance, exact candidate cwd, and base.
   For each round, record `HEAD` and the exact contents of staged, unstaged,
   and untracked candidate changes: a Git tree OID or retained patches and
   untracked-file content hashes. Include the content of untracked files in the
   review input when it is in scope. `HEAD` and status alone do not identify
   uncommitted content. Keep the snapshot and finding ledger outside the
   candidate worktree. Preserve unrelated user changes and stop if the
   candidate moves while a review round is in progress.

2. Prepare a review prompt that names the acceptance criteria, parent/blocker
   constraints, candidate identity, base, and exact state snapshot. Include
   the relevant repository guidance explicitly, because restricted Claude
   sessions do not load user or project settings. Request actionable
   correctness, regression, security, test, and spec findings with evidence
   and locations. Do not require reviewer network access. Make the retained
   patches and untracked-file content available in the prompt or in an
   evidence directory passed with `--add-dir`; do not rely on Claude running
   Git commands to discover them.

   From the candidate cwd, start one fresh Claude Code CLI conversation with
   a new UUID and save its complete JSON result outside the candidate worktree:

   ```sh
   claude -p --session-id <new-uuid> \
     --model claude-opus-5-5 --effort medium \
     --restricted --strict-mcp-config --tools "Read,Glob,Grep" \
     --permission-mode dontAsk --permission-prompts none \
     --output-format json < <review-prompt-file> > <review-result-file>
   ```

   Add `--add-dir <evidence-dir>` if Claude needs to read retained evidence
   outside the candidate cwd. Do not add Bash, file-editing, web, or MCP tools,
   or use `--bare`, `--no-session-persistence`, or a model fallback. Check the
   process exit status, JSON result, session ID, and any available model or
   permission-denial metadata before accepting a response. A failed or
   ambiguous launch is not a review result. Record the UUID, process handle
   while it runs, result path, and response count with the ledger.

   If the process yields to the caller, wait on that same process handle.
   Use the exact UUID for each later clarification or re-review:

   ```sh
   claude -p --resume <session-id> \
     --model claude-opus-5-5 --effort medium \
     --restricted --strict-mcp-config --tools "Read,Glob,Grep" \
     --permission-mode dontAsk --permission-prompts none \
     --output-format json < <follow-up-prompt-file> > <follow-up-result-file>
   ```

   Repeat the same working directory and evidence access on resume. Do not
   use `--continue`, `--fork-session`, or a fresh reviewer for ordinary
   follow-ups. If the session cannot be resumed or its identity cannot be
   established, retain the transcript and results, report the review as
   blocked, and stop rather than silently replacing the reviewer.

3. Adjudicate every finding as exactly one of `valid in-scope`, `invalid`,
   `out-of-scope`, or `needs clarification`. For substantial code tracing,
   reproduction, or test-gap investigation, delegate a bounded evidence task
   to a workhorse under step 4 without candidate-edit authority. Require
   locations, reproduction/check results, and a proposed disposition; Sol
   inspects the decisive evidence and owns the decision. Obvious findings can
   proceed directly to correction. Ask the same Claude session when reviewer
   clarification is necessary. Keep stable finding IDs, dispositions, and
   reasons in the retained ledger.

4. Batch all accepted (`valid in-scope`) findings into a bounded correction
   task for a direct native, bounded/self-contained fork pinned to the
   selected model and task-specific reasoning effort above. Record the
   requested and observed model override and reasoning setting. State the
   exact cwd and candidate, owned files or scope, exclusions, required
   affected tests or checks, and that the workhorse has no commit, push,
   merge, issue-closing, or worktree-removal authority. The workhorse must
   address all accepted comments, including small ones. Do not silently
   substitute another model; if the selected workhorse launch is impossible,
   stop and report the blocked review. Reuse the same workhorse agent while
   its recorded effort remains appropriate for related investigation and
   correction turns, granting edit authority only after Sol accepts the
   findings. Have the workhorse confirm workspace access and required tools
   before substantive work, and report execution blockers immediately with the
   failed operation.

5. Require the workhorse to implement corrections and run affected
   verification, then return a compact handoff identifying exact `HEAD`,
   changed files, `git status --short`, commands and results, failures or
   flakes, and residual risks. Map each corrected finding ID to its change and
   verification evidence bound to the candidate snapshot. Avoid ingesting
   routine full logs. Sol inspects the actual diff, status, candidate
   identity, and concise evidence. Record a concrete risk or evidence
   discrepancy before duplicating the workhorse's passing checks; delegate
   substantial diagnosis and full validation to workhorses. After edits,
   record a fresh candidate identity and staged, unstaged, and untracked
   snapshot. If the handoff is incomplete or its evidence fails the task
   contract, send a bounded follow-up under explicit Sol guidance. Do not
   require a follow-up merely because a correction is substantial, and do not
   implement the correction in Sol.

6. If a correction materially changes behavior, interfaces, control flow,
   tests, or security-relevant code, re-review with the same Claude session.
   Identify old and new candidate identities, what changed, the new snapshot,
   and verification results in the follow-up prompt. A small correction may
   skip re-review only when Sol records why it adds no meaningful assurance.

7. All review, clarification, and re-review responses share a hard
   three-response cap unless the user explicitly extends the budget. Retain
   the count with the ledger across process and host restarts. If the cap is
   reached with an unresolved valid or `needs clarification` finding, report
   the review incomplete. If a material correction requires re-review but the
   cap prevents it, report that correction as unreviewed. Do not weaken a
   disposition or silently continue with a different reviewer.

8. Before reporting completion, Sol independently confirms the final diff and
   repository state are within pinned scope and reconciles the ledger against
   that candidate. Every accepted finding needs a workhorse correction and
   passing affected-verification evidence; every material correction needs a
   reviewer result. Any unresolved valid or `needs clarification` finding or
   missing required evidence leaves the review incomplete. Report rounds,
   every disposition and reason, candidate snapshots, Claude session ID and
   results, workhorse handoffs, re-review results, verification, blockers, and
   residual risks. Link the retained ledger and candidate evidence so later
   integration can resume without reconstructing them from chat. Do not
   commit, push, merge, or close issues as part of this skill.