"""Provider-free Linux checks. These do not simulate Darwin APIs or admission."""
import ctypes
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux-only portability checks")
class OwnedCanary(unittest.TestCase):
    def test_documented_shell_entry_refuses_linux_before_python_or_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            python = root / "must-not-execute"
            marker = root / "executed"
            python.write_text("#!/bin/sh\ntouch '" + str(marker) + "'\n")
            python.chmod(0o700)
            result = subprocess.run(["/bin/sh", str(HERE / "run.sh"),
                "--output", str(root / "output")], capture_output=True, timeout=3,
                env={"PATH": "/usr/bin:/bin", "FLOW_MAC_PROBE_PYTHON": str(python)})
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"unsupported platform", result.stderr)
            self.assertFalse(marker.exists())
            self.assertFalse((root / "output").exists())

    def test_linux_refuses_before_output_or_child_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = pathlib.Path(tmp) / "must-not-exist"
            result = subprocess.run([sys.executable, str(HERE / "probe.py"),
                "--output", str(destination)], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)
            value = json.loads(result.stdout)
            self.assertEqual(value["status"], "unsupported_platform")
            self.assertFalse(value["retirement_proven"])
            self.assertIsNone(value["proof"])
            self.assertEqual(value["commands"], [])
            self.assertFalse(destination.exists())

    def test_real_posix_helper_fork_doublefork_setsid_and_deadline(self):
        compiler = shutil.which("cc")
        self.assertIsNotNone(compiler, "Existing local C compiler required; no installs")
        # Own orphan grandchildren explicitly; never leave them to unrelated PID1.
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                binary = root / "helper"
                subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                    str(HERE / "helper.c"), "-o", str(binary)], check=True, timeout=10)
                invalid = subprocess.run([str(binary)], timeout=2)
                self.assertEqual(invalid.returncode, 2)
                child = subprocess.Popen([str(binary), str(root)], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env={"PATH": "/usr/bin:/bin", "HOME": tmp})
                try:
                    deadline = time.monotonic() + 3
                    while len(list(root.glob("*.json"))) < 4 and time.monotonic() < deadline:
                        time.sleep(.02)
                    records = [json.loads(p.read_text()) for p in root.glob("*.json")]
                    by_role = {r["role"]: r for r in records}
                    self.assertEqual(set(by_role), {"root", "fork", "intermediate", "doublefork-setsid"})
                    self.assertEqual(by_role["root"]["pid"], child.pid)
                    escaped = by_role["doublefork-setsid"]
                    self.assertEqual(escaped["session"], escaped["pid"])
                    self.assertEqual(escaped["group"], escaped["pid"])
                    self.assertEqual(by_role["fork"]["ppid"], child.pid)
                    self.assertEqual(child.wait(timeout=22), 0)
                    pid, code = os.waitpid(escaped["pid"], 0)
                    self.assertEqual(pid, escaped["pid"])
                    self.assertEqual(code, 0)
                finally:
                    if child.poll() is None:
                        child.wait(timeout=22)  # All helpers have a 20s self-alarm.
        finally:
            self.assertEqual(libc.prctl(36, previous.value, 0, 0, 0), 0)


if __name__ == "__main__":
    unittest.main()
