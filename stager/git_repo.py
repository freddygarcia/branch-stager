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
        remote) and offers the remote one only as a base. `date` is the tip's committer date
        (Unix seconds), for telling stale branches; `author` is the tip's author email
        (lowercased), for the "Mine only" filter.
        """
        lines = self.out(
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(authoremail:trim)",
            "refs/heads",
            f"refs/remotes/{REMOTE}",
        ).splitlines()
        local: dict[str, str] = {}
        remote: dict[str, str] = {}
        dates: dict[str, int | None] = {}
        authors: dict[str, str] = {}
        for line in lines:
            ref, sha, date, author = line.split("\0")
            dates[sha] = int(date) if date.isdigit() else None
            authors[sha] = author.lower()
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
                    "date": dates[sha],
                    "author": authors[sha],
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
                    "date": dates[sha],
                    "author": authors[sha],
                    "kind": "remote",
                    "remote": None,
                    "shadowed": name in local,
                }
            )
        return sorted(items, key=lambda item: item["name"])

    def user_email(self) -> str | None:
        """The email git authors commits with here (config or environment), lowercased."""
        ident = self.run("var", "GIT_AUTHOR_IDENT", check=False).stdout
        email = ident.partition("<")[2].partition(">")[0]
        return email.lower() or None

    def check_new_branch_name(self, name: str, *, may_exist: bool = False) -> None:
        """Refuse a name Apply must not write: invalid, protected, or (unless `may_exist`) taken."""
        if not self.succeeds("check-ref-format", "--branch", name):
            msg = f'"{name}" is not a valid branch name.'
            raise GitError(msg)
        if PROTECTED.match(name):
            msg = f'"{name}" is a protected branch name. Pick another one.'
            raise GitError(msg)
        if not may_exist and self.local_sha(name):
            msg = f'"{name}" already exists. Pick a new name.'
            raise GitError(msg)

    def local_sha(self, name: str) -> str | None:
        """Tip of the local branch `name`, None when there is no such branch."""
        result = self.run(
            "rev-parse", "--verify", "--quiet", f"refs/heads/{name}^{{commit}}", check=False
        )
        return result.stdout.strip() if result.returncode == 0 else None

    def remote_sha(self, name: str) -> str | None:
        """Tip of `origin/name` as of the last fetch, None when origin has no such branch."""
        result = self.run(
            "rev-parse",
            "--verify",
            "--quiet",
            f"refs/remotes/{REMOTE}/{name}^{{commit}}",
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    def checked_out_at(self, name: str) -> str | None:
        """The folder of a worktree (the main checkout included) that has `name` checked out."""
        folder = None
        for line in self.out("worktree", "list", "--porcelain").splitlines():
            if line.startswith("worktree "):
                folder = line.removeprefix("worktree ")
            elif line == f"branch refs/heads/{name}":
                return folder
        return None

    def push_branch(self, name: str, *, lease: str | None = None) -> tuple[bool, str]:
        """
        Push `name` to the remote and track it. With `lease` (the remote tip this helper
        last saw, "" for none) the push may replace the remote branch, but only while the
        remote still has that tip (--force-with-lease): a push made by someone else since
        the last fetch is never overwritten.
        """
        # never reached: such names are refused before merging
        if PROTECTED.match(name):
            return False, f"{name} is protected, not pushed"
        args = ["push", "--set-upstream"]
        if lease is not None:
            args.append(f"--force-with-lease=refs/heads/{name}:{lease}")
        result = self.run(*args, REMOTE, f"{name}:refs/heads/{name}", check=False)
        if result.returncode != 0:
            if lease is not None and "stale info" in result.stderr:
                return False, (
                    f"{REMOTE}/{name} changed since the last Reload (someone pushed to it), "
                    f"so it was not replaced. Reload to see what is there, then rebuild "
                    f"again to replace it."
                )
            return False, (result.stderr or result.stdout).strip() or "git push failed"
        how = " (replaced)" if lease else ""
        return True, f"Pushed {name} to {REMOTE}{how}"

    def has_saved_fixes(self) -> bool:
        """
        True when git rerere has recorded a conflict resolution (a "saved fix"). Its cache
        is in the common git dir, so a fix saved in one worktree is reused in every other.
        """
        common = Path(self.out("rev-parse", "--git-common-dir"))
        if not common.is_absolute():
            common = self.path / common
        return any((common / "rr-cache").glob("*/postimage*"))

    def worktrees(self) -> set[Path]:
        """The folders of every worktree of this clone, the main checkout included."""
        return {
            Path(line.removeprefix("worktree ")).resolve()
            for line in self.out("worktree", "list", "--porcelain").splitlines()
            if line.startswith("worktree ")
        }

    def delete_branch(self, name: str) -> None:
        self.run("branch", "-D", name, check=False)

    def remove_worktree(self, worktree: Path) -> None:
        self.run("worktree", "remove", "--force", str(worktree), check=False)
        shutil.rmtree(worktree, ignore_errors=True)
        self.run("worktree", "prune", check=False)
