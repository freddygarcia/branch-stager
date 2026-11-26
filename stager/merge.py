"""Merging branches: the in-memory dry run, and Apply in a temporary worktree."""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from .config import DRY_RUN_IDENTITY
from .git_repo import GitError, Repo

# git rerere, on for one command: replay a saved fix and stage it (autoUpdate). A fix is
# saved by "Open in editor" (resolve.py); rerere keeps it in the clone's rr-cache.
# rerere finds a fix by the conflict's text, which depends on the conflict style: every
# merge that saves or replays a fix uses diff3 (what the editor shows), or a fix saved
# there would not be found by the dry run or Apply.
RERERE = (
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoUpdate=true",
    "-c",
    "merge.conflictStyle=diff3",
)
SAVED_FIX = re.compile(r"^(?:Staged|Resolved) '(.+)' using previous resolution\.$", re.M)


def unmerged(repo: Repo, worktree: Path) -> list[str]:
    """Files of the worktree that still have a conflict."""
    return repo.out(
        "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U", cwd=worktree
    ).splitlines()


def merge_in_progress(repo: Repo, worktree: Path) -> bool:
    return repo.succeeds("rev-parse", "--quiet", "--verify", "MERGE_HEAD", cwd=worktree)


def saved_fixes(result) -> list[str]:
    """The files a merge resolved with a saved fix, from its output."""
    return SAVED_FIX.findall(f"{result.stdout}\n{result.stderr}")


def finish_with_saved_fixes(
    repo: Repo, worktree: Path, result, *, env: dict[str, str] | None = None
) -> list[str] | None:
    """
    After a merge that stopped on conflicts: when saved fixes resolved every one of them,
    commit the merge and return the files they fixed; else None (the merge is left as is).
    """
    if unmerged(repo, worktree) or not merge_in_progress(repo, worktree):
        return None
    done = repo.run(
        "commit", "--quiet", "--no-edit", "--no-verify", cwd=worktree, check=False, env=env
    )
    return saved_fixes(result) if done.returncode == 0 else None


class SavedFixCheck:
    """
    For the dry run: merge a conflicting branch for real, in one temporary worktree made
    on first use, to see whether saved fixes resolve all its conflicts.
    """

    def __init__(self, repo: Repo):
        self.repo = repo
        self.worktree: Path | None = None

    def merge(self, current: str, sha: str, head: str) -> tuple[str, list[str]] | None:
        """(the merge commit, the files fixed) when saved fixes resolve it all, else None."""
        repo = self.repo
        if self.worktree is None:
            self.worktree = Path(tempfile.mkdtemp(prefix="branch-merger-"))
            repo.run("worktree", "add", "--quiet", "--detach", str(self.worktree), current)
        else:
            repo.run("checkout", "--quiet", "--detach", "--force", current, cwd=self.worktree)
        result = repo.run(
            *RERERE,
            "merge",
            "--no-ff",
            "--no-verify",
            "-m",
            f"Branch Merger dry run: merge {head}",
            sha,
            cwd=self.worktree,
            check=False,
            env=DRY_RUN_IDENTITY,
        )
        fixed = finish_with_saved_fixes(repo, self.worktree, result, env=DRY_RUN_IDENTITY)
        if fixed is None:
            repo.run("merge", "--abort", cwd=self.worktree, check=False)
            return None
        return repo.out("rev-parse", "HEAD", cwd=self.worktree), fixed

    def close(self) -> None:
        if self.worktree is not None:
            self.repo.remove_worktree(self.worktree)


def dry_run(repo: Repo, base: str, heads: list[str]) -> list[dict]:
    """
    Merge `heads` into `base` in order, in memory only (`git merge-tree`): no worktree,
    branch or ref is touched. Each clean merge is chained through an unreferenced commit
    (removed by git gc) so the next branch is checked against everything merged before
    it, like Apply. A conflicting branch is left out of the chain: the branches after it
    are checked as if it had been removed (Apply itself would stop there).
    A conflict that saved fixes (git rerere) resolve completely counts as clean, with
    `fixed`: the files they fixed. Checking that takes a real merge in a temporary worktree,
    so it only happens when the clone has saved fixes.
    """
    check = SavedFixCheck(repo) if repo.has_saved_fixes() else None
    try:
        return _dry_run(repo, base, heads, check)
    finally:
        if check is not None:
            check.close()


def _dry_run(
    repo: Repo, base: str, heads: list[str], check: SavedFixCheck | None
) -> list[dict]:
    current = repo.resolve(base)
    results: list[dict] = []
    for head in heads:
        try:
            sha = repo.resolve(head)
        except GitError as e:
            results.append({"head": head, "status": "error", "message": str(e)})
            continue
        if repo.succeeds("merge-base", "--is-ancestor", sha, current):
            results.append({"head": head, "status": "contained"})
            continue
        # diff3 markers: the conflict view also shows what the common ancestor had
        merge = repo.run(
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
            current = repo.out(
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
            fixed = check.merge(current, sha, head) if check else None
            if fixed is not None:
                current, files = fixed
                results.append({"head": head, "status": "clean", "fixed": files})
                continue
            files = list(dict.fromkeys(line for line in lines[1:] if line))
            # the merged tree (markers included) stays readable until git gc
            results.append(
                {
                    "head": head,
                    "status": "conflict",
                    "files": files,
                    "tree": lines[0],
                    "notes": _conflict_notes(files, messages_part),
                }
            )
        else:
            message = (merge.stderr or merge.stdout).strip() or "git merge-tree failed"
            results.append({"head": head, "status": "error", "message": message})
    return results


def _conflict_notes(files: list[str], messages: str) -> dict[str, list[str]]:
    """The CONFLICT messages of merge-tree that name each file."""
    conflicts = [m for m in messages.splitlines() if m.startswith("CONFLICT")]
    return {
        path: [
            m
            for m in conflicts
            if re.search(rf"(?<![\w/.-]){re.escape(path)}(?![\w/-])", m)
        ]
        for path in files
    }


def apply(
    repo: Repo,
    name: str,
    base: str,
    heads: list[str],
    *,
    delete_on_fail: bool,
    ff: bool = False,
    push: bool = False,
    rebuild: bool = False,
    profile: str = "",
) -> dict:
    """
    `merge_into_new_branch` (or `rebuild_branch` with `rebuild`), then push the branch
    when asked. Only a branch whose merges all succeeded is pushed; a rebuilt branch is
    pushed with --force-with-lease. Returns {ok, result, log, created, pushed}, and on
    success `built`: the commits merged, {base: sha, heads: {name: sha}}.
    """
    if rebuild:
        # the remote tip to replace, as of the last fetch: read before anything changes
        lease = repo.remote_sha(name) or ""
        result = rebuild_branch(repo, name, base, heads, ff=ff, profile=profile)
    else:
        lease = None
        result = merge_into_new_branch(
            repo, name, base, heads, delete_on_fail=delete_on_fail, ff=ff
        )
    result["pushed"] = False
    if result["ok"] and push:
        pushed, message = repo.push_branch(name, lease=lease)
        result["pushed"] = pushed
        result["log"].append(
            {
                "text": message if pushed else f"Push failed: {message}",
                "cls": "ok" if pushed else "err",
            }
        )
        result["result"] += ", pushed" if pushed else ", push failed"
    return result


def rebuild_branch(
    repo: Repo,
    name: str,
    base: str,
    heads: list[str],
    *,
    ff: bool = False,
    profile: str = "",
) -> dict:
    """
    Build `name` again from `base` and `heads`, whether or not it exists: an environment
    branch rebuilt in place. The merges run on a detached temporary worktree and `name`
    only moves once all of them succeeded, so a conflict leaves it exactly as it was.
    The last commit is an empty one that describes the build (`describe_build`).
    Returns {ok, result, log, created} like `merge_into_new_branch`.
    """
    repo.check_new_branch_name(name, may_exist=True)
    where = repo.checked_out_at(name)
    if where:
        msg = f"{name} is checked out in {where}: switch that folder to another branch first."
        raise GitError(msg)
    old = repo.local_sha(name)
    base_sha = repo.resolve(base)
    head_shas = [(head, repo.resolve(head)) for head in heads]
    run = MergeRun(repo, name, base, ff=ff)
    run.built = {"base": base_sha, "heads": dict(head_shas)}
    run.say(f"Rebuild {name}" + (f" (now at {old[:8]})" if old else " (new)"))
    run.say(f"Base {base}")
    run.say(f"  at {base_sha[:8]}", "muted")
    run.say(
        "Merge mode: --ff (fast-forward when possible)"
        if ff
        else "Merge mode: --no-ff (always a merge commit)",
        "muted",
    )

    worktree = Path(tempfile.mkdtemp(prefix="branch-merger-"))
    try:
        repo.run("worktree", "add", "--quiet", "--detach", str(worktree), base_sha)
        failed = next(
            (head for head, sha in head_shas if not run.merge(worktree, head, sha)),
            None,
        )
        if failed is not None:
            run.say(f"{name} not changed", "warn")
            result = run.failed(failed, created=False)
            # an existing branch still is where it was: its links stay useful
            result["created"] = bool(old)
            return result
        repo.run(
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-verify",
            "-m",
            describe_build(name, base, base_sha, head_shas, profile=profile),
            cwd=worktree,
        )
        new = repo.out("rev-parse", "HEAD", cwd=worktree)
        run.say(f"  ✎ described the build in {new[:8]}", "muted")
        # moves the branch only if nobody moved it since `old` was read ("" = must not exist)
        repo.run(
            "update-ref",
            "-m",
            "Branch Merger: rebuild",
            f"refs/heads/{name}",
            new,
            old or "",
        )
        run.say(
            f"{name}: {old[:8]} → {new[:8]}" if old else f"Created {name} at {new[:8]}",
            "ok",
        )
        return run.done()
    finally:
        repo.remove_worktree(worktree)


TRAILER = "Branch-Merger"


def describe_build(
    name: str,
    base: str,
    base_sha: str,
    head_shas: list[tuple[str, str]],
    *,
    profile: str = "",
) -> str:
    """
    The message of the empty commit that ends a rebuild: what `name` was built from, as
    git trailers, so `git log -1 name` shows it without this tool. Read them back with
    `git log -1 --format='%(trailers:key=Branch-Merger-Branch,valueonly)' name`.
    """
    count = len(head_shas)
    lines = [
        f"Build {name}: {base} + {count} branch{'' if count == 1 else 'es'}",
        "",
        "Rebuilt by Branch Merger"
        + (f" from profile {profile}" if profile else "")
        + ": the base and these branches, merged in this order.",
        "",
        f"{TRAILER}-Base: {base} {base_sha}",
        *(f"{TRAILER}-Branch: {head} {sha}" for head, sha in head_shas),
    ]
    if profile:
        lines.append(f"{TRAILER}-Profile: {profile}")
    return "\n".join(lines) + "\n"


def merge_into_new_branch(
    repo: Repo,
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
    repo.check_new_branch_name(name)
    base_sha = repo.resolve(base)
    head_shas = [(head, repo.resolve(head)) for head in heads]
    run = MergeRun(repo, name, base, ff=ff)
    run.built = {"base": base_sha, "heads": dict(head_shas)}
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
        repo.run("worktree", "add", "--quiet", "-b", name, str(worktree), base_sha)
        created = True
        run.say(f"Created {name} (local)", "ok")
        failed = next(
            (head for head, sha in head_shas if not run.merge(worktree, head, sha)),
            None,
        )
        if failed is None:
            return run.done()
        if delete_on_fail:
            repo.remove_worktree(worktree)
            repo.delete_branch(name)
            created = False
            run.say(f"Deleted {name}", "warn")
        else:
            run.say(f"{name} kept (local) with the merges before {failed}", "warn")
        return run.failed(failed, created=created)
    except Exception:
        if created and delete_on_fail:
            repo.remove_worktree(worktree)
            repo.delete_branch(name)
        raise
    finally:
        repo.remove_worktree(worktree)


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
        # rerere only when there is a saved fix to replay: else it would start a cache
        self.rerere = RERERE if repo.has_saved_fixes() else ()
        # the commits merged: {"base": sha, "heads": {name: sha}}, returned on success
        self.built: dict = {}

    def say(self, text: str, cls: str = "") -> None:
        self.log.append({"text": text, "cls": cls})

    def merge(self, worktree: Path, head: str, sha: str) -> bool:
        """Merge one branch; False (merge aborted, reason logged) if it could not."""
        repo = self.repo
        if repo.succeeds("merge-base", "--is-ancestor", sha, "HEAD", cwd=worktree):
            self.up_to_date += 1
            self.say(f"  = {head}  already contained, nothing to merge", "muted")
            return True
        fast_forward = self.ff and repo.succeeds(
            "merge-base", "--is-ancestor", "HEAD", sha, cwd=worktree
        )
        # --no-verify: like the GitHub API merge, no local hooks run on the merge commit
        message = f"Merge branch '{head}' into {self.name}"
        result = repo.run(
            *self.rerere,
            "merge",
            "--ff" if self.ff else "--no-ff",
            "--no-verify",
            "-m",
            message,
            sha,
            cwd=worktree,
            check=False,
        )
        fixed = (
            finish_with_saved_fixes(repo, worktree, result)
            if result.returncode != 0 and self.rerere
            else None
        )
        if result.returncode == 0 or fixed is not None:
            self.merged += 1
            self.fast_forwarded += fast_forward
            self.merged_heads.append(head)
            short = repo.out("rev-parse", "--short=8", "HEAD", cwd=worktree)
            how = "  (fast-forward)" if fast_forward else ""
            if fixed is not None:
                how = f"  (saved fix for {', '.join(fixed) or 'its conflicts'})"
            self.say(f"  ✓ {head}  → {short}{how}", "ok")
            return True

        files = unmerged(repo, worktree)
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
        return {
            "ok": True,
            "result": result,
            "log": self.log,
            "created": True,
            "built": self.built,
        }

    def failed(self, head: str, *, created: bool) -> dict:
        outcome = f"Conflict: {head}" if self.conflicted else f"Merge failed: {head}"
        return {"ok": False, "result": outcome, "log": self.log, "created": created}
