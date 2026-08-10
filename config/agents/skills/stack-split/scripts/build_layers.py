#!/usr/bin/env python3
"""Construct a true-linear stack of branches from a layer plan.

Reads a plan JSON on stdin, builds one branch per layer inside a temporary
worktree so the source ref and the user's checkout are never touched, then
proves the top layer's tree exactly equals the source tree.

Every (file, hunk) in the target..source diff must be assigned to exactly one
layer. An unassigned hunk would silently drop work; a doubly-assigned hunk
would duplicate it. Both are rejected before any ref is created.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SPLIT_DIFF = os.path.join(HERE, "split_diff.py")

# Sentinel for files that carry no hunks (pure renames) and so are indivisible.
WHOLE = "whole"


def die(msg, created=None):
    print(f"error: {msg}", file=sys.stderr)
    if created:
        print("\nBranches created before the failure:", file=sys.stderr)
        for b in created:
            print(f"  {b}", file=sys.stderr)
        print(
            "\nNothing was deleted. To roll back:\n  git branch -D "
            + " ".join(created),
            file=sys.stderr,
        )
    sys.exit(1)


def run(cmd, cwd=None, check=True, capture=True):
    p = subprocess.run(
        cmd, cwd=cwd, capture_output=capture, text=True,
    )
    if check and p.returncode != 0:
        raise RuntimeError(
            f"command failed ({p.returncode}): {' '.join(cmd)}\n"
            f"{(p.stderr or '').strip()}"
        )
    return p


def git(args, cwd=None, **kw):
    return run(["git"] + args, cwd=cwd, **kw)


def analyze(merge_base, source, repo):
    """Return {path: file_record} for the full merge_base..source diff."""
    diff = git(
        ["diff", f"{merge_base}..{source}"], cwd=repo
    ).stdout
    p = subprocess.run(
        [sys.executable, SPLIT_DIFF, "analyze"],
        input=diff, capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"analyze failed: {p.stderr.strip()}")
    data = json.loads(p.stdout)
    return {f["path"]: f for f in data["files"]}


def validate(plan, actual):
    """Every hunk of every changed file assigned exactly once."""
    seen = {}
    for i, layer in enumerate(plan["layers"]):
        for f in layer.get("files", []):
            path = f["path"]
            if path not in actual:
                die(f"layer {i+1} assigns {path}, which is not in the diff")
            rec = actual[path]
            hunks = f.get("hunks", "all")
            if rec["is_binary"] and hunks != "all":
                die(f"{path} is binary; it cannot be split by hunk")
            # A pure rename carries no hunks; it is an indivisible whole-file unit.
            if rec["hunk_count"] == 0:
                if hunks != "all":
                    die(f"{path} has no hunks; assign it whole with \"all\"")
                idxs = [WHOLE]
            else:
                idxs = (
                    list(range(rec["hunk_count"]))
                    if hunks == "all"
                    else sorted(int(h) for h in hunks)
                )
            for h in idxs:
                if h is not WHOLE and h >= rec["hunk_count"]:
                    die(
                        f"{path} hunk {h} does not exist "
                        f"(file has {rec['hunk_count']})"
                    )
                key = (path, h)
                if key in seen:
                    die(
                        f"{path} hunk {h} assigned to both layer "
                        f"{seen[key]+1} and layer {i+1}"
                    )
                seen[key] = i

    missing = []
    for path, rec in actual.items():
        if rec["hunk_count"] == 0:
            if (path, WHOLE) not in seen:
                missing.append(path)
            continue
        for h in range(rec["hunk_count"]):
            if (path, h) not in seen:
                missing.append(f"{path}#{h}")
    if missing:
        die(
            "unassigned changes would be silently dropped: "
            + ", ".join(missing[:20])
            + ("..." if len(missing) > 20 else "")
        )


def cumulative_hunks(plan, path, upto):
    """Hunk indices for `path` assigned in layers 0..upto inclusive."""
    out = set()
    for layer in plan["layers"][: upto + 1]:
        for f in layer.get("files", []):
            if f["path"] == path:
                hs = f.get("hunks", "all")
                if hs == "all":
                    return "all"
                out.update(int(h) for h in hs)
    return sorted(out)


def apply_file(wt, repo, plan, rec, spec, layer_idx, merge_base, source):
    """Materialize `spec['path']` in the worktree at layer `layer_idx`."""
    path = spec["path"]
    ctype = rec["change_type"]
    hunks = spec.get("hunks", "all")
    full = os.path.join(wt, path)

    if ctype == "D":
        git(["rm", "-q", "--", path], cwd=wt)
        return None  # git rm already stages it; re-adding a gone path errors

    os.makedirs(os.path.dirname(full) or wt, exist_ok=True)

    if ctype == "R" and rec.get("old_path"):
        # Take the new path's content, drop the old path.
        git(["checkout", source, "--", path], cwd=wt)
        old = rec["old_path"]
        if os.path.exists(os.path.join(wt, old)):
            git(["rm", "-q", "--", old], cwd=wt)
        return path

    if hunks == "all" or rec["is_binary"]:
        git(["checkout", source, "--", path], cwd=wt)
        return path

    # Partial hunks: rebuild from the merge-base content using the cumulative
    # hunk set for this file, so the layer's tree contains all prior layers'
    # edits to it plus this layer's.
    cum = cumulative_hunks(plan, path, layer_idx)
    if cum == "all":
        git(["checkout", source, "--", path], cwd=wt)
        return path

    with tempfile.TemporaryDirectory() as td:
        base_p = os.path.join(td, "base")
        diff_p = os.path.join(td, "diff")
        if ctype == "A":
            open(base_p, "w").close()
        else:
            with open(base_p, "w") as fh:
                fh.write(git(["show", f"{merge_base}:{path}"], cwd=repo).stdout)
        with open(diff_p, "w") as fh:
            fh.write(
                git(
                    ["diff", f"{merge_base}..{source}", "--", path], cwd=repo
                ).stdout
            )
        run(
            [
                sys.executable, SPLIT_DIFF, "reconstruct",
                "--base-file", base_p,
                "--diff-file", diff_p,
                "--hunks", ",".join(str(h) for h in cum),
                "--output", full,
            ]
        )
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True, help="plan JSON path, or - for stdin")
    ap.add_argument("--repo", default=".", help="repository path")
    ap.add_argument(
        "--dry-run", action="store_true",
        help="validate the plan and exit without creating refs",
    )
    args = ap.parse_args()

    raw = sys.stdin.read() if args.plan == "-" else open(args.plan).read()
    plan = json.loads(raw)

    repo = os.path.abspath(args.repo)
    source = plan["source_ref"]
    merge_base = plan["merge_base"]
    layers = plan["layers"]
    if len(layers) < 2:
        die("a stack needs at least 2 layers")

    actual = analyze(merge_base, source, repo)
    validate(plan, actual)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "ok": True,
                    "validated": True,
                    "layers": [l["branch"] for l in layers],
                    "files_in_diff": len(actual),
                },
                indent=2,
            )
        )
        return

    for layer in layers:
        b = layer["branch"]
        if git(["rev-parse", "--verify", "-q", b], cwd=repo, check=False).returncode == 0:
            die(f"branch {b} already exists; choose other names or delete it")

    wt = tempfile.mkdtemp(prefix="stack-split-")
    created = []
    try:
        git(["worktree", "add", "--quiet", "--detach", wt, merge_base], cwd=repo)
        parent = merge_base
        for i, layer in enumerate(layers):
            b = layer["branch"]
            git(["checkout", "--quiet", "-b", b, parent], cwd=wt)
            created.append(b)
            touched = []
            for spec in layer.get("files", []):
                t = apply_file(
                    wt, repo, plan, actual[spec["path"]], spec, i,
                    merge_base, source,
                )
                if t:
                    touched.append(t)
            if touched:
                git(["add", "--"] + touched, cwd=wt)
            if not git(["diff", "--cached", "--quiet"], cwd=wt, check=False).returncode:
                die(f"layer {b} produced no change; merge its content elsewhere", created)
            git(["commit", "--quiet", "-m", layer["message"]], cwd=wt)
            parent = b

        top = layers[-1]["branch"]
        eq = git(["diff", "--quiet", top, source], cwd=repo, check=False).returncode == 0
        if not eq:
            stat = git(["diff", "--stat", top, source], cwd=repo).stdout
            die(
                "tree-equality proof FAILED: top layer does not match the "
                f"source ref.\n{stat}",
                created,
            )

        print(
            json.dumps(
                {
                    "ok": True,
                    "tree_equality_proven": True,
                    "branches": created,
                    "top": top,
                    "next": f"gh stack init --base {plan['base']} "
                            + " ".join(created),
                },
                indent=2,
            )
        )
    except RuntimeError as e:
        die(str(e), created)
    finally:
        run(["git", "worktree", "remove", "--force", wt], cwd=repo, check=False)
        shutil.rmtree(wt, ignore_errors=True)


if __name__ == "__main__":
    main()
