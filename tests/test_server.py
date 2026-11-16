import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote

from stager.config import PROTECTED, load_dotenv
from stager.jira import Jira, JiraError, jira_site
from stager.server import HelperServer

from tests.gitfixture import GitTestCase


class ServerTestCase(GitTestCase):
    def setUp(self) -> None:
        super().setUp()
        server = HelperServer(0, default_repo=None, jira=None)
        self.port = server.port
        threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def request(self, method, path, body=None, *, headers=None, api=True, repo=True):
        sent = {"Host": f"127.0.0.1:{self.port}"}
        if api:
            sent["X-Branch-Merger"] = "1"
        if repo:
            sent["X-Branch-Merger-Repo"] = quote(str(self.path))
        if body is not None:
            sent["Content-Type"] = "application/json"
        sent.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        self.addCleanup(conn.close)
        conn.request(method, path, None if body is None else json.dumps(body), sent)
        res = conn.getresponse()
        data = res.read()
        if res.getheader("Content-Type", "").startswith("application/json"):
            return res.status, json.loads(data)
        return res.status, data


class GuardTest(ServerTestCase):
    def test_page_is_served(self):
        status, body = self.request("GET", "/", api=False, repo=False)
        self.assertEqual(status, 200)
        self.assertIn(b"<html", body)

    def test_static_files(self):
        for path, kind in (("/app.css", "text/css"), ("/js/main.js", "text/javascript")):
            with self.subTest(path=path):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
                self.addCleanup(conn.close)
                conn.request("GET", path, headers={"Host": f"127.0.0.1:{self.port}"})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertTrue(res.getheader("Content-Type").startswith(kind))

    def test_only_web_files_are_served(self):
        for path in ("/../main.py", "/%2e%2e/main.py", "/js/../../main.py", "/nope.css"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path, api=False)[0], 404)

    def test_api_needs_the_header(self):
        status, _ = self.request("GET", "/api/info", api=False)
        self.assertEqual(status, 403)

    def test_foreign_origin_refused(self):
        status, _ = self.request(
            "POST", "/api/fetch", {}, headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(status, 403)

    def test_dns_rebinding_refused(self):
        status, _ = self.request("GET", "/", api=False, headers={"Host": "evil.example"})
        self.assertEqual(status, 403)

    def test_own_origin_allowed(self):
        status, body = self.request(
            "GET", "/api/info", headers={"Origin": f"http://localhost:{self.port}"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["remote"], "origin")
        self.assertEqual(body["protected"], PROTECTED.pattern)


class RouteTest(ServerTestCase):
    def test_branches(self):
        status, body = self.request("GET", "/api/branches")
        self.assertEqual(status, 200)
        self.assertEqual(body["repo"], str(self.path))
        self.assertIn("feature-a", [b["name"] for b in body["branches"]])

    def test_missing_repo(self):
        status, body = self.request("GET", "/api/branches", repo=False)
        self.assertEqual(status, 422)
        self.assertIn("repository folder", body["error"])

    def test_compare(self):
        old, head = self.sha("old"), self.sha("feature-a")
        status, body = self.request("GET", f"/api/compare?base={old}&head={head}")
        self.assertEqual((status, body), (200, {"ahead": 2, "behind": 0}))
        status, _ = self.request("GET", "/api/compare?base=master&head=x")
        self.assertEqual(status, 400)

    def test_dry_run_and_conflict(self):
        status, body = self.request(
            "POST", "/api/dry-run", {"base": "master", "branches": ["feature-a", "clash"]}
        )
        self.assertEqual(status, 200)
        conflict = body["results"][1]
        self.assertEqual(conflict["status"], "conflict")
        status, body = self.request(
            "GET", f"/api/conflict?tree={conflict['tree']}&path=file.txt"
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["hunks"])
        status, _ = self.request("POST", "/api/dry-run", {"branches": "x"})
        self.assertEqual(status, 400)

    def test_apply(self):
        status, body = self.request(
            "POST",
            "/api/apply",
            {"name": "integration/x", "base": "master", "branches": ["feature-a"]},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["pushed"])
        status, body = self.request(
            "POST",
            "/api/apply",
            {"name": "master", "base": "master", "branches": ["feature-a"]},
        )
        self.assertEqual(status, 422)
        self.assertIn("protected", body["error"])
        status, _ = self.request("POST", "/api/apply", {"name": "x", "branches": []})
        self.assertEqual(status, 400)

    def test_invalid_json(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        self.addCleanup(conn.close)
        conn.request(
            "POST",
            "/api/apply",
            "{nope",
            {"Host": f"127.0.0.1:{self.port}", "X-Branch-Merger": "1"},
        )
        self.assertEqual(conn.getresponse().status, 400)

    def test_body_must_be_an_object(self):
        status, _ = self.request("POST", "/api/apply", ["x"])
        self.assertEqual(status, 400)

    def test_jira_not_set_up(self):
        status, body = self.request("POST", "/api/jira/filters", {})
        self.assertEqual(status, 422)
        self.assertIn("Jira", body["error"])
        status, body = self.request(
            "POST", "/api/jira/filters", {"jira": {"url": "https://x.atlassian.net"}}
        )
        self.assertEqual(status, 422)
        self.assertIn("Fill in", body["error"])
        status, _ = self.request("POST", "/api/jira/search", {"jql": ""})
        self.assertEqual(status, 400)

    def test_unknown_route(self):
        self.assertEqual(self.request("GET", "/api/nope")[0], 404)
        self.assertEqual(self.request("POST", "/api/nope", {})[0], 404)


class ConfigTest(unittest.TestCase):
    def test_jira_site(self):
        self.assertEqual(
            jira_site(" https://x.atlassian.net/jira/your-work "), "https://x.atlassian.net"
        )
        for bad in ("http://x.atlassian.net", "x.atlassian.net", "https://u@x.net"):
            with self.subTest(url=bad), self.assertRaises(JiraError):
                jira_site(bad)

    def test_jira_from_settings(self):
        self.assertIsNone(Jira.from_settings({}))
        jira = Jira.from_settings(
            {"url": "https://x.atlassian.net/x", "email": "a@b.c", "token": "t"}
        )
        self.assertEqual(jira.url, "https://x.atlassian.net")
        with self.assertRaisesRegex(JiraError, "object"):
            Jira.from_settings("x")

    def test_load_dotenv(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text(
                "# comment\nexport A_TEST=1\nB_TEST = 'two'\nC_TEST=\"3\"\nnoise\n"
            )
            with mock.patch.dict(os.environ, {"C_TEST": "kept"}):
                load_dotenv(env)
                self.assertEqual(os.environ["A_TEST"], "1")
                self.assertEqual(os.environ["B_TEST"], "two")
                self.assertEqual(os.environ["C_TEST"], "kept")
            load_dotenv(Path(tmp) / "missing")


if __name__ == "__main__":
    unittest.main()
