# Mac verification handoff

This revision contains the accepted Linux implementation and an **unadmitted Mac
ownership diagnostic**. Start here on each of the personal and work MacBooks.
Running the diagnostic does not enable native Flow execution on macOS. The Mac
backend and its real host acceptance remain unfinished.

## Get one isolated checkout

From an existing clone, fetch the handoff branch and create a new worktree:

```sh
git fetch origin feature/flow-runtime
git worktree add --detach ../dotfiles-flow-mac-verification FETCH_HEAD
cd ../dotfiles-flow-mac-verification
git rev-parse HEAD 'HEAD^{tree}'
git status --porcelain
```

`feature/flow-runtime` is the primary publication branch. The separately
published `draft/flow-mac-verification-handoff-20261107` retains the original
handoff snapshot for historical reference.

Choose a different new destination if that directory already exists. Preserve
the existing checkout, user edits, default `flow`, application authentication,
and authority state. Record the fetched commit and tree in every returned host
report. No Linux-only receipt directory or installed Linux launcher is needed.
Do not copy the Linux `flow-supervised` wrapper: its paths and executable pin are
host-specific.

The accepted Linux base is commit
`83951e710070ade9a5ca6e12d130c420cc47d5d1`, tree
`410cccd99c7184bd2519f161cd5599687386d2a3`. The Mac diagnostic was reviewed as
`4d10d63c55fb90172415f2b68f44bcb1d7753748` plus prerequisite-entry correction
`9cf8d4c71473e7382be85c246f3c70768fce62b0`; their cherry-picked equivalents are
in this branch. The handoff changes no production execution implementation.
Derived release bindings describe the new source and preserve qualification
`not_run`; they do not qualify the added diagnostic or a Mac backend.

## What Linux established

The final Linux base passed `env CI=1 ./dotfiles check`: all 23 categories, exit
0, 456.290 seconds, with 955 tracked source identities unchanged. Independent
source and evidence reviews cleared the scoped changes. Actual official CLI
trials used Codex 0.166.0 and Claude Code 2.1.318, with nine fresh native tasks
positively retired and all trial owners stopped.

| Actual trial | Executed source | Observed result |
| --- | --- | --- |
| Local feature test | [a717834][linux-scenarios] | Registered health/expected RED, writer, GREEN, Flow-owned commit, independent critique, verification and seal |
| Default feature verify | [a717834][linux-scenarios] | Git-backed content observations, independent critique and sealed candidate; project behavioral checks **not run** |
| Separate local mixed review | [a717834][linux-scenarios] | Claude lens plus fresh Codex critic, complete review coverage, persisted distinct review attempt; no human approval |
| Active owner crash and cancellation | [a717834][linux-scenarios] | Same native task adopted after owner restart, cancelled and fully retired; recorded Git baseline and external canary unchanged |
| Explicit cancellation settlement and next feature | [83951e7][linux-base] | One durable claim release and settlement, idempotent replay, then a complete next feature in the **same repository and authority** |

The mixed review used the retained earlier TESTv2 candidate
`sha256:47e87233ca98252a218b86695ba248458774cc9b0f9ab2add83f99ecee232240`
(commit `2266e669`, produced on [a6aa4db][producer-source]). It did not review the later final
TEST2 candidate `9b05095d7a60dd9b44b3c9bb9658b40c71fe3ee7`.

The first four paid scenarios were not rerun on `83951e7`. Compatibility was
checked explicitly: its production delta adds the reviewed cancellation
settlement/event-fold path; execution descriptions, adapters, feature/review
definitions, registered checks and commit mechanisms are unchanged. Five other
corrections affect test fixtures. The final full repository check and real
settlement/reuse ran on `83951e7` itself.

Earlier failures remain part of the history: the `a717834` full check failed
Flow and Flow transition after 875.848 seconds; the final `83951e7` check was a
fresh passing run. Real trials also exposed restart binding, native schema and
metadata, Git identity, review-attempt collision and cancelled-claim defects.
Their corrections and regressions are in this branch's ancestry; failed trials
were not renamed as successes. No private model logs or account data are copied
into this handoff.

This is cooperative, explicitly selected **supervised native execution** under
[ADR-0012](../adr/0012-offer-explicit-supervised-native-execution.md). Requested
CLI permissions and ambient startup are trusted; independent workspace,
startup, tool-network and escalation enforcement are not established. Strict
qualification remains `not_run`. The legacy default, remote-mutation authority
and broader release gates were not changed. See the
[operator guide](operator-guide.md) for the actual local preparation contract.
Linux success supplies no Darwin process-retirement proof.

## Run the diagnostic on each Mac

Use the ordinary logged-in GUI user, without sudo. Respect work-device managed
policy. Required tools must already exist:

- macOS with an available per-user `gui/<uid>` launchd domain;
- selected Command Line Tools or Xcode, an installed native compiler and macOS
  SDK;
- an explicitly selected, installed **non-Apple Python 3.9 or newer**, resolving
  to a native executable. A Homebrew or other existing private installation may
  work; do not invoke a package manager or install missing tools for this step.

Use the shell entry below. It checks installed prerequisites before running
Python, never calls Apple Python/compiler installation stubs or `xcrun`, and
refuses unsupported hosts. Do not bypass it by running `probe.py` directly.
If prerequisites or managed permissions block execution, retain the failure and
report the missing prerequisite; do not change host policy or install software.

Set `HOST_KIND` separately to `personal-macbook` or `work-macbook`. Substitute
your actual installed Python path; `/opt/homebrew/bin/python3` is an example,
not a request to install it.

```sh
HOST_KIND=personal-macbook
PYTHON=/opt/homebrew/bin/python3
BUNDLE="$(mktemp -d "${TMPDIR:-/tmp}/flow-mac-evidence.XXXXXX")"
{
  printf 'host_kind=%s\npython=%s\n' "$HOST_KIND" "$PYTHON"
  /usr/bin/sw_vers
  /usr/bin/uname -m
  git rev-parse HEAD 'HEAD^{tree}'
  git status --porcelain
} > "$BUNDLE/host.txt"
if FLOW_MAC_PROBE_PYTHON="$PYTHON" /bin/sh \
  tools/flow/diagnostics/macos/launchd-ownership-canary/run.sh \
  --output "$BUNDLE/probe" > "$BUNDLE/stdout.json" 2> "$BUNDLE/stderr.log"; then
  STATUS=0
else
  STATUS=$?
fi
printf 'exit=%s\nevidence=%s\n' "$STATUS" "$BUNDLE" | tee "$BUNDLE/result.txt"
```

The output path must be new; the probe creates it privately. Expect roughly
22 seconds after compilation, with bounded tool calls. It compiles only the
adjacent owned C helper. Two unique per-user launchd jobs create ordinary fork
and double-fork/setsid descendants; each helper has a self-exit deadline of at
most 20 seconds. Only the two recorded unique job targets receive `bootout`.
There are no PID/process-group signals, network/provider calls, authentication
reads, LaunchAgents installation, privileged helpers or coalition mutation.

Return the **complete** bundle, including `host.txt`, exit/stdout/stderr,
`probe/report.json` when created, helper binary, plists, command logs and per-PID
records. Inspect it before sharing: it includes host versions, user-bearing
paths and process identities. If shell preflight fails, no probe report may
exist; the captured stderr and exit are still a valid blocked observation.
See the [diagnostic README](../../tools/flow/diagnostics/macos/launchd-ownership-canary/README.md)
for implementation details and primary Apple interface references.

## Interpret evidence without granting execution

Record role counts per job, available coalition IDs within and across jobs,
controller membership, API return sizes/errors, usage counters, command exits,
and post-deadline observations. Missing private symbols, denied access,
incomplete records or unavailable GUI domains leave the hypothesis unresolved.
Shared resource coalition IDs across the two jobs would contradict the proposed
job isolation. Preserve negative results rather than modifying the host until
it appears to pass.

Exit 0 means the observation routine completed, not that containment passed.
Even `observations_only_host_interpretation_required` is diagnostic evidence.
`admitted` and `retirement_proven` remain false, `proof` remains null, and final
qualification is `not_granted`. Equal counters, a vanished PID or a removed job
do not prove that an ownership boundary is sealed against future descendants.
Review every cleanup command result; the second `bootout` may report that an
already removed job is absent. Do not infer cleanup from an unsuccessful command
or signal unrelated processes. Preserve interrupted bundles and wait for owned
helper deadlines before assessing the recorded unique job targets.

## Next implementation and host acceptance

Use these observations to decide whether launchd ownership can support a real
Darwin task supervisor. A useful next implementation must bind the exact native
CLI, worker, descriptor, input/schema, workspace and caller identity; survive
client/owner loss; adopt exactly once; cancel without broad PID/group signals;
and positively establish full owned-tree retirement or retain uncertainty.
Start from the existing [task port](../../tools/flow/src/direct-task-port.mjs),
[Linux worker](../../tools/flow/src/direct-task-worker.py), and
[registered test runner](../../config/flow/src/production-feature-test-check.mjs).
Implement the corresponding bounded Mac verification runner as well. Existing
Linux subreaper/pidfd code and Linux-only verification fences must not be renamed
as Darwin proof. Portable owner, authority, workspace and recovery seams should
be reused. A negative canary may require a different mechanism.

After implementation and review, prepare concrete disposable-repository trials
through the public CLI, with exact installed official executable identities and
an operator-accepted immutable preparation. Keep paid/provider work within the
operator's authorized task and budget; the diagnostic itself authorizes none.
Keep strict enforcement qualification separate from any explicitly selected Mac
supervised contract. Observe work-device policy before using credentials or
native agents. Do not silently enable a backend, change global permissions,
replace the default launcher or treat diagnostic output as admission.

Retain separate evidence for **both** hosts; success on one cannot fill the
other's record:

| Acceptance evidence | Personal MacBook | Work MacBook |
| --- | --- | --- |
| Exact source, OS/architecture, installed tools and managed-policy observations | NOT_RUN | NOT_RUN |
| Ownership diagnostic bundle and interpretation | NOT_RUN | NOT_RUN |
| Implemented native task and bounded verification mechanisms | NOT_RUN | NOT_RUN |
| Real feature test and content-verify paths; exact candidate and independent review with both applicable official harnesses | NOT_RUN | NOT_RUN |
| Owner/client loss, same-task adoption, cancellation, retirement, explicit claim settlement and same-repository reuse | NOT_RUN | NOT_RUN |
| Public status/confirmation/result rendering and truthful verification scope | NOT_RUN | NOT_RUN |

Actual host reboot and the expanded visual matrix remain their own later
acceptance work; do not reboot a host as part of this diagnostic.

## Issue ownership

- [#2](https://github.com/Seavenly/dotfiles/issues/2) retains the overall usable
  personal MacBook, work MacBook and Linux outcome.
- [#92](https://github.com/Seavenly/dotfiles/issues/92) owns unfinished Mac native
  task supervision; [#89](https://github.com/Seavenly/dotfiles/issues/89) owns the
  production test route and its strict qualification. Supervised Linux results
  do not discharge either ticket's broader acceptance.
- [#84](https://github.com/Seavenly/dotfiles/issues/84) owns real feature and
  independent-review proof; [#50](https://github.com/Seavenly/dotfiles/issues/50)
  owns the first usable supervised feature/review opt-in across required hosts.
- [#47](https://github.com/Seavenly/dotfiles/issues/47) retains actual reboot
  admission and expanded macOS visual acceptance, beyond this canary.
- [#90](https://github.com/Seavenly/dotfiles/issues/90) supplies the implemented
  authority-derived local-review facts bridge. Reuse that seam rather than
  reconstructing caller-trusted candidate facts.

Update each owning issue with exact host/source evidence and remaining failures.
Do not close a broader ticket because this diagnostic runs or because Linux
passed. Publication of this handoff branch is neither a canonical merge nor
Mac release qualification.

[linux-base]: https://github.com/Seavenly/dotfiles/commit/83951e710070ade9a5ca6e12d130c420cc47d5d1
[linux-scenarios]: https://github.com/Seavenly/dotfiles/commit/a7178343b1cfce5eb3b4c6faf8feef6943978e73
[producer-source]: https://github.com/Seavenly/dotfiles/commit/a6aa4db01a2bfdf7ff4375cadbb455670fa5c5c7
