import shutil
from pathlib import Path
from unittest import mock

from stager import merge, resolve
from stager.git_repo import GitError, Repo

from tests.gitfixture import GitTestCase
from tests.test_server import ServerTestCase

FIX = "ONE-uno\ntwo\nthree\n"
SELECTED = ["feature-a", "clash"]


def fake_editor(test) -> None:
    """No editor is started by the tests: its tool is found, its launch recorded."""
    for name, value in (("_editor_tool", "/bin/code"), ("_spawn", None)):
        patch = mock.patch.object(resolve, name, return_value=value)
        patch.start()
        test.addCleanup(patch.stop)


class ResolveTest(GitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.repo = Repo(self.path)
        fake_editor(self)

    def open(self, editor="vscode"):
        return resolve.open_conflict(self.repo, "master", SELECTED, "clash", editor)

    def save_a_fix(self) -> Path:
        folder = Path(self.open()["path"])
        (folder / "file.txt").write_text(FIX)
        saved = resolve.save_fix(self.repo, "clash")
        self.assertEqual(saved, {"saved": ["file.txt"], "unsaved": []})
        return folder

    def test_opens_the_conflict(self):
        opened = self.open()
        folder = Path(opened["path"])
        self.assertEqual(folder, self.path.parent / "repo-conflicts" / "clash")
        self.assertEqual(opened["files"], ["file.txt"])
        self.assertEqual((opened["file"], opened["line"]), ("file.txt", 1))
        self.assertFalse(opened["reused"])
        self.assertTrue(opened["opened"])
        text = (folder / "file.txt").read_text()
        # merged after feature-a, with the common ancestor shown (diff3)
        self.assertIn("ONE", text)
        self.assertIn("|||||||", text)
        self.assertTrue(resolve.status(self.repo, "clash")["open"])
        # the user's checkout is untouched
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_reopening_keeps_the_work(self):
        folder = Path(self.open()["path"])
        (folder / "file.txt").write_text("half done <<<<<<< x\n")
        self.assertTrue(self.open()["reused"])
        self.assertEqual((folder / "file.txt").read_text(), "half done <<<<<<< x\n")

    def test_markers_left_refused(self):
        self.open()
        with self.assertRaisesRegex(GitError, "conflict markers: file.txt"):
            resolve.save_fix(self.repo, "clash")
        self.assertTrue(resolve.status(self.repo, "clash")["open"])

    def test_saved_fix_is_reused(self):
        folder = self.save_a_fix()
        self.assertFalse(folder.exists())
        self.assertFalse(resolve.status(self.repo, "clash")["open"])

        results = merge.dry_run(self.repo, "master", [*SELECTED, "feature-b"])
        self.assertEqual(results[1], {"head": "clash", "status": "clean", "fixed": ["file.txt"]})
        self.assertEqual(results[2]["status"], "clean")

        result = merge.merge_into_new_branch(
            self.repo, "env-qa", "master", [*SELECTED, "feature-b"], delete_on_fail=True
        )
        self.assertTrue(result["ok"], result["log"])
        self.assertEqual(result["result"], "3 merged")
        self.assertIn("saved fix for file.txt", "\n".join(x["text"] for x in result["log"]))
        self.assertEqual(self.git("show", "env-qa:file.txt") + "\n", FIX)
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)

    def test_saved_fix_found_when_the_conflict_style_matters(self):
        # both sides add the same line after their change: the default conflict style
        # leaves it out of the conflict, diff3 (the editor's) keeps it in, so the
        # conflict reads differently and rerere only finds the fix in the same style
        self.write("s.txt", "a\nend\n")
        self.commit("s.txt")
        self.branch("left", "s.txt", "L\nSAME\nend\n")
        self.branch("right", "s.txt", "R\nSAME\nend\n")
        heads = ["left", "right"]
        folder = Path(resolve.open_conflict(self.repo, "master", heads, "right", "vscode")["path"])
        (folder / "s.txt").write_text("LR\nSAME\nend\n")
        self.assertEqual(resolve.save_fix(self.repo, "right")["saved"], ["s.txt"])

        results = merge.dry_run(self.repo, "master", heads)
        self.assertEqual(results[1], {"head": "right", "status": "clean", "fixed": ["s.txt"]})
        result = merge.merge_into_new_branch(
            self.repo, "env-qa", "master", heads, delete_on_fail=True
        )
        self.assertTrue(result["ok"], result["log"])
        self.assertEqual(self.git("show", "env-qa:s.txt") + "\n", "LR\nSAME\nend\n")

    def test_nothing_left_to_fix(self):
        self.save_a_fix()
        opened = self.open()
        self.assertEqual(opened["files"], [])
        self.assertFalse(Path(opened["path"]).exists())

    def test_discard(self):
        folder = Path(self.open()["path"])
        resolve.discard(self.repo, "clash")
        self.assertFalse(folder.exists())
        self.assertFalse(self.repo.has_saved_fixes())

    def test_folder_deleted_by_hand(self):
        # removed without `git worktree remove`: git still has it registered
        folder = Path(self.open()["path"])
        shutil.rmtree(folder)
        opened = self.open()
        self.assertFalse(opened["reused"])
        self.assertEqual(opened["files"], ["file.txt"])
        self.assertTrue(resolve.status(self.repo, "clash")["open"])

    def test_foreign_folder_refused(self):
        folder = resolve.conflict_dir(self.repo, "clash")
        folder.mkdir(parents=True)
        (folder / "mine.txt").write_text("keep me")
        with self.assertRaisesRegex(GitError, "not a worktree of this clone"):
            self.open()
        self.assertTrue((folder / "mine.txt").exists())

    def test_no_rerere_cache_without_a_fix(self):
        merge.dry_run(self.repo, "master", SELECTED)
        merge.merge_into_new_branch(self.repo, "x", "master", SELECTED, delete_on_fail=True)
        self.assertFalse((self.path / ".git" / "rr-cache").exists())

    def test_branch_names_become_folder_names(self):
        self.assertEqual(resolve.conflict_dir(self.repo, "feature/AB-1 x").name, "feature-AB-1-x")

    def test_editor(self):
        with mock.patch.object(resolve, "_editor_tool", return_value="/bin/code"), \
             mock.patch.object(resolve, "_spawn") as spawn:
            opened = self.open("vscode")
        self.assertTrue(opened["opened"])
        args = spawn.call_args.args[0]
        self.assertEqual(args[:2], ["/bin/code", opened["path"]])
        self.assertEqual(args[2:], ["--goto", f"{opened['path']}/file.txt:1"])

    def test_editor_link_without_its_tool(self):
        with mock.patch.object(resolve, "_editor_tool", return_value=None):
            opened = self.open("cursor")
        self.assertFalse(opened["opened"])
        self.assertTrue(opened["url"].startswith("cursor://file/"))
        self.assertTrue(opened["url"].endswith("/file.txt:1"))

    def open_custom(self, command):
        with mock.patch.object(resolve, "_spawn") as spawn:
            opened = resolve.open_conflict(
                self.repo, "master", SELECTED, "clash", "custom", command
            )
        return opened, spawn.call_args.args[0]

    def test_custom_command(self):
        opened, args = self.open_custom('git --file="{file}" -C {folder} --at {line}')
        folder = opened["path"]
        self.assertTrue(opened["opened"])
        self.assertTrue(args[0].endswith("/git"))  # found on PATH
        self.assertEqual(
            args[1:], [f"--file={folder}/file.txt", "-C", folder, "--at", "1"]
        )

    def test_custom_command_gets_the_folder(self):
        opened, args = self.open_custom("git --one 'two words'")
        self.assertEqual(args[1:], ["--one", "two words", opened["path"]])

    def test_custom_command_refused(self):
        for command, error in (
            ("", "Enter the custom command"),
            ("no-such-editor-xyz {folder}", "no-such-editor-xyz not found"),
            ("git 'unclosed", "Custom command: No closing quotation"),
        ):
            with self.subTest(command=command), self.assertRaisesRegex(GitError, error):
                resolve.open_conflict(self.repo, "master", SELECTED, "clash", "custom", command)
        # refused before anything was merged
        self.assertFalse(resolve.conflict_dir(self.repo, "clash").exists())

    def test_unknown_editor_refused(self):
        with self.assertRaisesRegex(GitError, "Unknown editor"):
            self.open("sh -c x")


class ResolveRouteTest(ServerTestCase):
    def setUp(self) -> None:
        super().setUp()
        fake_editor(self)

    def test_open_save(self):
        body = {"base": "master", "branches": SELECTED, "head": "clash", "editor": "cursor"}
        status, opened = self.request("POST", "/api/resolve/open", body)
        self.assertEqual(status, 200, opened)
        self.assertEqual(opened["files"], ["file.txt"])
        status, data = self.request("GET", "/api/resolve?head=clash")
        self.assertEqual((status, data["open"]), (200, True))
        Path(opened["path"], "file.txt").write_text(FIX)
        status, data = self.request("POST", "/api/resolve/save", {"head": "clash"})
        self.assertEqual((status, data["saved"]), (200, ["file.txt"]))
        status, data = self.request("POST", "/api/resolve/discard", {"head": "clash"})
        self.assertEqual(status, 200)

    def test_head_required(self):
        status, _ = self.request("POST", "/api/resolve/save", {})
        self.assertEqual(status, 400)
