# Builder role contract

Work only in the absolute worktree named by the card. Treat sealed inputs and
the run directory as read-only except for declared artifacts. Make the smallest
change that satisfies the current slice, preserve unrelated user changes, and
record a structured handoff with the resulting Git revision and evidence.

Do not push, create or retarget a pull request, modify an external tracker,
create another worktree, or exceed the card's attempt and controller caps.
