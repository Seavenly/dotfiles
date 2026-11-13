# Guided supplied-source research

Research answers one bounded question over local text you explicitly supply.
The default quick mode uses one researcher and a separately routed synthesizer.
Deep mode compares two confirmed angles through bounded cycles and fresh gap
criticism. Neither mode searches the web or implements a change. On the supported
Linux backend, begin in an existing clean Git project:

```sh
flow-supervised init --purpose research
```

Review the setup preview and confirm it. No feature brief, project type or
registered checker is needed. Setup installs nothing and starts no owner,
project test or model task; confirmation retains the bounded official CLI
version check. Existing projects keep their original authority, profile, exact
executable/Git pins and selected checker. See the
[existing-runtime procedure](operator-guide.md#supervised-local-repositories)
when an explicit stopped, settled upgrade is required. Select the returned
immutable `--client DIRECTORY` when several clients exist.

## Supply a question and source files

No JSON, source IDs or hashes need to be written by hand:

```sh
flow-supervised research \
  --question 'Which guarantees do these observations support, and what remains unknown?' \
  --source ../notes/observations.txt \
  --source ../notes/constraints.txt
```

The question is at most 4 KiB of UTF-8. Supply one through four regular,
canonical UTF-8 files, each at most 32 KiB and together at most 128 KiB. Aliases,
malformed UTF-8, duplicate source contents and unsafe text are refused. The
existing safety scanner rejects credentials, unsafe paths and other prohibited
content without echoing rejected bytes; it does not silently remove content.
Non-content-addressed reference URLs within supplied text may also be refused.
Keep optional reference URLs in separate provenance notes, outside the supplied
source files.

Flow snapshots the exact bytes and derives content-addressed source IDs,
SHA-256 identities and a packet digest. Local file paths appear in the preview
as provenance; citations use source identities rather than granting local-path
or URI authority. Nothing is fetched. A digest proves which bytes were supplied,
not whether their claims are true or independently authenticated.

Preview may start or reuse the selected original owner and recover previously
authorized work. It does not launch the new research before confirmation. Read
the question, source paths and hashes, both actual role/executable/model routes,
requested permissions, exact retained confirmation and overall budget. The
researcher receives supplied source contents; the separately routed synthesizer
receives the accepted researcher evidence and source identities. Flow creates
the predecessor evidence digest; the model copies that identity rather than
inventing a hash.

Answer `yes` to launch this exact preview, or decline. Both roles request
read-only execution under operator-supervised official CLI permissions and
ambient startup. Flow does not independently enforce filesystem or network
isolation under this contract. This is not Mac native or strict qualification.

## Investigate two angles with deep research

Select deep mode explicitly; omitting the mode preserves quick research:

```sh
flow-supervised research --mode deep \
  --question 'Can change hints reduce polling without weakening verified replay?' \
  --source ../notes/observations.txt --source ../notes/constraints.txt \
  --angle 'Connection-local notification guarantees and omissions' \
  --angle 'Durable verification across process boundaries' \
  --parallel 2 --max-cycles 2 --timeout-seconds 1200
```

Supply exactly two distinct safe angle texts, each at most 1 KiB of UTF-8. The
source bounds and safety checks above apply unchanged. Flow assigns stable angle
identities; no JSON, IDs or hashes need to be written by hand.

Deep mode defaults to concurrency two and two total cycles. Two cycles means the
initial investigation and at most one revision cycle. Each cycle ends with a
fresh critic. At most six native tasks may run, with one attempt per card and no
automatic operational retries. `--parallel 1` uses the same two angles serially;
`--max-cycles 1` permits only the initial investigation and critic.

Inspect every declared native route, including future routes that may remain
unused. The initial graph also contains a registered cycle decision and
checkpoint; graph cards are distinct from native attempts. A revision reserves
the entire affected angle subset, fresh critic and decision/checkpoint before
any member starts. Repeated requests for the same angle coalesce. Unchanged
accepted angle evidence and all earlier dispositions remain retained; each fresh
critic receives the complete current set. A missing or uncertain worker is never
treated as settled evidence.

The preview shows the original owner's runner capacity. Parallel deep research
requires capacity two. A live capacity-one owner is refused, not resized. Keep
its exact client and follow the stopped, settled runtime/startup procedure
before selecting a compatible owner. Existing quick clients and executable pins
are preserved; installing a newer frontend does not upgrade them silently.

The default shared elapsed limit is 600 seconds; choose
`--timeout-seconds 1..3600` during preview. The limit spans every cycle, critic
and scope decision. Attachment, revision and scope approval never reset it. A
semantic cycle cap can produce a complete lower-assurance report with findings
and residual gaps. Operational, authority, safety or retirement failure remains
blocked or incomplete, even if a diagnostic critic reports on the failure.

### Decide an exact same-run scope proposal

A critic may propose a safe replacement question as data. It cannot authorize
widening. The current authority checkpoint shows the old and proposed question,
unchanged source packet and two angles, remaining original elapsed/cycle budget,
and whole next-cycle cost. Approve or decline only the fresh displayed action.
For scripts, inspect the reported legal actions and use the printed
`--attach RUN_ID --action sha256:DIGEST` command for that exact decision.

Approval retains the original packet and appends the approved question identity
in the same run. Both angles must be investigated under the new question, with
a fresh critic, using the remaining revision cycle. Within the original authority
budget, decline retains the original scope and its honest report. Unsafe, stale
or unaffordable proposals cannot start
a partial cycle. Changing source bytes or angle texts requires a separately
prepared run; it is not a scope-checkpoint shortcut.

Unknown, uncertain or exhausted authority time blocks scope completion by either
approval or decline. A validated original report remains diagnostic evidence;
inspect the current cancellation or recovery actions.

## Confirm, detach and recover the same attempt

For scripts, append `--json` to the question/source command. It returns a
`flow.project-research-preview/v1` record and exact `confirmation_digest`.
Confirm the retained preview using its printed client and digest:

```sh
flow-supervised research --client /private/original/client \
  --confirm sha256:THE_PRINTED_DIGEST --json
```

Use `--repository PATH` when outside that project. Source files must retain their
exact previewed bytes before each send, including recovery of a saved accepted
intent. Changed inputs require a fresh preview; `--refresh` replaces only a
proven unlaunched preview and retains its history. Do not retry under a different
authority or manually edit retained files.

The default overall run limit is 600 seconds. `--timeout-seconds 1..3600` selects
that limit during preview; there is one attempt per role and zero revisions.
These are the quick-mode role bounds; deep mode uses the whole-cycle bounds
above. There is no independent per-role timer guarantee. `--follow-seconds` bounds
observation only. `--no-follow` or Ctrl-C detaches without cancelling durable
work; preserve the exact run ID and reattach:

```sh
flow-supervised research --client /private/original/client --attach RUN_ID
flow-supervised research --client /private/original/client --cancel RUN_ID
flow-supervised runs
```

Confirmation and attachment use the saved mode, source packet, angles and policy;
omit new mode, question, source, angle, concurrency or cycle flags. Decisions use
only fresh authority-derived actions. Cancellation
submits the currently offered action, not a process signal. A cancelled phase or
stopped owner alone does not prove worker retirement or workspace reuse. Retain
uncertain effects and follow the original authority's recovery evidence.

## Read the report

A completed `flow.project-research-result/v1` includes the answer, exact source
citations, host-created researcher evidence identity, findings and nonempty
residual gaps. Findings need not be empty for research to complete. Lower
assurance is explicit: the report covers supplied bytes, not an independently
verified survey, runtime check or open-web investigation.

An incomplete, blocked, cancelled or unavailable attempt is not a validated
report. Keep its retained evidence and inspect unresolved effects, quarantine
and workspace disposition. `runs` can find the original attempt without starting
an owner. Research creates no prototype, candidate, independent code review,
human approval or publication authority.

Deep results use `flow.project-deep-research-result/v1`. Read the original and
effective question, current cycle, typed angle dispositions, retained evidence
identity, both-angle criticism, findings, nonempty residual gaps and any semantic
cap. Complete coverage is automated research evidence, not independent source
authentication, a code review or human approval. Whole-run cancellation prevents
new critic work; it does not erase accepted history or establish retirement.
