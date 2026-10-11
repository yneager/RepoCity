"""Bug-fix detection and SZZ produce exactly the expected introducing commits."""

from __future__ import annotations

from repocity.config import SZZConfig
from repocity.szz.bugfix import BugfixClassifier
from repocity.szz.szz import commit_sizes, is_noise_line, parse_deleted_lines, szz_links
from repocity.store.db import Store


def _links(store_path, cfg):
    with Store(store_path) as st:
        commits = st.read("commits")
        sizes = st.read("intro_sizes")
        links = szz_links(st.read("szz_lines"), commits, dict(zip(sizes["hash"], sizes["n_files"])), cfg)
    by_idx = dict(zip(commits["idx"], commits["hash"]))
    return {(by_idx[f], h) for f, h in zip(links["fix_idx"], links["intro_hash"])}


def test_keyword_classifier():
    clf = BugfixClassifier()
    assert clf.is_bugfix("Fix crash when config is missing")
    assert clf.is_bugfix("fix(router): wrong status code")
    assert clf.is_bugfix("Resolves issue #42")
    assert clf.is_bugfix("bug-fix for parser")
    assert not clf.is_bugfix("Add prefix handling")  # whole words only
    assert not clf.is_bugfix("fix typo in README")
    assert not clf.is_bugfix("docs: fix broken link")
    assert not clf.is_bugfix("Resolve merge conflicts")
    assert clf.is_bugfix("Fix typo and fix crash in app")  # one exclusion does not hide a real fix
    assert clf.is_bugfix_merge("Merge pull request #7 from a/b\n\nFix crash in CLI")
    assert not clf.is_bugfix_merge("Merge pull request #8 from a/fix-things\n\nAdd feature")


def test_bugfix_flags(bug_repo, bug_store):
    with Store(bug_store) as st:
        c = st.read("commits")
    fixes = set(c[c.is_bugfix]["hash"])
    h = bug_repo.hashes
    assert fixes == {h["c3"], h["c6"], h["c9"], h["c10"]}
    merge = c[c.hash == h["m1"]].iloc[0]
    assert merge["is_merge"] and merge["n_integrated"] == 1 and not merge["is_bugfix"]


def test_plain_bszz(bug_repo, bug_store):
    h = bug_repo.hashes
    got = _links(bug_store, SZZConfig(ignore_whitespace_comments=False, ignore_large_commits=False))
    assert got == {
        (h["c3"], h["c2"]),
        (h["c6"], h["c5"]),  # blame follows the app.py -> core.py rename
        (h["c9"], h["c7"]),  # the whitespace-only change hides the real origin
        (h["c9"], h["c8"]),  # the deleted comment line is blamed too
        (h["c10"], h["b1"]),  # introducing commit lives on a merged branch
    }


def test_whitespace_comment_improvement(bug_repo, bug_store):
    h = bug_repo.hashes
    got = _links(bug_store, SZZConfig(ignore_whitespace_comments=True, ignore_large_commits=False))
    assert got == {(h["c3"], h["c2"]), (h["c6"], h["c5"]), (h["c9"], h["c3"]), (h["c10"], h["b1"])}


def test_large_commit_filter(bug_repo, bug_store):
    h = bug_repo.hashes
    assert _links(bug_store, SZZConfig(ignore_large_commits=True, large_commit_files=0)) == set()
    sizes = commit_sizes(bug_repo.path, [h["c1"], h["c2"], h["b1"]])
    assert sizes == {h["c1"]: 3, h["c2"]: 1, h["b1"]: 1}


def test_diff_parser_and_noise():
    diff = (
        "diff --git a/x.py b/y.py\nsimilarity index 80%\nrename from x.py\nrename to y.py\n"
        "--- a/x.py\n+++ b/y.py\n@@ -3,2 +3 @@ def a():\n-    old1\n-    # c\n+    new\n"
        "@@ -10 +9,0 @@\n-gone\n"
    )
    assert parse_deleted_lines(diff) == {("x.py", "y.py"): [(3, "    old1"), (4, "    # c"), (10, "gone")]}
    assert is_noise_line("a.py", "   # comment") and is_noise_line("a.java", " * javadoc")
    assert is_noise_line("a.js", "   ") and not is_noise_line("a.py", "x = 1  # trailing")
