#!/usr/bin/env python3
"""Behavior of the review feed through its run entry point, with GitHub faked."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("review_feed", root / "tools/review-feed/review_feed.py")
feed = importlib.util.module_from_spec(spec)
sys.modules["review_feed"] = feed
spec.loader.exec_module(feed)

tmp = Path(tempfile.mkdtemp())
os.environ.update({
    "REVIEW_FEED_STATE_DIR": str(tmp / "state"),
    "COWORKER_PRS_FILE": str(tmp / "coworker-review-prs.jsonl"),
    "REVIEW_FEED_ORG": "example-org",
})

banners: list[dict] = []
queues: dict = {"review": [], "reply": [], "error": None}
feed.notify = banners.append
feed.github_token = lambda: "token"


def fake_collect(_gh, org, _team):
    assert org == "example-org"
    if queues["error"]:
        raise queues["error"]
    return "me", list(queues["review"]), list(queues["reply"])


feed.collect = fake_collect


def pr(number: int, **extra) -> feed.PR:
    return feed.PR(owner="example-org", repo="app", number=number, title=f"PR {number}",
                   url=f"https://github.com/example-org/app/pull/{number}",
                   updated_at="2026-09-28T12:00:00Z", **extra)


def run() -> list[dict]:
    banners.clear()
    assert feed.main([]) == 0
    return list(banners)


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"not ok - {message}", file=sys.stderr)
        sys.exit(1)


queues["review"] = [pr(1, head_sha="a", reason="direct review request")]
queues["reply"] = [pr(2, reply_state="commented", unaddressed=1)]
check(run() == [], "first run seeds without banners")
lines = [json.loads(line) for line in Path(os.environ["COWORKER_PRS_FILE"]).read_text().splitlines()]
check(lines == [
    {"repo": "example-org/app", "number": 1, "title": "PR 1",
     "url": "https://github.com/example-org/app/pull/1", "kind": "review"},
    {"repo": "example-org/app", "number": 2, "title": "PR 2",
     "url": "https://github.com/example-org/app/pull/2", "kind": "reply", "state": "commented"},
], "feed matches the review-inbox contract")
print("ok - first run seeds silently and writes the review-inbox feed")

check(run() == [], "an unchanged queue raises no banners")
queues["review"] = [pr(1, head_sha="b", reason="direct review request"), pr(3, head_sha="c", reason="assigned to you")]
titles = sorted(b["title"] for b in run())
check(titles == ["\U0001f504 PR activity: example-org/app#1", "\U0001f535 New PR: example-org/app#3"],
      f"new commit and new PR each raise one banner, got {titles}")
print("ok - banners fire only for new or changed PRs")

queues["reply"] = [pr(2, reply_state="approved", unaddressed=1)]
raised = run()
check(len(raised) == 1 and raised[0]["title"].startswith("\U0001f7e2 Your PR (update) — approved"),
      "an approval flip raises a green reply banner")
check(raised[0]["url"] == "https://github.com/example-org/app/pull/2", "banner click opens the PR")
print("ok - reply state changes are announced with their state")

good_feed = Path(os.environ["COWORKER_PRS_FILE"]).read_text()
queues["error"] = RuntimeError("GitHub API error 403")
check([b["title"] for b in run()] == ["⚠️ Review feed error"], "first failure raises one banner")
check(run() == [], "a continuing failure stays quiet")
check(Path(os.environ["COWORKER_PRS_FILE"]).read_text() == good_feed, "failure keeps the last good feed")
check("403" in (tmp / "state" / "error.log").read_text(), "failure is logged")
queues["error"] = None
check([b["title"] for b in run()] == ["✅ Review feed recovered"], "recovery raises one banner")
print("ok - failures are throttled and preserve the last good feed")

legacy = {"version": 2, "seeded": True, "failing": False, "prs": {
    "example-org/app#4": {"fp": "f0dfcbc976f542a7"},
    "example-org/app#5": {"fp": "adf1e7fa7981c098"},
}}
(tmp / "state" / "state.json").write_text(json.dumps(legacy))
queues["review"] = [pr(4, head_sha="abc", reason="direct review request")]
queues["reply"] = [pr(5, reply_state="commented", unaddressed=2)]
check(run() == [], "fingerprints carried over from the Hermes notifier do not re-alert")
print("ok - state from the previous notifier is compatible")

check(feed.first_meaningful_line("<!-- template -->\n## Summary\n- [ ] tested\n**Adds** the `feed`.") == "Adds the feed.",
      "description skips template boilerplate")
print("ok - PR descriptions skip template boilerplate")
