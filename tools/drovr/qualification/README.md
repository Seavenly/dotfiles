# Drovr qualification catalog

[`catalog.v1.json`](catalog.v1.json) is the versioned source of truth for
qualifying Drovr for supervised reusable-agent review cycles. It preserves the
known production incidents as standalone scenarios so the later runner does
not need Git history or private runtime state to reconstruct expected behavior.

Validate it deterministically with:

```sh
npm --silent --prefix tools/drovr run qualification:validate
```

Every scenario declares only public `drovr` commands, required preconditions,
typed positive, negative, uncertain, and recovery outcomes, applicable safety
invariants, cleanup obligations, and the evidence needed to distinguish a true
pass from hidden repair. The validator rejects an incomplete scenario,
unrecognized invariant, unknown incident mapping, duplicate scenario ID, or a
catalog that omits either execution class.

## Evidence contract

A future runner records one `drovr.qualification-evidence/v1` result per
scenario. The catalog defines its required fields before runner implementation,
including exact version bindings, model and reasoning effort, declared and
measured limits, ordered public invocations, typed observations, assertions,
and one embedded cleanup receipt. Deterministic replay records why live use was
not needed. A live run records why replay could not prove the behavior.

The embedded `drovr.qualification-cleanup-receipt/v1` binds every created
resource to its disposition, records prohibited-mutation checks, proves the
caller-owned workspace was preserved, and retains unresolved cleanup duties
instead of manufacturing a clean pass.

The runner may read native transcripts and Herdr observations as evidence, but
it must exercise behavior only through public Drovr commands. It must never
edit private registry records, native transcripts, caller files, or unrelated
Herdr resources to manufacture success.

## Execution classes

- `deterministic_trace_replay` covers behavior fully proven by captured,
  production-shaped observations and transcript records.
- `real_herdr_harness` is reserved for native editor conversion, prompt-box
  stability, exact session behavior, or another mechanism that replay cannot
  establish. Each such scenario names its harness and hard turn, retry, and
  elapsed-time limits.

Every live scenario uses the smallest configured supported model and lowest
supported reasoning effort that can exercise the mechanism; any deviation is
recorded in its evidence. Generic live coverage belongs on Codex. Claude is
reserved for Claude-specific behavior and the minimum later shared-parity
evidence.

## Scope

This qualification issue tree does not block GitHub issues 13 or 21. It also
does not replace the later Claude, Codex, and mixed-Flow validation owned by
issue 44.
