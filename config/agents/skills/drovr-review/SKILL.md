---
name: drovr-review
description: Run a Sol-led iterative Drovr review with a read-only Claude Code Opus reviewer at medium effort, then delegate accepted corrections and affected verification to native gpt-5.6-luna agents. Use only when invoked as /drovr-review or $drovr-review.
disable-model-invocation: true
---

# Drovr Review

Review a completed local candidate as the Sol primary agent. Sol owns scope,
guidance, authority, adjudication, and the final gate. Do not treat a reviewer
or Luna summary as proof; inspect the actual candidate state.

1. Pin the request or spec, repository guidance, exact candidate cwd, and base.
   For each review round, record the current `HEAD` and the exact contents of
   staged, unstaged, and untracked candidate changes: a Git tree OID or
   retained patches and untracked-file content hashes. `HEAD` and status alone
   do not identify uncommitted content. Preserve unrelated user changes. Do not
   review a moving or ambiguous candidate.

2. From the candidate cwd, invoke one fresh, read-only Drovr reviewer with a
   fresh task key. Run Drovr with login-shell startup disabled so the caller
   and managed pane resolve the same tracked harness executable. Before the
   first launch, run `drovr doctor` once from that same cwd and non-login shell;
   stop on an unqualified result instead of creating or retrying a reviewer.

   ```sh
   drovr delegate --task-key <key> --agent-key reviewer --cwd <cwd> \
     --role reviewer --harness claude --model opus --effort medium \
     --capability read-only "<scope and review request>"
   ```

   Request actionable correctness, regression, security, test, and spec
   findings with evidence and locations. Embed the acceptance criteria,
   parent/blocker constraints, candidate identity, and state snapshot; do not
   require reviewer network access. Record the agent ID. Resume incomplete
   turns with that same agent; never replace it.

   Retain the returned task, agent, and turn IDs. Resume a yielded automation
   process through its existing process/session handle. Otherwise observe only
   the exact turn with `drovr turn wait TURN_ID`, use `drovr turn get TURN_ID`
   for a nonblocking snapshot, and add `--include-messages` only when the
   transcript is needed. Use `drovr ask AGENT_ID "<prompt>"` and
   `drovr agent get AGENT_ID` exactly. Do not use unfiltered `drovr status` to
   rediscover known work; if IDs were lost, use `drovr status --agent AGENT_ID`
   or `drovr status --task TASK_ID`.

   If a later turn alone is blocked by the typed `caller_shell_mismatch`
   outcome after at least one correlated reviewer response, first retry from
   the same non-login shell and run `drovr doctor`. If the original reviewer
   still cannot resume, an evidence-preserving rollover is the only permitted
   replacement. Capture `drovr agent get AGENT_ID` and `drovr turn get TURN_ID
   --include-messages` outside the candidate worktree, hash both records, and
   launch one fresh reviewer with the same role, harness, model, effort, and
   read-only capability. Bind its prompt to the original IDs, record hashes,
   prior response count, complete finding/disposition ledger, and current
   candidate snapshot. Report the new agent as a rollover, never as the same
   reviewer. Count responses from both agents against the shared three-response
   cap. Do not roll over any other compatibility or identity failure.

3. Adjudicate every finding as exactly one of `valid in-scope`, `invalid`,
   `out-of-scope`, or `needs clarification`. For substantial code tracing,
   reproduction, or test-gap investigation, delegate a bounded evidence task
   using the Luna launch contract in step 4, with no candidate-edit authority.
   Require locations, reproduction/check results, and a proposed disposition;
   Sol inspects decisive evidence and owns the decision. Obvious findings can
   proceed directly to correction. Use `drovr ask` on the same reviewer when
   reviewer clarification is necessary. Keep stable finding IDs, dispositions,
   and reasons in a ledger outside the candidate worktree.

4. Batch all accepted (`valid in-scope`) findings into a bounded correction
   task for a direct native, bounded/self-contained fork pinned to
   `gpt-5.6-luna` with `reasoning_effort: max`. Record the requested and
   observed model override and reasoning setting. The task must state the
   exact cwd and candidate, owned files or scope, exclusions, required affected
   tests or checks, and that the agent has no commit, push, merge, issue-closing,
   or worktree-removal authority. Luna must address all accepted comments,
   including small ones. Do not silently substitute another model; if the
   required Luna launch is impossible, stop and report the blocked review.
   Reuse the same Luna agent for related investigation and correction turns,
   explicitly granting edit authority only after Sol accepts the findings.
   Have it confirm workspace access and required tools before substantive
   work, and report execution blockers immediately with the failed operation.

5. Require Luna to implement the corrections and run the affected
   verification, then return a compact handoff identifying exact `HEAD`, the
   changed-file list, and `git status --short` state, plus commands and
   results, failures or flakes, and residual risks. Map each corrected finding
   ID to its change and verification evidence bound to the candidate snapshot.
   Avoid ingesting routine full logs. Sol must inspect the actual diff, status,
   candidate identity, and concise evidence. Record a concrete risk or evidence
   discrepancy before duplicating Luna's passing checks; delegate substantial
   diagnosis and full validation to Luna. After Luna edits, record the new
   candidate identity and a fresh staged/unstaged/untracked snapshot; do not
   treat the original `HEAD` as current. If the handoff is incomplete, the actual
   diff or evidence fails the task contract, or Sol finds an issue, send a bounded follow-up to Luna
   under explicit Sol guidance. Do not require a follow-up merely because a
   correction is substantive, and do not implement the correction in Sol.

6. If a correction materially changes behavior, interfaces, control flow,
   tests, or security-relevant code, ask the original Drovr reviewer to
   re-review the resulting candidate with `drovr ask <agent-id>`, explicitly
   identifying the old and new candidate identities, what changed, the new
   changed-file/status snapshot, verification results, and the re-review
   request. Reuse that reviewer for every subsequent turn. A small correction
   may skip a new review only when Sol records why it adds no meaningful
   assurance.

7. All clarification, review, and re-review responses share a hard
   three-response cap unless the user explicitly extends the budget. Retain the
   response count with the finding ledger across resumptions; a new turn or host
   restart does not reset it. If the cap is reached while any valid in-scope or
   `needs clarification` finding remains unresolved, do not declare the
   review complete; report the unresolved findings and stop. If a material
   correction requires re-review but the cap prevents it, report that
   correction as unreviewed and do not declare the Drovr review complete. Do
   not weaken a disposition or silently continue with another reviewer.

8. Before reporting completion, Sol must independently confirm the final diff
   and repository state are within the pinned scope and reconcile the ledger
   against that candidate. Every accepted finding needs a Luna correction and
   passing affected-verification evidence; every material correction needs a
   reviewer result. Any unresolved valid or `needs clarification` finding, or
   missing required evidence, leaves the review incomplete regardless of
   severity or budget exhaustion. Report review rounds, every disposition and
   reason, candidate identities and state snapshots, Luna
   handoffs, re-review results, verification, blockers, and residual risks. Link
   the retained ledger and candidate evidence so later integration can resume
   without reconstructing them from chat. Do not commit, push, merge, or close
   issues as part of this skill.
