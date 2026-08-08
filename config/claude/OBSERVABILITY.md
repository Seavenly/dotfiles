# Observability doctrine — agent-teams

Single source of truth for how the agent-teams flows treat observability.
Both the **builder** (feature-flow: planner, implementer, feature critic) and
the **reviewer** (review-flow: the `observability` lens + critic) work from
this. The goal is the same in both directions: when this code misbehaves in
production, can an on-call engineer figure out *what happened and why* from
the telemetry alone — without attaching a debugger or adding a log and
waiting for it to recur?

## The two principles

1. **Add observability where it earns its place — don't force it.** Not
   every function needs a span or a log line. The bar is: *would this signal
   change what a debugger does at 3am?* Decision points, external calls,
   error/edge branches, and anything non-obvious about why a request went the
   way it did clear that bar. A pure getter, a trivial mapper, or a one-line
   pass-through does not. Noise is a cost: it dilutes the signal, inflates
   cardinality, and trains people to ignore the logs.

2. **One wide root span per request, not a confetti of tiny spans.** The
   preferred shape is a single span covering the unit of work (the request,
   the job, the message handler) carrying *many attributes*, rather than
   dozens of nested micro-spans each carrying one. Wide-and-flat beats
   deep-and-thin: it's cheaper, it's queryable, and the whole story of a
   request lives in one place you can filter and group by.

## Where signal goes

**Attributes useful for debugging or for isolating a class of requests belong
on the root span.** If you would ever want to *find* the slow/failing
requests by some dimension, or *explain* an individual one after the fact,
that dimension is a root-span attribute. Examples: the tenant / account / user
id, the resource id being operated on, the route or operation name, the result
status, key request parameters, feature-flag / variant in effect, retry count,
upstream-dependency outcome, the reason a request took a branch it doesn't
usually take.

- **Root span** — the request's identifying and explaining dimensions
  (above). High-value, bounded-cardinality, queryable. This is the default
  home for new attributes.
- **Child span** — add one only when a sub-operation has its *own* latency or
  failure worth measuring independently (a specific downstream call, an
  expensive computation you'll want to time in isolation). A child span is a
  deliberate measurement, not a tracing reflex.
- **Logs** — for the discrete, point-in-time narrative a span attribute can't
  carry: an edge case was hit, a fallback fired, a retry was exhausted, an
  invariant was violated. Log at the boundary where the decision is made, with
  enough structured context (ids, the value that triggered it) to act on it.
  Prefer structured key/values over interpolated prose. Match the level to the
  consequence: `error` for "someone needs to look," `warn` for "unexpected but
  handled," `info` for the happy-path milestones worth keeping, `debug` for
  the rest.

## Edge cases are the point

The highest-value observability is on the paths that are **hard to reproduce
and tricky to debug** — exactly the ones a happy-path test never exercises.
When a branch handles a rare input, a degraded dependency, a race, a partial
failure, a fallback, or a "this should never happen" guard: leave a trail.
A single well-placed log line or root-span attribute on that branch ("served
stale cache because upstream returned 503", "skipped row N: malformed
payload") is worth more than ten on the happy path. If a maintainer would have
to add a log and wait for the bug to recur, the log should already be there.

## Anti-patterns (these are findings, not improvements)

- A forest of one-attribute child spans where attributes on the root span
  would answer the same questions more cheaply.
- Debug-relevant dimensions buried on a leaf span (or in a log line) where you
  can't filter the request population by them.
- Logging secrets, tokens, full request bodies, PII, or anything that turns a
  log store into a data-leak — redact or omit.
- Unbounded-cardinality attributes used where a metric/bounded tag was meant
  (raw timestamps, full URLs with ids, free-text) — they blow up indexing.
- Log spam on the hot path: per-iteration `info` logs, logging the same thing
  at every layer, narrating the obvious. Noise buries signal.
- A silent `catch` / swallowed error / empty fallback branch with no log and
  no attribute — the single most common "why is this impossible to debug"
  cause.
- Logging an error *and* rethrowing it so it's recorded twice (double-counts
  alerts); record it once, at the layer that decides what to do about it.

## Quick checklist

- Is there a span for this unit of work, and is it **wide** (the request's
  dimensions live on it) rather than fragmented into micro-spans?
- Could on-call **filter to the failing/slow population** by the dimensions
  that matter (tenant, resource, route, status)? Are those on the root span?
- Does every non-happy-path branch (error, fallback, retry-exhausted, guard)
  leave a trail?
- Any swallowed error or silent catch with no signal?
- Any secret / PII / unbounded-cardinality value being logged or tagged?
- Is the volume proportionate — no per-iteration or every-layer log spam?
