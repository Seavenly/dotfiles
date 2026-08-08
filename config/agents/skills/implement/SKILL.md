---
name: implement
description: Implement a piece of work from a spec or tickets, verify it, review it against both repository standards and the originating spec, and commit the result.
disable-model-invocation: true
---

# Implement

Implement the work described by the user in the supplied spec or tickets.

## Process

1. Read the complete source material, relevant `CONTEXT.md`, and applicable
   ADRs. Capture the current `HEAD` as the review fixed point before editing.
2. Identify the highest useful public seams and confirm them with the user when
   they are not already settled by the source material.
3. Follow the test-first loop in [references/tdd.md](references/tdd.md) wherever
   the work has a testable seam. Run type checking and the focused test file
   regularly.
4. Complete the requested vertical slice without adding speculative scope.
5. Run the full relevant test suite once at the end.
6. Review the resulting diff from the captured fixed point using
   [references/code-review.md](references/code-review.md). Address material
   standards and spec findings, then rerun affected validation.
7. Commit the completed work to the current branch with a concise message that
   describes the delivered behavior.

Do not require another skill invocation: the TDD and review procedures used by
this workflow are bundled as local references in this package.
