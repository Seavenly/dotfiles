# Unadmitted Mac ownership canary

This isolated diagnostic asks whether two unique per-user launchd jobs have
distinct resource coalitions and whether ordinary fork and double-fork/setsid
descendants retain their job's coalition membership. It records counters before
and after job removal and helper deadlines. It grants no Flow admission or
retirement proof. Actual macOS execution is NOT_RUN until an operator returns
host evidence. Linux results cannot qualify Darwin behavior.

On a Mac with Python 3 and existing Command Line Tools, from this directory:

```sh
python3 probe.py --output "${TMPDIR:-/tmp}/flow-ownership-$(date +%s)-$$"
```

Use a new directory. Do not use sudo. No downloads, auth/config reads, network,
privileged helper, coalition mutation, or global signals are used. The probe
compiles only the adjacent owned C helper with `/usr/bin/clang`. Missing SDK,
compiler, private symbols, per-user GUI domain, permissions and API failures are
retained as failures or unsupported observations; nothing is installed.

The two job labels contain random UUIDs. Plists and output remain in the private
evidence directory, outside LaunchAgents. Only those exact job targets receive
`bootout`. Four processes per job self-exit within 20 seconds even if the probe
is interrupted; the normal observation window is about 22 seconds. No PID or
process-group signals are sent. Return the complete output directory, including
`report.json`, plists, command logs and per-PID helper records. Inspect it before
sharing; it contains host version, username-bearing paths and owned PID details.

`retirement_proven` always remains false and `proof` remains null. Counter
equality or missing PID observations cannot prove that a coalition is sealed
against future members or that arbitrary native agents are fully retired.
Cross-job equality of resource IDs would disprove the proposed job isolation.
Missing helper records or unavailable private APIs leave the question unresolved.
Cleanup command results remain visible; no cleanup success is inferred from a
failed `launchctl` command.

Primary Apple source references (interfaces are private and may change):

- [proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h): flavor 20 and the five-u64 PID coalition record.
- [mach/coalition.h](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h): resource coalition kind and usage counter prefix.
- [sys_coalition.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c): usage read copies the requested prefix; lifecycle creation/termination are separate privileged operations.
- [launchd.plist manual source](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5): job lifecycle expectations. Its process-group behavior does not establish escaped-descendant retirement.

Linux-only provider-free portability checks:

```sh
python3 test.py
```

These compile and run the actual POSIX helper, observe all four owned roles and
the new session, reap their own descendants, and verify that the public Mac
probe refuses Linux before any output mutation or child execution. They do not
compile Darwin code or mock a successful Mac host result.
