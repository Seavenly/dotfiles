"""Unadmitted Mac launchd/coalition observations, never retirement authority."""
import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import platform
import plistlib
import subprocess
import time
import uuid


def output():
    return {"schema": "flow.mac-ownership-canary/v1", "admitted": False,
            "retirement_proven": False, "proof": None,
            "qualification": "not_run", "platform": platform.system(),
            "observations": [], "commands": []}


def coalition(pid):
    """Private Apple ABI; failed symbols/permissions/sizes remain explicit."""
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        fn = libproc.proc_pidinfo
        fn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                       ctypes.c_void_p, ctypes.c_int]
        fn.restype = ctypes.c_int
        # XNU proc_info_private.h: flavor20, two IDs and three reserved u64s.
        ids = (ctypes.c_uint64 * 5)()
        size = fn(pid, 20, 0, ids, ctypes.sizeof(ids))
        if size != ctypes.sizeof(ids):
            return {"supported": False, "return_size": size, "errno": ctypes.get_errno()}
        value = {"supported": True, "resource_id": ids[0], "jetsam_id": ids[1]}
        value["usage"] = resource_usage(ids[0])
        return value
    except (OSError, AttributeError) as error:
        return {"supported": False, "error": str(error)}


def resource_usage(coalition_id):
    try:
        system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        usage = system.coalition_info_resource_usage
        usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
        usage.restype = ctypes.c_int
        # XNU copies min(requested size, current struct size); prefix is three u64s.
        prefix = (ctypes.c_uint64 * 3)()
        result = usage(coalition_id, prefix, ctypes.sizeof(prefix))
        return {"return": result, "errno": ctypes.get_errno(),
                "tasks_started": prefix[0] if result == 0 else None,
                "tasks_exited": prefix[1] if result == 0 else None}
    except (OSError, AttributeError) as error:
        return {"supported": False, "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="new private evidence directory")
    args = parser.parse_args()
    report = output()
    if platform.system() != "Darwin":
        report["status"] = "unsupported_platform"
        print(json.dumps(report, indent=2))
        return 2
    directory = pathlib.Path(args.output).absolute()
    directory.mkdir(mode=0o700)  # Never reuse, erase or follow an existing output path.
    report["directory"] = str(directory)
    report["uname"] = list(platform.uname())
    private = directory / "private"
    private.mkdir(mode=0o700)
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(private),
                   "TMPDIR": str(private), "LANG": "C"}
    jobs = []

    def save():
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    def command(argv, timeout=5):
        index = len(report["commands"])
        with (directory / f"command-{index}.stdout").open("wb") as out, \
                (directory / f"command-{index}.stderr").open("wb") as err:
            try:
                result = subprocess.run(argv, env=environment, stdin=subprocess.DEVNULL,
                                        stdout=out, stderr=err, timeout=timeout)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = "timeout"
        report["commands"].append({"argv": argv, "exit": code})
        save()
        return code

    try:
        if command(["/usr/bin/xcode-select", "-p"]) != 0:
            report["status"] = "developer_tools_unavailable_no_install_attempted"
            return 2
        developer = pathlib.Path((directory / "command-0.stdout").read_text().strip())
        if not developer.is_absolute() or not developer.is_dir():
            report["status"] = "selected_developer_directory_unavailable"
            return 2
        developer = developer.resolve()
        compiler = developer / "usr/bin/clang"
        sdk = developer / "SDKs/MacOSX.sdk"
        if not compiler.is_file():
            compiler = developer / "Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
            sdk = developer / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
        if not compiler.is_file() or not os.access(compiler, os.X_OK) or \
                not (sdk / "SDKSettings.json").is_file() or \
                not (sdk / "System/Library/Frameworks").is_dir():
            report["status"] = "selected_compiler_or_sdk_unavailable_no_install_attempted"
            return 2
        compiler = compiler.resolve()
        sdk = sdk.resolve()
        if compiler.parent == pathlib.Path("/usr/bin") or \
                not compiler.is_relative_to(developer) or not sdk.is_relative_to(developer):
            report["status"] = "selected_tools_escape_developer_directory"
            return 2
        report["selected_compiler"] = str(compiler)
        report["selected_sdk"] = str(sdk)
        source = pathlib.Path(__file__).with_name("helper.c")
        helper = directory / "owned-helper"
        if command([str(compiler), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-isysroot", str(sdk), str(source), "-o", str(helper)], timeout=20) != 0:
            report["status"] = "compile_failed_or_missing_sdk_no_install_attempted"
            return 2
        report["helper_sha256"] = hashlib.sha256(helper.read_bytes()).hexdigest()
        report["controller_coalition"] = coalition(os.getpid())
        domain = f"gui/{os.getuid()}"
        started = time.monotonic()
        for _ in range(2):
            label = "local.flow.ownership-canary." + uuid.uuid4().hex
            owned = directory / label
            owned.mkdir(mode=0o700)
            path = directory / (label + ".plist")
            path.write_bytes(plistlib.dumps({"Label": label,
                "ProgramArguments": [str(helper), str(owned)], "RunAtLoad": True,
                "KeepAlive": False, "ExitTimeOut": 2,
                "StandardOutPath": str(owned / "stdout"),
                "StandardErrorPath": str(owned / "stderr"),
                "EnvironmentVariables": environment}))
            target = domain + "/" + label
            # Record cleanup ownership before bootstrap, including partial failures.
            jobs.append(target)
            command(["/bin/launchctl", "bootstrap", domain, str(path)])
        time.sleep(1)
        for owned in directory.glob("local.flow.ownership-canary.*"):
            if not owned.is_dir():
                continue
            for record in sorted(owned.glob("*.json")):
                value = json.loads(record.read_text())
                value["job"] = owned.name
                value["coalition"] = coalition(value["pid"])
                report["observations"].append(value)
        for target in jobs:
            command(["/bin/launchctl", "print", target])
            command(["/bin/launchctl", "bootout", target])
        # No PID/process-group signals: escaped helpers have their own <=20s alarm.
        time.sleep(max(0, 22 - (time.monotonic() - started)))
        report["after_deadline"] = [{"pid": item["pid"],
            "coalition_query": coalition(item["pid"])} for item in report["observations"]]
        ids = sorted({item["coalition"]["resource_id"] for item in report["observations"]
                      if item["coalition"].get("supported")})
        report["coalitions_after_deadline"] = [{"resource_id": cid,
            "usage": resource_usage(cid)} for cid in ids]
        report["status"] = "observations_only_host_interpretation_required" if len(report["observations"]) == 8 else "incomplete_owned_helper_observations"
        report["qualification"] = "not_granted"
        return 0
    except (OSError, ValueError) as error:
        report["status"] = "unsupported_or_observation_error"
        report["error"] = str(error)
        return 2
    finally:
        for target in jobs:
            command(["/bin/launchctl", "bootout", target])
        report["cleanup"] = "only the two recorded unique per-user launchd targets; no PID signals"
        save()
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
