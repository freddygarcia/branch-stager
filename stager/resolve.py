"""
Open in editor: fix a branch's conflicts once, in your editor, and have every later
dry run and Apply reuse the fix.

`open_conflict` builds a worktree next to the clone (`<clone>-conflicts/<branch>`) that
is stopped on the branch's conflicting merge, with git rerere on, and opens it in VS Code,
Cursor or the user's own command. `save_fix` records the files as the user left them (`git rerere`) and removes
the worktree; from then on the merges of merge.py replay that fix (merge.RERERE).
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from .git_repo import GitError, Repo
from .merge import (
    RERERE,
    finish_with_saved_fixes,
    merge_in_progress,
    unmerged,
)

# editor id -> its command line tool, and where the app keeps it when it is not on PATH
EDITORS = {
    "vscode": (
        "code",
        "Visual Studio Code.app/Contents/Resources/app/bin/code",
        "vscode",
    ),
    "cursor": ("cursor", "Cursor.app/Contents/Resources/app/bin/cursor", "cursor"),
}
# Settings > Build > Fix conflicts in > Custom command: a command line of the user's,
# run with no shell. Its placeholders are filled in each argument; with none of them,
# the folder is added as the last argument.
CUSTOM = "custom"
PLACEHOLDERS = ("{folder}", "{file}", "{line}")
MARKER = re.compile(r"^(<{7}|>{7})( |$)", re.M)
RECORDED = re.compile(r"^Recorded resolution for '(.+)'\.$", re.M)


def conflict_dir(repo: Repo, head: str) -> Path:
    """The worktree where the conflicts of `head` are fixed: next to the clone."""
    slug = re.sub(r"[^\w.-]+", "-", head).strip("-.") or "branch"
    return repo.path.parent / f"{repo.path.name}-conflicts" / slug


def status(repo: Repo, head: str) -> dict:
    """Whether a conflict worktree of `head` is open: {open, path, repo}."""
    folder = conflict_dir(repo, head)
    return {"open": _ours(repo, folder), "path": str(folder), "repo": str(repo.path)}


def open_conflict(
    repo: Repo, base: str, heads: list[str], head: str, editor: str, command: str = ""
) -> dict:
    """
    Merge `base` and the branches before `head` in `heads` (in order, leaving out one
    that conflicts, like the dry run) then `head`, in the conflict worktree, and stop on
    its conflicts. A worktree already stopped on `head`'s current tip is reused as it is,
    so a fix in progress is kept. Opens it in `editor` (a key of EDITORS), or with
    `command` when `editor` is CUSTOM.
    Returns {path, files, file, line, reused, opened, url}; `files` is empty when `head`
    merges with no conflict left (saved fixes covered them all) and nothing is opened.
    """
    if head not in heads:
        msg = f"{head} is not a selected branch"
        raise GitError(msg)
    if editor == CUSTOM:
        args = custom_args(command)  # refused before anything is merged
    elif editor not in EDITORS:
        msg = f"Unknown editor: {editor}"
        raise GitError(msg)
    base_sha = repo.resolve(base)
    before = [(h, repo.resolve(h)) for h in heads[: heads.index(head)]]
    sha = repo.resolve(head)
    folder = conflict_dir(repo, head)

    reused = _ours(repo, folder) and _merging(repo, folder) == sha
    if not reused:
        _remove(repo, folder)
        _build(repo, folder, base_sha, before, head, sha)
    files = unmerged(repo, folder)
    if not files:
        _remove(repo, folder)
        return {"path": str(folder), "files": [], "reused": False, "opened": False}

    file, line = _first_marker(folder, files)
    if editor == CUSTOM:
        _spawn(_fill(args, folder, file, line))
        opened, url = True, None
    else:
        opened, url = _launch(editor, folder, file, line)
    return {
        "path": str(folder),
        "files": files,
        "file": file,
        "line": line,
        "reused": reused,
        "opened": opened,
        "url": url,
    }


def save_fix(repo: Repo, head: str) -> dict:
    """
    Record the conflict worktree's files as the fix of `head`'s conflicts (git rerere),
    then remove the worktree. Refused while a file still has conflict markers.
    Returns {saved, unsaved}: the files saved, and the conflicted files rerere cannot
    keep (deleted on one side, binary), which must be fixed in the branch itself.
    """
    folder = conflict_dir(repo, head)
    if not _ours(repo, folder):
        msg = f"No open conflicts for {head}: Open in editor first."
        raise GitError(msg)
    if not merge_in_progress(repo, folder):
        # committed from the editor: git rerere recorded the fix then (its cache exists)
        _remove(repo, folder)
        return {"saved": [], "unsaved": [], "committed": True}
    files = unmerged(repo, folder)
    marked = [f for f in files if _has_markers(folder / f)]
    if marked:
        msg = f"Still has conflict markers: {', '.join(marked)}. Fix them, save, try again."
        raise GitError(msg)
    tracked = set(repo.out(*RERERE, "rerere", "status", cwd=folder).splitlines())
    recorded = repo.run(*RERERE, "rerere", cwd=folder)
    saved = RECORDED.findall(f"{recorded.stdout}\n{recorded.stderr}")
    _remove(repo, folder)
    return {"saved": saved, "unsaved": [f for f in files if f not in tracked]}


def discard(repo: Repo, head: str) -> dict:
    """Remove the conflict worktree of `head`, and whatever was fixed in it."""
    folder = conflict_dir(repo, head)
    if _ours(repo, folder):
        _remove(repo, folder)
    return {"ok": True}


# ---------------------------------------------------------------------- helpers


def _ours(repo: Repo, folder: Path) -> bool:
    """True when `folder` is a worktree of this clone (one made by `_build`)."""
    return folder.is_dir() and folder.resolve() in repo.worktrees()


def _merging(repo: Repo, folder: Path) -> str | None:
    """The commit the worktree is stopped merging, if any."""
    result = repo.run(
        "rev-parse", "--quiet", "--verify", "MERGE_HEAD", cwd=folder, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _remove(repo: Repo, folder: Path) -> None:
    if _ours(repo, folder):
        repo.remove_worktree(folder)
    elif folder.exists():
        msg = f"{folder} exists and is not a worktree of this clone: move it away first."
        raise GitError(msg)


def _build(
    repo: Repo,
    folder: Path,
    base_sha: str,
    before: list[tuple[str, str]],
    head: str,
    sha: str,
) -> None:
    folder.parent.mkdir(parents=True, exist_ok=True)
    # a conflict folder deleted by hand (not `git worktree remove`) is still registered,
    # and `worktree add` refuses its path until the registration is pruned
    repo.run("worktree", "prune", check=False)
    repo.run("worktree", "add", "--quiet", "--detach", str(folder), base_sha)
    try:
        for name, commit in before:
            result = _merge(repo, folder, name, commit)
            if result.returncode != 0 and finish_with_saved_fixes(repo, folder, result) is None:
                # it conflicts too: left out, like the dry run does
                repo.run("merge", "--abort", cwd=folder, check=False)
        # diff3 (in RERERE): the editor shows what the common ancestor had too
        result = _merge(repo, folder, head, sha)
        if result.returncode != 0 and not unmerged(repo, folder):
            # no conflict left: saved fixes covered them all, or the merge failed
            if finish_with_saved_fixes(repo, folder, result) is None:
                raise GitError((result.stderr or result.stdout).strip() or "git merge failed")
    except Exception:
        repo.remove_worktree(folder)
        raise


def _merge(repo: Repo, folder: Path, name: str, sha: str):
    return repo.run(
        *RERERE,
        "merge",
        "--no-ff",
        "--no-verify",
        "-m",
        f"Merge branch '{name}'",
        sha,
        cwd=folder,
        check=False,
    )


def _has_markers(path: Path) -> bool:
    try:
        return bool(MARKER.search(path.read_text(errors="replace")))
    except (FileNotFoundError, IsADirectoryError):
        return False


def _first_marker(folder: Path, files: list[str]) -> tuple[str, int]:
    """The first conflicted file with a conflict marker, and that marker's line."""
    for file in files:
        try:
            text = (folder / file).read_text(errors="replace")
        except (FileNotFoundError, IsADirectoryError):
            continue
        match = MARKER.search(text)
        if match:
            return file, text.count("\n", 0, match.start()) + 1
    return files[0], 1


def _editor_tool(editor: str) -> str | None:
    name, in_app, _ = EDITORS[editor]
    found = shutil.which(name)
    if found:
        return found
    for apps in (Path("/Applications"), Path.home() / "Applications"):
        tool = apps / in_app
        if os.access(tool, os.X_OK):
            return str(tool)
    return None


def custom_args(command: str) -> list[str]:
    """
    The arguments of a custom command (shell-style quoting, no shell), its program
    resolved on PATH. Refused when empty, badly quoted, or the program is not found.
    """
    try:
        args = shlex.split(command or "")
    except ValueError as e:
        msg = f"Custom command: {e}"
        raise GitError(msg) from e
    if not args:
        msg = "Enter the custom command in Settings › Build."
        raise GitError(msg)
    program = shutil.which(os.path.expanduser(args[0]))
    if not program:
        msg = f"Custom command: {args[0]} not found (use its full path?)"
        raise GitError(msg)
    return [program, *args[1:]]


def _fill(args: list[str], folder: Path, file: str, line: int) -> list[str]:
    """The custom command's arguments with its placeholders filled in."""
    values = {"{folder}": str(folder), "{file}": str(folder / file), "{line}": str(line)}
    if not any(p in arg for arg in args for p in PLACEHOLDERS):
        return [*args, str(folder)]
    filled = []
    for arg in args:
        for placeholder, value in values.items():
            arg = arg.replace(placeholder, value)
        filled.append(arg)
    return filled


def _launch(editor: str, folder: Path, file: str, line: int) -> tuple[bool, str | None]:
    """
    Open `folder` in the editor at `file`:`line` with its command line tool. Without the
    tool, (False, a vscode:// or cursor:// link) for the page to open instead.
    """
    target = f"{folder / file}:{line}"
    tool = _editor_tool(editor)
    if tool:
        _spawn([tool, str(folder), "--goto", target])
        return True, None
    return False, f"{EDITORS[editor][2]}://file{quote(target, safe='/:')}"


def _spawn(args: list[str]) -> None:
    """Start the editor and leave it running on its own."""
    subprocess.Popen(  # noqa: S603 - a known editor tool, arguments passed as a list
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
