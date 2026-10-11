"""History ingestion: first-parent commit walk, per-file churn and rename tracking.

Design (Section 4.1 of the spec):

* We walk the **first-parent** history of the default branch, i.e. the sequence of
  states the main branch actually went through. A merge commit is diffed against its
  first parent (``--diff-merges=first-parent``), so a merged pull request appears as
  one "integrated change" that touches exactly the files the PR changed.
* Each commit records hash, committer timestamp (when it landed on the branch),
  a hashed author e-mail (privacy), initials, message, and per-file added/deleted lines.
* **Rename tracking**: git's rename detection (``-M``, 50% similarity) gives
  ``old -> new`` pairs; :class:`IdentityTracker` maps every path to a stable integer
  ``file_id`` so a file keeps its identity (and its history) across renames.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from repocity import config
from repocity.ingest.gitutil import run_git, unquote_path

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"
MSG_END = "\x1d"
LOG_FORMAT = "%x1e%H%x1f%P%x1f%ct%x1f%at%x1f%aE%x1f%aN%x1f%B%x1d"


@dataclass
class FileChange:
    status: str  # A, M, D, R (copies are treated as A, type changes as M)
    old_path: str | None
    new_path: str | None
    added: int
    deleted: int


@dataclass
class Commit:
    hash: str
    parents: list[str]
    commit_time: int  # unix seconds, committer date
    author_time: int
    author: str  # hashed e-mail
    initials: str
    message: str
    changes: list[FileChange] = field(default_factory=list)

    @property
    def is_merge(self) -> bool:
        return len(self.parents) > 1


def hash_author(email: str) -> str:
    """Pseudonymise an author: first 10 hex chars of sha256(lower-cased e-mail)."""
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:10]


def initials(name: str) -> str:
    words = [w for w in re.split(r"[\s._\-]+", name.strip()) if w and w[0].isalnum()]
    if not words:
        return "?"
    letters = words[0][0] + (words[-1][0] if len(words) > 1 else "")
    return letters.upper()


def is_source_file(path: str | None, extensions: Iterable[str] = config.SOURCE_EXTENSIONS) -> bool:
    """True for source files we analyse; False for vendored, generated, minified or non-code files."""
    if not path:
        return False
    p = PurePosixPath(path)
    name = p.name.lower()
    if p.suffix.lower() not in extensions:
        return False
    if any(name.endswith(s) for s in config.EXCLUDED_SUFFIXES):
        return False
    return not any(part.lower() in config.EXCLUDED_DIRS for part in p.parts[:-1])


REGULAR_MODES = frozenset({"100644", "100755", "100664"})
_RAW_RE = re.compile(r"^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$")


def _parse_changes(block: str) -> list[FileChange]:
    """Parse the ``--raw`` + ``--numstat`` lines that follow one commit header.

    Raw lines (``:old_mode new_mode old_sha new_sha STATUS\\tpath[\\tpath2]``) give the
    change type and exact paths; numstat lines (``added\\tdeleted\\tpath``) give line
    counts. Git prints both lists in the same order, so we zip them by position.
    """
    raws: list[tuple[str, str | None, str | None]] = []
    stats: list[tuple[int, int]] = []
    for line in block.split("\n"):
        if not line:
            continue
        if line.startswith(":"):
            parts = line.split("\t")
            m = _RAW_RE.match(parts[0])
            if not m:
                continue
            # Only regular files count; symlinks (120000) and submodules (160000) are not
            # source code. Skipped entries keep their slot so the numstat zip stays aligned.
            old_ok, new_ok = m.group(1) in REGULAR_MODES, m.group(2) in REGULAR_MODES
            status = m.group(5)
            paths = [unquote_path(x) for x in parts[1:]]
            if status in ("R", "C") and len(paths) >= 2:
                old, new = paths[0], paths[1]
                if new_ok and old_ok:
                    raws.append(("R" if status == "R" else "A", old if status == "R" else None, new))
                elif new_ok:
                    raws.append(("A", None, new))
                elif old_ok and status == "R":
                    raws.append(("D", old, None))
                else:
                    raws.append(("SKIP", None, None))
            elif status == "A":
                raws.append(("A", None, paths[0]) if new_ok else ("SKIP", None, None))
            elif status == "D":
                raws.append(("D", paths[0], None) if old_ok else ("SKIP", None, None))
            else:  # M, T (type change), U ...
                if old_ok and new_ok:
                    raws.append(("M", paths[0], paths[0]))
                elif old_ok:
                    raws.append(("D", paths[0], None))  # regular file became a symlink/submodule
                elif new_ok:
                    raws.append(("A", None, paths[0]))
                else:
                    raws.append(("SKIP", None, None))
        else:
            parts = line.split("\t", 2)
            if len(parts) == 3:
                a, d = parts[0], parts[1]
                stats.append((int(a) if a.isdigit() else 0, int(d) if d.isdigit() else 0))
    changes = []
    for i, (status, old, new) in enumerate(raws):
        if status == "SKIP":
            continue
        added, deleted = stats[i] if i < len(stats) else (0, 0)
        changes.append(FileChange(status, old, new, added, deleted))
    return changes


def read_history(repo: str | Path, rev: str = "HEAD", timeout: float = 1800) -> list[Commit]:
    """Return first-parent commits of ``rev`` from oldest to newest with per-file changes."""
    out = run_git(
        repo,
        [
            "log", "--first-parent", "--diff-merges=first-parent", "-M", "--raw", "--numstat",
            "--no-abbrev", "--reverse", f"--format={LOG_FORMAT}", rev,
        ],
        timeout=timeout,
    )
    commits: list[Commit] = []
    for record in out.split(RECORD_SEP):
        if not record.strip():
            continue
        header, _, rest = record.partition(MSG_END)
        fields = header.split(FIELD_SEP)
        if len(fields) < 7:
            continue
        h, parents, ct, at, email, name = fields[:6]
        message = FIELD_SEP.join(fields[6:]).strip()
        commits.append(
            Commit(
                hash=h,
                parents=parents.split(),
                commit_time=int(ct),
                author_time=int(at),
                author=hash_author(email),
                initials=initials(name),
                message=message,
                changes=_parse_changes(rest),
            )
        )
    return commits


@dataclass
class TrackedChange:
    commit_idx: int
    file_id: int
    path: str  # path after the change (old path for deletions)
    status: str
    added: int
    deleted: int


@dataclass
class FileRecord:
    file_id: int
    first_path: str
    last_path: str
    created_idx: int
    deleted_idx: int | None = None


class IdentityTracker:
    """Assigns stable ``file_id``s to source files and follows them through renames.

    Within a single commit all removals (deletes and the *old* side of renames) are
    processed before additions, so swaps such as ``a -> b, b -> a`` are handled.
    A path that is deleted and later re-created gets a *new* identity.
    """

    def __init__(self, is_source=is_source_file):
        self.is_source = is_source
        self.path_to_id: dict[str, int] = {}
        self.files: list[FileRecord] = []
        self.changes: list[TrackedChange] = []
        self.reconciled = 0

    def _new_id(self, path: str, idx: int) -> int:
        fid = len(self.files)
        self.files.append(FileRecord(fid, path, path, idx))
        self.path_to_id[path] = fid
        return fid

    def apply(self, idx: int, changes: list[FileChange]) -> None:
        moving: list[tuple[int | None, FileChange]] = []
        # Pass 1: detach old paths of deletions and renames.
        for ch in changes:
            if ch.status in ("D", "R") and ch.old_path is not None:
                fid = self.path_to_id.pop(ch.old_path, None)
                if ch.status == "D":
                    if fid is not None:
                        self.files[fid].deleted_idx = idx
                        self.changes.append(TrackedChange(idx, fid, ch.old_path, "D", ch.added, ch.deleted))
                else:
                    moving.append((fid, ch))
        # Pass 2: attach new paths (renames, additions, modifications).
        for fid, ch in moving:
            new = ch.new_path
            assert new is not None
            if not self.is_source(new):
                if fid is not None:  # renamed to a non-source name: the source file is gone
                    self.files[fid].deleted_idx = idx
                    self.changes.append(TrackedChange(idx, fid, ch.old_path or new, "D", ch.added, ch.deleted))
                continue
            if fid is None:  # non-source renamed into a source file
                fid = self._new_id(new, idx)
                status = "A"
            else:
                if new in self.path_to_id and self.path_to_id[new] != fid:
                    self.files[self.path_to_id[new]].deleted_idx = idx
                self.path_to_id[new] = fid
                self.files[fid].last_path = new
                status = "R"
            self.changes.append(TrackedChange(idx, fid, new, status, ch.added, ch.deleted))
        for ch in changes:
            if ch.status in ("D", "R"):
                continue
            path = ch.new_path
            if path is None or not self.is_source(path):
                continue
            fid = self.path_to_id.get(path)
            status = ch.status
            if fid is None:
                fid = self._new_id(path, idx)
                status = "A"
            elif ch.status == "A":
                status = "M"  # re-added on top of an existing tracked path
            self.changes.append(TrackedChange(idx, fid, path, status, ch.added, ch.deleted))

    def reconcile(self, idx: int, tree_paths: set[str]) -> None:
        """Align the tracked set with a real tree listing (defensive; counts mismatches)."""
        for path in [p for p in self.path_to_id if p not in tree_paths]:
            fid = self.path_to_id.pop(path)
            self.files[fid].deleted_idx = idx
            self.reconciled += 1
        for path in tree_paths:
            if path not in self.path_to_id:
                self._new_id(path, idx)
                self.reconciled += 1


def list_tree(repo: str | Path, commit: str) -> dict[str, str]:
    """``path -> blob sha`` for every source file in ``commit``."""
    out = run_git(repo, ["ls-tree", "-r", "--full-tree", commit])
    result: dict[str, str] = {}
    for line in out.split("\n"):
        if not line:
            continue
        meta, _, path = line.partition("\t")
        parts = meta.split()
        if len(parts) == 3 and parts[1] == "blob" and parts[0] in REGULAR_MODES:
            path = unquote_path(path)
            if is_source_file(path):
                result[path] = parts[2]
    return result
