#!/usr/bin/env python3
"""
Local helper for Branch Merger: serves the page and lets it list and merge the branches
of your local clone with git, local branches included.

    python3 main.py [--port 8765] [--repo PATH]

then open http://127.0.0.1:8765 and enter the folder of your clone in Settings. Every API
request names the repository folder in the X-Branch-Merger-Repo header; --repo only
pre-fills that field. The code lives in the stager/ package (see the README).

Jira panel: fill in Settings > Jira on the page. When those settings are empty, the helper
uses JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN from its environment, or from a .env file
next to this script (see .env.example).
"""

from __future__ import annotations

import argparse
import contextlib
import sys
from pathlib import Path

from stager.config import ROOT, load_dotenv
from stager.git_repo import GitError, repo_top
from stager.jira import Jira
from stager.server import HelperServer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--repo",
        help="repository folder to pre-fill in Settings (the page can name any other)",
    )
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")

    default = None
    if args.repo:
        try:
            default = repo_top(str(Path(args.repo).resolve()))
        except GitError as e:
            sys.exit(str(e))

    jira = Jira.from_env()
    server = HelperServer(args.port, default_repo=default, jira=jira)
    print(f"Branch Merger (local)\nOpen http://127.0.0.1:{server.port}  (Ctrl+C to stop)")
    print(
        f"Jira: {jira.url}"
        if jira
        else "Jira: set it up in the page's Settings (or JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN)"
    )
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
