"""Read-only Jira Cloud client for the Jira panel: saved filters and JQL search."""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from .config import JIRA_BULK, JIRA_ENV, JIRA_FIELDS, JIRA_PAGE, JIRA_TIMEOUT


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

    @classmethod
    def from_settings(cls, given: object) -> Jira | None:
        """
        A client for the Jira settings the page sent ({url, email, token}), or None when
        they are all empty.
        """
        if not isinstance(given, dict):
            msg = "jira must be an object"
            raise JiraError(msg)
        url, email, token = (
            str(given.get(k) or "").strip() for k in ("url", "email", "token")
        )
        if not (url or email or token):
            return None
        if not (url and email and token):
            msg = "Fill in the Jira site, email and API token in Settings."
            raise JiraError(msg)
        return cls(jira_site(url), email, token)

    @classmethod
    def from_env(cls) -> Jira | None:
        """A client for JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN, or None when unset."""
        url, email, token = (os.environ.get(name, "").strip() for name in JIRA_ENV)
        if not (url and email and token):
            if url or email or token:
                missing = [n for n, v in zip(JIRA_ENV, (url, email, token)) if not v]
                print(f"Jira disabled, missing: {', '.join(missing)}", file=sys.stderr)
            return None
        try:
            return cls(jira_site(url), email, token)
        except JiraError as e:
            sys.exit(f"JIRA_URL: {e}")

    def call(self, path: str, body: dict | None = None):
        request = urllib.request.Request(  # noqa: S310 - https URL checked by jira_site
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
        return {
            "issues": [_issue(issue) for issue in data.get("issues", [])],
            "next": None if data.get("isLast", True) else data.get("nextPageToken"),
            "url": self.url,
        }

    def issues(self, keys: list[str]) -> dict:
        """The issues of `keys`; a key Jira doesn't know (or hides) is left out."""
        found = []
        for i in range(0, len(keys), JIRA_BULK):
            body = {"issueIdsOrKeys": keys[i : i + JIRA_BULK], "fields": JIRA_FIELDS}
            data = self.call("/rest/api/3/issue/bulkfetch", body) or {}
            found += [_issue(issue) for issue in data.get("issues", [])]
        return {"issues": found, "url": self.url}


def _issue(issue: dict) -> dict:
    fields = issue.get("fields") or {}
    status = fields.get("status") or {}
    return {
        "key": issue["key"],
        "summary": fields.get("summary") or "",
        "status": status.get("name", ""),
        # new / indeterminate / done
        "category": (status.get("statusCategory") or {}).get("key", ""),
        "type": (fields.get("issuetype") or {}).get("name", ""),
        "assignee": (fields.get("assignee") or {}).get("displayName", ""),
        "priority": (fields.get("priority") or {}).get("name", ""),
    }
