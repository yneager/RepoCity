"""SZZ: identify the commits that introduced the lines a bug fix had to change.

Basic algorithm (B-SZZ), Sliwerski, Zimmermann & Zeller, "When do changes induce
fixes?", MSR 2005:

1. For a bug-fix commit ``F`` with (first) parent ``P``, compute the diff ``P -> F``.
2. Every line that ``F`` deletes or modifies is a line that was (probably) part of the
   bug. Modified lines appear in a diff as delete + add, so we take the deleted side.
3. ``git blame`` those line numbers in ``P``: the commit that last touched each line is
   a *bug-introducing candidate*.

Improvements, each switchable for the E5 ablation (``SZZConfig``):

* **Whitespace / comment lines** (Kim et al., "Automatic identification of
  bug-introducing changes", ASE 2006): ignore deleted lines that are blank or contain
  only a comment, and blame with ``-w`` so pure re-indentation does not hide the real
  origin of a line.
* **Large commits** (Kim et al. 2006; da Costa et al., TSE 2017): fix commits touching
  more than N files are usually refactorings/merges with a "fix" keyword and are
  skipped; candidates touching more than N files are discarded as noise.
* **Issue date filter** (Sliwerski et al. 2005; MA-SZZ, da Costa et al. 2017): a
  candidate dated *after* the bug report cannot have caused it. This needs report
  dates from an issue tracker; RepoCity does not call issue-tracker APIs, so the
  filter is only applied when an ``issue_dates`` mapping is supplied.

Pure additions (hunks that delete nothing) give B-SZZ nothing to blame; like the
original algorithm we skip them. Files deleted or added by the fix are skipped too.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from repocity.config import SZZConfig
from repocity.ingest.gitutil import GitError, run_git, unquote_path

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_SHA_RE = re.compile(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$")

HASH_COMMENT = {".py", ".rb", ".pl", ".pm", ".sh"}
SLASH_COMMENT = {
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt", ".kts", ".scala", ".go", ".c", ".h",
    ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".cs", ".swift", ".rs", ".m", ".mm", ".php", ".sol", ".zig",
}


def is_noise_line(path: str, content: str) -> bool:
    """True if a source line is blank or comment-only (language chosen by extension)."""
    s = content.strip()
    if not s:
        return True
    ext = Path(path).suffix.lower()
    if ext in HASH_COMMENT and s.startswith("#"):
        return True
    if ext in SLASH_COMMENT and (s.startswith("//") or s.startswith("/*") or s.startswith("*") or s.startswith("*/")):
        return True
    if ext == ".php" and s.startswith("#"):
        return True
    if ext == ".lua" and s.startswith("--"):
        return True
    return False


def parse_deleted_lines(diff: str) -> dict[tuple[str, str], list[tuple[int, str]]]:
    """Parse ``git diff -U0`` output into ``{(old_path, new_path): [(old_line_no, text)]}``."""
    result: dict[tuple[str, str], list[tuple[int, str]]] = {}
    old_path = new_path = None
    old_line = 0
    current: list[tuple[int, str]] | None = None
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            old_path = new_path = None
            current = None
        elif line.startswith("--- "):
            p = line[4:].rstrip("\t")
            old_path = None if p == "/dev/null" else unquote_path(p)[2:]
        elif line.startswith("+++ "):
            p = line[4:].rstrip("\t")
            new_path = None if p == "/dev/null" else unquote_path(p)[2:]
            if old_path and new_path:
                current = result.setdefault((old_path, new_path), [])
            else:
                current = None
        elif line.startswith("@@"):
            m = _HUNK_RE.match(line)
            if m:
                old_line = int(m.group(1))
        elif current is not None and line.startswith("-"):
            current.append((old_line, line[1:]))
            old_line += 1
    return result


def blame_lines(repo: Path, rev: str, path: str, lines: list[int], ignore_ws: bool) -> dict[int, tuple[str, int]]:
    """``git blame`` the given line numbers of ``path`` at ``rev``: ``{line: (sha, committer_time)}``."""
    if not lines:
        return {}
    ranges: list[tuple[int, int]] = []
    for n in sorted(set(lines)):
        if ranges and n == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], n)
        else:
            ranges.append((n, n))
    args = ["blame", "--porcelain"]
    if ignore_ws:
        args.append("-w")
    for a, b in ranges[:400]:  # extremely fragmented hunks: cap the argument list
        args += ["-L", f"{a},{b}"]
    args += [rev, "--", path]
    out = run_git(repo, args, timeout=300)
    times: dict[str, int] = {}
    result: dict[int, tuple[str, int]] = {}
    sha = None
    final = 0
    for line in out.split("\n"):
        if line.startswith("\t"):
            if sha is not None:
                result[final] = (sha, times.get(sha, 0))
            continue
        m = _SHA_RE.match(line)
        if m:
            sha = m.group(1)
            final = int(m.group(3))
        elif line.startswith("committer-time ") and sha is not None:
            times[sha] = int(line.split()[1])
    return result


@dataclass
class FixTask:
    fix_idx: int
    fix_hash: str
    parent: str
    files: dict[str, int]  # new path -> file_id (modified / renamed source files)


def _run_fix(repo: Path, task: FixTask, modes: tuple[str, ...]) -> list[tuple]:
    try:
        diff = run_git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "-M", task.parent, task.fix_hash, "--"], timeout=300)
    except GitError:
        return []
    rows: list[tuple] = []
    for (old, new), deleted in parse_deleted_lines(diff).items():
        fid = task.files.get(new)
        if fid is None or not deleted:
            continue
        noise = {n: is_noise_line(old, text) for n, text in deleted}
        for mode in modes:
            try:
                blamed = blame_lines(repo, task.parent, old, [n for n, _ in deleted], ignore_ws=(mode == "w"))
            except GitError:
                continue
            for n, (sha, t) in blamed.items():
                rows.append((task.fix_idx, fid, n, noise.get(n, False), mode, sha, t))
    return rows


def run_szz(
    repo: Path,
    commits: pd.DataFrame,
    changes: pd.DataFrame,
    modes: tuple[str, ...] = ("plain", "w"),
    workers: int = 8,
    progress: Callable[[float, str], None] | None = None,
) -> pd.DataFrame:
    """Blame the deleted lines of every bug-fix commit. Returns one row per blamed line.

    Columns: fix_idx, file_id, line_no, noise, mode ('plain' = B-SZZ blame, 'w' = blame -w),
    intro_hash, intro_time. Variant selection happens later in :func:`szz_links`.
    """
    fixes = commits[commits["is_bugfix"]]
    ch = changes[changes["status"].isin(["M", "R"])]
    by_commit = {k: dict(zip(g["path"], g["file_id"])) for k, g in ch.groupby("commit_idx")}
    tasks = []
    for idx, h, parents in zip(fixes["idx"], fixes["hash"], fixes["parents"]):
        ps = parents.split()
        files = by_commit.get(idx)
        if ps and files:
            tasks.append(FixTask(int(idx), h, ps[0], files))
    rows: list[tuple] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_run_fix, repo, t, modes) for t in tasks]
        for i, f in enumerate(futures):
            rows.extend(f.result())
            if progress and (i % 50 == 0 or i == len(futures) - 1):
                progress((i + 1) / max(1, len(futures)), f"SZZ: blamed {i + 1}/{len(futures)} bug fixes")
    return pd.DataFrame(rows, columns=["fix_idx", "file_id", "line_no", "noise", "mode", "intro_hash", "intro_time"])


def commit_sizes(repo: Path, hashes: list[str]) -> dict[str, int]:
    """Number of files changed by each commit (any branch), for the large-commit filter."""
    sizes: dict[str, int] = {}
    for start in range(0, len(hashes), 2000):
        chunk = hashes[start : start + 2000]
        out = run_git(
            repo, ["log", "--no-walk=unsorted", "--format=%x1e%H", "--shortstat", "--stdin"], input_text="\n".join(chunk) + "\n"
        )
        for rec in out.split("\x1e"):
            if not rec.strip():
                continue
            lines = rec.strip().split("\n")
            n = 0
            for ln in lines[1:]:
                m = re.search(r"(\d+) files? changed", ln)
                if m:
                    n = int(m.group(1))
            sizes[lines[0].strip()] = n
    return sizes


def szz_links(
    lines: pd.DataFrame,
    commits: pd.DataFrame,
    intro_sizes: dict[str, int],
    cfg: SZZConfig,
    issue_dates: dict[str, int] | None = None,
) -> pd.DataFrame:
    """Apply an SZZ variant to blamed lines -> unique (fix, file, introducing commit) links.

    Returns columns: fix_idx, fix_time, file_id, intro_hash, intro_time.
    """
    mode = "w" if cfg.ignore_whitespace_comments else "plain"
    df = lines[lines["mode"] == mode]
    if cfg.ignore_whitespace_comments:
        df = df[~df["noise"]]
    fix_info = commits.set_index("idx")[["hash", "time", "n_files_all"]]
    df = df.join(fix_info, on="fix_idx")
    if cfg.ignore_large_commits:
        n = cfg.large_commit_files
        df = df[df["n_files_all"] <= n]
        df = df[np.array([intro_sizes.get(h, 0) <= n for h in df["intro_hash"]], dtype=bool)]
    if cfg.use_issue_dates and issue_dates:
        limit = df["hash"].map(issue_dates)
        df = df[limit.isna() | (df["intro_time"] <= limit)]
    df = df[df["intro_hash"] != df["hash"]]
    out = (
        df.groupby(["fix_idx", "file_id", "intro_hash"], as_index=False)
        .agg(fix_time=("time", "first"), intro_time=("intro_time", "first"))
    )
    return out[["fix_idx", "fix_time", "file_id", "intro_hash", "intro_time"]]
