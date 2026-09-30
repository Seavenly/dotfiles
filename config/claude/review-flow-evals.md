# review-flow manual regression set

A small set of frozen PR revisions for checking `/review-flow` after a change
to its prompts, personas, models or scripts. There is no automated harness:
run the cases by hand, adjudicate the output, and record the result below.

The cases point at private repositories, so the case list lives outside this
repository, in `~/.local/share/dotfiles-private/review-flow-evals.md`. This
file keeps the method and the recording format.

These are known regressions. Passing them shows the flow still catches what
it was already tuned to catch; it does not measure
performance on unseen bugs. When a real review misses a bug or posts a false
positive, add it here, with its verified repair as a paired case.

## Running a case

```bash
node ~/.claude/scripts/review-flow-prep.js <pr> --repo <owner/name> \
  --at-base <comparison base> --at-head <head>
```

Or pass the same flags to `/review-flow`. A replay run:

- diffs `git diff <base> <head>` from the clone. The listed bases are already
  the intended comparison (the head's parent for the stacked cases, the merge
  base for the other), so a direct diff is exact;
- withholds the PR's prior review threads, which would hand reviewers the
  answer. The PR description is fetched live and may have been edited since;
- reads repo rules from the frozen base and CI annotations for the frozen head;
- is marked `replay: true` in the brief and snapshot. `review-flow-post.js`
  refuses it (exit 7), so the rendered draft is a proposal to inspect, never
  something that can be posted.

Don't give the reviewer the expected outcome, and delete the run directory
when the result is recorded.

## Cases

Each case is a PR with a comparison base, a head and an expected outcome,
plus optional repaired pairs (the same base at a fixed head, where the
root cause should no longer be reported) and negative controls
(historically approved revisions, for checking noise; adjudicate every
finding). Each expected defect warrants critical or important. A different
tier needs an explicit impact argument; the right root cause matters more
than the label.

## Recording a result

One entry per run, newest first:

```
### <date> <case> - <dotfiles commit>
- models: reviewers <model>, critic <model>, verifier <model>, codex <model or off>
- expected problem: found (finding id, tier) | partial (what was missing) | missed
- false positives: <ids and why, or none>
- placement and coverage: anchors right? Coverage section honest about what was traced?
- notes: duplicates, unsupported claims, run time
```

## Results

None recorded yet.
