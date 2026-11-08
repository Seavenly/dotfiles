#!/usr/bin/env python3
"""Check a retained fixture packet offline; never grants production authority."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def read_private_file(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("packet member must be a regular mode 0600 file: " + path.name)
        if info.st_size > 1024 * 1024:
            raise ValueError("packet member exceeds diagnostic bound")
        return source.read()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(directory):
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink(), "expected real packet directory")
    report = json.loads(read_private_file(directory / "report.json"))
    require(report["schema"] == "issue92.darwin-fixture-observation/v1", "unexpected report schema")
    require(report["status"] == "FIXTURE_OBSERVATIONS_RECORDED", "fixture did not complete")
    require(report["host"]["sys_platform"] == "darwin", "actual Darwin observation missing")
    require(report["production_containment_proven"] is False, "invalid production claim")
    require(report["native_provider_calls"] == 0 and report["signals_to_other_pids"] == 0,
            "unexpected provider call or signal")
    require(report["home_or_auth_copied"] is False and report["private_identity_apis_used"] == [],
            "unexpected authentication copy or private API")
    require(report["confinement_canary"] == "NOT_IMPLEMENTED", "unexpected confinement claim")
    require(report["native_agent_qualification"] == "NOT_RUN", "unexpected qualification claim")
    require(report["probe_sha256"] == hashlib.sha256(
        (Path(__file__).resolve().parent / "probe.py").read_bytes()).hexdigest(), "probe source binding changed")
    require(report["scenario_timer_exceeded"] is False, "scenario deadline exceeded")
    require(0 <= report["elapsed_monotonic_seconds"] <= report["invocation_bound_seconds"],
            "invalid observed elapsed bound")
    token = report["token"]
    require(isinstance(token, str) and len(token) == 32 and all(c in "0123456789abcdef" for c in token),
            "invalid fixture token")
    hashes = report["files_sha256"]
    members = {p.name for p in directory.iterdir()}
    require(set(hashes) == members - {"report.json"}, "packet files missing or unbound")
    for name, digest in hashes.items():
        require(Path(name).name == name and name not in (".", ".."), "invalid member name")
        require(hashlib.sha256(read_private_file(directory / name)).hexdigest() == digest,
                "packet digest mismatch: " + name)
    required = {"start.json", "direct-ready.json", "direct-release.json", "direct-exit-intent.json",
                "escaped-ready.json", "escaped-release.json", "escaped-exit-intent.json",
                "intermediate-wait.json", "direct.stdout", "direct.stderr",
                "escape-parent.stdout", "escape-parent.stderr"}
    require(required <= set(hashes), "required retained evidence missing")
    start = json.loads(read_private_file(directory / "start.json"))
    require(all(start[key] == report[key] for key in ("token", "host", "probe_sha256", "interpreter_sha256")),
            "start observation binding mismatch")
    cases = report["cases"]
    require(set(cases) == {"direct", "escape-parent"}, "incomplete fixture cases")
    for role, record_role in (("direct", "direct"), ("escape-parent", "escaped")):
        case = cases[role]
        ready = json.loads(read_private_file(directory / (record_role + "-ready.json")))
        intent = json.loads(read_private_file(directory / (record_role + "-exit-intent.json")))
        release = json.loads(read_private_file(directory / (record_role + "-release.json")))
        require(ready == case["ready"] and intent == case["fixture_exit_intent"], "record binding mismatch")
        require(ready["token"] == intent["token"] == release["token"] == token, "record token mismatch")
        require(ready["pid"] == intent["pid"] == case["exit_observation"]["ident"], "exit identity mismatch")
        require(intent["is_actual_exit_receipt"] is False and intent["intended_exit"] == 0,
                "exit intent is not an actual exit receipt")
        require(case["exit_observation"]["is_wait_or_tree_proof"] is False, "invalid kernel event claim")
    direct, escaped = cases["direct"], cases["escape-parent"]
    require(direct["ready"]["pid"] == direct["popen_pid"] and direct["actual_popen_wait_exit"] == 0,
            "owned direct-child wait missing")
    require(escaped["direct_parent_actual_wait_exit"] == 0, "escape parent wait missing")
    intermediate = json.loads(read_private_file(directory / "intermediate-wait.json"))
    require(intermediate == escaped["intermediate_actual_wait"] and intermediate["exit_code"] == 0,
            "intermediate wait missing")
    require(escaped["escaped_fixture_observed_outside_parent_group"] is True and
            escaped["after_parent_wait_observed_pgid"] != escaped["popen_pid"], "escape counterexample missing")
    require(escaped["live_pid_resolution_absent"] is True and
            escaped["escaped_child_waited_by_probe"] is False and
            escaped["full_tree_retirement_proven"] is False, "escaped fixture disposition incomplete")
    dispositions = report["direct_child_disposition"]
    require(len(dispositions) == 2 and
            {d["pid"] for d in dispositions} == {direct["popen_pid"], escaped["popen_pid"]} and
            all(d["actual_wait_exit"] == 0 for d in dispositions), "owned child retirement incomplete")
    return {"status": "FIXTURE_PACKET_COMPLETE", "host": report["host"],
            "report_sha256": hashlib.sha256(read_private_file(directory / "report.json")).hexdigest(),
            "production_containment_proven": False, "native_agent_qualification": "NOT_RUN",
            "confinement_canary": "NOT_IMPLEMENTED", "resource_disposition": "RETAIN_ALL_OUTPUT"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.directory)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "INVALID_OR_INCOMPLETE", "error": str(error),
                          "production_containment_proven": False}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
