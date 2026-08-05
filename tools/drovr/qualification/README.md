# Drovr qualification catalog

[`catalog.v1.json`](catalog.v1.json) is the versioned source of truth for
qualifying Drovr for supervised reusable-agent review cycles. It preserves the
known production incidents as standalone scenarios so the later runner does
not need Git history or private runtime state to reconstruct expected behavior.

Validate it deterministically with:

```sh
npm --silent --prefix tools/drovr run qualification:validate
```

The validator also checks the versioned promotion soak plan. Run the bounded
live promotion soak with evidence outside the caller-owned workspace:

```sh
soak_evidence_dir=$(mktemp -d)
npm --silent --prefix tools/drovr run qualification:soak -- \
  --evidence-dir "$soak_evidence_dir"
```

The soak binds the exact source commit, Herdr and native integration versions,
Claude Code and Codex versions, qualification models and effort, configuration
watermark, and catalog digest before running ten Codex cycles, three consecutive
Claude cycles, the bounded Codex lifecycle coverage cycle, and one explicitly
justified extra Claude staged-input cycle. Each cycle is a fresh qualification
process using isolated Drovr state, while the scenario itself proves same-agent
and same-native-session reuse through public commands. The extra Claude cycle
is accepted only with a named reason that Codex and deterministic replay cannot
provide the native editor coverage.
The report records every cycle, live turn/retry/elapsed measurements, cleanup
receipt, verification-suite result, and a final `promote` or `unqualified`
decision. A failed cycle resets that harness's consecutive streak and retains
its evidence.

The soak also runs the deterministic replay suite, the catalog-derived
`--full-live` conformance suite, and the fault matrix at the same source
commit. Exit status `0` means `promote`; status `4` means the durable report
is `unqualified`; status `5` means the soak could not produce a report; status
`130` means an operator interrupted the soak. An interrupted run retains its
partial report when possible and records `verification.interrupted` plus
`unattempted_cycles` so truncation is not mistaken for an ordinary failed
cycle.

Every scenario declares only public `drovr` commands, required preconditions,
typed positive, negative, uncertain, and recovery outcomes, applicable safety
invariants, cleanup obligations, and the evidence needed to distinguish a true
pass from hidden repair. The validator rejects an incomplete scenario,
unrecognized invariant, unknown incident mapping, duplicate scenario ID, or a
catalog that omits either execution class.

## Evidence contract

The black-box runner records one `drovr.qualification-evidence/v1` result per
scenario. It validates every public `drovr.command/v1` envelope and records
exact source, integration, executable, model, and reasoning-effort versions;
declared and measured limits; ordered public invocations; typed observations;
assertions; and one embedded cleanup receipt.

Deterministic scenarios run through the semantic Herdr replay seam. Their
evidence embeds a `drovr.harness-trace/v1` trace from the versioned
[`traces.v1.json`](traces.v1.json) fixture bundle. Live scenarios also journal
Herdr command results, agent observations, pane snapshots, transcript events,
delays, and errors while they run, then validate the sanitized trace before
adding it to evidence. Credentials, bearer values, private keys, machine-local
paths, and non-sentinel text are rejected or redacted before persistence.

Replay consumes the recorded operation order through the same semantic harness
interface used by production, and advances a controllable clock from recorded
delay events. Each fixture carries exact replay, transcript-adapter, and
semantic-feature compatibility facts. It does not sleep or return canned
method results; an altered operation, identity, token, transcript boundary,
delay, or compatibility fact fails the replay.

Run one focused live scenario and retain its evidence outside the caller-owned
workspace:

```sh
qualification_evidence_dir=$(mktemp -d)
npm --silent --prefix tools/drovr run qualification:run -- \
  --scenario codex_live_prompt_sources_and_reuse \
  --evidence-dir "$qualification_evidence_dir"
```

Run the cost-bounded Codex-primary set plus the minimal Claude-specific set
unattended:

```sh
qualification_evidence_dir=$(mktemp -d)
npm --silent --prefix tools/drovr run qualification:run -- \
  --full-live \
  --evidence-dir "$qualification_evidence_dir"
```

`--full-live` is derived from catalog scenarios marked `unattended = true`.
`claude_owned_staged_input_submit` is intentionally excluded because its exact
uncertain-turn staged-input precondition cannot be manufactured on a healthy
system through public commands. Run it by name as a bounded incident-capture
scenario: it attempts delivery and exercises recovery only when that exact
owned receipt emerges; healthy direct completion is not a recovery pass.
`claude_staged_input_transient_clear_reappears` is also explicit-only because
it shares the stable-clear executor and is useful when capturing a suspected
reappearance incident, not as a second unattended Claude run with duplicate
behavior. Its replay fixture covers reappearance inside the qualified
stability interval. The deterministic
`claude_staged_input_delayed_reappearance_after_clear` fixture covers the
other boundary: the clear reaches `cleared`, then an identical unknown
snapshot reappears after the interval. Replay proves that the later snapshot
is observed without submitting it, replacing the agent, or resuming a native
process implicitly. Staged-input tokens bind the visible snapshot digest to
the exact native state transition observed with it, so the pre-clear token is
rejected if identical text reappears under a later transition. Durable owned
receipts keep text ownership separate from this freshness token, so a receipt
remains discoverable after an intervening transition while recovery still
requires a fresh current token. If Herdr omits a safe `state_change_seq`, the
snapshot may be reported for diagnosis but no recovery token or mutation action
is issued. The transition-bound check is defense in depth; its anti-replay
guarantee therefore depends on Herdr advancing this counter for the clear
transition. Until a live clear qualification confirms that behavior, it must
not be treated as the sole reappearance guard.

The promotion soak's staged-input cycle records the transition sequence before
staging, after staging, after the double-Escape clear, after qualified stable
absence, and after a separate public Drovr process observes the same agent
again. That final phase is process re-entry only - the Herdr/native process is
not manually restarted by the qualification. A missing or unchanged clear
transition counter is an unqualified anti-replay gap. The soak does not
manufacture a transient reappearance; the existing transient scenario remains
an explicit incident-capture scenario.

Exit status `0` means every selected scenario passed. Status `3` means
prerequisites blocked execution, a replay executor was explicitly deferred, or
a mixed run was incomplete; status `4` means a scenario assertion failed. Each
non-pass retains evidence. Missing or incompatible prerequisites never become
a pass.

Catalog `max_elapsed` bounds scenario work through the final behavioral
observation. Cleanup then receives a separate 65-second wall-time budget,
recorded under `limits.cleanup`. The soak supervisor forwards interruption and
allows a separate graceful-exit window before force termination so cleanup can
persist its receipt. Exhausting either budget produces typed failure evidence.

The embedded `drovr.qualification-cleanup-receipt/v1` binds every created
resource to its disposition, records prohibited-mutation checks, proves the
caller-owned workspace was preserved, and retains unresolved cleanup duties
instead of manufacturing a clean pass.
Turn resources are reported as `retained` after successful cleanup because
their durable history remains in the isolated registry until the scenario
state root is removed.

The live runner stays on public Drovr commands. For Claude prompt-file
scenarios it proves end-to-end completion, one logical input, prompt-source
preservation, exact identities, and an exact sentinel result. Private
paste-conversion and submit mechanics are covered by the adapter tests and are
not overstated as directly observed live evidence. A prohibited mutation is
reported as `not_observed` whenever every clause cannot be checked through the
public interface.

Catalog `public_commands` list the behavior under qualification. Common
isolation, discovery, observation, and cleanup commands are runner mechanics
and are recorded in the evidence invocation list rather than repeated in every
scenario entry.

Unknown staged-input scenarios explicitly label their native text as a
runner-authored stimulus. The runner stages that exact text through the
guarded public `agent staged-input --stage-unknown-file` command, which targets
the exact registered pane without submitting it and verifies the resulting
unknown snapshot. The clear-and-reuse and transient-reappearance entries remain
separate because they guard distinct incident outcomes: stable absence is a
pass for the former, while any reappearance is retained as a typed contradiction
for the latter. The delayed post-stability replay retains the earlier clear as
`cleared` while proving the later unknown snapshot cannot trigger hidden
repair. Only the stable-clear scenario is included in the unattended set.

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

Every live scenario uses the tracked qualification configuration in
`config/drovr/config.toml`: `gpt-5.6-luna` with `low` effort for Codex and
`haiku` with `low` effort for Claude. Any future deviation must be recorded in
its evidence. Generic live coverage belongs on Codex. Claude is reserved for
Claude-specific behavior and the minimum shared-parity evidence.

## Scope

This qualification issue tree does not block GitHub issues 13 or 21. It also
does not replace the later Claude, Codex, and mixed-Flow validation owned by
issue 44.
