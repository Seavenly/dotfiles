# Implementation Protocol

Read the complete issue body and all comments. Also read its parent
specification, linked blocking issues, `AGENTS.md`, `CONTEXT.md`, relevant ADRs,
and repository guidance referenced by those documents.

## Execution roles

Run this protocol as a Sol lead. The lead owns scope, planning, delegation,
integration decisions, and final acceptance. Use sub-agents running
`gpt-5.6-luna` with `reasoning_effort: max` as the implementation workhorses for
code, tests, focused diagnosis, review, and review corrections.

Do not silently substitute another workhorse model. If Luna Max sub-agents
cannot be launched, stop and report that this skill's required execution model
is unavailable. A model override requires a self-contained or bounded-context
fork rather than a full-history fork. Give each sub-agent all task-local facts
it needs in its prompt. Set and record the exact model and reasoning override on
every launch. Do not accept work from a launch whose requested configuration is
missing, rejected, or replaced. Treat a timeout as an incomplete attempt:
inspect repository state before retrying or assigning follow-up work.

The Sol lead must not treat a sub-agent's summary as proof. Inspect the actual
diff and repository state, check reported test output, and independently decide
whether each work packet and the complete ticket meet their contracts. Reserve
direct Sol edits for small integration adjustments; delegate substantive
implementation and correction work to Luna Max.

## Worktree requirement

You are responsible for creating and using a dedicated Git worktree and ticket
branch for this implementation.

Before editing:

- Confirm that every native blocking issue is closed. If a blocker remains
  open, stop and report it.
- Inspect the existing worktree and preserve all user changes.
- Determine the correct source branch and starting commit from the repository
  and ticket context. Do not assume the repository's default branch is the
  correct source.
- Record the exact starting commit SHA.
- Create a uniquely named branch for this ticket from that commit.
- Create a dedicated Git worktree checked out on the ticket branch.
- Perform all implementation, testing, review corrections, and commits inside
  that worktree.
- Do not implement directly in the user's existing worktree.
- Do not copy existing uncommitted changes into the ticket worktree unless they
  are clearly part of this ticket. If they appear necessary but their ownership
  is ambiguous, stop and explain the conflict.
- Leave the completed worktree and branch intact for subsequent inspection or
  integration. Do not remove them automatically.

Treat the ticket's decisions, scope, acceptance criteria, and testing seams as
settled. Do not reopen planning unless implementation reveals a genuine
contradiction or missing decision.

Implement only this ticket. Do not begin dependent or adjacent tickets.

Implement the ticket end to end from the operator's perspective.

## Plan before delegation

After creating the worktree and before any implementation edit, produce and
record a concrete plan in the lead's durable plan state. Keep its work packets
and acceptance matrix current throughout the run, and reproduce the final
acceptance matrix in the completion report. The plan is ready only when it:

- Maps every acceptance criterion to an observable verification.
- Identifies the end-user path and the public test seams, including the initial
  failing reproduction for a bug.
- Decomposes the work into bounded vertical work packets with explicit scope,
  file or module ownership, dependencies, and completion checks.
- Separates packets that can safely run in parallel from packets that must run
  in sequence. Never assign concurrent writers to overlapping files or shared
  mutable state.
- Includes focused tests, static checks, full relevant validation, two-axis
  review, correction loops, and final commit verification.
- Avoids speculative work and covers the complete operator-visible outcome.

The Sol lead must resolve gaps in this plan from the issue and repository
evidence before delegating. If the evidence contains a genuine contradiction
or missing decision that materially changes the result, stop and ask the user.

## Delegate and iterate

Delegate each work packet to a Luna Max sub-agent. Every prompt must state:

- The ticket goal, relevant acceptance criteria, and the exact worktree path.
- The packet's bounded scope, owned files or modules, dependencies, and explicit
  exclusions.
- Applicable repository guidance and source documents to read.
- The required test-first seam or other verification steps.
- Commands the agent should run and the evidence it must report.
- That it shares the worktree with other agents, must preserve unrelated work,
  and must not commit, push, merge, close issues, or remove worktrees unless the
  Sol lead explicitly authorizes that exact action.
- That it must not spawn another writing agent or expand its ownership without
  approval from the Sol lead.

Use parallel Luna Max agents only for independent, non-overlapping packets and
within the available concurrency limit. Treat lockfiles, generated outputs,
formatter scope, build caches, and repository-wide commands as shared mutable
state: assign them to one owner or serialize the affected packets. Use follow-up
tasks with the same agent when continuity helps. Use a fresh Luna Max agent when
an independent diagnosis or review is more valuable than retained context.

After each packet:

1. Inspect its diff, test changes, and command evidence against the packet
   contract and the overall plan.
2. Run or inspect an appropriate focused check independently when the change is
   risky, the evidence is incomplete, or the result is surprising.
3. Send concrete findings back to a Luna Max agent for correction. Do not absorb
   unfinished substantive implementation into the Sol role.
4. Repeat the inspect-correct-verify loop until the packet is satisfactory or a
   genuine blocker is proven.
5. Update the plan and acceptance matrix from repository evidence. Do not mark
   work complete only because an agent says it is complete.

Use the TDD skill where practical at the pre-agreed seams:

- Write a failing test first.
- Verify that it fails for the expected reason.
- Implement the smallest complete behavior that makes it pass.
- Refactor while keeping the tests green.
- Prefer tests against stable public contracts and observable behavior over
  internal implementation details.

Keep feedback loops tight:

- Run the relevant single test files regularly.
- Run typechecking or the repository's equivalent static checks regularly.
- Run applicable formatting and lint checks.
- Once the work is complete, run the full relevant test suite once.
- Treat failures and flakiness caused by this work as engineering problems to
  resolve.
- If an unrelated pre-existing failure prevents validation, capture clear
  evidence and report it without silently expanding scope.

Verify every acceptance criterion explicitly. For operator-facing behavior,
exercise the closest practical end-user path and inspect its rendered or
projected result where applicable.

Once implementation and validation are complete, use the code-review skill to
review the diff from the current review fixed point along both axes:

- Standards: repository guidance, maintainability, safety, tests, and
  documented engineering conventions.
- Specification: the ticket, its parent specification, acceptance criteria,
  and operator-visible behavior.

Apply the code-review skill's two-axis rubric, but have the Sol lead launch both
independent review agents directly so each launch explicitly records
`gpt-5.6-luna` and `reasoning_effort: max`. Do not delegate the review-skill
invocation to an agent that could choose unpinned reviewers. The Sol lead must
inspect each finding against the source evidence, keep valid findings separate
by axis, and delegate every valid in-scope correction to Luna Max.

Address every valid in-scope review finding. Rerun the affected focused checks
after each correction and rerun final validation if the corrections materially
changed behavior.

Before accepting the result, the Sol lead must verify:

- The final diff is limited to the ticket and contains no unexplained changes.
- Every acceptance criterion has concrete passing evidence.
- The closest practical end-user path works.
- Focused tests, static checks, formatting and lint checks, and the full relevant
  suite have the required passing evidence.
- Both review axes are clear or every finding has a recorded disposition.
- The ticket branch and worktree are clean except for the intended final diff.

After the last implementation or correction edit, the Sol lead must personally
run the agreed final command matrix, including the full relevant suite. Earlier
or agent-reported results are supporting evidence, not a substitute for this
final run. If the final matrix changes generated files, inspect those changes
and repeat any invalidated check.

If a check fails or flakes, delegate bounded diagnosis and correction to Luna
Max, then repeat the affected validation and review. Preserve evidence for a
proven unrelated pre-existing failure rather than weakening the gate.

Commit the completed work to the ticket branch inside the dedicated worktree.
Use a concise commit message describing the delivered behavior. Do not add
agent attribution or co-author trailers. Commit only after the Sol lead accepts
the final diff, then verify the resulting commit and clean worktree directly.

Finish with a concise report containing:

- Worktree path
- Ticket branch
- Starting commit SHA
- Final review fixed-point SHA
- Resulting commit SHA
- What was delivered
- Acceptance criteria verification
- Tests and checks run
- Code-review findings and dispositions
- Any genuine residual risks or pre-existing validation failures

## Aggregate branch management

The durable integration branch is `feature/flow-runtime`.

- Fetch `refs/heads/feature/flow-runtime` into the remote-tracking ref
  `refs/remotes/origin/feature/flow-runtime`. Resolve and record that exact SHA
  as both the ticket source and initial review fixed point.
- A later "merge and close" follow-up resumes the preserved worktree and branch
  named in the completion report. Verify their paths, refs, commits, and clean
  state before mutation. If that identity is unavailable or ambiguous, stop.
- Before integration, fetch the remote-tracking ref again. If it moved, merge
  the new remote SHA into the ticket branch without rebasing. Resolve only
  interactions required by this ticket, then use the new remote SHA as the
  review fixed point. Any changed ticket head requires the Sol final command
  matrix and fresh two-axis review over the new fixed point through `HEAD`.
- During implementation, do not integrate, push, or close the issue.
- If the user later says "merge and close," that explicitly authorizes:
  1. Verifying the fetched remote SHA is an ancestor of the exact reviewed
     ticket head.
  2. Pushing that exact head to `refs/heads/feature/flow-runtime` with a normal
     non-force push.
  3. Verifying the remote SHA matches the reviewed local SHA.
  4. Closing the ticket only after publication succeeds.
- Push the aggregate branch, not the ticket branch.
- Do not mutate a dirty worktree where the aggregate branch is checked out. The
  exact-SHA push above does not require checking out or rewriting that local
  branch.
- If the remote moves again after review or the update is not a fast-forward,
  stop and repeat the fetch, merge, validation, and review sequence. Never
  rebase or force-push.
- Do not merge into `main`, open a pull request, or remove worktrees unless
  explicitly requested.

Do not merge, push, open a pull request, close the issue, or remove the worktree
during implementation. A later explicit "merge and close" instruction
authorizes only the aggregate publication sequence defined above.
