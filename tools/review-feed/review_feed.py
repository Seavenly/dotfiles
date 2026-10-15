#!/usr/bin/env python3
"""Coworker PR feed for ``review-inbox``, with macOS banners on change.

One run collects two narrow GitHub queues for the authenticated user:

  * kind="review" - coworker PRs waiting on your review: assigned to you, a
    direct review request, the configured team requested, or a PR you already
    reviewed that has new activity since (GitHub drops you from
    ``requested_reviewers`` once you review, so it would otherwise vanish).
  * kind="reply"  - your open PRs with coworker feedback newer than your last
    commit or comment, plus approved PRs until they merge.

Outputs:
  1. ``COWORKER_PRS_FILE`` - JSONL read by ``review-inbox``, rewritten in full
     from the current open set, so merged/closed PRs drop out.
  2. ``queue.txt`` in the state directory - the human-readable queue.
  3. terminal-notifier banners for net-new or changed PRs only. Change is a
     per-PR fingerprint kept in ``state.json``.

The first run seeds state silently. Failures leave the last good feed in place
and raise one banner per failure streak, then one on recovery. The process
exits 0 either way so the scheduler stays quiet; the banner is the signal.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_VERSION = 2
ERROR_GROUP = "review-feed-error"
MAX_ITEMS = int(os.getenv("REVIEW_FEED_MAX_ITEMS", "50"))
HTTP_TIMEOUT = int(os.getenv("REVIEW_FEED_HTTP_TIMEOUT", "30"))
RETRIES = int(os.getenv("REVIEW_FEED_RETRIES", "3"))


def state_dir() -> Path:
    default = Path(os.getenv("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "dotfiles" / "review-feed"
    return Path(os.getenv("REVIEW_FEED_STATE_DIR", str(default)))


def feed_path() -> Path:
    default = Path(os.getenv("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "dotfiles" / "coworker-review-prs.jsonl"
    return Path(os.getenv("COWORKER_PRS_FILE", str(default)))


# --- GitHub client ----------------------------------------------------------
def github_token() -> str:
    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        if os.getenv(key):
            return os.environ[key]
    cmd = ["gh", "auth", "token"]
    if os.getenv("REVIEW_FEED_GITHUB_USER"):
        cmd += ["--user", os.environ["REVIEW_FEED_GITHUB_USER"]]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"no GitHub token: set GH_TOKEN or authenticate gh ({exc})") from exc
    token = result.stdout.strip()
    if not token:
        raise RuntimeError("no GitHub token: gh auth token returned nothing")
    return token


class GitHub:
    def __init__(self, token: str) -> None:
        self._token = token

    def request(self, url: str, *, method: str = "GET", body: bytes | None = None) -> Any:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dotfiles-review-feed",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, headers=headers, method=method, data=body)
        last_exc: BaseException | None = None
        for attempt in range(1, RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    data = resp.read().decode("utf-8")
                    return json.loads(data) if data else None
            except urllib.error.HTTPError as exc:
                text = exc.read().decode("utf-8", "replace")
                if exc.code not in {403, 408, 409, 425, 429, 500, 502, 503, 504} or attempt == RETRIES:
                    raise RuntimeError(f"GitHub API error {exc.code} for {url}: {text[:500]}") from exc
                last_exc = exc
            except (TimeoutError, http.client.IncompleteRead, http.client.RemoteDisconnected, urllib.error.URLError) as exc:
                last_exc = exc
                if attempt == RETRIES:
                    raise RuntimeError(f"GitHub API read/network error for {url}: {exc}") from exc
            time.sleep(min(2 ** (attempt - 1), 8))
        raise RuntimeError(f"GitHub API failed for {url}: {last_exc}")

    def rest(self, path: str, params: dict[str, str] | None = None) -> Any:
        if params:
            path += ("&" if "?" in path else "?") + urllib.parse.urlencode(params)
        return self.request("https://api.github.com" + path)

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        data = self.request("https://api.github.com/graphql", method="POST", body=payload)
        if data and data.get("errors"):
            raise RuntimeError(f"GitHub GraphQL error: {json.dumps(data['errors'])[:500]}")
        return data.get("data") if data else None


@dataclass
class PR:
    owner: str
    repo: str
    number: int
    title: str
    url: str
    updated_at: str
    node_id: str | None = None
    head_sha: str | None = None
    description: str = ""
    reason: str = ""
    # Re-review PRs: opaque key for the latest activity since your review.
    activity_key: str = ""
    # Reply PRs: approved / changes_requested / commented, and how many
    # coworker interactions are newer than your last activity.
    reply_state: str = ""
    unaddressed: int = 0

    @property
    def key(self) -> str:
        return f"{self.owner}/{self.repo}#{self.number}"


def search_prs(gh: GitHub, query: str, limit: int = MAX_ITEMS) -> list[PR]:
    items: list[PR] = []
    per_page = min(100, limit)
    page = 1
    while len(items) < limit:
        data = gh.rest("/search/issues", {
            "q": query, "sort": "updated", "order": "desc",
            "per_page": str(per_page), "page": str(page),
        })
        batch = data.get("items", [])
        for item in batch[: limit - len(items)]:
            owner, repo = item["repository_url"].rsplit("/", 2)[-2:]
            items.append(PR(
                owner=owner,
                repo=repo,
                number=int(item["number"]),
                title=item.get("title", ""),
                url=item.get("html_url", ""),
                updated_at=item.get("updated_at", ""),
                node_id=item.get("node_id"),
            ))
        if len(batch) < per_page:
            break
        page += 1
    return items


def load_detail(gh: GitHub, pr: PR) -> dict[str, Any]:
    detail = gh.rest(f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}")
    pr.node_id = pr.node_id or detail.get("node_id")
    pr.head_sha = (detail.get("head") or {}).get("sha")
    pr.description = first_meaningful_line(detail.get("body"))
    return detail


def iso_to_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_HEADING_RE = re.compile(r"^#{1,6}\s")
_HR_RE = re.compile(r"^([-*_])\1{2,}$")
_CHECKBOX_ITEM_RE = re.compile(r"^[-*+]?\s*\[[ xX]?\]")
_LIST_MARKER_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_EMPHASIS_RE = re.compile(r"\*\*|__|`")


def first_meaningful_line(body: str | None, max_len: int = 140) -> str:
    """First prose line of a PR body, skipping template headings and checklists."""
    if not body:
        return ""
    for raw in _HTML_COMMENT_RE.sub("", body).splitlines():
        line = raw.strip()
        if not line or _HEADING_RE.match(line) or _HR_RE.match(line) or _CHECKBOX_ITEM_RE.match(line):
            continue
        line = _EMPHASIS_RE.sub("", _LIST_MARKER_RE.sub("", line)).strip()
        if len(re.sub(r"[^0-9A-Za-z]", "", line)) < 3:
            continue
        if len(line) > max_len:
            line = line[: max_len - 1].rstrip() + "…"
        return line
    return ""


# --- Queues -----------------------------------------------------------------
_ACTIVITY_QUERY = """
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewDecision
      commits(last: 100) { nodes { commit { committedDate author { user { login } } } } }
      reviews(first: 100) { nodes { author { login } submittedAt } }
      comments(first: 100) { nodes { author { login } createdAt } }
      reviewThreads(first: 50) { nodes { comments(first: 100) { nodes { author { login } createdAt } } } }
    }
  }
}
"""


def _login(node: dict) -> str | None:
    return (node.get("author") or {}).get("login")


def _activity(gh: GitHub, pr: PR) -> dict:
    node = (gh.graphql(_ACTIVITY_QUERY, {"id": pr.node_id}) or {}).get("node") or {}
    node["_thread_comments"] = [
        c for t in (node.get("reviewThreads") or {}).get("nodes") or []
        for c in (t.get("comments") or {}).get("nodes") or []
    ]
    return node


def _nodes(node: dict, name: str) -> list[dict]:
    return (node.get(name) or {}).get("nodes") or []


def requested_prs(gh: GitHub, viewer: str, team: str) -> list[PR]:
    """PRs assigned to you, or with you or your team requested as reviewer.

    Drafts and already-approved PRs are excluded: neither needs your review.
    """
    team_slug = team.rsplit("/", 1)[-1] if team else ""
    base = f"is:pr is:open draft:false archived:false -review:approved -author:{viewer}"
    queries = [f"{base} assignee:{viewer}", f"{base} review-requested:{viewer}"]
    if team:
        queries.append(f"{base} team-review-requested:{team}")

    found: dict[str, PR] = {}
    for query in queries:
        for pr in search_prs(gh, query):
            detail = load_detail(gh, pr)
            assignees = {u.get("login") for u in detail.get("assignees") or []}
            reviewers = {u.get("login") for u in detail.get("requested_reviewers") or []}
            team_requested = any(
                t.get("slug") == team_slug
                or t.get("name") == team_slug
                or (t.get("html_url") or "").endswith("/" + team_slug)
                for t in detail.get("requested_teams") or []
            ) if team_slug else False

            reasons: list[str] = []
            if viewer in assignees:
                reasons.append("assigned to you")
            if viewer in reviewers:
                reasons.append("direct review request")
            if team_requested:
                reasons.append(f"team review request: {team}")
            if not reasons:
                continue

            existing = found.get(pr.key)
            if existing:
                for part in reasons:
                    if part not in existing.reason:
                        existing.reason += f"; {part}"
            else:
                pr.reason = "; ".join(reasons)
                found[pr.key] = pr
    return sorted(found.values(), key=lambda p: p.updated_at, reverse=True)


def rereview_prs(gh: GitHub, viewer: str, org: str, already: set[str]) -> list[PR]:
    """Coworker PRs you reviewed that have a new commit or coworker comment since."""
    query = (
        f"is:pr is:open draft:false archived:false -review:approved "
        f"reviewed-by:{viewer} -author:{viewer} org:{org}"
    )
    out: list[PR] = []
    for pr in search_prs(gh, query):
        if pr.key in already:
            continue
        load_detail(gh, pr)
        node = _activity(gh, pr)

        my_reviews = [
            iso_to_dt(r.get("submittedAt")) for r in _nodes(node, "reviews")
            if _login(r) == viewer and r.get("submittedAt")
        ]
        if not my_reviews:
            continue
        last_review = max(my_reviews)

        commits = _nodes(node, "commits")
        head_committed = iso_to_dt((commits[-1].get("commit") or {}).get("committedDate")) if commits else None
        new_commit = bool(head_committed and head_committed > last_review)

        def after(nodes: list[dict], ts_key: str) -> bool:
            return any(
                _login(n) not in (None, viewer) and (ts := iso_to_dt(n.get(ts_key))) and ts > last_review
                for n in nodes
            )

        new_comment = (
            after(_nodes(node, "reviews"), "submittedAt")
            or after(_nodes(node, "comments"), "createdAt")
            or after(node["_thread_comments"], "createdAt")
        )
        if not (new_commit or new_comment):
            continue

        commit_ts = head_committed.isoformat() if head_committed else ""
        pr.reason = "you reviewed; new activity since your review"
        pr.activity_key = f"{pr.head_sha or ''}|{commit_ts}|{new_commit}|{new_comment}"
        out.append(pr)
    return sorted(out, key=lambda p: p.updated_at, reverse=True)


def authored_prs_with_feedback(gh: GitHub, viewer: str, org: str) -> list[PR]:
    """Your open, non-draft PRs with coworker feedback you have not answered.

    Unanswered means a coworker review or comment newer than your last commit,
    review, or comment. Approved PRs stay until merged regardless.
    """
    query = f"is:pr is:open draft:false archived:false author:{viewer} org:{org}"
    out: list[PR] = []
    for pr in search_prs(gh, query):
        load_detail(gh, pr)
        node = _activity(gh, pr)
        reviews = _nodes(node, "reviews")
        discussion = _nodes(node, "comments") + node["_thread_comments"]

        my_times = [
            ts for c in _nodes(node, "commits")
            if (((c.get("commit") or {}).get("author") or {}).get("user") or {}).get("login") == viewer
            and (ts := iso_to_dt((c.get("commit") or {}).get("committedDate")))
        ]
        my_times += [ts for r in reviews if _login(r) == viewer and (ts := iso_to_dt(r.get("submittedAt")))]
        my_times += [ts for c in discussion if _login(c) == viewer and (ts := iso_to_dt(c.get("createdAt")))]
        my_last = max(my_times) if my_times else None

        def others_after(nodes: list[dict], ts_key: str) -> int:
            return sum(
                1 for n in nodes
                if _login(n) not in (None, viewer)
                and (ts := iso_to_dt(n.get(ts_key)))
                and (my_last is None or ts > my_last)
            )

        unaddressed = others_after(reviews, "submittedAt") + others_after(discussion, "createdAt")
        state = {
            "APPROVED": "approved",
            "CHANGES_REQUESTED": "changes_requested",
        }.get(node.get("reviewDecision") or "", "commented")
        if state != "approved" and unaddressed == 0:
            continue
        pr.reply_state = state
        pr.unaddressed = unaddressed
        out.append(pr)
    return sorted(out, key=lambda p: p.updated_at, reverse=True)


def collect(gh: GitHub, org: str, team: str) -> tuple[str, list[PR], list[PR]]:
    viewer = gh.rest("/user")["login"]
    review = requested_prs(gh, viewer, team)
    review += rereview_prs(gh, viewer, org, {pr.key for pr in review})
    reply = authored_prs_with_feedback(gh, viewer, org)
    return viewer, review, reply


# --- Change detection -------------------------------------------------------
def _digest(basis: str) -> str:
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def current_entries(review: list[PR], reply: list[PR]) -> dict[str, dict]:
    """Per-PR state with a fingerprint that changes when a PR deserves a new banner.

    Review PRs change on a new head commit, a new request reason, or new
    activity since your review. Reply PRs change on a state flip or a change in
    the count of unanswered coworker interactions.
    """
    entries: dict[str, dict] = {}
    for pr in review:
        basis = pr.activity_key or f"{pr.head_sha or ''}|{pr.reason or ''}"
        entries[pr.key] = {
            "fp": _digest(basis), "kind": "review", "url": pr.url, "title": pr.title,
            "reason": pr.reason, "description": pr.description,
        }
    for pr in reply:
        entries[pr.key] = {
            "fp": _digest(f"{pr.reply_state}|{pr.unaddressed}|0"), "kind": "reply",
            "state": pr.reply_state, "url": pr.url, "title": pr.title,
            "description": pr.description,
        }
    return entries


def banner_for(key: str, info: dict, is_new: bool) -> dict:
    if info["kind"] == "review":
        prefix = "\U0001f535 New PR" if is_new else "\U0001f504 PR activity"
        title = f"{prefix}: {key}"
        body = [info.get("reason") or "", info.get("description") or ""]
    else:
        state = info.get("state", "commented")
        # The icon encodes state, never new-vs-changed, so its color is reliable.
        icon = {"changes_requested": "\U0001f7e0", "approved": "\U0001f7e2"}.get(state, "\U0001f535")
        verb = {"approved": "approved", "changes_requested": "changes requested"}.get(state, "new activity")
        noun = "Your PR" if is_new else "Your PR (update)"
        title = f"{icon} {noun} — {verb}: {key}"
        body = [f"state: {state}", info.get("description") or ""]
    return {
        "title": title,
        "subtitle": (info.get("title") or "")[:120],
        "message": "\n".join(part for part in body if part)[:300],
        "group": "review-feed-" + re.sub(r"[/#]", "-", key),
        "url": info.get("url") or "",
    }


def reconcile(prev: dict, entries: dict[str, dict], now: str) -> tuple[dict, list[dict]]:
    """Next state plus the banners to raise. The first run seeds silently."""
    banners: list[dict] = []
    if prev.get("failing"):
        banners.append({
            "title": "✅ Review feed recovered", "subtitle": "",
            "message": "The GitHub review feed is healthy again.", "group": ERROR_GROUP, "url": "",
        })
    if prev.get("seeded"):
        prev_prs = prev.get("prs", {})
        for key, info in entries.items():
            old = prev_prs.get(key)
            if old is None or old.get("fp") != info["fp"]:
                banners.append(banner_for(key, info, is_new=old is None))
    state = {"version": STATE_VERSION, "seeded": True, "failing": False, "updated_at": now, "prs": entries}
    return state, banners


# --- Outputs ----------------------------------------------------------------
def notify(banner: dict) -> None:
    binary = shutil.which("terminal-notifier") or next(
        (p for p in ("/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier") if Path(p).exists()),
        None,
    )
    if not binary:
        return
    cmd = [binary, "-title", banner["title"], "-message", banner["message"] or " ",
           "-group", banner["group"], "-sound", "Ping"]
    if banner.get("subtitle"):
        cmd += ["-subtitle", banner["subtitle"]]
    if banner.get("url"):
        cmd += ["-open", banner["url"]]
    try:
        subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


def load_state() -> dict:
    try:
        return json.loads((state_dir() / "state.json").read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    write_atomic(state_dir() / "state.json", json.dumps(state, indent=2) + "\n")


def feed_lines(review: list[PR], reply: list[PR]) -> str:
    """The ``review-inbox`` contract: one JSON object per open PR."""
    lines = [json.dumps({"repo": f"{pr.owner}/{pr.repo}", "number": pr.number, "title": pr.title,
                         "url": pr.url, "kind": "review"}) for pr in review]
    lines += [json.dumps({"repo": f"{pr.owner}/{pr.repo}", "number": pr.number, "title": pr.title,
                          "url": pr.url, "kind": "reply", "state": pr.reply_state or "commented"})
              for pr in reply]
    return "".join(line + "\n" for line in lines)


def queue_text(review: list[PR], reply: list[PR], now: datetime) -> str:
    stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    total = len(review) + len(reply)
    if total == 0:
        return f"GitHub review queue - no PRs need your attention ({stamp})\n"
    lines = [f"GitHub review queue - {total} PR(s) needing attention ({stamp})", ""]
    if review:
        lines += [f"Awaiting your review - {len(review)} PR(s)", ""]
        for i, pr in enumerate(review, 1):
            lines.append(f"{i}. {pr.key}: {pr.title}")
            if pr.description:
                lines.append(f"   {pr.description}")
            lines += [f"   Reason: {pr.reason}", f"   Updated: {pr.updated_at}", f"   {pr.url}", ""]
    if reply:
        lines += [f"Your PRs with coworker interaction - {len(reply)} PR(s)", ""]
        for i, pr in enumerate(reply, 1):
            lines.append(f"{i}. {pr.key}: {pr.title}  [{pr.reply_state}]")
            if pr.description:
                lines.append(f"   {pr.description}")
            lines += [f"   Updated: {pr.updated_at}", f"   {pr.url}", ""]
    return "\n".join(lines).rstrip() + "\n"


def record_failure(exc: BaseException) -> None:
    """Log the failure and raise one banner per failure streak.

    The feed and queue files are left alone so readers keep the last good view.
    """
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "error.log").write_text(
        f"{datetime.now(timezone.utc).isoformat()}\n"
        + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    )
    state = load_state()
    if not state.get("failing"):
        notify({
            "title": "⚠️ Review feed error", "subtitle": "GitHub review feed failed",
            "message": f"{type(exc).__name__}: {str(exc)[:180]}", "group": ERROR_GROUP, "url": "",
        })
    state["failing"] = True
    state.setdefault("version", STATE_VERSION)
    save_state(state)


def main(argv: list[str]) -> int:
    show = "--print" in argv
    org = os.getenv("REVIEW_FEED_ORG", "")
    team = os.getenv("REVIEW_FEED_TEAM", "")
    try:
        if not org:
            raise RuntimeError("REVIEW_FEED_ORG is not configured")
        _, review, reply = collect(GitHub(github_token()), org, team)
    except Exception as exc:  # network, auth, or API failure
        record_failure(exc)
        if show:
            print(f"review-feed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        return 0

    now = datetime.now(timezone.utc)
    text = queue_text(review, reply, now)
    write_atomic(state_dir() / "queue.txt", text)
    write_atomic(feed_path(), feed_lines(review, reply))
    state, banners = reconcile(load_state(), current_entries(review, reply), now.isoformat())
    for banner in banners:
        notify(banner)
    save_state(state)
    if show:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
