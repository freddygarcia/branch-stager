"""
The HTTP server: serves the page and the /api/ routes it calls.

Only listens on 127.0.0.1. API requests must carry the X-Branch-Merger header and come
from this server's own origin, so other web pages open in the browser cannot call it.
"""

from __future__ import annotations

import json
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, unquote, urlparse

from . import merge
from .config import (
    API_HEADER,
    JQL_MAX,
    PROTECTED,
    REMOTE,
    REPO_HEADER,
    SHA,
    STATIC_TYPES,
    WEB,
)
from .conflicts import conflict_hunks
from .git_repo import GitError, Repo, repo_top
from .jira import Jira, JiraError

# fetch and apply change refs; run them one at a time
WRITE_LOCK = threading.Lock()


class BadRequest(Exception):
    """A malformed request: answered with 400 and the message."""


class HelperServer(ThreadingHTTPServer):
    def __init__(self, port: int, *, default_repo: Path | None, jira: Jira | None):
        super().__init__(("127.0.0.1", port), Handler)
        self.default_repo = default_repo
        self.jira = jira

    @property
    def port(self) -> int:
        return self.server_address[1]


class Request:
    """What a route needs from one API request."""

    def __init__(self, handler: Handler, query: dict[str, list[str]], body: dict):
        self.server: HelperServer = handler.server  # type: ignore[assignment]
        self.headers = handler.headers
        self.query = query
        self.body = body

    def arg(self, name: str) -> str:
        """A query string parameter, "" when absent."""
        return self.query.get(name, [""])[0]

    def str_list(self, name: str, *, non_empty: bool = False) -> list[str]:
        value = self.body.get(name)
        if (
            not isinstance(value, list)
            or (non_empty and not value)
            or not all(isinstance(v, str) for v in value)
        ):
            kind = "a non-empty list" if non_empty else "a list"
            msg = f"{name} must be {kind}"
            raise BadRequest(msg)
        return value

    @property
    def repo(self) -> Repo:
        """The repository named by the request's REPO_HEADER."""
        path = unquote(self.headers.get(REPO_HEADER, "")).strip()
        if not path:
            msg = "Enter the repository folder in Settings."
            raise GitError(msg)
        return Repo(repo_top(path))

    @property
    def jira(self) -> Jira:
        """The Jira settings sent by the page, else the helper's environment."""
        jira = Jira.from_settings(self.body.get("jira") or {}) or self.server.jira
        if jira is None:
            msg = "Jira is not set up: fill in Settings > Jira."
            raise JiraError(msg)
        return jira


# ---------------------------------------------------------------------- routes


def info(req: Request) -> dict:
    default = req.server.default_repo
    return {
        "repo": str(default) if default else None,
        "remote": REMOTE,
        "protected": PROTECTED.pattern,
    }


def branches(req: Request) -> dict:
    repo = req.repo
    return {"repo": str(repo.path), "branches": repo.branches()}


def compare(req: Request) -> dict:
    base, head = req.arg("base"), req.arg("head")
    if not (SHA.match(base) and SHA.match(head)):
        msg = "base and head must be commit shas"
        raise BadRequest(msg)
    ahead, behind = req.repo.counts(base, head)
    return {"ahead": ahead, "behind": behind}


def conflict(req: Request) -> dict:
    tree, path = req.arg("tree"), req.arg("path")
    if not (SHA.match(tree) and path):
        msg = "tree must be a sha and path is required"
        raise BadRequest(msg)
    return conflict_hunks(req.repo, tree, path)


def fetch(req: Request) -> dict:
    with WRITE_LOCK:
        req.repo.fetch()
    return {"ok": True}


def dry_run(req: Request) -> dict:
    heads = req.str_list("branches")
    return {"results": merge.dry_run(req.repo, str(req.body.get("base", "")), heads)}


def apply(req: Request) -> dict:
    heads = req.str_list("branches", non_empty=True)
    with WRITE_LOCK:
        return merge.apply(
            req.repo,
            str(req.body.get("name", "")).strip(),
            str(req.body.get("base", "")),
            heads,
            delete_on_fail=bool(req.body.get("deleteOnFail", True)),
            ff=req.body.get("ff") is True,
            push=req.body.get("push") is True,
        )


def jira_filters(req: Request) -> dict:
    jira = req.jira
    return {"filters": jira.filters(), "url": jira.url}


def jira_search(req: Request) -> dict:
    jql, page_token = req.body.get("jql"), req.body.get("next")
    if not isinstance(jql, str) or not jql.strip() or len(jql) > JQL_MAX:
        msg = f"jql must be a non-empty string under {JQL_MAX} characters"
        raise BadRequest(msg)
    if page_token is not None and not isinstance(page_token, str):
        msg = "next must be a string"
        raise BadRequest(msg)
    return req.jira.search(jql.strip(), page_token)


ROUTES: dict[tuple[str, str], Callable[[Request], dict]] = {
    ("GET", "/api/info"): info,
    ("GET", "/api/branches"): branches,
    ("GET", "/api/compare"): compare,
    ("GET", "/api/conflict"): conflict,
    ("POST", "/api/fetch"): fetch,
    ("POST", "/api/dry-run"): dry_run,
    ("POST", "/api/apply"): apply,
    ("POST", "/api/jira/filters"): jira_filters,
    ("POST", "/api/jira/search"): jira_search,
}


# ---------------------------------------------------------------------- handler


class Handler(BaseHTTPRequestHandler):
    server: HelperServer

    def log_message(self, fmt: str, *args) -> None:  # quieter than the default
        sys.stderr.write(
            f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n"
        )

    def do_GET(self) -> None:
        url = urlparse(self.path)
        api = url.path.startswith("/api/")
        if not self._allowed(api=api):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
        elif api:
            self._api(url.path, parse_qs(url.query), {})
        else:
            self._static(url.path)

    def _static(self, path: str) -> None:
        """A file of web/; / is index.html (so is the page's old name)."""
        if path in {"/", "/branch-merger.html"}:
            path = "/index.html"
        file = (WEB / unquote(path).lstrip("/")).resolve()
        content_type = STATIC_TYPES.get(file.suffix)
        if not (content_type and file.is_relative_to(WEB) and file.is_file()):
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        self._send(HTTPStatus.OK, file.read_bytes(), content_type)

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
        if not isinstance(body, dict):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "The body must be an object"})
            return
        self._api(url.path, {}, body)

    def _api(self, path: str, query: dict[str, list[str]], body: dict) -> None:
        """Run an API route; the request has passed `_allowed`."""
        route = ROUTES.get((self.command, path))
        if route is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        try:
            self._json(HTTPStatus.OK, route(Request(self, query, body)))
        except BadRequest as e:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
        except (GitError, JiraError) as e:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})

    # ------------------------------------------------------------------ guards

    def _own_origins(self) -> set[str]:
        port = self.server.port
        return {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    def _allowed(self, *, api: bool) -> bool:
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

    # ------------------------------------------------------------------ responses

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")
