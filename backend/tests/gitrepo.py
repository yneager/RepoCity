"""Programmatic construction of small git repositories with fully controlled history."""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path


class SyntheticRepo:
    def __init__(self, path: Path):
        self.path = path
        path.mkdir(parents=True, exist_ok=True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "core.autocrlf", "false")
        self.hashes: dict[str, str] = {}

    def git(self, *args: str, env: dict | None = None) -> str:
        out = subprocess.run(
            ["git", "-C", str(self.path), *args],
            capture_output=True,
            check=True,
            env={**os.environ, **(env or {})},
        )
        return out.stdout.decode().strip()

    def write(self, rel: str, content: str) -> None:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", newline="\n") as fh:
            fh.write(content)

    def remove(self, rel: str) -> None:
        self.git("rm", "-q", rel)

    def move(self, src: str, dst: str) -> None:
        (self.path / dst).parent.mkdir(parents=True, exist_ok=True)
        self.git("mv", src, dst)

    def commit(self, label: str, message: str, date: str, author: str = "Alice", email: str = "alice@example.com") -> str:
        """Commit everything with a fixed date (``YYYY-MM-DD``); returns the hash."""
        ts = datetime.fromisoformat(date).replace(hour=12, tzinfo=UTC).isoformat()
        env = {
            "GIT_AUTHOR_DATE": ts,
            "GIT_COMMITTER_DATE": ts,
            "GIT_AUTHOR_NAME": author,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_COMMITTER_NAME": author,
            "GIT_COMMITTER_EMAIL": email,
        }
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message, env=env)
        h = self.git("rev-parse", "HEAD")
        self.hashes[label] = h
        return h

    def merge(self, label: str, branch: str, message: str, date: str) -> str:
        ts = datetime.fromisoformat(date).replace(hour=12, tzinfo=UTC).isoformat()
        env = {"GIT_AUTHOR_DATE": ts, "GIT_COMMITTER_DATE": ts}
        self.git("merge", "-q", "--no-ff", branch, "-m", message, env=env)
        h = self.git("rev-parse", "HEAD")
        self.hashes[label] = h
        return h


F_V1 = "def f(x):\n    return x + 1\n\n\ndef g(y):\n    return y * 2\n"


def build_bug_repo(path: Path) -> SyntheticRepo:
    """A history with known bug introductions, fixes, a rename and a merged PR.

    =====  ==========  =============================================================
    label  date        what happens
    =====  ==========  =============================================================
    c1     2020-01-15  add app.py (f, g) and util.py
    c2     2020-02-10  BUG: g returns y * 3 (author Bob)
    c3     2020-03-05  "Fix bug in g": y * 3 -> y * 2          SZZ -> c2
    c4     2020-04-20  rename app.py -> core.py
    c5     2020-05-12  BUG: f returns x - 1
    c6     2020-06-08  "fix crash in f" on core.py            SZZ -> c5 (across rename)
    c7     2020-07-02  whitespace-only change of g's return line
    c8     2020-07-25  comment line added above g's return
    c9     2020-08-14  "Fix wrong result": changes g's return, deletes the comment
                       plain blame -> {c7 (return line), c8 (comment)}
                       blame -w, no comments -> {c3}
    b1     2020-09-03  (branch) BUG in util.py
    m1     2020-09-10  merge of branch "feature"
    c10    2020-10-01  "Fix defect in util" -> SZZ -> b1 (a non-first-parent commit)
    c11    2020-11-05  "fix typo in README" (not a bug fix)
    c12    2021-02-01  delete util.py
    c13    2021-03-01  add new.py
    =====  ==========  =============================================================
    """
    r = SyntheticRepo(path)
    r.write("app.py", F_V1)
    r.write("util.py", "def h(z):\n    return z\n")
    r.write("README.md", "hello\n")
    r.commit("c1", "Initial commit", "2020-01-15")
    r.write("app.py", F_V1.replace("y * 2", "y * 3"))
    r.commit("c2", "Tweak g", "2020-02-10", author="Bob", email="bob@example.com")
    r.write("app.py", F_V1)
    r.commit("c3", "Fix bug in g", "2020-03-05")
    r.move("app.py", "core.py")
    r.commit("c4", "Rename app to core", "2020-04-20")
    r.write("core.py", F_V1.replace("x + 1", "x - 1"))
    r.commit("c5", "Change f", "2020-05-12", author="Bob", email="bob@example.com")
    r.write("core.py", F_V1)
    r.commit("c6", "fix crash in f", "2020-06-08")
    v7 = F_V1.replace("    return y * 2", "    return  y * 2")
    r.write("core.py", v7)
    r.commit("c7", "Reformat", "2020-07-02")
    v8 = v7.replace("    return  y * 2", "    # double it\n    return  y * 2")
    r.write("core.py", v8)
    r.commit("c8", "Add comment", "2020-07-25")
    r.write("core.py", F_V1.replace("y * 2", "y * 4"))
    r.commit("c9", "Fix wrong result in g", "2020-08-14")
    r.git("checkout", "-q", "-b", "feature")
    r.write("util.py", "def h(z):\n    return -z\n")
    r.commit("b1", "Negate h", "2020-09-03", author="Carol", email="carol@example.com")
    r.git("checkout", "-q", "main")
    r.merge("m1", "feature", "Merge branch 'feature'", "2020-09-10")
    r.write("util.py", "def h(z):\n    return z\n")
    r.commit("c10", "Fix defect in util", "2020-10-01")
    r.write("README.md", "hello world\n")
    r.commit("c11", "fix typo in README", "2020-11-05")
    r.remove("util.py")
    r.commit("c12", "Remove util", "2021-02-01")
    r.write("new.py", "def k():\n    return 1\n")
    r.commit("c13", "Add new module", "2021-03-01")
    return r
