# Guided supplied-source research

Use quick research for one bounded question over local text you explicitly
supply. It does not search the web or implement a change. On the supported Linux
backend, begin in an existing clean Git project:

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
There is no independent per-role timer guarantee. `--follow-seconds` bounds
observation only. `--no-follow` or Ctrl-C detaches without cancelling durable
work; preserve the exact run ID and reattach:

```sh
flow-supervised research --client /private/original/client --attach RUN_ID
flow-supervised research --client /private/original/client --cancel RUN_ID
flow-supervised runs
```

Attachment uses the saved source packet and policy; omit new question, source or
policy flags. Decisions use only fresh authority-derived actions. Cancellation
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
