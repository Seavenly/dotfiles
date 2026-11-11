# Bounded Flow observation

`query` and `watch` remain projections, never scheduling or lifecycle authority.
Every durable query still verifies the complete event stream and stored fold,
including digests, generation, ordering and omissions. This slice adds no replay
cache, database replacement or observer-owned mutation lock.

A durable watcher polls after 100 ms initially and after a changed observation.
An unchanged read backs off to 1000 ms; a changed watermark resets the shorter
interval. Polling runs only while a consumer awaits an observation. These are
timer delays, not guaranteed delivery deadlines: replay and scheduling add time.
The guided `run`/`review` query loop continues to use its existing one-second
interval, while `runs` and `usage` retain their bounded read-only inspections.

## Slow consumers and failures

The in-process watcher and socket client each retain at most 64 queued
observations or 8 MiB of serialized queued data, whichever comes first. Existing
per-frame transport limits still apply. Observations remain FIFO; they are not
silently coalesced or replaced with a newer snapshot.

On overflow, only that observer detaches. Its already queued snapshots remain
available, then the next read rejects with `watch_backpressure_exceeded`.
Other terminal transport failures likewise remain visible after queued data
drains, including failures received when no read was pending. Explicit iterator
`return()` discards queued data and failure, releases the timer/socket/subscription
and makes subsequent reads done. A late connection cannot subscribe after return.
Poll-read exceptions fail the observer with `watch_read_failed` rather than
escaping a timer callback. None of these events cancels Flow work.

The CLI watch loop waits for stdout drain before requesting another observation.
While blocked on drain, a closed or failed output stream returns the watcher and fails the command;
it does not cancel the run. Watch error codes remain redacted in the public
envelope. Treat overflow or observation failure as incomplete inspection: query
fresh state through the same exact original client/authority before reattaching.
Buffered legal actions may be stale; use only the fresh projection's choices.

Existing clients and owners keep their original runtime pins and behavior.
Updating the named launcher does not silently upgrade those authorities. Follow
the explicit [`init --upgrade-runtime yes` procedure](guided-setup.md), including
its stopped/settled requirement, when choosing to upgrade an existing project.

## Linux measurement and reproduction

The Linux diagnostic uses only new synthetic authorities and checkpoint cards.
It invokes no agent, model, version probe, retained authority or project test.
Use an already installed Node 22.23.1 and a clean source checkout with its
existing dependencies:

```sh
RESULTS=/absolute/new/private/observation-results
/usr/bin/python3 -I -S tools/flow/benchmarks/observe-linux.py \
  --node /absolute/path/to/node-22.23.1 --output "$RESULTS"
```

`--source /absolute/clean/checkout` selects an exact comparison checkout;
`--socket-only` runs just the finite slow-consumer canaries. The output directory
must be new. The wrapper scrubs credentials and Node/Git/Flow overrides, records
the exact source commit and host, bounds the workload to 120 seconds and 128 MiB,
and requires the 2 GiB free-disk reserve on both source and output filesystems,
before starting and while running. Raw logs, progress, reports, receipts and
owned synthetic authorities remain in that directory for inspection. Remove only
that owned directory when its evidence is no longer needed. The short owned
temporary socket directory is removed after the finite canary completes.

The predeclared workload has 1, 16 and 64 cards with 1 KiB prompt padding plus a
fixture label per card, completing all but two through exact public-core legal actions. This
produces **1, 15 and 63 target run events and zero delegated attempts**. Each size
uses separate one- and four-observer fixtures, ten warm query samples and a
five-second settled idle interval. CPU percentages refer to one CPU core.
Logical `rchar`/read syscall counts and physical `read_bytes` are separate; warm
SQLite reads may have zero physical disk I/O. RSS and peak RSS are observations,
not claims of uniformly lower memory use.

On Linux x86_64, QEMU Virtual CPU 2.5+, kernel 7.0.0-29-generic, four available
CPUs and Node 22.23.1, the bounded comparison was:

| Cards / target events | Observers | Idle CPU before | Idle CPU after | Warm query p95 before / after |
| --- | ---: | ---: | ---: | ---: |
| 1 / 1 | 1 | 20.36% | 0.29% | 3.36 / 3.59 ms |
| 1 / 1 | 4 | 62.39% | 0.96% | 2.49 / 2.60 ms |
| 16 / 15 | 1 | 34.19% | 0.50% | 4.78 / 5.00 ms |
| 16 / 15 | 4 | 90.46% | 1.66% | 4.88 / 4.61 ms |
| 64 / 63 | 1 | 54.90% | 1.19% | 16.02 / 12.60 ms |
| 64 / 63 | 4 | 99.12% | 4.92% | 13.78 / 13.82 ms |

The declared goals were at most 2% idle CPU for one observer, 5% for four,
250 ms warm-query p95, 500 ms control acceptance and approximately one second
update detection. All six idle observations met their goals in this sample;
the four-observer 4.92% result is not a host-wide guarantee. Ten-sample warm
percentiles are descriptive, not robust tail estimates or normal-CI assertions.

The two largest-fixture update observations were 99 and 137 ms after the change.
They are two samples, not a detection p95. Same-process synchronous admission
and cancellation acceptance maxima were 24.1 and 62.0 ms. Those measurements
exclude host IPC, event-loop queue delay and later completion. The independent
public transport correctness test verifies four observers, fresh actions,
disconnect isolation and equality with a fresh full query, without asserting
these performance targets.

A corrected separate 512-frame socket baseline retained all 512 without a
bound; the in-process baseline retained 513 including its initial snapshot.
Both successor canaries retain 64 then explicitly fail. The first CPU matrix's
socket canary omitted a required frame field, so that socket metric is excluded;
the corrected socket-only run leaves the CPU workload and targets unchanged.
The earlier missing-cancel-authority fixture failure is also retained separately.

This is progress under #86, not completion of its cross-host scaling criteria.
Thousands-event histories, long delegated/retry payloads, more observers,
Mac measurements, prolonged owner responsiveness and broader memory/I/O scaling
remain unmeasured. No strict qualification, native execution or default cutover
claim follows from this diagnostic.
