"""Running git against a local clone: branches, refs and the checks around them."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .config import GIT_TIMEOUT, PROTECTED, REMOTE


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

    def succeeds(self, *args: str, cwd: Path | None = None) -> bool:
        """True when the git command exits with 0 (for yes/no commands like --is-ancestor)."""
        return self.run(*args, cwd=cwd, check=False).returncode == 0

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

    def fetch(self) -> None:
        self.run("fetch", "--prune", "--quiet", REMOTE)

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
        if not self.succeeds("check-ref-format", "--branch", name):
            msg = f'"{name}" is not a valid branch name.'
            raise GitError(msg)
        if PROTECTED.match(name):
            msg = f'"{name}" is a protected branch name. Pick another one.'
            raise GitError(msg)
        if self.succeeds("show-ref", "--verify", "--quiet", f"refs/heads/{name}"):
            msg = f'"{name}" already exists. Pick a new name.'
            raise GitError(msg)

    def push_new_branch(self, name: str) -> tuple[bool, str]:
        """Push a branch this helper just created to the remote and track it."""
        # never reached: such names are refused before merging
        if PROTECTED.match(name):
            return False, f"{name} is protected, not pushed"
        result = self.run(
            "push", "--set-upstream", REMOTE, f"{name}:refs/heads/{name}", check=False
        )
        if result.returncode != 0:
            return False, (result.stderr or result.stdout).strip() or "git push failed"
        return True, f"Pushed {name} to {REMOTE}"

    def delete_branch(self, name: str) -> None:
        self.run("branch", "-D", name, check=False)

    def remove_worktree(self, worktree: Path) -> None:
        self.run("worktree", "remove", "--force", str(worktree), check=False)
        shutil.rmtree(worktree, ignore_errors=True)
        self.run("worktree", "prune", check=False)
