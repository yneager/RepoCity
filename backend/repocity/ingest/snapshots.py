"""Build the commit table, rename-aware change table and monthly snapshots.

A *snapshot* for month ``M`` is the state of the default branch at the last
first-parent commit whose (monotonic) time falls in or before ``M``. Every calendar
month between the first and last commit gets a snapshot, so the time slider is
continuous; quiet months simply repeat the previous state.

Static metrics are computed per *blob*: a snapshot only triggers lizard for blobs that
were never analysed before (incremental update, see :mod:`repocity.metrics.static`).
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from repocity.ingest.gitutil import CatFile
from repocity.ingest.history import Commit, IdentityTracker, is_source_file, list_tree, read_history
from repocity.metrics.static import _analyse_batch
from repocity.timeutil import month_end_ts, month_of, month_range

Progress = Callable[[float, str], None]


def _noop(_f: float, _m: str) -> None:
    pass


@dataclass
class HistoryData:
    commits: pd.DataFrame
    changes: pd.DataFrame
    files: pd.DataFrame
    snapshots: pd.DataFrame
    snapshot_files: pd.DataFrame
    raw_commits: list[Commit]
    reconciled: int


def build_history(repo: Path, rev: str = "HEAD", workers: int = 4, progress: Progress = _noop) -> HistoryData:
    progress(0.0, "Reading first-parent history")
    commits = read_history(repo, rev)
    if not commits:
        raise ValueError("Repository has no commits")
    progress(0.15, f"Parsed {len(commits)} commits; tracking renames")

    # Monotonic time: first-parent order is the truth for "when it landed"; clock skew
    # between machines must not make time go backwards.
    times: list[int] = []
    running = 0
    for c in commits:
        running = max(running, c.commit_time)
        times.append(running)

    tracker = IdentityTracker()
    months = month_range(month_of(times[0]), month_of(times[-1]))
    snap_rows: list[dict] = []
    snapfile_rows: list[tuple[str, int, str, str]] = []
    ci = 0
    last_tree: dict[str, str] | None = None
    last_idx = -1
    for mi, month in enumerate(months):
        end = month_end_ts(month)
        while ci < len(commits) and times[ci] <= end:
            tracker.apply(ci, commits[ci].changes)
            ci += 1
        idx = ci - 1
        if idx < 0:
            continue
        if idx != last_idx:
            last_tree = list_tree(repo, commits[idx].hash)
            tracker.reconcile(idx, set(last_tree))
            last_idx = idx
        assert last_tree is not None
        snap_rows.append({"month": month, "commit_idx": idx, "hash": commits[idx].hash, "end_ts": end})
        for path, blob in last_tree.items():
            snapfile_rows.append((month, tracker.path_to_id[path], path, blob))
        if mi % 12 == 0:
            progress(0.15 + 0.35 * (mi + 1) / len(months), f"Snapshot {month}: {len(last_tree)} source files")

    commit_df = pd.DataFrame(
        {
            "idx": range(len(commits)),
            "hash": [c.hash for c in commits],
            "parents": [" ".join(c.parents) for c in commits],
            "time": times,
            "commit_time": [c.commit_time for c in commits],
            "author_time": [c.author_time for c in commits],
            "author": [c.author for c in commits],
            "initials": [c.initials for c in commits],
            "message": [c.message for c in commits],
            "is_merge": [c.is_merge for c in commits],
            "n_files_all": [len(c.changes) for c in commits],
            "n_files": [sum(1 for ch in c.changes if is_source_file(ch.new_path or ch.old_path)) for c in commits],
        }
    )
    changes_df = pd.DataFrame(
        [(t.commit_idx, t.file_id, t.path, t.status, t.added, t.deleted) for t in tracker.changes],
        columns=["commit_idx", "file_id", "path", "status", "added", "deleted"],
    )
    files_df = pd.DataFrame(
        [(f.file_id, f.first_path, f.last_path, f.created_idx, f.deleted_idx) for f in tracker.files],
        columns=["file_id", "first_path", "last_path", "created_idx", "deleted_idx"],
    )
    files_df["deleted_idx"] = files_df["deleted_idx"].astype("Int64")
    snaps_df = pd.DataFrame(snap_rows)
    sf = pd.DataFrame(snapfile_rows, columns=["month", "file_id", "path", "blob"])

    # ---- static metrics, one lizard run per distinct blob -------------------------------
    blobs = sf.drop_duplicates("blob")[["blob", "path"]].reset_index(drop=True)
    progress(0.5, f"Computing static metrics for {len(blobs)} distinct file versions")
    metrics: dict[str, tuple[int, int, int, int]] = {}
    chunk = 1500
    with CatFile(repo) as cat, ProcessPoolExecutor(max_workers=max(1, workers)) as pool:
        for start in range(0, len(blobs), chunk):
            part = blobs.iloc[start : start + chunk]
            items = [(p, cat.read(b)) for b, p in zip(part["blob"], part["path"])]
            size = max(8, len(items) // (workers * 3) + 1)
            batches = [items[i : i + size] for i in range(0, len(items), size)]
            results = [m for res in pool.map(_analyse_batch, batches) for m in res]
            for b, m in zip(part["blob"], results):
                metrics[b] = m
            progress(0.5 + 0.5 * min(1.0, (start + chunk) / max(1, len(blobs))), "Static metrics")
    m = pd.DataFrame.from_dict(metrics, orient="index", columns=["loc", "ccn_total", "ccn_max", "nfuncs"])
    m.index.name = "blob"
    sf = sf.join(m, on="blob")
    progress(1.0, f"{len(snaps_df)} monthly snapshots, {len(files_df)} file identities")
    return HistoryData(commit_df, changes_df, files_df, snaps_df, sf, commits, tracker.reconciled)
