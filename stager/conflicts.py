"""The conflict view: the conflicted regions of a file from a dry-run merge tree."""

from __future__ import annotations

from .config import CONFLICT_CONTEXT, CONFLICT_MAX_LINES
from .git_repo import Repo


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


def conflict_hunks(repo: Repo, tree: str, path: str) -> dict:
    """
    The conflicted regions of `path` in a dry-run merge `tree` (diff3 markers), each with
    CONFLICT_CONTEXT lines around it, as [line number, kind, text] rows. Kinds: ctx,
    ours, base, theirs, and m-ours/m-base/m-sep/m-theirs for the marker lines.
    """
    empty = {"missing": False, "binary": False, "hunks": [], "truncated": False}
    blob = repo.run("cat-file", "-p", f"{tree}:{path}", check=False)
    if blob.returncode != 0:  # e.g. modify/delete: the path is not in the result
        return {**empty, "missing": True}
    if "\0" in blob.stdout:
        return {**empty, "binary": True}

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
    return {**empty, "hunks": hunks, "truncated": truncated}
