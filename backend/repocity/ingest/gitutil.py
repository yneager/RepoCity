"""Thin, safe wrappers around the ``git`` command line.

We call git directly (subprocess, argument lists, never a shell) because parsing
``git log --raw --numstat`` is one to two orders of magnitude faster than walking
commits object-by-object. No code from an analysed repository is ever executed:
we only read objects, and hooks are disabled for clones.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",  # never ask for credentials (private repos must fail fast)
    "GIT_ASKPASS": "echo",
    "GCM_INTERACTIVE": "never",
    "LC_ALL": "C",
}
BASE_ARGS = ["git", "-c", "core.quotepath=off", "-c", "diff.renameLimit=5000", "-c", "core.longpaths=true"]


class GitError(RuntimeError):
    pass


def run_git(repo: str | Path | None, args: list[str], timeout: float | None = 600, input_text: str | None = None) -> str:
    """Run ``git <args>`` inside ``repo`` and return stdout decoded as UTF-8 (lossy)."""
    cmd = BASE_ARGS + (["-C", str(repo)] if repo else []) + args
    try:
        proc = subprocess.run(
            cmd,
            input=input_text.encode() if input_text is not None else None,
            capture_output=True,
            timeout=timeout,
            env=GIT_ENV,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {' '.join(args[:3])} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise GitError(proc.stderr.decode("utf-8", "replace").strip() or f"git {args[0]} failed")
    return proc.stdout.decode("utf-8", "replace")


_URL_RE = re.compile(r"^https://[A-Za-z0-9.\-]+(:\d+)?/[A-Za-z0-9._~\-/]+?(\.git)?/?$")


def validate_url(url: str) -> str:
    """Accept only plain ``https://host/owner/repo`` URLs (no credentials, no query)."""
    url = url.strip()
    if not _URL_RE.match(url) or "@" in url or ".." in url:
        raise ValueError("Only public https:// git URLs are allowed, e.g. https://github.com/pallets/flask")
    return url.rstrip("/")


def remote_head(url: str, timeout: float = 60) -> str:
    """Hash of the remote's HEAD (default branch) without cloning; raises for missing/private repos."""
    try:
        out = run_git(None, ["ls-remote", url, "HEAD"], timeout=timeout)
    except GitError as exc:
        msg = str(exc).lower()
        if "authentication" in msg or "could not read username" in msg or "not found" in msg or "terminal prompts" in msg:
            raise GitError("Repository not found or private (only public repositories are supported).") from exc
        raise
    if not out.strip():
        raise GitError("Remote has no HEAD (empty repository?)")
    return out.split()[0]


def rmtree_force(path: Path) -> None:
    """Delete a directory tree, including git's read-only object files (needed on Windows)."""
    import stat

    def on_error(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass

    if Path(path).exists():
        shutil.rmtree(path, onexc=on_error)


def clone(url: str, dest: Path, timeout: float, rev: str | None = None) -> None:
    """Full-history, single-branch, no-checkout clone (blobs are needed for blame + metrics)."""
    if dest.exists():
        rmtree_force(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    run_git(None, ["clone", "--quiet", "--no-checkout", "--single-branch", url, str(dest)], timeout=timeout)
    if rev:
        run_git(dest, ["cat-file", "-e", f"{rev}^{{commit}}"])


def repo_size_mb(path: Path) -> float:
    total = 0
    for root, _dirs, files in os.walk(path / ".git"):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / 1e6


def unquote_path(path: str) -> str:
    """Undo git's C-style quoting of unusual paths (only used when core.quotepath can't help)."""
    if len(path) >= 2 and path[0] == '"' and path[-1] == '"':
        body = path[1:-1]
        raw = bytearray()
        i = 0
        escapes = {"n": 10, "t": 9, '"': 34, "\\": 92, "a": 7, "b": 8, "f": 12, "r": 13, "v": 11}
        while i < len(body):
            ch = body[i]
            if ch == "\\" and i + 1 < len(body):
                nxt = body[i + 1]
                if nxt in escapes:
                    raw.append(escapes[nxt])
                    i += 2
                    continue
                if nxt.isdigit() and i + 3 < len(body) + 1:
                    raw.append(int(body[i + 1 : i + 4], 8))
                    i += 4
                    continue
            raw.extend(ch.encode())
            i += 1
        return raw.decode("utf-8", "replace")
    return path


class CatFile:
    """Persistent ``git cat-file --batch`` process for fast blob reads (thread-safe)."""

    def __init__(self, repo: Path):
        self._proc = subprocess.Popen(
            BASE_ARGS + ["-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=GIT_ENV,
        )
        self._lock = threading.Lock()

    def read(self, sha: str) -> bytes:
        with self._lock:
            assert self._proc.stdin and self._proc.stdout
            self._proc.stdin.write(sha.encode() + b"\n")
            self._proc.stdin.flush()
            header = self._proc.stdout.readline().split()
            if len(header) < 3 or header[1] == b"missing":
                return b""
            size = int(header[2])
            data = self._proc.stdout.read(size)
            self._proc.stdout.read(1)  # trailing newline
            return data

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.wait(timeout=10)
        except Exception:  # pragma: no cover - best effort cleanup
            self._proc.kill()

    def __enter__(self) -> CatFile:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
