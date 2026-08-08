# Implementation Protocol

Read the complete issue body and all comments. Also read its parent
specification, linked blocking issues, `AGENTS.md`, `CONTEXT.md`, relevant ADRs,
and repository guidance referenced by those documents.

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
review the diff from the recorded starting commit along both axes:

- Standards: repository guidance, maintainability, safety, tests, and
  documented engineering conventions.
- Specification: the ticket, its parent specification, acceptance criteria,
  and operator-visible behavior.

Address every valid in-scope review finding. Rerun the affected focused checks
after each correction and rerun final validation if the corrections materially
changed behavior.

Commit the completed work to the ticket branch inside the dedicated worktree.
Use a concise commit message describing the delivered behavior. Do not add
agent attribution or co-author trailers.

Finish with a concise report containing:

- Worktree path
- Ticket branch
- Starting commit SHA
- Resulting commit SHA
- What was delivered
- Acceptance criteria verification
- Tests and checks run
- Code-review findings and dispositions
- Any genuine residual risks or pre-existing validation failures

## Aggregate branch management

The durable integration branch is `feature/flow-runtime`.

- Fetch `origin/feature/flow-runtime` and use its latest verified commit as the
  ticket source. Record that SHA.
- Before integration, fetch it again and merge any movement into the ticket
  branch. Any changed ticket head requires full revalidation and repeat review.
- During implementation, do not integrate, push, or close the issue.
- If the user later says "merge and close," that explicitly authorizes:
  1. Fast-forwarding `feature/flow-runtime` to the reviewed ticket head.
  2. Pushing `feature/flow-runtime` with a normal non-force push.
  3. Verifying the remote SHA matches the reviewed local SHA.
  4. Closing the ticket only after publication succeeds.
- Push the aggregate branch, not the ticket branch.
- If the remote moved or fast-forward integration is impossible, stop, resync
  the ticket, revalidate, and repeat review. Never rebase or force-push.
- Do not merge into `main`, open a pull request, or remove worktrees unless
  explicitly requested.

Do not merge, push, open a pull request, close the issue, or remove the worktree
during implementation. A later explicit "merge and close" instruction
authorizes only the aggregate publication sequence defined above.
