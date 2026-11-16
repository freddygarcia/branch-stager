import unittest

from stager import merge
from stager.conflicts import conflict_hunks
from stager.git_repo import GitError, Repo, repo_top

from tests.gitfixture import GitTestCase


class RepoTopTest(GitTestCase):
    def test_folder_inside_the_clone(self):
        (self.path / "sub").mkdir()
        self.assertEqual(repo_top(str(self.path / "sub")), self.path)

    def test_relative_path_refused(self):
        with self.assertRaisesRegex(GitError, "absolute"):
            repo_top("repo")

    def test_missing_folder(self):
        with self.assertRaisesRegex(GitError, "No such folder"):
            repo_top(str(self.path / "nope"))

    def test_not_a_repository(self):
        with self.assertRaisesRegex(GitError, "Not a git repository"):
            repo_top(str(self.path.parent))


class BranchesTest(GitTestCase):
    def test_local_and_remote(self):
        # a fake origin: one branch shadowed by a local one (and behind it), one remote only
        self.git("update-ref", "refs/remotes/origin/feature-a", self.sha("master"))
        self.git("update-ref", "refs/remotes/origin/only-remote", self.sha("master"))
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature-a")
        items = {b["name"]: b for b in Repo(self.path).branches()}
        self.assertEqual(
            sorted(items),
            [
                "clash",
                "feature-a",
                "feature-b",
                "master",
                "old",
                "origin/feature-a",
                "origin/only-remote",
            ],
        )
        self.assertEqual(items["feature-a"]["remote"]["ahead"], 1)
        self.assertEqual(items["feature-a"]["remote"]["behind"], 0)
        self.assertIsNone(items["master"]["remote"])
        self.assertTrue(items["origin/feature-a"]["shadowed"])
        self.assertFalse(items["origin/only-remote"]["shadowed"])
        self.assertEqual(items["origin/only-remote"]["kind"], "remote")

    def test_resolve(self):
        repo = Repo(self.path)
        self.assertEqual(repo.resolve("feature-a"), self.sha("feature-a"))
        with self.assertRaisesRegex(GitError, "No such branch"):
            repo.resolve("nope")

    def test_counts(self):
        ahead, behind = Repo(self.path).counts(self.sha("old"), self.sha("feature-a"))
        self.assertEqual((ahead, behind), (2, 0))


class DryRunTest(GitTestCase):
    def test_statuses(self):
        results = merge.dry_run(
            Repo(self.path),
            "master", ["feature-a", "old", "clash", "feature-b", "nope"]
        )
        by_head = {r["head"]: r for r in results}
        self.assertEqual(by_head["feature-a"]["status"], "clean")
        self.assertEqual(by_head["old"]["status"], "contained")
        self.assertEqual(by_head["clash"]["status"], "conflict")
        self.assertEqual(by_head["clash"]["files"], ["file.txt"])
        self.assertTrue(by_head["clash"]["notes"]["file.txt"])
        # checked against feature-a merged before it, without the conflicting branch
        self.assertEqual(by_head["feature-b"]["status"], "clean")
        self.assertEqual(by_head["nope"]["status"], "error")

    def test_touches_no_ref(self):
        before = self.git("for-each-ref")
        merge.dry_run(Repo(self.path), "master", ["feature-a", "clash"])
        self.assertEqual(self.git("for-each-ref"), before)

    def test_conflict_hunks(self):
        repo = Repo(self.path)
        conflict = merge.dry_run(repo, "master", ["feature-a", "clash"])[1]
        view = conflict_hunks(repo, conflict["tree"], "file.txt")
        self.assertFalse(view["missing"] or view["binary"] or view["truncated"])
        kinds = [row[1] for row in view["hunks"][0]]
        self.assertEqual(kinds[:4], ["m-ours", "ours", "m-base", "base"])
        self.assertIn("theirs", kinds)
        self.assertTrue(conflict_hunks(repo, conflict["tree"], "gone.txt")["missing"])


class MergeTest(GitTestCase):
    def test_merges_in_a_worktree(self):
        status = self.git("status", "--porcelain")
        result = merge.merge_into_new_branch(
            Repo(self.path),
            "integration/x", "master", ["feature-a", "old", "feature-b"], delete_on_fail=True
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"], "2 merged, 1 up to date")
        self.assertEqual(self.git("branch", "--show-current"), "master")
        self.assertEqual(self.git("status", "--porcelain"), status)
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)
        # --no-ff: two merge commits
        merges = self.git("rev-list", "--merges", "master..integration/x").split()
        self.assertEqual(len(merges), 2)

    def test_reports_the_commits_merged(self):
        result = merge.merge_into_new_branch(
            Repo(self.path),
            "integration/x", "master", ["feature-a", "old"], delete_on_fail=True
        )
        self.assertEqual(
            result["built"],
            {
                "base": self.sha("master"),
                "heads": {"feature-a": self.sha("feature-a"), "old": self.sha("old")},
            },
        )

    def test_fast_forward(self):
        result = merge.merge_into_new_branch(
            Repo(self.path),
            "integration/x", "master", ["feature-a", "feature-b"], delete_on_fail=True, ff=True
        )
        self.assertIn("1 fast-forwarded", result["result"])
        self.assertEqual(
            self.git("rev-parse", "integration/x^1"), self.sha("feature-a")
        )

    def test_conflict_deletes_the_branch(self):
        result = merge.merge_into_new_branch(
            Repo(self.path),
            "integration/x", "master", ["feature-a", "clash"], delete_on_fail=True
        )
        self.assertFalse(result["ok"])
        self.assertFalse(result["created"])
        self.assertEqual(result["result"], "Conflict: clash")
        self.assertEqual(self.git("branch", "--list", "integration/x"), "")

    def test_conflict_keeps_the_branch(self):
        result = merge.merge_into_new_branch(
            Repo(self.path),
            "integration/x", "master", ["feature-a", "clash"], delete_on_fail=False
        )
        self.assertTrue(result["created"])
        self.assertNotEqual(self.git("branch", "--list", "integration/x"), "")

    def test_names_refused(self):
        repo = Repo(self.path)
        for name, message in (
            ("master", "protected"),
            ("release/1", "protected"),
            ("feature-a", "already exists"),
            ("bad..name", "not a valid"),
        ):
            with self.subTest(name=name), self.assertRaisesRegex(GitError, message):
                merge.merge_into_new_branch(
                    repo, name, "master", ["feature-b"], delete_on_fail=True
                )


class RebuildTest(GitTestCase):
    def test_creates_then_replaces(self):
        repo = Repo(self.path)
        first = merge.rebuild_branch(repo, "env/qa", "master", ["feature-a"])
        self.assertTrue(first["ok"])
        built = self.sha("env/qa")
        self.assertEqual(self.sha("env/qa^2"), self.sha("feature-a"))
        # rebuilt from scratch: feature-a is gone, feature-b is in
        second = merge.rebuild_branch(repo, "env/qa", "master", ["feature-b"])
        self.assertTrue(second["ok"])
        self.assertEqual(second["built"]["heads"], {"feature-b": self.sha("feature-b")})
        self.assertNotEqual(self.sha("env/qa"), built)
        self.assertEqual(self.sha("env/qa^1"), self.sha("master"))
        self.assertEqual(self.sha("env/qa^2"), self.sha("feature-b"))
        self.assertEqual(self.git("branch", "--show-current"), "master")
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)

    def test_conflict_leaves_the_branch(self):
        repo = Repo(self.path)
        merge.rebuild_branch(repo, "env/qa", "master", ["feature-b"])
        before = self.sha("env/qa")
        result = merge.rebuild_branch(repo, "env/qa", "master", ["feature-a", "clash"])
        self.assertFalse(result["ok"])
        self.assertTrue(result["created"])  # it still exists, unchanged
        self.assertEqual(self.sha("env/qa"), before)

    def test_conflict_on_a_new_branch_creates_nothing(self):
        result = merge.rebuild_branch(
            Repo(self.path), "env/qa", "master", ["feature-a", "clash"]
        )
        self.assertFalse(result["created"])
        self.assertEqual(self.git("branch", "--list", "env/qa"), "")

    def test_checked_out_branch_refused(self):
        self.git("branch", "env/qa", "master")
        self.git("checkout", "--quiet", "env/qa")
        with self.assertRaisesRegex(GitError, "checked out"):
            merge.rebuild_branch(Repo(self.path), "env/qa", "master", ["feature-a"])

    def test_protected_refused(self):
        with self.assertRaisesRegex(GitError, "protected"):
            merge.rebuild_branch(Repo(self.path), "staging", "master", ["feature-a"])


class RebuildPushTest(GitTestCase):
    """Rebuild and push to a bare origin, then again after someone else pushed."""

    def setUp(self) -> None:
        super().setUp()
        self.origin = self.path.parent / "origin.git"
        self.git("init", "--quiet", "--bare", str(self.origin))
        self.git("remote", "add", "origin", str(self.origin))

    def origin_sha(self, name: str) -> str:
        return self.git("--git-dir", str(self.origin), "rev-parse", name)

    def rebuild(self, *heads: str) -> dict:
        return merge.apply(
            Repo(self.path), "env/qa", "master", list(heads),
            delete_on_fail=True, push=True, rebuild=True,
        )

    def test_force_with_lease(self):
        self.assertTrue(self.rebuild("feature-a")["pushed"])
        self.assertEqual(self.origin_sha("env/qa"), self.sha("env/qa"))

        # a rebuild replaces what it pushed before
        result = self.rebuild("feature-b")
        self.assertTrue(result["pushed"], result["log"])
        self.assertEqual(self.origin_sha("env/qa"), self.sha("env/qa"))

        # someone else pushes to env/qa, and this clone hasn't fetched it: not overwritten
        tree = self.git("rev-parse", "env/qa^{tree}")
        other = self.git("commit-tree", "-p", self.sha("env/qa"), "-m", "other", tree)
        self.git("push", "--quiet", str(self.origin), f"{other}:refs/heads/env/qa")
        result = self.rebuild("feature-a")
        self.assertTrue(result["ok"])
        self.assertFalse(result["pushed"])
        self.assertIn("changed since the last Reload", result["log"][-1]["text"])
        self.assertEqual(self.origin_sha("env/qa"), other)


if __name__ == "__main__":
    unittest.main()
