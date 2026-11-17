"""Constants shared by the helper, and the .env loader."""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# the page and its files, served as they are (read from disk on every request)
WEB = ROOT / "web"
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
REMOTE = "origin"
# branches that must never be the new branch (the page gets this pattern from /api/info)
PROTECTED = re.compile(r"^(master|main|release/.*|hotfix/.*)$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")
API_HEADER = "X-Branch-Merger"
# the repository folder of an API request, URI-encoded (a header value must be ASCII)
REPO_HEADER = "X-Branch-Merger-Repo"
GIT_TIMEOUT = 300
# conflict view: lines shown around each conflict, and at most this many lines per file
CONFLICT_CONTEXT = 3
CONFLICT_MAX_LINES = 2000
# the in-memory commits of a dry run need an identity, whatever the user's config says
DRY_RUN_IDENTITY = {
    "GIT_AUTHOR_NAME": "Branch Merger dry run",
    "GIT_AUTHOR_EMAIL": "dry-run@branch-merger.invalid",
    "GIT_COMMITTER_NAME": "Branch Merger dry run",
    "GIT_COMMITTER_EMAIL": "dry-run@branch-merger.invalid",
}
# Jira: fields shown in the panel, issues per page, request timeout, longest JQL accepted
JIRA_FIELDS = ["summary", "status", "assignee", "issuetype", "priority"]
JIRA_PAGE = 50
JIRA_TIMEOUT = 30
JQL_MAX = 10_000
JIRA_ENV = ("JIRA_URL", "JIRA_EMAIL", "JIRA_API_TOKEN")


def load_dotenv(path: Path) -> None:
    """KEY=VALUE lines of `path` into os.environ; variables already set win."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)
