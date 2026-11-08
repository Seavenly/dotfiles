#!/usr/bin/env python3
"""Portable bundle checks. Synthetic packets are never Mac execution evidence."""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BundleTests(unittest.TestCase):
    def test_packaging_binds_files_and_preserves_existing_archive(self):
        module = load("package")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "probe.tar.gz"
            receipt = module.package(archive)
            before = archive.read_bytes()
            self.assertEqual(receipt["sha256"], hashlib.sha256(before).hexdigest())
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            with tarfile.open(archive) as packet:
                members = packet.getmembers()
                self.assertEqual({m.name for m in members},
                                 {"flow-macos-probe/" + n for n in (*module.MEMBERS, "manifest.json")})
                self.assertTrue(all(m.isfile() and m.mode == 0o600 for m in members))
                manifest = json.load(packet.extractfile("flow-macos-probe/manifest.json"))
                for name, identity in manifest["files"].items():
                    data = packet.extractfile("flow-macos-probe/" + name).read()
                    self.assertEqual(hashlib.sha256(data).hexdigest(), identity["sha256"])
                    if name.endswith(".py"):
                        ast.parse(data)
            with self.assertRaises(FileExistsError):
                module.package(archive)
            self.assertEqual(archive.read_bytes(), before)

    @unittest.skipUnless(sys.platform == "linux", "actual Linux refusal check")
    def test_linux_guard_has_no_resource_effects(self):
        active, forbidden = [False], []
        def audit(event, args):
            if not active[0]:
                return
            if event in ("subprocess.Popen", "os.fork", "os.forkpty", "os.posix_spawn", "os.exec",
                         "os.system", "os.mkdir", "os.remove", "os.rename", "os.link", "os.chmod",
                         "socket.__new__", "socket.connect"):
                forbidden.append(event)
                raise AssertionError(event)
            if event == "open":
                mode, flags = args[1], args[2]
                if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                        isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT)):
                    forbidden.append("open_write")
                    raise AssertionError("filesystem write")
        sys.addaudithook(audit)
        before_files = sorted(p.name for p in ROOT.iterdir())
        children_path = Path(f"/proc/self/task/{os.getpid()}/children")
        before_children = children_path.read_text()
        output = io.StringIO()
        original = sys.argv
        try:
            sys.argv = [str(ROOT / "probe.py"), "--output-parent", str(ROOT)]
            active[0] = True
            with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(ROOT / "probe.py"), run_name="__main__")
        finally:
            active[0] = False
            sys.argv = original
        self.assertEqual(stopped.exception.code, 3)
        self.assertEqual(json.loads(output.getvalue())["code"], "unsupported_host")
        self.assertEqual(forbidden, [])
        self.assertEqual(before_children, children_path.read_text())
        self.assertEqual(before_files, sorted(p.name for p in ROOT.iterdir()))

    def test_offline_verifier_rejects_missing_report_and_symlink(self):
        verifier = load("verify-report")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(FileNotFoundError):
                verifier.verify(directory)
            target = directory / "target"
            target.write_text("{}")
            target.chmod(0o600)
            (directory / "report.json").symlink_to(target)
            with self.assertRaises(OSError):
                verifier.verify(directory)

    def test_incomplete_or_qualified_claim_cannot_pass_verification(self):
        verifier = load("verify-report")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            report = directory / "report.json"
            for status, production in (("INCOMPLETE", False), ("FIXTURE_OBSERVATIONS_RECORDED", True)):
                report.write_text(json.dumps({"schema": "issue92.darwin-fixture-observation/v1",
                                             "status": status, "host": {"sys_platform": "darwin"},
                                             "production_containment_proven": production}))
                report.chmod(0o600)
                with self.assertRaises(ValueError):
                    verifier.verify(directory)

    def test_synthetic_packet_consistency_and_tamper_rejection(self):
        # Exercises packet validation only; this data is not actual Mac evidence.
        verifier = load("verify-report")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            def write(name, value):
                path = directory / name
                path.write_text(json.dumps(value))
                path.chmod(0o600)
            token = "a" * 32
            report = {"schema": "issue92.darwin-fixture-observation/v1",
                      "status": "FIXTURE_OBSERVATIONS_RECORDED", "host": {"sys_platform": "darwin"},
                      "token": token, "production_containment_proven": False, "native_provider_calls": 0,
                      "signals_to_other_pids": 0, "home_or_auth_copied": False, "private_identity_apis_used": [],
                      "confinement_canary": "NOT_IMPLEMENTED", "native_agent_qualification": "NOT_RUN",
                      "scenario_timer_exceeded": False, "elapsed_monotonic_seconds": 1,
                      "invocation_bound_seconds": 25, "cases": {},
                      "probe_sha256": hashlib.sha256((ROOT / "probe.py").read_bytes()).hexdigest(),
                      "interpreter_sha256": "b" * 64}
            write("start.json", {key: report[key] for key in
                                 ("token", "host", "probe_sha256", "interpreter_sha256")})
            for role, target, pid, parent in (("direct", "direct", 100, 100),
                                              ("escape-parent", "escaped", 201, 200)):
                ready = {"token": token, "pid": pid}
                intent = {"token": token, "pid": pid, "is_actual_exit_receipt": False, "intended_exit": 0}
                write(target + "-ready.json", ready)
                write(target + "-exit-intent.json", intent)
                write(target + "-release.json", {"token": token})
                write(role + ".stdout", "")
                write(role + ".stderr", "")
                case = {"ready": ready, "fixture_exit_intent": intent, "popen_pid": parent,
                        "exit_observation": {"ident": pid, "is_wait_or_tree_proof": False}}
                report["cases"][role] = case
            report["cases"]["direct"]["actual_popen_wait_exit"] = 0
            intermediate = {"token": token, "exit_code": 0}
            write("intermediate-wait.json", intermediate)
            report["cases"]["escape-parent"].update({"direct_parent_actual_wait_exit": 0,
                "intermediate_actual_wait": intermediate, "escaped_fixture_observed_outside_parent_group": True,
                "after_parent_wait_observed_pgid": 201, "live_pid_resolution_absent": True,
                "escaped_child_waited_by_probe": False, "full_tree_retirement_proven": False})
            report["direct_child_disposition"] = [{"pid": 100, "actual_wait_exit": 0},
                                                   {"pid": 200, "actual_wait_exit": 0}]
            report["files_sha256"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir()}
            write("report.json", report)
            self.assertEqual(verifier.verify(directory)["status"], "FIXTURE_PACKET_COMPLETE")
            write("direct.stdout", "tampered")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verifier.verify(directory)


if __name__ == "__main__":
    unittest.main()
