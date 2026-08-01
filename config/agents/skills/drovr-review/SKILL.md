---
name: drovr-review
description: Run an iterative Drovr review with Claude Code Opus at medium effort. Use only when invoked as /drovr-review or $drovr-review.
disable-model-invocation: true
---

# Drovr Review

Review completed, verified local changes.

1. Pin the scope: request or spec, repository guidance, base and head, plus
   staged, unstaged, and untracked changes.
2. From the candidate cwd, create one read-only reviewer with a fresh task key:

```sh
drovr delegate --task-key <key> --agent-key reviewer --cwd <cwd> \
  --role reviewer --harness claude --model opus --effort medium \
  --capability read-only "<scope and review request>"
```

Ask for actionable correctness, regression, security, test, and spec findings,
each with evidence and a location. Record the returned agent ID.
Resume incomplete turns; never replace the reviewer.

3. Classify every finding: accept, reject, or clarify. Apply clear accepted
   changes, reject with reasons, and verify affected behavior.
4. Before editing, use `drovr ask` with a proposed fix only when ambiguity,
   risk, spec conflict, or competing designs make likely rework costlier than
   another turn.
5. If changes materially alter behavior, interfaces, control flow, or tests,
   run `drovr ask <agent-id> "<fixes, pushback, verification; re-review>"`.
   Reuse the agent. All clarification and review responses share a three-response
   cap. Stop early when another review adds little value. Report sizable changes
   made after the third response as unreviewed.
6. Report rounds, dispositions, verification, unresolved blockers, and whether
   another review cycle would add meaningful value. Do not start one without
   the user's request.
