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
   For each review round, record the current `HEAD` and a snapshot of staged,
   unstaged, and untracked state. Preserve unrelated user changes. Do not
   review a moving or ambiguous candidate.

2. From the candidate cwd, invoke one fresh, read-only Drovr reviewer with a
   fresh task key:

   ```sh
   drovr delegate --task-key <key> --agent-key reviewer --cwd <cwd> \
     --role reviewer --harness claude --model opus --effort medium \
     --capability read-only "<scope and review request>"
   ```

   Request actionable correctness, regression, security, test, and spec
   findings, each with evidence and a location. Include the round's candidate
   identity and state snapshot. Record the agent ID. Resume incomplete turns
   with that same agent; never replace it.

3. Adjudicate every finding as exactly one of `valid in-scope`, `invalid`,
   `out-of-scope`, or `needs clarification`. Use `drovr ask` on the same
   reviewer only when clarification or review evidence is necessary. Keep a
   disposition and reason for every finding.

4. Batch all accepted (`valid in-scope`) findings into a bounded correction
   task for a direct native, bounded/self-contained fork pinned to
   `gpt-5.6-luna` with `reasoning_effort: max`. Record the requested and
   observed model override and reasoning setting. The task must state the
   exact cwd and candidate, owned files or scope, exclusions, required affected
   tests or checks, and that the agent has no commit, push, merge, issue-closing,
   or worktree-removal authority. Luna must address all accepted comments,
   including small ones. Do not silently substitute another model; if the
   required Luna launch is impossible, stop and report the blocked review.

5. Require Luna to implement the corrections and run the affected
   verification, then return a compact handoff identifying exact `HEAD`, the
   changed-file list, and `git status --short` state, plus commands and
   results, failures or flakes, and residual risks. Avoid ingesting routine
   full logs. Sol must inspect the actual diff, status, candidate identity, and
   concise evidence. After Luna edits, record the new candidate identity and a
   fresh staged/unstaged/untracked snapshot; do not treat the original `HEAD`
   as current. If the handoff is incomplete, the actual diff or evidence fails
   the task contract, or Sol finds an issue, send a bounded follow-up to Luna
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
   three-response cap. If the cap is reached while any valid in-scope finding
   or `needs clarification` finding remains unresolved, do not declare the
   review complete; report the unresolved findings and stop. If a material
   correction requires re-review but the cap prevents it, report that
   correction as unreviewed and do not declare the Drovr review complete. Do
   not weaken a disposition or silently continue with another reviewer.

8. Before reporting completion, Sol must independently confirm the final diff
   and repository state are within the pinned scope, every accepted finding
   has a Luna correction and affected-verification result, every material
   correction has a reviewer result, and no valid or `needs clarification`
   finding remains unresolved or unreviewed. Report review rounds, every
   disposition and reason, candidate identities and state snapshots, Luna
   handoffs, re-review results, verification, blockers, and residual risks. Do
   not commit, push, merge, or close issues as part of this skill.
