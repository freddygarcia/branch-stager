#!/usr/bin/env python3
"""
Local helper for Branch Merger: serves branch-merger.html and lets it list and merge the
branches of your local clone with git, local branches included.

    python3 main.py [--port 8765] [--repo PATH]

then open http://127.0.0.1:8765 (opened as a file, the page only talks to GitHub) and enter
the folder of your clone in Settings. Every API request names the repository folder in the
X-Branch-Merger-Repo header; --repo only pre-fills that field.

Apply cuts the new branch from the base and merges every selected branch into it, in order,
inside a temporary git worktree: your working copy, current branch and uncommitted changes
are never touched, and a conflict is aborted and reported instead of left behind. Merges
are --no-ff unless the request asks for ff (fast-forward when possible). The new branch is
only created locally unless the request asks to push it.

Only listens on 127.0.0.1. API requests must carry the X-Branch-Merger header and come
from this server's own origin, so other web pages open in the browser cannot call it.

Jira panel: fill in Settings > Jira on the page. Each Jira request carries those settings
and the helper calls Jira with them (a browser page cannot call Jira itself). When they
are empty, the helper uses JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN from its environment,
or from a .env file next to this script (see .env.example).
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse, urlsplit

HERE = Path(__file__).resolve().parent
PAGE = HERE / "branch-merger.html"
REMOTE = "origin"
# branches that must never be the new branch (same rule as the page)
PROTECTED = re.compile(r"^(master|main|staging|development|release/.*|hotfix/.*)$")
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
# fetch and apply change refs; run them one at a time
WRITE_LOCK = threading.Lock()
# Jira: fields shown in the panel, issues per page, request timeout, longest JQL accepted
JIRA_FIELDS = ["summary", "status", "assignee", "issuetype", "priority"]
JIRA_PAGE = 50
JIRA_TIMEOUT = 30
JQL_MAX = 10_000
JIRA_ENV = ("JIRA_URL", "JIRA_EMAIL", "JIRA_API_TOKEN")


class GitError(Exception):
    pass


def repo_top(path: str) -> Path:
    """Top folder of the git repository that contains `path` (`~` expanded)."""
    folder = Path(path).expanduser()
    if not folder.is_absolute():
        msg = f"Enter an absolute path: {path}"
        raise GitError(msg)
    if not folder.is_dir():
        msg = f"No such folder: {folder}"
        raise GitError(msg)
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],  # noqa: S607
        cwd=folder,
        capture_output=True,
        text=True,
        check=False,
        timeout=GIT_TIMEOUT,
    )
    if result.returncode != 0:
        msg = f"Not a git repository: {folder}"
        raise GitError(msg)
    return Path(result.stdout.strip())


class JiraError(Exception):
    pass


def jira_site(url: str) -> str:
    """https://host of a Jira site URL; any path pasted with it is dropped."""
    parts = urlsplit(url.strip())
    if parts.scheme != "https" or not parts.hostname or "@" in parts.netloc:
        msg = f"The Jira site must be an https:// URL, e.g. https://your-site.atlassian.net: {url}"
        raise JiraError(msg)
    return f"https://{parts.netloc}"


class Jira:
    """Read-only Jira Cloud REST client: saved filters and JQL search."""

    def __init__(self, url: str, email: str, token: str):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()

    def call(self, path: str, body: dict | None = None):
        request = urllib.request.Request(  # noqa: S310 - https URL checked at startup
            self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            method="GET" if body is None else "POST",
            headers={
                "Authorization": self.auth,
                "Accept": "application/json",
                **({} if body is None else {"Content-Type": "application/json"}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=JIRA_TIMEOUT) as res:  # noqa: S310
                return json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            raise JiraError(self._message(e)) from None
        except (urllib.error.URLError, TimeoutError) as e:
            msg = f"Could not reach Jira: {getattr(e, 'reason', e)}"
            raise JiraError(msg) from None

    @staticmethod
    def _message(e: urllib.error.HTTPError) -> str:
        if e.code in {401, 403}:
            return (
                f"Jira refused the request ({e.code}): check the Jira email and API token."
            )
        try:
            data = json.loads(e.read() or b"{}")
        except ValueError:
            data = {}
        parts = [*data.get("errorMessages", []), *data.get("errors", {}).values()]
        return f"Jira error {e.code}: {' '.join(map(str, parts)) or e.reason}"

    def filters(self) -> list[dict]:
        """Starred filters, then the user's own, each once; favourites first."""
        found: dict[str, dict] = {}
        for path, starred in (
            ("/rest/api/3/filter/favourite", True),
            ("/rest/api/3/filter/my", False),
        ):
            for f in self.call(path) or []:
                found.setdefault(
                    str(f["id"]),
                    {
                        "id": str(f["id"]),
                        "name": f.get("name", ""),
                        "jql": f.get("jql", ""),
                        "favourite": starred or bool(f.get("favourite")),
                    },
                )
        return sorted(
            found.values(), key=lambda f: (not f["favourite"], f["name"].lower())
        )

    def search(self, jql: str, page_token: str | None = None) -> dict:
        body: dict = {"jql": jql, "maxResults": JIRA_PAGE, "fields": JIRA_FIELDS}
        if page_token:
            body["nextPageToken"] = page_token
        data = self.call("/rest/api/3/search/jql", body) or {}
        issues = []
        for issue in data.get("issues", []):
            fields = issue.get("fields") or {}
            status = fields.get("status") or {}
            issues.append(
                {
                    "key": issue["key"],
                    "summary": fields.get("summary") or "",
                    "status": status.get("name", ""),
                    # new / indeterminate / done
                    "category": (status.get("statusCategory") or {}).get("key", ""),
                    "type": (fields.get("issuetype") or {}).get("name", ""),
                    "assignee": (fields.get("assignee") or {}).get("displayName", ""),
                    "priority": (fields.get("priority") or {}).get("name", ""),
                }
            )
        return {
            "issues": issues,
            "next": None if data.get("isLast", True) else data.get("nextPageToken"),
            "url": self.url,
        }


def conflict_kinds(lines: list[str]) -> list[str]:
    """Kind of each line of a file with diff3 conflict markers (see `conflict_hunks`)."""
    kinds: list[str] = []
    region = None
    for text in lines:
        if text.startswith("<<<<<<<"):
            kind, region = "m-ours", "ours"
        elif region and text.startswith("|||||||"):
            kind, region = "m-base", "base"
        elif region and text.rstrip() == "=======":
            kind, region = "m-sep", "theirs"
        elif region and text.startswith(">>>>>>>"):
            kind, region = "m-theirs", None
        else:
            kind = region or "ctx"
        kinds.append(kind)
    return kinds


def conflict_ranges(kinds: list[str]) -> list[list[int]]:
    """[first, last] line indexes of each conflict plus its context, overlaps joined."""
    ranges: list[list[int]] = []
    for i, kind in enumerate(kinds):
        if kind == "ctx":
            continue
        lo = max(i - CONFLICT_CONTEXT, 0)
        hi = min(i + CONFLICT_CONTEXT, len(kinds) - 1)
        if ranges and lo <= ranges[-1][1] + 1:
            ranges[-1][1] = max(ranges[-1][1], hi)
        else:
            ranges.append([lo, hi])
    return ranges


class Repo:
    def __init__(self, path: Path):
        self.path = path

    def run(
        self,
        *args: str,
        cwd: Path | None = None,
        check: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess:
        result = subprocess.run(  # noqa: S603 - fixed git binary, arguments passed as a list
            ["git", *args],  # noqa: S607
            cwd=cwd or self.path,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
            check=False,
            # never wait for a credentials prompt nobody can see: fail instead
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})},
            # file contents (conflict view) need not be valid UTF-8
            errors="replace",
        )
        if check and result.returncode != 0:
            raise GitError(
                (result.stderr or result.stdout).strip() or f"git {args[0]} failed"
            )
        return result

    def out(
        self, *args: str, cwd: Path | None = None, env: dict[str, str] | None = None
    ) -> str:
        return self.run(*args, cwd=cwd, env=env).stdout.strip()

    def resolve(self, name: str) -> str:
        """Commit sha of a branch listed by `branches()`: `x` (local) or `origin/x`."""
        ref = (
            f"refs/remotes/{name}"
            if name.startswith(f"{REMOTE}/")
            else f"refs/heads/{name}"
        )
        result = self.run(
            "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False
        )
        if result.returncode != 0:
            msg = f"No such branch: {name}"
            raise GitError(msg)
        return result.stdout.strip()

    def counts(self, left: str, right: str) -> tuple[int, int]:
        """(commits only in `right`, commits only in `left`), i.e. (ahead, behind) of right."""
        behind, ahead = self.out(
            "rev-list", "--left-right", "--count", f"{left}...{right}"
        ).split()
        return int(ahead), int(behind)

    def branches(self) -> list[dict]:
        """
        Local branches and the remote's branches. A remote branch with a local branch of the
        same name is `shadowed`: the page lists the local one (with how it compares to the
        remote) and offers the remote one only as a base.
        """
        lines = self.out(
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/heads",
            f"refs/remotes/{REMOTE}",
        ).splitlines()
        local: dict[str, str] = {}
        remote: dict[str, str] = {}
        for line in lines:
            ref, sha = line.split("\0")
            if ref.startswith("refs/heads/"):
                local[ref.removeprefix("refs/heads/")] = sha
            elif ref != f"refs/remotes/{REMOTE}/HEAD":
                remote[ref.removeprefix(f"refs/remotes/{REMOTE}/")] = sha

        items = []
        for name, sha in local.items():
            on_remote = None
            if name in remote:
                ahead, behind = (
                    (0, 0) if remote[name] == sha else self.counts(remote[name], sha)
                )
                on_remote = {"sha": remote[name], "ahead": ahead, "behind": behind}
            items.append(
                {
                    "name": name,
                    "sha": sha,
                    "kind": "local",
                    "remote": on_remote,
                    "shadowed": False,
                }
            )
        for name, sha in remote.items():
            items.append(
                {
                    "name": f"{REMOTE}/{name}",
                    "sha": sha,
                    "kind": "remote",
                    "remote": None,
                    "shadowed": name in local,
                }
            )
        return sorted(items, key=lambda item: item["name"])

    def check_new_branch_name(self, name: str) -> None:
        if self.run("check-ref-format", "--branch", name, check=False).returncode != 0:
            msg = f'"{name}" is not a valid branch name.'
            raise GitError(msg)
        if PROTECTED.match(name):
            msg = f'"{name}" is a protected branch name. Pick another one.'
            raise GitError(msg)
        if (
            self.run(
                "show-ref", "--verify", "--quiet", f"refs/heads/{name}", check=False
            ).returncode
            == 0
        ):
            msg = f'"{name}" already exists. Pick a new name.'
            raise GitError(msg)

    def dry_run(self, base: str, heads: list[str]) -> list[dict]:
        """
        Merge `heads` into `base` in order, in memory only (`git merge-tree`): no worktree,
        branch or ref is touched. Each clean merge is chained through an unreferenced commit
        (removed by git gc) so the next branch is checked against everything merged before
        it, like Apply. A conflicting branch is left out of the chain: the branches after it
        are checked as if it had been removed (Apply itself would stop there).
        """
        current = self.resolve(base)
        results: list[dict] = []
        for head in heads:
            try:
                sha = self.resolve(head)
            except GitError as e:
                results.append({"head": head, "status": "error", "message": str(e)})
                continue
            ancestor = self.run(
                "merge-base", "--is-ancestor", sha, current, check=False
            )
            if ancestor.returncode == 0:
                results.append({"head": head, "status": "contained"})
                continue
            # diff3 markers: the conflict view also shows what the common ancestor had
            merge = self.run(
                "-c",
                "core.quotePath=false",
                "-c",
                "merge.conflictStyle=diff3",
                "merge-tree",
                "--write-tree",
                "--name-only",
                current,
                sha,
                check=False,
            )
            # tree, conflicted files, a blank line, then the "Auto-merging"/"CONFLICT" messages
            files_part, _, messages_part = merge.stdout.partition("\n\n")
            lines = files_part.splitlines()
            if merge.returncode == 0:
                current = self.out(
                    "commit-tree",
                    lines[0],
                    "-p",
                    current,
                    "-p",
                    sha,
                    "-m",
                    f"Branch Merger dry run: merge {head}",
                    env=DRY_RUN_IDENTITY,
                )
                results.append({"head": head, "status": "clean"})
            elif merge.returncode == 1:
                files = list(dict.fromkeys(line for line in lines[1:] if line))
                conflicts = [
                    m for m in messages_part.splitlines() if m.startswith("CONFLICT")
                ]
                notes = {
                    path: [
                        m
                        for m in conflicts
                        if re.search(rf"(?<![\w/.-]){re.escape(path)}(?![\w/-])", m)
                    ]
                    for path in files
                }
                # the merged tree (markers included) stays readable until git gc
                results.append(
                    {
                        "head": head,
                        "status": "conflict",
                        "files": files,
                        "tree": lines[0],
                        "notes": notes,
                    }
                )
            else:
                message = (
                    merge.stderr or merge.stdout
                ).strip() or "git merge-tree failed"
                results.append({"head": head, "status": "error", "message": message})
        return results

    def conflict_hunks(self, tree: str, path: str) -> dict:
        """
        The conflicted regions of `path` in a dry-run merge `tree` (diff3 markers), each with
        CONFLICT_CONTEXT lines around it, as [line number, kind, text] rows. Kinds: ctx,
        ours, base, theirs, and m-ours/m-base/m-sep/m-theirs for the marker lines.
        """
        blob = self.run("cat-file", "-p", f"{tree}:{path}", check=False)
        if blob.returncode != 0:  # e.g. modify/delete: the path is not in the result
            return {"missing": True, "binary": False, "hunks": [], "truncated": False}
        if "\0" in blob.stdout:
            return {"missing": False, "binary": True, "hunks": [], "truncated": False}

        lines = blob.stdout.splitlines()
        kinds = conflict_kinds(lines)
        hunks, total, truncated = [], 0, False
        for lo, end in conflict_ranges(kinds):
            hi = min(end, lo + CONFLICT_MAX_LINES - total - 1)
            if hi < end or total >= CONFLICT_MAX_LINES:
                truncated = True
            if hi < lo:
                break
            hunks.append([[i + 1, kinds[i], lines[i]] for i in range(lo, hi + 1)])
            total += hi - lo + 1
        return {
            "missing": False,
            "binary": False,
            "hunks": hunks,
            "truncated": truncated,
        }

    def push_new_branch(self, name: str) -> tuple[bool, str]:
        """Push a branch this helper just created to the remote and track it."""
        if PROTECTED.match(
            name
        ):  # never reached: such names are refused before merging
            return False, f"{name} is protected, not pushed"
        result = self.run(
            "push", "--set-upstream", REMOTE, f"{name}:refs/heads/{name}", check=False
        )
        if result.returncode != 0:
            return False, (result.stderr or result.stdout).strip() or "git push failed"
        return True, f"Pushed {name} to {REMOTE}"

    def merge_into_new_branch(
        self,
        name: str,
        base: str,
        heads: list[str],
        *,
        delete_on_fail: bool,
        ff: bool = False,
    ) -> dict:
        """
        Cut `name` from `base` and merge `heads` into it in order, in a temporary worktree.
        With `ff`, a branch that is ahead of the new branch is fast-forwarded instead of
        getting a merge commit (git merge --ff); otherwise every merge is --no-ff.
        Returns {ok, result, log, created}; a conflict aborts that merge and stops there.
        """
        self.check_new_branch_name(name)
        base_sha = self.resolve(base)
        head_shas = [(head, self.resolve(head)) for head in heads]
        run = MergeRun(self, name, base, ff=ff)
        run.say(f"Base {base}")
        run.say(f"  at {base_sha[:8]}", "muted")
        run.say(
            "Merge mode: --ff (fast-forward when possible)"
            if ff
            else "Merge mode: --no-ff (always a merge commit)",
            "muted",
        )

        worktree = Path(tempfile.mkdtemp(prefix="branch-merger-"))
        created = False
        try:
            self.run("worktree", "add", "--quiet", "-b", name, str(worktree), base_sha)
            created = True
            run.say(f"Created {name} (local)", "ok")
            failed = next(
                (head for head, sha in head_shas if not run.merge(worktree, head, sha)),
                None,
            )
            if failed is None:
                return run.done()
            if delete_on_fail:
                self._remove_worktree(worktree)
                self.run("branch", "-D", name, check=False)
                created = False
                run.say(f"Deleted {name}", "warn")
            else:
                run.say(f"{name} kept (local) with the merges before {failed}", "warn")
            return run.failed(failed, created=created)
        except Exception:
            if created and delete_on_fail:
                self._remove_worktree(worktree)
                self.run("branch", "-D", name, check=False)
            raise
        finally:
            self._remove_worktree(worktree)

    def _remove_worktree(self, worktree: Path) -> None:
        self.run("worktree", "remove", "--force", str(worktree), check=False)
        shutil.rmtree(worktree, ignore_errors=True)
        self.run("worktree", "prune", check=False)


class MergeRun:
    """The log and counters of one apply."""

    def __init__(self, repo: Repo, name: str, base: str, *, ff: bool = False):
        self.repo = repo
        self.name = name
        self.ff = ff
        self.merged_heads = [base]
        self.log: list[dict] = []
        self.merged = 0
        self.fast_forwarded = 0
        self.up_to_date = 0
        self.conflicted = False

    def say(self, text: str, cls: str = "") -> None:
        self.log.append({"text": text, "cls": cls})

    def merge(self, worktree: Path, head: str, sha: str) -> bool:
        """Merge one branch; False (merge aborted, reason logged) if it could not."""
        repo = self.repo
        if (
            repo.run(
                "merge-base", "--is-ancestor", sha, "HEAD", cwd=worktree, check=False
            ).returncode
            == 0
        ):
            self.up_to_date += 1
            self.say(f"  = {head}  already contained, nothing to merge", "muted")
            return True
        fast_forward = (
            self.ff
            and repo.run(
                "merge-base", "--is-ancestor", "HEAD", sha, cwd=worktree, check=False
            ).returncode
            == 0
        )
        # --no-verify: like the GitHub API merge, no local hooks run on the merge commit
        message = f"Merge branch '{head}' into {self.name}"
        result = repo.run(
            "merge",
            "--ff" if self.ff else "--no-ff",
            "--no-verify",
            "-m",
            message,
            sha,
            cwd=worktree,
            check=False,
        )
        if result.returncode == 0:
            self.merged += 1
            self.fast_forwarded += fast_forward
            self.merged_heads.append(head)
            short = repo.out("rev-parse", "--short=8", "HEAD", cwd=worktree)
            how = "  (fast-forward)" if fast_forward else ""
            self.say(f"  ✓ {head}  → {short}{how}", "ok")
            return True

        files = repo.out(
            "diff", "--name-only", "--diff-filter=U", cwd=worktree
        ).splitlines()
        repo.run("merge", "--abort", cwd=worktree, check=False)
        self.conflicted = bool(files)
        if files:
            with_what = " + ".join(self.merged_heads)
            self.say(
                f"  ✗ {head}  conflicts with {with_what} in {', '.join(files)}", "err"
            )
        else:
            self.say(
                f"  ✗ {head}  merge failed: {(result.stderr or result.stdout).strip()}",
                "err",
            )
        return False

    def done(self) -> dict:
        ff_note = (
            f" ({self.fast_forwarded} fast-forwarded)" if self.fast_forwarded else ""
        )
        self.say(
            f"Done: {self.merged} merged{ff_note}, {self.up_to_date} already contained.",
            "ok",
        )
        result = f"{self.merged} merged{ff_note}" + (
            f", {self.up_to_date} up to date" if self.up_to_date else ""
        )
        return {"ok": True, "result": result, "log": self.log, "created": True}

    def failed(self, head: str, *, created: bool) -> dict:
        outcome = f"Conflict: {head}" if self.conflicted else f"Merge failed: {head}"
        return {"ok": False, "result": outcome, "log": self.log, "created": created}


class Handler(BaseHTTPRequestHandler):
    default_repo: Path | None
    port: int
    jira: Jira | None = None

    def _jira(self, body: dict) -> Jira:
        """The Jira settings sent by the page, else the helper's environment."""
        given = body.get("jira") or {}
        if not isinstance(given, dict):
            msg = "jira must be an object"
            raise JiraError(msg)
        url, email, token = (
            str(given.get(k) or "").strip() for k in ("url", "email", "token")
        )
        if url or email or token:
            if not (url and email and token):
                msg = "Fill in the Jira site, email and API token in Settings."
                raise JiraError(msg)
            return Jira(jira_site(url), email, token)
        if self.jira is None:
            msg = "Jira is not set up: fill in Settings > Jira."
            raise JiraError(msg)
        return self.jira

    @property
    def repo(self) -> Repo:
        """The repository named by the request's REPO_HEADER."""
        path = unquote(self.headers.get(REPO_HEADER, "")).strip()
        if not path:
            msg = "Enter the repository folder in Settings."
            raise GitError(msg)
        return Repo(repo_top(path))

    def log_message(self, fmt: str, *args) -> None:  # quieter than the default
        sys.stderr.write(
            f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n"
        )

    # ------------------------------------------------------------------ guards

    def _own_origins(self) -> set[str]:
        return {f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"}

    def _allowed(self, api: bool) -> bool:
        # Host: stops DNS rebinding (a site resolving its own name to 127.0.0.1).
        if f"http://{self.headers.get('Host', '')}" not in self._own_origins():
            return False
        if not api:
            return True
        # A custom header can't be sent cross-origin without a CORS preflight, which this
        # server never approves; the Origin check covers browsers that send it anyway.
        origin = self.headers.get("Origin")
        return self.headers.get(API_HEADER) == "1" and (
            origin is None or origin in self._own_origins()
        )

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    # ------------------------------------------------------------------ routes

    def do_GET(self) -> None:
        url = urlparse(self.path)
        api = url.path.startswith("/api/")
        if not self._allowed(api):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
            return
        if url.path in {"/", "/branch-merger.html"}:
            self._send(HTTPStatus.OK, PAGE.read_bytes(), "text/html; charset=utf-8")
            return
        try:
            if url.path == "/api/info":
                default = str(self.default_repo) if self.default_repo else None
                self._json(HTTPStatus.OK, {"repo": default, "remote": REMOTE})
            elif url.path == "/api/branches":
                repo = self.repo
                self._json(
                    HTTPStatus.OK, {"repo": str(repo.path), "branches": repo.branches()}
                )
            elif url.path == "/api/compare":
                query = parse_qs(url.query)
                base, head = query.get("base", [""])[0], query.get("head", [""])[0]
                if not (SHA.match(base) and SHA.match(head)):
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "base and head must be commit shas"},
                    )
                    return
                ahead, behind = self.repo.counts(base, head)
                self._json(HTTPStatus.OK, {"ahead": ahead, "behind": behind})
            elif url.path == "/api/conflict":
                query = parse_qs(url.query)
                tree, path = query.get("tree", [""])[0], query.get("path", [""])[0]
                if not (SHA.match(tree) and path):
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "tree must be a sha and path is required"},
                    )
                    return
                self._json(HTTPStatus.OK, self.repo.conflict_hunks(tree, path))
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        except (GitError, JiraError) as e:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if not self._allowed(api=True):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return
        try:
            if url.path == "/api/fetch":
                with WRITE_LOCK:
                    self.repo.run("fetch", "--prune", "--quiet", REMOTE)
                self._json(HTTPStatus.OK, {"ok": True})
            elif url.path == "/api/dry-run":
                heads = body.get("branches")
                if not isinstance(heads, list) or not all(
                    isinstance(h, str) for h in heads
                ):
                    self._json(
                        HTTPStatus.BAD_REQUEST, {"error": "branches must be a list"}
                    )
                    return
                results = self.repo.dry_run(str(body.get("base", "")), heads)
                self._json(HTTPStatus.OK, {"results": results})
            elif url.path == "/api/apply":
                heads = body.get("branches")
                if (
                    not isinstance(heads, list)
                    or not heads
                    or not all(isinstance(h, str) for h in heads)
                ):
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "branches must be a non-empty list"},
                    )
                    return
                name = str(body.get("name", "")).strip()
                with WRITE_LOCK:
                    result = self.repo.merge_into_new_branch(
                        name,
                        str(body.get("base", "")),
                        heads,
                        delete_on_fail=bool(body.get("deleteOnFail", True)),
                        ff=body.get("ff") is True,
                    )
                    # Only a branch whose merges all succeeded is pushed, and only on request.
                    result["pushed"] = False
                    if result["ok"] and body.get("push") is True:
                        pushed, message = self.repo.push_new_branch(name)
                        result["pushed"] = pushed
                        result["log"].append(
                            {
                                "text": message
                                if pushed
                                else f"Push failed: {message}",
                                "cls": "ok" if pushed else "err",
                            }
                        )
                        result["result"] += ", pushed" if pushed else ", push failed"
                self._json(HTTPStatus.OK, result)
            elif url.path == "/api/jira/filters":
                jira = self._jira(body)
                self._json(HTTPStatus.OK, {"filters": jira.filters(), "url": jira.url})
            elif url.path == "/api/jira/search":
                jql, page_token = body.get("jql"), body.get("next")
                if not isinstance(jql, str) or not jql.strip() or len(jql) > JQL_MAX:
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": f"jql must be a non-empty string under {JQL_MAX} characters"},
                    )
                    return
                if page_token is not None and not isinstance(page_token, str):
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "next must be a string"})
                    return
                self._json(HTTPStatus.OK, self._jira(body).search(jql.strip(), page_token))
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        except (GitError, JiraError) as e:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})


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


def jira_from_env() -> Jira | None:
    url, email, token = (os.environ.get(name, "").strip() for name in JIRA_ENV)
    if not (url and email and token):
        if url or email or token:
            missing = [n for n, v in zip(JIRA_ENV, (url, email, token)) if not v]
            print(f"Jira disabled, missing: {', '.join(missing)}", file=sys.stderr)
        return None
    try:
        return Jira(jira_site(url), email, token)
    except JiraError as e:
        sys.exit(f"JIRA_URL: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--repo",
        help="repository folder to pre-fill in Settings (the page can name any other)",
    )
    args = parser.parse_args()
    load_dotenv(HERE / ".env")

    default = None
    if args.repo:
        try:
            default = repo_top(str(Path(args.repo).resolve()))
        except GitError as e:
            sys.exit(str(e))

    Handler.default_repo = default
    Handler.port = args.port
    Handler.jira = jira_from_env()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(
        f"Branch Merger (local)\nOpen http://127.0.0.1:{args.port}  (Ctrl+C to stop)"
    )
    print(
        f"Jira: {Handler.jira.url}"
        if Handler.jira
        else "Jira: set it up in the page's Settings (or JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN)"
    )
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
