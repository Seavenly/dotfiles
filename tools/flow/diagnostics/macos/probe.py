#!/usr/bin/env python3
"""Disposable Darwin fixture observations. Never a production containment proof."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

FIXTURE_SECONDS = 10
INVOCATION_SECONDS = 25


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def host():
    uname = os.uname()
    return {"sys_platform": sys.platform, "system": uname.sysname,
            "kernel_release": uname.release, "kernel_version": uname.version,
            "machine_observed": uname.machine, "macos_observed": platform.mac_ver()[0],
            "python": sys.version, "python_executable": os.path.realpath(sys.executable)}


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("owned output must be a real directory")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("owned output must belong to this UID with mode 0700")


def write_json(path, value):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    temporary = path.with_name(path.name + ".partial-" + uuid.uuid4().hex)
    descriptor = os.open(temporary, flags, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    # Publish complete bytes without replacing an existing fixture record.
    try:
        os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink()


def read_record(path, token):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("invalid fixture record owner/type")
        if stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384:
            raise ValueError("invalid fixture record permissions/size")
        value = json.load(source)
    if value.get("token") != token:
        raise ValueError("fixture record token mismatch")
    return value


def wait_record(path, token, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            return read_record(path, token)
        except FileNotFoundError:
            time.sleep(0.02)
    raise TimeoutError("fixture ready record unavailable")


def arm_fixture():
    # Every fork branch arms its own timer; timers are not assumed inherited.
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.setitimer(signal.ITIMER_REAL, FIXTURE_SECONDS)


def identity(token, role):
    return {"token": token, "role": role, "pid": os.getpid(), "ppid": os.getppid(),
            "pgid": os.getpgrp(), "sid": os.getsid(0), "uid": os.getuid(),
            "ready_monotonic_ns": time.monotonic_ns(), "utc": now(),
            "identity_kind": "cooperative_owned_fixture_self_report"}


def fixture_wait(run, token, role):
    write_json(run / (role + "-ready.json"), identity(token, role))
    wait_record(run / (role + "-release.json"), token, FIXTURE_SECONDS - 1)
    write_json(run / (role + "-exit-intent.json"),
               {"token": token, "role": role, "pid": os.getpid(),
                "intended_exit": 0, "utc": now(), "is_actual_exit_receipt": False})


def fixture(args):
    run = Path(args.run_directory)
    private_directory(run)
    if len(args.token) != 32 or any(c not in "0123456789abcdef" for c in args.token):
        raise ValueError("invalid fixture token")
    arm_fixture()
    if args.fixture == "direct":
        fixture_wait(run, args.token, "direct")
        return 0
    intermediate = os.fork()
    if intermediate == 0:
        arm_fixture()
        os.setsid()
        grandchild = os.fork()
        if grandchild == 0:
            arm_fixture()
            try:
                fixture_wait(run, args.token, "escaped")
                os._exit(0)
            except BaseException:
                os._exit(125)
        os._exit(0)
    waited_pid, status = os.waitpid(intermediate, 0)
    write_json(run / "intermediate-wait.json",
               {"token": args.token, "waited_pid": waited_pid,
                "wait_status": status, "exit_code": os.waitstatus_to_exitcode(status)})
    wait_record(run / "escaped-ready.json", args.token, 3)
    return 0


def watch(pid):
    queue = select.kqueue()
    try:
        queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                    flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                    fflags=select.KQ_NOTE_EXIT)], 0, 0)
    except BaseException:
        queue.close()
        raise
    return queue


def exit_event(queue, seconds):
    events = queue.control(None, 1, seconds)
    if not events:
        raise TimeoutError("owned fixture kernel exit event unavailable")
    event = events[0]
    if not event.fflags & select.KQ_NOTE_EXIT:
        raise ValueError("expected NOTE_EXIT")
    return {"ident": event.ident, "filter": event.filter,
            "flags": event.flags, "fflags": event.fflags,
            "kind": "kqueue_process_exit_observation", "is_wait_or_tree_proof": False}


def release(run, role, token):
    write_json(run / (role + "-release.json"), {"token": token})


def probe(args):
    os.umask(0o077)
    parent = Path(args.output_parent).expanduser().resolve(strict=True)
    run = Path(tempfile.mkdtemp(prefix="issue92-darwin-", dir=parent))
    private_directory(run)
    token = uuid.uuid4().hex
    receipt = {"schema": "issue92.darwin-fixture-observation/v1", "status": "INCOMPLETE",
               "start_utc": now(), "host": host(), "run_directory": str(run),
               "token": token, "invocation_bound_seconds": INVOCATION_SECONDS,
               "fixture_self_deadline_seconds": FIXTURE_SECONDS,
               "production_containment_proven": False, "native_provider_calls": 0,
               "home_or_auth_copied": False, "signals_to_other_pids": 0,
               "private_identity_apis_used": [], "identity_scope": "owned_cooperative_fixtures_only",
               "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "interpreter_sha256": hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest(),
               "confinement_canary": "NOT_IMPLEMENTED",
               "native_agent_qualification": "NOT_RUN",
               "cases": {}, "resource_disposition": "RETAIN_ALL_OUTPUT"}
    write_json(run / "start.json", receipt)
    children, queues, logs = [], [], []
    def alarm(*_):
        raise TimeoutError("invocation deadline reached; retain evidence")
    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, INVOCATION_SECONDS)
    invocation_deadline = time.monotonic() + INVOCATION_SECONDS
    try:
        for role in ("direct", "escape-parent"):
            out = open(run / (role + ".stdout"), "xb")
            err = open(run / (role + ".stderr"), "xb")
            logs.extend([out, err])
            command = [os.path.realpath(sys.executable), "-I", "-S", str(Path(__file__).resolve()),
                       "--fixture", "direct" if role == "direct" else "escape",
                       "--run-directory", str(run), "--token", token]
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     start_new_session=True, cwd=run,
                                     env={"PATH": "/usr/bin:/bin", "TMPDIR": str(run)})
            children.append(child)
            target_role = "direct" if role == "direct" else "escaped"
            ready = wait_record(run / (target_role + "-ready.json"), token, 3)
            if time.monotonic_ns() - ready["ready_monotonic_ns"] > 2_000_000_000:
                raise ValueError("stale ready observation; do not infer identity")
            if role == "direct" and ready["pid"] != child.pid:
                raise ValueError("direct fixture identity differs from Popen child")
            queue = watch(ready["pid"])
            queues.append(queue)
            case = {"command": command, "popen_pid": child.pid, "ready": ready}
            receipt["cases"][role] = case
            if role == "escape-parent":
                case["direct_parent_actual_wait_exit"] = child.wait(timeout=4)
                case["intermediate_actual_wait"] = read_record(run / "intermediate-wait.json", token)
                if case["intermediate_actual_wait"]["exit_code"] != 0:
                    raise ValueError("intermediate child did not exit successfully")
                # Read-only PID lookup: this is not a signal or race-free identity primitive.
                observed_group = os.getpgid(ready["pid"])
                case["after_parent_wait_observed_pgid"] = observed_group
                case["escaped_fixture_observed_outside_parent_group"] = observed_group != child.pid
                if case["direct_parent_actual_wait_exit"] != 0 or observed_group == child.pid:
                    raise ValueError("expected parent exit while fixture remains outside its group")
            release(run, target_role, token)
            case["exit_observation"] = exit_event(queue, FIXTURE_SECONDS + 1)
            case["fixture_exit_intent"] = read_record(run / (target_role + "-exit-intent.json"), token)
            if case["fixture_exit_intent"]["pid"] != ready["pid"]:
                raise ValueError("fixture exit-intent identity mismatch")
            if role == "direct":
                case["actual_popen_wait_exit"] = child.wait(timeout=4)
                if case["actual_popen_wait_exit"] != 0:
                    raise ValueError("direct fixture did not exit successfully")
            else:
                deadline = time.monotonic() + 2
                case["live_pid_resolution_absent"] = False
                while time.monotonic() < deadline:
                    try:
                        os.getpgid(ready["pid"])
                    except ProcessLookupError:
                        case["live_pid_resolution_absent"] = True
                        break
                    time.sleep(0.02)
                case["escaped_child_waited_by_probe"] = False
                case["full_tree_retirement_proven"] = False
                if not case["live_pid_resolution_absent"]:
                    raise ValueError("escaped PID still resolves; retain output and uncertainty")
        receipt["status"] = "FIXTURE_OBSERVATIONS_RECORDED"
    except BaseException as error:
        receipt["status"] = "BLOCKED_OR_FAILED"
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        # Release only token-bound fixture gates; no signal-based cleanup.
        for role in ("direct", "escaped"):
            try:
                release(run, role, token)
            except FileExistsError:
                pass
        receipt["direct_child_disposition"] = []
        for child in children:
            try:
                remaining = max(0, invocation_deadline - time.monotonic())
                code = child.wait(timeout=min(FIXTURE_SECONDS + 1, remaining))
                receipt["direct_child_disposition"].append({"pid": child.pid, "actual_wait_exit": code})
            except subprocess.TimeoutExpired:
                receipt["direct_child_disposition"].append({"pid": child.pid, "actual_wait_exit": None,
                                                          "disposition": "UNKNOWN_RETAIN_NO_SIGNAL"})
                receipt["status"] = "BLOCKED_OR_FAILED"
        for queue in queues:
            queue.close()
        for output in logs:
            output.close()
        receipt["end_utc"] = now()
        receipt["elapsed_monotonic_seconds"] = time.monotonic() - (invocation_deadline - INVOCATION_SECONDS)
        receipt["scenario_timer_exceeded"] = time.monotonic() > invocation_deadline
        if receipt["scenario_timer_exceeded"]:
            receipt["status"] = "BLOCKED_OR_FAILED"
        receipt["files_sha256"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in run.iterdir() if p.is_file()}
        write_json(run / "report.json", receipt)
    print(json.dumps({"status": receipt["status"], "report": str(run / "report.json"),
                      "production_containment_proven": False}))
    return 0 if receipt["status"] == "FIXTURE_OBSERVATIONS_RECORDED" else 1


def main():
    # Guard precedes argument processing, directory creation, fork and subprocess.
    if sys.platform != "darwin":
        print(json.dumps({"schema": "issue92.darwin-probe-rejection/v1",
                          "code": "unsupported_host", "observed_platform": sys.platform,
                          "child_processes_spawned": 0, "native_provider_calls": 0}))
        return 3
    if sys.version_info < (3, 11):
        print(json.dumps({"code": "python_version_unavailable", "required": "3.11+"}))
        return 3
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-parent")
    parser.add_argument("--fixture", choices=("direct", "escape"), help=argparse.SUPPRESS)
    parser.add_argument("--run-directory", help=argparse.SUPPRESS)
    parser.add_argument("--token", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture:
        if not args.run_directory or not args.token:
            parser.error("fixture requires allocated output and token")
        return fixture(args)
    if not args.output_parent:
        parser.error("--output-parent requires an existing, allocated directory")
    return probe(args)


if __name__ == "__main__":
    sys.exit(main())
