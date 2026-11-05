#!/usr/bin/env python3
"""Generate a standalone provider-free Mac probe archive at an exclusive path."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile

MEMBERS = ("README.md", "host-inventory.sh", "probe.py", "verify-report.py")


def package(output):
    root = Path(__file__).resolve().parent
    contents = {name: (root / name).read_bytes() for name in MEMBERS}
    manifest = {"schema": "flow.macos-diagnostic-bundle/v1",
                "production_containment_proven": False, "native_provider_calls": 0,
                "files": {name: {"sha256": hashlib.sha256(data).hexdigest(), "mode": "0600"}
                          for name, data in contents.items()}}
    contents["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    # Exclusive creation preserves earlier packets. No source files are generated.
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as destination:
        with tarfile.open(fileobj=destination, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
            for name, data in contents.items():
                member = tarfile.TarInfo("flow-macos-probe/" + name)
                member.size = len(data)
                member.mode = 0o600
                archive.addfile(member, io.BytesIO(data))
        destination.flush()
        os.fsync(destination.fileno())
    return {"archive": str(output.resolve()), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "bytes": output.stat().st_size, "files": manifest["files"],
            "actual_mac_execution": "NOT_RUN", "production_containment_proven": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.output), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
