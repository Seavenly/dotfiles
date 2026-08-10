---
name: drovr-review
description: Run an iterative Drovr review with a full-access reviewer, optionally selecting the harness, model, and effort. Use only when invoked as /drovr-review or $drovr-review.
argument-hint: "[--harness claude|codex] [--model <model>] [--effort low|medium|high|xhigh]"
disable-model-invocation: true
---

# Drovr Review

Review completed, verified local changes.

1. Pin the scope: request or spec, repository guidance, base and head, plus
   staged, unstaged, and untracked changes.
2. Resolve the reviewer launch from the optional arguments. Accept only
   `--harness`, `--model`, and `--effort`; reject any other argument or an
   invalid value instead of guessing.

   - `--harness`: `claude` or `codex`. Defaults to `claude`.
   - `--model`: any model the resolved harness supports. Defaults to `opus`
     when the harness is `claude`; for any other harness, omit the flag so
     Drovr resolves that harness default.
   - `--effort`: `low`, `medium`, `high`, or `xhigh`. Defaults to `medium`
     when the harness is `claude`; for any other harness, omit the flag.

3. From the candidate cwd, create one reviewer with a fresh task key, passing
   only the flags that resolved to a value:

```sh
drovr delegate --task-key <key> --agent-key reviewer --cwd <cwd> \
  --role reviewer --harness <harness> [--model <model>] [--effort <effort>] \
  --capability unrestricted "<scope and review request>"
```

The reviewer runs with full access, so ask it to run whatever repository
checks its findings need for evidence, and to leave the working tree, index,
and branches unchanged; every edit remains yours. Ask for actionable
correctness, regression, security, test, and spec findings, each with evidence
and a location. Record the returned agent ID. Resume incomplete turns; never
replace the reviewer.

4. Classify every finding: accept, reject, or clarify. Apply clear accepted
   changes, reject with reasons, and verify affected behavior.
5. Before editing, use `drovr ask` with a proposed fix only when ambiguity,
   risk, spec conflict, or competing designs make likely rework costlier than
   another turn.
6. If changes materially alter behavior, interfaces, control flow, or tests,
   run `drovr ask <agent-id> "<fixes, pushback, verification; re-review>"`.
   Reuse the agent. All clarification and review responses share a three-response
   cap. Stop early when another review adds little value. Report sizable changes
   made after the third response as unreviewed.
7. Report rounds, dispositions, verification, unresolved blockers, and whether
   another review cycle would add meaningful value. Do not start one without
   the user's request.
