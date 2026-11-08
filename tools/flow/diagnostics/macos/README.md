# Provider-free Mac diagnostic bundle

Collect separate evidence on the personal and work MacBooks without starting
Flow or an agent. This bundle does not enable native Darwin execution. It uses
only an already installed Python 3.11+ and macOS system inventory commands.
It installs nothing and reads no HOME, native agent configuration or credentials.

Generate a transport archive from a Linux checkout using an existing Python:

```sh
python3 -I -S tools/flow/diagnostics/macos/package.py --output /allocated/path/flow-macos-probe.tar.gz
```

The output path must not exist; the archive and manifest bind the exact script
bytes. Copy it to an allocated directory on each Mac and extract it there. The
archive contains only five regular files under `flow-macos-probe/`, all mode
0600. Do not put personal/work host evidence in the repository.

Maintainer verification is `python3 -I -S tools/flow/diagnostics/macos/test.py -v`.
It checks packaging, Linux refusal without resource effects, and offline packet
validation including synthetic consistency/tamper cases. Synthetic packets
establish no Darwin mechanism or native qualification.

The smallest first host action is read-only inventory:

```sh
sh /allocated/path/flow-macos-probe/host-inventory.sh
```

It prints macOS version, observed kernel architecture and a Python lookup without
executing that Python. Record whether this is the personal or work host and
whether local fixture execution is permitted. Physical chip, Rosetta execution
and managed restrictions remain explicit operator inputs. No host names, serial
numbers, auth files or management profiles are collected.

Choose an existing, known absolute Python 3.11+ executable. Avoid an unverified
system stub; the bundle never installs Python. Create an external evidence parent
directory, then run once on each permitted actual Mac:

```sh
/absolute/known/python3 -I -S /allocated/path/flow-macos-probe/probe.py --output-parent /allocated/evidence
```

The script prints one retained `issue92-darwin-*/report.json` path and returns 0
only for complete fixture observations. Capture the actual command, stdout,
stderr and exit status. Return the entire report directory and inventory output.
Do not repeat a failed probe before inspecting its retained evidence. The probe
refuses Linux with exit 3 before argument processing, writing files or spawning.

Verify the returned packet offline on either host, using the exact bundle:

```sh
/absolute/known/python3 -I -S /allocated/path/flow-macos-probe/verify-report.py /allocated/evidence/issue92-darwin-EXACT
```

`FIXTURE_PACKET_COMPLETE` means the retained bytes and observations agree. It is
a consistency check of cooperative fixture evidence, not cryptographic host
attestation. No production qualification follows. Copy/extraction must preserve
regular files and mode 0600 for report members. Verification accepts no symlink
members or unbound extra files. Keep transport logs outside the report directory.

## What the fixture observes

The probe creates two direct Python children. The second creates an intermediate
child and a double-forked `setsid` grandchild. Every fixture branch arms a
10-second self-expiry, and the observer has a 25-second scenario bound. Kernel
suspension or blocked OS calls can delay those timers. The direct children
provide actual `wait` exit statuses. The observer registers kqueue exit watches
while the direct child and escaped grandchild wait at nonce-bound gates.

The counterexample shows the direct parent can exit while its grandchild lives
outside its group. A grandchild exit event and later failed PID lookup are
observations only: the observer does not reap that grandchild, and an exit-intent
file does not establish exit. The report retains that distinction. No other PID
is signalled, no launchd job is installed and no private identity API is used.

Identity records are cooperative fixture self-reports. They do not establish
race-free identity for arbitrary unmodified agents or recovery after worker loss.
All output remains on disk. Missing reports, nonzero exits, pending children or
unresolved escaped PIDs require retaining the evidence and resource uncertainty.
Do not infer cleanup from self-expiry intent or delete an incomplete packet.

This packages the previously prepared issue92 fixture, with exact interpreter
and script hashes, intermediate wait evidence, elapsed bounds and an offline
verifier. It does not implement the separate confinement canary. Scratch-only
writes, denied fake HOME/auth reads, denied symlink/temp escape, network denial,
native startup policy, owner restart and reboot remain unproved. Actual Mac
execution and both native harnesses remain NOT_RUN until their own evidence exists.

## Practical deployment decision

The accepted cooperative host-local threat model excludes a malicious same-user
actor. It still includes ordinary tools that detach or call `setsid`; treating
parent exit or an empty process group as complete retirement would weaken the
current contract. The fixture makes that distinction observable on the actual
host. Existing kqueue, launchd and Seatbelt findings supply no established
equivalent of the Linux subreaper/pidfd worker. This bundle makes no impossibility
claim about Darwin and adds no speculative production adapter.

The recommended fallback is each Mac's ordinary SSH terminal connected to the
existing Ubuntu host, if that access and workflow are accepted. It reuses the
current Linux implementation without adding a remote execution backend. A local
Linux guest is the alternative when local/offline execution is required. Either
is a separate deployment and qualification target. Flow authority,
repository workspace, checks and official CLI authentication must reside there;
the Mac is the terminal/UI. Host HOME/auth must not be copied. Native CLI policy
qualification is still required in that environment. Guest installation, work
device permission, new dependencies and this change in daily workflow require
user alignment before implementation. No VM or remote execution is selected by
this diagnostic bundle.

To keep native Mac execution as a release requirement, the decisive next input is
actual host access and restrictions plus a supported mechanism that owns escaped
descendants through cancellation and positive final retirement. Passing this
fixture alone cannot supply it. If no mechanism is established, preserve the
native admission block and decide explicitly between the Linux deployment and
a revised cooperative contract.
