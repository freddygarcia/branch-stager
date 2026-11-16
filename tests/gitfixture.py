"""A throwaway git repository for the tests, isolated from the user's git config."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ISOLATED_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


class GitTestCase(unittest.TestCase):
    """
    Each test gets a repository on `master` with file.txt = "one\\ntwo\\nthree\\n" and:
      feature-a  edits line 1 of file.txt   (merges cleanly with feature-b)
      feature-b  adds b.txt
      clash      edits line 1 differently from feature-a
      old        an ancestor of master      (already contained)
    """

    def setUp(self) -> None:
        env = mock.patch.dict(os.environ, ISOLATED_ENV)
        env.start()
        self.addCleanup(env.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name).resolve() / "repo"
        self.path.mkdir()
        self.git("init", "--quiet", "--initial-branch=master")
        self.write("file.txt", "zero\n")
        self.commit("start")
        self.git("branch", "old")
        self.write("file.txt", "one\ntwo\nthree\n")
        self.commit("base")
        self.branch("feature-a", "file.txt", "ONE\ntwo\nthree\n")
        self.branch("feature-b", "b.txt", "b\n")
        self.branch("clash", "file.txt", "uno\ntwo\nthree\n")

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.path, check=True, capture_output=True, text=True
        ).stdout.strip()

    def write(self, name: str, text: str) -> None:
        (self.path / name).write_text(text)

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def branch(self, name: str, file: str, text: str) -> str:
        self.git("checkout", "--quiet", "-b", name, "master")
        self.write(file, text)
        sha = self.commit(f"{name}: edit {file}")
        self.git("checkout", "--quiet", "master")
        return sha

    def sha(self, ref: str) -> str:
        return self.git("rev-parse", ref)
